import { DatabaseSync } from 'node:sqlite';

import type { EnvironmentRecoveryRecord, ForceReleaseRecord } from './recovery.ts';
import type { RecoveryStore } from './recovery-store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * SQLite adapter for durable Environment recovery records and Force Release
 * outcomes (#88).
 *
 * Recovery records are one JSON document keyed by id, like enrollments: their
 * append-only reconciliation decisions and derived unresolved facts belong to
 * the record as a whole. Force Release outcomes are append rows, because
 * ADR-0009 makes them permanent operational events that must remain readable
 * after the Environment becomes Green again.
 *
 * The documents hold only neutral evidence facts and sanitized operator text, so
 * no credential, hostname, address, or absolute path has a column here.
 */
export class SqliteRecoveryStore implements RecoveryStore {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;

  constructor(options: { filename: string } | { db: DatabaseSync }) {
    if ('db' in options) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      this.#db = new DatabaseSync(options.filename);
      this.#ownsDb = true;
      try {
        migrateOrInitializeDatabase(this.#db, { filename: options.filename });
      } catch (error) {
        this.#db.close();
        throw error;
      }
    }
    this.#init();
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS environment_recovery (
        id TEXT PRIMARY KEY,
        environment_instance_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        document TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS environment_recovery_lease_idx
        ON environment_recovery (lease_id);
      CREATE INDEX IF NOT EXISTS environment_recovery_instance_idx
        ON environment_recovery (environment_instance_id);
      CREATE TABLE IF NOT EXISTS environment_force_releases (
        id TEXT PRIMARY KEY,
        environment_instance_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        document TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS environment_force_releases_instance_idx
        ON environment_force_releases (environment_instance_id, at);
    `);
  }

  async save(record: EnvironmentRecoveryRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO environment_recovery (id, environment_instance_id, lease_id, phase, document)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           environment_instance_id = excluded.environment_instance_id,
           lease_id = excluded.lease_id,
           phase = excluded.phase,
           document = excluded.document`,
      )
      .run(
        record.id,
        record.environmentInstanceId,
        record.leaseId,
        record.phase,
        JSON.stringify(record),
      );
  }

  async get(recordId: string): Promise<EnvironmentRecoveryRecord | undefined> {
    const row = this.#db
      .prepare('SELECT document FROM environment_recovery WHERE id = ?')
      .get(recordId) as { readonly document: string } | undefined;
    return row ? (JSON.parse(row.document) as EnvironmentRecoveryRecord) : undefined;
  }

  async forLease(leaseId: string): Promise<EnvironmentRecoveryRecord | undefined> {
    const row = this.#db
      .prepare(
        `SELECT document FROM environment_recovery
          WHERE lease_id = ? AND phase <> 'resolved'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(leaseId) as { readonly document: string } | undefined;
    return row ? (JSON.parse(row.document) as EnvironmentRecoveryRecord) : undefined;
  }

  async list(): Promise<readonly EnvironmentRecoveryRecord[]> {
    const rows = this.#db
      .prepare('SELECT document FROM environment_recovery ORDER BY rowid DESC')
      .all() as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as EnvironmentRecoveryRecord);
  }

  async appendForceRelease(record: ForceReleaseRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO environment_force_releases (id, environment_instance_id, lease_id, at, document)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.environmentInstanceId, record.leaseId, record.at, JSON.stringify(record));
  }

  async listForceReleases(environmentInstanceId: string): Promise<readonly ForceReleaseRecord[]> {
    const rows = this.#db
      .prepare(
        `SELECT document FROM environment_force_releases
          WHERE environment_instance_id = ?
          ORDER BY at DESC`,
      )
      .all(environmentInstanceId) as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as ForceReleaseRecord);
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}
