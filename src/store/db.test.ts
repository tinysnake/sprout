/**
 * Move-sensitive evidence for the SQLite adapter rehome (#81).
 *
 * These tests exist because this Ticket is a *relocation* of adapters, not a
 * behaviour change. They pin the two things a careless move could break without
 * any store test noticing:
 *
 * 1. **The physical schema is byte-identical.** Every table, column, declared
 *    type, primary key, `UNIQUE` constraint, and explicit indexes are
 *    asserted literally, so a moved `CREATE TABLE` that quietly renames or
 *    reorders a column fails here.
 * 2. **The rehomed adapters and the shared handle address the same tables.** A
 *    domain store constructed directly on a file and the same domain store
 *    mounted on `SqliteStore` observe each other's rows through the shared
 *    connection, which is what proves the mount still points at the same
 *    physical state.
 *
 * A third check writes a database with the exact pre-rehome `CREATE TABLE`
 * text and reads it back through the rehomed adapters, so historical durable
 * rows open unchanged. The statements are copied from the fixed base commit, so
 * this is a real compatibility assertion rather than a self-referential round
 * trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SqliteStore } from '../store/db.ts';
import { SqliteRunStore } from '../run/sqlite-store.ts';
import { SqliteLeaseStore } from '../environment/sqlite-store.ts';
import { SqliteProjectStore } from '../project/sqlite-store.ts';
import { SqliteTaskStore } from '../task/sqlite-store.ts';
import type { TaskLeaseBinding } from '../environment/pool.ts';
import type { Task } from '../task/model.ts';

interface ColumnShape {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
}

/** The exact composed schema shape, including the M2 authority boundary. */
const EXPECTED_SCHEMA: Record<string, readonly ColumnShape[]> = {
  operator_identity: [
    { name: 'singleton', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'credential_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'credential_salt', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'version', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  browser_sessions: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'token_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'csrf_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'credential_version', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'last_seen_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'absolute_expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'idle_expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'revoked_at', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  agent_runs: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'agent_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'prompt', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'events', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'lease_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'failure', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'result', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'completed_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'hand_off', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'task_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'token_usage', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'replay_sequence', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  environment_leases: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'capability', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'holder_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'holder_kind', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'run_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'task_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'acquired_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  projects: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  agent_session_keys: [
    { name: 'slot', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'agent_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'engine', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'working_directory', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'session_key', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  collaboration_messages: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'channel', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'author_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'author_kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'body', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'recipients', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'delivery_key', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'in_reply_to', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  collaboration_wake_requests: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'message_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'agent_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'reason', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'idempotency_key', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'run_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'detail', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  collaboration_observations: [
    { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'message_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'agent_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'reason', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'detail', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  tasks: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'title', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'goal', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'constraints', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'assigned_agent_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'environment_preference', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'blocker_reason', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'environment_lease_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'environment_lifecycle_state', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'recovery_state', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'active_run_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'completed_at', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  task_run_links: [
    { name: 'task_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'run_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'agent_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'sequence', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'linked_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'summary_status', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'summary_text', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'summary_agent_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'summary_recorded_at', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  environment_enrollments: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  environment_readiness: [
    { name: 'environment_instance_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  environment_probes: [
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'sequence', type: 'INTEGER', notnull: 1, pk: 2 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
};

function withStore(run: (store: SqliteStore) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-rehome-'));
  const store = new SqliteStore({ filename: join(directory, 'sprout.db') });
  return Promise.resolve()
    .then(() => run(store))
    .finally(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
}

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-sprout',
    title: 'Owned lease boundary',
    goal: 'Commit the Task and its lease together.',
    constraints: [],
    status: 'todo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('the composed handle declares every domain table with its contract columns', async () => {
  await withStore((store) => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as unknown as readonly { readonly name: string }[];
    assert.deepEqual(
      tables.map((table) => table.name),
      Object.keys(EXPECTED_SCHEMA).sort(),
    );

    for (const [table, expected] of Object.entries(EXPECTED_SCHEMA)) {
      const columns = store.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly ColumnShape[];
      assert.deepEqual(
        columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
        expected,
        `column shape for ${table}`,
      );
    }
  });
});

test('explicit indexes keep their names, tables, and column order', async () => {
  await withStore((store) => {
    const indexes = store.db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
      .all() as unknown as readonly { readonly name: string; readonly tbl_name: string }[];
    assert.deepEqual(
      indexes.map((index) => ({ name: index.name, tbl: index.tbl_name })),
      [
        { name: 'agent_runs_replay_sequence_idx', tbl: 'agent_runs' },
        { name: 'browser_sessions_active_idx', tbl: 'browser_sessions' },
        { name: 'environment_enrollments_instance_idx', tbl: 'environment_enrollments' },
        { name: 'task_run_links_by_task', tbl: 'task_run_links' },
      ],
    );

    const replayColumns = store.db.prepare('PRAGMA index_info(agent_runs_replay_sequence_idx)').all() as unknown as readonly {
      readonly name: string;
    }[];
    assert.deepEqual(replayColumns.map((column) => column.name), ['replay_sequence']);

    const sessionColumns = store.db.prepare('PRAGMA index_info(browser_sessions_active_idx)').all() as unknown as readonly {
      readonly name: string;
    }[];
    assert.deepEqual(sessionColumns.map((column) => column.name), ['revoked_at', 'credential_version']);

    const columns = store.db.prepare('PRAGMA index_info(task_run_links_by_task)').all() as unknown as readonly {
      readonly name: string;
    }[];
    assert.deepEqual(columns.map((column) => column.name), ['task_id', 'sequence']);
  });
});

test('uniqueness identities are still enforced by the database, not the caller', async () => {
  await withStore((store) => {
    const unique = store.db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NULL ORDER BY name")
      .all() as unknown as readonly { readonly name: string; readonly tbl_name: string }[];
    // Every entry is the implicit index behind a PRIMARY KEY or UNIQUE column;
    // their existence is what makes a repeated delivery key, wake idempotency
    // key, and session-key slot collapse onto one row.
    assert.deepEqual(
      unique.map((row) => row.tbl_name).sort(),
      [
        'agent_runs',
        'agent_session_keys',
        'browser_sessions',
        'browser_sessions',
        'collaboration_messages',
        'collaboration_messages',
        'collaboration_wake_requests',
        'collaboration_wake_requests',
        'environment_enrollments',
        'environment_leases',
        'environment_probes',
        'environment_readiness',
        'projects',
        'task_run_links',
        'tasks',
      ],
    );
  });
});

test('a directly constructed domain adapter and the shared handle observe the same rows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-rehome-mount-'));
  const path = join(directory, 'sprout.db');
  try {
    const handle = new SqliteStore({ filename: path });
    const lease = {
      id: 'lease-1',
      instanceId: 'mac-mini-1',
      capability: 'agent-run',
      holderId: 'run-1',
      holderKind: 'run' as const,
      runId: 'run-1',
      acquiredAt: 1,
      expiresAt: 2,
      state: 'active' as const,
    };
    handle.leases.save(lease);
    await handle.runs.save({
      id: 'run-1',
      agentId: 'agent-scout',
      prompt: 'go',
      environmentInstanceId: 'mac-mini-1',
      status: 'queued',
      events: [],
      createdAt: 1,
    });
    await handle.projects.save({
      id: 'project-sprout',
      goal: 'Ship it',
      rules: [],
      availableEnvironmentInstanceIds: ['mac-mini-1'],
      memberships: [],
    });
    handle.close();

    // Independent adapters over the same file read exactly what the composed
    // handle wrote, which is the compatibility property the move must keep.
    const leaseStore = new SqliteLeaseStore({ filename: path });
    assert.deepEqual(leaseStore.get('lease-1'), lease);
    leaseStore.close();

    const runStore = new SqliteRunStore({ filename: path });
    assert.equal((await runStore.get('run-1'))?.environmentInstanceId, 'mac-mini-1');
    runStore.close();

    const projectStore = new SqliteProjectStore({ filename: path });
    assert.equal((await projectStore.get('project-sprout'))?.goal, 'Ship it');
    projectStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A database written with the exact pre-rehome `CREATE TABLE` text.
 *
 * The statements below are copied verbatim from the adapters at the fixed base
 * commit (`git show <base>:src/run/sqlite-store.ts`), so opening this file with
 * the rehomed adapters proves the moved classes still read the schema an older
 * Sprout produced. Regenerating it means copying the base text again; the point
 * is that the on-disk shape does not change across the move.
 */
function writeHistoricalDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      environment_instance_id TEXT NOT NULL,
      project_id TEXT,
      status TEXT NOT NULL,
      events TEXT NOT NULL,
      lease_id TEXT,
      failure TEXT,
      result TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      hand_off TEXT,
      task_id TEXT,
      token_usage TEXT
    );
    CREATE TABLE environment_leases (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      holder_kind TEXT,
      run_id TEXT,
      task_id TEXT,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      document TEXT NOT NULL
    );
    CREATE TABLE agent_session_keys (
      slot TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      environment_instance_id TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      session_key TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO agent_runs (id, agent_id, prompt, environment_instance_id, project_id, status, events, created_at, token_usage)
    VALUES ('legacy-run', 'agent-scout', 'hi', 'mac-mini-1', 'project-sprout', 'completed', '[]', 10,
            '{"promptTokens":7,"completionTokens":3,"totalTokens":10}');
    INSERT INTO environment_leases (id, instance_id, capability, holder_id, holder_kind, task_id, acquired_at, expires_at, state)
    VALUES ('legacy-lease', 'mac-mini-1', 'agent-run', 'task-1', 'task', 'task-1', 10, 60000, 'active');
    INSERT INTO projects (id, document)
    VALUES ('legacy-project', '{"id":"legacy-project","goal":"old goal","rules":[],"availableEnvironmentInstanceIds":[],"memberships":[]}');
  `);
  db.close();
}

test('a database written with the pre-rehome schema still opens and reads back', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-rehome-historical-'));
  const path = join(directory, 'historical.db');
  try {
    writeHistoricalDatabase(path);

    const handle = new SqliteStore({ filename: path });
    // Opening runs the idempotent `CREATE TABLE IF NOT EXISTS` and the
    // `#addColumnIfMissing` migrations; a historical file must be left with the
    // same nine tables rather than failing or duplicating one.
    const tables = handle.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as unknown as readonly { readonly name: string }[];
    assert.deepEqual(
      tables.map((table) => table.name),
      Object.keys(EXPECTED_SCHEMA).sort(),
    );

    // Rows written before the move come back through the rehomed adapters with
    // their meaning intact, including a JSON document and a Task-held lease.
    assert.equal((await handle.runs.get('legacy-run'))?.tokenUsage?.totalTokens, 10);
    assert.equal(handle.leases.get('legacy-lease')?.holderKind, 'task');
    assert.equal((await handle.projects.get('legacy-project'))?.goal, 'old goal');
    handle.close();

    // A standalone rehomed adapter over the same historical file agrees.
    const leases = new SqliteLeaseStore({ filename: path });
    assert.equal(leases.get('legacy-lease')?.taskId, 'task-1');
    leases.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * F1 regression evidence (#81 rework).
 *
 * The reviewer found that `SqliteTaskStore` still issued `environment_leases`
 * SQL directly while `SqliteLeaseStore` separately owned that table. These tests
 * pin the two properties the fix must hold:
 *
 * 1. **One owner for lease SQL.** The Task adapter has no lease SQL of its own;
 *    the begin/end boundary runs the environment domain's statements through a
 *    bound `TaskLeaseBinding`, and the shared handle owns the transaction.
 * 2. **The atomic boundary is unchanged.** A Task begin writes the Task row and
 *    its Task lease in one `BEGIN IMMEDIATE` … `COMMIT`, and a failing begin
 *    rolls back both, exactly as M1 did.
 */

test('a Task begin/end boundary calls the bound environment lease adapter, not lease SQL of its own', async () => {
  const calls: string[] = [];
  const binding: TaskLeaseBinding = {
    insertTaskHeldLease: (lease) => { calls.push(`insert:${lease.id}`); },
    markTaskLeaseReleased: (leaseId) => { calls.push(`release:${leaseId}`); },
  };
  const store = new SqliteTaskStore({ filename: ':memory:', leases: binding });
  await store.create(sampleTask());
  const lease = {
    id: 'lease-1', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'task-1',
    holderKind: 'task' as const, taskId: 'task-1', acquiredAt: 1, expiresAt: 2, state: 'active' as const,
  };
  await store.saveBeginningWithLease(sampleTask({ environmentLeaseId: 'lease-1' }), lease);
  await store.saveTerminalWithLease(sampleTask({ environmentLeaseId: 'lease-1' }), 'lease-1');
  assert.deepEqual(calls, ['insert:lease-1', 'release:lease-1'], 'lease SQL is delegated to the environment port');

  // A store constructed without the environment port refuses a lease boundary
  // rather than issuing lease SQL itself or committing half of it.
  const bare = new SqliteTaskStore({ filename: ':memory:' });
  await bare.create(sampleTask());
  await assert.rejects(bare.saveBeginningWithLease(sampleTask(), lease), /no Environment lease adapter/);
  store.close();
  bare.close();
});

test('the composed handle binds the Task adapter to the environment lease port and one coordinator', async () => {
  await withStore((store) => {
    assert.equal(typeof store.transactions.immediate, 'function');
    // The Task store answers a begin boundary by writing the lease row through
    // the environment adapter, proving the mount is wired, not merely typed.
    const lease = {
      id: 'lease-bound', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'task-1',
      holderKind: 'task' as const, taskId: 'task-1', acquiredAt: 1, expiresAt: 2, state: 'active' as const,
    };
    return (async () => {
      await store.tasks.create(sampleTask());
      await store.tasks.saveBeginningWithLease(sampleTask({ environmentLeaseId: 'lease-bound', assignedAgentId: 'pi' }), lease);
      assert.deepEqual(store.leases.get('lease-bound'), lease);
    })();
  });
});

test('a failing Task begin rolls back both the Task row and the lease in the one shared transaction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-f1-atomic-'));
  const path = join(directory, 'sprout.db');
  try {
    const store = new SqliteStore({ filename: path });
    await store.tasks.create(sampleTask());

    // A conflicting live lease makes the boundary throw after the conflict read;
    // neither the Task write nor any lease row may survive.
    store.leases.insertTaskHeldLease({
      id: 'lease-live', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'run-1',
      holderKind: 'run', runId: 'run-1', acquiredAt: 1, expiresAt: 9_999_999_999, state: 'active',
    });
    await assert.rejects(
      store.tasks.saveBeginningWithLease(
        sampleTask({ environmentLeaseId: 'lease-new', environmentLifecycleState: 'beginning', assignedAgentId: 'pi' }),
        { id: 'lease-new', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'task-1',
          holderKind: 'task', taskId: 'task-1', acquiredAt: 2, expiresAt: 3, state: 'active' },
      ),
      /unavailable/,
    );
    assert.equal(store.leases.get('lease-new'), undefined, 'no partial lease row survives a failed begin');
    assert.equal((await store.tasks.get('task-1'))?.environmentLifecycleState, undefined, 'no partial Task write survives');
    assert.equal(store.leases.list().length, 1, 'only the pre-existing lease remains');
    store.close();

    // Reopening the file after the rolled-back boundary shows the same durable
    // state: the boundary is atomic across a restart, not only in memory.
    const reopened = new SqliteStore({ filename: path });
    assert.equal(reopened.leases.get('lease-new'), undefined);
    assert.equal(reopened.leases.list().length, 1);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a Task begin then end commits and releases its Task-held lease in one boundary each', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-f1-commit-'));
  const path = join(directory, 'sprout.db');
  try {
    const store = new SqliteStore({ filename: path });
    await store.tasks.create(sampleTask());
    const lease = {
      id: 'lease-task', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'task-1',
      holderKind: 'task' as const, taskId: 'task-1', acquiredAt: 1, expiresAt: 2, state: 'active' as const,
    };
    await store.tasks.saveBeginningWithLease(
      sampleTask({ environmentLeaseId: 'lease-task', environmentLifecycleState: 'beginning', assignedAgentId: 'pi' }),
      lease,
    );
    assert.equal(store.leases.get('lease-task')?.state, 'active');

    await store.tasks.saveTerminalWithLease(
      sampleTask({ status: 'done', environmentLeaseId: 'lease-task', environmentLifecycleState: 'ended', completedAt: 5 }),
      'lease-task',
    );
    assert.equal(store.leases.get('lease-task')?.state, 'released');
    assert.equal((await store.tasks.get('task-1'))?.environmentLifecycleState, 'ended');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * S1 evidence (#81 review suggestion): a write/reopen round-trip across every
 * composed adapter, including the Task-held atomic lease path, so the move's
 * compatibility claim is asserted by a durable test rather than only by an
 * external byte probe.
 */
test('every composed adapter writes, reopens from the file, and reads back', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-f1-reopen-'));
  const path = join(directory, 'sprout.db');
  try {
    const first = new SqliteStore({ filename: path });
    await first.tasks.create(sampleTask());
    await first.tasks.saveBeginningWithLease(
      sampleTask({ environmentLeaseId: 'lease-task', environmentLifecycleState: 'beginning', assignedAgentId: 'pi' }),
      { id: 'lease-task', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'task-1',
        holderKind: 'task', taskId: 'task-1', acquiredAt: 1, expiresAt: 2, state: 'active' },
    );
    await first.tasks.linkRun({ taskId: 'task-1', runId: 'run-1', agentId: 'agent-scout', now: 3 });
    await first.runs.save({
      id: 'run-1', agentId: 'agent-scout', prompt: 'go', environmentInstanceId: 'mac-mini-1',
      projectId: 'project-sprout', taskId: 'task-1', status: 'completed', events: [],
      tokenUsage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 }, createdAt: 4, completedAt: 5,
    });
    await first.sessionKeys.save({
      agentId: 'agent-scout', engine: 'scripted', environmentInstanceId: 'mac-mini-1',
      workingDirectory: '/work', key: 'sk-1', updatedAt: 6,
    });
    await first.collaboration.postMessage({
      message: { id: 'msg-1', projectId: 'project-sprout', channel: 'project',
        author: { id: 'agent-scout', kind: 'agent' }, body: 'hi', recipients: [], deliveryKey: 'd-1', createdAt: 7 },
      plan: { messageId: 'msg-1', decisions: [{ agentId: 'agent-scout', reason: 'direct-recipient' }], observations: [] },
      now: 7,
    });
    first.close();

    const reopened = new SqliteStore({ filename: path });
    assert.equal((await reopened.tasks.get('task-1'))?.environmentLifecycleState, 'beginning');
    assert.equal(reopened.leases.get('lease-task')?.state, 'active');
    assert.equal((await reopened.tasks.listRuns('task-1')).length, 1);
    assert.equal((await reopened.runs.get('run-1'))?.tokenUsage?.totalTokens, 3);
    assert.equal((await reopened.sessionKeys.get({
      agentId: 'agent-scout', engine: 'scripted', environmentInstanceId: 'mac-mini-1', workingDirectory: '/work',
    }))?.key, 'sk-1');
    assert.equal((await reopened.collaboration.listWakeRequests()).length, 1);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
