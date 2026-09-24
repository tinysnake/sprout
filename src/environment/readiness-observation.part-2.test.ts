import assert from 'node:assert/strict';

import { test } from 'node:test';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';import { createReadinessObservation } from './readiness-observation.ts';

import { SqliteStore } from '../store/db.ts';

import { workerReadinessProbeFixture } from '../worker/readiness-fixture.ts';

import { createReadinessAuthorityTestSeam } from './readiness-authority.test-support.ts';


const readinessAuthorityTestSeam = createReadinessAuthorityTestSeam();


test('sqlite additive migration preserves legacy history and reopen requires fresh accepted Worker evidence (Scenario 13, #126)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-obs-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'sprout.db');

  // 1. Seed a legacy database at schema version 14 with legacy readiness and probe rows
  const legacyReadiness = {
    enrollmentId: 'enroll-legacy',
    connectionEpoch: 2,
    connection: { state: 'online' as const, lastConfirmedAt: 500 },
    compatibility: { state: 'compatible' as const, workerProtocolVersion: '2' },
    engines: [{
      engine: 'codex',
      installed: true,
      readiness: 'ready' as const,
      required: true,
      models: { state: 'available' as const, models: ['gpt-5'] },
    }],
  };
  const legacyProbe = {
    enrollmentId: 'enroll-legacy',
    connectionEpoch: 2,
    at: 500,
    latencyMs: 10,
    protocolOk: true,
    enginesOk: true,
    source: 'worker' as const,
    version: '1.0.0',
    summary: 'legacy probe from v14',
  };

  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    PRAGMA user_version = 14;
    CREATE TABLE environment_enrollments (
      id TEXT PRIMARY KEY,
      environment_instance_id TEXT NOT NULL,
      document TEXT NOT NULL
    );
    CREATE TABLE environment_instance_enrollment_authority (
      environment_instance_id TEXT PRIMARY KEY,
      enrollment_id TEXT NOT NULL
    );
    CREATE TABLE environment_readiness (
      environment_instance_id TEXT PRIMARY KEY,
      document TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE environment_probes (
      environment_instance_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY (environment_instance_id, sequence)
    );
    CREATE TABLE worker_connection_epochs (
      enrollment_id TEXT PRIMARY KEY,
      high_water INTEGER NOT NULL CHECK (high_water > 0)
    );
  `);
  legacyDb.prepare('INSERT INTO environment_enrollments VALUES (?, ?, ?)').run('enroll-legacy', 'env-leg', '{}');
  legacyDb.prepare('INSERT INTO environment_instance_enrollment_authority VALUES (?, ?)').run('env-leg', 'enroll-legacy');
  legacyDb.prepare('INSERT INTO environment_readiness VALUES (?, ?, ?)').run('env-leg', JSON.stringify(legacyReadiness), 500);
  legacyDb.prepare('INSERT INTO environment_probes VALUES (?, ?, ?, ?)').run('env-leg', legacyProbe.at, 1, JSON.stringify(legacyProbe));
  legacyDb.prepare('INSERT INTO worker_connection_epochs VALUES (?, ?)').run('enroll-legacy', 2);
  legacyDb.close();

  // 2. Open via SqliteStore (applies migration 14 -> 15)
  const store = new SqliteStore({ filename: dbPath });
  assert.equal(store.schemaVersion, 16);

  // Legacy rows are preserved as historical; getCurrentObservation returns undefined
  // because unscoped legacy rows cannot establish a current observation
  const legacyCurrent = await store.environmentReadiness.getCurrentObservation('env-leg');
  assert.equal(legacyCurrent, undefined, 'legacy row cannot be promoted to current observation');

  // Legacy probe is still in history
  const legacyProbes = await store.environmentReadiness.listProbes('env-leg');
  assert.equal(legacyProbes.length, 1);
  assert.equal(legacyProbes[0]?.summary, 'legacy probe from v14');

  // 3. Fresh accepted Worker evidence establishes new current observation and receipt
  const freshAuthority = readinessAuthorityTestSeam.mint({
    environmentInstanceId: 'env-leg',
    enrollmentId: 'enroll-legacy',
    connectionEpoch: 3,
    isCurrent: () => true,
  });
  const freshResult = workerReadinessProbeFixture({
    protocolVersion: '2',
    observedAt: 1_500,
    engines: [{ engine: 'codex', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-5'] }],
  });
  const freshObs = createReadinessObservation(freshResult, {
    environmentInstanceId: 'env-leg',
    authority: freshAuthority,
    supported: { minMajor: 2, maxMajor: 2 },
    at: 1_500,
    verifyAuthority: readinessAuthorityTestSeam.verify,
  });
  assert.ok(freshObs);
  const receipt = await store.environmentReadiness.commitObservation('env-leg', freshObs, freshAuthority);
  assert.ok(receipt);
  assert.equal(receipt.connectionEpoch, 3);
  assert.equal(receipt.sequence, 2);

  // Now current observation is the fresh one
  const freshCurrent = await store.environmentReadiness.getCurrentObservation('env-leg');
  assert.ok(freshCurrent);
  assert.equal(freshCurrent.observationId, receipt.observationId);
  assert.equal(freshCurrent.sequence, 2);

  // Reopen store: historical receipt survives
  store.close();
  const reopened = new SqliteStore({ filename: dbPath });
  try {
    assert.equal(reopened.schemaVersion, 16);
    const retrievedReceipt = await reopened.environmentReadiness.getReceipt('env-leg', receipt.observationId);
    assert.ok(retrievedReceipt);
    assert.equal(retrievedReceipt.observationId, receipt.observationId);
    assert.equal(retrievedReceipt.sequence, 2);

    const allProbes = await reopened.environmentReadiness.listProbes('env-leg');
    assert.equal(allProbes.length, 2);
    assert.equal(allProbes[0]?.summary, 'legacy probe from v14');
    assert.equal(allProbes[1]?.at, freshResult.probe.at);
  } finally {
    reopened.close();
  }
});
