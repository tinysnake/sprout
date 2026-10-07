/**
 * Post-revocation recovery after identity rotation (#171).
 *
 * A revocation opens a `worker-channel-lost` recovery record pinned to the
 * Worker identity that the subsequent reset then invalidates. Before #171 that
 * rotation left the record permanently unresolvable: the machine reconnect pass
 * fenced it out, `observeReconnect` demanded the dead key, and every offered
 * path (resume, discard, lease release) either did nothing to the record or
 * failed. These tests rebuild the witnessed state — revoke opens the record,
 * reset → claim → approve binds a fresh identity, the successor connects — and
 * prove the record reaches `resolved` with readiness leaving the recovery
 * state, plus that inapplicable Task recovery actions now refuse actionably
 * instead of the protected generic failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import { signWorkerChallenge } from './environment/worker-proof.ts';
import { workSafetyFromRecovery } from './environment/recovery.ts';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import {
  INSTANCE_ID,
  readinessWorkflowHarness,
  scriptedStartupReadiness,
  testComposition,
  waitFor,
} from './runtime-test-harness.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from './worker/enrollment-connector.ts';
import { WorkerRecoveryJournal } from './worker/recovery-journal.ts';
import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';

test('#171 a revocation-opened recovery record resolves after reset, fresh claim, and Human approval', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-171-rotation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = await readinessWorkflowHarness({ backend: 'sqlite', directory: dir, engineId: 'scripted' });
  try {
    const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
    const originalKey = join(dir, 'worker-key.pem');
    await h.connect(enrollmentId, originalKey, {
      engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
      readiness: scriptedStartupReadiness,
      recoveryJournal: new WorkerRecoveryJournal(join(dir, 'worker-recovery.json'), 1),
    });
    await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'eligible Worker');
    const project = await h.runtime.projectService.create({
      id: 'rotation-project', displayName: 'Project', goal: 'Test',
      agentMemberships: [{ agentId: 'scout' }],
    });
    await h.runtime.projectAccess.grant({
      projectId: project.id, environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'default' },
    });
    const task = await h.runtime.tasks.create({
      projectId: project.id, title: 'Rotation', goal: 'Test', assignedAgentId: 'scout',
    });
    const begun = await h.runtime.tasks.begin(task.id);
    const leaseId = begun.environmentLeaseId!;

    const originalDigest = (await h.runtime.enrollments.get(enrollmentId))?.worker.identityDigest ?? '';
    assert.notEqual(originalDigest, '', 'the original identity was bound before revocation');

    // Revoke: the channel loss opens the protective record with no attached run.
    await h.runtime.enrollments.revoke(enrollmentId, 'synthetic revocation for the #171 regression');
    await waitFor(async () => {
      const record = await h.runtime.recovery.forLease(leaseId);
      return record !== undefined && record.workerIdentityDigest === originalDigest;
    }, 'revocation-opened record pinned to the original identity');
    const stuck = (await h.runtime.recovery.forLease(leaseId))!;
    assert.equal(stuck.cause, 'worker-channel-lost');
    assert.equal(stuck.phase, 'recovery');
    assert.equal(stuck.evidence, undefined);
    assert.equal(stuck.interruptedRunActive, false);
    assert.equal(stuck.runId, undefined);
    assert.equal((await h.runtime.tasks.get(task.id))?.environmentLifecycleState, 'recovery');

    // Reset → fresh claim → Human approval: the witnessed identity rotation.
    await h.runtime.enrollments.reset(enrollmentId, 'synthetic reset after revocation');
    assert.ok((await h.runtime.enrollments.get(enrollmentId))
      ?.invalidatedIdentityDigests.includes(originalDigest), 'reset invalidated the original key');
    const regenerated = await h.runtime.enrollments.regenerateClaimSecret(enrollmentId);
    await h.runtime.enrollments.claimEnrollment(enrollmentId, regenerated.claim.secret);
    const challenge = await h.runtime.enrollments.issueChallenge(enrollmentId);
    const successorKey = join(dir, 'worker-key-successor.pem');
    const successor = loadOrCreateWorkerIdentity(successorKey);
    await h.runtime.enrollments.connectWorker({
      enrollmentId,
      proof: {
        challengeId: challenge.id,
        publicKey: workerPublicKey(successor.privateKey),
        signature: signWorkerChallenge(successor.privateKey, challenge),
      },
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: WORKER_PROTOCOL_VERSION },
      engines: [],
    });
    await h.runtime.enrollments.approve(enrollmentId, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });

    // The successor connects at a new epoch; the record must reach resolved.
    await h.connect(enrollmentId, successorKey, {
      engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
      readiness: scriptedStartupReadiness,
      recoveryJournal: new WorkerRecoveryJournal(join(dir, 'worker-recovery-successor.json'), 2),
    });
    await waitFor(async () => (await h.runtime.recovery.listForEnvironment(INSTANCE_ID))
      .some((record) => record.leaseId === leaseId && record.phase === 'resolved'),
    'revocation record resolved after re-enrollment');

    // Readiness truth: the idle Task is restored on its retained lease and work
    // safety leaves the recovery state.
    assert.equal((await h.runtime.tasks.get(task.id))?.environmentLifecycleState, 'idle');
    assert.equal(h.runtime.pool.getLease(leaseId)?.state, 'active');
    const workSafety = workSafetyFromRecovery(
      await h.runtime.recovery.listForEnvironment(INSTANCE_ID),
      h.runtime.pool.leases().map((lease) => ({ instanceId: lease.instanceId, state: lease.state })),
      INSTANCE_ID,
    );
    assert.notEqual(workSafety, 'recovery', 'work safety must return to a non-recovery state');
  } finally {
    await h.close();
  }
});


test('#171 task recovery actions refuse actionably instead of the protected generic failure', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-171-actions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = await readinessWorkflowHarness({ backend: 'sqlite', directory: dir, engineId: 'scripted' });
  try {
    const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
    await h.connect(enrollmentId, join(dir, 'worker-key.pem'), {
      engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
      readiness: scriptedStartupReadiness,
      recoveryJournal: new WorkerRecoveryJournal(join(dir, 'worker-recovery.json'), 1),
    });
    await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'eligible Worker');
    const project = await h.runtime.projectService.create({
      id: 'held-project', displayName: 'Project', goal: 'Test',
      agentMemberships: [{ agentId: 'scout' }],
    });
    await h.runtime.projectAccess.grant({
      projectId: project.id, environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'default' },
    });
    const task = await h.runtime.tasks.create({
      projectId: project.id, title: 'Held', goal: 'Test', assignedAgentId: 'scout',
    });
    const begun = await h.runtime.tasks.begin(task.id);

    // Channel loss protects the idle Task and opens the record.
    testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID)!.close();
    await waitFor(async () => (await h.runtime.recovery.forLease(begun.environmentLeaseId!)) !== undefined,
      'channel-loss recovery record');
    await waitFor(async () => (await h.runtime.tasks.get(task.id))?.environmentLifecycleState === 'recovery',
      'Task plane protected');

    const post = (action: string) => fetch(`${h.base}/api/tasks/${task.id}/recovery`, {
      method: 'POST',
      headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ action, reason: 'operator recovery decision' }),
    });

    const resumed = await post('resume');
    assert.equal(resumed.status, 409, 'a disconnected Worker cannot authorize ordinary recovery');
    assert.equal((await resumed.json() as { code: string }).code, 'evidence-not-synchronized');
    assert.equal((await h.runtime.tasks.get(task.id))?.environmentLifecycleState, 'recovery');
    assert.equal(h.runtime.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');

    // An idle Task returns to its exact state only after the same Worker
    // reconnects and proves the held context and engine fence.
    await h.connect(enrollmentId, join(dir, 'worker-key.pem'), {
      engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
      readiness: scriptedStartupReadiness,
      recoveryJournal: new WorkerRecoveryJournal(join(dir, 'worker-recovery.json'), 2),
    });
    await waitFor(async () => (await h.runtime.tasks.get(task.id))?.environmentLifecycleState === 'idle',
      'same-identity idle context proof');

    const discarded = await post('discard');
    assert.equal(discarded.status, 409);
    const body = (await discarded.json()) as { readonly error?: string; readonly code?: string };
    assert.notEqual(body.error, 'request could not be completed',
      'an inapplicable recovery action must not collapse into the generic protected failure');
    assert.equal(body.code, 'not-awaiting-recovery');
    assert.match(body.error ?? '', /not awaiting recovery/);

    // The inapplicable action cannot change the resolved decision history.
    assert.equal((await h.runtime.recovery.listForEnvironment(INSTANCE_ID))
      .find(record => record.leaseId === begun.environmentLeaseId)?.phase, 'resolved');
  } finally {
    await h.close();
  }
});
