/**
 * The collaboration coordinator: the core write path (#26, #96).
 *
 * ## The selected write path
 *
 * Three candidate write paths were compared; this module implements the one
 * chosen for M1 — **automatic final-result projection** — and the reasons live
 * in `docs/research/collaboration-write-path.md`. In one line: after a run
 * admitted by a wake request completes, the core projects the run's final
 * assistant message as one Agent-authored reply linked to the input, using
 * nothing but the engine port's `EngineTurnResult`.
 *
 * Why this path and not the alternatives:
 *
 * - It needs **no reachability and no new authentication** inside an
 *   environment. A container publishes no port and a Windows host exposes no
 *   Sprout endpoint today; an agent-facing API/CLI would need both, plus a
 *   per-run credential. Projection happens in the core, so all three topologies
 *   work identically.
 * - It is **engine-neutral** and adds nothing to the worker protocol. The reply
 *   is derived from `EngineTurnResult.text`, which every adapter already
 *   produces; no engine name, method, or collaboration verb enters the core.
 * - It **cannot impersonate**: the authored identity is `run.agentId`, the
 *   record the core itself created, not a value the run supplies.
 *
 * ## The two invariants the path must keep
 *
 * - **Persistence-before-wake.** `deliver` and `publishEvent` persist the input
 *   and every wake request in one store transaction *before* they admit any
 *   run. A crash after the write and before the run leaves a durable wake
 *   request to recover from; it can never leave a run with no input.
 * - **Idempotent retry.** A repeated `deliveryKey` returns the stored input and
 *   its wake requests without adding anything, and `admitWake` is a
 *   compare-and-set, so a repeated delivery key produces at most one run
 *   admission.
 *
 * ## Scope-governed delivery (#96)
 *
 * A Message is delivered to exactly one conversation scope — the Project
 * channel, one Project-scoped direct conversation, or one Working group
 * channel (#95). Before anything is persisted, the acting author's admission
 * state for that scope is checked: an archived Project, a disbanded Working
 * group, or an ended membership refuses delivery with a typed error while the
 * durable history stays readable. The scope is the single source of the
 * Message's `projectId`, `channel`, and (for a direct conversation)
 * participants, so routing can never disagree with scope governance.
 *
 * ## Deterministic routing, no model (#96, ADR-0007)
 *
 * `planWake` and `planEventWake` are pure: direct recipients, exact
 * whole-token mentions, exact `@all` broadcasts, and `addressed` Project
 * events resolve against current Project member facts and never consult a
 * wake model or the Project's wake policy. Unaddressed inputs persist with a
 * durable suppressed observation instead of a guessed wake; wake-model-
 * assisted judgement arrives with routing batches (#97).
 *
 * ## Project events (#96)
 *
 * `publishEvent` requires one explicit routing disposition per event
 * (addressed, wake-eligible, informational, human-action-required,
 * non-routing). Only `addressed` events route, through the same per-input,
 * per-recipient WakeRequest path a Message uses; every other disposition
 * persists the fact without any wake. An event-triggered run projects its
 * final assistant text as a non-routing Agent Message on the Project channel —
 * final text only, exactly like a Message-triggered reply.
 *
 * ## Restart reconciliation
 *
 * `deliver` and `publishEvent` project replies inline after awaiting the
 * admitted run, which is deterministic while the process lives. A process that
 * dies after a run completed but before the reply was projected would
 * otherwise leave the conversation silent forever. `reconcile()` closes that
 * gap: on startup it re-admits any wake that was persisted but never admitted,
 * then re-projects a reply for every admitted wake whose run completed without
 * one, resolving the causal input whether it is a Message or a Project event.
 * All halves are idempotent by construction (the wake CAS and the reply
 * delivery key), so a restart can never duplicate a run or a reply.
 *
 * ## What is deliberately excluded
 *
 * A reply's body is the run's final assistant text only. The run's `events`
 * (tool calls, tool output, notices) and any model reasoning never enter
 * conversation: they stay in the run record, exactly as the O5 hand-off rule
 * already keeps them out of shared context.
 */

