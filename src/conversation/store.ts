/**
 * Durable storage for conversation scopes (ticket #95).
 *
 * A seam, not a detail of SQLite (ADR-0002): the conversation scope service
 * reads and writes through this interface, so the same rules run over the
 * in-memory adapter in tests and the SQLite adapter in production.
 *
 * Each scope is stored as one JSON document keyed by its stable id — a
 * Project channel, one Project-scoped direct conversation, or one Working
 * group with its content versions and membership history — because the
 * versions belong to the scope as a whole and must never be rewritten
 * piecemeal.
 *
 * There is deliberately no lifecycle delete: disbanding and ended membership
 * are statuses and recorded facts (ADR-0008). A save upserts by id, which is
 * what makes the deterministic Project-channel and direct-conversation
 * identities idempotent under a repeated open or a restart. The one removal
 * this seam supports is `remove`, used only to roll back a Project channel
 * row that a failed Project persistence just prepared — it erases a
 * never-published orphan, never a lifecycle fact.
 */

import type { ConversationScope } from './model.ts';

export interface ConversationScopeStore {
  save(scope: ConversationScope): Promise<void>;
  get(scopeId: string): Promise<ConversationScope | undefined>;
  /** Every scope recorded for one Project, oldest first. */
  listForProject(projectId: string): Promise<readonly ConversationScope[]>;
  /** Every durable scope; for reconciliation and observability. */
  list(): Promise<readonly ConversationScope[]>;
  /**
   * Remove one scope row by identity.
   *
   * Reserved for preparation rollback: the Project-channel invariant is
   * recorded during the Project authority's prepare phase, and a Project
   * persistence failure removes the row that preparation created. No
   * lifecycle or history path may call it (ADR-0008: non-destructive).
   */
  remove(scopeId: string): Promise<void>;
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

  async remove(scopeId: string): Promise<void> {
    this.#scopes.delete(scopeId);
  }
}
