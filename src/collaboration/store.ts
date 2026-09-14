/**
 * Durable storage for collaboration Messages and wake requests (prototype #25).
 *
 * A seam, not a detail of SQLite (ADR-0002): the collaboration coordinator never
 * issues a query, and the in-memory implementation is enough for the probe.
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
  CollaborationMessage,
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
    readonly message: CollaborationMessage;
    readonly plan: WakePlan;
    readonly now: number;
  }): Promise<PostMessageResult>;

  getMessage(messageId: string): Promise<CollaborationMessage | undefined>;
  getMessageByDeliveryKey(deliveryKey: string): Promise<CollaborationMessage | undefined>;
  listMessages(): Promise<readonly CollaborationMessage[]>;

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
}

export interface PostMessageResult {
  readonly message: CollaborationMessage;
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
  readonly #messages = new Map<string, CollaborationMessage>();
  readonly #byDeliveryKey = new Map<string, string>();
  readonly #wakes = new Map<string, WakeRequest>();
  /** Every observation recorded, for assertions in tests and the probe. */
  readonly observations: { readonly messageId: string; readonly observation: WakeObservation }[] =
    [];

  async postMessage(input: {
    readonly message: CollaborationMessage;
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

  async getMessage(messageId: string): Promise<CollaborationMessage | undefined> {
    return this.#messages.get(messageId);
  }

  async getMessageByDeliveryKey(deliveryKey: string): Promise<CollaborationMessage | undefined> {
    const id = this.#byDeliveryKey.get(deliveryKey);
    return id === undefined ? undefined : this.#messages.get(id);
  }

  async listMessages(): Promise<readonly CollaborationMessage[]> {
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
    this.observations.push({ messageId: input.messageId, observation: input.observation });
  }

  #wakesFor(messageId: string): readonly WakeRequest[] {
    return [...this.#wakes.values()].filter((wake) => wake.messageId === messageId);
  }
}
