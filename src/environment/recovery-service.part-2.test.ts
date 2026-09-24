import { test } from 'node:test';

import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { AgentRegistry } from '../agent/registry.ts';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';

import { EnvironmentPool } from './pool.ts';

import { ProjectRegistry } from '../project/registry.ts';

import { SqliteStore } from '../store/db.ts';

import { InMemoryTaskStore } from '../task/store.ts';

import { TaskEnvironmentLifecycle } from '../task/environment-lifecycle.ts';

import type { Task } from '../task/model.ts';

import { EnvironmentRecoveryService } from './recovery-service.ts';

import { InMemoryRecoveryStore } from './recovery-store.ts';

import { SqliteRecoveryStore } from './sqlite-recovery-store.ts';

import { FORCE_RELEASE_CONFIRMATION } from './recovery.ts';


/**
 * Environment reconciliation, ordinary recovery, and Force Release evidence (#88).
 *
 * These drive the real `EnvironmentPool`, the real `TaskEnvironmentLifecycle`, and
 * a real temporary SQLite store closed and reopened, so they prove the safety
 * rules over durable state rather than over a test double.
 */

const definition: EnvironmentDefinition = {
  id: 'mac',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};

const instance: EnvironmentInstance = { id: 'mac-1', definitionId: 'mac', workingDirectory: '/work' };

const agents = new AgentRegistry([
  { id: 'pi', name: 'Pi', engine: 'scripted', capability: 'agent-run' },
]);

const projects = new ProjectRegistry([
  {
    id: 'project',
    goal: 'Goal',
    rules: [],
    availableEnvironmentInstanceIds: ['mac-1'],
    memberships: [{ agentId: 'pi', responsibilities: [], collaborationInstructions: '' }],
  },
]);


function task(id = 'task-1'): Task {
  return {
    id,
    projectId: 'project',
    title: 'Task',
    goal: 'Goal',
    constraints: [],
    status: 'todo',
    assignedAgentId: 'pi',
    createdAt: 1,
    updatedAt: 1,
  };
}


interface Built {
  readonly pool: EnvironmentPool;
  readonly store: InMemoryTaskStore;
  readonly lifecycle: TaskEnvironmentLifecycle;
  readonly recovery: EnvironmentRecoveryService;
  readonly recoveryStore: InMemoryRecoveryStore;
}


function build(options: {
  readonly store?: InMemoryTaskStore;
  readonly pool?: EnvironmentPool;
  readonly leaseIds?: readonly string[];
  readonly now?: number;
} = {}): Built {
  const store = options.store ?? new InMemoryTaskStore();
  const leaseIds = options.leaseIds ?? ['lease-1'];
  let leaseIndex = 0;
  const pool =
    options.pool ??
    new EnvironmentPool({
      definitions: [definition],
      instances: [instance],
      idFactory: () => leaseIds[Math.min(leaseIndex++, leaseIds.length - 1)]!,
    });
  const recoveryStore = new InMemoryRecoveryStore();
  let recovery: EnvironmentRecoveryService;
  const lifecycle = new TaskEnvironmentLifecycle({
    store,
    pool,
    agents,
    projects,
    ids: {
      task: () => 'task',
      message: () => 'message',
      lease: () => 'lease',
      run: () => 'run-1',
    },
    runs: { submit: async (request) => ({ id: request.runId }) },
    onRecovery: async ({ leaseId, hadActiveRun }) => {
      await recovery.open({ leaseId, cause: 'worker-channel-lost', hadActiveRun });
    },
    forceReleaseLease: (leaseId) => pool.releaseTaskLease(leaseId) !== undefined,
    ...(options.now !== undefined ? { clock: { now: () => options.now! } } : {}),
  });
  recovery = new EnvironmentRecoveryService({
    store: recoveryStore,
    leases: pool,
    holders: {
      resumeTask: (taskId) => lifecycle.recover(taskId, 'resume').then(() => undefined),
      discardTask: (taskId) => lifecycle.recover(taskId, 'discard').then(() => undefined),
      forceReleaseTask: (input) => lifecycle.forceRelease(input.taskId, input),
    },
    taskRuns: async (taskId) => (await store.listRuns(taskId)).map((link) => link.runId),
    ...(options.now !== undefined ? { clock: () => options.now! } : {}),
  });
  return { pool, store, lifecycle, recovery, recoveryStore };
}


