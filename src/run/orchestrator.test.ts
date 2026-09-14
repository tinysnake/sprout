import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool, InMemoryLeaseStore } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import type { AgentRunEvent, EngineAdapter } from '../engine/port.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';
import type { WorkerConnection } from '../worker/carrier.ts';
import { EnvironmentWorkerRegistry } from '../worker/supervisor.ts';
import { InMemoryRunStore } from './store.ts';
import { RunOrchestrator } from './orchestrator.ts';

/**
 * One environment instance's worker, as the core sees it: an instance identity
 * plus the engine adapters that execute there. Distinct fakes stand in for
 * distinct machines in the F1 acceptance test.
 */
class FakeWorkerConnection implements WorkerConnection {
  readonly info: { pid: number; environmentInstanceId: string; engines: [] };
  readonly adapters: ReadonlyMap<string, EngineAdapter>;
  #alive = true;

  constructor(instanceId: string, adapter: EngineAdapter) {
    this.info = { pid: 1, environmentInstanceId: instanceId, engines: [] };
    this.adapters = new Map([['scripted', adapter]]);
  }

  get alive(): boolean {
    return this.#alive;
  }

  async close(): Promise<void> {
    this.#alive = false;
  }
}

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [
    { name: 'agent-run', requiresLease: true },
    { name: 'read-only-investigation', requiresLease: false },
  ],
};
const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

/** The project that grants Scout its environment access, shared by the tests. */
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-sprout',
    goal: 'Ship Sprout',
    rules: ['Report what you observed'],
    availableEnvironmentInstanceIds: ['mac-mini-1'],
    memberships: [
      {
        agentId: 'agent-scout',
        responsibilities: ['Investigate'],
        collaborationInstructions: 'Keep it short',
      },
    ],
    ...overrides,
  };
}

function build(options: {
  turns?: ConstructorParameters<typeof ScriptedEngineAdapter>[0]['turns'];
  failStart?: string;
  onInterrupt?: () => void;
  projects?: readonly Project[];
}) {
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    clock: { now: () => 1_000 },
  });
  const adapter = new ScriptedEngineAdapter({
    turns: options.turns ?? [],
    ...(options.failStart !== undefined ? { failStart: options.failStart } : {}),
    ...(options.onInterrupt !== undefined ? { onInterrupt: options.onInterrupt } : {}),
  });
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
      instructions: 'You are Scout.',
    },
  ]);
  const store = new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects: new ProjectRegistry(options.projects ?? [project()]),
    pool,
    store,
    leaseTtlMs: 60_000,
  });
  return { orchestrator, adapter, pool, store, registry };
}

const successEvents: readonly AgentRunEvent[] = [
  { type: 'notice', text: 'starting' },
  { type: 'tool-call', name: 'shell', detail: 'echo hi' },
  { type: 'tool-output', text: 'hi' },
  { type: 'message', text: 'done', final: true },
];

const completed = { status: 'completed', text: 'done' } as const;

