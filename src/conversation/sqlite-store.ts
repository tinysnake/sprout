import { DatabaseSync } from 'node:sqlite';

import type { ConversationScope } from './model.ts';
import type { ConversationScopeStore } from './store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * SQLite adapter for durable conversation scopes (ticket #95).
 *
 * The whole scope — a Project channel, one Project-scoped direct conversation,
 * or one Working group with its content versions and membership history — is
 * one JSON document keyed by its stable id, like an Agent identity or a
 * Project authority record: its append-only versions belong to the scope as a
 * whole and must never be rewritten piecemeal. The document holds only
 * sanitized display name, goal, rules, member ids, actor ids, reasons, and
 * timestamps — so no credential, provider or account identity, hostname,
 * address, or absolute path has a column here. There is no delete: disbanding
 * and ended membership are statuses and recorded facts (ADR-0008).
 */
export class SqliteConversationScopeStore implements ConversationScopeStore {
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
      CREATE TABLE IF NOT EXISTS conversation_scopes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        document TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_scopes_project
        ON conversation_scopes(project_id);
    `);
  }

  async save(scope: ConversationScope): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO conversation_scopes (id, project_id, kind, document, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           document = excluded.document,
           updated_at = excluded.updated_at`,
      )
      .run(scope.id, scope.projectId, scope.kind, JSON.stringify(scope), scope.updatedAt);
  }

  async get(scopeId: string): Promise<ConversationScope | undefined> {
    const row = this.#db
      .prepare('SELECT document FROM conversation_scopes WHERE id = ?')
      .get(scopeId) as { readonly document: string } | undefined;
    return row ? (JSON.parse(row.document) as ConversationScope) : undefined;
  }

  async listForProject(projectId: string): Promise<readonly ConversationScope[]> {
    const rows = this.#db
      .prepare(
        `SELECT document FROM conversation_scopes WHERE project_id = ?
         ORDER BY json_extract(document, '$.createdAt'), id`,
      )
      .all(projectId) as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as ConversationScope);
  }

  async list(): Promise<readonly ConversationScope[]> {
    const rows = this.#db
      .prepare(
        `SELECT document FROM conversation_scopes
         ORDER BY json_extract(document, '$.createdAt'), id`,
      )
      .all() as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as ConversationScope);
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}
