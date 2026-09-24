import { DatabaseSync } from 'node:sqlite';

import type { ProjectEnvironmentAccess } from './access.ts';
import type { ProjectAccessStore } from './access-store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * SQLite adapter for durable Project Environment access and workspace bindings
 * (#93).
 *
 * One access record per (Project, Environment instance) is one JSON document,
 * like an Agent identity or a Project authority: its append-only binding history
 * belongs to the relationship as a whole, and reconstructing bindings from
 * mutable columns would risk losing the historical attribution later work
 * depends on. The document holds only the Worker's opaque workspace identity
 * and, for a relative selection, a Worker-root-relative location — so no
 * credential, provider or account identity, hostname, address, or absolute path
 * has a column here. Ending access is a status inside the document; there is no
 * delete.
 */
export class SqliteProjectAccessStore implements ProjectAccessStore {
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
      CREATE TABLE IF NOT EXISTS project_environment_access (
        project_id TEXT NOT NULL,
        environment_instance_id TEXT NOT NULL,
        document TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, environment_instance_id)
      );
    `);
  }

  async save(access: ProjectEnvironmentAccess): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO project_environment_access
           (project_id, environment_instance_id, document, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, environment_instance_id) DO UPDATE SET
           document = excluded.document,
           updated_at = excluded.updated_at`,
      )
      .run(
        access.projectId,
        access.environmentInstanceId,
        JSON.stringify(access),
        access.updatedAt,
      );
  }

  async get(
    projectId: string,
    environmentInstanceId: string,
  ): Promise<ProjectEnvironmentAccess | undefined> {
    const row = this.#db
      .prepare(
        `SELECT document FROM project_environment_access
         WHERE project_id = ? AND environment_instance_id = ?`,
      )
      .get(projectId, environmentInstanceId) as { readonly document: string } | undefined;
    return row ? (JSON.parse(row.document) as ProjectEnvironmentAccess) : undefined;
  }

  async listForProject(projectId: string): Promise<readonly ProjectEnvironmentAccess[]> {
    const rows = this.#db
      .prepare(
        `SELECT document FROM project_environment_access
         WHERE project_id = ? ORDER BY updated_at, environment_instance_id`,
      )
      .all(projectId) as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as ProjectEnvironmentAccess);
  }

  async list(): Promise<readonly ProjectEnvironmentAccess[]> {
    const rows = this.#db
      .prepare('SELECT document FROM project_environment_access ORDER BY updated_at, project_id, environment_instance_id')
      .all() as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as ProjectEnvironmentAccess);
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}
