import { test } from 'node:test';

import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { EnvironmentEnrollmentService } from './enrollment-service.ts';

import { workerReadinessProbeFixture } from '../worker/readiness-fixture.ts';

import { createReadinessAuthorityTestSeam } from './readiness-authority.test-support.ts';import { EnrollmentError } from './enrollment.ts';

import { SqliteEnrollmentStore } from './sqlite-enrollment-store.ts';

import { SqliteEnvironmentReadinessStore } from './sqlite-readiness-store.ts';

import { workerIdentityFixture, type WorkerIdentityFixture } from './worker-identity-fixture.ts';

import type { EnvironmentReadinessStore } from './readiness-store.ts';

import type { EnrollmentStore } from './enrollment-store.ts';

import type { ConnectionFact, CompatibilityFact, EngineReadinessFact, LeaseSafetyFact } from './readiness.ts';

import type { EnvironmentEnrollment } from './enrollment.ts';


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

async function recordIssued(enrollments: EnvironmentEnrollmentService,
  result: ReturnType<typeof workerReadinessProbeFixture>) {
  const attempt = await enrollments.issueReadinessAttempt('enroll-1', readinessAuthority);
  assert.ok(attempt);
  return enrollments.recordReadinessObservation('enroll-1', result, readinessAuthority, { attempt });
}


const readinessAuthority = readinessAuthorityTestSeam.mint({
  environmentInstanceId: 'local-macos',
  enrollmentId: 'enroll-1',
  connectionEpoch: 1,
});


