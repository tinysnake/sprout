import { DatabaseSync } from 'node:sqlite';

import type { ProbeResultFact } from './readiness.ts';
import type { EnvironmentReadinessStore, ObservedReadiness } from './readiness-store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * SQLite adapter for observed Environment readiness facts (#87).
 *
 * The latest observation is one JSON document per environment instance, because
 * it is a current value that supersedes an older value. Probe results are append
 * rows, because ADR-0009 makes readiness observations append-only: a newer probe
 * supersedes a value without erasing the observations that came before it.
 */
export class SqliteEnvironmentReadinessStore implements EnvironmentReadinessStore {
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
      CREATE TABLE IF NOT EXISTS environment_readiness (
        environment_instance_id TEXT PRIMARY KEY,
        document TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS environment_probes (
        environment_instance_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        document TEXT NOT NULL,
        PRIMARY KEY (environment_instance_id, sequence)
      );
    `);
  }

  async saveReadiness(environmentInstanceId: string, observed: ObservedReadiness): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO environment_readiness (environment_instance_id, document, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(environment_instance_id) DO UPDATE SET
           document = excluded.document,
           updated_at = excluded.updated_at`,
      )
      .run(environmentInstanceId, JSON.stringify(observed), Date.now());
  }

  async getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined> {
    const row = this.#db
      .prepare('SELECT document FROM environment_readiness WHERE environment_instance_id = ?')
      .get(environmentInstanceId) as { readonly document: string } | undefined;
    return row ? (JSON.parse(row.document) as ObservedReadiness) : undefined;
  }

  async appendProbe(environmentInstanceId: string, probe: ProbeResultFact): Promise<void> {
    const next = this.#db
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM environment_probes WHERE environment_instance_id = ?',
      )
      .get(environmentInstanceId) as { readonly sequence: number };
    this.#db
      .prepare(
        `INSERT INTO environment_probes (environment_instance_id, at, sequence, document)
         VALUES (?, ?, ?, ?)`,
      )
      .run(environmentInstanceId, probe.at, next.sequence + 1, JSON.stringify(probe));
  }

  async listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]> {
    const rows = this.#db
      .prepare(
        `SELECT document FROM environment_probes
          WHERE environment_instance_id = ?
          ORDER BY sequence ASC`,
      )
      .all(environmentInstanceId) as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as ProbeResultFact);
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}
