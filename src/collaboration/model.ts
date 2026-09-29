/**
 * The collaboration vocabulary: Messages, Project events, and wake requests.
 *
 * This is the production Message, Project-event, and wake vocabulary. It
 * mirrors `docs/goal.md` and `CONTEXT.md`, and lives entirely in the core:
 * nothing here is depended on by the engine port or the environment-worker
 * protocol (ADR-0003). Persistence is behind `CollaborationStore` (ADR-0002),
 * with SQLite as the backend.
 *
 * - A **Message** is one durable piece of Human- or Agent-authored conversation
 *   in exactly one conversation scope: the Project channel, one Project-scoped
 *   direct conversation, or one Working group channel (#95, #96). It is
 *   deliberately not a Task, a run event, or a system-produced Project event.
 * - A **Project event** is a durable system-produced fact exposed in a
 *   Project. Every event declares one **routing disposition** (ADR-0007); only
 *   an `addressed` event routes deterministically, and publication without a
 *   valid disposition is refused.
 * - A **Wake request** is the durable, per-recipient decision that one input
 *   (a Message or a Project event) should start one Agent run. It is what
 *   makes "persistence-before-wake" and idempotent retry observable.
 * - A **reply** is not a separate entity: it is an Agent-authored Message whose
 *   `inReplyTo` points at the Message it answers (an event-triggered reply
 *   lands on the Project channel with no `inReplyTo`). Keeping one durable
 *   conversation unit is what stops the run's raw events or private reasoning
 *   from becoming a parallel, unsanitized conversation.
 *
 * Routing here is deterministic by construction (ADR-0007): the wake contract
 * in `wake.ts` never consults a model. Wake-model-assisted judgement over
 * unaddressed inputs arrives with routing batches (#97), not before.
 */

/**
 * Which conversation scope a Message belongs to.
 *
 * The value mirrors `ConversationScopeKind`: a Message lives in exactly one of
 * the three Project-owned communication contexts (#95, ADR-0008).
 */
export type MessageChannel = 'project' | 'direct' | 'working-group';

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
 * the conversation scope it belongs to, who wrote it, what it says, whom it
 * addresses, and an idempotency key so a repeated delivery cannot create a
 * second Message.
 *
 * `scopeId` is the durable conversation-scope identity (#95). An empty string
 * is only ever a migrated legacy row written before scopes existed: it remains
 * readable history and can never receive a new Message, because delivery
 * resolves its scope first.
 *
 * Deliberately absent: the agent run's events, tool output, and raw reasoning.
 * Those stay in the run record (`AgentRun.events`) and never enter conversation.
 */
export interface Message {
  readonly id: string;
  readonly projectId: string;
  /** The conversation scope this Message was posted to. */
  readonly scopeId: string;
  /** The kind of that scope; redundant with the scope record, kept for reads. */
  readonly channel: MessageChannel;
  readonly author: MessageAuthor;
  readonly body: string;
  /** Explicit addressees for a direct Message; empty for channel Messages. */
  readonly recipients: readonly string[];
  /** Idempotency key: repeated delivery of the same key yields one Message. */
  readonly deliveryKey: string;
  /** The Message this one answers, when it is a reply. */
  readonly inReplyTo?: string;
  readonly createdAt: number;
}

/**
 * Why one recipient was woken, or why an input woke nobody.
 *
 * Every value is deterministic: the plan that produces these never consults a
 * model (ADR-0007). Keeping the reason durable is what lets a human see
 * exactly why an input did or did not start a run.
 */
export type WakeReason =
  /** The input named this agent as a direct recipient. */
  | 'direct-recipient'
  /** The input mentioned this agent by exact whole-token `@id`. */
  | 'agent-mention'
  /** The input broadcast to the whole Project (`@all`). */
  | 'broadcast'
  /** The Project event declared this agent as its responsible target. */
  | 'event-addressed'
  /** No deterministic addressing form applied; the input stayed durable. */
  | 'unaddressed';

/** The durable lifecycle of one wake request. */
export type WakeStatus =
  /** The decision is durable; no run has been admitted yet. */
  | 'pending'
  /** Exactly one Agent run was admitted for this wake request. */
  | 'admitted'
  /** Routing deliberately woke nobody; recorded, never silent. */
  | 'suppressed'
  /** The wake could not be delivered (unknown member, no environment). */
  | 'failed';

/**
 * The durable per-recipient decision that an input should start a run.
 *
 * `inputId` names the causal input: a Message id, or a Project event id for an
 * `addressed` event. The `(inputId, agentId)` pair is the idempotency
 * identity: a repeated delivery of the same input reuses the existing wake
 * request instead of admitting a second run.
 */
export interface WakeRequest {
  readonly id: string;
  readonly inputId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly reason: WakeReason;
  readonly status: WakeStatus;
  /** Always `${inputId}:${agentId}`; the store enforces uniqueness. */
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

/** The pure result of applying the wake contract to one input. */
export interface WakePlan {
  /** The Message or Project event this plan was computed for. */
  readonly inputId: string;
  readonly decisions: readonly WakeDecision[];
  readonly observations: readonly WakeObservation[];
}
