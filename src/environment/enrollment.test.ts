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

test('same-key connection is an idempotent reconnect and never a second identity', () => {
  const approved = approveEnrollment(pending(), { capabilityPermissions: {}, at: 2_000 });
  const outcome = reconcileWorkerConnection(approved, approved.worker.identityDigest, 3_000);
  assert.equal(outcome.outcome, 'reconnected');
  assert.equal(outcome.requiresHumanApproval, false);
  assert.equal(outcome.enrollment.id, approved.id, 'the same Environment identity is reused');
});

test('same-key connection while pending stays pending and still requires approval', () => {
  const enrollment = pending();
  const outcome = reconcileWorkerConnection(enrollment, enrollment.worker.identityDigest, 3_000);
  assert.equal(outcome.outcome, 'duplicate-same-key');
  assert.equal(outcome.requiresHumanApproval, true);
  assert.equal(outcome.enrollment.status, 'pending');
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

test('a fresh reset clears approval so only a new identity requires a fresh Human approval', () => {
  const approved = approveEnrollment(
    pending(),
    { capabilityPermissions: { 'agent-run': true }, at: 2_000 },
  );
  const reset = resetEnrollment(approved, 3_000, '');
  assert.equal(reset.status, 'pending');
  assert.equal(reset.everApproved, false);
  assert.deepEqual(reset.capabilityPermissions, {
    'agent-run': false,
    'read-only-investigation': false,
  });
  // The old identity can still be recognized, but it is no longer approved, so
  // the reset Worker needs a new Human approval before work.
  const reconnect = reconcileWorkerConnection(reset, reset.worker.identityDigest, 4_000);
  assert.equal(reconnect.requiresHumanApproval, true);
  // The decision history is preserved.
  assert.deepEqual(
    reset.decisions.map((decision) => decision.kind),
    ['requested', 'approved', 'reset'],
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

test('the recorded enrollment carries no private key, credential, hostname, or absolute path', () => {
  const serialized = JSON.stringify(pending());
  assert.equal(/PRIVATE KEY/.test(serialized), false);
  assert.equal(/\/Users\//.test(serialized), false);
  assert.equal(/\/home\//.test(serialized), false);
  assert.equal(/[A-Za-z]:\\/.test(serialized), false);
});
