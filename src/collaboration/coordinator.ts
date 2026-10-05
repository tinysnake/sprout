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
 * Message's `projectId`, `channel`, and current participants (the pair for a
 * direct conversation, the group's active participations for a Working group),
 * so routing can never disagree with scope governance.
 *
 * ## Deterministic routing first, then batches (#96, #97, ADR-0007)
 *
 * `planWake` and `planEventWake` are pure: direct recipients, exact
 * whole-token mentions, exact `@all` broadcasts, and `addressed` Project
 * events resolve against current Project member facts — and, for direct and
 * Working-group scopes, against that scope's current participants — and never
 * consult a wake model or the Project's wake policy. An input with no
 * deterministic address either records a durable suppressed observation
 * (`explicit-only`) or joins the Project's fixed routing window
 * (`wake-model-assisted`), where the frozen batch — never the plan — reaches a
 * wake model (#97).
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
 * ## Run-lifecycle failure events (#180)
 *
 * The settlement stream that ends a run also publishes its system Project
 * event when that run fails: the coordinator subscribes to the run orchestrator
 * once, and every Project-scoped terminal failure becomes one durable
 * `informational` `agent-run-failure` event (the producer projection lives in
 * `run-failure-events.ts`). A process that dies between settlement and
 * publication is repaired by `reconcile()`, which scans every durable run and
 * publishes the same delivery key — so the live stream and the restart pass
 * can never produce two events for one terminal transition. The event wakes
 * nobody: `informational` is durable context, never routing (ADR-0007).
 *
 * ## What is deliberately excluded
 *
 * A reply's body is the run's final assistant text only. The run's `events`
 * (tool calls, tool output, notices) and any model reasoning never enter
 * conversation: they stay in the run record, exactly as the O5 hand-off rule
 * already keeps them out of shared context.
 */

import type { AgentRun, RunObserver } from '../run/model.ts';
import type { RunOrchestrator } from '../run/orchestrator.ts';
import { createIdFactory, type IdFactory } from '../ids.ts';
import { redactSensitiveText, sanitizeIdentifier } from '../environment/privacy.ts';
import {
  ConversationScopeError,
  projectChannelScopeId,
  type ConversationScope,
  type ScopeState,
  type ScopeStateReason,
} from '../conversation/model.ts';
import type { ConversationProjectFacts } from '../conversation/service.ts';
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
import {
  type RoutingAttempt,
  type RoutingBatch,
  type RoutingBatchInput,
  type RoutingBounds,
  type RoutingFailureKind,
  type RoutingInputOutcome,
  type RoutingModelPort,
  type RoutingWindow,
} from './routing.ts';
import {
  freezeRoutingBatches,
  type RoutingContractFacts,
  type RoutingContextMessage,
  type RoutingInputFact,
} from './routing-context.ts';
import {
  parseRoutingJudgement,
  type JudgementExpectation,
  type JudgementParseResult,
  type RoutingJudgement,
} from './routing-judgement.ts';
import type {
  CollaborationStore,
  ProjectEventPage,
  ProjectEventPageQuery,
} from './store.ts';
import { DEFAULT_PROJECT_EVENT_PAGE_SIZE, wakeFromBatch, wakeIdempotencyKey } from './store.ts';
import { runFailureEventInput } from './run-failure-events.ts';
import { runInterruptionEventInput } from './run-interruption-events.ts';

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
  /**
   * The durable settlement stream of this process's runs (#180).
   *
   * When present, the coordinator subscribes once so a Project-scoped terminal
   * failure publishes its system event the moment the run settles. An admitter
   * without the stream (tests, the probe) leaves publication entirely to the
   * restart reconciliation scan over `list`, which uses the same delivery key.
   */
  subscribe?(observer: RunObserver): () => void;
  /**
   * Every durable run, including ones a previous process recorded (#180).
   *
   * Restart reconciliation scans it for Project-scoped terminal failures whose
   * event was never published — the process died between settlement and
   * publication. Optional like `load`, so minimal admitters need not provide it.
   */
  list?(): Promise<readonly AgentRun[]>;
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
  /**
   * The wake policy and fixed routing interval in force (#97). Optional: a
   * port without it behaves as `explicit-only`, so a missing composition can
   * never collect inputs into a window by accident.
   */
  routingPolicy?(projectId: string): Promise<
    { readonly wakePolicy: 'explicit-only' | 'wake-model-assisted'; readonly intervalMs: number } | undefined
  >;
  /**
   * The Project-shared contract facts a routing context freezes (#97): goal,
   * rules, and member responsibilities. Optional like `routingPolicy`; without
   * it an assisted Project fails closed rather than freezing an empty context.
   */
  projectContract?(projectId: string): Promise<ConversationProjectFacts | undefined>;
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
  /**
   * The wake model for assisted routing batches (#97). Absent means every
   * attempt fails as `model-unavailable`, retries once on the identical
   * snapshot, and fails closed with visible per-input failures — ADR-0007's
   * rule for a missing model, never silence and never fail-open fan-out.
   * Configuring a real low-cost wake model is explicit future work
   * (docs/roadmap.md M2 evidence note).
   */
  readonly routingModel?: RoutingModelPort;
  /** Awaited after durable settlement, with the coordinator's actual attempt identity. */
  readonly onRoutingAttempt?: (attempt: RoutingAttempt, projectId: string) => Promise<void>;
  /** Per-attempt wake-model timeout; defaults to 30 seconds. */
  readonly routingAttemptTimeoutMs?: number;
  /** Bounds overrides; defaults to `DEFAULT_ROUTING_BOUNDS`. Tests shrink them. */
  readonly routingBounds?: Partial<RoutingBounds>;
}

/** A request to post one durable Message and wake whoever it addresses. */
export interface DeliverInput {
  /** Optional runtime authority fence, checked after lookups before durable delivery. */
  readonly assertActive?: () => void;
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
  /**
   * Run ids whose system failure event this pass published (#180). A run whose
   * event was already durable (published by the live settlement stream) is not
   * listed: one event per terminal transition, reported as work done.
   */
  readonly failureEventRunIds: readonly string[];
}

/** The causal input of a wake: a Message or a system-produced Project event. */
type RoutingInput = Message | ProjectEvent;

function isProjectEvent(input: RoutingInput): input is ProjectEvent {
  return 'disposition' in input;
}

/**
 * One wake's resolved causal source (#97).
 *
 * A deterministic wake resolves to its Message or Project event; a
 * model-assisted wake resolves to its frozen batch plus the batch inputs
 * actually assigned to that wake's Agent — the facts its prompt and reply
 * placement derive from.
 */
type ResolvedRoutingSource =
  | { readonly kind: 'input'; readonly input: RoutingInput }
  | {
      readonly kind: 'batch';
      readonly batch: RoutingBatch;
      /** The batch inputs assigned to this wake's Agent, chronological. */
      readonly assigned: readonly RoutingInput[];
    };

