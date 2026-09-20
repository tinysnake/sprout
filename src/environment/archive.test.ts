import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EnvironmentArchiveService, ArchiveError } from './archive.ts';
import { InMemoryEnrollmentStore } from './enrollment-store.ts';
import {
  createPendingEnrollment,
  approveEnrollment,
  type EnvironmentEnrollment,
} from './enrollment.ts';

const at = 1_000;

function approvedEnrollment(): EnvironmentEnrollment {
  const pending = createPendingEnrollment({
    id: 'enroll-1',
    environmentInstanceId: 'inst-1',
    displayName: 'Local Mac',
    platform: 'macos',
    identityDigest: 'digest-1',
    at,
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  return approveEnrollment(pending, { capabilityPermissions: { 'agent-run': true }, at });
}

function service(
  enrollment: EnvironmentEnrollment,
  leases: readonly { instanceId: string; state: string }[] = [],
  recovery: readonly { phase: string }[] = [],
): EnvironmentArchiveService {
  const store = new InMemoryEnrollmentStore();
  store.save(enrollment);
  return new EnvironmentArchiveService({
    enrollments: store,
    leases: { leases: () => leases },
    recovery: { listForEnvironment: async () => recovery },
    clock: () => at + 1,
  });
}

test('archive is refused while an active or recovering lease depends on the instance', async () => {
  const archive = service(approvedEnrollment(), [{ instanceId: 'inst-1', state: 'active' }]);
  await assert.rejects(
    archive.archive('enroll-1'),
    (error: unknown) => error instanceof ArchiveError && error.code === 'active-work-depends-on-environment',
  );
  const recovering = service(approvedEnrollment(), [{ instanceId: 'inst-1', state: 'recovering' }]);
  await assert.rejects(
    recovering.archive('enroll-1'),
    (error: unknown) => error instanceof ArchiveError && error.code === 'active-work-depends-on-environment',
  );
});

test('archive is refused while an open recovery record protects the instance', async () => {
  const archive = service(approvedEnrollment(), [], [{ phase: 'reconciling' }]);
  await assert.rejects(
    archive.archive('enroll-1'),
    (error: unknown) => error instanceof ArchiveError && error.code === 'recovery-depends-on-environment',
  );
});

test('archive preserves identity and history, and records the decision', async () => {
  const enrollment = approvedEnrollment();
  const archive = service(enrollment);
  const archived = await archive.archive('enroll-1', 'host retired for the week');
  assert.equal(archived.status, 'archived');
  assert.equal(archived.worker.identityDigest, enrollment.worker.identityDigest);
  assert.deepEqual(archived.capabilityPermissions, enrollment.capabilityPermissions);
  assert.equal(archived.decisions[archived.decisions.length - 1]?.kind, 'archived');
  // The decision history is append-only: every prior decision survives.
  assert.equal(archived.decisions.length, enrollment.decisions.length + 1);

  // A reason that is only redacted placeholder text falls back to product text.
  const archive2 = service(approvedEnrollment());
  const fallback = await archive2.archive('enroll-1', '');
  assert.equal(fallback.decisions[fallback.decisions.length - 1]?.kind, 'archived');
});

test('archiving twice is refused', async () => {
  const archive = service(approvedEnrollment());
  await archive.archive('enroll-1');
  await assert.rejects(
    archive.archive('enroll-1'),
    (error: unknown) => error instanceof ArchiveError && error.code === 'already-archived',
  );
});

test('restore reuses the still-valid approved enrollment and appends the decision', async () => {
  const archive = service(approvedEnrollment());
  await archive.archive('enroll-1');
  const restored = await archive.restore('enroll-1');
  assert.equal(restored.status, 'approved');
  assert.equal(restored.decisions[restored.decisions.length - 1]?.kind, 'restored');
});

test('restore is refused for a record that is not archived', async () => {
  const archive = service(approvedEnrollment());
  await assert.rejects(
    archive.restore('enroll-1'),
    (error: unknown) => error instanceof ArchiveError && error.code === 'not-archived',
  );
});

test('an unknown enrollment is a sanitized 404-class refusal', async () => {
  const archive = service(approvedEnrollment());
  await assert.rejects(
    archive.archive('nope'),
    (error: unknown) => error instanceof ArchiveError && error.code === 'unknown-enrollment',
  );
});
