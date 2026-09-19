import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

import type { OperatorCredentialRecord, OperatorSessionStore } from './store.ts';

const CREDENTIAL_KEY_LENGTH = 32;

export interface AuthenticatedBrowserSession {
  readonly id: string;
}

export interface BrowserSessionView {
  readonly id: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly current: boolean;
}

export type SessionAuthentication =
  | { readonly authenticated: true; readonly session: AuthenticatedBrowserSession }
  | { readonly authenticated: false };

/**
 * One-operator credential verification and browser-session lifecycle.
 *
 * The host supplies an initialization/recovery credential only through typed
 * configuration. It is verified with scrypt and a timing-safe digest compare;
 * browser sessions use independent random bearer and request-forgery values,
 * with only SHA-256 digests persisted.
 */
export class OperatorSessionService {
  readonly #store: OperatorSessionStore;
  readonly #clock: () => number;
  readonly #random: (size: number) => Buffer;

  constructor(options: {
    readonly store: OperatorSessionStore;
    readonly clock?: () => number;
    readonly random?: (size: number) => Buffer;
  }) {
    this.#store = options.store;
    this.#clock = options.clock ?? Date.now;
    this.#random = options.random ?? randomBytes;
  }

  /**
   * Initialize a missing identity or recover it with a new host-local credential.
   * Supplying the existing credential is a no-op; a different host credential
   * rotates the identity and durably invalidates every browser session.
   */
  async initializeOrRecover(hostCredential: string | undefined): Promise<void> {
    if (!hostCredential) return;
    const existing = await this.#store.getOperator();
    const now = this.#clock();
    if (!existing) {
      await this.#store.saveOperator(this.#newCredential(hostCredential, 1, now, now));
      return;
    }
    if (verifyCredential(hostCredential, existing)) return;
    await this.#store.saveOperator(this.#newCredential(hostCredential, existing.version + 1, existing.createdAt, now));
    await this.#store.revokeAllSessions(now);
  }

  async isConfigured(): Promise<boolean> {
    return (await this.#store.getOperator()) !== undefined;
  }

  /** Create one browser session after credential verification, never returning its bearer token. */
  async signIn(credential: string): Promise<{ readonly bearerToken: string; readonly csrfToken: string } | undefined> {
    const operator = await this.#store.getOperator();
    if (!operator || !verifyCredential(credential, operator)) return undefined;
    const bearerToken = this.#token();
    const csrfToken = this.#token();
    const now = this.#clock();
    await this.#store.createSession({
      id: this.#token(),
      tokenHash: digest(bearerToken),
      csrfHash: digest(csrfToken),
      credentialVersion: operator.version,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: undefined,
    });
    return { bearerToken, csrfToken };
  }

  async authenticate(bearerToken: string | undefined): Promise<SessionAuthentication> {
    if (!bearerToken) return { authenticated: false };
    const [operator, session] = await Promise.all([
      this.#store.getOperator(),
      this.#store.getSessionByTokenHash(digest(bearerToken)),
    ]);
    if (!operator || !session || session.revokedAt !== undefined || session.credentialVersion !== operator.version) {
      return { authenticated: false };
    }
    await this.#store.touchSession(session.id, this.#clock());
    return { authenticated: true, session: { id: session.id } };
  }

  async verifyRequestForgery(sessionId: string, csrfToken: string | undefined): Promise<boolean> {
    if (!csrfToken) return false;
    const session = (await this.#store.listSessions()).find((candidate) => candidate.id === sessionId);
    return session !== undefined && session.revokedAt === undefined && equalDigest(digest(csrfToken), session.csrfHash);
  }

  async listSessions(currentSessionId: string): Promise<readonly BrowserSessionView[]> {
    return (await this.#store.listSessions())
      .filter((session) => session.revokedAt === undefined)
      .map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        current: session.id === currentSessionId,
      }));
  }

  async revokeSession(id: string): Promise<boolean> {
    return this.#store.revokeSession(id, this.#clock());
  }

  async revokeOtherSessions(currentSessionId: string): Promise<number> {
    return this.#store.revokeSessionsExcept(currentSessionId, this.#clock());
  }

  async revokeCurrentSession(currentSessionId: string): Promise<boolean> {
    return this.revokeSession(currentSessionId);
  }

  #newCredential(credential: string, version: number, createdAt: number, updatedAt: number): OperatorCredentialRecord {
    const credentialSalt = this.#token();
    return {
      credentialSalt,
      credentialHash: deriveCredentialHash(credential, credentialSalt),
      version,
      createdAt,
      updatedAt,
    };
  }

  #token(): string {
    return this.#random(32).toString('base64url');
  }
}

function deriveCredentialHash(credential: string, salt: string): string {
  return scryptSync(credential, salt, CREDENTIAL_KEY_LENGTH).toString('base64');
}

function verifyCredential(credential: string, record: OperatorCredentialRecord): boolean {
  return equalDigest(deriveCredentialHash(credential, record.credentialSalt), record.credentialHash);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64');
}

function equalDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
