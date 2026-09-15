import { DatabaseSync } from 'node:sqlite';

import type { AgentRun, AgentRunStatus, RunHandOff, TokenUsage } from './model.ts';
import type { AgentRunEvent } from '../engine/port.ts';
import type { RunStore } from './store.ts';
import {
  sessionKeyId,
  type SessionKeyStore,
  type SessionKeyIdentity,
  type StoredSessionKey,
} from './session-key-store.ts';
import type { EnvironmentLease, LeaseState, LeaseStore } from '../environment/pool.ts';
import type { Project } from '../project/model.ts';
import type { ProjectStore } from '../project/store.ts';
import { SqliteCollaborationStore } from '../collaboration/sqlite-store.ts';
import { SqliteTaskStore } from '../task/sqlite-store.ts';

/**
 * SQLite-backed storage for runs and leases (ADR-0002).
 *
 * This is the only module that knows SQL. The orchestrator and environment pool
 * depend on the `RunStore` and `LeaseStore` interfaces, so swapping this for
 * an in-memory store or server database does not touch domain orchestration.
 *
 * Events are stored as one JSON document per run rather than a child table: the
 * run's progress record is always read as a whole, and a run is small enough
 * that a document keeps the write path to a single statement.
 */

export interface SqliteRunStoreOptions {
  /** A file path, or `:memory:` for tests. */
  readonly filename: string;
}

interface RunRow {
  readonly id: string;
  readonly agent_id: string;
  readonly prompt: string;
  readonly environment_instance_id: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly status: string;
  readonly events: string;
  readonly lease_id: string | null;
  readonly failure: string | null;
  readonly result: string | null;
  readonly created_at: number;
  readonly completed_at: number | null;
  readonly hand_off: string | null;
  readonly token_usage: string | null;
}

export class SqliteRunStore implements RunStore {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;

  constructor(options: SqliteRunStoreOptions | { db: DatabaseSync }) {
    if ('db' in options) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      this.#db = new DatabaseSync(options.filename);
      this.#ownsDb = true;
    }
    this.#init();
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
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
    `);
    // Added after the table shipped; a database from before this column still
    // has its runs, they simply carry no recorded hand-off.
    this.#addColumnIfMissing('agent_runs', 'project_id', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'hand_off', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'task_id', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'token_usage', 'TEXT');
  }

  #addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly {
      name: string;
    }[];
    if (!columns.some((existing) => existing.name === column)) {
      this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  async save(run: AgentRun): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO agent_runs
           (id, agent_id, prompt, environment_instance_id, project_id, task_id, status, events, lease_id, failure, result, created_at, completed_at, hand_off, token_usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           events = excluded.events,
           lease_id = excluded.lease_id,
           failure = excluded.failure,
           result = excluded.result,
           completed_at = excluded.completed_at,
           hand_off = excluded.hand_off,
           task_id = excluded.task_id,
           token_usage = excluded.token_usage`,
      )
      .run(
        run.id,
        run.agentId,
        run.prompt,
        run.environmentInstanceId,
        run.projectId ?? null,
        run.taskId ?? null,
        run.status,
        JSON.stringify(run.events),
        run.leaseId ?? null,
        run.failure ?? null,
        run.result ? JSON.stringify(run.result) : null,
        run.createdAt,
        run.completedAt ?? null,
        run.handOff ? JSON.stringify(run.handOff) : null,
        run.tokenUsage ? JSON.stringify(run.tokenUsage) : null,
      );
  }

  async get(runId: string): Promise<AgentRun | undefined> {
    const row = this.#db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as
      | unknown
      | undefined;
    return row ? toRun(row as RunRow) : undefined;
  }

  async list(): Promise<readonly AgentRun[]> {
    const rows = this.#db
      .prepare('SELECT * FROM agent_runs ORDER BY created_at DESC')
      .all() as unknown as RunRow[];
    return rows.map(toRun);
  }

  close(): void {
    if (this.#ownsDb) {
      this.#db.close();
    }
  }
}

interface LeaseRow {
  readonly id: string;
  readonly instance_id: string;
  readonly capability: string;
  readonly holder_id: string;
  readonly holder_kind: 'run' | 'task' | null;
  readonly run_id: string | null;
  readonly task_id: string | null;
  readonly acquired_at: number;
  readonly expires_at: number;
  readonly state: string;
}

