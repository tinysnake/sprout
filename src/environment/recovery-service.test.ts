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

import { FORCE_RELEASE_CONFIRMATION, UNRESOLVED_FACT_WORKER_OFFLINE, workSafetyFromRecovery } from './recovery.ts';


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
      message: () => 'message', projectEvent: () => 'project-event',
      lease: () => 'lease',
      run: () => 'run-1',
    },
    runs: { submit: async (request) => ({ id: request.runId }) },
    onRecovery: async ({ leaseId, hadActiveRun, cause }) => {
      await recovery.open({ leaseId, cause: cause ?? 'worker-channel-lost', hadActiveRun });
    },
    forceReleaseLease: (leaseId) => pool.releaseTaskLease(leaseId) !== undefined,
    ...(options.now !== undefined ? { clock: { now: () => options.now! } } : {}),
  });
  recovery = new EnvironmentRecoveryService({
    store: recoveryStore,
    leases: pool,
    holders: {
      clearIdleTask: (taskId) => lifecycle.clearIdleRecovery(taskId),
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


test('overdue blocked lease exposes durable recovery and Human Force Release without freeing work automatically', async () => {
  let now = 1;
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance], clock: { now: () => now }, idFactory: () => 'lease-1' });
  const built = build({ pool });
  await built.store.create(task());
  const begun = await built.lifecycle.begin('task-1');
  const leaseId = begun.environmentLeaseId!;
  await built.store.save({ ...begun, status: 'blocked', environmentLifecycleState: 'blocked' });
  assert.equal(await built.recovery.forLease(leaseId), undefined);
  now = pool.getLease(leaseId)!.expiresAt;
  assert.equal((await pool.acquireLeaseRevalidated({ instanceId: 'mac-1', capability: 'agent-run', holderId: 'other', ttlMs: 1000 })).ok, false);
  const record = await built.recovery.forLease(leaseId);
  assert.equal(record?.phase, 'recovery');
  assert.equal(record?.cause, 'lease-overdue');
  assert.equal(workSafetyFromRecovery([record!], pool.leases(), 'mac-1'), 'recovery');
  assert.ok(record!.unresolvedFacts.length > 0);
  assert.equal(pool.getLease(leaseId)?.state, 'recovering');
  await built.recovery.forceRelease(leaseId, {
    acknowledgedRisks: true, typedConfirmation: FORCE_RELEASE_CONFIRMATION, reason: 'Human releases overdue blocked work',
  });
  assert.equal(pool.getLease(leaseId)?.state, 'released');
  assert.equal((await built.store.get('task-1'))?.status, 'cancelled');
  assert.equal((await built.recovery.forceReleaseHistory('mac-1')).length, 1);
  assert.equal((await pool.acquireLeaseRevalidated({ instanceId: 'mac-1', capability: 'agent-run', holderId: 'other', ttlMs: 1000 })).ok, true);
});

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
  assert.match(record.unresolvedFacts.join(' '), /Task context has not been proved owned/);
  await assert.rejects(built.recovery.resume(leaseId), /safe held context/,
    'leftover or unverified Task context cannot unlock an ordinary decision');
  // The interrupted run remains an interrupted history fact, not a replayed run.
  assert.equal((await built.store.get('task-1'))?.environmentLifecycleState, 'recovery');
});

test('a replacement enrollment or reset identity cannot provide the lost holder’s proof', async () => {
  const built = build();
  const { leaseId } = await interruptedTask(built);
  await built.recovery.open({ leaseId, cause: 'worker-channel-lost', hadActiveRun: true,
    enrollmentId: 'original', workerIdentityDigest: 'original-digest' });
  for (const [enrollmentId, workerIdentityDigest] of [
    ['replacement', 'replacement-digest'], ['original', 'replacement-digest'],
  ]) {
    await assert.rejects(built.recovery.observeReconnect(leaseId, {
      enrollmentId: enrollmentId!, workerIdentityDigest: workerIdentityDigest!,
      environmentInstanceId: 'mac-1', identityVerified: true,
      protocolCompatible: true, permissionsAllowed: true, hadActiveRun: true,
    }), /original enrolled Worker identity/);
  }
  assert.equal((await built.recovery.forLease(leaseId))?.phase, 'recovery');
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
    evidence: { retainedEventCount: 4, turnSettlementObserved: true, engineSessionStopped: true, taskContextRecycled: false, taskContextPrepared: true },
  });

  const resolved = await built.recovery.resume(leaseId);
  assert.equal(resolved.phase, 'resolved');
  const resumedTask = await built.store.get('task-1');
  assert.equal(resumedTask?.environmentLifecycleState, 'blocked');
  assert.equal(resumedTask?.environmentLeaseId, leaseId);
  assert.equal(built.pool.getLease(leaseId)?.state, 'active');
  assert.equal(built.pool.getLease(leaseId)?.taskId, 'task-1');
});

