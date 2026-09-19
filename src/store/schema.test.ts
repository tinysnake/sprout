import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  MAX_SUPPORTED_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_RANGE,
  SchemaTooNewError,
  SchemaTooOldError,
  MigrationSafetyCopyError,
  SchemaMigrationError,
  getSchemaVersion,
  sanitizePath,
  defaultSafetyCopyPath,
  type MigrationStep,
} from './schema.ts';
import { SqliteStore } from './db.ts';
import { SqliteRunStore } from '../run/sqlite-store.ts';
import { SqliteTaskStore } from '../task/sqlite-store.ts';

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-schema-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}

test('schema constants declare supported version range', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 1);
  assert.equal(MIN_SUPPORTED_SCHEMA_VERSION, 0);
  assert.equal(MAX_SUPPORTED_SCHEMA_VERSION, 1);
  assert.deepEqual(SUPPORTED_SCHEMA_RANGE, {
    min: 0,
    max: 1,
    current: 1,
  });
});

test('empty store creation initializes full schema at current version with no safety copy', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const safetyPath = defaultSafetyCopyPath(dbPath);

    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(safetyPath), false);

    const store = new SqliteStore({ filename: dbPath });
    assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(getSchemaVersion(store.db), CURRENT_SCHEMA_VERSION);

    // No pre-migration safety copy is created for a brand-new empty store
    assert.equal(existsSync(safetyPath), false, 'empty store must not create a safety copy');

    // All domain tables exist
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as unknown as readonly { readonly name: string }[];
    assert.ok(tables.some((t) => t.name === 'agent_runs'));
    assert.ok(tables.some((t) => t.name === 'environment_leases'));
    assert.ok(tables.some((t) => t.name === 'projects'));
    assert.ok(tables.some((t) => t.name === 'tasks'));
    assert.ok(tables.some((t) => t.name === 'collaboration_messages'));

    store.close();

    // Reopening the same-version database succeeds with no safety copy
    const reopened = new SqliteStore({ filename: dbPath });
    assert.equal(reopened.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(existsSync(safetyPath), false);
    reopened.close();
  });
});

test('empty in-memory store initializes schema at current version', () => {
  const store = new SqliteStore({ filename: ':memory:' });
  assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(getSchemaVersion(store.db), CURRENT_SCHEMA_VERSION);
  store.close();
});

test('non-empty store receives pre-migration safety copy before forward migration', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const safetyPath = defaultSafetyCopyPath(dbPath);

    // Create a legacy v0 database with data
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      INSERT INTO projects (id, document) VALUES ('proj-1', '{"id":"proj-1","goal":"Legacy"}');
    `);
    assert.equal(getSchemaVersion(seedDb), 0);
    seedDb.close();

    assert.equal(existsSync(safetyPath), false);

    // Open through SqliteStore, triggering forward migration v0 -> v1
    const store = new SqliteStore({ filename: dbPath });
    assert.equal(store.schemaVersion, 1);
    assert.equal(getSchemaVersion(store.db), 1);

    // Pre-migration safety copy must exist
    assert.equal(existsSync(safetyPath), true, 'safety copy must be created for non-empty migration');

    // Inspect safety copy database: must be at v0
    const copyDb = new DatabaseSync(safetyPath);
    assert.equal(getSchemaVersion(copyDb), 0);
    const copyProject = copyDb.prepare('SELECT document FROM projects WHERE id = ?').get('proj-1') as { document: string };
    assert.equal(JSON.parse(copyProject.document).goal, 'Legacy');
    copyDb.close();

    // The migrated store has the data and full schema
    const project = await store.projects.get('proj-1');
    assert.equal(project?.goal, 'Legacy');
    store.close();
  });
});

test('safety copy creation failure blocks forward migration and leaves database unmodified', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');

    // Seed non-empty v0 database
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      INSERT INTO projects (id, document) VALUES ('proj-original', '{"id":"proj-original"}');
    `);
    assert.equal(getSchemaVersion(seedDb), 0);
    seedDb.close();

    // Attempt to open with a failing safety copy creator
    let thrownError: unknown;
    try {
      new SqliteStore({
        filename: dbPath,
        createSafetyCopy: () => {
          throw new Error('Disk full: simulated safety copy failure');
        },
      });
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError instanceof MigrationSafetyCopyError, 'must throw MigrationSafetyCopyError');
    assert.equal(thrownError.name, 'MigrationSafetyCopyError');
    assert.equal(thrownError.fromVersion, 0);
    assert.equal(thrownError.toVersion, 1);
    assert.ok(thrownError.guidance.includes('refused to migrate'));
    assert.ok(thrownError.guidance.includes('disk space'));

    // Check database file: must still be at version 0, no tables added
    const verifyDb = new DatabaseSync(dbPath);
    assert.equal(getSchemaVersion(verifyDb), 0, 'database version must remain 0');
    const tables = verifyDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as unknown as readonly { readonly name: string }[];
    assert.equal(tables.length, 1, 'no extra tables should have been created');
    verifyDb.close();
  });
});

