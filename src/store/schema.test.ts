import { test } from 'node:test';

import assert from 'node:assert/strict';import { existsSync, mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';import { CURRENT_SCHEMA_VERSION, MIN_SUPPORTED_SCHEMA_VERSION, MAX_SUPPORTED_SCHEMA_VERSION, SUPPORTED_SCHEMA_RANGE, SchemaMigrationError, getSchemaVersion, defaultSafetyCopyPath, type MigrationStep } from './schema.ts';

import { SqliteStore } from './db.ts';

import { BROWSER_SESSION_ABSOLUTE_LIFETIME_MS, BROWSER_SESSION_IDLE_LIFETIME_MS } from '../auth/session-policy.ts';

import { WorkerConnectionRegistry } from '../environment/worker-epoch.ts';

import { ADMISSION_CAPABILITY, projectCatalogEntry } from '../environment/catalog.ts';

import { createPendingEnrollment } from '../environment/enrollment.ts';

import { SUPPORTED_WORKER_PROTOCOL } from '../environment/enrollment-service.ts';


function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-schema-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}


test('schema constants declare supported version range', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 16);
  assert.equal(MIN_SUPPORTED_SCHEMA_VERSION, 0);
  assert.equal(MAX_SUPPORTED_SCHEMA_VERSION, 16);
  assert.deepEqual(SUPPORTED_SCHEMA_RANGE, {
    min: 0,
    max: 16,
    current: 16,
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


test('v12 migration seeds epoch high-water and instance enrollment authority before reconnect', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const staleReadiness = {
      enrollmentId: 'enrollment-a',
      connectionEpoch: 7,
      connection: { state: 'online' as const, lastConfirmedAt: 1 },
      compatibility: { state: 'compatible' as const, workerProtocolVersion: '2' },
      engines: [{
        engine: 'scripted',
        installed: true,
        readiness: 'ready' as const,
        required: true,
        models: { state: 'available' as const, models: ['scripted-model'] },
      }],
    };
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA user_version = 12;
      CREATE TABLE environment_enrollments (
        id TEXT PRIMARY KEY,
        environment_instance_id TEXT NOT NULL,
        document TEXT NOT NULL
      );
      CREATE TABLE environment_readiness (
        environment_instance_id TEXT PRIMARY KEY,
        document TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.prepare(
      'INSERT INTO environment_enrollments (id, environment_instance_id, document) VALUES (?, ?, ?)',
    ).run('enrollment-a', 'instance-a', '{}');
    legacy.prepare(
      'INSERT INTO environment_readiness (environment_instance_id, document, updated_at) VALUES (?, ?, ?)',
    ).run('instance-a', JSON.stringify(staleReadiness), 1);
    legacy.close();

    const store = new SqliteStore({ filename: dbPath });
    assert.equal(store.schemaVersion, 16);
    const seeded = store.db.prepare(
      'SELECT high_water FROM worker_connection_epochs WHERE enrollment_id = ?',
    ).get('enrollment-a') as { readonly high_water: number } | undefined;
    assert.equal(seeded?.high_water, 7, 'migration carries forward persisted epoch evidence');
    const authority = store.db.prepare(
      'SELECT enrollment_id FROM environment_instance_enrollment_authority WHERE environment_instance_id = ?',
    ).get('instance-a') as { readonly enrollment_id: string } | undefined;
    assert.equal(authority?.enrollment_id, 'enrollment-a', 'v14 reserves the existing enrollment authority');

    const workerEpochs = new WorkerConnectionRegistry({
      store: store.workerConnectionEpochs,
      idFactory: () => 'connection-after-upgrade',
    });
    const firstPostUpgrade = workerEpochs.accept('enrollment-a');
    assert.equal(firstPostUpgrade.epoch, 8, 'the first post-upgrade epoch is strictly newer');
    assert.notEqual(firstPostUpgrade.epoch, 7, 'persisted readiness can never match the new connection');

    const enrollment = {
      ...createPendingEnrollment({
        id: 'enrollment-a',
        environmentInstanceId: 'instance-a',
        displayName: 'Environment A',
        identityDigest: 'identity-a',
        platform: 'macos',
        capabilityRequests: [ADMISSION_CAPABILITY],
        engineFacts: [],
        at: 1,
      }),
      status: 'approved' as const,
      everApproved: true,
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    };
    const persistedReadiness = await store.environmentReadiness.getReadiness('instance-a');
    assert.ok(persistedReadiness !== undefined);
    assert.equal(projectCatalogEntry({
      enrollment,
      observed: persistedReadiness,
      currentEpoch: firstPostUpgrade.epoch,
      workSafety: 'clear',
      requiredEngines: ['scripted'],
      supportedProtocol: SUPPORTED_WORKER_PROTOCOL,
      now: 1,
    }).eligible, false, 'stale v12 readiness cannot admit the new connection');
    assert.equal(projectCatalogEntry({
      enrollment,
      observed: { ...staleReadiness, connectionEpoch: firstPostUpgrade.epoch },
      currentEpoch: firstPostUpgrade.epoch,
      workSafety: 'clear',
      requiredEngines: ['scripted'],
      supportedProtocol: SUPPORTED_WORKER_PROTOCOL,
      now: 1,
    }).eligible, true, 'only fresh readiness from the post-upgrade connection can admit');
    store.close();
  });
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
    assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(getSchemaVersion(store.db), CURRENT_SCHEMA_VERSION);

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
    assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
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
    assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);

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


test('v9 run history receives workspace_binding through the versioned safety-copy migration', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const safetyPath = defaultSafetyCopyPath(dbPath);
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA user_version = 9;
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, prompt TEXT NOT NULL,
        environment_instance_id TEXT NOT NULL, status TEXT NOT NULL,
        events TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO agent_runs VALUES ('run-legacy', 'agent', 'hi', 'env', 'completed', '[]', 1);
    `);
    legacy.close();

    const store = new SqliteStore({ filename: dbPath });
    assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
    const columns = store.db.prepare('PRAGMA table_info(agent_runs)').all() as unknown as readonly { name: string }[];
    assert.equal(columns.some((column) => column.name === 'workspace_binding'), true);
    assert.equal(
      (store.db.prepare("SELECT id FROM agent_runs WHERE id = 'run-legacy'").get() as { id: string }).id,
      'run-legacy',
      'the migration adds the column without replacing existing run rows',
    );
    store.close();

    const safety = new DatabaseSync(safetyPath);
    assert.equal(getSchemaVersion(safety), 9);
    const safetyColumns = safety.prepare('PRAGMA table_info(agent_runs)').all() as unknown as readonly { name: string }[];
    assert.equal(safetyColumns.some((column) => column.name === 'workspace_binding'), false);
    safety.close();
  });
});


test('a failed workspace_binding migration rolls back the column and preserves its safety copy', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'sprout.db');
    const safetyPath = defaultSafetyCopyPath(dbPath);
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA user_version = 9;
      CREATE TABLE agent_runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      INSERT INTO agent_runs VALUES ('run-legacy', 1);
    `);
    legacy.close();
    const failing: readonly MigrationStep[] = [{
      fromVersion: 9,
      toVersion: 10,
      migrate: (db) => {
        db.exec('ALTER TABLE agent_runs ADD COLUMN workspace_binding TEXT');
        throw new Error('simulated binding migration failure');
      },
    }];

    assert.throws(
      () => new SqliteStore({
        filename: dbPath,
        targetSchemaVersion: 10,
        supportedSchemaRange: { min: 9, max: 10, current: 10 },
        migrations: failing,
      }),
      (error: unknown) => error instanceof SchemaMigrationError,
    );
    const retained = new DatabaseSync(dbPath);
    assert.equal(getSchemaVersion(retained), 9);
    const columns = retained.prepare('PRAGMA table_info(agent_runs)').all() as unknown as readonly { name: string }[];
    assert.equal(columns.some((column) => column.name === 'workspace_binding'), false);
    retained.close();
    const safety = new DatabaseSync(safetyPath);
    assert.equal(getSchemaVersion(safety), 9);
    safety.close();
  });
});
