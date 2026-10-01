import { test } from 'node:test';

import assert from 'node:assert/strict';import { existsSync, mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';import { CURRENT_SCHEMA_VERSION, MIN_SUPPORTED_SCHEMA_VERSION, MAX_SUPPORTED_SCHEMA_VERSION, SUPPORTED_SCHEMA_RANGE, SchemaMigrationError, migrateOrInitializeDatabase, getSchemaVersion, defaultSafetyCopyPath, type MigrationStep } from './schema.ts';

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
  assert.equal(CURRENT_SCHEMA_VERSION, 26);
  assert.equal(MIN_SUPPORTED_SCHEMA_VERSION, 0);
  assert.equal(MAX_SUPPORTED_SCHEMA_VERSION, 26);
  assert.deepEqual(SUPPORTED_SCHEMA_RANGE, {
    min: 0,
    max: 26,
    current: 26,
  });
});

test('v21 migration creates usage_activities and usage_observations tables', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'sprout.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE dummy (id TEXT PRIMARY KEY);
      PRAGMA user_version = 21;
    `);
    legacy.close();

    const store = new SqliteStore({ filename: path });
    try {
      assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_activities'").get());
      assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_observations'").get());
    } finally {
      store.close();
    }
  });
});

test('v20 duplicate routing attempts migrate without losing calls or granting a fresh retry', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'sprout.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA user_version = 20;
      CREATE TABLE collaboration_routing_attempts (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
        model_id TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
        status TEXT NOT NULL, error_kind TEXT, error_detail TEXT
      );
      INSERT INTO collaboration_routing_attempts VALUES
        ('first', 'batch-a', 1, 'model', 10, 11, 'failed', 'timeout', 'first failure'),
        ('second', 'batch-a', 1, 'model', 12, 13, 'failed', 'timeout', 'second failure'),
        ('third', 'batch-a', 2, 'model', 14, 15, 'failed', 'timeout', 'third failure'),
        ('other', 'batch-b', 1, 'model', 10, 11, 'failed', 'timeout', 'other failure');
    `);
    legacy.close();

    const store = new SqliteStore({ filename: path });
    try {
      assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
      const attempts = await store.collaboration.listRoutingAttempts('batch-a');
      assert.deepEqual(attempts.map((attempt) => [attempt.id, attempt.attemptNumber, attempt.errorDetail]), [
        ['first', 1, 'first failure'], ['second', 2, 'second failure'], ['third', 3, 'third failure'],
      ]);
      assert.equal(attempts.length > 2, true, 'all spent calls remain visible to recovery');
      assert.deepEqual((await store.collaboration.listRoutingAttempts('batch-b')).map((attempt) => attempt.attemptNumber), [1]);
      assert.throws(() => store.db.prepare(`INSERT INTO collaboration_routing_attempts
        (id, batch_id, attempt_number, model_id, started_at, finished_at, status)
        VALUES ('duplicate', 'batch-a', 2, 'model', 16, 17, 'started')`).run());
    } finally { store.close(); }

    const reopened = new SqliteStore({ filename: path });
    try {
      assert.equal((await reopened.collaboration.listRoutingAttempts('batch-a')).length, 3);
    } finally { reopened.close(); }
  });
});

