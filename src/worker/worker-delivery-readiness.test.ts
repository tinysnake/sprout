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


/**
 * C21-002 — every delivery outcome a run can produce is observable.
 *
 * An earlier version left the two ordinary successes (`agents.md`,
 * `engine-hook`) with no log line at all, so "delivered through the engine's own
 * channel" and "no contract was ever assembled" looked identical in the log.
 * These tests pin one reportable outcome per mechanism, including both silent
 * successes.
 */
test('every contract delivery mechanism produces a distinct worker log line', async (t) => {
  const cases: readonly { readonly mechanism: ContractDelivery; readonly expected: string }[] = [
    {
      mechanism: { mechanism: 'agents.md', path: '/tmp/work/AGENTS.md' },
      expected: WORKER_DIAGNOSTICS.contractAgentsMd,
    },
    {
      mechanism: {
        mechanism: 'sprout-contract-file',
        path: '/tmp/work/SPROUT-PROJECT-CONTRACT.md',
        agentsMdSkipped: 'user-owned',
      },
      expected: WORKER_DIAGNOSTICS.contractSproutFile,
    },
    {
      mechanism: { mechanism: 'engine-hook', path: '/cfg/hooks.json' },
      expected: WORKER_DIAGNOSTICS.contractEngineHook,
    },
    {
      mechanism: { mechanism: 'skipped-user-owned', path: '/tmp/work/AGENTS.md' },
      expected: WORKER_DIAGNOSTICS.contractUserOwned,
    },
    {
      mechanism: { mechanism: 'skipped-unreadable', path: '/tmp/work/AGENTS.md' },
      expected: WORKER_DIAGNOSTICS.contractUnreadable,
    },
    {
      mechanism: { mechanism: 'unavailable', reason: 'no writable location' },
      expected: WORKER_DIAGNOSTICS.contractUnavailable,
    },
  ];

  const seen = new Set<string>();
  for (const testCase of cases) {
    const worker = await connectedWorker({
      turns: [{ events: successEvents, result: { status: 'completed', text: 'done' } }],
      contractDelivery: testCase.mechanism,
    });
    const { orchestrator } = buildOrchestrator(worker.adapters);
    await orchestrator.waitFor(
      (await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' })).id,
    );
    const reported = worker.logs.find((line) => line.includes('project contract'));
    worker.killChannel();

    assert.ok(reported, `${testCase.mechanism.mechanism} is reported, not silent`);
    assert.equal(reported, testCase.expected);
    assert.doesNotMatch(reported, /\/tmp|\/cfg|no writable location/);
    seen.add(testCase.mechanism.mechanism);
  }
  t.diagnostic(`reported mechanisms: ${[...seen].join(', ')}`);
  assert.equal(seen.size, cases.length, 'each mechanism has its own report');
});


test('an out-of-band adapter that reports no delivery logs nothing', async (t) => {
  // The only silent case is an adapter that hands instructions straight to the
  // engine on its own invocation, where there is no delivery to report.
  const worker = await connectedWorker({
    turns: [{ events: successEvents, result: { status: 'completed', text: 'done' } }],
  });
  t.after(() => worker.killChannel());

  const { orchestrator } = buildOrchestrator(worker.adapters);
  await orchestrator.waitFor((await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' })).id);

  assert.equal(
    worker.logs.filter((line) => line.includes('project contract')).length,
    0,
    'no delivery means no delivery line, never a false report',
  );
});


test('worker/info reports neutral protocol and engine readiness without engine details (#87)', async (t) => {
  const worker = await connectedWorker({ turns: [] });
  t.after(() => worker.killChannel());

  const readiness = worker.info.readiness;
  assert.ok(readiness, 'the Worker reports a neutral readiness projection');
  assert.equal(readiness.protocolVersion, '3');
  // An adapter with no readiness source is honestly `unknown`, never falsely
  // ready, so an unverified engine cannot make an Environment look green.
  assert.deepEqual(readiness.engines, [
    { engine: 'scripted', installed: true, readiness: 'unknown', modelAvailability: 'unknown', models: [] },
  ]);
  // No engine-internal facts leak through the neutral projection.
  assert.equal(JSON.stringify(readiness).includes('binaryPath'), false);
});


test('an injected readiness provider carries only neutral facts across the worker boundary (#87)', async (t) => {
  const coreToWorker = new PassThrough();
  const workerToCore = new PassThrough();
  const engine = new ScriptedEngineAdapter({ turns: [] });
  const worker = new EnvironmentWorker({
    environmentInstanceId: 'mac-mini-1',
    engines: new Map([['scripted', engine]]),
    input: coreToWorker,
    output: workerToCore,
    readiness: () => ({
      protocolVersion: '2',
      engines: [
        {
          engine: 'scripted',
          installed: true,
          readiness: 'login-required',
          modelAvailability: 'available',
          models: ['scripted-model'],
        },
      ],
    }),
  });
  const transport = new LineJsonRpcTransport({ input: workerToCore, output: coreToWorker });
  const connected = await WorkerClient.connect(transport);
  t.after(() => {
    workerToCore.destroy();
    coreToWorker.destroy();
    void worker;
  });

  assert.deepEqual(connected.info.readiness, {
    protocolVersion: '2',
    engines: [
      {
        engine: 'scripted',
        installed: true,
        readiness: 'login-required',
        modelAvailability: 'available',
        models: ['scripted-model'],
      },
    ],
  });
});
