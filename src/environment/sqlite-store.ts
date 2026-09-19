import { DatabaseSync } from 'node:sqlite';

import type { EnvironmentLease, LeaseState, LeaseStore, TaskLeaseBinding } from './pool.ts';
import {
  assertSchemaCompatibility,
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  setSchemaVersion,
} from '../store/schema.ts';

/**
 * SQLite-backed storage for environment leases (ADR-0002).
 *
 * This is the environment domain's own adapter: it is the only module that knows
 * the lease SQL and it lives beside the lease state machine it persists. It is
 * mounted on the shared persistence handle so lease rows commit against the same
 * durable state the run and Task domains use (which is what lets a Task's begin
 * and terminal transitions bind a Task lease in one transaction).
 *
 * Besides the plain `LeaseStore` surface it implements the `TaskLeaseBinding`
 * port, so the Task lifecycle's atomic begin/end boundaries run this domain's
 * lease statements rather than duplicating them; those methods issue no
 * `BEGIN`/`COMMIT` of their own and rely on the shared `TransactionCoordinator`
 * to hold the boundary.
 *
 * The plain `LeaseStore` SQL, table, columns, and migration behaviour are
 * unchanged from the M1 adapter; this file only relocates the class from `run/`
 * to `environment/` and adds the boundary methods whose SQL also came from M1.
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

export class SqliteLeaseStore implements LeaseStore, TaskLeaseBinding {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;

  constructor(options: { filename: string } | { db: DatabaseSync }) {
    if ('db' in options) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      this.#db = new DatabaseSync(options.filename);
      this.#ownsDb = true;
      assertSchemaCompatibility(this.#db, undefined, options.filename);
    }
    this.#init();
    if (this.#ownsDb && getSchemaVersion(this.#db) === 0) {
      setSchemaVersion(this.#db, CURRENT_SCHEMA_VERSION);
    }
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

  /**
   * The Task-held lease statements a Task's atomic begin boundary needs.
   *
   * These issue no `BEGIN`/`COMMIT`: the Task store opens one shared
   * transaction through the `TransactionCoordinator` and calls them inside it,
   * so a Task row and its Task-held lease commit or roll back as one state.
   * The statements and the conflict semantics are exactly the ones M1 ran from
   * inside the Task adapter; only their owner moved here.
   */
  insertTaskHeldLease(lease: EnvironmentLease): void {
    const conflict = this.#db.prepare(
      `SELECT id FROM environment_leases
        WHERE instance_id = ? AND state IN ('active', 'recovering') LIMIT 1`,
    ).get(lease.instanceId);
    if (conflict) throw new Error(`environment ${lease.instanceId} is unavailable`);
    this.#db
      .prepare(
        `INSERT INTO environment_leases
       (id, instance_id, capability, holder_id, holder_kind, run_id, task_id, acquired_at, expires_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(lease.id, lease.instanceId, lease.capability, lease.holderId, 'task', lease.runId ?? null,
        lease.taskId ?? null, lease.acquiredAt, lease.expiresAt, lease.state);
  }

  /**
   * The Task-held lease statements a Task's atomic end boundary needs.
   *
   * An already-released or foreign lease is refused rather than silently
   * treated as cleanup. Called inside the shared transaction so the release and
   * the terminal Task row commit together.
   */
  markTaskLeaseReleased(leaseId: string, taskId: string): void {
    const lease = this.#db.prepare(
      `SELECT holder_kind, task_id FROM environment_leases WHERE id = ?`,
    ).get(leaseId) as { holder_kind: string | null; task_id: string | null } | undefined;
    if (!lease || lease.holder_kind !== 'task' || lease.task_id !== taskId) {
      throw new Error(`task ${taskId} lease could not be released after cleanup`);
    }
    this.#db.prepare(`UPDATE environment_leases SET state = 'released' WHERE id = ?`).run(leaseId);
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
