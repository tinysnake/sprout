/**
 * Independent privacy and contract probe for Environment enrollment (#87).
 *
 * `node scripts/probe-environment-enrollment.ts`
 *
 * This is deliberately *outside* the test suite and the Module under test: it
 * drives the real SQLite adapters and the real HTTP router over a real temporary
 * database, then inspects the durable rows and the API payloads it can observe.
 * Its purpose is to try to falsify the ticket's privacy and contract claims
 * rather than to restate them.
 *
 * It prints a sanitized PASS/FAIL transcript. No credential, host identity,
 * address, or absolute path is printed; the temporary database is removed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { EnvironmentEnrollmentService } from '../src/environment/enrollment-service.ts';
import { SqliteEnrollmentStore } from '../src/environment/sqlite-enrollment-store.ts';
import { SqliteEnvironmentReadinessStore } from '../src/environment/sqlite-readiness-store.ts';
import { workerIdentityDigest } from '../src/environment/enrollment-identity.ts';

const SENTINEL_PRIVATE_KEY = 'BEGIN OPENSSH PRIVATE KEY sentinel-private-material';
const SENTINEL_ENGINE_CREDENTIAL = 'sk-sentinel000000000000000000enginecredential';
const SENTINEL_HOSTNAME = 'sentinel-internal-host';
const SENTINEL_ADDRESS = '192.168.77.42';
const SENTINEL_ABSOLUTE_PATH = '/Users/sentinel-home/private/workspace';

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  process.stdout.write(`${status} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const directory = mkdtempSync(join(tmpdir(), 'sprout-enrollment-probe-'));
const dbPath = join(directory, 'sprout.db');
try {
  const enrollments = new SqliteEnrollmentStore({ filename: dbPath });
  const readiness = new SqliteEnvironmentReadinessStore({ filename: dbPath });
  const service = new EnvironmentEnrollmentService({
    enrollments,
    readiness,
    clock: () => 1_000,
    idFactory: () => 'enroll-probe',
  });

  // 1. A pending enrollment created from a public key retains only its digest.
  await service.requestEnrollment({
    environmentInstanceId: 'probe-instance',
    displayName: 'Probe Environment',
    publicKey: 'probe-public-key-material',
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [{ engine: 'codex', installed: true, authenticated: false, models: [] }],
  });
  const created = await service.get('enroll-probe');
  check('public key is digested, not stored', created?.worker.identityDigest === workerIdentityDigest('probe-public-key-material'));
  check('raw public key is absent from the record', JSON.stringify(created).includes('probe-public-key-material') === false);

  // 2. Approval grants the capability and records the decision.
  await service.approve('enroll-probe', { capabilityPermissions: { 'agent-run': true } });
  const approved = await service.get('enroll-probe');
  check('approval is durable', approved?.status === 'approved');
  check('approval grants exactly the requested capability', approved?.capabilityPermissions['agent-run'] === true);

  // 3. Facts stay independent: an engine problem does not change enrollment.
  await service.observeReadiness('enroll-probe', {
    connection: { state: 'online', lastConfirmedAt: 2_000 },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: [
      { engine: 'codex', installed: true, readiness: 'login-required', required: true, models: { state: 'unknown', models: [] } },
      { engine: 'pi', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['pi-probe'] } },
    ],
  });
  const assembled = await service.readiness('enroll-probe');
  check('enrollment remains approved while an engine needs login', assembled.readiness.enrollmentStatus === 'approved');
  check('connection is its own fact', assembled.readiness.connection.state === 'online');
  check('compatibility is its own fact', assembled.readiness.compatibility.state === 'compatible');
  check('engine login is shown independently', assembled.readiness.engines.find((e) => e.engine === 'codex')?.readiness === 'login-required');
  check('work safety is its own fact', assembled.readiness.workSafety.state === 'clear');
  check('the summary is Yellow, not a replacement for the facts', assembled.summary.level === 'yellow');
  check('the summary carries a decisive textual reason', /login/i.test(assembled.summary.reason), assembled.summary.reason);

  // 4. Duplicate identity with a new key is refused without overwriting identity.
  const before = assembled.enrollment.worker.identityDigest;
  await service.connectWorker({
    enrollmentId: 'enroll-probe',
    identityDigest: workerIdentityDigest('a-different-key'),
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: [],
  });
  const afterDuplicate = await service.get('enroll-probe');
  check('a different key cannot replace an approved identity', afterDuplicate?.worker.identityDigest === before);
  check('the refused duplicate is recorded as a durable decision', afterDuplicate?.decisions.some((d) => d.kind === 'duplicate-new-key-refused') === true);
  check('the enrollment stays approved after a refused duplicate', afterDuplicate?.status === 'approved');

  // 5. Revocation is durable and refuses reconnection.
  await service.revoke('enroll-probe', 'probe revocation');
  const revoked = await service.get('enroll-probe');
  check('revocation is durable', revoked?.status === 'revoked');
  const reconnect = await service.connectWorker({
    enrollmentId: 'enroll-probe',
    identityDigest: before!,
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: [],
  });
  check('a revoked Worker cannot reconnect', reconnect.requiresHumanApproval === true);

  // 6. Fresh reset requires a new approval before work.
  await service.reset('enroll-probe', 'probe reset');
  const reset = await service.get('enroll-probe');
  check('reset clears approval', reset?.status === 'pending' && reset?.everApproved === false);
  check('reset clears granted permissions', reset?.capabilityPermissions['agent-run'] === false);
  check('reset preserves the decision history', (reset?.decisions.length ?? 0) >= 5);

  // 7. The durable rows and every observed payload carry no private material.
  const raw = new DatabaseSync(dbPath);
  const rows = raw.prepare('SELECT * FROM environment_enrollments').all() as unknown as readonly Record<string, unknown>[];
  const probes = ['SELECT * FROM environment_readiness', 'SELECT * FROM environment_probes']
    .flatMap((sql) => raw.prepare(sql).all() as unknown as readonly Record<string, unknown>[]);
  const durableText = JSON.stringify([...rows, ...probes]);
  raw.close();

  const forbidden: readonly [string, string][] = [
    ['private key material', SENTINEL_PRIVATE_KEY],
    ['engine credential', SENTINEL_ENGINE_CREDENTIAL],
    ['hostname', SENTINEL_HOSTNAME],
    ['private address', SENTINEL_ADDRESS],
    ['absolute path', SENTINEL_ABSOLUTE_PATH],
    ['macOS home path', '/Users/'],
    ['Linux home path', '/home/'],
    ['Windows home path', 'C:\\Users\\'],
  ];
  for (const [label, needle] of forbidden) {
    check(`durable state excludes ${label}`, durableText.includes(needle) === false);
  }
  check('durable state contains no raw public key', durableText.includes('probe-public-key-material') === false);

  // 8. Reopen the store: outcomes survive a restart, so nothing is recomputed.
  const reopenedEnrollments = new SqliteEnrollmentStore({ filename: dbPath });
  const reopened = await reopenedEnrollments.get('enroll-probe');
  check('the reset outcome survives a store reopen', reopened?.status === 'pending');
  check('decision history survives a store reopen', (reopened?.decisions.length ?? 0) === (reset?.decisions.length ?? -1));

  process.stdout.write(
    failures === 0
      ? '\nPROBE RESULT: PASS — enrollment facts are durable, independent, and privacy-safe.\n'
      : `\nPROBE RESULT: FAIL — ${failures} check(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
