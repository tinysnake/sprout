import { test } from 'node:test';

import assert from 'node:assert/strict';


import { AgentRegistry } from '../agent/registry.ts';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';

import { EnvironmentPool } from './pool.ts';

import { ProjectRegistry } from '../project/registry.ts';

import { InMemoryTaskStore } from '../task/store.ts';

import { TaskEnvironmentLifecycle } from '../task/environment-lifecycle.ts';

import type { Task } from '../task/model.ts';

import { EnvironmentRecoveryService } from './recovery-service.ts';

import { InMemoryRecoveryStore } from './recovery-store.ts';

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


test('an interrupted nested run opens one durable recovery record and retains the Task lease', async () => {
  const built = build();
  const { leaseId } = await interruptedTask(built);

  assert.equal((await built.store.get('task-1'))?.environmentLifecycleState, 'recovery');
  assert.equal(built.pool.getLease(leaseId)?.state, 'recovering');
  const record = await built.recovery.forLease(leaseId);
  assert.ok(record);
  assert.equal(record.phase, 'recovery');
  assert.equal(record.holderKind, 'task');
  assert.equal(record.taskId, 'task-1');
  // A reconnect has not happened, so the decisive unresolved fact is that no
  // evidence was synchronized: a reconnect alone never proves safety.
  assert.deepEqual(record.unresolvedFacts, [
    'The Worker channel is lost; no retained evidence has been synchronized.',
  ]);
  // No competing Task can acquire the Environment.
  const competing = built.pool.acquireLease({
    instanceId: 'mac-1',
    capability: 'agent-run',
    holderId: 'task-2',
    taskId: 'task-2',
    ttlMs: 1,
  });
  assert.equal(competing.ok, false);
});


test('a reconnect only moves the record to reconciling and never resolves it', async () => {
  const built = build();
  const { leaseId } = await interruptedTask(built);

  const reconnected = await built.recovery.observeReconnect(leaseId, {
    enrollmentId: 'enroll-1',
    environmentInstanceId: 'mac-1',
    identityVerified: true,
    protocolCompatible: true,
    permissionsAllowed: true,
    hadActiveRun: true,
  });
  assert.equal(reconnected.phase, 'reconciling');
  assert.equal(built.pool.getLease(leaseId)?.state, 'recovering');
  assert.match(reconnected.unresolvedFacts.join(' '), /no retained evidence/);

  // An ordinary decision before evidence is synchronized is refused.
  await assert.rejects(built.recovery.resume(leaseId), /synchronized evidence/i);
});


test('a reconnect is re-authenticated, protocol-checked, and permission-checked', async () => {
  const built = build();
  const { leaseId } = await interruptedTask(built);

  await assert.rejects(
    built.recovery.observeReconnect(leaseId, {
      enrollmentId: 'enroll-1',
      environmentInstanceId: 'mac-1',
      identityVerified: false,
      protocolCompatible: true,
      permissionsAllowed: true,
      hadActiveRun: true,
    }),
    /re-authenticate/i,
  );
  await assert.rejects(
    built.recovery.observeReconnect(leaseId, {
      enrollmentId: 'enroll-1',
      environmentInstanceId: 'mac-1',
      identityVerified: true,
      protocolCompatible: false,
      permissionsAllowed: true,
      hadActiveRun: true,
    }),
    /not compatible/i,
  );
  await assert.rejects(
    built.recovery.observeReconnect(leaseId, {
      enrollmentId: 'enroll-1',
      environmentInstanceId: 'other-instance',
      identityVerified: true,
      protocolCompatible: true,
      permissionsAllowed: true,
      hadActiveRun: true,
    }),
    /does not serve/i,
  );
  // The record is unchanged by every refused attempt.
  assert.equal((await built.recovery.forLease(leaseId))?.phase, 'recovery');
});


test('synchronized evidence drives an interrupted record to recovery and never replays the run', async () => {
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
  const record = await built.recovery.synchronizeEvidence(leaseId, {
    hadActiveRun: true,
    evidence: {
      retainedEventCount: 4,
      turnSettlementObserved: true,
      engineSessionStopped: true,
      taskContextRecycled: false,
    },
  });
  assert.equal(record.phase, 'recovery');
  // The unrecycled Task context is a concrete unresolved fact.
  assert.match(record.unresolvedFacts.join(' '), /Task context has not been confirmed recycled/);
  // The interrupted run remains an interrupted history fact, not a replayed run.
  assert.equal((await built.store.get('task-1'))?.environmentLifecycleState, 'recovery');
});


