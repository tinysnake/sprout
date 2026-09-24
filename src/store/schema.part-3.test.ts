import { test } from 'node:test';

import assert from 'node:assert/strict';import { existsSync, mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';import { SchemaTooNewError, SchemaTooOldError, MigrationSafetyCopyError, SchemaMigrationError, getSchemaVersion, sanitizePath, defaultSafetyCopyPath, type MigrationStep } from './schema.ts';

import { SqliteStore } from './db.ts';import { SqliteSessionKeyStore } from '../run/sqlite-store.ts';

import { SqliteLeaseStore } from '../environment/sqlite-store.ts';

import { SqliteProjectStore } from '../project/sqlite-store.ts';

import { SqliteCollaborationStore } from '../collaboration/sqlite-store.ts';


function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-schema-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}


test('failure in a later multi-step migration rolls back all previous steps completely (M77-SCHEMA-002)', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const safetyPath = defaultSafetyCopyPath(dbPath);

    // Seed v1 database
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE test_data (id TEXT PRIMARY KEY, val TEXT);
      INSERT INTO test_data VALUES ('k1', 'initial_v1');
    `);
    seedDb.close();

    const multiStepMigrations: readonly MigrationStep[] = [
      {
        fromVersion: 1,
        toVersion: 2,
        name: 'step_1_to_2',
        migrate: (db) => {
          db.exec('ALTER TABLE test_data ADD COLUMN step2_col TEXT DEFAULT "added_in_step2";');
        },
      },
      {
        fromVersion: 2,
        toVersion: 3,
        name: 'step_2_to_3_failing',
        migrate: () => {
          throw new Error('Simulated SQL error in migration step 2');
        },
      },
    ];

    assert.throws(
      () =>
        new SqliteStore({
          filename: dbPath,
          targetSchemaVersion: 3,
          supportedSchemaRange: { min: 1, max: 3, current: 3 },
          migrations: multiStepMigrations,
        }),
      (err: unknown) => err instanceof SchemaMigrationError && err.fromVersion === 1 && err.toVersion === 3,
    );

    // Database must be rolled back completely to v1
    const verifyDb = new DatabaseSync(dbPath);
    assert.equal(getSchemaVersion(verifyDb), 1, 'user_version must remain 1');

    // The column added in step 1 must NOT exist in the database!
    const columns = verifyDb.prepare('PRAGMA table_info(test_data)').all() as unknown as readonly { name: string }[];
    assert.equal(columns.some((c) => c.name === 'step2_col'), false, 'step 1 changes must have rolled back');

    verifyDb.close();

    // Safety copy must be preserved
    assert.equal(existsSync(safetyPath), true);
  });
});


test('path sanitization sanitizes arbitrary Unix, Windows, and UNC absolute paths (M77-PRIVACY-001)', () => {
  // Arbitrary Unix absolute paths
  assert.equal(sanitizePath('/var/lib/sprout/db.sqlite'), '<absolute-path>');
  assert.equal(sanitizePath('/opt/sprout/data.db'), '<absolute-path>');
  assert.equal(sanitizePath('/srv/data/sprout.db'), '<absolute-path>');
  assert.equal(sanitizePath('/tmp/test-sprout.db'), '<temporary-path>');
  assert.equal(sanitizePath('/private/tmp/test-sprout.db'), '<temporary-path>');

  // Arbitrary Windows drive paths
  assert.equal(sanitizePath('D:\\sprout\\data.db'), '<absolute-path>');
  assert.equal(sanitizePath('C:\\ProgramData\\sprout\\db.sqlite'), '<absolute-path>');
  assert.equal(sanitizePath('E:/storage/sprout.db'), '<absolute-path>');
  assert.equal(sanitizePath('C:\\Windows\\Temp\\sprout.db'), '<temporary-path>');

  // UNC paths
  assert.equal(sanitizePath('\\\\server\\share\\sprout.db'), '<network-share-path>');
  assert.equal(sanitizePath('//nas/backup/sprout.db'), '<network-share-path>');

  // Error messages and guidance must not expose raw causes, credentials, or absolute paths
  const copyError = new MigrationSafetyCopyError({
    databasePath: '/var/data/sprout.db',
    safetyCopyPath: '/var/data/sprout.db.safety-copy',
    fromVersion: 0,
    toVersion: 1,
  });
  assert.ok(!copyError.message.startsWith('/var/data'));
  assert.ok(!copyError.guidance.startsWith('/var/data'));
  assert.ok(copyError.message.includes('<absolute-path>'));
  assert.ok(copyError.guidance.includes('<absolute-path>'));
  assert.ok(copyError.guidance.includes('stopped'));
  assert.equal('causeError' in copyError, false);
  assert.equal(copyError.safetyCopyPath, '<absolute-path>');

  const migrationError = new SchemaMigrationError({
    databasePath: 'C:\\Users\\admin\\db.sqlite',
    safetyCopyPath: 'C:\\Users\\admin\\db.sqlite.safety-copy',
    fromVersion: 1,
    toVersion: 2,
  });
  assert.ok(!migrationError.message.includes('admin'));
  assert.ok(!migrationError.guidance.includes('admin'));
  assert.ok(migrationError.guidance.includes('stopped'));
  assert.equal('causeError' in migrationError, false);
  assert.equal(migrationError.safetyCopyPath, '<home-path>');
});


test('directly constructed domain adapters enforce schema coordination and safety copy (M77-SCHEMA-003)', async () => {
  await withTempDir(async (dir) => {
    // 1. Direct SqliteProjectStore on legacy v0 creates a safety copy before migrating.
    const projDbPath = join(dir, 'proj.db');
    const projSafetyPath = defaultSafetyCopyPath(projDbPath);
    const seedProj = new DatabaseSync(projDbPath);
    seedProj.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      INSERT INTO projects VALUES ('p1', '{"id":"p1"}');
    `);
    seedProj.close();

    const projStore = new SqliteProjectStore({ filename: projDbPath });
    assert.equal(existsSync(projSafetyPath), true, 'SqliteProjectStore must create safety copy for non-empty migration');
    const projCopyDb = new DatabaseSync(projSafetyPath);
    assert.equal(getSchemaVersion(projCopyDb), 0);
    projCopyDb.close();
    projStore.close();

    // 2. Direct SqliteLeaseStore on a future schema throws SchemaTooNewError
    const futureDbPath = join(dir, 'future.db');
    const seedFuture = new DatabaseSync(futureDbPath);
    seedFuture.exec('PRAGMA user_version = 17; CREATE TABLE dummy (id TEXT);');
    seedFuture.close();

    assert.throws(
      () => new SqliteLeaseStore({ filename: futureDbPath }),
      (err: unknown) => err instanceof SchemaTooNewError,
    );
    assert.throws(
      () => new SqliteSessionKeyStore({ filename: futureDbPath }),
      (err: unknown) => err instanceof SchemaTooNewError,
    );
    assert.throws(
      () => new SqliteCollaborationStore({ filename: futureDbPath }),
      (err: unknown) => err instanceof SchemaTooNewError,
    );
  });
});


test('empty store initialization validates targetVersion against supportedRange (M77-SCHEMA-004)', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'empty.db');

    // Attempting to create an empty database with targetSchemaVersion = 2 (above max 1)
    assert.throws(
      () =>
        new SqliteStore({
          filename: dbPath,
          targetSchemaVersion: 2,
          supportedSchemaRange: { min: 0, max: 1, current: 1 },
        }),
      (err: unknown) => err instanceof SchemaTooNewError && err.version === 2,
    );

    // Attempting to create an empty database with targetSchemaVersion = -1 (below min 0)
    assert.throws(
      () =>
        new SqliteStore({
          filename: dbPath,
          targetSchemaVersion: -1,
          supportedSchemaRange: { min: 0, max: 1, current: 1 },
        }),
      (err: unknown) => err instanceof SchemaTooOldError && err.version === -1,
    );
  });
});