export class SqliteLeaseStore implements LeaseStore {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;

  constructor(options: { filename: string } | { db: DatabaseSync }) {
    if ('db' in options) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      this.#db = new DatabaseSync(options.filename);
      this.#ownsDb = true;
    }
    this.#init();
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS environment_leases (
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
    `);
    this.#addColumnIfMissing('environment_leases', 'holder_kind', 'TEXT');
    this.#addColumnIfMissing('environment_leases', 'task_id', 'TEXT');
  }

  #addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly { name: string }[];
    if (!columns.some((existing) => existing.name === column)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  save(lease: EnvironmentLease): void {
    this.#db
      .prepare(
        `INSERT INTO environment_leases
           (id, instance_id, capability, holder_id, holder_kind, run_id, task_id, acquired_at, expires_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           expires_at = excluded.expires_at,
           state = excluded.state,
           run_id = excluded.run_id,
           task_id = excluded.task_id,
           holder_kind = excluded.holder_kind`,
      )
      .run(
        lease.id,
        lease.instanceId,
        lease.capability,
        lease.holderId,
        lease.holderKind ?? null,
        lease.runId ?? null,
        lease.taskId ?? null,
        lease.acquiredAt,
        lease.expiresAt,
        lease.state,
      );
  }

  get(leaseId: string): EnvironmentLease | undefined {
    const row = this.#db
      .prepare('SELECT * FROM environment_leases WHERE id = ?')
      .get(leaseId) as unknown | undefined;
    return row ? toLease(row as LeaseRow) : undefined;
  }

  list(): readonly EnvironmentLease[] {
    const rows = this.#db
      .prepare('SELECT * FROM environment_leases ORDER BY acquired_at DESC')
      .all() as unknown as LeaseRow[];
    return rows.map(toLease);
  }

  close(): void {
    if (this.#ownsDb) {
      this.#db.close();
    }
  }
}

export interface SqliteStoreOptions {
  /** A file path, or `:memory:` for tests. */
  readonly filename: string;
}

/**
 * SQLite-backed storage for projects (ADR-0002).
 *
 * A project is read and written as a whole — its rules, environment set, and
 * memberships belong together — so it is stored as one JSON document keyed by
 * id rather than normalized into child tables.
 */
export class SqliteProjectStore implements ProjectStore {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;

  constructor(options: { filename: string } | { db: DatabaseSync }) {
    if ('db' in options) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      this.#db = new DatabaseSync(options.filename);
      this.#ownsDb = true;
    }
    this.#init();
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        document TEXT NOT NULL
      );
    `);
  }

  async save(project: Project): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO projects (id, document) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET document = excluded.document`,
      )
      .run(project.id, JSON.stringify(project));
  }

  async get(projectId: string): Promise<Project | undefined> {
    const row = this.#db.prepare('SELECT document FROM projects WHERE id = ?').get(projectId) as
      | { readonly document: string }
      | undefined;
    return row ? (JSON.parse(row.document) as Project) : undefined;
  }

  async list(): Promise<readonly Project[]> {
    const rows = this.#db
      .prepare('SELECT document FROM projects ORDER BY id')
      .all() as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as Project);
  }

  close(): void {
    if (this.#ownsDb) {
      this.#db.close();
    }
  }
}

/**
 * SQLite-backed storage for engine session keys (ADR-0002).
 *
 * The table's primary key is the identity tuple, so a re-run for the same agent
 * in the same environment and working directory replaces its own key rather than
 * accumulating rows. The key itself is an opaque string: Sprout never parses it.
 */
export class SqliteSessionKeyStore implements SessionKeyStore {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;

  constructor(options: { filename: string } | { db: DatabaseSync }) {
    if ('db' in options) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      this.#db = new DatabaseSync(options.filename);
      this.#ownsDb = true;
    }
    this.#init();
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS agent_session_keys (
        slot TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        environment_instance_id TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        session_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async get(identity: SessionKeyIdentity): Promise<StoredSessionKey | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM agent_session_keys WHERE slot = ?')
      .get(sessionKeyId(identity)) as unknown | undefined;
    return row ? toStoredSessionKey(row as SessionKeyRow) : undefined;
  }

  async save(record: StoredSessionKey): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO agent_session_keys
           (slot, agent_id, engine, environment_instance_id, working_directory, session_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET
           session_key = excluded.session_key,
           updated_at = excluded.updated_at`,
      )
      .run(
        sessionKeyId(record),
        record.agentId,
        record.engine,
        record.environmentInstanceId,
        record.workingDirectory,
        record.key,
        record.updatedAt,
      );
  }

  async delete(identity: SessionKeyIdentity): Promise<void> {
    this.#db.prepare('DELETE FROM agent_session_keys WHERE slot = ?').run(sessionKeyId(identity));
  }

  async list(): Promise<readonly StoredSessionKey[]> {
    const rows = this.#db
      .prepare('SELECT * FROM agent_session_keys ORDER BY updated_at DESC')
      .all() as unknown as SessionKeyRow[];
    return rows.map(toStoredSessionKey);
  }

  close(): void {
    if (this.#ownsDb) {
      this.#db.close();
    }
  }
}

