/**
 * Durable storage for engine session keys (ADR-0002).
 *
 * A run is one bounded activation, so continuation across runs happens by
 * handing the *next* run the key of the conversation the previous run used. That
 * key is engine-native and only the engine can make sense of it, so Sprout stores
 * it verbatim rather than deriving state from it.
 *
 * The lookup identity is the Agent, engine, Environment instance, immutable
 * execution mode, actual engine host/profile, working directory, and authorized
 * Conversation, Routing batch, or Task scope. Every dimension is load-bearing:
 * a key is issued
 * by one engine, exists in one engine host's store, is tied to the working area,
 * and belongs to one authorization context. The raw directory is reduced to a
 * stable digest before it enters a stored record or SQLite slot.
 *
 * This is a seam, not a detail of SQLite: the orchestrator never issues a query,
 * and the store can be swapped for the in-memory implementation in tests or for a
 * server database later (ADR-0002).
 */

import { createHash } from 'node:crypto';

import { sanitizeIdentifier } from '../environment/privacy.ts';
import { sessionKeyPlacementTuple, sessionKeyScopeTuple, legacyEnvironmentPlacement, legacySessionScope, type HostedExecutionPlacement, type SessionKeyScope } from '../execution-placement.ts';

/** What identifies one continuation slot, independent of the key itself. */
export interface SessionKeyIdentity {
  readonly agentId: string;
  readonly engine: string;
  readonly environmentInstanceId: string;
  readonly executionPlacement?: HostedExecutionPlacement;
  readonly scope?: SessionKeyScope;
  /** The working directory the engine session was created in. */
  readonly workingDirectory: string;
}

/** One stored engine session key and when it was last written. */
export interface StoredSessionKey {
  readonly agentId: string;
  readonly engine: string;
  readonly environmentInstanceId: string;
  readonly executionPlacement: HostedExecutionPlacement;
  readonly scope: SessionKeyScope;
  /** One-way runtime-derived identity for the working directory. */
  readonly workingDirectoryId: string;
  readonly key: string;
  readonly updatedAt: number;
}

/** Input to save; the raw directory is reduced before the store retains it. */
export interface SessionKeyWrite extends SessionKeyIdentity {
  readonly key: string;
  readonly updatedAt: number;
}

export interface SessionKeyStore {
  /** The key for this slot, or `undefined` when none was ever recorded. */
  get(identity: SessionKeyIdentity): Promise<StoredSessionKey | undefined>;
  /** Record (or replace) the key for this slot. */
  save(record: SessionKeyWrite): Promise<void>;
  /** Forget a slot, e.g. after the engine refused the key and started fresh. */
  delete(identity: SessionKeyIdentity): Promise<void>;
  list(): Promise<readonly StoredSessionKey[]>;
}

/**
 * Reduce one working directory to a stable, one-way identifier for durable use.
 *
 * The digest preserves the continuation slot's exact directory boundary across
 * restarts without retaining the host path in SQLite or returned records.
 */
export function workingDirectoryId(workingDirectory: string): string {
  const digest = createHash('sha256').update(workingDirectory, 'utf8').digest('hex');
  const identity = sanitizeIdentifier(digest, { fallback: '', kind: 'digest' });
  if (identity === '') throw new Error('working-directory identity could not be derived');
  return identity;
}

/**
 * One stable string for an identity, used as the store's primary key.
 *
 * JSON-encoding the tuple rather than joining with a delimiter means an identity
 * containing the delimiter cannot collide with another slot.
 */
export function sessionKeyId(identity: SessionKeyIdentity): string {
  return JSON.stringify([
    identity.agentId,
    identity.engine,
    identity.environmentInstanceId,
    ...sessionKeyPlacementTuple(normalizedExecutionPlacement(identity)),
    workingDirectoryId(identity.workingDirectory),
    ...sessionKeyScopeTuple(identity.scope ?? legacySessionScope()),
  ]);
}

export function normalizedExecutionPlacement(identity: SessionKeyIdentity): HostedExecutionPlacement {
  const placement = identity.executionPlacement ?? legacyEnvironmentPlacement(identity.environmentInstanceId);
  if (placement.engineHost === undefined) throw new Error('session key identity requires a recorded engine host');
  return placement as HostedExecutionPlacement;
}

export class InMemorySessionKeyStore implements SessionKeyStore {
  readonly #keys = new Map<string, StoredSessionKey>();
  /** Every record this store was ever asked to persist, in order. */
  readonly writes: StoredSessionKey[] = [];

  async get(identity: SessionKeyIdentity): Promise<StoredSessionKey | undefined> {
    return this.#keys.get(sessionKeyId(identity));
  }

  async save(record: SessionKeyWrite): Promise<void> {
    const stored: StoredSessionKey = {
      agentId: record.agentId,
      engine: record.engine,
      environmentInstanceId: record.environmentInstanceId,
      executionPlacement: normalizedExecutionPlacement(record),
      scope: record.scope ?? legacySessionScope(),
      workingDirectoryId: workingDirectoryId(record.workingDirectory),
      key: record.key,
      updatedAt: record.updatedAt,
    };
    this.#keys.set(sessionKeyId(record), stored);
    this.writes.push(stored);
  }

  async delete(identity: SessionKeyIdentity): Promise<void> {
    this.#keys.delete(sessionKeyId(identity));
  }

  async list(): Promise<readonly StoredSessionKey[]> {
    return [...this.#keys.values()];
  }
}