test('a submitted run acquires its lease, streams progress, and completes', async () => {
  const { orchestrator, pool } = build({
    turns: [{ events: successEvents, result: completed }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.deepEqual(
    run.events.map((event) => event.type),
    ['notice', 'tool-call', 'tool-output', 'message'],
  );
  assert.equal(run.result?.status, 'completed');
  assert.equal(run.result?.status === 'completed' && run.result.text, 'done');

  const lease = pool.leases()[0];
  assert.equal(lease?.holderId, 'agent-scout');
  assert.equal(lease?.state, 'released', 'lease is released on completion');
  assert.equal(pool.activeLease('mac-mini-1'), undefined);
});

test('submission returns before the run settles, and progress is observable meanwhile', async () => {
  const { orchestrator } = build({
    turns: [{ events: successEvents, result: completed, settleAfterMs: 40 }],
  });

  const observed: string[] = [];
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  orchestrator.subscribe((run) => {
    if (run.id === id) observed.push(run.status);
  });

  const before = orchestrator.get(id);
  assert.ok(before, 'the run is inspectable immediately after submission');
  assert.notEqual(before.status, 'completed', 'submission does not block until completion');

  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.ok(
    observed.includes('running'),
    `expected an observable running state, saw ${JSON.stringify(observed)}`,
  );
  assert.ok(
    observed.filter((status) => status === 'running').length >= 1 &&
      observed.at(-1) === 'completed',
    `expected progress before the terminal state, saw ${JSON.stringify(observed)}`,
  );
  const firstProgressAt = run.events.findIndex((event) => event.type === 'tool-call');
  assert.ok(firstProgressAt < run.events.length - 1, 'tool progress precedes the final message');
});

test('a conflicting run is refused instead of sharing the environment', async () => {
  const { orchestrator, adapter } = build({
    turns: [{ events: successEvents, result: completed, settleAfterMs: 200 }],
  });

  const first = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'first' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'second' });
  const refused = await orchestrator.waitFor(second.id);

  assert.equal(refused.status, 'failed');
  assert.equal(refused.result?.status, 'failed');
  assert.match(
    refused.result?.status === 'failed' ? refused.result.message : '',
    /lease|environment/i,
  );
  assert.equal(adapter.requests.length, 1, 'the engine never started for the refused run');

  await orchestrator.waitFor(first.id);
});

test('the user can stop a running run and the lease is released', async () => {
  let interrupted = false;
  const { orchestrator, pool } = build({
    onInterrupt: () => {
      interrupted = true;
    },
    turns: [
      {
        events: [{ type: 'notice', text: 'working' }],
        result: completed,
        settleAfterMs: 5_000,
      },
    ],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'long job' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const stopped = await orchestrator.stop(id);

  assert.equal(interrupted, true, 'the adapter received an interrupt');
  assert.equal(stopped.status, 'interrupted');
  assert.equal(stopped.result?.status, 'interrupted');
  assert.equal(pool.activeLease('mac-mini-1'), undefined);
  assert.equal((await orchestrator.waitFor(id)).status, 'interrupted');
});

test('an engine failure becomes an explicit failed state and releases the lease', async () => {
  const { orchestrator, pool } = build({
    turns: [{ events: successEvents, result: { status: 'failed', message: 'engine exploded' } }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'boom' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.equal(run.result?.status === 'failed' && run.result.message, 'engine exploded');
  assert.equal(pool.activeLease('mac-mini-1'), undefined);
});

test('a failure to start the engine becomes an explicit failed state', async () => {
  const { orchestrator, pool } = build({ failStart: 'codex binary missing' });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'boom' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.result?.status === 'failed' ? run.result.message : '', /codex binary missing/);
  assert.equal(pool.activeLease('mac-mini-1'), undefined);
});

test('the agent identity and its environment are Sprout-owned', async () => {
  const { orchestrator, adapter } = build({
    turns: [{ events: successEvents, result: completed }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  await orchestrator.waitFor(id);

  assert.equal(adapter.requests[0]?.agentId, 'agent-scout');
  assert.equal(adapter.requests[0]?.instructions, 'You are Scout.');
  assert.equal(adapter.requests[0]?.workingDirectory, '/tmp');
});

test('a finished run is persisted so it survives a restart', async () => {
  const { orchestrator, store } = build({
    turns: [{ events: successEvents, result: completed }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  await orchestrator.waitFor(id);

  const restored = new RunOrchestrator({
    engines: new Map(),
    agents: new AgentRegistry([]),
    pool: new EnvironmentPool({ definitions: [], instances: [] }),
    store,
  });
  const recovered = await restored.load(id);

  assert.equal(recovered?.status, 'completed');
  assert.equal(recovered?.result?.status === 'completed' && recovered.result.text, 'done');
  assert.equal(recovered?.events.length, successEvents.length);
});

test('an unknown agent is refused', async () => {
  const { orchestrator } = build({ turns: [] });
  const { id } = await orchestrator.submit({ agentId: 'nobody', prompt: 'hello' });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.status, 'failed');
  assert.match(run.result?.status === 'failed' ? run.result.message : '', /unknown agent/i);
});

test('a run whose agent has no engine adapter is refused', async () => {
  const orchestrator = new RunOrchestrator({
    engines: new Map(),
    agents: new AgentRegistry([
      {
        id: 'agent-scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/tmp',
      },
    ]),
    projects: new ProjectRegistry([project()]),
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hello' });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.status, 'failed');
  assert.match(run.result?.status === 'failed' ? run.result.message : '', /no engine/i);
});

test('run ids stay unique across a restart so a new run cannot overwrite a stored one', async () => {
  // Regression: a per-process counter produced `run-1` twice, so a restarted
  // process overwrote an already-persisted `run-1` and destroyed its evidence.
  const store = new InMemoryRunStore();
  const { createIdFactory } = await import('../ids.ts');

  const first = new RunOrchestrator({
    engines: new Map(),
    agents: new AgentRegistry([]),
    pool: new EnvironmentPool({ definitions: [], instances: [] }),
    store,
    ids: createIdFactory(),
  });
  const second = new RunOrchestrator({
    engines: new Map(),
    agents: new AgentRegistry([]),
    pool: new EnvironmentPool({ definitions: [], instances: [] }),
    store,
    ids: createIdFactory(),
  });

  const a = await first.submit({ agentId: 'nobody', prompt: 'first' });
  const b = await second.submit({ agentId: 'nobody', prompt: 'second' });

  assert.notEqual(a.id, b.id, 'a restarted process must not reuse a persisted run id');
  assert.equal((await store.list()).length, 2);
});

test('a run left running by a dead process is reconciled instead of shown as live', async () => {
  // Regression from the live runtime: killing Sprout left a run persisted as
  // "running" forever, so the client showed a run that could never progress.
  const store = new InMemoryRunStore();
  const stubEngine = {
    id: 'scripted',
    capabilities: { streaming: 'incremental', supportsInterrupt: true } as const,
    startSession: () => {
      throw new Error('a recovered run must never be restarted automatically');
    },
  };
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);

  // Process one: a run is persisted while it is still running.
  const first = new RunOrchestrator({
    engines: new Map(),
    agents: registry,
    pool: new EnvironmentPool({ definitions: [], instances: [] }),
    store,
  });
  await store.save({
    id: 'orphan-1',
    agentId: 'agent-scout',
    prompt: 'was running when the process died',
    environmentInstanceId: 'mac-mini-1',
    status: 'running',
    events: [{ type: 'notice', text: 'was working' }],
    leaseId: 'lease-1',
    createdAt: 1_000,
  });

  // Process two: same store, no in-memory state.
  const second = new RunOrchestrator({
    engines: new Map([['scripted', stubEngine]]),
    agents: registry,
    pool: new EnvironmentPool({ definitions: [], instances: [] }),
    store,
    clock: { now: () => 5_000 },
  });
  const recovered = await second.reconcileOrphanedRuns();

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.id, 'orphan-1');
  assert.equal(recovered[0]?.status, 'failed');
  assert.match(recovered[0]?.failure ?? '', /restart/i);

  const listed = await second.list();
  assert.equal(listed[0]?.status, 'failed');
  assert.deepEqual(listed[0]?.events, [{ type: 'notice', text: 'was working' }]);
  first.get('orphan-1');
});

test('a completed run is not disturbed by restart reconciliation', async () => {
  const store = new InMemoryRunStore();
  await store.save({
    id: 'done-1',
    agentId: 'agent-scout',
    prompt: 'finished',
    environmentInstanceId: 'mac-mini-1',
    status: 'completed',
    events: [],
    result: { status: 'completed', text: 'ok' },
    createdAt: 1_000,
    completedAt: 2_000,
  });

  const orchestrator = new RunOrchestrator({
    engines: new Map(),
    agents: new AgentRegistry([]),
    pool: new EnvironmentPool({ definitions: [], instances: [] }),
    store,
  });
  const recovered = await orchestrator.reconcileOrphanedRuns();

  assert.equal(recovered.length, 0);
  const listed = await orchestrator.list();
  assert.equal(listed[0]?.status, 'completed');
});

test('an orphaned run has its lease transitioned to recovering on restart, blocking subsequent runs until resolved', async () => {
  const store = new InMemoryRunStore();
  const leaseStore = new InMemoryLeaseStore();

  const poolOptions = {
    definitions: [definition],
    instances: [instance],
    store: leaseStore,
  };

  // Seed an orphaned run and its active lease.
  leaseStore.save({
    id: 'lease-orphaned',
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    holderId: 'agent-scout',
    runId: 'orphan-1',
    acquiredAt: 1_000,
    expiresAt: 600_000,
    state: 'active',
  });

  await store.save({
    id: 'orphan-1',
    agentId: 'agent-scout',
    prompt: 'interrupted turn',
    environmentInstanceId: 'mac-mini-1',
    status: 'running',
    events: [{ type: 'notice', text: 'in-flight event' }],
    leaseId: 'lease-orphaned',
    createdAt: 1_000,
  });

  const adapter = new ScriptedEngineAdapter({
    turns: [{ events: [{ type: 'message', text: 'ok', final: true }], result: { status: 'completed', text: 'ok' } }],
  });
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
      instructions: 'You are Scout.',
    },
  ]);

  // Second process starts up with the persisted pool and store.
  const pool = new EnvironmentPool(poolOptions);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects: new ProjectRegistry([project()]),
    pool,
    store,
    clock: { now: () => 5_000 },
  });

  const recovered = await orchestrator.reconcileOrphanedRuns();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, 'failed');
  assert.deepEqual(recovered[0]?.events, [{ type: 'notice', text: 'in-flight event' }]);

  // The lease must now be in recovery, not forgotten or active.
  const lease = pool.getLease('lease-orphaned');
  assert.equal(lease?.state, 'recovering');
  assert.equal(leaseStore.get('lease-orphaned')?.state, 'recovering');

  // Acquiring that environment for a new run must conflict with recovery message.
  const nextSubmit = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'try again' });
  const settled = await orchestrator.waitFor(nextSubmit.id);
  assert.equal(settled.status, 'failed');
  assert.match(settled.failure ?? '', /in recovery/i);

  // Resolving/releasing the recovering lease frees the environment.
  const released = orchestrator.releaseLease('lease-orphaned');
  assert.equal(released?.state, 'released');

  // A new run now succeeds.
  const retrySubmit = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'now it works' });
  const retrySettled = await orchestrator.waitFor(retrySubmit.id);
  assert.equal(retrySettled.status, 'completed');
});

