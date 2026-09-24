import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from './worker/enrollment-connector.ts';
import {
  connectRuntimeWorker,
  createRuntime,
  enrollEligibleInstance,
  hostConfiguration,
  observeSyntheticReady,
  testComposition,
  readinessAuthority,
  scriptedReadinessProbe,
  waitFor,
} from './runtime-test-harness.ts';

test('E2: a durable enrollment alone does not admit work; a current epoch and required facts do', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-eligibility-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const keyPath = join(directory, 'host-a-key.pem');
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'host-a',
      displayName: 'Host A',
      publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;
    await runtime.enrollments.approve(enrollmentId, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    await runtime.refreshEnvironmentCatalog();
    // Approved, but no connection and no required readiness facts: catalog
    // entry present, not eligible.
    assert.ok(runtime.environmentCatalog.entry('host-a') !== undefined);
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);

    // A current epoch with no required readiness is still ineligible.
    await connectRuntimeWorker(runtime, enrollmentId, keyPath);
    const emptyEpoch = runtime.workerGateway.currentConnectionEpoch(enrollmentId)!;
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);

    // Establishing the required readiness fact makes it eligible dynamically.
    await observeSyntheticReady(runtime, enrollmentId,
      readinessAuthority(runtime, enrollmentId, emptyEpoch));
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, true);
  } finally {
    await runtime.close();
  }
});

test('E2: two eligible instances stay independent and a lease conflict is observable', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-multi-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
    // Deterministic lease identity so the conflict is asserted precisely.
  });
  try {
    await enrollEligibleInstance(runtime, 'host-a', join(directory, 'host-a-key.pem'));
    await enrollEligibleInstance(runtime, 'host-b', join(directory, 'host-b-key.pem'));
    assert.deepEqual(
      [...runtime.environmentCatalog.eligibleInstanceIds()].sort(),
      ['host-a', 'host-b'],
    );

    const first = runtime.pool.acquireLease({
      instanceId: 'host-a',
      capability: ADMISSION_CAPABILITY,
      holderId: 'scout',
      runId: 'run-a',
      ttlMs: 60_000,
    });
    assert.equal(first.ok, true);
    const conflict = runtime.pool.acquireLease({
      instanceId: 'host-a',
      capability: ADMISSION_CAPABILITY,
      holderId: 'scribe',
      runId: 'run-b',
      ttlMs: 60_000,
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.reason, 'conflict');
    // The second instance is untouched by the first lease.
    const other = runtime.pool.acquireLease({
      instanceId: 'host-b',
      capability: ADMISSION_CAPABILITY,
      holderId: 'scribe',
      runId: 'run-c',
      ttlMs: 60_000,
    });
    assert.equal(other.ok, true);
  } finally {
    await runtime.close();
  }
});

test('E2: a disconnected instance loses eligibility but keeps its catalog record and lease', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-disconnect-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const enrollmentId = await enrollEligibleInstance(runtime, 'host-a', join(directory, 'host-a-key.pem'));
    const lease = runtime.pool.acquireLease({
      instanceId: 'host-a',
      capability: ADMISSION_CAPABILITY,
      holderId: 'scout',
      runId: 'run-a',
      ttlMs: 60_000,
    });
    assert.equal(lease.ok, true);

    // The accepted connection ends: the epoch is invalidated and the catalog is
    // re-projected. The record and the active lease survive; the instance stops
    // admitting new work.
    testComposition(runtime).workerGateway.liveFor('host-a')!.close();
    await waitFor(() => runtime.workerGateway.liveFor('host-a') === undefined, 'disconnected Worker removal');
    await runtime.refreshEnvironmentCatalog();
    assert.ok(runtime.environmentCatalog.entry('host-a') !== undefined, 'offline never deletes');
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    assert.equal(runtime.pool.requiresLease('host-a', ADMISSION_CAPABILITY), undefined);
    if (lease.ok) assert.equal(runtime.pool.getLease(lease.lease.id)?.state, 'active');

    // A newer epoch cannot reuse old readiness. It becomes eligible only after
    // fresh facts for that replacement epoch are stored; the lease is intact.
    await connectRuntimeWorker(runtime, enrollmentId, join(directory, 'host-a-key.pem'));
    const replacement = runtime.workerGateway.currentConnectionEpoch(enrollmentId)!;
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    await observeSyntheticReady(runtime, enrollmentId,
      readinessAuthority(runtime, enrollmentId, replacement));
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, true);
    if (lease.ok) assert.equal(runtime.pool.getLease(lease.lease.id)?.state, 'active');
  } finally {
    await runtime.close();
  }
});

