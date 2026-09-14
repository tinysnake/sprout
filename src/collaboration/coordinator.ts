/**
 * The collaboration coordinator (ticket #26): the core write path.
 *
 * ## The selected write path
 *
 * Three candidate write paths were compared; this module implements the one
 * chosen for M1 — **automatic final-result projection** — and the reasons live
 * in `docs/research/collaboration-write-path.md`. In one line: after a run admitted by a
 * wake request completes, the core projects the run's final assistant message as
 * one Agent-authored reply Message linked to the input, using nothing but the
 * engine port's `EngineTurnResult`.
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
 * The rejected alternatives and their blockers are documented rather than
 * silently dropped (ticket #25, acceptance item 2).
 *
 * ## The two invariants the probe must show
 *
 * - **Persistence-before-wake.** `deliver` persists the Message and every wake
 *   request in one store transaction *before* it admits any run. A crash after
 *   the write and before the run leaves a durable wake request to recover from;
 *   it can never leave a run with no input.
 * - **Idempotent retry.** A repeated `deliveryKey` returns the stored Message
 *   and its wake requests without adding anything, and `admitWake` is a compare-
 *   and-set, so a repeated delivery key produces at most one run admission.
 *
 * ## Restart reconciliation
 *
 * `deliver` projects a reply inline after awaiting the admitted run, which is
 * deterministic while the process lives. A process that dies after a run
 * completed but before the reply was projected would otherwise leave the
 * conversation silent forever. `reconcile()` closes that gap: on startup it
 * re-admits any wake that was persisted but never admitted, then re-projects a
 * reply for every admitted wake whose run completed without one. Both halves are
 * idempotent by construction (the wake CAS and the reply delivery key), so a
 * restart can never duplicate a run or a reply.
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
import type { ProjectRegistry } from '../project/registry.ts';
import { createIdFactory, type IdFactory } from '../ids.ts';
import {
  type Message,
  type WakeObservation,
  type WakeRequest,
} from './model.ts';
import { planWake } from './wake.ts';
import type { CollaborationStore } from './store.ts';
import { wakeIdempotencyKey } from './store.ts';

/** The slice of the run orchestrator the coordinator uses. */
export interface RunAdmitter {
  submit(request: {
    readonly agentId: string;
    readonly prompt: string;
    /**
     * The causal Message's Project, so the run resolves only against it.
     *
     * Every admitted wake names its input Message's `projectId`. Without it a
     * target Agent that belongs to several Projects could resolve through the
     * wrong one (whichever the registry lists first), silently using another
     * Project's environment and contract. The orchestrator verifies membership
     * in this Project and refuses explicitly rather than falling back.
     */
    readonly projectId: string;
  }): Promise<{ id: string }>;
  waitFor(runId: string): Promise<AgentRun>;
  /**
   * Look up a run without requiring it to exist.
   *
   * Used by reconciliation, where a wake may name a run whose record is no longer
   * present. An unknown run is then simply "no reply to project", not a startup
   * crash. Optional so a minimal admitter (tests, the probe) need not provide it;
   * when absent, `waitFor` is used and an unknown run propagates.
   */
  load?(runId: string): Promise<AgentRun | undefined>;
}

export interface CollaborationCoordinatorOptions {
  readonly projects: ProjectRegistry;
  readonly store: CollaborationStore;
  readonly runs: RunOrchestrator | RunAdmitter;
  /** Ids for new Messages. Injected so the probe and tests are deterministic. */
  readonly ids?: IdFactory;
  readonly wakeModel?: import('./model.ts').WakeModel;
  readonly clock?: { now(): number };
  readonly onObservation?: (observation: {
    readonly messageId: string;
    readonly observation: WakeObservation;
  }) => void;
}

/** A request to post one durable Message and wake whoever it addresses. */
export interface DeliverInput {
  readonly projectId: string;
  readonly channel: Message['channel'];
  readonly author: Message['author'];
  readonly body: string;
  /** Required for a direct Message; ignored on the project channel. */
  readonly recipients?: readonly string[];
  /** Idempotency key. Repeating it must not create a second Message. */
  readonly deliveryKey: string;
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

export class CollaborationCoordinator {
  readonly #projects: ProjectRegistry;
  readonly #store: CollaborationStore;
  readonly #runs: RunAdmitter;
  readonly #ids: IdFactory;
  readonly #wakeModel: import('./model.ts').WakeModel | undefined;
  readonly #clock: { now(): number };
  readonly #onObservation: CollaborationCoordinatorOptions['onObservation'];

  constructor(options: CollaborationCoordinatorOptions) {
    this.#projects = options.projects;
    this.#store = options.store;
    this.#runs = options.runs;
    this.#ids = options.ids ?? createIdFactory();
    this.#wakeModel = options.wakeModel;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#onObservation = options.onObservation;
  }