const secondDefinition: EnvironmentDefinition = {
  id: 'container-linux',
  platform: 'container',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const secondInstance: EnvironmentInstance = { id: 'container-1', definitionId: 'container-linux' };

test('an agent with no fixed environment runs on an instance resolved from its project', async () => {
  const pool = new EnvironmentPool({
    definitions: [definition, secondDefinition],
    instances: [instance, secondInstance],
    clock: { now: () => 1_000 },
  });
  const adapter = new ScriptedEngineAdapter({
    turns: [{ events: successEvents, result: completed }],
  });
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);
  // The project names the container, not the first pool instance, so the run can
  // only land there if resolution actually consulted the project.
  const projects = new ProjectRegistry([
    project({ id: 'project-portable', availableEnvironmentInstanceIds: ['container-1'] }),
  ]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool,
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal(run.environmentInstanceId, 'container-1');
  assert.equal(run.projectId, 'project-portable');
  assert.equal(pool.leases()[0]?.instanceId, 'container-1');
});

test('the project-selected environment instance selects the executing worker, and the run records it', async () => {
  // F1 acceptance check (#18): a run that leases container-1 must execute on
  // container-1's worker. Two distinct worker connections each hold their own
  // adapter, and the project names container-1, so a pass proves execution
  // followed the resolved instance rather than one global adapter map.
  const definitionFor = (id: string, platform: EnvironmentDefinition['platform']): EnvironmentDefinition => ({
    id,
    platform,
    capabilities: [{ name: 'agent-run', requiresLease: true }],
  });
  const macInstance: EnvironmentInstance = {
    id: 'mac-mini-1',
    definitionId: 'macos-workstation',
    workingDirectory: '/tmp/mac-work',
  };
  const containerInstance: EnvironmentInstance = {
    id: 'container-1',
    definitionId: 'container-linux',
    workingDirectory: '/sprout',
  };
  const macAdapter = new ScriptedEngineAdapter({
    turns: [{ events: successEvents, result: completed }],
  });
  const containerAdapter = new ScriptedEngineAdapter({
    turns: [{ events: successEvents, result: { status: 'completed', text: 'from container' } }],
  });
  const workers: Record<string, FakeWorkerConnection> = {
    'mac-mini-1': new FakeWorkerConnection('mac-mini-1', macAdapter),
    'container-1': new FakeWorkerConnection('container-1', containerAdapter),
  };
  const requestedInstances: string[] = [];
  const workerRegistry = new EnvironmentWorkerRegistry({
    connect: (instanceId) => {
      requestedInstances.push(instanceId);
      return Promise.resolve(workers[instanceId]!);
    },
  });

  const pool = new EnvironmentPool({
    definitions: [definitionFor('macos-workstation', 'macos'), definitionFor('container-linux', 'container')],
    instances: [macInstance, containerInstance],
    clock: { now: () => 1_000 },
  });
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      // No fixed directory: the resolved instance supplies it.
    },
  ]);
  const projects = new ProjectRegistry([
    project({ id: 'project-portable', availableEnvironmentInstanceIds: ['container-1'] }),
  ]);
  const store = new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    // Production wiring: adapters come from the worker serving the run's instance.
    engines: (instanceId) => workerRegistry.adapters(instanceId),
    agents: registry,
    projects,
    pool,
    store,
    leaseTtlMs: 60_000,
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  const run = await orchestrator.waitFor(id);
  await workerRegistry.close();

  assert.equal(run.status, 'completed');
  assert.deepEqual(requestedInstances, ['container-1'], 'the worker for the leased instance was used');
  assert.equal(containerAdapter.requests.length, 1, "the selected instance's worker executed the run");
  assert.equal(macAdapter.requests.length, 0, 'the other instance never executed it');
  assert.equal(
    containerAdapter.requests[0]?.workingDirectory,
    '/sprout',
    "the run's directory came from the resolved instance",
  );
  assert.equal(run.environmentInstanceId, 'container-1');
  assert.equal(pool.leases()[0]?.instanceId, 'container-1');

  const stored = await store.get(id);
  assert.equal(stored?.environmentInstanceId, 'container-1', 'the record agrees with the executing worker');
  assert.equal(
    store.writes.every((write) => write.environmentInstanceId === 'container-1'),
    true,
  );
});

