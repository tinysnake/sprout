import { DatabaseSync } from 'node:sqlite';

import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * Durable high-water allocation for Worker connection epochs (#116, ADR-0012).
 *
 * Readiness facts survive restart, so the authority generation they name must
 * survive too. Allocation is atomic per enrollment and gaps are harmless: once
 * a number has been handed to an authenticated connection it is never reused.
 */
export interface WorkerConnectionEpochStore {
  next(enrollmentId: string): number;
}

export class InMemoryWorkerConnectionEpochStore implements WorkerConnectionEpochStore {
  readonly #highWater = new Map<string, number>();

  next(enrollmentId: string): number {
    const epoch = (this.#highWater.get(enrollmentId) ?? 0) + 1;
    this.#highWater.set(enrollmentId, epoch);
    return epoch;
  }
}

export class SqliteWorkerConnectionEpochStore implements WorkerConnectionEpochStore {
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
      CREATE TABLE IF NOT EXISTS worker_connection_epochs (
        enrollment_id TEXT PRIMARY KEY,
        high_water INTEGER NOT NULL CHECK (high_water > 0)
      );
    `);
  }

  next(enrollmentId: string): number {
    const row = this.#db.prepare(`
      INSERT INTO worker_connection_epochs (enrollment_id, high_water)
      VALUES (?, 1)
      ON CONFLICT(enrollment_id) DO UPDATE SET high_water = high_water + 1
      RETURNING high_water
    `).get(enrollmentId) as { readonly high_water: number } | undefined;
    if (row === undefined || !Number.isSafeInteger(row.high_water) || row.high_water < 1) {
      throw new Error('Worker connection epoch allocation failed');
    }
    return row.high_water;
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}