function sourceTouchesScope(source: ResolvedRoutingSource, scopeId: string): boolean {
  const inputs = source.kind === 'batch' ? source.assigned : [source.input];
  return inputs.some((input) => isProjectEvent(input)
    ? scopeId === projectChannelScopeId(input.projectId)
    : input.scopeId === scopeId);
}

function sourceProjectId(source: ResolvedRoutingSource): string {
  return source.kind === 'batch' ? source.batch.projectId : source.input.projectId;
}

/** The durable causal identity a reply or observation keys on for this source. */
function sourceCausalId(source: ResolvedRoutingSource): string {
  return source.kind === 'batch' ? source.batch.id : source.input.id;
}

function renderSourcePrompt(source: ResolvedRoutingSource, agentId: string): string {
  if (source.kind === 'batch') {
    return renderBatchWakePrompt(agentId, source.batch, source.assigned);
  }
  return renderWakePrompt(source.input, agentId);
}

export class CollaborationCoordinator {
  readonly #store: CollaborationStore;
  readonly #runs: RunAdmitter;
  readonly #scopes: CollaborationScopePort;
  readonly #ids: IdFactory;
  readonly #clock: { now(): number };
  readonly #onObservation: CollaborationCoordinatorOptions['onObservation'];
  readonly #routingModel: RoutingModelPort | undefined;
  readonly #onRoutingAttempt: CollaborationCoordinatorOptions['onRoutingAttempt'];
  readonly #attemptTimeoutMs: number;
  readonly #routingBounds: Partial<RoutingBounds> | undefined;
  /** Routing ids for an injected factory that predates routing (#97). */
  readonly #fallbackIds = createIdFactory();
  /** Best-effort in-process deadline timers; durability is the sweep's job. */
  readonly #windowTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One sweep at a time: freeze and submit are serialized, never racing. */
  #sweepInFlight: Promise<void> | undefined;

  constructor(options: CollaborationCoordinatorOptions) {
    this.#store = options.store;
    this.#runs = options.runs;
    this.#scopes = options.scopes;
    this.#ids = options.ids ?? createIdFactory();
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#onObservation = options.onObservation;
    this.#routingModel = options.routingModel;
    this.#onRoutingAttempt = options.onRoutingAttempt;
    this.#attemptTimeoutMs = options.routingAttemptTimeoutMs ?? 30_000;
    this.#routingBounds = options.routingBounds;

    // The live run-lifecycle failure producer (#180). The subscription lives as
    // long as the orchestrator it belongs to (both are process-lifetime), and
    // the event's run-id delivery key makes this path and restart
    // reconciliation converge on one event instead of racing for a second.
    if (typeof options.runs.subscribe === 'function') {
      options.runs.subscribe((run) => {
        if (run.status === 'failed') {
          void this.publishRunFailure(run).catch(() => {
            // Never let publication failure disturb the run path. The durable run
            // remains the authority and the next restart reconciliation publishes
            // the same delivery key; the log names no prompt, error text, or host.
            process.stderr.write(
              `[collaboration] run failure event for run ${run.id} is deferred to restart reconciliation\n`,
            );
          });
        } else if (run.status === 'interrupted' && run.interruptionReason === 'human-stop') {
          void this.publishRunInterruption(run).catch(() => {
            process.stderr.write(
              `[collaboration] run interruption event for run ${run.id} is deferred to restart reconciliation\n`,
            );
          });
        }
      });
    }
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
      const pending = (await this.#store.listWakeRequests()).filter((wake) => wake.inputId === existing.id);
      input.assertActive?.();
      const admittedRunIds = await this.#admitAll(
        pending,
        { kind: 'input', input: existing },
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
    const routingPolicy = await this.#routingPolicyOf(scope.projectId);

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

    const plan = planWake(message, {
      members,
      scope: scopeFacts(scope),
      wakePolicy: routingPolicy.wakePolicy,
    });

    // A batch-eligible input joins its Project's fixed routing window in the
    // same store transaction as the Message itself (#97): a crash between the
    // two can never leave an eligible input outside every window.
    const collect =
      plan.batchEligible === true ? { intervalMs: routingPolicy.intervalMs } : undefined;
    input.assertActive?.();
    const stored = await this.#store.postMessage({
      message,
      plan,
      now,
      ...(collect !== undefined ? { collect } : {}),
    });
    if (stored.duplicate) {
      return { ...stored, admittedRunIds: [] };
    }
    this.#announce(message.id, plan.observations);
    if (stored.window !== undefined) this.#afterWindowJoin(stored.window);

    const admittedRunIds = await this.#admitAll(stored.wakes, { kind: 'input', input: message }, input.awaitReply !== false);
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
        { kind: 'input', input: existing },
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
    const routingPolicy = await this.#routingPolicyOf(input.projectId);
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

