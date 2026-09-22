import { DatabaseSync } from 'node:sqlite';

import type { Agent } from './model.ts';
import type { AgentStore } from './store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * SQLite adapter for durable portable Agent identities (#90).
 *
 * The whole Agent is one JSON document keyed by its stable id, like an
 * enrollment: its append-only configuration history belongs to the identity as
 * a whole, and reconstructing versions from mutable columns would risk losing
 * the historical attribution every run depends on. The document holds only the
 * display name, standing instructions, and ordered work options — all sanitized
 * at the write boundary — so no host path, credential, or host identity has a
 * column here.
 */
export class SqliteAgentStore implements AgentStore {
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
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        document TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async save(agent: Agent): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO agents (id, document, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           document = excluded.document,
           updated_at = excluded.updated_at`,
      )
      .run(agent.id, JSON.stringify(agent), agent.updatedAt);
  }

  async get(agentId: string): Promise<Agent | undefined> {
    const row = this.#db
      .prepare('SELECT document FROM agents WHERE id = ?')
      .get(agentId) as { readonly document: string } | undefined;
    return row ? (JSON.parse(row.document) as Agent) : undefined;
  }

  async list(): Promise<readonly Agent[]> {
    const rows = this.#db
      .prepare('SELECT document FROM agents ORDER BY updated_at, id')
      .all() as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as Agent);
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}
