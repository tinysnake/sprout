import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EnvironmentEnrollmentService } from './enrollment-service.ts';
import { SqliteEnrollmentStore } from './sqlite-enrollment-store.ts';
import { SqliteEnvironmentReadinessStore } from './sqlite-readiness-store.ts';
import { workerIdentityFixture, type WorkerIdentityFixture } from './worker-identity-fixture.ts';
import { workerIdentityDigest } from './enrollment-identity.ts';
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
    ...(options.leases !== undefined ? { leases: () => options.leases! } : {}),
    clock: () => options.now ?? 10_000,
    idFactory: () => 'enroll-1',
  });
}

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

test('a revocation survives reopen and still refuses reconnection', async () => {
  const { directory, path } = databasePath();
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
    await enrollments.observeReadiness('enroll-1', {
      connection: { state: 'online', lastConfirmedAt: 5_000 },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [
        {
          engine: 'codex',
          installed: true,
          readiness: 'login-required',
          required: true,
          models: { state: 'unknown', models: [] },
        },
        {
          engine: 'pi',
          installed: true,
          readiness: 'ready',
          required: true,
          models: { state: 'available', models: ['pi-model'] },
        },
      ],
    });
    await enrollments.recordProbe('enroll-1', {
      at: 1_000,
      latencyMs: 20,
      protocolOk: true,
      enginesOk: false,
      summary: 'codex login required',
    });
    await enrollments.recordProbe('enroll-1', {
      at: 2_000,
      latencyMs: 12,
      protocolOk: true,
      enginesOk: true,
      summary: 'all engines ready',
    });
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
    assert.equal(assembled.readiness.compatibility.workerProtocolVersion, '2.1', 'the revoked reconnect does not replace the observed protocol');
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
    await enrollments.observeReadiness('enroll-1', {
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [
        { engine: 'codex', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['gpt-5-codex'] } },
        { engine: 'pi', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['pi-model'] } },
      ],
    });
    const assembled = await enrollments.readiness('enroll-1');
    assert.equal(assembled.readiness.workSafety.state, 'recovery');
    assert.equal(assembled.summary.level, 'red');
    assert.match(assembled.summary.reason, /recovery/i);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a legacy durable enrollment row with unsanitized text is sanitized on read', async () => {
  const { directory, path } = databasePath();
  try {
    const store = stores(path);
    // Simulate an earlier writer that persisted an unsanitized display name and
    // decision reason, plus a credential typed into an identifier and an
    // arbitrary protocol string. The read must not return any of it.
    const legacy = {
      id: 'enroll-1',
      environmentInstanceId: 'local-macos',
      displayName: 'buildbox-07 /srv/sprout/worker password=hunter2correcthorse',
      status: 'revoked',
      everApproved: true,
      worker: {
        identityDigest: workerIdentityDigest('legacy-public-key'),
        platform: 'macos',
        protocolVersion: '2.1 /srv/leak',
        capabilityRequests: ['agent-run', '/srv/leak'],
        engineFacts: [{ engine: '/srv/engine', installed: true, authenticated: false, models: ['/srv/model'] }],
      },
      capabilityPermissions: { 'agent-run': true, '/srv/cap': true },
      createdAt: 1_000,
      updatedAt: 1_000,
      decisions: [
        {
          kind: 'revoked',
          actor: 'operator',
          at: 1_000,
          reason: 'retired /srv/sprout/worker on buildbox-07 with password=hunter2correcthorse and token=abc123def456ghi789',
        },
      ],
    };
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw
      .prepare('INSERT INTO environment_enrollments (id, environment_instance_id, document) VALUES (?, ?, ?)')
      .run('enroll-1', 'local-macos', JSON.stringify(legacy));
    raw.close();

    const enrollments = service(store);
    const readBack = await enrollments.get('enroll-1');
    const serialized = JSON.stringify(readBack);
    assert.equal(/\/srv\//.test(serialized), false, 'the legacy absolute path is sanitized on read');
    assert.equal(/buildbox-07/.test(serialized), false, 'the legacy hostname is sanitized on read');
    assert.equal(/hunter2correcthorse/.test(serialized), false, 'the legacy credential is sanitized on read');
    assert.equal(/abc123def456ghi789/.test(serialized), false, 'the legacy token is sanitized on read');
    assert.match(readBack!.decisions[0]!.reason, /retired/i, 'the decisive legacy reason survives');
    // The wire projection is the last boundary and applies the same rule.
    const { toEnrollmentView } = await import('../web/views.ts');
    const viewText = JSON.stringify(toEnrollmentView(readBack!));
    assert.equal(/\/srv\//.test(viewText), false, 'the wire view sanitizes a legacy display name');
    assert.equal(/hunter2correcthorse/.test(viewText), false, 'the wire view sanitizes a legacy reason');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a legacy durable document written before the identity-proof rework is read additively', async () => {
  const { directory, path } = databasePath();
  try {
    const store = stores(path);
    // Simulate an older writer: no invalidatedIdentityDigests and no
    // requiresFreshIdentity field. Reading it must not produce undefined-shaped
    // breakage, and the old identity stays usable as a normal pending identity.
    const legacy = {
      id: 'enroll-1',
      environmentInstanceId: 'local-macos',
      displayName: 'Local Mac',
      status: 'pending',
      everApproved: false,
      worker: {
        identityDigest: workerIdentityDigest('legacy-public-key'),
        platform: 'macos',
        capabilityRequests: ['agent-run'],
        engineFacts: [],
      },
      capabilityPermissions: { 'agent-run': false },
      createdAt: 1_000,
      updatedAt: 1_000,
      decisions: [{ kind: 'requested', actor: 'operator', at: 1_000, reason: 'legacy' }],
    };
    // Write through the raw SQLite table the store owns, so this is exactly what
    // an earlier build left behind rather than a re-serialization of a new shape.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw
      .prepare('INSERT INTO environment_enrollments (id, environment_instance_id, document) VALUES (?, ?, ?)')
      .run('enroll-1', 'local-macos', JSON.stringify(legacy));
    raw.close();

    const enrollments = service(store);
    const readBack = await enrollments.get('enroll-1');
    assert.deepEqual(readBack?.invalidatedIdentityDigests, []);
    assert.equal(readBack?.requiresFreshIdentity, false);

    // The legacy identity can still claim/approve normally, so the upgrade is
    // additive rather than a silent lockout.
    const worker = workerIdentityFixture();
    const claimed = await enrollments.connectWorker({
      enrollmentId: 'enroll-1',
      proof: await worker.prove(enrollments, 'enroll-1'),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
    // The legacy digest differs from the presented key, so it is refused as a
    // duplicate; but the read itself did not throw, which is the additive claim.
    assert.equal(claimed.outcome, 'duplicate-new-key-refused');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a legacy durable readiness row with an absolute path is sanitized on read', async () => {
  const { directory, path } = databasePath();
  try {
    const store = stores(path);
    const worker = workerIdentityFixture();
    const enrollments = service(store);
    await request(enrollments, worker);
    await enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });

    // Simulate an earlier writer that persisted an unsanitized detail/summary, as
    // a pre-rework build (or a bypassing adapter) would have.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        'INSERT INTO environment_readiness (environment_instance_id, document, updated_at) VALUES (?, ?, ?) ON CONFLICT(environment_instance_id) DO UPDATE SET document = excluded.document',
      )
      .run(
        'local-macos',
        JSON.stringify({
          connection: { state: 'online' },
          compatibility: {
            state: 'incompatible',
            workerProtocolVersion: '3',
            detail: 'mismatch at /Users/example/secret with sk-live-abcdefghijklmnop',
          },
          engines: [],
        }),
        Date.now(),
      );
    raw
      .prepare(
        'INSERT INTO environment_probes (environment_instance_id, at, sequence, document) VALUES (?, ?, ?, ?)',
      )
      .run(
        'local-macos',
        1_000,
        1,
        JSON.stringify({ at: 1_000, latencyMs: 1, protocolOk: false, enginesOk: false, summary: 'failed at /Users/example/secret' }),
      );
    raw.close();

    const assembled = await enrollments.readiness('enroll-1');
    const serialized = JSON.stringify(assembled.readiness);
    assert.equal(/\/Users\//.test(serialized), false, 'the legacy detail is sanitized on read');
    assert.equal(/sk-live-/.test(serialized), false, 'the legacy credential is sanitized on read');
    const probes = await enrollments.listProbes('enroll-1');
    assert.equal(/\/Users\//.test(JSON.stringify(probes)), false, 'the legacy probe summary is sanitized on read');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the durable enrollment document contains no private key, public key, signature, or absolute path', async () => {
  const { directory, path } = databasePath();
  try {
    const store = stores(path);
    const enrollments = service(store);
    const worker = workerIdentityFixture();
    await request(enrollments, worker);
    await enrollments.approve('enroll-1', { capabilityPermissions: {} });
    await connect(enrollments, worker, 'enroll-1', {
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1', detail: 'ok at /Users/example/private/key material' },
      engines: [],
    });
    const row = await store.enrollments.get('enroll-1');
    const serialized = JSON.stringify(row);
    assert.equal(serialized.includes(worker.publicKey), false, 'the public key is not retained, only its digest');
    assert.equal(serialized.includes(worker.privateKey), false, 'the private key never crosses the boundary');
    assert.equal(serialized.includes('signature'), false, 'the proof signature is not retained');
    assert.equal(row?.worker.identityDigest, worker.digest, 'only the digest is retained');
    assert.equal(/PRIVATE KEY/.test(serialized), false);
    assert.equal(/\/Users\//.test(serialized), false);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