/** Drive a Task from create through begin and an interrupted nested run. */
async function interruptedTask(built: Built): Promise<{ readonly leaseId: string }> {
  await built.store.create(task());
  const begun = await built.lifecycle.begin('task-1');
  const advanced = await built.lifecycle.advanceRun('task-1', 'pi', 'go');
  // A Worker channel loss settles the run as interrupted; the lifecycle then
  // retains the lease in recovery and opens the durable recovery record.
  await built.lifecycle.settleRun('task-1', {
    id: advanced.runId,
    agentId: 'pi',
    prompt: 'go',
    environmentInstanceId: 'mac-1',
    projectId: 'project',
    taskId: 'task-1',
    leaseId: begun.environmentLeaseId!,
    status: 'interrupted',
    events: [],
    createdAt: 2,
    completedAt: 3,
  });
  return { leaseId: begun.environmentLeaseId! };
}


test('Force Release cancels the Task, releases the lease, preserves the workspace, and records the exceptional outcome', async () => {
  const built = build();
  const { leaseId } = await interruptedTask(built);
  await built.recovery.observeReconnect(leaseId, {
    enrollmentId: 'enroll-1',
    environmentInstanceId: 'mac-1',
    identityVerified: true,
    protocolCompatible: true,
    permissionsAllowed: true,
    hadActiveRun: true,
  });
  await built.recovery.synchronizeEvidence(leaseId, {
    hadActiveRun: true,
    evidence: { retainedEventCount: 4, turnSettlementObserved: true, engineSessionStopped: false, taskContextRecycled: false },
  });

  const outcome = await built.recovery.forceRelease(leaseId, {
    acknowledgedRisks: true,
    typedConfirmation: FORCE_RELEASE_CONFIRMATION,
    reason: 'Host machine hard rebooted without a clean worker exit',
  });
  assert.equal(outcome.environmentInstanceId, 'mac-1');
  assert.equal(outcome.leaseId, leaseId);
  assert.equal(outcome.holderKind, 'task');
  assert.equal(outcome.taskId, 'task-1');
  assert.equal(outcome.risksAcknowledged, true);
  assert.equal(outcome.projectWorkspacePreserved, true);
  assert.equal(outcome.unrecycledTaskContext, true);
  assert.deepEqual(outcome.affectedRunIds, ['run-1']);
  assert.ok(outcome.unresolvedFacts.length > 0);

  const task = await built.store.get('task-1');
  assert.equal(task?.status, 'cancelled');
  assert.equal(task?.environmentLifecycleState, 'discarded');
  assert.equal(built.pool.getLease(leaseId)?.state, 'released');
  assert.equal((await built.recovery.forLease(leaseId)), undefined);

  // The permanent history survives the resolution and is still readable.
  const history = await built.recovery.forceReleaseHistory('mac-1');
  assert.equal(history.length, 1);
  assert.equal(history[0]?.reason, 'Host machine hard rebooted without a clean worker exit');
  assert.match(history[0]!.unresolvedFacts.join(' '), /engine session/);
});


