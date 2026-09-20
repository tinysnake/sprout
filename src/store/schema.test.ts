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
import { SqliteRunStore, SqliteSessionKeyStore } from '../run/sqlite-store.ts';
import { SqliteLeaseStore } from '../environment/sqlite-store.ts';
import { SqliteProjectStore } from '../project/sqlite-store.ts';
import { SqliteTaskStore } from '../task/sqlite-store.ts';
import { SqliteCollaborationStore } from '../collaboration/sqlite-store.ts';
import { BROWSER_SESSION_ABSOLUTE_LIFETIME_MS, BROWSER_SESSION_IDLE_LIFETIME_MS } from '../auth/session-policy.ts';

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-schema-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}

test('schema constants declare supported version range', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 7);
  assert.equal(MIN_SUPPORTED_SCHEMA_VERSION, 0);
  assert.equal(MAX_SUPPORTED_SCHEMA_VERSION, 7);
  assert.deepEqual(SUPPORTED_SCHEMA_RANGE, {
    min: 0,
    max: 7,
    current: 7,
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

    // Open through SqliteStore, triggering the supported v0 -> current migration chain.
    const store = new SqliteStore({ filename: dbPath });
    assert.equal(store.schemaVersion, 7);
    assert.equal(getSchemaVersion(store.db), 7);

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

test('v2 browser sessions receive persisted finite absolute and idle deadlines during migration', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const createdAt = 10_000;
    const lastSeenAt = 20_000;
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA user_version = 2;
      CREATE TABLE browser_sessions (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL,
        credential_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL, revoked_at INTEGER
      );
    `);
    legacy.prepare(`INSERT INTO browser_sessions
      (id, token_hash, csrf_hash, credential_version, created_at, last_seen_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`).run('legacy-session', 'digest-a', 'digest-b', 1, createdAt, lastSeenAt);
    legacy.close();

    const store = new SqliteStore({ filename: dbPath });
    const row = store.db.prepare(`SELECT absolute_expires_at, idle_expires_at FROM browser_sessions WHERE id = 'legacy-session'`)
      .get() as { absolute_expires_at: number; idle_expires_at: number };
    assert.equal(row.absolute_expires_at, createdAt + BROWSER_SESSION_ABSOLUTE_LIFETIME_MS);
    assert.equal(row.idle_expires_at, Math.min(
      lastSeenAt + BROWSER_SESSION_IDLE_LIFETIME_MS,
      createdAt + BROWSER_SESSION_ABSOLUTE_LIFETIME_MS,
    ));
    store.close();
  });
});

test('v3 run history receives a transactional durable replay order before serving', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const safetyPath = defaultSafetyCopyPath(dbPath);
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA user_version = 3;
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, prompt TEXT NOT NULL,
        environment_instance_id TEXT NOT NULL, status TEXT NOT NULL,
        events TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO agent_runs VALUES ('run-b', 'agent', 'b', 'environment', 'completed', '[]', 1000);
      INSERT INTO agent_runs VALUES ('run-a', 'agent', 'a', 'environment', 'completed', '[]', 1000);
    `);
    legacy.close();

    const store = new SqliteStore({ filename: dbPath });
    assert.equal(store.schemaVersion, 7);
    const replayRows = store.db.prepare(
      'SELECT id, replay_sequence FROM agent_runs ORDER BY replay_sequence ASC',
    ).all() as unknown as readonly { id: string; replay_sequence: number }[];
    assert.deepEqual(
      replayRows.map((row) => [row.id, row.replay_sequence]),
      [['run-a', 1], ['run-b', 2]],
    );
    store.close();

    assert.equal(existsSync(safetyPath), true);
    const safety = new DatabaseSync(safetyPath);
    assert.equal(getSchemaVersion(safety), 3);
    const columns = safety.prepare('PRAGMA table_info(agent_runs)').all() as unknown as readonly { name: string }[];
    assert.equal(columns.some((column) => column.name === 'replay_sequence'), false);
    safety.close();
  });
});