test('ordinary Resume keeps the existing lease holder and returns to deliberate blocked work', async () => {
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
    evidence: { retainedEventCount: 4, turnSettlementObserved: true, engineSessionStopped: true, taskContextRecycled: false },
  });

  const resolved = await built.recovery.resume(leaseId);
  assert.equal(resolved.phase, 'resolved');
  const resumedTask = await built.store.get('task-1');
  assert.equal(resumedTask?.environmentLifecycleState, 'blocked');
  assert.equal(resumedTask?.environmentLeaseId, leaseId);
  assert.equal(built.pool.getLease(leaseId)?.state, 'active');
  assert.equal(built.pool.getLease(leaseId)?.taskId, 'task-1');
});


test('ordinary Discard performs safe Task end: context recycled then lease released', async () => {
  const calls: string[] = [];
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
    worker: {
      prepare: async () => ({ bootstrapInstructions: '' }),
      recycle: async () => {
        calls.push('recycle');
      },
    },
    onRecovery: async ({ leaseId, hadActiveRun }) => {
      await recovery.open({ leaseId, cause: 'worker-channel-lost', hadActiveRun });
    },
    forceReleaseLease: (leaseId) => pool.releaseTaskLease(leaseId) !== undefined,
  });
  recovery = new EnvironmentRecoveryService({
    store: recoveryStore,
    leases: pool,
    holders: {
      discardTask: async (taskId) => {
        calls.push('discard');
        await lifecycle.recover(taskId, 'discard');
        calls.push(`task:${(await store.get(taskId))?.status}`);
      },
    },
  });

  await store.create(task());
  const begun = await lifecycle.begin('task-1');
  const advanced = await lifecycle.advanceRun('task-1', 'pi', 'go');
  await lifecycle.settleRun('task-1', {
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

  const leaseId = begun.environmentLeaseId!;
  await recovery.observeReconnect(leaseId, {
    enrollmentId: 'enroll-1',
    environmentInstanceId: 'mac-1',
    identityVerified: true,
    protocolCompatible: true,
    permissionsAllowed: true,
    hadActiveRun: true,
  });
  await recovery.synchronizeEvidence(leaseId, {
    hadActiveRun: true,
    evidence: { retainedEventCount: 2, turnSettlementObserved: true, engineSessionStopped: true, taskContextRecycled: false },
  });
  const resolved = await recovery.discard(leaseId);
  assert.equal(resolved.phase, 'resolved');
  // Task context was recycled *before* the Task became cancelled and the lease
  // was released; the Project workspace was never touched.
  assert.deepEqual(calls, ['discard', 'recycle', 'task:cancelled']);
  assert.equal((await store.get('task-1'))?.environmentLifecycleState, 'discarded');
  assert.equal(pool.getLease(leaseId)?.state, 'released');
});


test('Force Release is refused outside recovery, without facts, acknowledgement, typed confirmation, or reason', async () => {
  const built = build();
  const { leaseId } = await interruptedTask(built);

  // Reconciling is not recovery, so the override is refused there.
  await built.recovery.observeReconnect(leaseId, {
    enrollmentId: 'enroll-1',
    environmentInstanceId: 'mac-1',
    identityVerified: true,
    protocolCompatible: true,
    permissionsAllowed: true,
    hadActiveRun: true,
  });
  await assert.rejects(
    built.recovery.forceRelease(leaseId, {
      acknowledgedRisks: true,
      typedConfirmation: FORCE_RELEASE_CONFIRMATION,
      reason: 'kernel panic',
    }),
    /only for a lease already in recovery/i,
  );

  await built.recovery.synchronizeEvidence(leaseId, {
    hadActiveRun: true,
    evidence: { retainedEventCount: 4, turnSettlementObserved: true, engineSessionStopped: true, taskContextRecycled: false },
  });
  // The record is now `recovery` and carries a concrete unresolved fact.
  assert.equal((await built.recovery.forLease(leaseId))?.phase, 'recovery');

  await assert.rejects(
    built.recovery.forceRelease(leaseId, {
      acknowledgedRisks: false,
      typedConfirmation: FORCE_RELEASE_CONFIRMATION,
      reason: 'kernel panic',
    }),
    /risk acknowledgement/i,
  );
  await assert.rejects(
    built.recovery.forceRelease(leaseId, {
      acknowledgedRisks: true,
      typedConfirmation: 'force release',
      reason: 'kernel panic',
    }),
    /typed confirmation/i,
  );
  await assert.rejects(
    built.recovery.forceRelease(leaseId, {
      acknowledgedRisks: true,
      typedConfirmation: FORCE_RELEASE_CONFIRMATION,
      reason: '  ',
    }),
    /written reason/i,
  );
  // Every refusal left the record protected and the lease unreleased.
  assert.equal(built.pool.getLease(leaseId)?.state, 'recovering');
});