test('a restart reopens protection for a leftover recovering lease and never resolves it', async () => {
  const store = new InMemoryTaskStore();
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    idFactory: () => 'lease-1',
  });
  const recoveryStore = new InMemoryRecoveryStore();
  let recovery: EnvironmentRecoveryService;
  const lifecycle = new TaskEnvironmentLifecycle({
    store,
    pool,
    agents,
    projects,
    ids: { task: () => 'task', message: () => 'message', lease: () => 'lease', run: () => 'run-1' },
    runs: { submit: async (request) => ({ id: request.runId }) },
    onRecovery: async ({ leaseId, hadActiveRun }) => {
      await recovery.open({ leaseId, cause: 'worker-channel-lost', hadActiveRun });
    },
  });
  recovery = new EnvironmentRecoveryService({ store: recoveryStore, leases: pool });
  await store.create(task());
  const begun = await lifecycle.begin('task-1');
  await pool.markRecovering(begun.environmentLeaseId!);

  // A fresh service over the same durable store represents the restarted process.
  const restarted = new EnvironmentRecoveryService({ store: recoveryStore, leases: pool });
  const reopened = await restarted.reconcileAfterRestart();
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0]?.phase, 'recovery');
  assert.equal(pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
});


test('the recovery record and Force Release outcome survive a real SQLite reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-recovery-'));
  try {
    const path = join(directory, 'sprout.db');
    const first = new SqliteStore({ filename: path });
    const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });
    const recoveryStore = new SqliteRecoveryStore({ db: first.db });
    const recovery = new EnvironmentRecoveryService({ store: recoveryStore, leases: pool });

    const acquired = pool.reserveTaskLease({
      instanceId: 'mac-1',
      capability: 'agent-run',
      holderId: 'task-1',
      taskId: 'task-1',
      ttlMs: 60_000,
    });
    assert.equal(acquired.ok, true);
    const lease = acquired.ok ? acquired.lease : undefined;
    assert.ok(lease);
    pool.adoptLease(lease);
    await recovery.open({ leaseId: lease.id, cause: 'worker-channel-lost', hadActiveRun: true });
    await recovery.observeReconnect(lease.id, {
      enrollmentId: 'enroll-1',
      environmentInstanceId: 'mac-1',
      identityVerified: true,
      protocolCompatible: true,
      permissionsAllowed: true,
      hadActiveRun: true,
    });
    await recovery.synchronizeEvidence(lease.id, {
      hadActiveRun: true,
      evidence: { retainedEventCount: 4, turnSettlementObserved: true, engineSessionStopped: false, taskContextRecycled: false },
    });
    const outcome = await recovery.forceRelease(lease.id, {
      acknowledgedRisks: true,
      typedConfirmation: FORCE_RELEASE_CONFIRMATION,
      reason: 'Host machine hard rebooted without a clean worker exit',
    });
    first.close();

    // A brand-new handle reads the durable history back.
    const second = new SqliteStore({ filename: path });
    const reopened = new SqliteRecoveryStore({ db: second.db });
    const records = await reopened.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.phase, 'resolved');
    assert.deepEqual(records[0]?.decisions.map((decision) => decision.kind), [
      'interrupted',
      'reconnect-observed',
      'evidence-synchronized',
      'force-released',
    ]);
    const history = await reopened.listForceReleases('mac-1');
    assert.equal(history.length, 1);
    assert.equal(history[0]?.id, outcome.id);
    assert.equal(history[0]?.reason, outcome.reason);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('Force Release sanitizes a sensitive reason and keeps a product-owned record', async () => {
  const built = build();
  const { leaseId } = await interruptedTask(built);
  await built.recovery.observeReconnect(leaseId, {
    enrollmentId: 'enroll-1',
    environmentInstanceId: 'mac-1',
    identityVerified: true,
    protocolCompatible: true,
    permissionsAllowed: true,
    hadActiveRun: true,
  });
  await built.recovery.synchronizeEvidence(leaseId, {
    hadActiveRun: true,
    evidence: { retainedEventCount: 1, turnSettlementObserved: true, engineSessionStopped: false, taskContextRecycled: false },
  });
  const outcome = await built.recovery.forceRelease(leaseId, {
    acknowledgedRisks: true,
    typedConfirmation: FORCE_RELEASE_CONFIRMATION,
    reason: 'worker died after typing password=hunter2correcthorse at /Users/local/secret',
  });
  assert.ok(!outcome.reason.includes('hunter2correcthorse'));
  assert.ok(!outcome.reason.includes('/Users/'));
  assert.ok(outcome.reason.length > 0);
});
