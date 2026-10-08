import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { SqliteStore } from '../store/db.ts';
import { createExecutionStrategy } from '../execution-mode.ts';
import type { AgentRun } from '../run/model.ts';
import { InMemoryTaskStore } from './store.ts';
import { TaskEnvironmentLifecycle, type TaskContextWorker } from './environment-lifecycle.ts';
import type { Task } from './model.ts';

class PauseRaceStore extends InMemoryTaskStore {
  readonly pauseWriteStarted: Promise<void>;
  #startPauseWrite!: () => void;
  #releasePauseWrite!: () => void;
  readonly #pauseWriteGate = new Promise<void>((resolve) => { this.#releasePauseWrite = resolve; });

  constructor() {
    super();
    this.pauseWriteStarted = new Promise<void>((resolve) => { this.#startPauseWrite = resolve; });
  }

  releasePauseWrite(): void { this.#releasePauseWrite(); }

  override async saveIfUnchanged(task: Task, expected: Parameters<InMemoryTaskStore['saveIfUnchanged']>[1]): Promise<boolean> {
    if (task.pauseState === 'requested') {
      this.#startPauseWrite();
      await this.#pauseWriteGate;
    }
    return super.saveIfUnchanged(task, expected);
  }
}

class PauseExhaustionStore extends InMemoryTaskStore {
  readonly firstPauseWriteStarted: Promise<void>;
  #startPauseWrite!: () => void;
  #releasePauseWrite!: () => void;
  readonly #firstPauseWriteGate = new Promise<void>((resolve) => { this.#releasePauseWrite = resolve; });
  #failedAttempts = 3;
  #pauseAttempts = 0;

  constructor() {
    super();
    this.firstPauseWriteStarted = new Promise<void>((resolve) => { this.#startPauseWrite = resolve; });
  }

  get pauseAttempts(): number { return this.#pauseAttempts; }
  releaseFirstPauseWrite(): void { this.#releasePauseWrite(); }
  allowPauseWrites(): void { this.#failedAttempts = 0; }

  override async saveIfUnchanged(task: Task, expected: Parameters<InMemoryTaskStore['saveIfUnchanged']>[1]): Promise<boolean> {
    if (task.pauseState === 'requested' || task.pauseState === 'paused') {
      this.#pauseAttempts += 1;
      if (this.#pauseAttempts === 1) {
        this.#startPauseWrite();
        await this.#firstPauseWriteGate;
      }
      if (this.#failedAttempts > 0) {
        this.#failedAttempts -= 1;
        return false;
      }
    }
    return super.saveIfUnchanged(task, expected);
  }
}

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
  let nextRun = 0;
  const lifecycle = new TaskEnvironmentLifecycle({ store, pool, agents, projects, ...(options.worker !== undefined ? { worker: options.worker } : {}), ids: { task: () => 'task', message: () => 'message', projectEvent: () => 'project-event', lease: () => 'lease', run: () => `run-${++nextRun}` }, runs: { submit: async (request) => { submitted.push({ runId: request.runId }); return { id: request.runId }; } } });
  return { store, pool, lifecycle, submitted };
}

function sqliteLifecycle(store: SqliteStore, options: {
  leaseId?: string;
  runId?: () => string;
  worker?: TaskContextWorker;
  onSubmit?: () => void;
  executionStrategy?: ReturnType<typeof createExecutionStrategy>;
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
      message: () => 'message', projectEvent: () => 'project-event',
      lease: () => options.leaseId ?? 'lease-1',
      run: options.runId ?? (() => 'run-1'),
    },
    ...(options.worker !== undefined ? { worker: options.worker } : {}),
    ...(options.executionStrategy !== undefined ? { executionStrategy: options.executionStrategy } : {}),
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
      ids: { task: () => 'task', message: () => 'message', projectEvent: () => 'project-event', lease: () => 'lease-1', run: () => 'run-1' },
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

test('clearIdleRecovery restores the exact lease when Task persistence fails', async () => {
  let now = 100;
  const store = new InMemoryTaskStore();
  const pool = new EnvironmentPool({
    definitions: [definition], instances: [instance], clock: { now: () => now }, idFactory: () => 'lease-1',
  });
  const scenario = build({ store, pool });
  await store.create(task());
  const begun = await scenario.lifecycle.begin('task-1');
  await scenario.lifecycle.workerChannelLost('task-1');
  const taskBefore = await store.get('task-1');
  const leaseBefore = pool.getLease(begun.environmentLeaseId!);
  assert.equal(taskBefore?.environmentLifecycleState, 'recovery');
  assert.equal(leaseBefore?.state, 'recovering');

  now = 101;
  store.save = async () => { throw new Error('task store is locked'); };

  await assert.rejects(scenario.lifecycle.clearIdleRecovery('task-1'), /task store is locked/);

  assert.deepEqual(pool.getLease(begun.environmentLeaseId!), leaseBefore, 'failed recovery clearing must restore the exact lease');
  assert.deepEqual(await store.get('task-1'), taskBefore, 'failed recovery clearing must leave the Task in recovery');
});


test('overdue blocked Task lease enters retained recovery before competing acquisition', async () => {
  let now = 1;
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance], clock: { now: () => now }, idFactory: () => 'lease-1' });
  const scenario = build({ pool });
  await scenario.store.create(task());
  const begun = await scenario.lifecycle.begin('task-1');
  await scenario.store.save({ ...begun, status: 'blocked', environmentLifecycleState: 'blocked' });
  now = pool.getLease(begun.environmentLeaseId!)!.expiresAt;
  const acquired = await pool.acquireLeaseRevalidated({ instanceId: 'mac-1', capability: 'agent-run', holderId: 'other', ttlMs: 1000 });
  assert.equal(acquired.ok, false);
  if (!acquired.ok) assert.equal(acquired.state, 'recovering');
  const recovering = await scenario.store.get('task-1');
  assert.equal(recovering?.environmentLifecycleState, 'recovery');
  assert.equal(recovering?.recoveryState, 'blocked');
  assert.equal(recovering?.status, 'blocked');
  assert.equal(pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
  await scenario.lifecycle.recover('task-1', 'resume');
  assert.equal((await scenario.store.get('task-1'))?.environmentLifecycleState, 'blocked');
  assert.ok(pool.getLease(begun.environmentLeaseId!)!.expiresAt > now);
  assert.equal((await pool.acquireLeaseRevalidated({ instanceId: 'mac-1', capability: 'agent-run', holderId: 'other', ttlMs: 1000 })).ok, false);
});

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

test('Pause retries after natural settlement wins its compare-and-set before later admission', async () => {
  const store = new PauseRaceStore();
  const scenario = build({ store });
  await store.create(task());
  const begun = await scenario.lifecycle.begin('task-1');
  const advanced = await scenario.lifecycle.advanceRun('task-1', 'pi', 'go');

  const pausePending = scenario.lifecycle.requestPause('task-1', { memberId: 'operator', memberKind: 'human' }, 'hold before next run');
  await store.pauseWriteStarted;
  await scenario.lifecycle.settleRun('task-1', run(advanced.runId, 'completed'));
  const settled = await store.get('task-1');
  assert.equal(settled?.environmentLifecycleState, 'idle');
  assert.equal(settled?.activeRunId, undefined);
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
  const competingAdmission = scenario.lifecycle.advanceRun('task-1', 'pi', 'run-2');
  await setImmediate();
  assert.deepEqual(scenario.submitted.map((item) => item.runId), ['run-1']);
  assert.equal((await store.get('task-1'))?.activeRunId, undefined);

  store.releasePauseWrite();
  const paused = await pausePending;
  assert.equal(paused.pauseState, 'paused');
  assert.deepEqual(paused.controlHistory?.map((event) => event.action), ['paused']);
  await assert.rejects(competingAdmission, /paused/i);
  assert.deepEqual(scenario.submitted.map((item) => item.runId), ['run-1']);
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
});

test('Pause CAS exhaustion keeps queued admission gated until the Human retries or cancels the request', async () => {
  const store = new PauseExhaustionStore();
  const scenario = build({ store });
  await store.create(task());
  const begun = await scenario.lifecycle.begin('task-1');
  const advanced = await scenario.lifecycle.advanceRun('task-1', 'pi', 'run-1');

  const pausePending = scenario.lifecycle.requestPause('task-1', { memberId: 'operator', memberKind: 'human' }, 'hold before next run');
  await store.firstPauseWriteStarted;
  await scenario.lifecycle.settleRun('task-1', run(advanced.runId, 'completed'));
  const queuedAdmission = scenario.lifecycle.advanceRun('task-1', 'pi', 'run-2');
  let admissionSettled = false;
  void queuedAdmission.then(() => { admissionSettled = true; }, () => { admissionSettled = true; });

  store.releaseFirstPauseWrite();
  await assert.rejects(pausePending, /retry Human Pause/);
  await setImmediate();
  assert.equal(store.pauseAttempts, 3);
  assert.equal(admissionSettled, false);
  assert.deepEqual(scenario.submitted.map((item) => item.runId), ['run-1']);
  assert.equal((await store.get('task-1'))?.pauseState, 'retry-required');
  assert.equal((await store.get('task-1'))?.activeRunId, undefined);
  await assert.rejects(scenario.lifecycle.resumePause('task-1', { memberId: 'operator', memberKind: 'human' }, 'bypass required resolution'), /retried or explicitly cancelled/);
  await assert.rejects(scenario.lifecycle.discardForHuman('task-1', { memberId: 'operator', memberKind: 'human' }, 'bypass required resolution'), /retried or explicitly cancelled/);
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'active');

  store.allowPauseWrites();
  const retried = await scenario.lifecycle.requestPause('task-1', { memberId: 'operator', memberKind: 'human' }, 'confirm the hold');
  assert.equal(retried.pauseState, 'paused');
  await assert.rejects(queuedAdmission, /paused/i);
  assert.deepEqual(scenario.submitted.map((item) => item.runId), ['run-1']);
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
});

test('Human cancellation releases admission after exhausted Pause CAS', async () => {
  const store = new PauseExhaustionStore();
  const scenario = build({ store });
  await store.create(task());
  const begun = await scenario.lifecycle.begin('task-1');
  const advanced = await scenario.lifecycle.advanceRun('task-1', 'pi', 'run-1');
  const actor = { memberId: 'operator', memberKind: 'human' } as const;

  const pausePending = scenario.lifecycle.requestPause('task-1', actor, 'hold before next run');
  await store.firstPauseWriteStarted;
  await scenario.lifecycle.settleRun('task-1', run(advanced.runId, 'completed'));
  const queuedAdmission = scenario.lifecycle.advanceRun('task-1', 'pi', 'run-2');
  let admissionSettled = false;
  void queuedAdmission.then(() => { admissionSettled = true; }, () => { admissionSettled = true; });

  store.releaseFirstPauseWrite();
  await assert.rejects(pausePending, /retry Human Pause/);
  await setImmediate();
  assert.equal(store.pauseAttempts, 3);
  assert.equal(admissionSettled, false);
  assert.deepEqual(scenario.submitted.map((item) => item.runId), ['run-1']);

  const cancelled = await scenario.lifecycle.cancelPauseRetryForHuman('task-1', actor, 'cancel the pending hold');
  assert.equal(cancelled.pauseState, undefined);
  assert.equal(cancelled.controlHistory?.at(-1)?.action, 'pause-request-cancelled');
  await queuedAdmission;
  assert.deepEqual(scenario.submitted.map((item) => item.runId), ['run-1', 'run-2']);
  assert.equal((await store.get('task-1'))?.activeRunId, 'run-2');
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
});

test('Human pause blocks later admission, Interrupt settles stopped, and the Task lease stays held until resume', async () => {
  const scenario = build();
  await scenario.store.create(task());
  const begun = await scenario.lifecycle.begin('task-1');
  const advanced = await scenario.lifecycle.advanceRun('task-1', 'pi', 'go');

  const pauseRequested = await scenario.lifecycle.requestPause('task-1', { memberId: 'operator', memberKind: 'human' }, 'hold after this run');
  assert.equal(pauseRequested.pauseState, 'requested');
  await scenario.lifecycle.settleRun('task-1', run(advanced.runId, 'stopped'));
  const paused = await scenario.store.get('task-1');
  assert.equal(paused?.pauseState, 'paused');
  await assert.rejects(scenario.lifecycle.advanceRun('task-1', 'pi', 'must not start'), /paused/i);
  assert.equal(paused?.environmentLifecycleState, 'idle');
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'active');

  await scenario.lifecycle.resumePause('task-1', { memberId: 'operator', memberKind: 'human' }, 'continue deliberately');
  assert.equal((await scenario.store.get('task-1'))?.pauseState, undefined);
  assert.equal(scenario.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
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

test('a mode mismatch refuses Task advancement before changing run or lease state', async () => {
  const scenario = build();
  const reservation = scenario.pool.reserveTaskLease({
    instanceId: 'mac-1', capability: 'agent-run', holderId: 'task-1', taskId: 'task-1', ttlMs: 60_000,
  });
  assert.equal(reservation.ok, true);
  if (!reservation.ok) return;
  scenario.pool.adoptLease(reservation.lease);
  await scenario.store.create({
    ...task(),
    status: 'in-progress',
    executionPlacement: {
      mode: 'host-run',
      engineHost: { kind: 'sprout', id: 'sprout-test', profile: { platform: 'macos', boundary: 'shared-host' } },
    },
    environmentInstanceId: 'mac-1',
    environmentLeaseId: reservation.lease.id,
    environmentLifecycleState: 'idle',
  });

  await assert.rejects(
    scenario.lifecycle.advanceRun('task-1', 'pi', 'continue'),
    /recorded under host-run.*this Sprout process is environment-hosted/,
  );
  assert.equal((await scenario.store.get('task-1'))?.environmentLifecycleState, 'idle');
  assert.equal(scenario.pool.getLease(reservation.lease.id)?.state, 'active');
  assert.deepEqual(scenario.submitted, []);
});

test('a Task retains its Environment-hosted placement through SQLite restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-placement-restart-'));
  try {
    const filename = join(directory, 'sprout.db');
    const first = new SqliteStore({ filename });
    await first.tasks.create(task());
    const initial = sqliteLifecycle(first);
    const begun = await initial.lifecycle.begin('task-1');
    assert.equal(begun.executionPlacement?.mode, 'environment-hosted');
    assert.equal(begun.executionPlacement?.engineHost?.id, 'mac-1');
    first.close();

    const reopened = new SqliteStore({ filename });
    const restored = await reopened.tasks.get('task-1');
    assert.deepEqual(restored?.executionPlacement, begun.executionPlacement);
    assert.equal(restored?.environmentInstanceId, begun.environmentInstanceId);
    assert.equal(restored?.environmentLeaseId, begun.environmentLeaseId);
    assert.equal(reopened.leases.get(begun.environmentLeaseId!)?.instanceId, begun.environmentInstanceId);
    assert.equal(reopened.leases.get(begun.environmentLeaseId!)?.state, 'active');
    const mismatch = sqliteLifecycle(reopened, { executionStrategy: createExecutionStrategy('host-run') });
    await assert.rejects(
      mismatch.lifecycle.advanceRun('task-1', 'pi', 'continue after restart'),
      /recorded under environment-hosted.*this Sprout process is host-run/,
    );
    assert.equal(reopened.leases.get(begun.environmentLeaseId!)?.state, 'active');
    assert.equal((await reopened.tasks.get('task-1'))?.environmentLifecycleState, 'idle');
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SQLite restart preserves pause state and its attributed control history beside the held Task lease', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-pause-restart-'));
  try {
    const filename = join(directory, 'sprout.db');
    const first = new SqliteStore({ filename });
    await first.tasks.create(task());
    const firstRuntime = sqliteLifecycle(first);
    const begun = await firstRuntime.lifecycle.begin('task-1');
    const paused = await firstRuntime.lifecycle.requestPause('task-1', { memberId: 'operator', memberKind: 'human' }, 'inspect before continuing');
    assert.equal(paused.pauseState, 'paused');
    first.close();

    const restarted = new SqliteStore({ filename });
    const runtime = sqliteLifecycle(restarted);
    const restored = await restarted.tasks.get('task-1');
    assert.equal(restored?.pauseState, 'paused');
    assert.deepEqual(restored?.controlHistory?.map(event => event.action), ['paused']);
    assert.equal(runtime.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
    restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SQLite restart preserves retry-required Pause intent for Human resolution', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-pause-retry-restart-'));
  try {
    const filename = join(directory, 'sprout.db');
    const first = new SqliteStore({ filename });
    await first.tasks.create(task());
    let pauseAttempts = 0;
    const saveIfUnchanged = first.tasks.saveIfUnchanged.bind(first.tasks);
    first.tasks.saveIfUnchanged = async (next, expected) => {
      if (next.pauseState === 'paused' || next.pauseState === 'requested') {
        pauseAttempts += 1;
        if (pauseAttempts <= 3) return false;
      }
      return saveIfUnchanged(next, expected);
    };
    const initial = sqliteLifecycle(first);
    const begun = await initial.lifecycle.begin('task-1');
    await assert.rejects(initial.lifecycle.requestPause('task-1', { memberId: 'operator', memberKind: 'human' }, 'hold for review'), /retry Human Pause/);
    assert.equal(pauseAttempts, 3);
    assert.equal((await first.tasks.get('task-1'))?.pauseState, 'retry-required');
    first.close();

    const restarted = new SqliteStore({ filename });
    const recovery = sqliteLifecycle(restarted);
    const restored = await restarted.tasks.get('task-1');
    assert.equal(restored?.pauseState, 'retry-required');
    assert.equal(restored?.controlHistory?.at(-1)?.action, 'pause-retry-required');
    assert.equal(recovery.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
    const queuedAdmission = recovery.lifecycle.advanceRun('task-1', 'pi', 'held until Human resolution');
    let admissionSettled = false;
    void queuedAdmission.then(() => { admissionSettled = true; }, () => { admissionSettled = true; });
    await setImmediate();
    assert.equal(admissionSettled, false);
    const cancelled = await recovery.lifecycle.cancelPauseRetryForHuman('task-1', { memberId: 'operator', memberKind: 'human' }, 'release the pending hold');
    assert.equal(cancelled.pauseState, undefined);
    assert.equal(cancelled.controlHistory?.at(-1)?.action, 'pause-request-cancelled');
    await queuedAdmission;
    assert.equal((await restarted.tasks.get('task-1'))?.activeRunId, 'run-1');
    restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SQLite cleanup recovery preserves the completed end intent across restart and discard retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-end-intent-restart-'));
  try {
    const filename = join(directory, 'sprout.db');
    const first = new SqliteStore({ filename });
    let recycleAttempts = 0;
    const worker: TaskContextWorker = {
      prepare: async () => ({ bootstrapInstructions: '' }),
      recycle: async () => { recycleAttempts += 1; if (recycleAttempts === 1) throw new Error('cleanup unavailable'); },
    };
    await first.tasks.create(task());
    const initial = sqliteLifecycle(first, { worker });
    const begun = await initial.lifecycle.begin('task-1');
    await assert.rejects(initial.lifecycle.end('task-1'), /cleanup unavailable/);
    const intent = await first.tasks.get('task-1');
    assert.equal(intent?.environmentLifecycleState, 'recovery');
    assert.equal(intent?.endDisposition, 'completed');
    assert.notEqual(intent?.status, 'done');
    first.close();

    const restarted = new SqliteStore({ filename });
    const recovery = sqliteLifecycle(restarted);
    await recovery.lifecycle.reconcile();
    const recovered = await recovery.lifecycle.recover('task-1', 'discard');
    assert.equal(recovered.status, 'done');
    assert.equal(recovered.environmentLifecycleState, 'ended');
    assert.equal(recovered.endDisposition, 'completed');
    assert.equal(recovery.pool.getLease(begun.environmentLeaseId!)?.state, 'released');
    restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
