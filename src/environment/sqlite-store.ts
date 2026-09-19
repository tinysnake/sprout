import { DatabaseSync } from 'node:sqlite';

import type { EnvironmentLease, LeaseState, LeaseStore } from './pool.ts';

/**
 * SQLite-backed storage for environment leases (ADR-0002).
 *
 * This is the environment domain's own adapter: it is the only module that knows
 * the lease SQL and it lives beside the lease state machine it persists. It is
 * mounted on the shared persistence handle so lease rows commit against the same
 * durable state the run and Task domains use (which is what lets a Task's begin
 * and terminal transitions bind a Task lease in one transaction).
 *
 * The SQL, table, columns, and migration behaviour are unchanged from the M1
 * adapter; this file only relocates the class from `run/` to `environment/`.
 */

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
