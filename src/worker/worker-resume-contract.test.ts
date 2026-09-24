import { test } from 'node:test';

import assert from 'node:assert/strict';

import { PassThrough } from 'node:stream';


import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';

import { EnvironmentPool } from '../environment/pool.ts';

import { ScriptedEngineAdapter, type ScriptedTurn } from '../engine/scripted.ts';

import type { AgentRunEvent, ContractDelivery } from '../engine/port.ts';

import { LineJsonRpcTransport } from '../engine/jsonrpc.ts';

import { AgentRegistry } from '../agent/registry.ts';

import { ProjectRegistry } from '../project/registry.ts';

import { InMemoryRunStore } from '../run/store.ts';

import { InMemorySessionKeyStore } from '../run/session-key-store.ts';

import { RunOrchestrator } from '../run/orchestrator.ts';

import { WORKER_METHODS } from './protocol.ts';

import { EnvironmentWorker } from './server.ts';

import { WorkerClient } from './client.ts';

import { WORKER_DIAGNOSTICS } from './diagnostics.ts';


const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};

const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };


const successEvents: readonly AgentRunEvent[] = [
  { type: 'notice', text: 'starting' },
  { type: 'tool-call', name: 'shell', detail: 'echo hi' },
  { type: 'tool-output', text: 'hi' },
  { type: 'message', text: 'done', final: true },
];


interface ConnectedWorker {
  readonly adapters: ReadonlyMap<string, WorkerClient>;
  readonly info: {
    readonly pid: number;
    readonly environmentInstanceId: string;
    readonly readiness?: {
      readonly protocolVersion: string;
      readonly engines: readonly {
        readonly engine: string;
        readonly readiness: string;
        readonly modelAvailability: string;
        readonly models: readonly string[];
      }[];
    };
  };
  readonly engine: ScriptedEngineAdapter;
  readonly worker: EnvironmentWorker;
  /** Requests the worker received, in order, as seen on the wire. */
  readonly requests: readonly string[];
  /** Raw session-start payloads as serialized by the core-side WorkerClient. */
  readonly sessionStartParams: readonly Record<string, unknown>[];
  /** Raw Worker-to-core JSON-RPC frames, for privacy-boundary assertions. */
  readonly workerFrames: readonly string[];
  /** Lines the worker reported through `onLog`. */
  readonly logs: readonly string[];
  /** Simulates the carrier's channel dying. */
  killChannel(): void;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


/**
 * Wires a `EnvironmentWorker` to a `WorkerClient` over in-memory streams.
 *
 * This is the channel the real carrier provides, so the seam is exercised
 * end to end without a second process. Note what the core side can see: only
 * `worker/*` and `session/*` methods, never an engine-specific one.
 */
async function connectedWorker(options: {
  turns?: readonly ScriptedTurn[];
  failStart?: string;
  refuseStartKey?: string;
  knownSessionKeys?: readonly string[];
  staleResumeKey?: 'fresh' | 'fail' | 'fail-turn';
  contractDelivery?: ContractDelivery;
}): Promise<ConnectedWorker> {
  const coreToWorker = new PassThrough();
  const workerToCore = new PassThrough();
  const requests: string[] = [];
  const sessionStartParams: Record<string, unknown>[] = [];
  const workerFrames: string[] = [];
  const logs: string[] = [];

  const engine = new ScriptedEngineAdapter({
    turns: options.turns ?? [],
    ...(options.failStart !== undefined ? { failStart: options.failStart } : {}),
    ...(options.refuseStartKey !== undefined ? { refuseStartKey: options.refuseStartKey } : {}),
    ...(options.knownSessionKeys !== undefined
      ? { knownSessionKeys: options.knownSessionKeys }
      : {}),
    ...(options.staleResumeKey !== undefined ? { staleResumeKey: options.staleResumeKey } : {}),
    ...(options.contractDelivery !== undefined
      ? { contractDelivery: options.contractDelivery }
      : {}),
  });

  const worker = new EnvironmentWorker({
    environmentInstanceId: 'mac-mini-1',
    engines: new Map([['scripted', engine]]),
    input: coreToWorker,
    output: workerToCore,
    onLog: (line) => logs.push(line),
  });
  workerToCore.on('data', (chunk: Buffer) => workerFrames.push(chunk.toString('utf8')));

  let adapters = new Map<string, WorkerClient>();
  const transport = new LineJsonRpcTransport({
    input: workerToCore,
    output: coreToWorker,
    onClose: (reason) => {
      for (const adapter of adapters.values()) adapter.notifyChannelClosed(reason);
    },
  });

  // Record what goes over the core-to-worker channel.
  coreToWorker.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim() === '') continue;
      const message = JSON.parse(line) as { method?: string; id?: unknown; params?: unknown };
      if (typeof message.method === 'string' && message.id !== undefined) {
        requests.push(message.method);
        if (message.method === WORKER_METHODS.startSession && isRecord(message.params)) {
          sessionStartParams.push(message.params);
        }
      }
    }
  });

  const connected = await WorkerClient.connect(transport);
  adapters = new Map(connected.adapters);
  void worker;

  return {
    adapters,
    info: connected.info,
    engine,
    worker,
    requests,
    sessionStartParams,
    workerFrames,
    logs,
    killChannel: () => {
      workerToCore.destroy();
      coreToWorker.destroy();
    },
  };
}


