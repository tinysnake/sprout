import { DatabaseSync } from 'node:sqlite';

import type { AgentRun, AgentRunStatus } from './model.ts';
import type { AgentRunEvent } from '../engine/port.ts';
import type { RunStore } from './store.ts';
import type { EnvironmentLease, LeaseState, LeaseStore } from '../environment/pool.ts';

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
  readonly status: string;
  readonly events: string;
  readonly lease_id: string | null;
  readonly failure: string | null;
  readonly result: string | null;
  readonly created_at: number;
  readonly completed_at: number | null;
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
        status TEXT NOT NULL,
        events TEXT NOT NULL,
        lease_id TEXT,
        failure TEXT,
        result TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `);
  }

  async save(run: AgentRun): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO agent_runs
           (id, agent_id, prompt, environment_instance_id, status, events, lease_id, failure, result, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           events = excluded.events,
           lease_id = excluded.lease_id,
           failure = excluded.failure,
           result = excluded.result,
           completed_at = excluded.completed_at`,
      )
      .run(
        run.id,
        run.agentId,
        run.prompt,
        run.environmentInstanceId,
        run.status,
        JSON.stringify(run.events),
        run.leaseId ?? null,
        run.failure ?? null,
        run.result ? JSON.stringify(run.result) : null,
        run.createdAt,
        run.completedAt ?? null,
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
  readonly run_id: string | null;
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
        run_id TEXT,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL
      );
    `);
  }

  save(lease: EnvironmentLease): void {
    this.#db
      .prepare(
        `INSERT INTO environment_leases
           (id, instance_id, capability, holder_id, run_id, acquired_at, expires_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           expires_at = excluded.expires_at,
           state = excluded.state,
           run_id = excluded.run_id`,
      )
      .run(
        lease.id,
        lease.instanceId,
        lease.capability,
        lease.holderId,
        lease.runId ?? null,
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
 * Unified SQLite storage for Sprout, managing both runs and leases
 * through a single database handle (ADR-0002).
 */
export class SqliteStore {
  readonly db: DatabaseSync;
  readonly runs: SqliteRunStore;
  readonly leases: SqliteLeaseStore;

  constructor(options: SqliteStoreOptions) {
    this.db = new DatabaseSync(options.filename);
    this.runs = new SqliteRunStore({ db: this.db });
    this.leases = new SqliteLeaseStore({ db: this.db });
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
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    state: row.state as LeaseState,
  };
}

function toRun(row: RunRow): AgentRun {
  const result = row.result !== null ? (JSON.parse(row.result) as AgentRun['result']) : undefined;
  return {
    id: row.id,
    agentId: row.agent_id,
    prompt: row.prompt,
    environmentInstanceId: row.environment_instance_id,
    status: row.status as AgentRunStatus,
    events: JSON.parse(row.events) as AgentRunEvent[],
    ...(row.lease_id !== null ? { leaseId: row.lease_id } : {}),
    ...(row.failure !== null ? { failure: row.failure } : {}),
    ...(result !== undefined ? { result } : {}),
    createdAt: row.created_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}
