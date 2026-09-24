import { test } from 'node:test';

import assert from 'node:assert/strict';


import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';

import { EnvironmentPool, InMemoryLeaseStore } from '../environment/pool.ts';

import { ScriptedEngineAdapter } from '../engine/scripted.ts';

import type { AgentRunEvent, EngineAdapter } from '../engine/port.ts';import { AgentRegistry } from '../agent/registry.ts';

import { ProjectRegistry } from '../project/registry.ts';

import type { Project } from '../project/model.ts';

import type { WorkerConnection } from '../worker/carrier.ts';

import { WorkerContextClient } from '../worker/client.ts';

import { LineJsonRpcTransport } from '../engine/jsonrpc.ts';

import { PassThrough } from 'node:stream';

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
  readonly contexts = new WorkerContextClient(
    new LineJsonRpcTransport({ input: new PassThrough(), output: new PassThrough() }),
  );
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


const successEvents: readonly AgentRunEvent[] = [
  { type: 'notice', text: 'starting' },
  { type: 'tool-call', name: 'shell', detail: 'echo hi' },
  { type: 'tool-output', text: 'hi' },
  { type: 'message', text: 'done', final: true },
];


const completed = { status: 'completed', text: 'done' } as const;


const secondDefinition: EnvironmentDefinition = {
  id: 'container-linux',
  platform: 'container',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};

const secondInstance: EnvironmentInstance = { id: 'container-1', definitionId: 'container-linux' };


test('a run left running by a dead process is reconciled instead of shown as live', async () => {
  // Regression from the live runtime: killing Sprout left a run persisted as
  // "running" forever, so the client showed a run that could never progress.
  const store = new InMemoryRunStore();
  const stubEngine = {
    id: 'scripted',
    capabilities: { streaming: 'incremental', supportsInterrupt: true, standingInstructions: 'out-of-band' } as const,
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