test('forward migration is transactional: failure rolls back and preserves safety copy', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const safetyPath = defaultSafetyCopyPath(dbPath);

    // Seed non-empty v1 database
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      INSERT INTO projects (id, document) VALUES ('p1', '{"id":"p1"}');
    `);
    seedDb.close();

    const failingMigrations: readonly MigrationStep[] = [
      {
        fromVersion: 1,
        toVersion: 2,
        name: 'failing_step',
        migrate: (db) => {
          db.exec('CREATE TABLE test_table (id TEXT);');
          // Intentionally throw in migration
          throw new Error('Simulated SQL migration failure');
        },
      },
    ];

    let thrownError: unknown;
    try {
      new SqliteStore({
        filename: dbPath,
        targetSchemaVersion: 2,
        supportedSchemaRange: { min: 1, max: 2, current: 2 },
        migrations: failingMigrations,
      });
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError instanceof SchemaMigrationError, 'must throw SchemaMigrationError');
    assert.equal(thrownError.name, 'SchemaMigrationError');
    assert.equal(thrownError.fromVersion, 1);
    assert.equal(thrownError.toVersion, 2);
    assert.ok(thrownError.guidance.includes('rolled back'));
    assert.ok(thrownError.guidance.includes('pre-migration safety copy'));

    // Safety copy must be preserved
    assert.equal(existsSync(safetyPath), true, 'safety copy must remain on disk');

    // Database must be rolled back to version 1 and test_table must not exist
    const verifyDb = new DatabaseSync(dbPath);
    assert.equal(getSchemaVersion(verifyDb), 1, 'database version must be rolled back to 1');
    const testTable = verifyDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_table'")
      .get();
    assert.equal(testTable, undefined, 'rolled back migration must not leave new tables');
    verifyDb.close();
  });
});

test('multi-step forward migration executes transactionally from v1 to v3', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const safetyPath = defaultSafetyCopyPath(dbPath);

    // Seed v1 database
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      INSERT INTO projects (id, document) VALUES ('p1', '{"name":"initial"}');
    `);
    seedDb.close();

    const customMigrations: readonly MigrationStep[] = [
      {
        fromVersion: 1,
        toVersion: 2,
        name: 'step_1_to_2',
        migrate: (db) => {
          db.exec('ALTER TABLE projects ADD COLUMN version_tag INTEGER DEFAULT 2;');
        },
      },
      {
        fromVersion: 2,
        toVersion: 3,
        name: 'step_2_to_3',
        migrate: (db) => {
          db.exec('CREATE TABLE migration_meta (key TEXT PRIMARY KEY, val TEXT);');
          db.exec("INSERT INTO migration_meta VALUES ('migrated_to', '3');");
        },
      },
    ];

    const store = new SqliteStore({
      filename: dbPath,
      targetSchemaVersion: 3,
      supportedSchemaRange: { min: 1, max: 3, current: 3 },
      migrations: customMigrations,
    });

    assert.equal(store.schemaVersion, 3);
    assert.equal(getSchemaVersion(store.db), 3);
    assert.equal(existsSync(safetyPath), true);

    const meta = store.db.prepare("SELECT val FROM migration_meta WHERE key = 'migrated_to'").get() as { val: string };
    assert.equal(meta.val, '3');
    store.close();

    // Reopening at v3 does not re-migrate
    const reopened = new SqliteStore({
      filename: dbPath,
      targetSchemaVersion: 3,
      supportedSchemaRange: { min: 1, max: 3, current: 3 },
      migrations: customMigrations,
    });
    assert.equal(reopened.schemaVersion, 3);
    reopened.close();
  });
});

