import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { SqliteStore } from '../run/sqlite-store.ts';
import type { AgentRun } from '../run/model.ts';
import { InMemoryTaskStore } from './store.ts';
import { DurableWriteCrash, TaskEnvironmentLifecycle, type TaskContextWorker } from './environment-lifecycle.ts';
import type { Task } from './model.ts';

const definition: EnvironmentDefinition = { id: 'mac', platform: 'macos', capabilities: [{ name: 'agent-run', requiresLease: true }] };
const instance: EnvironmentInstance = { id: 'mac-1', definitionId: 'mac', workingDirectory: '/work' };
const agents = new AgentRegistry([{ id: 'pi', name: 'Pi', engine: 'scripted', capability: 'agent-run' }]);
const projects = new ProjectRegistry([{ id: 'project', goal: 'Goal', rules: [], availableEnvironmentInstanceIds: ['mac-1'], memberships: [{ agentId: 'pi', responsibilities: [], collaborationInstructions: '' }] }]);

function task(id = 'task-1'): Task {
  return { id, projectId: 'project', title: 'Task', goal: 'Goal', constraints: [], status: 'todo', assignedAgentId: 'pi', createdAt: 1, updatedAt: 1 };
}

function run(id: string, status: AgentRun['status']): AgentRun {
  return { id, agentId: 'pi', prompt: 'go', environmentInstanceId: 'mac-1', projectId: 'project', taskId: 'task-1', leaseId: 'lease-1', status, events: [], createdAt: 1, ...(status === 'failed' ? { failure: 'failed' } : {}), ...(status !== 'queued' && status !== 'running' ? { completedAt: 2 } : {}) };
}

function build(options: { worker?: TaskContextWorker; store?: InMemoryTaskStore; pool?: EnvironmentPool } = {}) {
  const store = options.store ?? new InMemoryTaskStore();
  const pool = options.pool ?? new EnvironmentPool({ definitions: [definition], instances: [instance], idFactory: () => 'lease-1' });
  const submitted: { runId: string }[] = [];
  const lifecycle = new TaskEnvironmentLifecycle({ store, pool, agents, projects, ...(options.worker !== undefined ? { worker: options.worker } : {}), ids: { task: () => 'task', message: () => 'message', lease: () => 'lease', run: () => 'run-1' }, runs: { submit: async (request) => { submitted.push({ runId: request.runId }); return { id: request.runId }; } } });
  return { store, pool, lifecycle, submitted };
}

test('begin binds a Task-owned non-expiring lease; nested settlement retains it and end releases after recycle', async () => {
  const calls: string[] = [];
  const context: TaskContextWorker = { prepare: async () => { calls.push('prepare'); }, recycle: async () => { calls.push('recycle'); } };
  const scenario = build({ worker: context });
  await scenario.store.create(task());

  const begun = await scenario.lifecycle.begin('task-1');
  assert.equal(begun.environmentLifecycleState, 'idle');
  assert.equal(begun.environmentInstanceId, 'mac-1');
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.holderKind, 'task');

  const advanced = await scenario.lifecycle.advanceRun('task-1', 'pi', 'go');
  await assert.rejects(scenario.lifecycle.advanceRun('task-1', 'pi', 'again'), /already has an active run/);
  await assert.rejects(scenario.lifecycle.end('task-1'), /while run/);
  await scenario.lifecycle.settleRun('task-1', run(advanced.runId, 'completed'));
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
  const ended = await scenario.lifecycle.end('task-1');
  assert.equal(ended.environmentLifecycleState, 'ended');
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'released');
  assert.deepEqual(calls, ['prepare', 'recycle']);
});

test('interrupted nested work and restart retain exclusion until the owning Task resumes or discards', async () => {
  const scenario = build();
  await scenario.store.create(task());
  const begun = await scenario.lifecycle.begin('task-1');
  const advanced = await scenario.lifecycle.advanceRun('task-1', 'pi', 'go');
  await scenario.lifecycle.settleRun('task-1', run(advanced.runId, 'interrupted'));
  assert.equal((await scenario.store.get('task-1'))?.environmentLifecycleState, 'recovery');
  const competing = scenario.pool.acquireLease({ instanceId: 'mac-1', capability: 'agent-run', holderId: 'run-2', runId: 'run-2', ttlMs: 1 });
  assert.equal(competing.ok, false);
  const resumed = await scenario.lifecycle.recover('task-1', 'resume');
  assert.equal(resumed.environmentLifecycleState, 'blocked');
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
  await scenario.lifecycle.reconcile();
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
  const discarded = await scenario.lifecycle.recover('task-1', 'discard');
  assert.equal(discarded.environmentLifecycleState, 'discarded');
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'released');
});

