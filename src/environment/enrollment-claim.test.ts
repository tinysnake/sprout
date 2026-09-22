import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EnvironmentEnrollmentService } from './enrollment-service.ts';
import { InMemoryEnrollmentStore } from './enrollment-store.ts';
import { InMemoryEnvironmentReadinessStore } from './readiness-store.ts';
import { EnrollmentError, type EnvironmentEnrollment } from './enrollment.ts';
import { workerIdentityFixture } from './worker-identity-fixture.ts';

/**
 * Enrollment claim semantics (#115, ADR-0012): a Human creates an identity-free
 * pending enrollment, a host claims it with a one-use short-lived secret, binds a
 * public key only after challenge proof, and can never approve itself.
 */

function service(options: { readonly now?: () => number } = {}): {
  readonly enrollments: EnvironmentEnrollmentService;
  readonly store: InMemoryEnrollmentStore;
} {
  const store = new InMemoryEnrollmentStore();
  return {
    store,
    enrollments: new EnvironmentEnrollmentService({
      enrollments: store,
      readiness: new InMemoryEnvironmentReadinessStore(),
      clock: options.now ?? (() => 1_000),
      idFactory: () => 'enroll-1',
      claimSecretFactory: () => 'claim-secret-one',
      claimTtlMs: 60_000,
    }),
  };
}