test('newer schema version is refused with sanitized host-local guidance', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');

    // Create database with schema version 2 (newer than current max supported 1)
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      PRAGMA user_version = 2;
      CREATE TABLE future_table (id TEXT PRIMARY KEY);
      INSERT INTO future_table VALUES ('fut-1');
    `);
    seedDb.close();

    let thrownError: unknown;
    try {
      new SqliteStore({ filename: dbPath });
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError instanceof SchemaTooNewError, 'must throw SchemaTooNewError');
    assert.equal(thrownError.name, 'SchemaTooNewError');
    assert.equal(thrownError.version, 2);
    assert.deepEqual(thrownError.supportedRange, SUPPORTED_SCHEMA_RANGE);
    assert.ok(thrownError.message.includes('newer than supported range'));
    assert.ok(thrownError.guidance.includes('upgrade Sprout'));

    // Standalone domain stores also refuse the newer version
    assert.throws(
      () => new SqliteRunStore({ filename: dbPath }),
      (err: unknown) => err instanceof SchemaTooNewError && err.version === 2,
    );
    assert.throws(
      () => new SqliteTaskStore({ filename: dbPath }),
      (err: unknown) => err instanceof SchemaTooNewError && err.version === 2,
    );
  });
});

test('too-old schema version is refused with sanitized host-local guidance', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');

    // Create database with schema version 0 and require min version 2 with no 0->2 migration
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      PRAGMA user_version = 0;
      CREATE TABLE ancient_table (id TEXT PRIMARY KEY);
    `);
    seedDb.close();

    let thrownError: unknown;
    try {
      new SqliteStore({
        filename: dbPath,
        targetSchemaVersion: 2,
        supportedSchemaRange: { min: 2, max: 2, current: 2 },
        migrations: [],
      });
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError instanceof SchemaTooOldError, 'must throw SchemaTooOldError');
    assert.equal(thrownError.name, 'SchemaTooOldError');
    assert.equal(thrownError.version, 0);
    assert.ok(thrownError.message.includes('older than supported range'));
    assert.ok(thrownError.guidance.includes('intermediate Sprout release'));
  });
});

test('path sanitization strips user home directories and keeps relative paths', () => {
  assert.equal(sanitizePath(':memory:'), ':memory:');
  assert.equal(sanitizePath(''), '');

  // Inside working directory -> relative path
  const localDb = join(process.cwd(), 'data', 'sprout.db');
  assert.equal(sanitizePath(localDb), 'data/sprout.db');

  // Home path sanitization
  const home = process.env.HOME || '/Users/exampleuser';
  const homePath = `${home}/some/deep/sprout.db`;
  const sanitizedHome = sanitizePath(homePath);
  assert.ok(sanitizedHome.startsWith('~/'), `sanitized path should start with ~/, got: ${sanitizedHome}`);
  assert.ok(!sanitizedHome.includes('exampleuser'));

  // Generic /Users/<user> path
  const macPath = '/Users/alice/Library/Application Support/sprout.db';
  const sanitizedMac = sanitizePath(macPath);
  assert.ok(sanitizedMac.startsWith('~/Library'), `got: ${sanitizedMac}`);
  assert.ok(!sanitizedMac.includes('alice'));

  // Linux /home/<user> path
  const linuxPath = '/home/bob/sprout/sprout.db';
  const sanitizedLinux = sanitizePath(linuxPath);
  assert.ok(sanitizedLinux.startsWith('~/sprout'), `got: ${sanitizedLinux}`);
  assert.ok(!sanitizedLinux.includes('bob'));

  // Windows path
  const winPath = 'C:\\Users\\charlie\\AppData\\sprout.db';
  const sanitizedWin = sanitizePath(winPath);
  assert.ok(sanitizedWin.startsWith('~/AppData'), `got: ${sanitizedWin}`);
  assert.ok(!sanitizedWin.includes('charlie'));
});

test('existing safety copy is replaced by the newest pre-migration safety copy', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const safetyPath = defaultSafetyCopyPath(dbPath);

    // Write a stale safety copy file
    writeFileSync(safetyPath, 'stale old safety copy data');

    // Create a non-empty v0 database
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      INSERT INTO projects (id, document) VALUES ('proj-newest', '{"state":"fresh"}');
    `);
    seedDb.close();

    // Migrate from v0 to v1
    const store = new SqliteStore({ filename: dbPath });
    assert.equal(store.schemaVersion, 1);
    store.close();

    // Safety copy was replaced with a valid SQLite database
    const copyDb = new DatabaseSync(safetyPath);
    assert.equal(getSchemaVersion(copyDb), 0);
    const row = copyDb.prepare('SELECT document FROM projects WHERE id = ?').get('proj-newest') as { document: string };
    assert.equal(JSON.parse(row.document).state, 'fresh');
    copyDb.close();
  });
});
