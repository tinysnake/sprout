/**
 * Durable storage for conversation scopes (ticket #95).
 *
 * A seam, not a detail of SQLite (ADR-0002): the conversation scope service
 * reads and writes through this interface, so the same rules run over the
 * in-memory adapter in tests and the SQLite adapter in production.
 *
 * Each scope is stored as one JSON document keyed by its stable id — a
 * Project channel, one Project-scoped direct conversation, one Working group
 * with its content versions and membership history, or one Task group bound
 * to a Task — because the versions belong to the scope as a whole and must
 * never be rewritten piecemeal.
 *
 * `update` is the one way a recorded document is rewritten: the row read, the
 * synchronous mutation, and the conditional write form one uninterruptible
 * critical section, so no interleaved command can overwrite an accepted
 * change, and a mutation computed from a row that changed since that read is
 * refused (`stale-scope-write`) instead of written (ADR-0008: every accepted
 * transition stays durable and attributable, and a stale command cannot
 * succeed).
 *
 * There is deliberately no lifecycle delete: disbanding and ended membership
 * are statuses and recorded facts (ADR-0008). A save upserts by id, which is
 * what makes the deterministic Project-channel and direct-conversation
 * identities idempotent under a repeated open or a restart. The one removal
 * this seam supports is `removeProjectChannel`, fenced in storage to rows of
 * kind `project`: it rolls back or reaps an interrupted Project-channel
 * preparation — a never-published orphan — and can never erase a Working
 * group's lifecycle, membership, or content history.
 */

import { ConversationScopeError, type ConversationScope } from './model.ts';

export interface ConversationScopeStore {
  save(scope: ConversationScope): Promise<void>;
  get(scopeId: string): Promise<ConversationScope | undefined>;
  /** Every scope recorded for one Project, oldest first. */
  listForProject(projectId: string): Promise<readonly ConversationScope[]>;
  /** Every durable scope; for reconciliation and observability. */
  list(): Promise<readonly ConversationScope[]>;
  /**
   * Atomically read-modify-write one scope row.
   *
   * The row is read, `mutate` runs synchronously against that read, and the
   * result is written conditionally — with no yield to the event loop in
   * between — so within this process the mutation observes the freshest row
   * and its result cannot be lost to a concurrent command. The write is
   * conditional on the document that was read: if the row changed underneath
   * (a second writer on the same file), the stale result is refused with
   * `stale-scope-write` rather than overwriting the accepted change.
   *
   * `mutate` returning `undefined` (or throwing) writes nothing. Adapters
   * must never `await` inside this operation: the synchronous span *is* the
   * serialization.
   */
  update(
    scopeId: string,
    mutate: (current: ConversationScope | undefined) => ConversationScope | undefined,
  ): Promise<ConversationScope | undefined>;
  /**
   * Remove one Project-channel row by identity; a missing row is a no-op.
   *
   * Fenced in storage to rows of kind `project`: a row carrying any other
   * kind — a Working group or Task group with durable history — is refused.
   * Used only to roll back or reap an interrupted Project-channel preparation
   * (ADR-0008: lifecycle facts are never deleted).
   */
  removeProjectChannel(scopeId: string): Promise<void>;
}

/** In-memory adapter: the contract, with a write trace tests can assert on. */
export class InMemoryConversationScopeStore implements ConversationScopeStore {
  readonly #scopes = new Map<string, ConversationScope>();
  /** Every state this store was ever asked to persist, in order. */
  readonly writes: ConversationScope[] = [];

  async save(scope: ConversationScope): Promise<void> {
    this.#scopes.set(scope.id, scope);
    this.writes.push(scope);
  }

  async get(scopeId: string): Promise<ConversationScope | undefined> {
    return this.#scopes.get(scopeId);
  }

  async listForProject(projectId: string): Promise<readonly ConversationScope[]> {
    return [...this.#scopes.values()]
      .filter((scope) => scope.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async list(): Promise<readonly ConversationScope[]> {
    return [...this.#scopes.values()].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  }

  async update(
    scopeId: string,
    mutate: (current: ConversationScope | undefined) => ConversationScope | undefined,
  ): Promise<ConversationScope | undefined> {
    // Critical section: read, synchronous mutation, conditional write. This
    // method must not await — no other command runs until it returns, so the
    // mutation sees the freshest row and its result lands unobserved.
    const current = this.#scopes.get(scopeId);
    const next = mutate(current);
    if (next === undefined) return undefined;
    // The write is conditional on the row that was read: anything changing it
    // under the mutation (a foreign writer, or a competing save inside the
    // callback) makes this stale result refuse instead of overwrite.
    if (this.#scopes.get(scopeId) !== current) {
      throw new ConversationScopeError(
        'stale-scope-write',
        `conversation scope ${scopeId} changed while the command was running; the stale write was refused`,
      );
    }
    this.#scopes.set(scopeId, next);
    this.writes.push(next);
    return next;
  }

  async removeProjectChannel(scopeId: string): Promise<void> {
    const current = this.#scopes.get(scopeId);
    if (current === undefined) return;
    if (current.kind !== 'project') {
      throw new Error(
        `refusing to remove ${scopeId}: only a Project-channel row is removable, never a ${current.kind} record`,
      );
    }
    this.#scopes.delete(scopeId);
  }
}
