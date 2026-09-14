/**
 * Durable storage for collaboration Messages and wake requests (ticket #26).
 *
 * A seam, not a detail of SQLite (ADR-0002): the collaboration coordinator never
 * issues a query, and the in-memory implementation is enough for unit tests.
 * The production backend is `SqliteCollaborationStore`, mounted on the primary
 * `SqliteStore` so collaboration rows share Sprout's one database (ADR-0002).
 *
 * The store's job is to make two invariants durable *before* any wake is
 * attempted:
 *
 * 1. **Persistence-before-wake.** A Message and its wake requests are written
 *    before the coordinator tries to admit any Agent run, so a crash between the
 *    two can only ever lose a wake that has a durable request to recover from —
 *    never a Message.
 * 2. **Idempotent retry.** A repeated delivery key yields exactly one Message,
 *    and a repeated `(messageId, agentId)` wake yields at most one run
 *    admission. Both identities are enforced by the store, not by the caller
 *    remembering to check first.
 */

import type {
  Message,
  WakeObservation,
  WakePlan,
  WakeRequest,
  WakeStatus,
} from './model.ts';

export interface CollaborationStore {
  /**
   * Persist a Message and its wake requests by idempotency key.
   *
   * A second call with an already-stored `deliveryKey` must **not** create a
   * second Message or a second set of wake requests; it returns the existing
   * ones so the caller can observe that this was a retry. This is the guarantee
   * the "repeated delivery key produces one durable input" acceptance check
   * rests on.
   */
  postMessage(input: {
    readonly message: Message;
    readonly plan: WakePlan;
    readonly now: number;
  }): Promise<PostMessageResult>;

  getMessage(messageId: string): Promise<Message | undefined>;
  getMessageByDeliveryKey(deliveryKey: string): Promise<Message | undefined>;
  listMessages(): Promise<readonly Message[]>;

  getWakeRequest(idempotencyKey: string): Promise<WakeRequest | undefined>;
  listWakeRequests(): Promise<readonly WakeRequest[]>;

  /**
   * Claim a wake request for exactly one run admission.
   *
   * Returns `{ admitted: true, wake }` to exactly one caller for a given
   * idempotency key; every later call returns `{ admitted: false, wake }` with
   * the already-admitted record. This is the durable "at most one corresponding
   * wake/run admission" guarantee, and it is deliberately a compare-and-set on
   * the stored record rather than a caller-side check that could race.
   */
  admitWake(input: {
    readonly idempotencyKey: string;
    readonly runId: string;
    readonly now: number;
  }): Promise<AdmitWakeResult>;

  /** Record a non-wake outcome (suppression or failure) for a Message. */
  recordObservation(input: {
    readonly messageId: string;
    readonly observation: WakeObservation;
    readonly now: number;
  }): Promise<void>;

  /**
   * The durable non-wake outcomes recorded for one Message.
   *
   * Suppression and failure are only meaningful if a human can see them, so the
   * contract that records them also exposes them; "nothing happened" must never
   * be the only available answer to "why did this Message wake nobody?".
   */
  listObservations(messageId: string): Promise<readonly WakeObservation[]>;
}

export interface PostMessageResult {
  readonly message: Message;
  readonly wakes: readonly WakeRequest[];
  /** True when the delivery key had already been stored; nothing was added. */
  readonly duplicate: boolean;
}

export interface AdmitWakeResult {
  readonly admitted: boolean;
  readonly wake: WakeRequest;
}

/** Compute the store's stable wake identity. One Message wakes one agent once. */
export function wakeIdempotencyKey(messageId: string, agentId: string): string {
  return `${messageId}:${agentId}`;
}

/** Materialize a wake request from a decision, ready for durable storage. */
export function wakeFromDecision(input: {
  readonly id: string;
  readonly messageId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly reason: WakeRequest['reason'];
  readonly now: number;
}): WakeRequest {
  return {
    id: input.id,
    messageId: input.messageId,
    projectId: input.projectId,
    agentId: input.agentId,
    reason: input.reason,
    status: 'pending' satisfies WakeStatus,
    idempotencyKey: wakeIdempotencyKey(input.messageId, input.agentId),
    createdAt: input.now,
  };
}

