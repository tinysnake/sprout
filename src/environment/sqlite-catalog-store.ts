import { DatabaseSync } from 'node:sqlite';

import type { EnvironmentDefinition, EnvironmentInstance } from './model.ts';
import type { EnvironmentCatalogRecord, EnvironmentCatalogStore } from './catalog-store.ts';
import { sanitizeEnvironmentCatalogRecord } from './catalog-privacy.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * SQLite adapter for the durable Environment catalog (E2, #116).
 *
 * One JSON document keyed by environment instance id, holding only selected
 * portable definition and instance facts. The store boundary discards
 * credentials, private keys, host/network details, absolute paths, and raw
 * diagnostics before writing. A record is retained whatever the current
 * connectivity or authority status, so an offline or revoked instance is still
 * inspectable after a restart.
 */
export class SqliteEnvironmentCatalogStore implements EnvironmentCatalogStore {
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
      CREATE TABLE IF NOT EXISTS environment_catalog (
        instance_id TEXT PRIMARY KEY,
        enrollment_id TEXT NOT NULL,
        document TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async save(record: EnvironmentCatalogRecord): Promise<void> {
    const safe = sanitizeEnvironmentCatalogRecord(record);
    const document = JSON.stringify({
      definition: safe.definition,
      instance: safe.instance,
    });
    this.#db
      .prepare(
        `INSERT INTO environment_catalog (instance_id, enrollment_id, document, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           enrollment_id = excluded.enrollment_id,
           document = excluded.document,
           updated_at = excluded.updated_at`,
      )
      .run(safe.instanceId, safe.enrollmentId, document, safe.updatedAt);
  }

  async get(instanceId: string): Promise<EnvironmentCatalogRecord | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM environment_catalog WHERE instance_id = ?')
      .get(instanceId) as unknown as
      | { readonly enrollment_id: string; readonly document: string; readonly updated_at: number }
      | undefined;
    return row === undefined ? undefined : toRecord(instanceId, row);
  }

  async list(): Promise<readonly EnvironmentCatalogRecord[]> {
    const rows = this.#db
      .prepare('SELECT * FROM environment_catalog ORDER BY instance_id')
      .all() as unknown as readonly {
      readonly instance_id: string;
      readonly enrollment_id: string;
      readonly document: string;
      readonly updated_at: number;
    }[];
    return rows.map((row) => toRecord(row.instance_id, row));
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

function toRecord(
  instanceId: string,
  row: { readonly enrollment_id: string; readonly document: string; readonly updated_at: number },
): EnvironmentCatalogRecord {
  let parsed: { readonly definition?: EnvironmentDefinition; readonly instance?: EnvironmentInstance };
  try {
    parsed = JSON.parse(row.document) as {
      readonly definition?: EnvironmentDefinition;
      readonly instance?: EnvironmentInstance;
    };
  } catch {
    // A damaged legacy document remains an inspectable, explicitly unknown
    // record rather than allowing raw bytes to escape or crashing catalog load.
    parsed = {};
  }
  return sanitizeEnvironmentCatalogRecord({
    instanceId,
    enrollmentId: row.enrollment_id,
    definition: parsed.definition,
    instance: parsed.instance,
    updatedAt: row.updated_at,
  });
}
