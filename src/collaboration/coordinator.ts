/**
 * The collaboration coordinator (prototype #25): the core write path.
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
  type CollaborationMessage,
  type WakeObservation,
  type WakeRequest,
} from './model.ts';
import { planWake } from './wake.ts';
import type { CollaborationStore } from './store.ts';
import { wakeIdempotencyKey } from './store.ts';

/** The slice of the run orchestrator the coordinator uses. */
export interface RunAdmitter {
  submit(request: { readonly agentId: string; readonly prompt: string }): Promise<{ id: string }>;
  waitFor(runId: string): Promise<AgentRun>;
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
  readonly channel: CollaborationMessage['channel'];
  readonly author: CollaborationMessage['author'];
  readonly body: string;
  /** Required for a direct Message; ignored on the project channel. */
  readonly recipients?: readonly string[];
  /** Idempotency key. Repeating it must not create a second Message. */
  readonly deliveryKey: string;
}

export interface DeliverResult {
  readonly message: CollaborationMessage;
  /** Every wake request the Message produced, admitted or not. */
  readonly wakes: readonly WakeRequest[];
  /** True when the delivery key had already been seen; nothing new was stored. */
  readonly duplicate: boolean;
  /** Run ids admitted by this delivery, in wake order. */
  readonly admittedRunIds: readonly string[];
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
      // A retry. Nothing is written and nothing is admitted: the durable input
      // and its wake requests already exist, and their admission state decides
      // whether a run ever ran.
      return {
        message: existing,
        wakes: (await this.#store.listWakeRequests()).filter((w) => w.messageId === existing.id),
        duplicate: true,
        admittedRunIds: [],
      };
    }

    const now = this.#clock.now();
    const message: CollaborationMessage = {
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

    const admittedRunIds: string[] = [];
    for (const wake of stored.wakes) {
      const runId = await this.#admit(wake, message);
      if (runId !== undefined) admittedRunIds.push(runId);
    }
    // Re-read the wake records after admission so the returned result reports
    // the durable state (status + run id) rather than the pre-admission snapshot.
    const finalWakes = (await this.#store.listWakeRequests()).filter(
      (candidate) => candidate.messageId === message.id,
    );
    return { ...stored, wakes: finalWakes, admittedRunIds };
  }

  /**
   * Admit one run for a wake request, then project its reply once it settles.
   *
   * Returns the run id when this call won the admission, or `undefined` when the
   * wake was already admitted (a repeated delivery) or is not pending.
   */
  async #admit(wake: WakeRequest, input: CollaborationMessage): Promise<string | undefined> {
    if (wake.status !== 'pending') return undefined;

    // Submit the run, then admit the wake with a compare-and-set. The order
    // matters: a run submitted but not admitted is the *extra wake* the contract
    // explicitly prefers over a lost one, while an admitted wake always names a
    // run that really exists. The run id is the orchestrator's, never guessed.
    const submission = await this.#runs.submit({
      agentId: wake.agentId,
      prompt: renderWakePrompt(input, wake.agentId),
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
    await this.#projectReply(admitted.wake, input);
    return submission.id;
  }

  /**
   * Project a completed run's final assistant message as one Agent reply.
   *
   * Only a `completed` run projects. A failed or interrupted run produces no
   * reply: an answer that was never produced must not be fabricated. The reply's
   * delivery key is derived from the wake idempotency key, so re-running this
   * projection (for example after a restart) can never post two replies for one
   * wake.
   */
  async #projectReply(wake: WakeRequest, input: CollaborationMessage): Promise<void> {
    const runId = wake.runId;
    if (runId === undefined) return;
    const run = await this.#runs.waitFor(runId);
    if (run.status !== 'completed') return;
    const text = run.result?.status === 'completed' ? run.result.text.trim() : '';
    if (text === '') return;

    await this.#store.postMessage({
      message: {
        id: `reply-${wake.idempotencyKey}`,
        projectId: input.projectId,
        channel: input.channel,
        author: { id: wake.agentId, kind: 'agent' },
        body: text,
        recipients: [],
        deliveryKey: `reply:${wake.idempotencyKey}`,
        inReplyTo: input.id,
        createdAt: this.#clock.now(),
      },
      plan: { messageId: input.id, decisions: [], observations: [] },
      now: this.#clock.now(),
    });
  }

  /** Durable state for observability: every Message on record. */
  listMessages(): Promise<readonly CollaborationMessage[]> {
    return this.#store.listMessages();
  }

  /** Durable state for observability: every wake request on record. */
  listWakeRequests(): Promise<readonly WakeRequest[]> {
    return this.#store.listWakeRequests();
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
export function renderWakePrompt(message: CollaborationMessage, agentId: string): string {
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