test('v17 recovery migration makes a safety copy and preserves v16 run rows without invented proof', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'sprout.db');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, prompt TEXT NOT NULL,
      environment_instance_id TEXT NOT NULL, project_id TEXT, task_id TEXT,
      status TEXT NOT NULL, events TEXT NOT NULL, lease_id TEXT,
      failure TEXT, result TEXT, created_at INTEGER NOT NULL,
      completed_at INTEGER, hand_off TEXT, token_usage TEXT,
      replay_sequence INTEGER, work_option TEXT, configuration_version INTEGER,
      workspace_binding TEXT
    );
    INSERT INTO agent_runs (id, agent_id, prompt, environment_instance_id, status, events, created_at)
      VALUES ('legacy-run', 'agent', 'old prompt', 'instance', 'failed', '[]', 1);
    PRAGMA user_version = 16;`);
    db.close();
    const store = new SqliteStore({ filename: path });
    try {
      assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(existsSync(defaultSafetyCopyPath(path)), true);
      const run = await store.runs.get('legacy-run');
      assert.equal(run?.recoverySettlement, undefined);
      assert.equal(run?.recoveredEvents, undefined);
      assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'worker_recovery_receipts'").get());
    } finally { store.close(); }
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
    assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
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

// Seed the actual v25 schema, not a hand-built approximation of its columns.
async function withV25Usage(fn: (path: string, legacy: DatabaseSync) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const path = join(dir, 'usage.db');
    const seed = new DatabaseSync(path);
    seed.exec('CREATE TABLE legacy_marker (id TEXT); PRAGMA user_version = 24;');
    seed.close();
    const legacy = new DatabaseSync(path);
    migrateOrInitializeDatabase(legacy, { filename: path, targetVersion: 25 });
    try {
      legacy.exec(`INSERT INTO usage_activities
        (id, kind, attempt_id, batch_id, project_id, engine, model, status, created_at, settled_at)
        VALUES ('routing', 'routing_attempt', 'attempt', 'batch', 'project', 'routing', 'wake', 'completed', 1, 2);
        INSERT INTO usage_observations
        (id, activity_id, observed_at, source, source_version, completeness, wall_duration_ms,
         billed_cost_status, cost_estimate_status, cost_estimate_usd_micros, valuation_provenance, billing_basis)
        VALUES ('observation', 'routing', 2, 'routing', '1', 'unavailable', 1,
          'unavailable', 'available', 0, 'provider_estimated', 'unknown');`);
      await fn(path, legacy);
    } finally { legacy.close(); }
  });
}

for (const [shape, mutation, reason] of [
  ['Routing ownership', "UPDATE usage_activities SET agent_id = 'agent', task_id = 'task'", 'Invalid legacy usage activity attribution'],
  ['available cost without facts', 'UPDATE usage_observations SET cost_estimate_usd_micros = NULL, valuation_provenance = NULL', 'Invalid legacy usage observation cost facts'],
] as const) {
  test(`v25 migration rejects ${shape} without rewriting durable facts`, async () => {
    await withV25Usage(async (path, legacy) => {
      legacy.exec(mutation);
      const before = legacy.prepare('SELECT * FROM usage_activities').all();
      const observations = legacy.prepare('SELECT * FROM usage_observations').all();
      let refusal: unknown;
      try {
        const upgraded = new SqliteStore({ filename: path });
        upgraded.close();
      } catch (error) { refusal = error; }
      if (refusal === undefined) {
        const reopened = new SqliteStore({ filename: path });
        try {
          if (shape === 'Routing ownership') {
            await reopened.usage.listActivities();
          } else {
            const aggregate = await reopened.usage.getAggregate({});
            assert.equal(aggregate.costCoverage.available, 0, 'missing cost facts must not count as available');
          }
        } finally { reopened.close(); }
      }
      assert.ok(refusal instanceof SchemaMigrationError && refusal.guidance.includes(reason), 'invalid facts must refuse migration with actionable guidance');
      // Reopen the rejected database: the schema, rows, and safety copy remain v25.
      const retained = new DatabaseSync(path);
      try {
        assert.equal(getSchemaVersion(retained), 25);
        assert.deepEqual(retained.prepare('SELECT * FROM usage_activities').all(), before);
        assert.deepEqual(retained.prepare('SELECT * FROM usage_observations').all(), observations);
        assert.equal(retained.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_activity_attribution_insert'").get(), undefined);
      } finally { retained.close(); }
      const safety = new DatabaseSync(defaultSafetyCopyPath(path));
      try { assert.equal(getSchemaVersion(safety), 25); } finally { safety.close(); }
    });
  });
}

test('valid v25 usage migrates unchanged and reads truthfully after reopen', async () => {
  await withV25Usage(async (path, legacy) => {
    const before = legacy.prepare('SELECT * FROM usage_activities').all();
    const observations = legacy.prepare('SELECT * FROM usage_observations').all();
    const upgraded = new SqliteStore({ filename: path });
    upgraded.close();
    const reopened = new SqliteStore({ filename: path });
    try {
      assert.deepEqual(reopened.db.prepare('SELECT * FROM usage_activities').all(), before);
      assert.deepEqual(reopened.db.prepare('SELECT * FROM usage_observations').all(), observations);
      assert.equal((await reopened.usage.listActivities()).length, 1);
      const aggregate = await reopened.usage.getAggregate({});
      assert.deepEqual(aggregate.costCoverage, { available: 1, pending: 0, unavailable: 0 });
      assert.equal(aggregate.cost.apiEquivalentUsdMicros, 0);
    } finally { reopened.close(); }
  });
});

test('v26 migration triggers reject unreadable Agent-run attribution on insert and update', async () => {
  await withV25Usage(async (path) => {
    const store = new SqliteStore({ filename: path });
    try {
      let insertError: unknown;
      try {
        store.db.prepare(`INSERT INTO usage_activities
          (id, kind, run_id, agent_id, engine, model, status, created_at)
          VALUES ('raw-invalid-run', 'agent_run', 'valid-run', NULL, 'pi', 'model', 'completed', 3)`).run();
      } catch (error) { insertError = error; }
      if (insertError === undefined) {
        await assert.rejects(store.usage.listActivities(), /Invalid usage activity attribution/);
      }
      assert.ok(insertError !== undefined, 'raw v26 insert must reject an Agent run without a nonempty agent_id');
      assert.match(String(insertError), /invalid usage activity attribution/i);
      assert.equal((await store.usage.listActivities()).length, 1, 'a rejected write leaves existing activity reads clean');

      // Seed an invalid preexisting row solely to exercise the UPDATE trigger independently.
      store.db.exec('DROP TRIGGER usage_activity_attribution_insert');
      store.db.prepare(`INSERT INTO usage_activities
        (id, kind, run_id, agent_id, engine, model, status, created_at)
        VALUES ('raw-invalid-update', 'agent_run', 'update-run', NULL, 'pi', 'model', 'completed', 4)`).run();
      assert.throws(
        () => store.db.prepare("UPDATE usage_activities SET status = 'active' WHERE id = 'raw-invalid-update'").run(),
        /invalid usage activity attribution/i,
      );
      store.db.prepare("DELETE FROM usage_activities WHERE id = 'raw-invalid-update'").run();
      assert.equal((await store.usage.listActivities()).length, 1);
    } finally { store.close(); }
  });
});

test('v26 migration cost triggers reject fractional available amounts on insert and update', async () => {
  await withV25Usage(async (path) => {
    const store = new SqliteStore({ filename: path });
    try {
      await store.usage.recordActivity({
        id: 'fractional-cost-activity', kind: 'agent_run',
        correlation: { runId: 'fractional-cost-run', agentId: 'agent' },
        engine: 'pi', model: 'model', status: 'completed', createdAt: 10, settledAt: 20,
      });
      const insert = (
        id: string,
        estimateStatus: 'available' | 'unavailable', estimate: number | null,
        billedStatus: 'available' | 'unavailable', billed: number | null,
      ) => store.db.prepare(`INSERT INTO usage_observations
        (id, activity_id, observed_at, source, source_version, completeness, wall_duration_ms,
         billed_cost_status, billed_usd_micros, cost_estimate_status, cost_estimate_usd_micros,
         valuation_provenance, billing_basis)
        VALUES (?, 'fractional-cost-activity', 20, 'raw-test', '1', 'complete', 10, ?, ?, ?, ?, ?, 'unknown')`)
        .run(id, billedStatus, billed, estimateStatus, estimate, estimateStatus === 'available' ? 'provider_estimated' : null);

      let insertError: unknown;
      try { insert('fractional-estimate-insert', 'available', 0.5, 'unavailable', null); }
      catch (error) { insertError = error; }
      if (insertError === undefined) {
        const aggregate = await store.usage.getAggregate({});
        assert.equal(aggregate.cost.apiEquivalentUsdMicros, 0.5, 'fractional raw estimate is exported by aggregation');
      }
      assert.ok(insertError !== undefined, 'v26 trigger must reject fractional available estimates');
      assert.match(String(insertError), /invalid usage observation cost facts/i);

      insert('integer-estimate-update', 'available', 2, 'unavailable', null);
      assert.throws(
        () => store.db.prepare("UPDATE usage_observations SET cost_estimate_usd_micros = 0.5 WHERE id = 'integer-estimate-update'").run(),
        /invalid usage observation cost facts/i,
      );
      assert.throws(
        () => insert('fractional-bill-insert', 'unavailable', null, 'available', 0.5),
        /invalid usage observation cost facts/i,
      );
      insert('integer-bill-update', 'unavailable', null, 'available', 2);
      assert.throws(
        () => store.db.prepare("UPDATE usage_observations SET billed_usd_micros = 0.5 WHERE id = 'integer-bill-update'").run(),
        /invalid usage observation cost facts/i,
      );
    } finally { store.close(); }
  });
});