async function requestIdentityFree(
  enrollments: EnvironmentEnrollmentService,
): Promise<{ readonly enrollment: EnvironmentEnrollment; readonly secret: string }> {
  const result = await enrollments.requestEnrollment({
    environmentInstanceId: 'local-macos',
    displayName: 'Local Mac',
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  assert.notEqual(result.claim, undefined);
  return { enrollment: result.enrollment, secret: result.claim!.secret };
}

test('a Web-created pending enrollment needs no key and separates the one-use secret', async () => {
  const { enrollments } = service();
  const { enrollment, secret } = await requestIdentityFree(enrollments);
  assert.equal(enrollment.status, 'pending');
  // No identity is bound, and neither the raw secret nor a digest is a Worker key.
  assert.equal(enrollment.worker.identityDigest, '');
  assert.equal(JSON.stringify(enrollment).includes(secret), false);
  assert.notEqual(enrollment.claim, undefined);
  assert.equal(enrollment.claim?.secretDigest.includes(secret), false);
  assert.equal(enrollment.claim?.consumedAt, undefined);
});

test('a claim consumes the one-use secret exactly once', async () => {
  const { enrollments } = service();
  const { enrollment, secret } = await requestIdentityFree(enrollments);
  const claimed = await enrollments.claimEnrollment(enrollment.id, secret);
  assert.notEqual(claimed.claim?.consumedAt, undefined);
  await assert.rejects(
    () => enrollments.claimEnrollment(enrollment.id, secret),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'invalid-claim',
  );
});

test('a wrong secret is refused and does not consume the claim', async () => {
  const { enrollments } = service();
  const { enrollment, secret } = await requestIdentityFree(enrollments);
  await assert.rejects(
    () => enrollments.claimEnrollment(enrollment.id, 'wrong-secret'),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'invalid-claim',
  );
  // The correct secret still works, so a failed attempt cannot deny a retry.
  const claimed = await enrollments.claimEnrollment(enrollment.id, secret);
  assert.notEqual(claimed.claim?.consumedAt, undefined);
});

test('an expired claim is refused cleanly at the exact boundary', async () => {
  let now = 1_000;
  const store = new InMemoryEnrollmentStore();
  const enrollments = new EnvironmentEnrollmentService({
    enrollments: store,
    readiness: new InMemoryEnvironmentReadinessStore(),
    clock: () => now,
    idFactory: () => 'enroll-1',
    claimSecretFactory: () => 'claim-secret-one',
    claimTtlMs: 60_000,
  });
  const { enrollment, secret } = await requestIdentityFree(enrollments);
  now = 1_000 + 60_000; // exactly the expiry instant is already too late
  await assert.rejects(
    () => enrollments.claimEnrollment(enrollment.id, secret),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'invalid-claim',
  );
});

test('a revoked enrollment can never be claimed', async () => {
  const { enrollments } = service();
  const { enrollment, secret } = await requestIdentityFree(enrollments);
  await enrollments.revoke(enrollment.id, 'host retired');
  await assert.rejects(
    () => enrollments.claimEnrollment(enrollment.id, secret),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'revoked-enrollment',
  );
});

test('identity proof is refused until the enrollment is claimed', async () => {
  const { enrollments } = service();
  const worker = workerIdentityFixture();
  const { enrollment, secret } = await requestIdentityFree(enrollments);
  const beforeClaim = await worker.prove(enrollments, enrollment.id);
  await assert.rejects(
    () =>
      enrollments.connectWorker({
        enrollmentId: enrollment.id,
        proof: beforeClaim,
        connection: { state: 'online' },
        compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
        engines: [],
      }),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'invalid-claim',
  );
  // After claiming, the same proof binds the identity but still needs approval.
  await enrollments.claimEnrollment(enrollment.id, secret);
  const outcome = await enrollments.connectWorker({
    enrollmentId: enrollment.id,
    proof: await worker.prove(enrollments, enrollment.id),
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: [],
  });
  assert.equal(outcome.outcome, 'identity-claimed');
  assert.equal(outcome.requiresHumanApproval, true);
  assert.equal(outcome.enrollment.status, 'pending');
});

test('claiming never approves; only a Human approval decides', async () => {
  const { enrollments } = service();
  const worker = workerIdentityFixture();
  const { enrollment, secret } = await requestIdentityFree(enrollments);
  await enrollments.claimEnrollment(enrollment.id, secret);
  await enrollments.connectWorker({
    enrollmentId: enrollment.id,
    proof: await worker.prove(enrollments, enrollment.id),
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: [],
  });
  const afterClaim = await enrollments.get(enrollment.id);
  assert.equal(afterClaim?.status, 'pending');
  assert.equal(afterClaim?.everApproved, false);
});

test('a pre-provisioned public key needs no claim and retains only its digest', async () => {
  const { enrollments } = service();
  const worker = workerIdentityFixture();
  const result = await enrollments.requestEnrollment({
    environmentInstanceId: 'local-macos',
    displayName: 'Local Mac',
    publicKey: worker.publicKey,
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  assert.equal(result.claim, undefined);
  assert.equal(result.enrollment.worker.identityDigest, worker.digest);
  assert.equal(JSON.stringify(result.enrollment).includes(worker.publicKey), false);
});

test('an Environment instance has one durable enrollment and rotates identity through reset', async () => {
  const { enrollments } = service();
  const first = await requestIdentityFree(enrollments);
  await assert.rejects(
    () =>
      enrollments.requestEnrollment({
        environmentInstanceId: first.enrollment.environmentInstanceId,
        displayName: 'Same Environment',
        platform: 'macos',
        capabilityRequests: ['agent-run'],
        engineFacts: [],
      }),
    (error: unknown) => error instanceof EnrollmentError && error.code === 'duplicate-instance',
  );
  await enrollments.reset(first.enrollment.id, 'rotate Worker identity');
  const reset = await enrollments.get(first.enrollment.id);
  assert.equal(reset?.status, 'pending');
  assert.equal((await enrollments.list()).length, 1, 'reset retains the one durable authority record');
});

/**
 * Exactly-once claim consumption under concurrency (#115 review finding 1).
 *
 * Two claimants present the same valid one-use secret at the same instant. The
 * store compare-and-set must let exactly one succeed; the other must be refused
 * durably as `invalid-claim`, never as a second success. This is the race that
 * made the one-use guarantee replayable before the rework.
 */
test('concurrent claims with the same valid secret yield exactly one success', async () => {
  const { enrollments } = service();
  const { enrollment, secret } = await requestIdentityFree(enrollments);
  const results = await Promise.allSettled([
    enrollments.claimEnrollment(enrollment.id, secret),
    enrollments.claimEnrollment(enrollment.id, secret),
    enrollments.claimEnrollment(enrollment.id, secret),
  ]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent claimant may succeed');
  assert.equal(rejected.length, 2);
  for (const rejection of rejected) {
    assert.ok(rejection.status === 'rejected');
    const error = rejection.reason as { code?: string };
    assert.equal(error.code, 'invalid-claim');
  }
  // The durable record shows exactly one consumption.
  const stored = await enrollments.get(enrollment.id);
  assert.notEqual(stored?.claim?.consumedAt, undefined);
});
