/**
 * The M1 collaboration vocabulary (ticket #26, from the #25 prototype).
 *
 * This is the production Message and wake vocabulary. It mirrors `docs/goal.md`
 * and `CONTEXT.md`, and lives entirely in the core: nothing here is depended on
 * by the engine port or the environment-worker protocol (ADR-0003). Persistence
 * is behind `CollaborationStore` (ADR-0002), with SQLite as the M1 backend.
 *
 * - A **Message** is conversation on a channel. It is deliberately not a Task:
 *   a Task is durable multi-run work with state, while a Message is a single
 *   durable piece of conversation.
 * - A **Wake request** is the durable, per-recipient decision that one Message
 *   should start one Agent run. It is what makes "persistence-before-wake" and
 *   idempotent retry observable.
 * - A **reply** is not a separate entity: it is an Agent-authored Message whose
 *   `inReplyTo` points at the input it answers. Keeping one durable conversation
 *   unit is what stops the run's raw events or private reasoning from becoming a
 *   parallel, unsanitized conversation.
 */

/** Which channel a Message was posted on. */
export type MessageChannel = 'direct' | 'project';

/** Who authored a Message. */
export type AuthorKind = 'human' | 'agent';

export interface MessageAuthor {
  readonly id: string;
  readonly kind: AuthorKind;
}

/**
 * One durable piece of conversation.
 *
 * The minimum fields that make causality from Message to reply reconstructible:
 * the channel it belongs to, who wrote it, what it says, whom it addresses, and
 * an idempotency key so a repeated delivery cannot create a second Message.
 *
 * Deliberately absent: the agent run's events, tool output, and raw reasoning.
 * Those stay in the run record (`AgentRun.events`) and never enter conversation.
 */
export interface Message {
  readonly id: string;
  readonly projectId: string;
  readonly channel: MessageChannel;
  readonly author: MessageAuthor;
  readonly body: string;
  /** Explicit addressees for a direct Message; empty for a project Message. */
  readonly recipients: readonly string[];
  /** Idempotency key: repeated delivery of the same key yields one Message. */
  readonly deliveryKey: string;
  /** The Message this one answers, when it is a reply. */
  readonly inReplyTo?: string;
  readonly createdAt: number;
}

/**
 * Why one recipient was woken.
 *
 * Every value is deterministic except `wake-model` and `wake-model-fail-open`,
 * which are the only outcomes that depend on judgement. Keeping the reason
 * durable is what lets a human see whether an addressed Message was woken
 * directly or routed by the low-cost model.
 */
export type WakeReason =
  /** The Message named this agent as a direct recipient. */
  | 'direct-recipient'
  /** The Message mentioned this agent by exact `@id` on the project channel. */
  | 'agent-mention'
  /** The Message broadcast to the whole project (`@all`). */
  | 'broadcast'
  /** Unaddressed on the project channel; the wake model chose to engage. */
  | 'wake-model'
  /** Unaddressed and the wake model failed; failed open to an extra wake. */
  | 'wake-model-fail-open';

/** The durable lifecycle of one wake request. */
export type WakeStatus =
  /** The decision is durable; no run has been admitted yet. */
  | 'pending'
  /** Exactly one Agent run was admitted for this wake request. */
  | 'admitted'
  /** The wake model deliberately did not engage; recorded, never silent. */
  | 'suppressed'
  /** The wake could not be delivered (unknown member, no environment). */
  | 'failed';

/**
 * The durable per-recipient decision that a Message should start a run.
 *
 * The `(messageId, agentId)` pair is the idempotency identity: a repeated
 * delivery of the same Message reuses the existing wake request instead of
 * admitting a second run.
 */
export interface WakeRequest {
  readonly id: string;
  readonly messageId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly reason: WakeReason;
  readonly status: WakeStatus;
  /** Always `${messageId}:${agentId}`; the store enforces uniqueness. */
  readonly idempotencyKey: string;
  /** The Agent run admitted for this wake, once one was. */
  readonly runId?: string;
  /** Why a wake was suppressed or failed, when there is something to say. */
  readonly detail?: string;
  readonly createdAt: number;
}

/** One recipient the wake contract decided to wake. */
export interface WakeDecision {
  readonly agentId: string;
  readonly reason: WakeReason;
}

/**
 * One durable wake outcome that did **not** admit a run.
 *
 * Suppression and failure are recorded rather than dropped, because "nothing
 * happened" is exactly the state a human cannot distinguish from a bug.
 */
export interface WakeObservation {
  readonly agentId: string;
  readonly status: 'suppressed' | 'failed';
  readonly reason: WakeReason;
  readonly detail: string;
}

/** The pure result of applying the wake contract to one Message. */
export interface WakePlan {
  readonly messageId: string;
  readonly decisions: readonly WakeDecision[];
  readonly observations: readonly WakeObservation[];
}

/** What the low-cost wake model decided about an unaddressed project Message. */
export interface WakeModelVerdict {
  readonly engage: boolean;
  readonly detail?: string;
}

/**
 * The low-cost judgement the M1 wake model performs.
 *
 * It only ever decides *whether* an unaddressed project-channel Message should
 * engage the project. It never picks recipients and never sees an addressed
 * Message: exact mentions, direct recipients, and broadcasts are deterministic.
 * Failing to construct one (or an error inside it) is modelled as a thrown
 * error and handled by the wake contract, which fails open.
 */
export interface WakeModel {
  decide(input: {
    readonly message: Message;
    readonly memberIds: readonly string[];
  }): Promise<WakeModelVerdict>;
}