test('SQLite begin and ending crash windows restart as blocking recovery and accept idempotent retries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-lease-'));
  try {
    const filename = join(directory, 'sprout.db');
    const first = new SqliteStore({ filename });
    const firstPool = new EnvironmentPool({ definitions: [definition], instances: [instance], store: first.leases, idFactory: () => 'lease-1' });
    const prepareThenCrash: TaskContextWorker = { prepare: async () => { throw new Error('crash after prepare'); }, recycle: async () => {} };
    const initial = new TaskEnvironmentLifecycle({ store: first.tasks, pool: firstPool, agents, projects, worker: prepareThenCrash, runs: { submit: async () => ({ id: 'never' }) } });
    await first.tasks.create(task());
    await assert.rejects(initial.begin('task-1'), /crash after prepare/);
    first.close();

    const restarted = new SqliteStore({ filename });
    const restartPool = new EnvironmentPool({ definitions: [definition], instances: [instance], store: restarted.leases, idFactory: () => 'lease-2' });
    const resumed = new TaskEnvironmentLifecycle({ store: restarted.tasks, pool: restartPool, agents, projects, runs: { submit: async () => ({ id: 'never' }) } });
    await resumed.reconcile();
    assert.equal((await restarted.tasks.get('task-1'))?.environmentLifecycleState, 'recovery');
    await resumed.recover('task-1', 'resume');
    const endCrash = new TaskEnvironmentLifecycle({
      store: restarted.tasks, pool: restartPool, agents, projects,
      worker: { prepare: async () => {}, recycle: async () => { throw new Error('crash after recycle'); } },
      runs: { submit: async () => ({ id: 'never' }) },
    });
    await assert.rejects(endCrash.end('task-1'), /crash after recycle/);
    assert.equal((await restarted.tasks.get('task-1'))?.recoveryState, 'ending');
    restarted.close();
    const finalStore = new SqliteStore({ filename });
    const finalPool = new EnvironmentPool({ definitions: [definition], instances: [instance], store: finalStore.leases, idFactory: () => 'lease-3' });
    const finalLifecycle = new TaskEnvironmentLifecycle({ store: finalStore.tasks, pool: finalPool, agents, projects, runs: { submit: async () => ({ id: 'never' }) } });
    await finalLifecycle.reconcile();
    const one = await finalLifecycle.recover('task-1', 'discard');
    const two = await finalLifecycle.recover('task-1', 'discard');
    assert.equal(one.environmentLifecycleState, 'discarded');
    assert.equal(two.environmentLifecycleState, 'discarded');
    finalStore.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('durable begin/end fault boundaries recover across SQLite restart without an unowned lease', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-durable-fault-'));
  try {
    const filename = join(directory, 'sprout.db');
    const first = new SqliteStore({ filename });
    const firstPool = new EnvironmentPool({ definitions: [definition], instances: [instance], store: first.leases, idFactory: () => 'lease-1' });
    await first.tasks.create(task());
    const crashAfterBeginCommit = new TaskEnvironmentLifecycle({
      store: first.tasks, pool: firstPool, agents, projects, runs: { submit: async () => ({ id: 'never' }) },
      faults: { afterBeginningCommit: () => { throw new DurableWriteCrash('simulated process crash after beginning commit'); } },
    });
    await assert.rejects(crashAfterBeginCommit.begin('task-1'), /simulated process crash/);
    first.close();

    const second = new SqliteStore({ filename });
    const secondPool = new EnvironmentPool({ definitions: [definition], instances: [instance], store: second.leases, idFactory: () => 'lease-2' });
    const resumed = new TaskEnvironmentLifecycle({ store: second.tasks, pool: secondPool, agents, projects, runs: { submit: async () => ({ id: 'never' }) } });
    await resumed.reconcile();
    assert.equal((await second.tasks.get('task-1'))?.environmentLeaseId, 'lease-1');
    assert.equal(secondPool.getLease('lease-1')?.holderKind, 'task');
    await resumed.recover('task-1', 'resume');
    const crashAfterEndCommit = new TaskEnvironmentLifecycle({
      store: second.tasks, pool: secondPool, agents, projects, runs: { submit: async () => ({ id: 'never' }) },
      faults: { afterTerminalCommit: () => { throw new DurableWriteCrash('simulated process crash after terminal commit'); } },
    });
    await assert.rejects(crashAfterEndCommit.end('task-1'), /simulated process crash/);
    second.close();

    const final = new SqliteStore({ filename });
    const finalPool = new EnvironmentPool({ definitions: [definition], instances: [instance], store: final.leases });
    const ended = await final.tasks.get('task-1');
    assert.equal(ended?.environmentLifecycleState, 'ended');
    assert.equal(finalPool.getLease('lease-1')?.state, 'released');
    final.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('worker channel loss enters owner recovery and validation retains the Task lease', async () => {
  const scenario = build();
  await scenario.store.create(task());
  const begun = await scenario.lifecycle.begin('task-1');
  const advanced = await scenario.lifecycle.advanceRun('task-1', 'pi', 'go');
  await scenario.lifecycle.settleRun('task-1', {
    ...run(advanced.runId, 'failed'),
    failure: 'environment worker channel closed: disconnected',
  });
  assert.equal((await scenario.store.get('task-1'))?.environmentLifecycleState, 'recovery');
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
  await scenario.lifecycle.recover('task-1', 'resume');
  const awaiting = await scenario.lifecycle.awaitHumanValidation('task-1');
  assert.equal(awaiting.environmentLifecycleState, 'awaiting-validation');
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
  scenario.pool.markRecovering(begun.environmentLeaseId!);
  assert.equal(scenario.pool.resolveRecovery(begun.environmentLeaseId!), undefined);
  assert.equal(scenario.pool.releaseLease(begun.environmentLeaseId!), undefined);
});
