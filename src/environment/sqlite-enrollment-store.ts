import { DatabaseSync } from 'node:sqlite';

import type { EnvironmentEnrollment } from './enrollment.ts';
import { normalizeEnrollment } from './enrollment.ts';
import type { EnrollmentStore } from './enrollment-store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * SQLite adapter for durable Environment enrollment decisions (#87).
 *
 * The whole enrollment is one JSON document keyed by id, like a Project: its
 * append-only decisions and capability permissions belong to the enrollment, and
 * reconstructing them from mutable columns would risk losing history. The
 * document holds only an opaque Worker identity digest and neutral facts, so no
 * private key or credential has a column here.
 */
export class SqliteEnrollmentStore implements EnrollmentStore {
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
      CREATE TABLE IF NOT EXISTS environment_enrollments (
        id TEXT PRIMARY KEY,
        environment_instance_id TEXT NOT NULL,
        document TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS environment_enrollments_instance_idx
        ON environment_enrollments (environment_instance_id);
    `);
  }

  async save(enrollment: EnvironmentEnrollment): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO environment_enrollments (id, environment_instance_id, document)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           environment_instance_id = excluded.environment_instance_id,
           document = excluded.document`,
      )
      .run(enrollment.id, enrollment.environmentInstanceId, JSON.stringify(enrollment));
  }

  async get(enrollmentId: string): Promise<EnvironmentEnrollment | undefined> {
    const row = this.#db
      .prepare('SELECT document FROM environment_enrollments WHERE id = ?')
      .get(enrollmentId) as { readonly document: string } | undefined;
    return row ? normalizeEnrollment(JSON.parse(row.document) as EnvironmentEnrollment) : undefined;
  }

  /**
   * Compare-and-set on the stored claim (#115).
   *
   * SQLite serializes the write, so this is the durable exactly-once boundary:
   * the materialized document is re-read and the claim is only consumed when it
   * is still unconsumed and still has the verified digest. Two concurrent claims
   * therefore cannot both apply, even across processes. The whole read/check/write
   * runs inside one `BEGIN IMMEDIATE` transaction so no other writer can interleave
   * between the read and the update.
   */
  async consumeClaim(
    enrollmentId: string,
    expectedDigest: string,
    consumedAt: number,
  ): Promise<EnvironmentEnrollment | undefined> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#db
        .prepare('SELECT document FROM environment_enrollments WHERE id = ?')
        .get(enrollmentId) as { readonly document: string } | undefined;
      if (row === undefined) {
        this.#db.exec('COMMIT');
        return undefined;
      }
      const current = normalizeEnrollment(JSON.parse(row.document) as EnvironmentEnrollment);
      const claim = current.claim;
      if (claim === undefined || claim.consumedAt !== undefined || claim.secretDigest !== expectedDigest) {
        this.#db.exec('COMMIT');
        return undefined;
      }
      const consumed: EnvironmentEnrollment = {
        ...current,
        claim: { ...claim, consumedAt },
        updatedAt: consumedAt,
      };
      this.#db
        .prepare(
          `INSERT INTO environment_enrollments (id, environment_instance_id, document)
           VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             environment_instance_id = excluded.environment_instance_id,
             document = excluded.document`,
        )
        .run(consumed.id, consumed.environmentInstanceId, JSON.stringify(consumed));
      this.#db.exec('COMMIT');
      return consumed;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async list(): Promise<readonly EnvironmentEnrollment[]> {
    const rows = this.#db
      .prepare('SELECT document FROM environment_enrollments ORDER BY id')
      .all() as unknown as readonly { readonly document: string }[];
    return rows.map((row) => normalizeEnrollment(JSON.parse(row.document) as EnvironmentEnrollment));
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}