import type { AgentRun } from '../run/model.ts';
import type { RunOrchestrator } from '../run/orchestrator.ts';
import { createIdFactory, type IdFactory } from '../ids.ts';
import {
  ConversationScopeError,
  projectChannelScopeId,
  type ConversationScope,
  type ScopeState,
  type ScopeStateReason,
} from '../conversation/model.ts';
import type { ProjectEvent, RoutingDisposition } from './events.ts';
import {
  ProjectEventError,
  requireRoutingDisposition,
  sanitizeProjectEventDetail,
  sanitizeProjectEventKind,
  sanitizeProjectEventSummary,
  sanitizeResponsibleAgents,
} from './events.ts';
import {
  type Message,
  type MessageAuthor,
  type WakeObservation,
  type WakeRequest,
} from './model.ts';
import { planEventWake, planWake, type WakeMember, type WakeScopeFacts } from './wake.ts';
import type { CollaborationStore } from './store.ts';
import { wakeIdempotencyKey } from './store.ts';

/** The slice of the run orchestrator the coordinator uses. */
export interface RunAdmitter {
  submit(request: {
    readonly agentId: string;
    readonly prompt: string;
    /**
     * The causal input's Project, so the run resolves only against it.
     *
     * Every admitted wake names its input's `projectId`. Without it a target
     * Agent that belongs to several Projects could resolve through the wrong
     * one (whichever the registry lists first), silently using another
     * Project's environment and contract. The orchestrator verifies membership
     * in this Project and refuses explicitly rather than falling back.
     */
    readonly projectId: string;
  }): Promise<{ id: string }>;
  waitFor(runId: string): Promise<AgentRun>;
  /**
   * Look up a run without requiring it to exist.
   *
   * Used by reconciliation, where a wake may name a run whose record is no
   * longer present. An unknown run is then simply "no reply to project", not a
   * startup crash. Optional so a minimal admitter (tests, the probe) need not
   * provide it; when absent, `waitFor` is used and an unknown run propagates.
   */
  load?(runId: string): Promise<AgentRun | undefined>;
}

/**
 * The conversation-scope read surface the write path governs delivery against.
 *
 * Structurally satisfied by `ConversationScopeService` (#95): the coordinator
 * needs only the scope record, the acting author's admission state, and the
 * Project's member facts — never a scope mutation.
 */
export interface CollaborationScopePort {
  getScope(scopeId: string): Promise<ConversationScope | undefined>;
  scopeState(scopeId: string, actorId: string): Promise<ScopeState>;
  /**
   * The Project's member facts (current and ended), or `undefined` when the
   * Project does not exist. Routing resolves "current Project Agents" here.
   */
  projectMembers(projectId: string): Promise<readonly WakeMember[] | undefined>;
}

/**
 * A Message delivery refused by its scope's admission state.
 *
 * The typed `reason` is the settled rule that made the scope read-only for the
 * author (ADR-0008); transport maps it to its HTTP contract without
 * re-deriving it.
 */
export class MessageDeliveryError extends Error {
  readonly code = 'scope-read-only' as const;
  readonly reason: ScopeStateReason;

  constructor(reason: ScopeStateReason, message: string) {
    super(message);
    this.name = 'MessageDeliveryError';
    this.reason = reason;
  }
}

export interface CollaborationCoordinatorOptions {
  readonly store: CollaborationStore;
  readonly runs: RunOrchestrator | RunAdmitter;
  readonly scopes: CollaborationScopePort;
  /** Ids for new Messages and Project events. Injected so tests are deterministic. */
  readonly ids?: IdFactory;
  readonly clock?: { now(): number };
  readonly onObservation?: (observation: {
    /** The Message or Project event the observation describes. */
    readonly inputId: string;
    readonly observation: WakeObservation;
  }) => void;
}