function buildOrchestrator(
  adapters: ReadonlyMap<string, WorkerClient>,
  sessionKeys?: InMemorySessionKeyStore,
  agentConfiguration: { readonly model?: string; readonly effort?: string } = {},
) {
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    clock: { now: () => 1_000 },
  });
  const orchestrator = new RunOrchestrator({
    engines: adapters,
    agents: new AgentRegistry([
      {
        id: 'agent-scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/tmp',
        instructions: 'You are Scout.',
        ...agentConfiguration,
      },
    ]),
    projects: new ProjectRegistry([
      {
        id: 'project-sprout',
        goal: 'Ship Sprout',
        rules: [],
        availableEnvironmentInstanceIds: ['mac-mini-1'],
        memberships: [
          { agentId: 'agent-scout', responsibilities: [], collaborationInstructions: '' },
        ],
      },
    ]),
    pool,
    store: new InMemoryRunStore(),
    ...(sessionKeys !== undefined ? { sessionKeys } : {}),
    leaseTtlMs: 60_000,
  });
  return { orchestrator, pool };
}


test('an engine that fails to start becomes a failed run through the worker', async (t) => {
  const rawFailure = 'engine stderr exposed /private/host/path and private.example:7443';
  const worker = await connectedWorker({ turns: [], failStart: rawFailure });
  t.after(() => worker.killChannel());

  const { orchestrator, pool } = buildOrchestrator(worker.adapters);
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'boom' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /engine session could not be started/i);
  assert.doesNotMatch(run.failure ?? '', /private\/host|private\.example|stderr exposed/);
  assert.doesNotMatch(worker.workerFrames.join(''), /private\/host|private\.example|stderr exposed/);
  assert.equal(pool.activeLease('mac-mini-1'), undefined);
});


test('an unrelated start failure through the worker keeps the stored key and is not retried', async (t) => {
  // SK-001 across the worker boundary: a start failure that is not a refused
  // resume must not be reported to the core as a refusal, so the core neither
  // retries fresh nor deletes the key.
  const worker = await connectedWorker({ turns: [], failStart: 'codex binary missing' });
  t.after(() => worker.killChannel());

  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/tmp',
    key: 'a-valid-key',
    updatedAt: 1_000,
  });
  const { orchestrator } = buildOrchestrator(worker.adapters, sessionKeys);

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'boom' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.equal(run.failure, WORKER_DIAGNOSTICS.sessionStartFailed);
  assert.equal(worker.engine.requests.length, 1, 'the unrelated failure was not retried');
  assert.equal(worker.engine.requests[0]?.resumeSessionKey, 'a-valid-key');
  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/tmp',
  });
  assert.equal(stored?.key, 'a-valid-key', 'the key survives across the worker boundary');
});


test('a refused resume crosses the worker boundary and is retried fresh', async (t) => {
  // The neutral refusal classification must survive the wire: the worker reports
  // a protocol code, the core turns it back into the port error, and only then
  // does it forget the key and retry fresh.
  const worker = await connectedWorker({
    turns: [
      { events: successEvents, result: { status: 'completed', text: 'first' } },
      { events: successEvents, result: { status: 'completed', text: 'recovered' } },
    ],
    knownSessionKeys: ['some-other-key'],
    staleResumeKey: 'fail',
  });
  t.after(() => worker.killChannel());

  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/tmp',
    key: 'stale-key',
    updatedAt: 1_000,
  });
  const { orchestrator } = buildOrchestrator(worker.adapters, sessionKeys);

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal(worker.engine.requests.length, 2, 'the refusal was retried once');
  assert.equal(worker.engine.requests[0]?.resumeSessionKey, 'stale-key');
  assert.equal(worker.engine.requests[1]?.resumeSessionKey, undefined);
  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/tmp',
  });
  assert.equal(stored?.key, 'scripted-key-1', 'the fresh key replaced the refused one');
});


