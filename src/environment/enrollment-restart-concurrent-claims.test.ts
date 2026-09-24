import { test } from 'node:test';

import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { EnvironmentEnrollmentService } from './enrollment-service.ts';

import { createReadinessAuthorityTestSeam } from './readiness-authority.test-support.ts';

import { SqliteEnrollmentStore } from './sqlite-enrollment-store.ts';

import { SqliteEnvironmentReadinessStore } from './sqlite-readiness-store.ts';

import type { EnvironmentReadinessStore } from './readiness-store.ts';

import type { EnrollmentStore } from './enrollment-store.ts';import type { LeaseSafetyFact } from './readiness.ts';


/**
 * Reopen/restart evidence for Environment enrollment and readiness (#87).
 *
 * The primary persistence seam is a real temporary SQLite store closed and
 * reopened, so these prove that an approval, revocation, reset, duplicate
 * outcome, and observed readiness fact survive a process restart rather than
 * being recomputed into a different state.
 *
 * Since the #87 rework, every connect carries a real private-key possession
 * proof, so these also prove that identity reconciliation happens *after*
 * verification rather than from a bare digest.
 */

const readinessAuthorityTestSeam = createReadinessAuthorityTestSeam();


function databasePath(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-enrollment-'));
  return { directory, path: join(directory, 'sprout.db') };
}


function stores(path: string): { enrollments: EnrollmentStore; readiness: EnvironmentReadinessStore; close: () => void } {
  const enrollments = new SqliteEnrollmentStore({ filename: path });
  const readiness = new SqliteEnvironmentReadinessStore({ filename: path });
  return { enrollments, readiness, close: () => enrollments.close() };
}


function service(
  store: { enrollments: EnrollmentStore; readiness: EnvironmentReadinessStore },
  options: { readonly leases?: readonly LeaseSafetyFact[]; readonly now?: number } = {},
): EnvironmentEnrollmentService {
  return new EnvironmentEnrollmentService({
    enrollments: store.enrollments,
    readiness: store.readiness,
    currentConnectionEpoch: () => 1,
    verifyObservationAuthority: readinessAuthorityTestSeam.verify,
    ...(options.leases !== undefined ? { leases: () => options.leases! } : {}),
    clock: () => options.now ?? 10_000,
    idFactory: () => 'enroll-1',
  });
}


test('concurrent claims over one SQLite store persist exactly one consumption', async () => {
  const { directory, path } = databasePath();
  try {
    const store = stores(path);
    const enrollments = service(store);
    const requested = await enrollments.requestEnrollment({
      environmentInstanceId: 'local-macos',
      displayName: 'Local Mac',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    const secret = requested.claim?.secret ?? '';
    const results = await Promise.allSettled([
      enrollments.claimEnrollment('enroll-1', secret),
      enrollments.claimEnrollment('enroll-1', secret),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    store.close();

    // Reopen: the durable record proves exactly one consumption survived.
    const reopened = stores(path);
    const stored = await reopened.enrollments.get('enroll-1');
    assert.notEqual(stored?.claim?.consumedAt, undefined);
    // A replay after reopen is refused from the durable fact, not process memory.
    await assert.rejects(
      () => service(reopened).claimEnrollment('enroll-1', secret),
      (error: unknown) => (error as { code?: string }).code === 'invalid-claim',
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