/** A request to post one durable Message and wake whoever it addresses. */
export interface DeliverInput {
  /** The conversation scope the Message is posted to. */
  readonly scopeId: string;
  readonly author: MessageAuthor;
  readonly body: string;
  /** Direct Messages may name recipients; channel Messages may not. */
  readonly recipients?: readonly string[];
  /** Idempotency key. Repeating it must not create a second Message. */
  readonly deliveryKey: string;
  /**
   * Whether delivery waits for the addressed run and its projected reply.
   *
   * Ordinary interactive delivery retains the established `true` default. A
   * control-plane relay may opt out so it can observe and stop a very long
   * running Agent through the ordinary run API instead of holding its HTTP
   * request open. The durable wake is still admitted before this returns, and
   * its reply is projected when the run eventually settles.
   */
  readonly awaitReply?: boolean;
}

export interface DeliverResult {
  readonly message: Message;
  /** Every wake request the Message produced, admitted or not. */
  readonly wakes: readonly WakeRequest[];
  /** True when the delivery key had already been seen; nothing new was stored. */
  readonly duplicate: boolean;
  /** Run ids admitted by this delivery, in wake order. */
  readonly admittedRunIds: readonly string[];
}

/** A request to publish one durable Project event (ADR-0007, #96). */
export interface PublishEventInput {
  readonly projectId: string;
  /** The producer-declared stable event kind. */
  readonly kind: string;
  readonly summary: string;
  readonly detail?: string;
  /** Who produced the fact; defaults to the system itself. */
  readonly producer?: ProjectEvent['producer'];
  /**
   * The required routing disposition. Publication refuses a missing or unknown
   * value — there is no default disposition.
   */
  readonly disposition: RoutingDisposition;
  /** Required for `addressed`: the responsible Agent ids. */
  readonly responsibleAgentIds?: readonly string[];
  /** Idempotency key. Repeating it must not create a second event. */
  readonly deliveryKey: string;
  /** Whether publication waits for admitted runs and their projected replies. */
  readonly awaitReply?: boolean;
}

export interface PublishEventResultView {
  readonly event: ProjectEvent;
  readonly wakes: readonly WakeRequest[];
  readonly duplicate: boolean;
  readonly admittedRunIds: readonly string[];
}

/** What one restart reconciliation pass recovered. */
export interface ReconcileResult {
  /** Pending wakes re-admitted by this pass, in wake order. */
  readonly admittedRunIds: readonly string[];
  /**
   * Input Message ids whose reply this pass (re)projected. A wake whose reply
   * was already durable is not listed: reconciliation reports work done, not
   * work inspected.
   */
  readonly projectedMessageIds: readonly string[];
}

/** The causal input of a wake: a Message or a system-produced Project event. */
type RoutingInput = Message | ProjectEvent;

function isProjectEvent(input: RoutingInput): input is ProjectEvent {
  return 'disposition' in input;
}

export class CollaborationCoordinator {
  readonly #store: CollaborationStore;
  readonly #runs: RunAdmitter;
  readonly #scopes: CollaborationScopePort;
  readonly #ids: IdFactory;
  readonly #clock: { now(): number };
  readonly #onObservation: CollaborationCoordinatorOptions['onObservation'];

  constructor(options: CollaborationCoordinatorOptions) {
    this.#store = options.store;
    this.#runs = options.runs;
    this.#scopes = options.scopes;
    this.#ids = options.ids ?? createIdFactory();
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#onObservation = options.onObservation;
  }