test('a turn-level resume refusal crosses the worker boundary and is retried fresh', async (t) => {
  // opencode's refusal arrives on the *turn*, not at session start. The worker
  // reads the authoritative completion rather than the thrown event-stream
  // error, so the neutral classification survives and the core retries once.
  const worker = await connectedWorker({
    turns: [
      { events: successEvents, result: { status: 'completed', text: 'first' } },
      { events: successEvents, result: { status: 'completed', text: 'recovered' } },
    ],
    knownSessionKeys: ['some-other-key'],
    staleResumeKey: 'fail-turn',
  });
  t.after(() => worker.killChannel());

  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/tmp',
    key: 'stale-key',
    updatedAt: 1_000,
  });
  const { orchestrator } = buildOrchestrator(worker.adapters, sessionKeys);

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal(worker.engine.requests.length, 2, 'the turn refusal was retried once');
  assert.equal(worker.engine.requests[1]?.resumeSessionKey, undefined);
});


test('an empty non-refusal turn failure through the worker keeps the stored key', async (t) => {
  // SK-001 across the worker boundary at the turn level: a valid resume whose
  // turn fails without a refusal classification must not be retried and must not
  // delete the key.
  const worker = await connectedWorker({
    turns: [
      { events: [], result: { status: 'failed', message: 'provider stderr /private/host/key private.example:7443' } },
    ],
  });
  t.after(() => worker.killChannel());

  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/tmp',
    key: 'a-valid-key',
    updatedAt: 1_000,
  });
  const { orchestrator } = buildOrchestrator(worker.adapters, sessionKeys);

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /engine turn failed/i);
  assert.doesNotMatch(run.failure ?? '', /private\/host|private\.example|provider stderr/);
  assert.doesNotMatch(worker.workerFrames.join(''), /private\/host|private\.example|provider stderr/);
  assert.equal(worker.engine.requests.length, 1, 'an empty non-refusal turn is not retried');
  assert.equal(worker.engine.requests[0]?.resumeSessionKey, 'a-valid-key');
  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/tmp',
  });
  assert.equal(stored?.key, 'a-valid-key', 'the key survives an empty non-refusal failure');
});


test('a fallback contract delivery is reported, not silent', async (t) => {
  // A working-directory engine that wrote the contract to Sprout's own file
  // instead of the engine's `AGENTS.md` has still delivered it — but somewhere
  // other than the primary channel. The worker must say so, so a user can tell
  // where the contract actually went (the C21-002 fix).
  const worker = await connectedWorker({
    turns: [{ events: successEvents, result: { status: 'completed', text: 'done' } }],
    contractDelivery: {
      mechanism: 'sprout-contract-file',
      path: '/tmp/work/SPROUT-PROJECT-CONTRACT.md',
      agentsMdSkipped: 'user-owned',
    },
  });
  t.after(() => worker.killChannel());

  const { orchestrator } = buildOrchestrator(worker.adapters);
  await orchestrator.waitFor((await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' })).id);

  const reported = worker.logs.find((line) => line.includes('project contract'));
  assert.ok(reported, 'the fallback delivery is reported');
  assert.equal(reported, WORKER_DIAGNOSTICS.contractSproutFile);
  assert.doesNotMatch(reported, /tmp|SPROUT-PROJECT-CONTRACT\.md/);
});


test('a skipped contract delivery is reported as not delivered', async (t) => {
  const worker = await connectedWorker({
    turns: [{ events: successEvents, result: { status: 'completed', text: 'done' } }],
    contractDelivery: { mechanism: 'skipped-unreadable', path: '/tmp/work/AGENTS.md' },
  });
  t.after(() => worker.killChannel());

  const { orchestrator } = buildOrchestrator(worker.adapters);
  await orchestrator.waitFor((await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' })).id);

  const reported = worker.logs.find((line) => line.includes('project contract'));
  assert.ok(reported, 'the skip is reported');
  assert.match(reported, /not delivered/);
  assert.doesNotMatch(reported, /tmp|AGENTS\.md/);
});