test('a run records the environment instance it used, observably through the store', async () => {
  const { orchestrator, store } = build({
    turns: [{ events: successEvents, result: completed }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  await orchestrator.waitFor(id);

  const stored = await store.get(id);
  assert.equal(stored?.environmentInstanceId, 'mac-mini-1');
  assert.equal(stored?.projectId, 'project-sprout');
  assert.equal(
    store.writes.every((write) => write.environmentInstanceId === 'mac-mini-1'),
    true,
    'every persisted state names the instance actually used',
  );
});

test('two agents whose project-resolved environments conflict are prevented from concurrent use', async () => {
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    clock: { now: () => 1_000 },
  });
  const adapter = new ScriptedEngineAdapter({
    turns: [{ events: successEvents, result: completed, settleAfterMs: 200 }],
  });
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
    {
      id: 'agent-cartographer',
      name: 'Cartographer',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);
  // Both agents are members of the same project, so both resolve to the same
  // single available instance and their leases must conflict.
  const projects = new ProjectRegistry([
    project({
      memberships: [
        {
          agentId: 'agent-scout',
          responsibilities: ['Investigate'],
          collaborationInstructions: 'Keep it short',
        },
        {
          agentId: 'agent-cartographer',
          responsibilities: ['Map'],
          collaborationInstructions: 'Keep it short',
        },
      ],
    }),
  ]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool,
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });

  const first = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'first' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await orchestrator.submit({ agentId: 'agent-cartographer', prompt: 'second' });
  const refused = await orchestrator.waitFor(second.id);

  assert.equal(refused.status, 'failed');
  assert.match(refused.failure ?? '', /mac-mini-1/);
  assert.match(refused.failure ?? '', /leased|recovery/i);
  assert.equal(adapter.requests.length, 1, 'the engine never started for the refused run');

  await orchestrator.waitFor(first.id);
});

test('an agent that belongs to no project is refused rather than guessed at', async () => {
  const { orchestrator } = build({ turns: [], projects: [] });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hello' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /no project/i);
});

test('an agent whose project offers no usable environment is refused explicitly', async () => {
  const { orchestrator } = build({
    turns: [],
    projects: [project({ availableEnvironmentInstanceIds: ['some-other-machine'] })],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hello' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /no available environment/i);
});
