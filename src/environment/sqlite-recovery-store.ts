import { DatabaseSync } from 'node:sqlite';

import type { EnvironmentRecoveryRecord, ForceReleaseRecord } from './recovery.ts';
import type { RecoveryStore } from './recovery-store.ts';
import type { RecoveryReceipt } from './recovery-store.ts';
import type { JournalTurn } from '../worker/recovery-journal.ts';
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
      CREATE TABLE IF NOT EXISTS worker_recovery_receipts (
        enrollment_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        settlement INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        settlement_payload TEXT,
        PRIMARY KEY (enrollment_id, turn_id)
      );
      CREATE TABLE IF NOT EXISTS worker_recovery_events (
        enrollment_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (enrollment_id, turn_id, sequence)
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

  /** SQLite commit precedes the Worker ack. Gaps never advance the receipt. */
  async receiveWorkerTurn(enrollmentId: string, turn: JournalTurn): Promise<RecoveryReceipt> {
    if (!enrollmentId || !turn.turnId || !Number.isSafeInteger(turn.acknowledged) || turn.acknowledged < 0 ||
        !Array.isArray(turn.events) || turn.events.length > 100_000) throw new Error('invalid Worker receipt');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.#db.prepare(`SELECT sequence, settlement, event_count AS eventCount FROM worker_recovery_receipts
        WHERE enrollment_id = ? AND turn_id = ?`).get(enrollmentId, turn.turnId) as RecoveryReceipt | undefined;
      let sequence = prior?.sequence ?? turn.acknowledged;
      let eventCount = prior?.eventCount ?? turn.acknowledged;
      if (turn.acknowledged > sequence) throw new Error('Worker ack is ahead of durable receipt');
      for (const entry of turn.events) {
        if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) throw new Error('invalid event sequence');
        if (entry.sequence <= sequence) {
          const existing = this.#db.prepare(`SELECT payload FROM worker_recovery_events
            WHERE enrollment_id = ? AND turn_id = ? AND sequence = ?`)
            .get(enrollmentId, turn.turnId, entry.sequence) as { payload: string } | undefined;
          if (existing !== undefined && existing.payload !== JSON.stringify(entry.event)) {
            throw new Error('conflicting duplicate Worker event');
          }
          continue;
        }
        if (entry.sequence !== sequence + 1) {
          throw new Error(`missing Worker event sequence: expected ${sequence + 1}, received ${entry.sequence}`);
        }
        this.#db.prepare(`INSERT INTO worker_recovery_events (enrollment_id, turn_id, sequence, payload)
          VALUES (?, ?, ?, ?)`).run(enrollmentId, turn.turnId, entry.sequence, JSON.stringify(entry.event));
        sequence = entry.sequence;
        eventCount++;
      }
      // A settlement may follow only a contiguous event prefix. An absent
      // settlement is never inferred from a closed transport.
      const settlement = (prior?.settlement ?? false) || turn.settlement !== undefined;
      const previousSettlement = this.#db.prepare(`SELECT settlement_payload AS payload FROM worker_recovery_receipts
        WHERE enrollment_id = ? AND turn_id = ?`).get(enrollmentId, turn.turnId) as { payload: string | null } | undefined;
      const payload = turn.settlement === undefined ? (previousSettlement?.payload ?? null) : JSON.stringify(turn.settlement);
      if (previousSettlement?.payload != null && turn.settlement !== undefined && previousSettlement.payload !== payload) {
        throw new Error('conflicting duplicate Worker settlement');
      }
      this.#db.prepare(`INSERT INTO worker_recovery_receipts
        (enrollment_id, turn_id, sequence, settlement, event_count, settlement_payload) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(enrollment_id, turn_id) DO UPDATE SET
          sequence = excluded.sequence, settlement = excluded.settlement, event_count = excluded.event_count,
          settlement_payload = excluded.settlement_payload`)
        .run(enrollmentId, turn.turnId, sequence, settlement ? 1 : 0, eventCount, payload);
      this.#db.exec('COMMIT');
      return { sequence, settlement: Boolean(settlement), eventCount };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
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