test('v4 store receives the Environment enrollment and readiness tables transactionally', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const safetyPath = defaultSafetyCopyPath(dbPath);
    // A realistic v4 store carries the operator authority boundary this build
    // migrated to just before enrollment. It is non-empty, so the migration must
    // create a safety copy before adding the new tables.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA user_version = 4;
      CREATE TABLE operator_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        credential_hash TEXT NOT NULL, credential_salt TEXT NOT NULL,
        version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO operator_identity VALUES (1, 'hash', 'salt', 1, 10, 10);
    `);
    legacy.close();

    const store = new SqliteStore({ filename: dbPath });
    assert.equal(store.schemaVersion, 7);

    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as unknown as readonly { readonly name: string }[];
    assert.ok(tables.some((table) => table.name === 'environment_enrollments'));
    assert.ok(tables.some((table) => table.name === 'environment_readiness'));
    assert.ok(tables.some((table) => table.name === 'environment_probes'));

    // The pre-existing authority row is preserved by the forward migration.
    const operator = store.db.prepare('SELECT version FROM operator_identity WHERE singleton = 1').get() as { version: number };
    assert.equal(operator.version, 1);
    store.close();

    // The pre-migration safety copy remains at v4 without the new tables.
    assert.equal(existsSync(safetyPath), true);
    const safety = new DatabaseSync(safetyPath);
    assert.equal(getSchemaVersion(safety), 4);
    const safetyTables = safety
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'environment_enrollments'")
      .get();
    assert.equal(safetyTables, undefined);
    safety.close();
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
    assert.equal(thrownError.toVersion, 7);
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

    // Create a database newer than the current maximum.
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      PRAGMA user_version = 8;
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
    assert.equal(thrownError.version, 8);
    assert.deepEqual(thrownError.supportedRange, SUPPORTED_SCHEMA_RANGE);
    assert.ok(thrownError.message.includes('newer than supported range'));
    assert.ok(thrownError.guidance.includes('upgrade Sprout'));

    // Standalone domain stores also refuse the newer version
    assert.throws(
      () => new SqliteRunStore({ filename: dbPath }),
      (err: unknown) => err instanceof SchemaTooNewError && err.version === 8,
    );
    assert.throws(
      () => new SqliteTaskStore({ filename: dbPath }),
      (err: unknown) => err instanceof SchemaTooNewError && err.version === 8,
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
  assert.equal(sanitizedHome, '<home-path>');
  assert.ok(!sanitizedHome.includes('exampleuser'));

  // Generic /Users/<user> path
  const macPath = '/Users/alice/Library/Application Support/sprout.db';
  const sanitizedMac = sanitizePath(macPath);
  assert.equal(sanitizedMac, '<home-path>');
  assert.ok(!sanitizedMac.includes('alice'));

  // Linux /home/<user> path
  const linuxPath = '/home/bob/sprout/sprout.db';
  const sanitizedLinux = sanitizePath(linuxPath);
  assert.equal(sanitizedLinux, '<home-path>');
  assert.ok(!sanitizedLinux.includes('bob'));

  // Windows path
  const winPath = 'C:\\Users\\charlie\\AppData\\sprout.db';
  const sanitizedWin = sanitizePath(winPath);
  assert.equal(sanitizedWin, '<home-path>');
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

    // Migrate from v0 to the current schema.
    const store = new SqliteStore({ filename: dbPath });
    assert.equal(store.schemaVersion, 7);
    store.close();

    // Safety copy was replaced with a valid SQLite database
    const copyDb = new DatabaseSync(safetyPath);
    assert.equal(getSchemaVersion(copyDb), 0);
    const row = copyDb.prepare('SELECT document FROM projects WHERE id = ?').get('proj-newest') as { document: string };
    assert.equal(JSON.parse(row.document).state, 'fresh');
    copyDb.close();
  });
});

test('failed safety copy replacement preserves the prior valid safety copy (M77-SCHEMA-001)', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const safetyPath = defaultSafetyCopyPath(dbPath);

    // Create a valid previous safety copy at v0 with specific data
    const priorCopyDb = new DatabaseSync(safetyPath);
    priorCopyDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      INSERT INTO projects (id, document) VALUES ('proj-prior', '{"name":"prior-valid-copy"}');
    `);
    priorCopyDb.close();

    // Create a non-empty v0 database
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      INSERT INTO projects (id, document) VALUES ('proj-new', '{"name":"new-store-data"}');
    `);
    seedDb.close();

    // Attempt migration with a failing safety copy creator (simulating failure during replacement)
    assert.throws(
      () =>
        new SqliteStore({
          filename: dbPath,
          createSafetyCopy: () => {
            throw new Error('Disk full during vacuum snapshot');
          },
        }),
      (err: unknown) => err instanceof MigrationSafetyCopyError,
    );

    // Prior safety copy must NOT have been destroyed or unlinked!
    assert.equal(existsSync(safetyPath), true, 'prior safety copy must be preserved');
    const verifyCopyDb = new DatabaseSync(safetyPath);
    const copyRow = verifyCopyDb.prepare('SELECT document FROM projects WHERE id = ?').get('proj-prior') as { document: string } | undefined;
    assert.ok(copyRow, 'prior safety copy data must remain readable');
    assert.equal(JSON.parse(copyRow.document).name, 'prior-valid-copy');
    verifyCopyDb.close();

    // Original database must remain at v0 untouched
    const verifyDb = new DatabaseSync(dbPath);
    assert.equal(getSchemaVersion(verifyDb), 0);
    verifyDb.close();
  });
});

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
    seedFuture.exec('PRAGMA user_version = 8; CREATE TABLE dummy (id TEXT);');
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