/**
 * Unified SQLite storage for Sprout, managing runs, leases, projects, session
 * keys, collaboration Messages/wake requests, and durable Tasks through a single
 * database handle (ADR-0002).
 *
 * Collaboration and Task rows live in the primary database rather than a separate
 * file, so a Message, its wake requests, the run they admitted, and the Task that
 * run advances all commit against the same durable state a restart reconciles.
 */
export class SqliteStore {
  readonly db: DatabaseSync;
  readonly runs: SqliteRunStore;
  readonly leases: SqliteLeaseStore;
  readonly projects: SqliteProjectStore;
  readonly sessionKeys: SqliteSessionKeyStore;
  readonly collaboration: SqliteCollaborationStore;
  readonly tasks: SqliteTaskStore;

  constructor(options: SqliteStoreOptions) {
    this.db = new DatabaseSync(options.filename);
    this.runs = new SqliteRunStore({ db: this.db });
    this.leases = new SqliteLeaseStore({ db: this.db });
    this.projects = new SqliteProjectStore({ db: this.db });
    this.sessionKeys = new SqliteSessionKeyStore({ db: this.db });
    this.collaboration = new SqliteCollaborationStore({ db: this.db });
    this.tasks = new SqliteTaskStore({ db: this.db });
  }

  close(): void {
    this.db.close();
  }
}

function toLease(row: LeaseRow): EnvironmentLease {
  return {
    id: row.id,
    instanceId: row.instance_id,
    capability: row.capability,
    holderId: row.holder_id,
    ...(row.holder_kind !== null ? { holderKind: row.holder_kind } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    state: row.state as LeaseState,
  };
}

function toRun(row: RunRow): AgentRun {
  const result = row.result !== null ? (JSON.parse(row.result) as AgentRun['result']) : undefined;
  const handOff =
    row.hand_off !== null ? (JSON.parse(row.hand_off) as RunHandOff) : undefined;
  const tokenUsage =
    row.token_usage !== null ? (JSON.parse(row.token_usage) as TokenUsage) : undefined;
  return {
    id: row.id,
    agentId: row.agent_id,
    prompt: row.prompt,
    environmentInstanceId: row.environment_instance_id,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    status: row.status as AgentRunStatus,
    events: JSON.parse(row.events) as AgentRunEvent[],
    ...(handOff !== undefined ? { handOff } : {}),
    ...(row.lease_id !== null ? { leaseId: row.lease_id } : {}),
    ...(row.failure !== null ? { failure: row.failure } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(tokenUsage !== undefined ? { tokenUsage } : {}),
    createdAt: row.created_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

interface SessionKeyRow {
  readonly slot: string;
  readonly agent_id: string;
  readonly engine: string;
  readonly environment_instance_id: string;
  readonly working_directory: string;
  readonly session_key: string;
  readonly updated_at: number;
}

function toStoredSessionKey(row: SessionKeyRow): StoredSessionKey {
  return {
    agentId: row.agent_id,
    engine: row.engine,
    environmentInstanceId: row.environment_instance_id,
    workingDirectory: row.working_directory,
    key: row.session_key,
    updatedAt: row.updated_at,
  };
}
