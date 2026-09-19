/**
 * Durable boundary for the one Operator identity and its browser sessions.
 *
 * These records deliberately contain only one-way credential and browser-token
 * digests. Raw credentials, session tokens, and request-forgery tokens are
 * browser/host inputs only; they never cross this store boundary.
 */

export interface OperatorCredentialRecord {
  readonly credentialHash: string;
  readonly credentialSalt: string;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BrowserSessionRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly csrfHash: string;
  readonly credentialVersion: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly revokedAt: number | undefined;
}

export interface OperatorSessionStore {
  getOperator(): Promise<OperatorCredentialRecord | undefined>;
  saveOperator(record: OperatorCredentialRecord): Promise<void>;
  getSessionByTokenHash(tokenHash: string): Promise<BrowserSessionRecord | undefined>;
  createSession(record: BrowserSessionRecord): Promise<void>;
  listSessions(): Promise<readonly BrowserSessionRecord[]>;
  touchSession(id: string, at: number): Promise<void>;
  revokeSession(id: string, at: number): Promise<boolean>;
  revokeSessionsExcept(id: string, at: number): Promise<number>;
  revokeAllSessions(at: number): Promise<number>;
}

/** In-memory implementation for composition and HTTP-contract tests. */
export class InMemoryOperatorSessionStore implements OperatorSessionStore {
  #operator: OperatorCredentialRecord | undefined;
  readonly #sessions = new Map<string, BrowserSessionRecord>();

  async getOperator(): Promise<OperatorCredentialRecord | undefined> {
    return this.#operator;
  }

  async saveOperator(record: OperatorCredentialRecord): Promise<void> {
    this.#operator = record;
  }

  async getSessionByTokenHash(tokenHash: string): Promise<BrowserSessionRecord | undefined> {
    return [...this.#sessions.values()].find((session) => session.tokenHash === tokenHash);
  }

  async createSession(record: BrowserSessionRecord): Promise<void> {
    this.#sessions.set(record.id, record);
  }

  async listSessions(): Promise<readonly BrowserSessionRecord[]> {
    return [...this.#sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async touchSession(id: string, at: number): Promise<void> {
    const session = this.#sessions.get(id);
    if (session) this.#sessions.set(id, { ...session, lastSeenAt: at });
  }

  async revokeSession(id: string, at: number): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (!session || session.revokedAt !== undefined) return false;
    this.#sessions.set(id, { ...session, revokedAt: at });
    return true;
  }

  async revokeSessionsExcept(id: string, at: number): Promise<number> {
    let revoked = 0;
    for (const session of this.#sessions.values()) {
      if (session.id !== id && session.revokedAt === undefined) {
        this.#sessions.set(session.id, { ...session, revokedAt: at });
        revoked += 1;
      }
    }
    return revoked;
  }

  async revokeAllSessions(at: number): Promise<number> {
    let revoked = 0;
    for (const session of this.#sessions.values()) {
      if (session.revokedAt === undefined) {
        this.#sessions.set(session.id, { ...session, revokedAt: at });
        revoked += 1;
      }
    }
    return revoked;
  }
}
