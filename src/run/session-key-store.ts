/**
 * Durable storage for engine session keys (ADR-0002).
 *
 * A run is one bounded activation, so continuation across runs happens by
 * handing the *next* run the key of the conversation the previous run used. That
 * key is engine-native and only the engine can make sense of it, so Sprout stores
 * it verbatim rather than deriving state from it.
 *
 * The record's identity is `(agent, engine, environment instance, working
 * directory)`. All four are load-bearing: a key is issued by one engine, recorded
 * inside one environment's engine store, and (for Pi and `opencode`, per #19)
 * coupled to the working directory it was created in. A run whose identity
 * differs must not receive the old key.
 *
 * This is a seam, not a detail of SQLite: the orchestrator never issues a query,
 * and the store can be swapped for the in-memory implementation in tests or for a
 * server database later (ADR-0002).
 */

/** What identifies one continuation slot, independent of the key itself. */
export interface SessionKeyIdentity {
  readonly agentId: string;
  readonly engine: string;
  readonly environmentInstanceId: string;
  /** The working directory the engine session was created in. */
  readonly workingDirectory: string;
}

/** One stored engine session key and when it was last written. */
export interface StoredSessionKey extends SessionKeyIdentity {
  readonly key: string;
  readonly updatedAt: number;
}

export interface SessionKeyStore {
  /** The key for this slot, or `undefined` when none was ever recorded. */
  get(identity: SessionKeyIdentity): Promise<StoredSessionKey | undefined>;
  /** Record (or replace) the key for this slot. */
  save(record: StoredSessionKey): Promise<void>;
  /** Forget a slot, e.g. after the engine refused the key and started fresh. */
  delete(identity: SessionKeyIdentity): Promise<void>;
  list(): Promise<readonly StoredSessionKey[]>;
}

/**
 * One stable string for an identity, used as the store's primary key.
 *
 * JSON-encoding the tuple rather than joining with a delimiter means a working
 * directory containing the delimiter cannot collide with another slot.
 */
export function sessionKeyId(identity: SessionKeyIdentity): string {
  return JSON.stringify([
    identity.agentId,
    identity.engine,
    identity.environmentInstanceId,
    identity.workingDirectory,
  ]);
}

export class InMemorySessionKeyStore implements SessionKeyStore {
  readonly #keys = new Map<string, StoredSessionKey>();
  /** Every record this store was ever asked to persist, in order. */
  readonly writes: StoredSessionKey[] = [];

  async get(identity: SessionKeyIdentity): Promise<StoredSessionKey | undefined> {
    return this.#keys.get(sessionKeyId(identity));
  }

  async save(record: StoredSessionKey): Promise<void> {
    this.#keys.set(sessionKeyId(record), record);
    this.writes.push(record);
  }

  async delete(identity: SessionKeyIdentity): Promise<void> {
    this.#keys.delete(sessionKeyId(identity));
  }

  async list(): Promise<readonly StoredSessionKey[]> {
    return [...this.#keys.values()];
  }
}
