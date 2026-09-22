import { DatabaseSync } from 'node:sqlite';

import type { ProjectAuthority } from './authority-model.ts';
import type { ProjectAuthorityStore } from './authority-store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * SQLite adapter for durable Project authority records (#92).
 *
 * The whole Project is one JSON document keyed by its stable id, like an Agent
 * identity: its append-only content history belongs to the Project as a whole,
 * and reconstructing versions from mutable columns would risk losing the
 * historical attribution later work depends on. The document holds only
 * sanitized display name, template attribution, goal, rules, wake policy,
 * routing interval, and membership facts — so no credential, provider or
 * account identity, hostname, address, or absolute path has a column here.
 */
export class SqliteProjectAuthorityStore implements ProjectAuthorityStore {
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
      CREATE TABLE IF NOT EXISTS project_authorities (
        id TEXT PRIMARY KEY,
        document TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async save(project: ProjectAuthority): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO project_authorities (id, document, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           document = excluded.document,
           updated_at = excluded.updated_at`,
      )
      .run(project.id, JSON.stringify(project), project.updatedAt);
  }

  async get(projectId: string): Promise<ProjectAuthority | undefined> {
    const row = this.#db
      .prepare('SELECT document FROM project_authorities WHERE id = ?')
      .get(projectId) as { readonly document: string } | undefined;
    return row ? (JSON.parse(row.document) as ProjectAuthority) : undefined;
  }

  async list(): Promise<readonly ProjectAuthority[]> {
    const rows = this.#db
      .prepare('SELECT document FROM project_authorities ORDER BY updated_at, id')
      .all() as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as ProjectAuthority);
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}
