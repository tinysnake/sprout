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
  readonly info: { readonly pid: number; readonly environmentInstanceId: string };
  readonly engine: ScriptedEngineAdapter;
  readonly worker: EnvironmentWorker;
  /** Requests the worker received, in order, as seen on the wire. */
  readonly requests: readonly string[];
  /** Raw session-start payloads as serialized by the core-side WorkerClient. */
  readonly sessionStartParams: readonly Record<string, unknown>[];
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

test('the core identifies a worker and learns which engines it hosts', async (t) => {
  const worker = await connectedWorker({ turns: [] });
  t.after(() => worker.killChannel());

  assert.equal(worker.info.environmentInstanceId, 'mac-mini-1');
  assert.ok(worker.info.pid > 0, 'the worker reports its own process id');
  assert.ok(worker.adapters.has('scripted'));
  assert.deepEqual(worker.adapters.get('scripted')?.capabilities, {
    streaming: 'incremental',
    supportsInterrupt: true,
    standingInstructions: 'out-of-band',
  });
});

test('Agent model and effort serialize through the worker and deserialize for the engine', async (t) => {
  const worker = await connectedWorker({
    turns: [{ events: successEvents, result: { status: 'completed', text: 'done' } }],
  });
  t.after(() => worker.killChannel());

  const { orchestrator } = buildOrchestrator(worker.adapters, undefined, {
    model: 'configured-model',
    effort: 'medium',
  });
  await orchestrator.waitFor((await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' })).id);

  assert.deepEqual(worker.sessionStartParams, [
    {
      engine: 'scripted',
      agentId: 'agent-scout',
      workingDirectory: '/tmp',
      model: 'configured-model',
      effort: 'medium',
      instructions: worker.engine.requests[0]?.instructions,
    },
  ]);
  assert.equal(worker.engine.requests[0]?.model, 'configured-model');
  assert.equal(worker.engine.requests[0]?.effort, 'medium');
});

test('a run executes through the worker and its events reach the core', async (t) => {
  const worker = await connectedWorker({
    turns: [{ events: successEvents, result: { status: 'completed', text: 'done' } }],
  });
  t.after(() => worker.killChannel());

  const adapter = worker.adapters.get('scripted');
  assert.ok(adapter);
  const session = await adapter.startSession({
    agentId: 'agent-scout',
    workingDirectory: '/tmp',
    instructions: 'You are Scout.',
  });

  const turn = session.run('say hi');
  const events: AgentRunEvent[] = [];
  for await (const event of turn.events) events.push(event);
  const result = await turn.completion;

  assert.deepEqual(
    events.map((event) => event.type),
    ['notice', 'tool-call', 'tool-output', 'message'],
  );
  assert.deepEqual(result, { status: 'completed', text: 'done' });
});

test('the orchestrator completes a run entirely through the worker', async (t) => {
  const worker = await connectedWorker({
    turns: [{ events: successEvents, result: { status: 'completed', text: 'done' } }],
  });
  t.after(() => worker.killChannel());

  const { orchestrator, pool } = buildOrchestrator(worker.adapters);
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal(run.result?.status === 'completed' && run.result.text, 'done');
  assert.deepEqual(
    run.events.map((event) => event.type),
    ['notice', 'tool-call', 'tool-output', 'message'],
  );
  assert.equal(pool.activeLease('mac-mini-1'), undefined, 'the core still owns the lease');
  assert.equal(worker.engine.requests[0]?.workingDirectory, '/tmp');
  assert.equal(worker.engine.requests[0]?.agentId, 'agent-scout');
});

test('the core-to-worker protocol exposes no engine-specific methods', async (t) => {
  const worker = await connectedWorker({
    turns: [{ events: successEvents, result: { status: 'completed', text: 'done' } }],
  });
  t.after(() => worker.killChannel());

  const { orchestrator } = buildOrchestrator(worker.adapters);
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  await orchestrator.waitFor(id);

  const allowed = new Set<string>(Object.values(WORKER_METHODS));
  for (const method of worker.requests) {
    assert.ok(
      allowed.has(method),
      `the core sent ${method}, which is not part of the worker protocol`,
    );
  }
  // The protocol is about sessions and turns, never about Codex or app-server.
  for (const method of worker.requests) {
    assert.doesNotMatch(method, /codex|app-server|thread|jsonrpc/i);
  }
});

test('the user can stop a run through the worker', async (t) => {
  const worker = await connectedWorker({
    turns: [
      {
        events: [{ type: 'notice', text: 'working' }],
        result: { status: 'completed', text: 'done' },
        settleAfterMs: 5_000,
      },
    ],
  });
  t.after(() => worker.killChannel());

  const { orchestrator, pool } = buildOrchestrator(worker.adapters);
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'long job' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const stopped = await orchestrator.stop(id);

  assert.equal(stopped.status, 'interrupted');
  assert.equal(pool.activeLease('mac-mini-1'), undefined, 'stopping releases the lease');
});

test('a worker that dies mid-run fails the run instead of hanging it', async (t) => {
  const worker = await connectedWorker({
    turns: [
      {
        events: [{ type: 'notice', text: 'working' }],
        result: { status: 'completed', text: 'done' },
        settleAfterMs: 60_000,
      },
    ],
  });
  t.after(() => worker.killChannel());

  const { orchestrator } = buildOrchestrator(worker.adapters);
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'long job' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The environment went away: the worker can never report on this run again.
  worker.killChannel();

  const run = await orchestrator.waitFor(id);
  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /worker channel closed/i);
});

test('one worker serves several runs and a session is created per run', async (t) => {
  const worker = await connectedWorker({
    turns: [
      { events: successEvents, result: { status: 'completed', text: 'first' } },
      { events: successEvents, result: { status: 'completed', text: 'second' } },
    ],
  });
  t.after(() => worker.killChannel());

  const { orchestrator } = buildOrchestrator(worker.adapters);
  const first = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'one' });
  await orchestrator.waitFor(first.id);
  const second = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'two' });
  await orchestrator.waitFor(second.id);

  assert.equal(worker.engine.requests.length, 2, 'each run got its own engine session');
  const infoRequests = worker.requests.filter((method) => method === WORKER_METHODS.info);
  assert.equal(infoRequests.length, 1, 'the worker is identified once, not per run');
});