test('another channel loss or Sprout restart invalidates prior epoch proof before any ordinary decision', async () => {
  const built = build();
  const { leaseId } = await interruptedTask(built);
  const reconnect = { enrollmentId: 'enroll-1', environmentInstanceId: 'mac-1', identityVerified: true,
    protocolCompatible: true, permissionsAllowed: true, hadActiveRun: true };
  await built.recovery.observeReconnect(leaseId, reconnect);
  await built.recovery.synchronizeEvidence(leaseId, { hadActiveRun: true, evidence: {
    retainedEventCount: 1, turnSettlementObserved: true, engineSessionStopped: true,
    taskContextRecycled: false, taskContextPrepared: true,
  } });
  assert.ok((await built.recovery.forLease(leaseId))?.evidence);
  await built.recovery.open({ leaseId, cause: 'worker-channel-lost', hadActiveRun: true });
  assert.equal((await built.recovery.forLease(leaseId))?.evidence, undefined);
  await assert.rejects(built.recovery.resume(leaseId), /synchronized retained evidence/);
  await built.recovery.observeReconnect(leaseId, reconnect);
  await built.recovery.synchronizeEvidence(leaseId, { hadActiveRun: true, evidence: {
    retainedEventCount: 1, turnSettlementObserved: true, engineSessionStopped: true,
    taskContextRecycled: false, taskContextPrepared: true,
  } });
  await built.recovery.reconcileAfterRestart();
  assert.equal((await built.recovery.forLease(leaseId))?.evidence, undefined,
    'restart is not proof that the old Worker channel and engine are safe');
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
    ids: { task: () => 'task', message: () => 'message', projectEvent: () => 'project-event', lease: () => 'lease', run: () => 'run-1' },
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
    evidence: { retainedEventCount: 2, turnSettlementObserved: true, engineSessionStopped: true, taskContextRecycled: false, taskContextPrepared: true },
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


/**
 * Construct the #171 stuck state directly: a Task-held lease protected by a
 * revocation-opened record with no attached run, pinned to the ORIGINAL Worker
 * identity that a subsequent enrollment reset has invalidated. The real stuck
 * record lived on a review instance that is no longer reachable, so the state
 * is rebuilt here from its observed shape: phase `recovery`, no evidence, no
 * run, `interruptedRunActive: false`.
 */
async function revocationStuckTask(built: Built): Promise<{ readonly leaseId: string }> {
  await built.store.create(task());
  const begun = await built.lifecycle.begin('task-1');
  const leaseId = begun.environmentLeaseId!;
  await built.store.save({ ...begun, environmentLifecycleState: 'recovery', recoveryState: 'idle', updatedAt: 11 });
  built.pool.markRecovering(leaseId);
  await built.recoveryStore.save({
    id: 'recovery-171-stuck',
    environmentInstanceId: 'mac-1',
    enrollmentId: 'enroll-1',
    workerIdentityDigest: 'digest-rotated-away',
    leaseId,
    holderKind: 'task',
    holderId: 'task-1',
    taskId: 'task-1',
    interruptedRunActive: false,
    cause: 'worker-channel-lost',
    phase: 'recovery',
    startedAt: 10,
    updatedAt: 10,
    unresolvedFacts: [UNRESOLVED_FACT_WORKER_OFFLINE],
    decisions: [{
      kind: 'interrupted',
      actor: 'system',
      at: 10,
      reason: 'The Environment restarted with unfinished work; the lease is protected until its facts agree.',
    }],
  });
  return { leaseId };
}


test('#171 a revocation-opened no-run record resolves for the Human-approved successor identity', async () => {
  const built = build();
  const { leaseId } = await revocationStuckTask(built);

  // Diagnosis: today this throws `identity-not-verified`
  // (recovery-service.ts, observeReconnect's digest gate), the record never
  // reaches `reconciling`, so synchronizeEvidence would refuse with
  // `not-reconciling` and every ordinary decision refuses with
  // `evidence-not-synchronized`. The rotation is attested by the enrollment
  // authority: the predecessor digest is durably invalidated.
  const observed = await built.recovery.observeReconnect(leaseId, {
    enrollmentId: 'enroll-1',
    workerIdentityDigest: 'digest-successor',
    environmentInstanceId: 'mac-1',
    identityVerified: true,
    protocolCompatible: true,
    permissionsAllowed: true,
    hadActiveRun: false,
    identityRotated: true,
  });
  assert.equal(observed.phase, 'reconciling');

  const resolved = await built.recovery.synchronizeEvidence(leaseId, {
    hadActiveRun: false,
    evidence: {
      retainedEventCount: 0,
      turnSettlementObserved: true,
      engineSessionStopped: true,
      taskContextPrepared: true,
      taskContextRecycled: false,
    },
  });
  assert.equal(resolved.phase, 'resolved');
  // The idle Task plane is restored on its retained lease; nothing replays.
  assert.equal((await built.store.get('task-1'))?.environmentLifecycleState, 'idle');
  assert.equal(built.pool.getLease(leaseId)?.state, 'active');
  const workSafety = workSafetyFromRecovery(
    await built.recovery.listForEnvironment('mac-1'),
    built.pool.leases().map((lease) => ({ instanceId: lease.instanceId, state: lease.state })),
    'mac-1',
  );
  assert.notEqual(workSafety, 'recovery', 'work safety must leave the recovery state');
});


test('#171 identity rotation is attested, never inferred: unexplained mismatches stay refused', async () => {
  const built = build();
  const { leaseId } = await revocationStuckTask(built);

  // A successor digest on the same enrollment without an attested rotation is
  // still refused — the pre-#171 invariant, pinned as a regression guard.
  await assert.rejects(built.recovery.observeReconnect(leaseId, {
    enrollmentId: 'enroll-1',
    workerIdentityDigest: 'digest-successor',
    environmentInstanceId: 'mac-1',
    identityVerified: true,
    protocolCompatible: true,
    permissionsAllowed: true,
    hadActiveRun: false,
  }), /original enrolled Worker identity/);

  // Rotation claims never launder a different enrollment's identity in.
  await assert.rejects(built.recovery.observeReconnect(leaseId, {
    enrollmentId: 'enroll-2',
    workerIdentityDigest: 'digest-successor',
    environmentInstanceId: 'mac-1',
    identityVerified: true,
    protocolCompatible: true,
    permissionsAllowed: true,
    hadActiveRun: false,
    identityRotated: true,
  }), /original enrolled Worker identity/);

  const unchanged = await built.recovery.forLease(leaseId);
  assert.equal(unchanged?.phase, 'recovery');
  assert.equal(unchanged?.evidence, undefined);
});
