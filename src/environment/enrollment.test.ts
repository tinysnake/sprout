import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  approveEnrollment,
  createPendingEnrollment,
  reconcileWorkerConnection,
  resetEnrollment,
  revokeEnrollment,
  setCapabilityPermission,
  EnrollmentError,
  type CreatePendingEnrollmentInput,
  type EnvironmentEnrollment,
} from './enrollment.ts';
import { workerIdentityDigest } from './enrollment-identity.ts';

function pending(overrides: Partial<CreatePendingEnrollmentInput> = {}): EnvironmentEnrollment {
  return createPendingEnrollment({
    id: 'enroll-1',
    environmentInstanceId: 'local-macos',
    displayName: 'Local Mac',
    identityDigest: workerIdentityDigest('public-key-a'),
    platform: 'macos',
    protocolVersion: '2.1',
    capabilityRequests: ['agent-run', 'read-only-investigation'],
    engineFacts: [
      { engine: 'codex', installed: true, authenticated: true, models: ['gpt-5-codex'] },
      { engine: 'pi', installed: true, authenticated: false, models: [] },
    ],
    at: 1_000,
    ...overrides,
  });
}

test('a new enrollment is pending with no granted permission and one requested decision', () => {
  const enrollment = pending();
  assert.equal(enrollment.status, 'pending');
  assert.equal(enrollment.everApproved, false);
  assert.deepEqual(enrollment.capabilityPermissions, {
    'agent-run': false,
    'read-only-investigation': false,
  });
  assert.deepEqual(enrollment.decisions.map((decision) => decision.kind), ['requested']);
  // The private key is not a field, and the digest is not the key.
  assert.equal(JSON.stringify(enrollment).includes('public-key-a'), false);
});

test('an unsupported platform is refused rather than recorded as a broken enrollment', () => {
  assert.throws(
    () => pending({ platform: 'plan9' }),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'unsupported-platform',
  );
});

test('Human approval records the decision, grants permissions, and is durable in the record', () => {
  const approved = approveEnrollment(pending(), {
    capabilityPermissions: { 'agent-run': true },
    at: 2_000,
    actor: 'operator',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.everApproved, true);
  assert.deepEqual(approved.capabilityPermissions, {
    'agent-run': true,
    'read-only-investigation': false,
  });
  assert.deepEqual(approved.decisions.map((decision) => decision.kind), ['requested', 'approved']);
});

test('only a pending enrollment can be approved', () => {
  const approved = approveEnrollment(pending(), { capabilityPermissions: {}, at: 2_000 });
  assert.throws(
    () => approveEnrollment(approved, { capabilityPermissions: {}, at: 3_000 }),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'not-pending',
  );
});

/**
 * An identity-free pending enrollment can never be Human-approved (#115 review
 * finding 2). A Web-created enrollment has no digest until a claimed host proves
 * key possession; approving it would create an approved record no key can ever
 * satisfy and permanently brick the enrollment. The state machine refuses the
 * approval and leaves the record pending and approvable after the real proof.
 */
test('approval is refused while no Worker identity is claimed', () => {
  const identityFree = pending({ identityDigest: '' });
  assert.equal(identityFree.worker.identityDigest, '');
  assert.throws(
    () => approveEnrollment(identityFree, { capabilityPermissions: { 'agent-run': true }, at: 2_000 }),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'identity-not-claimed',
  );
  // The refusal does not consume or mutate the pending record: once an identity
  // is proven, approval succeeds normally.
  const claimed = reconcileWorkerConnection(identityFree, workerIdentityDigest('public-key-a'), 3_000);
  assert.equal(claimed.outcome, 'identity-claimed');
  const approved = approveEnrollment(claimed.enrollment, { capabilityPermissions: { 'agent-run': true }, at: 4_000 });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.worker.identityDigest, workerIdentityDigest('public-key-a'));
});

test('same-key connection is an idempotent reconnect and never a second identity', () => {
  const approved = approveEnrollment(pending(), { capabilityPermissions: {}, at: 2_000 });
  const outcome = reconcileWorkerConnection(approved, approved.worker.identityDigest, 3_000);
  assert.equal(outcome.outcome, 'reconnected');
  assert.equal(outcome.requiresHumanApproval, false);
  assert.equal(outcome.enrollment.id, approved.id, 'the same Environment identity is reused');
});

test('a new key against an approved binding is refused and requires a reset', () => {
  const approved = approveEnrollment(pending(), { capabilityPermissions: {}, at: 2_000 });
  const outcome = reconcileWorkerConnection(approved, workerIdentityDigest('public-key-b'), 3_000);
  assert.equal(outcome.outcome, 'duplicate-new-key-refused');
  assert.equal(outcome.requiresHumanApproval, true);
  assert.equal(outcome.enrollment.status, 'approved', 'the existing binding is not replaced');
  assert.equal(
    outcome.enrollment.worker.identityDigest,
    approved.worker.identityDigest,
    'the refused attempt cannot overwrite the enrolled identity',
  );
});

test('a revoked enrollment refuses reconnection and cannot be approved without a reset', () => {
  const approved = approveEnrollment(pending(), { capabilityPermissions: {}, at: 2_000 });
  const revoked = revokeEnrollment(approved, 3_000, '');
  assert.equal(revoked.status, 'revoked');

  const outcome = reconcileWorkerConnection(revoked, revoked.worker.identityDigest, 4_000);
  assert.equal(outcome.outcome, 'revoked-refused');
  assert.equal(outcome.requiresHumanApproval, true);

  assert.throws(
    () => approveEnrollment(revoked, { capabilityPermissions: {}, at: 5_000 }),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'revoked-enrollment',
  );
});