test('E2: replacement and stale readiness ordering never re-admit a prior epoch in a multi-instance pool', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-epoch-order-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const enrollmentA = await enrollEligibleInstance(runtime, 'host-a', join(directory, 'host-a-key.pem'));
    await enrollEligibleInstance(runtime, 'host-b', join(directory, 'host-b-key.pem'));
    const lease = runtime.pool.acquireLease({
      instanceId: 'host-a', capability: ADMISSION_CAPABILITY, holderId: 'scout', runId: 'run-a', ttlMs: 60_000,
    });
    assert.equal(lease.ok, true);
    const firstAuthority = testComposition(runtime).workerGateway.authorizeObservation('host-a')!;

    // Loss followed by a replacement leaves host-b independently eligible but
    // removes host-a until the replacement itself supplies readiness.
    testComposition(runtime).workerGateway.liveFor('host-a')!.close();
    await waitFor(() => runtime.workerGateway.liveFor('host-a') === undefined, 'prior Worker removal');
    await connectRuntimeWorker(runtime, enrollmentA, join(directory, 'host-a-key.pem'));
    const replacement = runtime.workerGateway.currentConnectionEpoch(enrollmentA)!;
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    assert.equal(runtime.environmentCatalog.entry('host-b')?.eligible, true);
    if (lease.ok) assert.equal(runtime.pool.getLease(lease.lease.id)?.state, 'active');

    // A delayed old-epoch observation is refused as non-authoritative and
    // cannot make the new connection eligible or release/conflict-bypass lease.
    await observeSyntheticReady(runtime, enrollmentA, firstAuthority);
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    const blocked = runtime.pool.acquireLease({
      instanceId: 'host-a', capability: ADMISSION_CAPABILITY, holderId: 'scribe', runId: 'run-stale', ttlMs: 60_000,
    });
    assert.equal(blocked.ok, false);

    await observeSyntheticReady(runtime, enrollmentA,
      readinessAuthority(runtime, enrollmentA, replacement));
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, true);
    const conflict = runtime.pool.acquireLease({
      instanceId: 'host-a', capability: ADMISSION_CAPABILITY, holderId: 'scribe', runId: 'run-conflict', ttlMs: 60_000,
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.reason, 'conflict');
  } finally {
    await runtime.close();
  }
});

test('E2: production composition exposes no configured path and no leaked host fact', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-privacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    // No static configured Environment path is retained as a fallback.
    assert.equal(runtime.definition, undefined);
    assert.equal(runtime.instance, undefined);
    assert.equal(runtime.engines.size, 0);

    await enrollEligibleInstance(runtime, 'host-a', join(directory, 'host-a-key.pem'));
    const report = runtime.startupReport(41000);
    assert.match(report, /environment: enrollment catalog \(1 enrolled, 1 eligible\)/);
    assert.equal(report.includes('key-a'), false, 'no identity material leaks into the report');
    assert.equal(report.includes('host-a-key'), false);

    // The durable catalog record carries only portable identity.
    const record = await runtime.stores.environmentCatalog.get('host-a');
    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes('key-a'), false);
    assert.equal(serialized.includes('private'), false);
  } finally {
    await runtime.close();
  }
});

test('E2: approval and revocation re-project eligibility without a restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-mutation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const keyPath = join(directory, 'host-a-key.pem');
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'host-a',
      displayName: 'Host A',
      publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;
    // Application composition has no raw epoch issuer, and a pending enrollment
    // cannot obtain Gateway observation authority.
    assert.equal(testComposition(runtime).workerGateway.authorizeObservation('host-a'), undefined);
    assert.equal(
      await testComposition(runtime).enrollments.observeReadiness(enrollmentId, scriptedReadinessProbe(), {} as never),
      false,
    );
    // Still pending: no admission.
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible ?? false, false);
    assert.equal(await runtime.stores.environmentReadiness.getReadiness('host-a'), undefined);

    // Approval is necessary but not sufficient; only a post-approval Worker
    // observation can restore readiness authority.
    await runtime.enrollments.approve(enrollmentId, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    await connectRuntimeWorker(runtime, enrollmentId, keyPath);
    const epoch = runtime.workerGateway.currentConnectionEpoch(enrollmentId)!;
    await observeSyntheticReady(runtime, enrollmentId,
      readinessAuthority(runtime, enrollmentId, epoch));
    await runtime.refreshEnvironmentCatalog();
    await waitFor(
      () => runtime.environmentCatalog.entry('host-a')?.eligible === true,
      'approval to re-project eligibility',
    );

    // Revocation alone makes it ineligible again, while the record stays.
    await runtime.enrollments.revoke(enrollmentId, 'host retired');
    await waitFor(
      () => runtime.environmentCatalog.entry('host-a')?.eligible === false,
      'revocation to re-project ineligibility',
    );
    assert.ok(runtime.environmentCatalog.entry('host-a') !== undefined, 'revoked stays inspectable');
    assert.equal(runtime.pool.requiresLease('host-a', ADMISSION_CAPABILITY), undefined);
  } finally {
    await runtime.close();
  }
});
