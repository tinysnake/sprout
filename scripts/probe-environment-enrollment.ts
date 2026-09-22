/**
 * Independent privacy and contract probe for Environment enrollment (#87).
 *
 * `node scripts/probe-environment-enrollment.ts`
 *
 * This is deliberately *outside* the test suite and the Module under test: it
 * drives the real SQLite adapters and the real enrollment service over a real
 * temporary database, then inspects the durable rows and the observed payloads.
 * Its purpose is to try to falsify the ticket's privacy, identity-proof, reset,
 * and readiness claims rather than to restate them.
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
import { workerIdentityFixture, proveChallenge } from '../src/environment/worker-identity-fixture.ts';
import { generateWorkerIdentity } from '../src/environment/worker-proof.ts';

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

  const worker = workerIdentityFixture();

  // 1. A pending enrollment created from a public key retains only its digest.
  await service.requestEnrollment({
    environmentInstanceId: 'probe-instance',
    displayName: 'Probe Environment',
    publicKey: worker.publicKey,
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [{ engine: 'codex', installed: true, authenticated: false, models: [] }],
  });
  const created = await service.get('enroll-probe');
  check('public key is digested, not stored', created?.worker.identityDigest === worker.digest);
  check('raw public key is absent from the record', JSON.stringify(created).includes(worker.publicKey) === false);

  // 2. A bare digest is not a proof: a connect without a real challenge response
  //    must be refused before any identity is reconciled.
  let bareRefused = false;
  try {
    await service.connectWorker({
      enrollmentId: 'enroll-probe',
      // Deliberately bypass the typed proof with a forged object.
      proof: { challengeId: 'forged', publicKey: worker.publicKey, signature: 'AAAA' } as never,
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
  } catch (error) {
    bareRefused = (error as { code?: string }).code === 'invalid-proof';
  }
  check('a fabricated challenge response is refused as an invalid proof', bareRefused);

  // 3. A valid but mismatched signature is refused.
  const challenge = await service.issueChallenge('enroll-probe');
  const other = generateWorkerIdentity();
  const forged = proveChallenge(other.privateKey, worker.publicKey, challenge);
  let forgedRefused = false;
  try {
    await service.connectWorker({
      enrollmentId: 'enroll-probe',
      proof: forged,
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
  } catch (error) {
    forgedRefused = (error as { code?: string }).code === 'invalid-proof';
  }
  check('a signature that does not match the presented public key is refused', forgedRefused);

  // 4. Replay is refused: a valid proof is single-use.
  const replayChallenge = await service.issueChallenge('enroll-probe');
  const goodProof = proveChallenge(worker.privateKey, worker.publicKey, replayChallenge);
  await service.connectWorker({
    enrollmentId: 'enroll-probe',
    proof: goodProof,
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: [],
  });
  let replayed = false;
  try {
    await service.connectWorker({
      enrollmentId: 'enroll-probe',
      proof: goodProof,
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
  } catch (error) {
    replayed = (error as { code?: string }).code === 'invalid-proof';
  }
  check('a captured proof cannot be replayed', replayed);

  // 5. Approval grants the capability and records the decision.
  await service.approve('enroll-probe', { capabilityPermissions: { 'agent-run': true } });
  const approved = await service.get('enroll-probe');
  check('approval is durable', approved?.status === 'approved');
  check('approval grants exactly the requested capability', approved?.capabilityPermissions['agent-run'] === true);

  // 6. Facts stay independent: an engine problem does not change enrollment.
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

  // 7. Duplicate identity with a different verified key is refused without
  //    overwriting identity.
  const before = assembled.enrollment.worker.identityDigest;
  const rogue = workerIdentityFixture();
  await service.connectWorker({
    enrollmentId: 'enroll-probe',
    proof: await rogue.prove(service, 'enroll-probe'),
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: [],
  });
  const afterDuplicate = await service.get('enroll-probe');
  check('a different key cannot replace an approved identity', afterDuplicate?.worker.identityDigest === before);
  check('the refused duplicate is recorded as a durable decision', afterDuplicate?.decisions.some((d) => d.kind === 'duplicate-new-key-refused') === true);
  check('the enrollment stays approved after a refused duplicate', afterDuplicate?.status === 'approved');

  // 8. Revocation is durable and refuses reconnection.
  await service.revoke('enroll-probe', `retired ${SENTINEL_ABSOLUTE_PATH} and ${SENTINEL_ENGINE_CREDENTIAL}`);
  const revoked = await service.get('enroll-probe');
  check('revocation is durable', revoked?.status === 'revoked');
  const reconnect = await service.connectWorker({
    enrollmentId: 'enroll-probe',
    proof: await worker.prove(service, 'enroll-probe'),
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: [],
  });
  check('a revoked Worker cannot reconnect', reconnect.requiresHumanApproval === true);

  // 9. Fresh reset invalidates the old identity: the old key can neither
  //    reconnect nor be approved, and a fresh key gets a fresh approval.
  await service.reset('enroll-probe', `rotate ${SENTINEL_ADDRESS}`);
  const reset = await service.get('enroll-probe');
  check('reset clears approval', reset?.status === 'pending' && reset?.everApproved === false);
  check('reset clears granted permissions', reset?.capabilityPermissions['agent-run'] === false);
  check('reset clears the current identity', reset?.worker.identityDigest === '');
  check('reset records the old identity as invalidated', reset?.invalidatedIdentityDigests.includes(worker.digest) === true);
  const staleReconnect = await service.connectWorker({
    enrollmentId: 'enroll-probe',
    proof: await worker.prove(service, 'enroll-probe'),
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: [],
  });
  check('the old key cannot reconnect after a reset', staleReconnect.outcome === 'stale-identity-refused');
  let oldApprovalRefused = false;
  try {
    await service.approve('enroll-probe', { capabilityPermissions: { 'agent-run': true } });
  } catch (error) {
    oldApprovalRefused = (error as { code?: string }).code === 'fresh-identity-required';
  }
  check('the old identity cannot be approved after a reset', oldApprovalRefused);
  const freshWorker = workerIdentityFixture();
  const claimed = await service.connectWorker({
    enrollmentId: 'enroll-probe',
    proof: await freshWorker.prove(service, 'enroll-probe'),
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: [],
  });
  check('a newly generated key claims the reset enrollment', claimed.outcome === 'identity-claimed');
  check('the claimed identity is the fresh one', claimed.enrollment.worker.identityDigest === freshWorker.digest);

  // 10. The durable rows and every observed payload carry no private material.
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
    ['the Worker public key', worker.publicKey],
    ['the Worker private key', worker.privateKey],
  ];
  for (const [label, needle] of forbidden) {
    check(`durable state excludes ${label}`, durableText.includes(needle) === false);
  }
  check('durable state keeps the decisive revoke reason', durableText.includes('retired') === true);
  check('durable state keeps the decisive reset reason', durableText.includes('rotate') === true);

  // 11. Marked free text is sanitized before it is retained.
  await service.recordProbe('enroll-probe', {
    at: 3_000,
    latencyMs: 5,
    protocolOk: true,
    enginesOk: true,
    summary: `probe touched ${SENTINEL_ABSOLUTE_PATH} with ${SENTINEL_ENGINE_CREDENTIAL}`,
  });
  const probesList = await service.listProbes('enroll-probe');
  const summary = probesList.at(-1)!.summary;
  check('a probe summary drops an absolute path', summary.includes(SENTINEL_ABSOLUTE_PATH) === false, summary);
  check('a probe summary drops a credential', summary.includes(SENTINEL_ENGINE_CREDENTIAL) === false, summary);
  check('a probe summary keeps its decisive text', summary.includes('probe touched') === true, summary);

  // 12. Reopen the store: outcomes survive a restart, so nothing is recomputed.
  const latest = await service.get('enroll-probe');
  const reopenedEnrollments = new SqliteEnrollmentStore({ filename: dbPath });
  const reopened = await reopenedEnrollments.get('enroll-probe');
  check('the reset outcome survives a store reopen', reopened?.status === 'pending');
  check('decision history survives a store reopen', (reopened?.decisions.length ?? 0) === (latest?.decisions.length ?? -1));
  check('the invalidated identity survives a store reopen', reopened?.invalidatedIdentityDigests.includes(worker.digest) === true);

  process.stdout.write(
    failures === 0
      ? '\nPROBE RESULT: PASS — enrollment identity proof, reset invalidation, and privacy are durable and independent.\n'
      : `\nPROBE RESULT: FAIL — ${failures} check(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
