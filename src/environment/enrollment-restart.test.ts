import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EnvironmentEnrollmentService } from './enrollment-service.ts';
import { SqliteEnrollmentStore } from './sqlite-enrollment-store.ts';
import { SqliteEnvironmentReadinessStore } from './sqlite-readiness-store.ts';
import { workerIdentityDigest } from './enrollment-identity.ts';
import type { EnvironmentReadinessStore } from './readiness-store.ts';
import type { EnrollmentStore } from './enrollment-store.ts';
import type { LeaseSafetyFact } from './readiness.ts';

/**
 * Reopen/restart evidence for Environment enrollment and readiness (#87).
 *
 * The primary persistence seam is a real temporary SQLite store closed and
 * reopened, so these prove that an approval, revocation, reset, duplicate
 * outcome, and observed readiness fact survive a process restart rather than
 * being recomputed into a different state.
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

test('an approved enrollment and its capability permissions survive a store reopen', async () => {
  const { directory, path } = databasePath();
  try {
    const first = stores(path);
    const enrollments = service(first);
    await enrollments.requestEnrollment({
      environmentInstanceId: 'local-macos',
      displayName: 'Local Mac',
      publicKey: 'public-key-a',
      platform: 'macos',
      protocolVersion: '2.1',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
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
    await enrollments.requestEnrollment({
      environmentInstanceId: 'local-macos',
      displayName: 'Local Mac',
      publicKey: 'public-key-a',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    await enrollments.approve('enroll-1', { capabilityPermissions: {} });
    await enrollments.revoke('enroll-1', 'host retired');
    first.close();

    const second = stores(path);
    const reopened = service(second);
    const outcome = await reopened.connectWorker({
      enrollmentId: 'enroll-1',
      identityDigest: workerIdentityDigest('public-key-a'),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
    assert.equal(outcome.outcome, 'revoked-refused');
    assert.equal(outcome.requiresHumanApproval, true);
    assert.equal((await second.enrollments.get('enroll-1'))?.status, 'revoked');
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a reset survives reopen and requires a fresh Human approval', async () => {
  const { directory, path } = databasePath();
  try {
    const first = stores(path);
    const enrollments = service(first);
    await enrollments.requestEnrollment({
      environmentInstanceId: 'local-macos',
      displayName: 'Local Mac',
      publicKey: 'public-key-a',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    await enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
    await enrollments.reset('enroll-1', 'identity rotated');
    first.close();

    const second = stores(path);
    const reopened = await second.enrollments.get('enroll-1');
    assert.equal(reopened?.status, 'pending');
    assert.equal(reopened?.everApproved, false);
    assert.equal(reopened?.capabilityPermissions['agent-run'], false);
    assert.deepEqual(reopened?.decisions.map((decision) => decision.kind), ['requested', 'approved', 'reset']);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('observed readiness facts and probe history survive reopen without being silently rewritten', async () => {
  const { directory, path } = databasePath();
  try {
    const first = stores(path);
    const enrollments = service(first);
    await enrollments.requestEnrollment({
      environmentInstanceId: 'local-macos',
      displayName: 'Local Mac',
      publicKey: 'public-key-a',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
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
    await enrollments.requestEnrollment({
      environmentInstanceId: 'local-macos',
      displayName: 'Local Mac',
      publicKey: 'public-key-a',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    await enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
    // The enrolled Worker was online and ready at least once.
    await enrollments.connectWorker({
      enrollmentId: 'enroll-1',
      identityDigest: workerIdentityDigest('public-key-a'),
      connection: { state: 'online', lastConfirmedAt: 2_000 },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [
        { engine: 'codex', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['gpt-5-codex'] } },
        { engine: 'pi', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['pi-model'] } },
      ],
    });

    // A different key tries to connect: refused, and it must not overwrite the
    // enrolled Worker's observed readiness with its own claims.
    await enrollments.connectWorker({
      enrollmentId: 'enroll-1',
      identityDigest: workerIdentityDigest('public-key-b'),
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
    await enrollments.connectWorker({
      enrollmentId: 'enroll-1',
      identityDigest: workerIdentityDigest('public-key-a'),
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
    await enrollments.requestEnrollment({
      environmentInstanceId: 'local-macos',
      displayName: 'Local Mac',
      publicKey: 'public-key-a',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    await enrollments.approve('enroll-1', { capabilityPermissions: {} });
    await enrollments.connectWorker({
      enrollmentId: 'enroll-1',
      identityDigest: workerIdentityDigest('public-key-b'),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
    first.close();

    const second = stores(path);
    const reopened = await second.enrollments.get('enroll-1');
    assert.equal(reopened?.worker.identityDigest, workerIdentityDigest('public-key-a'));
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
    await enrollments.requestEnrollment({
      environmentInstanceId: 'local-macos',
      displayName: 'Local Mac',
      publicKey: 'public-key-a',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
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

test('the durable enrollment document contains no private key or absolute path', async () => {
  const { directory, path } = databasePath();
  try {
    const store = stores(path);
    const enrollments = service(store);
    await enrollments.requestEnrollment({
      environmentInstanceId: 'local-macos',
      displayName: 'Local Mac',
      publicKey: 'public-key-a',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    const row = await store.enrollments.get('enroll-1');
    const serialized = JSON.stringify(row);
    assert.equal(/public-key-a/.test(serialized), false, 'the raw public key is not retained, only its digest');
    assert.equal(/PRIVATE KEY/.test(serialized), false);
    assert.equal(/\/Users\//.test(serialized), false);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
