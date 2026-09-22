import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { SqliteStore } from '../store/db.ts';
import type { AgentRun } from '../run/model.ts';
import { InMemoryTaskStore } from './store.ts';
import { TaskEnvironmentLifecycle, type TaskContextWorker } from './environment-lifecycle.ts';
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

function sqliteLifecycle(store: SqliteStore, options: {
  leaseId?: string;
  runId?: () => string;
  worker?: TaskContextWorker;
  onSubmit?: () => void;
} = {}) {
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    store: store.leases,
    idFactory: () => options.leaseId ?? 'lease-1',
  });
  const lifecycle = new TaskEnvironmentLifecycle({
    store: store.tasks,
    pool,
    agents,
    projects,
    ids: {
      task: () => 'task',
      message: () => 'message',
      lease: () => options.leaseId ?? 'lease-1',
      run: options.runId ?? (() => 'run-1'),
    },
    ...(options.worker !== undefined ? { worker: options.worker } : {}),
    runs: { submit: async (request) => { options.onSubmit?.(); return { id: request.runId }; } },
  });
  return { lifecycle, pool };
}

/**
 * Exercise the real process-death path rather than throwing into a caller that
 * still owns the SQLite connection.  The hook runs immediately after its
 * transaction commits, so an exit here leaves the exact durable boundary for
 * the next Sprout process to recover.
 */