test('a fresh reset clears and invalidates the old identity so it cannot reconnect', () => {
  const approved = approveEnrollment(
    pending(),
    { capabilityPermissions: { 'agent-run': true }, at: 2_000 },
  );
  const reset = resetEnrollment(approved, 3_000, '');
  assert.equal(reset.status, 'pending');
  assert.equal(reset.everApproved, false);
  assert.equal(reset.worker.identityDigest, '', 'the claimed identity is cleared until a fresh key claims it');
  assert.equal(reset.requiresFreshIdentity, true);
  assert.ok(
    reset.invalidatedIdentityDigests.includes(approved.worker.identityDigest),
    'the old digest is retained only as an invalidated value',
  );
  assert.deepEqual(reset.capabilityPermissions, {
    'agent-run': false,
    'read-only-investigation': false,
  });
  // The old identity can no longer reconnect, even though the status is pending.
  const reconnect = reconcileWorkerConnection(reset, approved.worker.identityDigest, 4_000);
  assert.equal(reconnect.outcome, 'stale-identity-refused');
  assert.equal(reconnect.requiresHumanApproval, true);
  assert.equal(reconnect.enrollment.worker.identityDigest, '', 'the stale attempt cannot re-claim the identity');
  // The decision history is preserved.
  assert.deepEqual(
    reset.decisions.map((decision) => decision.kind),
    ['requested', 'approved', 'reset'],
  );
});

test('a fresh reset cannot be approved until a newly generated identity claims it', () => {
  const approved = approveEnrollment(pending(), { capabilityPermissions: {}, at: 2_000 });
  const reset = resetEnrollment(approved, 3_000, '');
  assert.throws(
    () => approveEnrollment(reset, { capabilityPermissions: {}, at: 4_000 }),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'fresh-identity-required',
  );

  const fresh = reconcileWorkerConnection(reset, workerIdentityDigest('public-key-fresh'), 4_000);
  assert.equal(fresh.outcome, 'identity-claimed');
  assert.equal(fresh.requiresHumanApproval, true);
  assert.equal(fresh.enrollment.requiresFreshIdentity, false);
  assert.equal(fresh.enrollment.worker.identityDigest, workerIdentityDigest('public-key-fresh'));

  const approvedAgain = approveEnrollment(fresh.enrollment, { capabilityPermissions: {}, at: 5_000 });
  assert.equal(approvedAgain.status, 'approved');
  assert.equal(approvedAgain.worker.identityDigest, workerIdentityDigest('public-key-fresh'));
});

test('a revoked enrollment that is reset can only be reclaimed by a fresh identity', () => {
  const approved = approveEnrollment(pending(), { capabilityPermissions: {}, at: 2_000 });
  const revoked = revokeEnrollment(approved, 3_000, '');
  const reset = resetEnrollment(revoked, 4_000, '');
  assert.equal(reset.status, 'pending');
  assert.equal(
    reconcileWorkerConnection(reset, approved.worker.identityDigest, 5_000).outcome,
    'stale-identity-refused',
  );
  assert.equal(
    reconcileWorkerConnection(reset, workerIdentityDigest('public-key-rotated'), 5_000).outcome,
    'identity-claimed',
  );
});

test('capability permission only changes on an approved enrollment and only for a declared capability', () => {
  const approved = approveEnrollment(pending(), { capabilityPermissions: {}, at: 2_000 });
  const updated = setCapabilityPermission(approved, 'agent-run', true, 3_000);
  assert.equal(updated.capabilityPermissions['agent-run'], true);

  assert.throws(
    () => setCapabilityPermission(pending(), 'agent-run', true, 3_000),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'not-approved',
  );
  assert.throws(
    () => setCapabilityPermission(approved, 'not-declared', true, 3_000),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'unknown-enrollment',
  );
});

test('revoke and reset reasons pass through the privacy boundary before they are retained', () => {
  const approved = approveEnrollment(pending(), { capabilityPermissions: {}, at: 2_000 });
  const revoked = revokeEnrollment(
    approved,
    3_000,
    'retired /Users/example/secret/workspace after key sk-live-abcdefghijklmnopqrst leaked',
  );
  const revokeReason = revoked.decisions.at(-1)!.reason;
  assert.equal(/\/Users\//.test(revokeReason), false, 'no absolute path is retained');
  assert.equal(/sk-live-/.test(revokeReason), false, 'no credential-like token is retained');
  assert.match(revokeReason, /retired/i, 'the decisive operator reason survives');

  const reset = resetEnrollment(revoked, 4_000, 'rotate key at C:\\Users\\example\\secret');
  const resetReason = reset.decisions.at(-1)!.reason;
  assert.equal(/C:\\/.test(resetReason), false, 'no Windows absolute path is retained');
  assert.match(resetReason, /rotate key/i, 'the decisive operator reason survives');
});

test('an empty or all-sensitive reason falls back to the product-owned decisive reason', () => {
  const approved = approveEnrollment(pending(), { capabilityPermissions: {}, at: 2_000 });
  const revoked = revokeEnrollment(approved, 3_000, '   /Users/example  ');
  assert.match(revoked.decisions.at(-1)!.reason, /revoked/i);
  const reset = resetEnrollment(revoked, 4_000, '192.168.1.10:5174');
  assert.equal(/192\.168/.test(reset.decisions.at(-1)!.reason), false);
  assert.match(reset.decisions.at(-1)!.reason, /reset/i);
});

test('the recorded enrollment carries no private key, credential, hostname, or absolute path', () => {
  const serialized = JSON.stringify(pending());
  assert.equal(/PRIVATE KEY/.test(serialized), false);
  assert.equal(/\/Users\//.test(serialized), false);
  assert.equal(/\/home\//.test(serialized), false);
  assert.equal(/[A-Za-z]:\\/.test(serialized), false);
});
