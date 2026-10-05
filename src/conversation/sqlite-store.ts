import { DatabaseSync } from 'node:sqlite';

import { ConversationScopeError, type ConversationScope } from './model.ts';
import type { ConversationScopeStore } from './store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * SQLite adapter for durable conversation scopes (ticket #95).
 *
 * The whole scope — a Project channel, one Project-scoped direct conversation,
 * one Working group with its content versions and membership history, or one
 * Task group bound to a Task — is one JSON document keyed by its stable id,
 * like an Agent identity or a
 * Project authority record: its append-only versions belong to the scope as a
 * whole and must never be rewritten piecemeal. The document holds only
 * sanitized display name, goal, rules, member ids, actor ids, reasons, and
 * timestamps — so no credential, provider or account identity, hostname,
 * address, or absolute path has a column here.
 *
 * A rewrite goes through `update`: the row read, the synchronous mutation,
 * and the conditional write (`… WHERE id = ? AND document = ?`) form one
 * critical section that never yields, and the condition refuses a row that
 * changed since the read instead of overwriting it (`stale-scope-write`).
 * Lifecycle changes never delete: disbanding and ended membership are statuses
 * and recorded facts (ADR-0008); `removeProjectChannel` exists solely to roll
 * back or reap a prepared Project-channel row whose Project never persisted,
 * and storage fences it to rows of kind `project`.
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

  async update(
    scopeId: string,
    mutate: (current: ConversationScope | undefined) => ConversationScope | undefined,
  ): Promise<ConversationScope | undefined> {
    // Critical section: read, synchronous mutation, conditional write. Nothing
    // here may await: the single-threaded event loop must get no chance to
    // interleave another command between the read and the write, which is what
    // serializes lifecycle edits in this process. The `WHERE document = ?`
    // condition then refuses a row changed by any other writer (another
    // connection) instead of overwriting it.
    const row = this.#db
      .prepare('SELECT document FROM conversation_scopes WHERE id = ?')
      .get(scopeId) as { readonly document: string } | undefined;
    const prior = row?.document;
    const next = mutate(prior === undefined ? undefined : (JSON.parse(prior) as ConversationScope));
    if (next === undefined) return undefined;
    const document = JSON.stringify(next);
    if (prior === undefined) {
      const inserted = this.#db
        .prepare(
          `INSERT INTO conversation_scopes (id, project_id, kind, document, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(scopeId, next.projectId, next.kind, document, next.updatedAt);
      if (Number(inserted.changes) !== 1) throw staleScopeWrite(scopeId);
    } else {
      const updated = this.#db
        .prepare(
          `UPDATE conversation_scopes
             SET document = ?, updated_at = ?
           WHERE id = ? AND document = ?`,
        )
        .run(document, next.updatedAt, scopeId, prior);
      if (Number(updated.changes) !== 1) throw staleScopeWrite(scopeId);
    }
    return next;
  }

  async removeProjectChannel(scopeId: string): Promise<void> {
    const row = this.#db
      .prepare('SELECT kind FROM conversation_scopes WHERE id = ?')
      .get(scopeId) as { readonly kind: string } | undefined;
    if (row === undefined) return;
    if (row.kind !== 'project') {
      throw new Error(
        `refusing to remove ${scopeId}: only a Project-channel row is removable, never a ${row.kind} record`,
      );
    }
    this.#db
      .prepare('DELETE FROM conversation_scopes WHERE id = ? AND kind = ?')
      .run(scopeId, 'project');
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

function staleScopeWrite(scopeId: string): ConversationScopeError {
  return new ConversationScopeError(
    'stale-scope-write',
    `conversation scope ${scopeId} changed while the command was running; the stale write was refused`,
  );
}