  /**
   * Persist one Message in one conversation scope, decide who it wakes, and
   * admit their runs.
   *
   * The order is the contract: **check admission, persist, then wake**. The
   * scope's read-only state is enforced before anything is written; the store
   * writes the Message and its wake requests together; only after that returns
   * does this method ask for run admission, and each admission is itself an
   * idempotent compare-and-set on the stored wake request.
   *
   * Throws `ConversationScopeError('unknown-scope')` for an unknown scope and
   * `MessageDeliveryError` when the scope is read-only for this author.
   */
  async deliver(input: DeliverInput): Promise<DeliverResult> {
    const existing = await this.#store.getMessageByDeliveryKey(input.deliveryKey);
    if (existing) {
      // A retry. No new Message is written, but any wake of this input that is
      // still pending is admitted now: idempotency must not leave addressed work
      // unwoken just because an earlier process died between persist and admit.
      // Admission is a compare-and-set, so this cannot double-admit a wake.
      const admittedRunIds = await this.#admitAll(
        (await this.#store.listWakeRequests()).filter((wake) => wake.inputId === existing.id),
        existing,
        input.awaitReply !== false,
      );
      return {
        message: existing,
        wakes: (await this.#store.listWakeRequests()).filter((w) => w.inputId === existing.id),
        duplicate: true,
        admittedRunIds,
      };
    }

    const scope = await this.#requireWritableScope(input.scopeId, input.author.id);
    const members = await this.#requireMembers(scope.projectId);

    const now = this.#clock.now();
    const message: Message = {
      id: this.#ids.message(),
      projectId: scope.projectId,
      scopeId: scope.id,
      channel: scope.kind,
      author: input.author,
      body: input.body,
      recipients: scope.kind === 'direct' ? (input.recipients ?? []) : [],
      deliveryKey: input.deliveryKey,
      createdAt: now,
    };

    const plan = planWake(message, { members, scope: scopeFacts(scope) });

    const stored = await this.#store.postMessage({ message, plan, now });
    if (stored.duplicate) {
      return { ...stored, admittedRunIds: [] };
    }
    this.#announce(message.id, plan.observations);

    const admittedRunIds = await this.#admitAll(stored.wakes, message, input.awaitReply !== false);
    // Re-read the wake records after admission so the returned result reports
    // the durable state (status + run id) rather than the pre-admission snapshot.
    const finalWakes = (await this.#store.listWakeRequests()).filter(
      (candidate) => candidate.inputId === message.id,
    );
    return { ...stored, wakes: finalWakes, admittedRunIds };
  }

  /**
   * Persist one Project event and, when it is `addressed`, wake its
   * responsible Agents (ADR-0007, #96).
   *
   * The disposition is required and validated here, not at the edge: a missing
   * or unknown disposition, or an `addressed` event without a responsible
   * Agent, is a `ProjectEventError` and nothing is stored. Any other
   * disposition persists the fact with no wake plan at all — the disposition
   * on the durable event *is* the routing evidence.
   */
  async publishEvent(input: PublishEventInput): Promise<PublishEventResultView> {
    const disposition = requireRoutingDisposition({
      disposition: input.disposition,
      responsibleAgentIds: input.responsibleAgentIds,
    });
    if (input.deliveryKey === '') {
      throw new ProjectEventError('invalid-event', 'a Project event requires a delivery key');
    }
    const kind = sanitizeProjectEventKind(input.kind);
    const summary = sanitizeProjectEventSummary(input.summary);
    const detail = sanitizeProjectEventDetail(input.detail);
    const responsibleAgentIds =
      disposition === 'addressed' ? sanitizeResponsibleAgents(input.responsibleAgentIds) : [];

    const existing = await this.#store.getEventByDeliveryKey(input.deliveryKey);
    if (existing) {
      const admittedRunIds = await this.#admitAll(
        (await this.#store.listWakeRequests()).filter((wake) => wake.inputId === existing.id),
        existing,
        input.awaitReply !== false,
      );
      return {
        event: existing,
        wakes: (await this.#store.listWakeRequests()).filter((w) => w.inputId === existing.id),
        duplicate: true,
        admittedRunIds,
      };
    }

    const members = await this.#requireMembers(input.projectId);
    const now = this.#clock.now();
    const event: ProjectEvent = {
      id: this.#ids.projectEvent(),
      projectId: input.projectId,
      kind,
      summary,
      ...(detail !== undefined ? { detail } : {}),
      producer: input.producer ?? { id: 'sprout', kind: 'system' },
      disposition,
      responsibleAgentIds,
      deliveryKey: input.deliveryKey,
      createdAt: now,
    };

    const plan =
      disposition === 'addressed'
        ? planEventWake(event, { members })
        : { inputId: event.id, decisions: [], observations: [] };

    const stored = await this.#store.publishEvent({ event, plan, now });
    if (stored.duplicate) {
      return { ...stored, admittedRunIds: [] };
    }
    this.#announce(event.id, plan.observations);

    const admittedRunIds = await this.#admitAll(stored.wakes, event, input.awaitReply !== false);
    const finalWakes = (await this.#store.listWakeRequests()).filter(
      (candidate) => candidate.inputId === event.id,
    );
    return { ...stored, wakes: finalWakes, admittedRunIds };
  }

  /**
   * Admit every pending wake in a list, in order, and report the runs started.
   *
   * Shared by `deliver`, `publishEvent`, their duplicate paths, and
   * reconciliation: admission is idempotent, so running it on wakes that are
   * already settled is a no-op.
   */
  async #admitAll(
    wakes: readonly WakeRequest[],
    input: RoutingInput,
    awaitReply: boolean,
  ): Promise<readonly string[]> {
    const admittedRunIds: string[] = [];
    for (const wake of wakes) {
      const outcome = await this.#admit(wake, input, awaitReply);
      if (outcome !== undefined) admittedRunIds.push(outcome.runId);
    }
    return admittedRunIds;
  }

  /**
   * Admit one run for a wake request, then project its reply once it settles.
   *
   * Returns the run id and whether a reply was projected when this call won the
   * admission, or `undefined` when the wake was already admitted (a repeated
   * delivery or reconciliation pass) or is not pending.
   */
  async #admit(
    wake: WakeRequest,
    input: RoutingInput,
    awaitReply = true,
  ): Promise<{ readonly runId: string; readonly projected: boolean } | undefined> {
    if (wake.status !== 'pending') return undefined;

    // Submit the run, then admit the wake with a compare-and-set. The order
    // matters: a run submitted but not admitted is the *extra wake* the contract
    // explicitly prefers over a lost one, while an admitted wake always names a
    // run that really exists. The run id is the orchestrator's, never guessed.
    //
    // The causal input's `projectId` is submitted with every wake, so the run
    // can only ever resolve against the Project that owns the input. A target
    // Agent that also belongs to another Project never executes there by
    // accident; the orchestrator refuses a non-member explicitly.
    const submission = await this.#runs.submit({
      agentId: wake.agentId,
      prompt: renderWakePrompt(input, wake.agentId),
      projectId: input.projectId,
    });

    const admitted = await this.#store.admitWake({
      idempotencyKey: wake.idempotencyKey,
      runId: submission.id,
      now: this.#clock.now(),
    });
    if (!admitted.admitted) {
      // Another delivery won the race. The run we just submitted is the extra
      // wake the contract explicitly prefers over a lost one; its reply is not
      // projected, because the winner projects the reply for this wake.
      return undefined;
    }

    // Projection is awaited rather than fire-and-forget so delivery has a
    // deterministic, observable effect: when `deliver` returns, the reply for an
    // admitted wake is durable (or the run settled without producing one).
    if (!awaitReply) {
      // Deliberately retain projection: callers that need to return before a
      // long Agent run settles still receive the normal durable reply later.
      void this.#projectReply(admitted.wake, input).catch(() => undefined);
      return { runId: submission.id, projected: false };
    }
    const projected = await this.#projectReply(admitted.wake, input);
    return { runId: submission.id, projected };
  }

  /**
   * Project a completed run's final assistant message as one Agent reply.
   *
   * Only a `completed` run projects. A failed or interrupted run produces no
   * reply: an answer that was never produced must not be fabricated. The
   * reply's delivery key is derived from the wake idempotency key, so
   * re-running this projection (for example after a restart) can never post
   * two replies for one wake. Returns whether this call actually created the
   * reply (false when the run produced no reply, or when a durable reply
   * already existed).
   *
   * A Message-triggered reply stays in the input's scope and points back with
   * `inReplyTo`. An event-triggered reply lands on the Project channel with no
   * `inReplyTo`: the event is a durable fact, not a piece of conversation to
   * answer inside. Either way the projection is final-text-only and
   * non-routing — it is posted with an empty wake plan, so a projected reply
   * can never open a routing window or wake another Agent (ADR-0007).
   */
  async #projectReply(
    wake: WakeRequest,
    input: RoutingInput,
    options: { readonly awaitSettlement: boolean } = { awaitSettlement: true },
  ): Promise<boolean> {
    const runId = wake.runId;
    if (runId === undefined) return false;
    // The deliver/admit path awaits the run's terminal state, because a reply must
    // not be projected from a half-finished run. Reconciliation instead reads the
    // current durable record: the restart has already settled orphaned runs as
    // failed, so a run is either terminal or genuinely absent — and an absent
    // record must mean "no reply", never an aborted startup.
    const run = options.awaitSettlement
      ? await this.#runs.waitFor(runId)
      : this.#runs.load
        ? await this.#runs.load(runId)
        : await this.#runs.waitFor(runId);
    if (run === undefined || run.status !== 'completed') return false;
    const text = run.result?.status === 'completed' ? run.result.text.trim() : '';
    if (text === '') return false;

    const base = {
      id: replyMessageId(wake),
      projectId: input.projectId,
      author: { id: wake.agentId, kind: 'agent' as const },
      body: text,
      recipients: [] as readonly string[],
      deliveryKey: replyDeliveryKey(wake),
      createdAt: this.#clock.now(),
    };
    const stored = await this.#store.postMessage({
      message: isProjectEvent(input)
        ? { ...base, scopeId: projectChannelScopeId(input.projectId), channel: 'project' as const }
        : { ...base, scopeId: input.scopeId, channel: input.channel, inReplyTo: input.id },
      plan: { inputId: input.id, decisions: [], observations: [] },
      now: this.#clock.now(),
    });
    return !stored.duplicate;
  }

  /**
   * Recover the collaboration write path after a restart.
   *
   * Two recoverable gaps can exist after an abrupt stop, and both are closed
   * here rather than left for a human to notice:
   *
   * 1. **A wake that was persisted but never admitted.** Persistence-before-wake
   *    is what makes this safe to redo; the pending wake is admitted now, exactly
   *    as `deliver` and `publishEvent` would have.
   * 2. **A completed run whose reply was never projected.** The run result is
   *    durable, so the reply is reconstructed from it. The projection is keyed by
   *    the wake idempotency key, so it cannot double-post.
   *
   * The causal input is resolved as a Message first and a Project event second,
   * so an event-triggered wake recovers through the same pass. A run that a
   * restart settled as `failed` or `interrupted` produces no reply: this
   * method never fabricates an answer. The whole pass is idempotent, so
   * running it twice — or on a healthy process — changes nothing.
   */
  async reconcile(): Promise<ReconcileResult> {
    const admittedRunIds: string[] = [];
    // A set: several wakes (for example an `@all` broadcast) can answer the same
    // input, and reconciliation reports each input once, not once per reply.
    const projectedMessageIds = new Set<string>();
    for (const wake of await this.#store.listWakeRequests()) {
      const input = (await this.#store.getMessage(wake.inputId)) ??
        (await this.#store.getEvent(wake.inputId));
      // A wake whose input is missing cannot be reconstructed; it is left alone
      // rather than guessed at, and remains visible in the durable wake list.
      if (input === undefined) continue;

      if (wake.status === 'pending') {
        const outcome = await this.#admit(wake, input);
        if (outcome !== undefined) {
          admittedRunIds.push(outcome.runId);
          if (outcome.projected) projectedMessageIds.add(input.id);
        }
        continue;
      }
      if (wake.status !== 'admitted') continue;

      const projected = await this.#projectReply(wake, input, { awaitSettlement: false });
      if (projected) projectedMessageIds.add(input.id);
    }
    return { admittedRunIds, projectedMessageIds: [...projectedMessageIds] };
  }

  /** Durable state for observability: every Message on record. */
  listMessages(filter?: { readonly scopeId?: string }): Promise<readonly Message[]> {
    return this.#store.listMessages().then((messages) =>
      filter?.scopeId === undefined
        ? messages
        : messages.filter((message) => message.scopeId === filter.scopeId),
    );
  }

  /** Durable state for observability: every Project event on record. */
  listEvents(projectId?: string): Promise<readonly ProjectEvent[]> {
    return this.#store.listEvents(projectId);
  }

  /** Durable state for observability: every wake request on record. */
  listWakeRequests(): Promise<readonly WakeRequest[]> {
    return this.#store.listWakeRequests();
  }

  /**
   * Durable non-wake outcomes for one input (Message or Project event), for
   * observability.
   *
   * This is what lets a human answer "why did this input wake nobody?": a
   * suppression and a failure are both visible here, never silent.
   */
  listObservations(inputId: string): Promise<readonly WakeObservation[]> {
    return this.#store.listObservations(inputId);
  }

  async #requireWritableScope(scopeId: string, actorId: string): Promise<ConversationScope> {
    const state = await this.#scopes.scopeState(scopeId, actorId);
    if (!state.writable) {
      throw new MessageDeliveryError(
        state.reason ?? 'not-a-member',
        `conversation scope ${scopeId} is read-only for ${actorId}` +
          `${state.reason !== undefined ? ` (${state.reason})` : ''}`,
      );
    }
    const scope = await this.#scopes.getScope(scopeId);
    if (scope === undefined) {
      throw new ConversationScopeError('unknown-scope', `unknown conversation scope: ${scopeId}`);
    }
    return scope;
  }

  async #requireMembers(projectId: string): Promise<readonly WakeMember[]> {
    const members = await this.#scopes.projectMembers(projectId);
    if (members === undefined) {
      throw new ConversationScopeError('unknown-project', `unknown project: ${projectId}`);
    }
    return members;
  }

  #announce(inputId: string, observations: readonly WakeObservation[]): void {
    for (const observation of observations) {
      this.#onObservation?.({ inputId, observation });
    }
  }
}