test('a resume key crosses the worker boundary and continues the run', async (t) => {
  // The core-to-worker protocol must carry the resume-input seam without
  // exposing any engine concept: it is a neutral `sessionKey` on the session
  // start, and the engine-reported key returns with the settlement. Two runs
  // through a core+worker pair prove the key survives the boundary in both
  // directions.
  const worker = await connectedWorker({
    turns: [
      { events: successEvents, result: { status: 'completed', text: 'first' } },
      { events: successEvents, result: { status: 'completed', text: 'second' } },
    ],
  });
  t.after(() => worker.killChannel());

  const sessionKeys = new InMemorySessionKeyStore();
  const { orchestrator } = buildOrchestrator(worker.adapters, sessionKeys);

  const first = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'one' });
  await orchestrator.waitFor(first.id);
  const second = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'two' });
  await orchestrator.waitFor(second.id);

  const firstKey = worker.engine.sessions[0]?.engineSessionKey;
  assert.ok(firstKey, 'the worker reported the first run\'s engine key to the core');
  assert.equal(worker.engine.requests[0]?.resumeSessionKey, undefined);
  assert.equal(
    worker.engine.requests[1]?.resumeSessionKey,
    firstKey,
    'the core handed the first run\'s key back through the worker',
  );
  assert.equal(worker.engine.sessions[1]?.engineSessionKey, firstKey);
});

test('a worker refuses an engine it does not host', () => {
  assert.throws(
    () =>
      new WorkerClient(
        {
          transport: new LineJsonRpcTransport({
            input: new PassThrough(),
            output: new PassThrough(),
          }),
          environmentInstanceId: 'mac-mini-1',
          engines: [
            {
              id: 'codex',
              streaming: 'incremental',
              supportsInterrupt: true,
              standingInstructions: 'out-of-band',
            },
          ],
        },
        'nope',
      ),
    /does not host engine/,
  );
});

test('an engine that fails to start becomes a failed run through the worker', async (t) => {
  const worker = await connectedWorker({ turns: [], failStart: 'codex binary missing' });
  t.after(() => worker.killChannel());

  const { orchestrator, pool } = buildOrchestrator(worker.adapters);
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'boom' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /codex binary missing/);
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
  assert.match(run.failure ?? '', /codex binary missing/);
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
      { events: [], result: { status: 'failed', message: 'provider authentication failed' } },
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
  assert.match(run.failure ?? '', /provider authentication failed/);
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
  assert.match(reported, /Sprout's own file/);
  assert.match(reported, /SPROUT-PROJECT-CONTRACT\.md/);
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
  assert.match(reported, /was not delivered/);
  assert.match(reported, /could not be read/);
});

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
  const cases: readonly { readonly mechanism: ContractDelivery; readonly expected: RegExp }[] = [
    {
      mechanism: { mechanism: 'agents.md', path: '/tmp/work/AGENTS.md' },
      expected: /delivered to the engine's own AGENTS\.md/,
    },
    {
      mechanism: {
        mechanism: 'sprout-contract-file',
        path: '/tmp/work/SPROUT-PROJECT-CONTRACT.md',
        agentsMdSkipped: 'user-owned',
      },
      expected: /delivered to Sprout's own file/,
    },
    {
      mechanism: { mechanism: 'engine-hook', path: '/cfg/hooks.json' },
      expected: /delivered through the engine's config hook/,
    },
    {
      mechanism: { mechanism: 'skipped-user-owned', path: '/tmp/work/AGENTS.md' },
      expected: /not delivered/,
    },
    {
      mechanism: { mechanism: 'skipped-unreadable', path: '/tmp/work/AGENTS.md' },
      expected: /not delivered/,
    },
    {
      mechanism: { mechanism: 'unavailable', reason: 'no writable location' },
      expected: /not delivered/,
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
    assert.match(reported, testCase.expected);
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