function crashLifecycleChild(filename: string, boundary: 'begin' | 'end'): void {
  const exitCode = boundary === 'begin' ? 91 : 92;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { AgentRegistry } from './src/agent/registry.ts';
    import { EnvironmentPool } from './src/environment/pool.ts';
    import { ProjectRegistry } from './src/project/registry.ts';
    import { SqliteStore } from './src/store/db.ts';
    import { TaskEnvironmentLifecycle } from './src/task/environment-lifecycle.ts';

    const store = new SqliteStore({ filename: ${JSON.stringify(filename)} });
    const pool = new EnvironmentPool({
      definitions: [{ id: 'mac', platform: 'macos', capabilities: [{ name: 'agent-run', requiresLease: true }] }],
      instances: [{ id: 'mac-1', definitionId: 'mac', workingDirectory: '/work' }],
      store: store.leases,
      idFactory: () => 'lease-1',
    });
    const lifecycle = new TaskEnvironmentLifecycle({
      store: store.tasks,
      pool,
      agents: new AgentRegistry([{ id: 'pi', name: 'Pi', engine: 'scripted', capability: 'agent-run' }]),
      projects: new ProjectRegistry([{ id: 'project', goal: 'Goal', rules: [], availableEnvironmentInstanceIds: ['mac-1'], memberships: [{ agentId: 'pi', responsibilities: [], collaborationInstructions: '' }] }]),
      ids: { task: () => 'task', message: () => 'message', lease: () => 'lease-1', run: () => 'run-1' },
      runs: { submit: async (request) => ({ id: request.runId }) },
      faults: ${boundary === 'begin'
        ? `{ afterBeginningCommit: () => process.exit(${exitCode}) }`
        : `{ afterTerminalCommit: () => process.exit(${exitCode}) }`},
    });
    await lifecycle.${boundary === 'begin' ? 'begin' : 'end'}('task-1');
    process.exit(1);
  `], { cwd: process.cwd(), encoding: 'utf8' });
  assert.ifError(child.error);
  assert.equal(child.signal, null, String(child.stderr));
  assert.equal(child.status, exitCode, String(child.stderr));
}

test('begin binds a Task-owned non-expiring lease; nested settlement retains it and end releases after recycle', async () => {
  const calls: string[] = [];
  const context: TaskContextWorker = { prepare: async () => { calls.push('prepare'); return { bootstrapInstructions: '' }; }, recycle: async () => { calls.push('recycle'); } };
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
  assert.deepEqual(calls, ['prepare', 'prepare', 'recycle']);
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

test('crashed child begin/end boundaries retain idle Task ownership and make retries durable across SQLite restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-lifecycle-crash-'));
  try {
    const filename = join(directory, 'sprout.db');
    const first = new SqliteStore({ filename });
    await first.tasks.create(task());
    first.close();
    crashLifecycleChild(filename, 'begin');

    const second = new SqliteStore({ filename });
    const resumed = sqliteLifecycle(second);
    await resumed.lifecycle.reconcile();
    assert.equal((await second.tasks.get('task-1'))?.environmentLeaseId, 'lease-1');
    assert.equal(resumed.pool.getLease('lease-1')?.state, 'recovering');
    assert.equal((await resumed.lifecycle.recover('task-1', 'resume')).environmentLifecycleState, 'idle');
    // Retrying begin after its crash is idempotent: it keeps the original lease.
    assert.equal((await resumed.lifecycle.begin('task-1')).environmentLeaseId, 'lease-1');
    await second.tasks.create(task('task-2'));
    second.close();

    const idleRestart = new SqliteStore({ filename });
    const idle = sqliteLifecycle(idleRestart, { leaseId: 'lease-2' });
    assert.equal((await idleRestart.tasks.get('task-1'))?.environmentLifecycleState, 'idle');
    assert.equal(idle.pool.getLease('lease-1')?.state, 'active');
    await assert.rejects(idle.lifecycle.begin('task-2'), /unavailable/);
    idleRestart.close();

    crashLifecycleChild(filename, 'end');
    const final = new SqliteStore({ filename });
    const ended = await final.tasks.get('task-1');
    assert.equal(ended?.environmentLifecycleState, 'ended');
    const terminal = sqliteLifecycle(final);
    assert.equal(terminal.pool.getLease('lease-1')?.state, 'released');
    assert.equal((await terminal.lifecycle.end('task-1')).environmentLifecycleState, 'ended');
    assert.equal((await terminal.lifecycle.end('task-1')).environmentLifecycleState, 'ended');
    final.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SQLite restart recovers an interrupted nested run, retains exclusion, and admits one concurrent owner retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-nested-restart-'));
  try {
    const filename = join(directory, 'sprout.db');
    const first = new SqliteStore({ filename });
    const initial = sqliteLifecycle(first);
    await first.tasks.create(task());
    await initial.lifecycle.begin('task-1');
    await initial.lifecycle.advanceRun('task-1', 'pi', 'first');
    first.close();

    const restarted = new SqliteStore({ filename });
    let nextRun = 0;
    const recovered = sqliteLifecycle(restarted, { runId: () => `run-${++nextRun}` });
    await recovered.lifecycle.reconcile();
    const interrupted = await restarted.tasks.get('task-1');
    assert.equal(interrupted?.environmentLifecycleState, 'recovery');
    assert.equal(interrupted?.recoveryState, 'running');
    assert.equal(recovered.pool.getLease('lease-1')?.state, 'recovering');
    const competing = recovered.pool.acquireLease({ instanceId: 'mac-1', capability: 'agent-run', holderId: 'task-2', taskId: 'task-2', ttlMs: 1 });
    assert.equal(competing.ok, false);

    assert.equal((await recovered.lifecycle.recover('task-1', 'resume')).environmentLifecycleState, 'blocked');
    const attempts = await Promise.allSettled([
      recovered.lifecycle.advanceRun('task-1', 'pi', 'retry one'),
      recovered.lifecycle.advanceRun('task-1', 'pi', 'retry two'),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
    assert.equal((await restarted.tasks.get('task-1'))?.environmentLifecycleState, 'running');
    restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a failed Worker refresh after nested-run admission durably enters retryable recovery after SQLite restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-refresh-recovery-'));
  try {
    const filename = join(directory, 'sprout.db');
    const first = new SqliteStore({ filename });
    let prepareCalls = 0;
    let submitted = 0;
    const failingWorker: TaskContextWorker = {
      prepare: async () => {
        prepareCalls += 1;
        if (prepareCalls === 2) throw new Error('Worker refresh failed');
        return { bootstrapInstructions: '' };
      },
      recycle: async () => {},
    };
    const initial = sqliteLifecycle(first, { worker: failingWorker, onSubmit: () => { submitted += 1; } });
    await first.tasks.create(task());
    const begun = await initial.lifecycle.begin('task-1');
    await assert.rejects(initial.lifecycle.advanceRun('task-1', 'pi', 'go'), /Worker refresh failed/);
    assert.equal(submitted, 0, 'a failed refresh does not submit a nested run');
    assert.equal((await first.tasks.get('task-1'))?.environmentLifecycleState, 'recovery');
    assert.equal(initial.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
    first.close();

    const restarted = new SqliteStore({ filename });
    const recovered = sqliteLifecycle(restarted);
    const durable = await restarted.tasks.get('task-1');
    assert.equal(durable?.environmentLifecycleState, 'recovery');
    assert.equal(durable?.recoveryState, 'running');
    assert.equal(recovered.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
    assert.equal((await recovered.lifecycle.recover('task-1', 'resume')).environmentLifecycleState, 'blocked');
    assert.equal(recovered.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
    restarted.close();
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