/** The scope facts the wake plan resolves a Message's targets against. */
function scopeFacts(scope: ConversationScope): WakeScopeFacts {
  return scope.kind === 'direct'
    ? { kind: scope.kind, participants: scope.participants }
    : { kind: scope.kind };
}

/**
 * Render one addressed input into the prompt its Agent run receives.
 *
 * The input is presented as conversation (or as the recorded Project fact)
 * with its author or producer and location named, so the agent knows whose
 * work it is answering and where a reply belongs. This is the only thing
 * projected into the run; the core does not pre-summarize or reinterpret it.
 */
export function renderWakePrompt(input: RoutingInput, agentId: string): string {
  const closing = [
    ``,
    `You are ${agentId}. Answer in your final message; that answer becomes your reply to this input. ` +
      `Keep private reasoning and tool output out of it.`,
  ];
  if (isProjectEvent(input)) {
    return [
      `You were woken by the Project event "${input.kind}" in project ${input.projectId}.`,
      ``,
      `${input.producer.kind} ${input.producer.id} recorded:`,
      input.summary,
      ...(input.detail !== undefined ? [input.detail] : []),
      ...closing,
    ].join('\n');
  }
  const where =
    input.channel === 'direct'
      ? 'a direct message'
      : input.channel === 'working-group'
        ? `the Working group channel ${input.scopeId}`
        : 'the project channel';
  return [
    `You were woken by ${where} in project ${input.projectId}.`,
    ``,
    `${input.author.kind} ${input.author.id} wrote:`,
    input.body,
    ...closing,
  ].join('\n');
}

export { wakeIdempotencyKey };

/**
 * The reply's stable identity: derived from the wake it answers.
 *
 * Deriving both the id and the delivery key from the wake idempotency key is
 * what makes reply projection idempotent: a restart, a retry, or two concurrent
 * projectors all address the same reply row, so there is at most one reply per
 * wake.
 */
function replyDeliveryKey(wake: WakeRequest): string {
  return `reply:${wake.idempotencyKey}`;
}

function replyMessageId(wake: WakeRequest): string {
  return `reply-${wake.idempotencyKey}`;
}
