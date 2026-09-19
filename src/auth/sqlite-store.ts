import { DatabaseSync } from 'node:sqlite';

import type { BrowserSessionRecord, OperatorCredentialRecord, OperatorSessionStore } from './store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

interface OperatorRow {
  readonly credential_hash: string;
  readonly credential_salt: string;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface SessionRow {
  readonly id: string;
  readonly token_hash: string;
  readonly csrf_hash: string;
  readonly credential_version: number;
  readonly created_at: number;
  readonly last_seen_at: number;
  readonly revoked_at: number | null;
}

/** SQLite adapter for the single Operator identity and browser-session records. */
export class SqliteOperatorSessionStore implements OperatorSessionStore {
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
      CREATE TABLE IF NOT EXISTS operator_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        credential_hash TEXT NOT NULL,
        credential_salt TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_hash TEXT NOT NULL,
        credential_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS browser_sessions_active_idx
        ON browser_sessions (revoked_at, credential_version);
    `);
  }

  async getOperator(): Promise<OperatorCredentialRecord | undefined> {
    const row = this.#db.prepare('SELECT * FROM operator_identity WHERE singleton = 1').get() as unknown;
    return row ? toOperator(row as OperatorRow) : undefined;
  }

  async saveOperator(record: OperatorCredentialRecord): Promise<void> {
    this.#db.prepare(`
      INSERT INTO operator_identity (singleton, credential_hash, credential_salt, version, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        credential_hash = excluded.credential_hash,
        credential_salt = excluded.credential_salt,
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run(record.credentialHash, record.credentialSalt, record.version, record.createdAt, record.updatedAt);
  }

  async getSessionByTokenHash(tokenHash: string): Promise<BrowserSessionRecord | undefined> {
    const row = this.#db.prepare('SELECT * FROM browser_sessions WHERE token_hash = ?').get(tokenHash) as unknown;
    return row ? toSession(row as SessionRow) : undefined;
  }

  async createSession(record: BrowserSessionRecord): Promise<void> {
    this.#db.prepare(`
      INSERT INTO browser_sessions
        (id, token_hash, csrf_hash, credential_version, created_at, last_seen_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.tokenHash,
      record.csrfHash,
      record.credentialVersion,
      record.createdAt,
      record.lastSeenAt,
      record.revokedAt ?? null,
    );
  }

  async listSessions(): Promise<readonly BrowserSessionRecord[]> {
    return (this.#db.prepare('SELECT * FROM browser_sessions ORDER BY created_at DESC').all() as unknown as SessionRow[])
      .map(toSession);
  }

  async touchSession(id: string, at: number): Promise<void> {
    this.#db.prepare('UPDATE browser_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id);
  }

  async revokeSession(id: string, at: number): Promise<boolean> {
    return Number(this.#db.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id)
      .changes) > 0;
  }

  async revokeSessionsExcept(id: string, at: number): Promise<number> {
    return Number(this.#db.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE id != ? AND revoked_at IS NULL').run(at, id)
      .changes);
  }

  async revokeAllSessions(at: number): Promise<number> {
    return Number(this.#db.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(at).changes);
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

function toOperator(row: OperatorRow): OperatorCredentialRecord {
  return {
    credentialHash: row.credential_hash,
    credentialSalt: row.credential_salt,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSession(row: SessionRow): BrowserSessionRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    csrfHash: row.csrf_hash,
    credentialVersion: row.credential_version,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at ?? undefined,
  };
}