/**
 * In-memory collaboration storage.
 *
 * Sufficient for the probe and for unit tests. It enforces the same two
 * idempotency identities as the SQLite implementation, so a test that passes
 * here is a statement about the contract rather than about one backend.
 */
export class InMemoryCollaborationStore implements CollaborationStore {
  readonly #messages = new Map<string, Message>();
  readonly #byDeliveryKey = new Map<string, string>();
  readonly #wakes = new Map<string, WakeRequest>();
  /** Every observation recorded, keyed by the Message it describes. */
  readonly #observations = new Map<string, WakeObservation[]>();

  async postMessage(input: {
    readonly message: Message;
    readonly plan: WakePlan;
    readonly now: number;
  }): Promise<PostMessageResult> {
    const existingId = this.#byDeliveryKey.get(input.message.deliveryKey);
    if (existingId !== undefined) {
      const existing = this.#messages.get(existingId);
      if (existing) {
        return { message: existing, wakes: this.#wakesFor(existing.id), duplicate: true };
      }
    }
    this.#messages.set(input.message.id, input.message);
    this.#byDeliveryKey.set(input.message.deliveryKey, input.message.id);
    for (const decision of input.plan.decisions) {
      const wake = wakeFromDecision({
        id: `wake-${input.message.id}-${decision.agentId}`,
        messageId: input.message.id,
        projectId: input.message.projectId,
        agentId: decision.agentId,
        reason: decision.reason,
        now: input.now,
      });
      this.#wakes.set(wake.idempotencyKey, wake);
    }
    for (const observation of input.plan.observations) {
      await this.recordObservation({
        messageId: input.message.id,
        observation,
        now: input.now,
      });
    }
    return { message: input.message, wakes: this.#wakesFor(input.message.id), duplicate: false };
  }

  async getMessage(messageId: string): Promise<Message | undefined> {
    return this.#messages.get(messageId);
  }

  async getMessageByDeliveryKey(deliveryKey: string): Promise<Message | undefined> {
    const id = this.#byDeliveryKey.get(deliveryKey);
    return id === undefined ? undefined : this.#messages.get(id);
  }

  async listMessages(): Promise<readonly Message[]> {
    return [...this.#messages.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async getWakeRequest(idempotencyKey: string): Promise<WakeRequest | undefined> {
    return this.#wakes.get(idempotencyKey);
  }

  async listWakeRequests(): Promise<readonly WakeRequest[]> {
    return [...this.#wakes.values()];
  }

  async admitWake(input: {
    readonly idempotencyKey: string;
    readonly runId: string;
    readonly now: number;
  }): Promise<AdmitWakeResult> {
    const wake = this.#wakes.get(input.idempotencyKey);
    if (!wake) throw new Error(`unknown wake request: ${input.idempotencyKey}`);
    if (wake.status === 'admitted') return { admitted: false, wake };
    const admitted: WakeRequest = { ...wake, status: 'admitted', runId: input.runId };
    this.#wakes.set(admitted.idempotencyKey, admitted);
    return { admitted: true, wake: admitted };
  }

  async recordObservation(input: {
    readonly messageId: string;
    readonly observation: WakeObservation;
    readonly now: number;
  }): Promise<void> {
    const existing = this.#observations.get(input.messageId) ?? [];
    existing.push(input.observation);
    this.#observations.set(input.messageId, existing);
  }

  async listObservations(messageId: string): Promise<readonly WakeObservation[]> {
    return this.#observations.get(messageId) ?? [];
  }

  #wakesFor(messageId: string): readonly WakeRequest[] {
    return [...this.#wakes.values()].filter((wake) => wake.messageId === messageId);
  }
}