async function request(
  enrollments: EnvironmentEnrollmentService,
  worker: WorkerIdentityFixture,
  overrides: { readonly publicKey?: string } = {},
): Promise<EnvironmentEnrollment> {
  const result = await enrollments.requestEnrollment({
    environmentInstanceId: 'local-macos',
    displayName: 'Local Mac',
    publicKey: overrides.publicKey ?? worker.publicKey,
    platform: 'macos',
    protocolVersion: '2.1',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  return result.enrollment;
}


async function connect(
  enrollments: EnvironmentEnrollmentService,
  worker: WorkerIdentityFixture,
  enrollmentId: string,
  overrides: {
    readonly connection?: ConnectionFact;
    readonly compatibility?: CompatibilityFact;
    readonly engines?: readonly EngineReadinessFact[];
  } = {},
) {
  return enrollments.connectWorker({
    enrollmentId,
    proof: await worker.prove(enrollments, enrollmentId),
    connection: overrides.connection ?? { state: 'online' },
    compatibility: overrides.compatibility ?? { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: overrides.engines ?? [],
  });
}


test('an approved enrollment and its capability permissions survive a store reopen', async () => {
  const { directory, path } = databasePath();
  try {
    const first = stores(path);
    const enrollments = service(first);
    const worker = workerIdentityFixture();
    await request(enrollments, worker);
    await enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
    first.close();

    const second = stores(path);
    const reopened = await second.enrollments.get('enroll-1');
    assert.equal(reopened?.status, 'approved');
    assert.equal(reopened?.capabilityPermissions['agent-run'], true);
    assert.deepEqual(reopened?.decisions.map((decision) => decision.kind), ['requested', 'approved']);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('SQLite reserves one enrollment authority per Environment instance across reopen', async () => {
  const { directory, path } = databasePath();
  try {
    const firstStores = stores(path);
    const firstService = service(firstStores);
    await request(firstService, workerIdentityFixture());
    firstStores.close();

    const reopenedStores = stores(path);
    const reopenedService = service(reopenedStores);
    await assert.rejects(
      () => request(reopenedService, workerIdentityFixture()),
      (error: unknown) => error instanceof EnrollmentError && error.code === 'duplicate-instance',
    );
    assert.equal((await reopenedService.list()).length, 1);
    reopenedStores.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('a revocation survives reopen and still refuses reconnection', async () => {  const { directory, path } = databasePath();
  try {
    const first = stores(path);
    const enrollments = service(first);
    const worker = workerIdentityFixture();
    await request(enrollments, worker);
    await enrollments.approve('enroll-1', { capabilityPermissions: {} });
    await enrollments.revoke('enroll-1', 'host retired');
    first.close();

    const second = stores(path);
    const reopened = service(second);
    const outcome = await connect(reopened, worker, 'enroll-1');
    assert.equal(outcome.outcome, 'revoked-refused');
    assert.equal(outcome.requiresHumanApproval, true);
    assert.equal((await second.enrollments.get('enroll-1'))?.status, 'revoked');
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('a reset survives reopen and invalidates the old identity', async () => {
  const { directory, path } = databasePath();
  try {
    const first = stores(path);
    const enrollments = service(first);
    const worker = workerIdentityFixture();
    await request(enrollments, worker);
    await enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
    await enrollments.reset('enroll-1', 'identity rotated');
    first.close();

    const second = stores(path);
    const reopened = await second.enrollments.get('enroll-1');
    assert.equal(reopened?.status, 'pending');
    assert.equal(reopened?.everApproved, false);
    assert.equal(reopened?.capabilityPermissions['agent-run'], false);
    assert.equal(reopened?.worker.identityDigest, '', 'the old digest is cleared');
    assert.ok(
      reopened?.invalidatedIdentityDigests.includes(worker.digest),
      'the old digest is recorded as invalidated',
    );
    assert.deepEqual(reopened?.decisions.map((decision) => decision.kind), ['requested', 'approved', 'reset']);

    // The old key cannot reconnect after the reset: it is refused as stale.
    const reopenedService = service(second);
    const refused = await connect(reopenedService, worker, 'enroll-1');
    assert.equal(refused.outcome, 'stale-identity-refused');
    assert.equal(refused.requiresHumanApproval, true);
    // And it cannot be approved either: the enrollment still needs a fresh key.
    await assert.rejects(
      () => reopenedService.approve('enroll-1', { capabilityPermissions: {} }),
      (error: unknown) => (error as { code?: string }).code === 'fresh-identity-required',
    );
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('a fresh reset requires a newly generated identity, which still needs fresh Human approval', async () => {
  const { directory, path } = databasePath();
  try {
    const store = stores(path);
    const enrollments = service(store);
    const oldWorker = workerIdentityFixture();
    await request(enrollments, oldWorker);
    await enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
    await enrollments.reset('enroll-1', 'identity rotated');

    // The old key can neither reconnect nor be approved.
    assert.equal((await connect(enrollments, oldWorker, 'enroll-1')).outcome, 'stale-identity-refused');

    // A newly generated key claims the pending request.
    const freshWorker = workerIdentityFixture();
    const claimed = await connect(enrollments, freshWorker, 'enroll-1');
    assert.equal(claimed.outcome, 'identity-claimed');
    assert.equal(claimed.requiresHumanApproval, true);
    assert.equal(claimed.enrollment.worker.identityDigest, freshWorker.digest);
    assert.equal(claimed.enrollment.requiresFreshIdentity, false);

    // Approval is now possible, and grants a fresh identity rather than the old.
    const approved = await enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
    assert.equal(approved.enrollment.status, 'approved');
    assert.equal(approved.enrollment.worker.identityDigest, freshWorker.digest);
    assert.notEqual(approved.enrollment.worker.identityDigest, oldWorker.digest);

    // The fresh key now reconnects automatically, and the old key stays barred.
    assert.equal((await connect(enrollments, freshWorker, 'enroll-1')).outcome, 'reconnected');
    assert.equal((await connect(enrollments, oldWorker, 'enroll-1')).outcome, 'stale-identity-refused');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('observed readiness facts and probe history survive reopen without being silently rewritten', async () => {
  const { directory, path } = databasePath();
  try {
    const first = stores(path);
    const enrollments = service(first);
    const worker = workerIdentityFixture();
    await request(enrollments, worker);
    await enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
    const observation = {
      observedAt: 5_000,
      protocolVersion: '2.1',
      engines: [
        {
          engine: 'codex',
          installed: true,
          readiness: 'login-required',
          modelAvailability: 'unknown',
          models: [],
        },
        {
          engine: 'pi',
          installed: true,
          readiness: 'ready',
          modelAvailability: 'available',
          models: ['pi-model'],
        },
      ],
    } as const;
    await recordIssued(enrollments, workerReadinessProbeFixture(observation, {
      at: 1_000,
      latencyMs: 20,
      protocolOk: true,
      enginesOk: false,
      summary: 'codex login required',
    }));
    await recordIssued(enrollments, workerReadinessProbeFixture(observation, {
      at: 2_000,
      latencyMs: 12,
      protocolOk: true,
      enginesOk: true,
      summary: 'all engines ready',
    }));
    first.close();

    const second = stores(path);
    const reopened = service(second);
    const assembled = await reopened.readiness('enroll-1');
    assert.equal(assembled.readiness.connection.state, 'online');
    assert.equal(assembled.readiness.engines[0]?.readiness, 'login-required');
    assert.equal(assembled.summary.level, 'yellow');
    assert.match(assembled.summary.reason, /login/i);
    // Both probes are retained, newest last, so history is append-only.
    const probes = await reopened.listProbes('enroll-1');
    assert.deepEqual(probes.map((probe) => probe.at), [1_000, 2_000]);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('a refused connection never produces or overwrites readiness facts', async () => {
  const { directory, path } = databasePath();
  try {
    const first = stores(path);
    const enrollments = service(first);
    const enrolled = workerIdentityFixture();
    const rogue = workerIdentityFixture();
    await request(enrollments, enrolled);
    await enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
    // The enrolled Worker was online and ready at least once.
    await connect(enrollments, enrolled, 'enroll-1', {
      connection: { state: 'online', lastConfirmedAt: 2_000 },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [
        { engine: 'codex', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['gpt-5-codex'] } },
        { engine: 'pi', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['pi-model'] } },
      ],
    });
    await recordIssued(enrollments, workerReadinessProbeFixture({
      observedAt: 2_000,
      protocolVersion: '2.1',
      engines: [
        { engine: 'codex', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-5-codex'] },
        { engine: 'pi', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['pi-model'] },
      ],
    }));

    // A different verified key tries to connect: refused, and it must not
    // overwrite the enrolled Worker's observed readiness with its own claims.
    await connect(enrollments, rogue, 'enroll-1', {
      connection: { state: 'online', lastConfirmedAt: 3_000 },
      compatibility: { state: 'compatible', workerProtocolVersion: '9.0' },
      engines: [
        { engine: 'codex', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['rogue-model'] } },
      ],
    });
    let assembled = await enrollments.readiness('enroll-1');
    assert.equal(assembled.readiness.compatibility.workerProtocolVersion, '2.1', 'the refused connection does not replace the observed protocol');
    assert.equal(assembled.readiness.engines.find((e) => e.engine === 'pi')?.readiness, 'ready');

    // Revocation is durable and a revoked Worker's reconnect cannot resurrect
    // or rewrite readiness either.
    await enrollments.revoke('enroll-1', 'host retired');
    await connect(enrollments, enrolled, 'enroll-1', {
      connection: { state: 'online', lastConfirmedAt: 4_000 },
      compatibility: { state: 'compatible', workerProtocolVersion: '9.0' },
      engines: [],
    });
    assembled = await enrollments.readiness('enroll-1');
    assert.equal(assembled.readiness.enrollmentStatus, 'revoked');
    assert.equal(
      assembled.readiness.compatibility.workerProtocolVersion,
      undefined,
      'revocation removes the old epoch from the current readiness projection',
    );
    assert.equal(assembled.summary.level, 'red');
    first.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('a duplicate-identity outcome is durable and restart-safe', async () => {
  const { directory, path } = databasePath();
  try {
    const first = stores(path);
    const enrollments = service(first);
    const enrolled = workerIdentityFixture();
    const rogue = workerIdentityFixture();
    await request(enrollments, enrolled);
    await enrollments.approve('enroll-1', { capabilityPermissions: {} });
    await connect(enrollments, rogue, 'enroll-1');
    first.close();

    const second = stores(path);
    const reopened = await second.enrollments.get('enroll-1');
    assert.equal(reopened?.worker.identityDigest, enrolled.digest);
    assert.ok(
      reopened?.decisions.some((decision) => decision.kind === 'duplicate-new-key-refused'),
      'the refused duplicate attempt is retained as a durable decision',
    );
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('work safety is projected from the lease registry into the Red summary', async () => {
  const { directory, path } = databasePath();
  try {
    const store = stores(path);
    const enrollments = service(store, { leases: [{ instanceId: 'local-macos', state: 'recovering' }] });
    const worker = workerIdentityFixture();
    await request(enrollments, worker);
    await enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
    await recordIssued(enrollments, workerReadinessProbeFixture({
      protocolVersion: '2.1',
      engines: [
        { engine: 'codex', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-5-codex'] },
        { engine: 'pi', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['pi-model'] },
      ],
    }));
    const assembled = await enrollments.readiness('enroll-1');
    assert.equal(assembled.readiness.workSafety.state, 'recovery');
    assert.equal(assembled.summary.level, 'red');
    assert.match(assembled.summary.reason, /recovery/i);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