    const plan = planEventWake(event, { members, wakePolicy: routingPolicy.wakePolicy });
    const collect =
      plan.batchEligible === true ? { intervalMs: routingPolicy.intervalMs } : undefined;
    const stored = await this.#store.publishEvent({
      event,
      plan,
      now,
      ...(collect !== undefined ? { collect } : {}),
    });
    if (stored.duplicate) {
      return { ...stored, admittedRunIds: [] };
    }
    this.#announce(event.id, plan.observations);
    if (stored.window !== undefined) this.#afterWindowJoin(stored.window);

    const admittedRunIds = await this.#admitAll(stored.wakes, { kind: 'input', input: event }, input.awaitReply !== false);
    const finalWakes = (await this.#store.listWakeRequests()).filter(
      (candidate) => candidate.inputId === event.id,
    );
    return { ...stored, wakes: finalWakes, admittedRunIds };
  }

  /**
   * Publish the durable system failure event for one run (#180).
   *
   * Idempotent by construction: the event's delivery key is the run id, so the
   * live settlement stream, a repeated observation of the same failed run, and
   * restart reconciliation all converge on one durable event. Non-failure runs,
   * non-terminal runs, and runs with no Project scope are skipped without a
   * trace — there is no failure to report and no timeline to report it in.
   */
  async publishRunFailure(run: AgentRun): Promise<'skipped' | 'duplicate' | 'published'> {
    const input = runFailureEventInput(run);
    if (input === undefined) return 'skipped';
    const result = await this.publishEvent(input);
    return result.duplicate ? 'duplicate' : 'published';
  }

  /** Publish one informational event for an intentional Human Chat interruption. */
  async publishRunInterruption(run: AgentRun): Promise<'skipped' | 'duplicate' | 'published'> {
    const input = runInterruptionEventInput(run);
    if (input === undefined) return 'skipped';
    const result = await this.publishEvent(input);
    return result.duplicate ? 'duplicate' : 'published';
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
    source: ResolvedRoutingSource,
    awaitReply: boolean,
  ): Promise<readonly string[]> {
    const admittedRunIds: string[] = [];
    for (const wake of wakes) {
      const outcome = await this.#admit(wake, source, awaitReply);
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
    source: ResolvedRoutingSource,
    awaitReply = true,
  ): Promise<{ readonly runId: string; readonly projected: boolean } | undefined> {
    if (wake.status !== 'pending') return undefined;

    // Submit the run, then admit the wake with a compare-and-set. The order
    // matters: a run submitted but not admitted is the *extra wake* the contract
    // explicitly prefers over a lost one, while an admitted wake always names a
    // run that really exists. The run id is the orchestrator's, never guessed.
    //
    // The causal source's `projectId` is submitted with every wake, so the run
    // can only ever resolve against the Project that owns the input. A target
    // Agent that also belongs to another Project never executes there by
    // accident; the orchestrator refuses a non-member explicitly.
    const submission = await this.#runs.submit({
      agentId: wake.agentId,
      prompt: renderSourcePrompt(source, wake.agentId),
      projectId: sourceProjectId(source),
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
      void this.#projectReply(admitted.wake, source).catch(() => undefined);
      return { runId: submission.id, projected: false };
    }
    const projected = await this.#projectReply(admitted.wake, source);
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
    source: ResolvedRoutingSource,
    options: { readonly awaitSettlement: boolean; readonly runId?: string } = { awaitSettlement: true },
  ): Promise<boolean> {
    // A bounded reconnect retry (#181) projects through the same wake, keyed
    // by the same reply identity: the original run id unless the caller names
    // the linked retry run that actually produced the answer.
    const runId = options.runId ?? wake.runId;
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
      projectId: sourceProjectId(source),
      author: { id: wake.agentId, kind: 'agent' as const },
      body: text,
      recipients: [] as readonly string[],
      deliveryKey: replyDeliveryKey(wake),
      createdAt: this.#clock.now(),
    };
    const placement =
      source.kind === 'batch'
        ? batchReplyPlacement(source.batch.projectId, source.assigned)
        : isProjectEvent(source.input)
          ? {
              scopeId: projectChannelScopeId(source.input.projectId),
              channel: 'project' as const,
            }
          : {
              scopeId: source.input.scopeId,
              channel: source.input.channel,
              inReplyTo: source.input.id,
            };
    const stored = await this.#store.postMessage({
      message: { ...base, ...placement },
      plan: { inputId: sourceCausalId(source), decisions: [], observations: [] },
      now: this.#clock.now(),
    });
    return !stored.duplicate;
  }

  /**
   * Project the reply of a bounded reconnect retry (#181) for the wake whose
   * original run failed before an engine could accept it.
   *
   * The reply keeps the wake's own identity and delivery key, so at most one
   * reply per wake can ever exist no matter how often reconciliation or a
   * repeated settle runs this. A retry that failed again (or a wake with no
   * causal source) projects nothing — an answer that was never produced is
   * never fabricated. Returns whether this call created the reply.
   */
  async projectRetryReply(input: {
    readonly originalRunId: string;
    readonly retryRunId: string;
  }): Promise<boolean> {
    const wake = (await this.#store.listWakeRequests()).find(
      (candidate) => candidate.runId === input.originalRunId,
    );
    if (wake === undefined || wake.status !== 'admitted') return false;
    const source = await this.#resolveWakeSource(wake);
    if (source === undefined) return false;
    return this.#projectReply(wake, source, {
      awaitSettlement: false,
      runId: input.retryRunId,
    });
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
   * 3. **A Project-scoped terminal run failure whose system event was never
   *    published.** The run record is durable, so the `agent-run-failure` event
   *    is reconstructed from it and keyed by the run id, so this scan and the
   *    live settlement stream can never both create the event (#180).
   *
   * The causal input is resolved as a Message first and a Project event second
   * for deterministic wakes; a model-assisted wake resolves through its frozen
   * batch and assigned inputs, so an event- or batch-triggered wake recovers
   * through the same pass. A run that a restart settled as `failed` or
   * `interrupted` produces no reply: this method never fabricates an answer.
   * The whole pass is idempotent, so running it twice — or on a healthy
   * process — changes nothing.
   *
   * Routing is swept first: an elapsed collection window is closed and
   * submitted immediately, and a frozen batch interrupted before judgement
   * resumes, both guarded by compare-and-set so a restart never splits the
   * same window twice or judges one batch twice.
   */
  async reconcile(): Promise<ReconcileResult> {
    // Repair the crash boundary between durable attempt settlement and its
    // usage observer. Replaying facts never invokes the model or invents tokens.
    if (this.#onRoutingAttempt !== undefined) {
      for (const batch of await this.#store.listRoutingBatches()) {
        for (const attempt of await this.#store.listRoutingAttempts(batch.id)) {
          if (attempt.status !== 'started') await this.#onRoutingAttempt(attempt, batch.projectId);
        }
      }
    }
    await this.sweepRouting();
    const admittedRunIds: string[] = [];
    // A set: several wakes (for example an `@all` broadcast) can answer the same
    // input, and reconciliation reports each causal identity once, not once per
    // reply (a batch wake reports its batch id).
    const projectedMessageIds = new Set<string>();
    for (const wake of await this.#store.listWakeRequests()) {
      const source = await this.#resolveWakeSource(wake);
      // A wake whose causal source is missing cannot be reconstructed; it is
      // left alone rather than guessed at, and remains visible in the durable
      // wake list.
      if (source === undefined) continue;
      const causalId = sourceCausalId(source);

      if (wake.status === 'pending') {
        const outcome = await this.#admit(wake, source);
        if (outcome !== undefined) {
          admittedRunIds.push(outcome.runId);
          if (outcome.projected) projectedMessageIds.add(causalId);
        }
        continue;
      }
      if (wake.status !== 'admitted') continue;

      const projected = await this.#projectReply(wake, source, { awaitSettlement: false });
      if (projected) projectedMessageIds.add(causalId);
    }

    // The failure-event scan runs over durable runs rather than wakes: a Task
    // run or an admission failure has no wake to hang the event on, and its
    // Project-scoped terminal failure is equally a fact the operator must see.
    const failureEventRunIds: string[] = [];
    for (const run of this.#runs.list !== undefined ? await this.#runs.list() : []) {
      try {
        if ((await this.publishRunFailure(run)) === 'published') failureEventRunIds.push(run.id);
        await this.publishRunInterruption(run);
      } catch {
        // One unreadable Project must not abort the pass: the durable run stays
        // visible and the next pass retries the same delivery key.
      }
    }
    return {
      admittedRunIds,
      projectedMessageIds: [...projectedMessageIds],
      failureEventRunIds,
    };
  }

  /** Durable state for observability: every Message on record. */
  listMessages(filter?: { readonly scopeId?: string }): Promise<readonly Message[]> {
    return this.#store.listMessages().then((messages) =>
      filter?.scopeId === undefined
        ? messages
        : messages.filter((message) => message.scopeId === filter.scopeId),
    );
  }

  /** Bounded, stable page for the browser conversation view. */
  async listMessagesPage(query: { readonly scopeId?: string; readonly limit: number; readonly before?: string }) {
    return this.#store.listMessagesPage(query);
  }

  /** Durable state for observability: every Project event on record. */
  async listEvents(projectId?: string): Promise<readonly ProjectEvent[]> {
    return this.#projectEvents(await this.#store.listEvents(projectId));
  }

  /** Bounded Project event page, optionally filtered to its causal chat origin. */
  async listEventsPage(query: ProjectEventPageQuery & { readonly originScopeId?: string }): Promise<ProjectEventPage | undefined> {
    if (query.originScopeId === undefined) {
      const page = await this.#store.listEventsPage(query);
      return page === undefined ? undefined : { ...page, events: await this.#projectEvents(page.events) };
    }

    const matching: ProjectEvent[] = [];
    let cursor = query.before;
    let hasOlder = false;
    const scanLimit = Math.max(query.limit + 1, DEFAULT_PROJECT_EVENT_PAGE_SIZE);
    while (matching.length <= query.limit) {
      const page = await this.#store.listEventsPage({
        projectId: query.projectId,
        limit: scanLimit,
        ...(cursor !== undefined ? { before: cursor } : {}),
      });
      if (page === undefined) return undefined;
      const projected = await this.#projectEvents(page.events);
      for (const event of [...projected].reverse()) {
        if (event.originScopeIds?.includes(query.originScopeId)) matching.push(event);
        if (matching.length > query.limit) break;
      }
      if (matching.length > query.limit) { hasOlder = true; break; }
      if (!page.hasOlder) break;
      const oldest = page.events[0]?.id;
      if (oldest === undefined || oldest === cursor) break;
      cursor = oldest;
    }
    return { events: matching.slice(0, query.limit).reverse(), hasOlder };
  }

  async #projectEvents(events: readonly ProjectEvent[]): Promise<readonly ProjectEvent[]> {
    const wakes = await this.#store.listWakeRequests();
    return Promise.all(events.map(async (event) => {
      const isFailure = event.kind === 'agent-run-failure' && event.producer.kind === 'system' &&
        event.deliveryKey.startsWith('run-failure:');
      const isInterruption = event.kind === 'agent-run-interruption' && event.producer.kind === 'system' &&
        event.deliveryKey.startsWith('run-interruption:');
      if (!isFailure && !isInterruption) return event;
      const prefix = isFailure ? 'run-failure:' : 'run-interruption:';
      const runId = event.deliveryKey.slice(prefix.length);
      const run = await this.#loadRun(runId);
      const origins = new Set<string>();
      for (const wake of wakes) {
        // Missing run links are not causal evidence: two unset IDs must never
        // make an unrelated pending wake an origin of this failure notice.
        if (wake.projectId !== event.projectId || wake.runId === undefined ||
            (wake.runId !== runId &&
             (run?.retryOfRunId === undefined || wake.runId !== run.retryOfRunId))) continue;
        const source = await this.#resolveWakeSource(wake);
        const inputs = source?.kind === 'batch' ? source.assigned : source ? [source.input] : [];
        for (const input of inputs) {
          if (!isProjectEvent(input) && input.projectId === event.projectId) origins.add(input.scopeId);
        }
      }
      // Placement is reconstructed from durable causality on every read. A
      // fast settlement published before admitWake commits gains its origin
      // only once that link is durable; historical events use the same path,
      // without duplicating facts or waking anyone.
      // Historical identifier-only events retain their durable identity while
      // their read projection explains the persisted outcome. No replay or
      // mutation of the Project record is needed after deploying this repair.
      const outcome = isFailure
        ? run?.projectId === event.projectId ? runFailureEventInput(run) : undefined
        : run?.projectId === event.projectId ? runInterruptionEventInput(run) : undefined;
      const detail = sanitizeProjectEventDetail(outcome?.detail ??
        (isFailure ? `${event.detail ?? ''} · No error outcome was recorded.` : 'The interruption outcome is unavailable.'));
      return {
        ...event,
        ...(isInterruption && outcome !== undefined ? { summary: outcome.summary } : {}),
        ...(detail !== undefined ? { detail } : {}),
        originScopeIds: [...origins],
      };
    }));
  }

  /** Return one run only when a durable wake links it to the requested conversation. */
  async chatRunForScope(scopeId: string, runId: string): Promise<AgentRun | undefined> {
    const run = await this.#loadRun(runId);
    if (run === undefined) return undefined;
    const linkedRunId = run.retryOfRunId ?? run.id;
    for (const wake of await this.#store.listWakeRequests()) {
      if (wake.runId !== linkedRunId || wake.projectId !== run.projectId) continue;
      const source = await this.#resolveWakeSource(wake);
      if (source !== undefined && sourceTouchesScope(source, scopeId)) return run;
    }
    return undefined;
  }

  /** Project the authoritative active Chat runs for one conversation after reconnect or refresh. */
  async activeChatRunsForScope(scopeId: string): Promise<readonly AgentRun[]> {
    const active: AgentRun[] = [];
    const seen = new Set<string>();
    const allRuns = this.#runs.list === undefined ? [] : await this.#runs.list();
    for (const wake of await this.#store.listWakeRequests()) {
      if (wake.status !== 'admitted' || wake.runId === undefined) continue;
      const original = await this.#loadRun(wake.runId);
      if (original === undefined) continue;
      const source = await this.#resolveWakeSource(wake);
      if (source === undefined || !sourceTouchesScope(source, scopeId)) continue;
      const candidates = [original, ...allRuns.filter((run) => run.retryOfRunId === original.id)];
      for (const run of candidates) {
        if ((run.status !== 'queued' && run.status !== 'running') || run.taskId !== undefined ||
            run.projectId !== wake.projectId || seen.has(run.id)) continue;
        seen.add(run.id);
        active.push(run);
      }
    }
    return active.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async #loadRun(runId: string): Promise<AgentRun | undefined> {
    const loaded = await this.#runs.load?.(runId);
    if (loaded !== undefined) return loaded;
    return (await this.#runs.list?.())?.find((run) => run.id === runId);
  }

  /** Durable state for observability: every wake request on record. */
  listWakeRequests(): Promise<readonly WakeRequest[]> {
    return this.#store.listWakeRequests();
  }

  /** Durable non-wake outcomes for one input (Message or Project event), for
   * observability.
   *
   * This is what lets a human answer "why did this input wake nobody?": a
   * suppression and a failure are both visible here, never silent.
   */
  listObservations(inputId: string): Promise<readonly WakeObservation[]> {
    return this.#store.listObservations(inputId);
  }

  // ---------------------------------------------------------------------
  // Wake-model-assisted routing (#97, ADR-0007)
  // ---------------------------------------------------------------------

  /**
   * The routing policy in force for one Project.
   *
   * Missing port or facts fail closed to `explicit-only` — a composition that
   * cannot read a policy never collects inputs into a window.
   */
  async #routingPolicyOf(projectId: string): Promise<{
    readonly wakePolicy: 'explicit-only' | 'wake-model-assisted';
    readonly intervalMs: number;
  }> {
    const policy =
      this.#scopes.routingPolicy !== undefined
        ? await this.#scopes.routingPolicy(projectId)
        : undefined;
    return policy ?? { wakePolicy: 'explicit-only', intervalMs: 30_000 };
  }

  /**
   * Arm the best-effort deadline timer for an open window, or sweep at once
   * when the deadline already passed (a slow process, an elapsed window).
   *
   * The timer is convenience, never authority: the durable deadline is what
   * `sweepRouting` — also run by `reconcile` after every restart — decides on.
   */
  #afterWindowJoin(window: RoutingWindow): void {
    if (window.deadlineAt <= this.#clock.now()) {
      void this.sweepRouting().catch(() => undefined);
      return;
    }
    if (this.#windowTimers.has(window.id)) return;
    const timer = setTimeout(() => {
      this.#windowTimers.delete(window.id);
      void this.sweepRouting().catch(() => undefined);
    }, window.deadlineAt - this.#clock.now());
    timer.unref();
    this.#windowTimers.set(window.id, timer);
  }

  /**
   * Close every elapsed routing window into frozen batches and submit every
   * frozen batch to the wake model.
   *
   * Idempotent and serialized: the window close and the batch's frozen→settled
   * transition are compare-and-set guarded in the store, so a timer, a
   * delivery-time sweep, and a restart sweep can never double-freeze a window
   * or judge one batch twice. This is what makes "an elapsed window is
   * submitted immediately" true across a restart without dropping input.
   */
  async sweepRouting(): Promise<void> {
    if (this.#sweepInFlight !== undefined) return this.#sweepInFlight;
    const sweep = this.#sweep().finally(() => {
      this.#sweepInFlight = undefined;
    });
    this.#sweepInFlight = sweep;
    return sweep;
  }

  async #sweep(): Promise<void> {
    const now = this.#clock.now();
    for (const window of await this.#store.listRoutingWindows()) {
      if (window.status === 'open' && window.deadlineAt <= now) {
        await this.#freezeWindow(window, now);
      }
    }
    // Every still-frozen batch is submitted: the ones this sweep just froze
    // and the ones an interrupted process froze before it died.
    for (const batch of await this.#store.listRoutingBatches()) {
      if (batch.status === 'frozen') await this.#submitBatch(batch);
    }
  }

  /**
   * Freeze one elapsed window into chronological, bounded batches (AC: split
   * batches and deterministic truncation), or return `[]` when another sweep
   * already froze it.
   */
  async #freezeWindow(window: RoutingWindow, now: number): Promise<readonly RoutingBatch[]> {
    const inputIds = await this.#store.listRoutingWindowInputs(window.id);
    const windowInputIds = new Set(inputIds);
    const facts: RoutingInputFact[] = [];
    for (const inputId of inputIds) {
      const message = await this.#store.getMessage(inputId);
      if (message !== undefined) {
        facts.push(await this.#messageFact(message));
        continue;
      }
      const event = await this.#store.getEvent(inputId);
      if (event !== undefined) {
        facts.push(await this.#eventFact(event));
      }
      // A missing input cannot occur: membership and the input itself are one
      // store transaction. If it somehow does, the surviving facts still freeze
      // and the durable membership row keeps the gap inspectable.
    }
    // Join order *is* the chronology: the durable cursor records arrival
    // order, and creation timestamps may tie within one millisecond (or under
    // a controlled clock). Sorting by a tieable timestamp would shuffle a
    // batch, so the membership order is preserved exactly.
    const contract = await this.#routingContract(window.projectId);
    const messages = await this.#store.listMessages();
    const recentContext = messages.filter(
      (message) =>
        message.channel === 'project' &&
        message.projectId === window.projectId &&
        !windowInputIds.has(message.id),
    );
    // Thread ancestors come from durable Messages only; a direct Message can
    // never be reached (batch inputs are channel Messages whose inReplyTo chain
    // stays inside their own scope), and the filter is the second lock.
    const contextById = new Map<string, RoutingContextMessage>(
      messages
        .filter((message) => message.channel !== 'direct')
        .map((message) => [
          message.id,
          {
            id: message.id,
            authorId: message.author.id,
            authorKind: message.author.kind,
            createdAt: message.createdAt,
            body: message.body,
            ...(message.inReplyTo !== undefined ? { inReplyTo: message.inReplyTo } : {}),
          },
        ]),
    );

    const plans = freezeRoutingBatches({
      window,
      inputs: facts,
      contract,
      recentContext: recentContext.map((message) => ({
        id: message.id,
        authorId: message.author.id,
        authorKind: message.author.kind,
        createdAt: message.createdAt,
        body: message.body,
        ...(message.inReplyTo !== undefined ? { inReplyTo: message.inReplyTo } : {}),
      })),
      messageById: (id) => contextById.get(id),
      ...(this.#routingBounds !== undefined ? { bounds: this.#routingBounds } : {}),
      now,
      createBatchId: () => this.#newRoutingId('routingBatch'),
    });
    const frozen = await this.#store.freezeRoutingWindow({
      windowId: window.id,
      now,
      batches: plans,
    });
    const timer = this.#windowTimers.get(window.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#windowTimers.delete(window.id);
    }
    return frozen;
  }

  /** Eligible candidate Agents for a Message input, scope-gated and author-excluded. */
  async #messageFact(message: Message): Promise<RoutingInputFact> {
    const members = await this.#requireMembers(message.projectId);
    const currentAgents = members
      .filter((member) => member.memberKind === 'agent' && member.endedAt === undefined)
      .map((member) => member.memberId);
    let candidates = currentAgents;
    if (message.scopeId !== '') {
      const scope = await this.#scopes.getScope(message.scopeId);
      if (scope === undefined) {
        candidates = [];
      } else {
        const facts = scopeFacts(scope);
        // Same fail-closed rule as deterministic routing: a participant-scoped
        // kind without a participant set resolves to the empty set.
        const participants =
          facts.kind === 'project' ? undefined : (facts.participants ?? []);
        if (participants !== undefined) {
          candidates = candidates.filter((agentId) => participants.includes(agentId));
        }
      }
    }
    return {
      inputId: message.id,
      kind: 'message',
      authorId: message.author.id,
      createdAt: message.createdAt,
      scopeId: message.scopeId,
      content: message.body,
      candidates: candidates.filter((agentId) => agentId !== message.author.id),
      ...(message.inReplyTo !== undefined ? { inReplyTo: message.inReplyTo } : {}),
    };
  }

  /** Eligible candidate Agents for a `wake-eligible` Project event input. */
  async #eventFact(event: ProjectEvent): Promise<RoutingInputFact> {
    const members = await this.#requireMembers(event.projectId);
    return {
      inputId: event.id,
      kind: 'event',
      authorId: event.producer.id,
      createdAt: event.createdAt,
      scopeId: '',
      content:
        `${event.kind}: ${event.summary}` + (event.detail !== undefined ? `\n${event.detail}` : ''),
      candidates: members
        .filter(
          (member) =>
            member.memberKind === 'agent' &&
            member.endedAt === undefined &&
            member.memberId !== event.producer.id,
        )
        .map((member) => member.memberId),
    };
  }

  /** The Project-shared contract facts frozen into the routing context. */
  async #routingContract(projectId: string): Promise<RoutingContractFacts> {
    const members = await this.#requireMembers(projectId);
    const facts =
      this.#scopes.projectContract !== undefined
        ? await this.#scopes.projectContract(projectId)
        : undefined;
    const details = new Map(
      (facts?.members ?? []).map((member) => [member.memberId, member] as const),
    );
    // No per-input Task relevance rule exists yet. Omitting Tasks is safer
    // than presenting unrelated open work as routing evidence (ADR-0007).
    return {
      projectId,
      goal: facts?.goal ?? '',
      rules: facts !== undefined ? [...facts.rules] : [],
      candidates: members
        .filter((member) => member.memberKind === 'agent' && member.endedAt === undefined)
        .map((member) => ({
          agentId: member.memberId,
          responsibilities: [...(details.get(member.memberId)?.responsibilities ?? [])],
          collaborationInstructions: details.get(member.memberId)?.collaborationInstructions ?? '',
        })),
    };
  }

  /**
   * Judge one frozen batch: up to two attempts on the identical snapshot, then
   * fail closed with one durable outcome per input (AC: retry once, then fail
   * closed with visible per-input outcomes).
   */
  async #submitBatch(batch: RoutingBatch): Promise<void> {
    const current = await this.#store.getRoutingBatch(batch.id);
    if (current === undefined || current.status !== 'frozen') return;
    const batchInputs = await this.#store.listRoutingBatchInputs(current.id);
    const expected: JudgementExpectation = {
      inputIds: batchInputs.map((input) => input.inputId),
      candidatesByInput: new Map(
        current.manifest.inputs.map((input) => [input.inputId, [...input.candidates]] as const),
      ),
    };

    const previous = await this.#store.listRoutingAttempts(current.id);
    // The port identity is evidence, not an injection channel for provider
    // credentials. Never persist a raw adapter-supplied identifier.
    const modelId = this.#routingModel === undefined
      ? 'unavailable'
      : sanitizeIdentifier(this.#routingModel.id, { kind: 'model', fallback: 'unknown-model' });
    const successful = previous.find((attempt) => attempt.status === 'succeeded');
    if (successful?.judgement !== undefined) {
      await this.#settleBatchRouted(current, batchInputs, successful.judgement);
      return;
    }
    if (successful !== undefined) {
      // A pre-v21 success has no recoverable judgement. Never ask the model
      // again and pretend the resulting decision was the original one.
      await this.#failBatchClosed(current, batchInputs, {
        kind: 'invalid-output', detail: 'legacy successful attempt has no recoverable judgement',
      });
      return;
    }
    let lastFailure: { readonly kind: RoutingFailureKind; readonly detail: string } =
      { kind: 'model-unavailable', detail: 'routing attempt interrupted before completion' };
    const priorFailure = previous.at(-1);
    if (priorFailure?.errorKind !== undefined) lastFailure = { kind: priorFailure.errorKind, detail: priorFailure.errorDetail ?? '' };
    for (let attemptNumber = previous.length + 1; attemptNumber <= 2; attemptNumber += 1) {
      const startedAt = this.#clock.now();
      const attemptId = this.#newRoutingId('routingAttempt');
      await this.#store.recordRoutingAttempt({
        id: attemptId, batchId: current.id, attemptNumber,
        modelId,
        startedAt, finishedAt: startedAt, status: 'started',
      });
      let judgement: RoutingJudgement | undefined;
      let parsed: JudgementParseResult | undefined;
      let failure: { readonly kind: RoutingFailureKind; readonly detail: string } | undefined;
      if (this.#routingModel === undefined) {
        failure = {
          kind: 'model-unavailable',
          detail: 'no wake model is configured for this instance',
        };
      } else {
        try {
          const raw = await withRoutingTimeout(
            this.#routingModel.judge({
              attemptId,
              batchId: current.id,
              projectId: current.projectId,
              attempt: attemptNumber,
              context: current.context,
            }),
            this.#attemptTimeoutMs,
          );
          parsed = parseRoutingJudgement(raw, expected);
          if (!parsed.ok) failure = { kind: parsed.kind, detail: parsed.detail };
        } catch (error) {
          failure = error instanceof RoutingAttemptTimeoutError
            ? {
                kind: 'timeout',
                detail: `wake model did not answer within ${this.#attemptTimeoutMs}ms`,
              }
            : {
                kind: 'model-unavailable',
                // Provider errors can embed an arbitrary unlabelled key. Do
                // not copy their prose into attempts, evidence, or logs.
                detail: 'wake model request failed',
              };
        }
      }
      judgement = parsed !== undefined && parsed.ok ? parsed.judgement : undefined;
      const settledAttempt: RoutingAttempt = {
        id: attemptId,
        batchId: current.id,
        attemptNumber,
        modelId,
        startedAt,
        finishedAt: this.#clock.now(),
        status: judgement !== undefined ? 'succeeded' : 'failed',
        ...(judgement !== undefined ? { judgement } : {}),
        ...(failure !== undefined
          ? { errorKind: failure.kind, errorDetail: failure.detail }
          : {}),
      };
      await this.#store.recordRoutingAttempt(settledAttempt);
      await this.#onRoutingAttempt?.(settledAttempt, current.projectId);
      if (judgement !== undefined) {
        await this.#settleBatchRouted(current, batchInputs, judgement);
        return;
      }
      lastFailure = failure!;
    }
    await this.#failBatchClosed(current, batchInputs, lastFailure);
  }

  /**
   * Settle a judged batch: one outcome per input, at most one WakeRequest and
   * run per selected Agent, all durable before any admission (AC: one frozen
   * attempt accounts for every input; coalesced fan-out).
   */
  async #settleBatchRouted(
    batch: RoutingBatch,
    batchInputs: readonly RoutingBatchInput[],
    judgement: RoutingJudgement,
  ): Promise<void> {
    const now = this.#clock.now();
    const selectionByInput = new Map(judgement.selections.map((s) => [s.inputId, s] as const));
    const suppressionByInput = new Map(judgement.suppressions.map((s) => [s.inputId, s] as const));
    const inputIdsByAgent = new Map<string, string[]>();
    const outcomes: RoutingInputOutcome[] = [];
    for (const batchInput of batchInputs) {
      const selection = selectionByInput.get(batchInput.inputId);
      if (selection !== undefined) {
        outcomes.push({
          batchId: batch.id,
          inputId: batchInput.inputId,
          status: 'selected',
          assignments: selection.assignments.map((assignment) => ({
            agentId: assignment.agentId,
            rationale: assignment.rationale,
          })),
          settledAt: now,
        });
        for (const assignment of selection.assignments) {
          const list = inputIdsByAgent.get(assignment.agentId) ?? [];
          list.push(batchInput.inputId);
          inputIdsByAgent.set(assignment.agentId, list);
        }
        continue;
      }
      const suppression = suppressionByInput.get(batchInput.inputId);
      if (suppression === undefined) {
        // Unreachable: the validator guarantees full accounting. Fail closed
        // defensively rather than settle an unaccounted input.
        await this.#failBatchClosed(
          batch,
          batchInputs,
          { kind: 'invalid-output', detail: `input ${batchInput.inputId} lost its judgement` },
        );
        return;
      }
      outcomes.push({
        batchId: batch.id,
        inputId: batchInput.inputId,
        status: 'suppressed',
        assignments: [],
        rationale: suppression.rationale,
        settledAt: now,
      });
    }

    const wakes = [...inputIdsByAgent.keys()].map((agentId) =>
      wakeFromBatch({ batchId: batch.id, projectId: batch.projectId, agentId, now }),
    );
    // Persistence-before-wake for the batch path: outcomes and WakeRequests are
    // durable together before any run admission begins.
    await this.#store.settleRoutingBatch({
      batchId: batch.id,
      status: inputIdsByAgent.size > 0 ? 'routed' : 'suppressed',
      outcomes,
      wakes,
      now,
    });

    // Deliberate suppression is durable, visible, and never retried: it is
    // recorded on the causal input exactly like any other non-wake outcome.
    for (const outcome of outcomes) {
      if (outcome.status !== 'suppressed') continue;
      const observation: WakeObservation = {
        agentId: '*',
        status: 'suppressed',
        reason: 'routing-model',
        detail: `routing model suppressed this input: ${outcome.rationale ?? 'no agent needed'}`,
      };
      await this.#store.recordObservation({ inputId: outcome.inputId, observation, now });
      this.#announce(outcome.inputId, [observation]);
    }

    for (const wake of wakes) {
      try {
        const source = await this.#resolveWakeSource(wake);
        if (source !== undefined) await this.#admit(wake, source, true);
      } catch {
        // Admission failed before a run id existed (submission error or
        // transient capacity). The wake stays durable and pending — visible,
        // with admission continuing when the condition clears through
        // `reconcile` (ADR-0007: pending or waiting, never silent expiry).
      }
    }
  }

  /**
   * Fail a batch closed after the one permitted retry: zero Agents woken,
   * every input left intact with a durable, visible failed outcome.
   */
  async #failBatchClosed(
    batch: RoutingBatch,
    batchInputs: readonly RoutingBatchInput[],
    failure: { readonly kind: RoutingFailureKind; readonly detail: string },
  ): Promise<void> {
    const now = this.#clock.now();
    const detail = redactSensitiveText(
      `routing attempt failed after 2 attempts on the identical frozen snapshot: ${failure.kind}: ${failure.detail}`,
    ).slice(0, 500);
    const outcomes: RoutingInputOutcome[] = batchInputs.map((batchInput) => ({
      batchId: batch.id,
      inputId: batchInput.inputId,
      status: 'failed',
      assignments: [],
      detail,
      settledAt: now,
    }));
    await this.#store.settleRoutingBatch({
      batchId: batch.id,
      status: 'failed',
      error: detail,
      outcomes,
      now,
    });
    for (const outcome of outcomes) {
      const observation: WakeObservation = {
        agentId: '*',
        status: 'failed',
        reason: 'routing-model',
        detail,
      };
      await this.#store.recordObservation({ inputId: outcome.inputId, observation, now });
      this.#announce(outcome.inputId, [observation]);
    }
  }

  /** Resolve causal input ids in order, skipping nothing that is durable. */
  async #resolveInputs(inputIds: readonly string[]): Promise<readonly RoutingInput[]> {
    const resolved: RoutingInput[] = [];
    for (const inputId of inputIds) {
      const message = await this.#store.getMessage(inputId);
      if (message !== undefined) {
        resolved.push(message);
        continue;
      }
      const event = await this.#store.getEvent(inputId);
      if (event !== undefined) resolved.push(event);
    }
    return resolved;
  }

  /** Resolve one wake's causal source: its input, or its batch and assignment. */
  async #resolveWakeSource(wake: WakeRequest): Promise<ResolvedRoutingSource | undefined> {
    if (wake.batchId !== undefined) {
      const batch = await this.#store.getRoutingBatch(wake.batchId);
      if (batch === undefined) return undefined;
      const outcomes = await this.#store.listRoutingOutcomes(batch.id);
      const assignedIds = outcomes
        .filter((outcome) => outcome.assignments.some((a) => a.agentId === wake.agentId))
        .map((outcome) => outcome.inputId);
      return { kind: 'batch', batch, assigned: await this.#resolveInputs(assignedIds) };
    }
    const input =
      (await this.#store.getMessage(wake.inputId)) ?? (await this.#store.getEvent(wake.inputId));
    return input === undefined ? undefined : { kind: 'input', input };
  }

  /** Durable routing windows, optionally scoped to one Project. */
  listRoutingWindows(projectId?: string): Promise<readonly RoutingWindow[]> {
    return this.#store.listRoutingWindows(projectId);
  }

  /** Durable frozen routing batches, optionally scoped to one Project. */
  listRoutingBatches(projectId?: string): Promise<readonly RoutingBatch[]> {
    return this.#store.listRoutingBatches(projectId);
  }

  /**
   * The complete causal evidence for one batch: window, inputs, attempts,
   * per-input outcomes, batch WakeRequests, and their projected replies — the
   * ADR-0007 human-inspectable chain without internal logs.
   */
  async getRoutingBatchEvidence(batchId: string): Promise<RoutingBatchEvidence | undefined> {
    const batch = await this.#store.getRoutingBatch(batchId);
    if (batch === undefined) return undefined;
    const window = (await this.#store.listRoutingWindows(batch.projectId)).find(
      (candidate) => candidate.id === batch.windowId,
    );
    const inputs = await this.#store.listRoutingBatchInputs(batch.id);
    const attempts = await this.#store.listRoutingAttempts(batch.id);
    const outcomes = await this.#store.listRoutingOutcomes(batch.id);
    const wakes = (await this.#store.listWakeRequests()).filter(
      (wake) => wake.batchId === batch.id,
    );
    const replies: { readonly idempotencyKey: string; readonly messageId: string }[] = [];
    for (const wake of wakes) {
      const reply = await this.#store.getMessage(replyMessageId(wake));
      if (reply !== undefined) replies.push({ idempotencyKey: wake.idempotencyKey, messageId: reply.id });
    }
    return { batch, window, inputs, attempts, outcomes, wakes, replies };
  }

  /**
   * The complete causal evidence for one input: its collection window, every
   * batch it joined (with attempts, outcomes, wakes, replies), its
   * deterministic wakes, and its durable non-wake observations.
   */
  async routingEvidenceForInput(inputId: string): Promise<RoutingInputEvidence | undefined> {
    const message = await this.#store.getMessage(inputId);
    const event = message === undefined ? await this.#store.getEvent(inputId) : undefined;
    if (message === undefined && event === undefined) return undefined;
    const projectId = (message ?? event)!.projectId;

    let window: RoutingWindow | undefined;
    for (const candidate of await this.#store.listRoutingWindows(projectId)) {
      const membership = await this.#store.listRoutingWindowInputs(candidate.id);
      if (membership.includes(inputId)) {
        window = candidate;
        break;
      }
    }

    const outcomes = await this.#store.listRoutingOutcomesForInput(inputId);
    const batches: RoutingBatchEvidence[] = [];
    for (const batchId of [...new Set(outcomes.map((outcome) => outcome.batchId))]) {
      const evidence = await this.getRoutingBatchEvidence(batchId);
      if (evidence !== undefined) batches.push(evidence);
    }
    const deterministicWakes = (await this.#store.listWakeRequests()).filter(
      (wake) => wake.batchId === undefined && wake.inputId === inputId,
    );
    return {
      input: message ?? event!,
      ...(window !== undefined ? { window } : {}),
      batches,
      deterministicWakes,
      observations: await this.#store.listObservations(inputId),
    };
  }

  #newRoutingId(kind: 'routingBatch' | 'routingAttempt'): string {
    const factory = this.#ids[kind];
    if (factory !== undefined) return factory.call(this.#ids);
    return this.#fallbackIds[kind]!();
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

/**
 * The scope facts the wake plan resolves a Message's targets against.
 *
 * This is where scope governance becomes routing: a Working group's current
 * participations (active `memberships` only) are its channel's participants,
 * exactly as ADR-0008 defines them, so group content can never fan out beyond
 * the group. The Project channel carries no participant list because every
 * current Project member is its participant.
 */
function scopeFacts(scope: ConversationScope): WakeScopeFacts {
  if (scope.kind === 'direct') {
    return { kind: scope.kind, participants: scope.participants };
  }
  if (scope.kind === 'working-group') {
    return {
      kind: scope.kind,
      participants: scope.memberships
        .filter((membership) => membership.endedAt === undefined)
        .map((membership) => membership.memberId),
    };
  }
  return { kind: scope.kind };
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
 * Render one batch-selected Agent's prompt (#97, ADR-0007).
 *
 * The Agent receives exactly its assigned batch inputs in chronological
 * order — never the whole batch, never another Agent's assignment — with the
 * batch identity named so the run can be traced back through its causal
 * chain. The final text becomes the Agent's reply to the batch.
 */
export function renderBatchWakePrompt(
  agentId: string,
  batch: RoutingBatch,
  assigned: readonly RoutingInput[],
): string {
  const lines = [
    `Wake-model routing selected you for one routing batch in project ${batch.projectId} (batch ${batch.id}).`,
    `${assigned.length} input${assigned.length === 1 ? '' : 's'} assigned to you, in chronological order:`,
  ];
  assigned.forEach((input, index) => {
    lines.push('');
    if (isProjectEvent(input)) {
      lines.push(
        `[input ${index + 1} | id=${input.id} | kind=project-event | producer=${input.producer.id} | at=${input.createdAt}]`,
        `${input.kind}: ${input.summary}`,
        ...(input.detail !== undefined ? [input.detail] : []),
      );
    } else {
      lines.push(
        `[input ${index + 1} | id=${input.id} | kind=message | author=${input.author.kind}:${input.author.id} | at=${input.createdAt} | scope=${input.scopeId}]`,
        input.body,
      );
    }
  });
  lines.push(
    '',
    `You are ${agentId}. Answer in your final message; that answer becomes your reply to this batch. ` +
      'Keep private reasoning and tool output out of it.',
  );
  return lines.join('\n');
}

/**
 * Where a batch-triggered reply lands (#97).
 *
 * One assigned Message keeps the ordinary single `inReplyTo` relationship in
 * its own scope. Several assigned Messages that share one conversation scope
 * post there without an `inReplyTo`. Anything else — mixed scopes, or only
 * Project events — posts to the Project channel, so scope-private content
 * never migrates into a wider scope through a reply.
 */
function batchReplyPlacement(
  projectId: string,
  assigned: readonly RoutingInput[],
): { readonly scopeId: string; readonly channel: Message['channel']; readonly inReplyTo?: string } {
  const messages = assigned.filter((input): input is Message => !isProjectEvent(input));
  if (assigned.length === 1 && messages.length === 1) {
    const only = messages[0]!;
    return { scopeId: only.scopeId, channel: only.channel, inReplyTo: only.id };
  }
  if (assigned.length > 0 && messages.length === assigned.length) {
    const first = messages[0]!;
    if (messages.every((message) => message.scopeId === first.scopeId)) {
      return { scopeId: first.scopeId, channel: first.channel };
    }
  }
  return { scopeId: projectChannelScopeId(projectId), channel: 'project' };
}

/** One wake-model attempt exceeded its timeout. */
class RoutingAttemptTimeoutError extends Error {
  constructor() {
    super('routing attempt timed out');
    this.name = 'RoutingAttemptTimeoutError';
  }
}

/** Race one model call against the attempt timeout, always clearing the timer. */
function withRoutingTimeout(promise: Promise<string>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RoutingAttemptTimeoutError()), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** The complete causal evidence for one frozen routing batch (#97). */
export interface RoutingBatchEvidence {
  readonly batch: RoutingBatch;
  readonly window?: RoutingWindow | undefined;
  readonly inputs: readonly RoutingBatchInput[];
  readonly attempts: readonly RoutingAttempt[];
  readonly outcomes: readonly RoutingInputOutcome[];
  /** The batch's model-assisted WakeRequests, at most one per selected Agent. */
  readonly wakes: readonly WakeRequest[];
  /** Projected replies by wake idempotency key, once a run completed. */
  readonly replies: readonly { readonly idempotencyKey: string; readonly messageId: string }[];
}

/** The complete causal evidence for one routing input (#97). */
export interface RoutingInputEvidence {
  readonly input: RoutingInput;
  readonly window?: RoutingWindow;
  readonly batches: readonly RoutingBatchEvidence[];
  /** Deterministic per-Message/per-Agent wakes, when the input was addressed. */
  readonly deterministicWakes: readonly WakeRequest[];
  readonly observations: readonly WakeObservation[];
}

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