  /**
   * Persist one Message, decide who it wakes, and admit their runs.
   *
   * The order is the contract: **persist, then wake**. The store writes the
   * Message and its wake requests together; only after that returns does this
   * method ask for run admission, and each admission is itself an idempotent
   * compare-and-set on the stored wake request.
   */
  async deliver(input: DeliverInput): Promise<DeliverResult> {
    const existing = await this.#store.getMessageByDeliveryKey(input.deliveryKey);
    if (existing) {
      // A retry. No new Message is written, but any wake of this input that is
      // still pending is admitted now: idempotency must not leave addressed work
      // unwoken just because an earlier process died between persist and admit.
      // Admission is a compare-and-set, so this cannot double-admit a wake.
      const admittedRunIds = await this.#admitAll(
        (await this.#store.listWakeRequests()).filter((wake) => wake.messageId === existing.id),
        existing,
      );
      return {
        message: existing,
        wakes: (await this.#store.listWakeRequests()).filter((w) => w.messageId === existing.id),
        duplicate: true,
        admittedRunIds,
      };
    }

    const now = this.#clock.now();
    const message: Message = {
      id: this.#ids.message(),
      projectId: input.projectId,
      channel: input.channel,
      author: input.author,
      body: input.body,
      recipients: input.recipients ?? [],
      deliveryKey: input.deliveryKey,
      createdAt: now,
    };

    const plan = await planWake(message, {
      projects: this.#projects,
      ...(this.#wakeModel !== undefined ? { wakeModel: this.#wakeModel } : {}),
    });

    const stored = await this.#store.postMessage({ message, plan, now });
    if (stored.duplicate) {
      return { ...stored, admittedRunIds: [] };
    }
    for (const observation of plan.observations) {
      this.#onObservation?.({ messageId: message.id, observation });
    }

    const admittedRunIds = await this.#admitAll(stored.wakes, message);
    // Re-read the wake records after admission so the returned result reports
    // the durable state (status + run id) rather than the pre-admission snapshot.
    const finalWakes = (await this.#store.listWakeRequests()).filter(
      (candidate) => candidate.messageId === message.id,
    );
    return { ...stored, wakes: finalWakes, admittedRunIds };
  }

  /**
   * Admit every pending wake in a list, in order, and report the runs started.
   *
   * Shared by `deliver` and its duplicate path: admission is idempotent, so
   * running it on wakes that are already settled is a no-op.
   */
  async #admitAll(
    wakes: readonly WakeRequest[],
    input: Message,
  ): Promise<readonly string[]> {
    const admittedRunIds: string[] = [];
    for (const wake of wakes) {
      const outcome = await this.#admit(wake, input);
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
    input: Message,
  ): Promise<{ readonly runId: string; readonly projected: boolean } | undefined> {
    if (wake.status !== 'pending') return undefined;

    // Submit the run, then admit the wake with a compare-and-set. The order
    // matters: a run submitted but not admitted is the *extra wake* the contract
    // explicitly prefers over a lost one, while an admitted wake always names a
    // run that really exists. The run id is the orchestrator's, never guessed.
    //
    // The causal Message's `projectId` is submitted with every wake, so the run
    // can only ever resolve against the Project that owns the Message. A target
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
    const projected = await this.#projectReply(admitted.wake, input);
    return { runId: submission.id, projected };
  }

  /**
   * Project a completed run's final assistant message as one Agent reply.
   *
   * Only a `completed` run projects. A failed or interrupted run produces no
   * reply: an answer that was never produced must not be fabricated. The reply's
   * delivery key is derived from the wake idempotency key, so re-running this
   * projection (for example after a restart) can never post two replies for one
   * wake. Returns whether this call actually created the reply (false when the
   * run produced no reply, or when a durable reply already existed).
   */
  async #projectReply(
    wake: WakeRequest,
    input: Message,
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

    const stored = await this.#store.postMessage({
      message: {
        id: replyMessageId(wake),
        projectId: input.projectId,
        channel: input.channel,
        author: { id: wake.agentId, kind: 'agent' },
        body: text,
        recipients: [],
        deliveryKey: replyDeliveryKey(wake),
        inReplyTo: input.id,
        createdAt: this.#clock.now(),
      },
      plan: { messageId: input.id, decisions: [], observations: [] },
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
   *    as `deliver` would have.
   * 2. **A completed run whose reply was never projected.** The run result is
   *    durable, so the reply is reconstructed from it. The projection is keyed by
   *    the wake idempotency key, so it cannot double-post.
   *
   * A run that a restart settled as `failed` or `interrupted` produces no reply:
   * this method never fabricates an answer. The whole pass is idempotent, so
   * running it twice — or on a healthy process — changes nothing.
   */
  async reconcile(): Promise<ReconcileResult> {
    const admittedRunIds: string[] = [];
    // A set: several wakes (for example an `@all` broadcast) can answer the same
    // input, and reconciliation reports each input once, not once per reply.
    const projectedMessageIds = new Set<string>();
    for (const wake of await this.#store.listWakeRequests()) {
      const input = await this.#store.getMessage(wake.messageId);
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
  listMessages(): Promise<readonly Message[]> {
    return this.#store.listMessages();
  }

  /** Durable state for observability: every wake request on record. */
  listWakeRequests(): Promise<readonly WakeRequest[]> {
    return this.#store.listWakeRequests();
  }

  /**
   * Durable non-wake outcomes for one Message, for observability.
   *
   * This is what lets a human answer "why did this Message wake nobody?": a
   * suppression and a failure are both visible here, never silent.
   */
  listObservations(messageId: string): Promise<readonly WakeObservation[]> {
    return this.#store.listObservations(messageId);
  }
}

/**
 * Render one addressed Message into the prompt its Agent run receives.
 *
 * The input is presented as conversation with its author and channel named, so
 * the agent knows whose work it is answering and on which channel a reply
 * belongs. This is the only thing projected into the run; the core does not
 * pre-summarize or reinterpret the Message.
 */
export function renderWakePrompt(message: Message, agentId: string): string {
  const where = message.channel === 'direct' ? 'a direct message' : `the project channel`;
  return [
    `You were woken by ${where} in project ${message.projectId}.`,
    ``,
    `${message.author.kind} ${message.author.id} wrote:`,
    message.body,
    ``,
    `You are ${agentId}. Answer in your final message; that answer becomes your reply to this message. ` +
      `Keep private reasoning and tool output out of it.`,
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
