import { DatabaseSync } from 'node:sqlite';

import type { Project } from './model.ts';
import type { ProjectStore } from './store.ts';
import {
  assertSchemaCompatibility,
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  setSchemaVersion,
} from '../store/schema.ts';

/**
 * SQLite-backed storage for projects (ADR-0002).
 *
 * This is the project domain's own adapter: it is the only module that knows the
 * project SQL and it lives beside the `ProjectStore` interface it implements. It
 * is mounted on the shared persistence handle so project rows commit against the
 * same durable state the run, lease, Task, and collaboration domains use.
 *
 * A project is read and written as a whole — its rules, environment set, and
 * memberships belong together — so it is stored as one JSON document keyed by
 * id rather than normalized into child tables.
 *
 * The SQL, table, and columns are unchanged from the M1 adapter; this file only
 * relocates the class from `run/` to `project/`.
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
      assertSchemaCompatibility(this.#db, undefined, options.filename);
    }
    this.#init();
    if (this.#ownsDb && getSchemaVersion(this.#db) === 0) {
      setSchemaVersion(this.#db, CURRENT_SCHEMA_VERSION);
    }
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
