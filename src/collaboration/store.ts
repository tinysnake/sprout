/**
 * Durable storage for collaboration Messages, Project events, and wake
 * requests (#26, #96).
 *
 * A seam, not a detail of SQLite (ADR-0002): the collaboration coordinator never
 * issues a query, and the in-memory implementation is enough for unit tests.
 * The production backend is `SqliteCollaborationStore`, mounted on the primary
 * `SqliteStore` so collaboration rows share Sprout's one database (ADR-0002).
 *
 * The store's job is to make two invariants durable *before* any wake is
 * attempted:
 *
 * 1. **Persistence-before-wake.** An input (a Message or a Project event) and
 *    its wake requests are written before the coordinator tries to admit any
 *    Agent run, so a crash between the two can only ever lose a wake that has a
 *    durable request to recover from — never an input.
 * 2. **Idempotent retry.** A repeated delivery key yields exactly one input,
 *    and a repeated `(inputId, agentId)` wake yields at most one run
 *    admission. Both identities are enforced by the store, not by the caller
 *    remembering to check first.
 */

import type { ProjectEvent } from './events.ts';
import { validateAttentionResolution, type CollaborationAttentionResolution, type ResolveCollaborationAttention, type FailedWakeInput } from './attention.ts';
import type {
  Message,
  WakeObservation,
  WakePlan,
  WakeRequest,
  WakeStatus,
} from './model.ts';
import type {
  FrozenRoutingBatchPlan,
} from './routing-context.ts';
import type {
  RoutingAttempt,
  RoutingBatch,
  RoutingBatchInput,
  RoutingInputOutcome,
  RoutingWindow,
} from './routing.ts';

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
    /** Present only for a batch-eligible input under assisted routing (#97). */
    readonly collect?: RoutingWindowCollect;
  }): Promise<PostMessageResult>;

  /**
   * Persist a Project event and its wake requests by idempotency key.
   *
   * The same two guarantees as `postMessage`: the event and its wakes become
   * durable together, and a repeated `deliveryKey` returns the existing event
   * and wakes instead of appending a copy.
   */
  publishEvent(input: {
    readonly event: ProjectEvent;
    readonly plan: WakePlan;
    readonly now: number;
    /** Present only for a batch-eligible input under assisted routing (#97). */
    readonly collect?: RoutingWindowCollect;
  }): Promise<PublishEventResult>;

  getMessage(messageId: string): Promise<Message | undefined>;
  getMessageByDeliveryKey(deliveryKey: string): Promise<Message | undefined>;
  listMessages(): Promise<readonly Message[]>;
  /** Counts only messages after the Human's durable per-scope cursor, excluding their own input. */
  unreadCount(scopeId: string, humanId: string): Promise<number>;
  /** Acknowledge through an observed message; never advance over an unseen arrival. */
  markReadThrough(scopeId: string, humanId: string, messageId: string): Promise<void>;

  /** Human-only Feed resolution; never changes historical collaboration facts. */
  resolveAttention(input: ResolveCollaborationAttention): Promise<void>;
  listAttentionResolutions(): Promise<readonly CollaborationAttentionResolution[]>;
  listWakeFailures(): Promise<readonly FailedWakeInput[]>;

  getEvent(eventId: string): Promise<ProjectEvent | undefined>;
  getEventByDeliveryKey(deliveryKey: string): Promise<ProjectEvent | undefined>;
  /** Project events on record, optionally scoped to one Project, oldest first. */
  listEvents(projectId?: string): Promise<readonly ProjectEvent[]>;

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

  /** Record a non-wake outcome (suppression or failure) for one input. */
  recordObservation(input: {
    readonly inputId: string;
    readonly observation: WakeObservation;
    readonly now: number;
  }): Promise<void>;

  /** The durable non-wake outcomes recorded for one input (Message or event).
   *
   * Suppression and failure are only meaningful if a human can see them, so the
   * contract that records them also exposes them; "nothing happened" must never
   * be the only available answer to "why did this input wake nobody?".
   */
  listObservations(inputId: string): Promise<readonly WakeObservation[]>;

  /** Every routing window on record, optionally scoped to one Project. */
  listRoutingWindows(projectId?: string): Promise<readonly RoutingWindow[]>;

  /**
   * Close one open window and freeze its inputs into chronological batches,
   * atomically.
   *
   * The close is a compare-and-set: exactly one caller freezes a window, so a
   * timer and a restart sweep can never both split the same inputs into two
   * batch sets. Returns the frozen batches, or `[]` when another caller already
   * froze (or the window is unknown).
   */
  freezeRoutingWindow(input: {
    readonly windowId: string;
    readonly now: number;
    readonly batches: readonly FrozenRoutingBatchPlan[];
  }): Promise<readonly RoutingBatch[]>;

  /** One window's collected input ids, in join order (the durable cursor). */
  listRoutingWindowInputs(windowId: string): Promise<readonly string[]>;

  /** Every frozen routing batch on record, optionally scoped to one Project. */
  listRoutingBatches(projectId?: string): Promise<readonly RoutingBatch[]>;
  getRoutingBatch(batchId: string): Promise<RoutingBatch | undefined>;
  /** One batch's inputs, in chronological position order. */
  listRoutingBatchInputs(batchId: string): Promise<readonly RoutingBatchInput[]>;

  /** Append one settled wake-model attempt of one batch (never rewritten). */
  recordRoutingAttempt(attempt: RoutingAttempt): Promise<void>;
  /** The attempts of one batch, in attempt-number order. */
  listRoutingAttempts(batchId: string): Promise<readonly RoutingAttempt[]>;

  /**
   * Settle one batch with one durable outcome per input, atomically with its
   * status change (and its WakeRequests when it routed).
   *
   * This is persistence-before-wake for the batch path: the outcomes and the
   * per-Agent wake requests become durable together, before any run admission.
   */
  settleRoutingBatch(input: {
    readonly batchId: string;
    readonly status: Extract<RoutingBatch['status'], 'routed' | 'suppressed' | 'failed'>;
    readonly error?: string;
    readonly outcomes: readonly RoutingInputOutcome[];
    readonly wakes?: readonly WakeRequest[];
    readonly now: number;
  }): Promise<void>;

  /** Every outcome of one settled batch, in chronological input order. */
  listRoutingOutcomes(batchId: string): Promise<readonly RoutingInputOutcome[]>;
  /** Every outcome recorded for one input across batches (evidence reads). */
  listRoutingOutcomesForInput(inputId: string): Promise<readonly RoutingInputOutcome[]>;
}

/** How one eligible input joins (or opens) its Project's routing window. */
export interface RoutingWindowCollect {
  /** The Project's fixed routing interval for the window about to open. */
  readonly intervalMs: number;
}

export interface PostMessageResult {
  readonly message: Message;
  readonly wakes: readonly WakeRequest[];
  /** True when the delivery key had already been stored; nothing was added. */
  readonly duplicate: boolean;
  /** The Project's open routing window after this input joined it (#97). */
  readonly window?: RoutingWindow;
}

export interface PublishEventResult {
  readonly event: ProjectEvent;
  readonly wakes: readonly WakeRequest[];
  /** True when the delivery key had already been stored; nothing was added. */
  readonly duplicate: boolean;
  /** The Project's open routing window after this input joined it (#97). */
  readonly window?: RoutingWindow;
}

export interface AdmitWakeResult {
  readonly admitted: boolean;
  readonly wake: WakeRequest;
}

/**
 * Compute the store's stable wake identity.
 *
 * One input (Message or Project event) wakes one Agent at most once: the
 * `(inputId, agentId)` pair is what makes every addressing form — recipients,
 * mentions, broadcasts, and event targets — collapse into one durable wake.
 */
export function wakeIdempotencyKey(inputId: string, agentId: string): string {
  return `${inputId}:${agentId}`;
}

/** Materialize a wake request from a decision, ready for durable storage. */
export function wakeFromDecision(input: {
  readonly id: string;
  readonly inputId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly reason: WakeRequest['reason'];
  readonly now: number;
}): WakeRequest {
  return {
    id: input.id,
    inputId: input.inputId,
    projectId: input.projectId,
    agentId: input.agentId,
    reason: input.reason,
    status: 'pending' satisfies WakeStatus,
    idempotencyKey: wakeIdempotencyKey(input.inputId, input.agentId),
    createdAt: input.now,
  };
}

/**
 * Materialize one model-assisted wake request from a frozen routing batch.
 *
 * Identified by `(batch, Agent)` — `inputId` is the batch id and `batchId` is
 * set — while the idempotency shape stays `${inputId}:${agentId}` so the same
 * store-level uniqueness and admission compare-and-set govern both wake kinds
 * (ADR-0007: batch-and-Agent identity beside the unchanged Message-and-Agent
 * identity).
 */
export function wakeFromBatch(input: {
  readonly batchId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly now: number;
}): WakeRequest {
  return {
    id: `wake-${input.batchId}-${input.agentId}`,
    inputId: input.batchId,
    batchId: input.batchId,
    projectId: input.projectId,
    agentId: input.agentId,
    reason: 'routing-model',
    status: 'pending' satisfies WakeStatus,
    idempotencyKey: wakeIdempotencyKey(input.batchId, input.agentId),
    createdAt: input.now,
  };
}

/**
 * In-memory collaboration storage.
 *
 * Sufficient for unit tests. It enforces the same idempotency identities as
 * the SQLite implementation, so a test that passes here is a statement about
 * the contract rather than about one backend.
 */
export class InMemoryCollaborationStore implements CollaborationStore {
  readonly #readMarkers = new Map<string, number>();
  readonly #resolutions = new Map<string, CollaborationAttentionResolution>();
  readonly #observationTimes = new Map<string, number>();
  readonly #messages = new Map<string, Message>();
  readonly #byDeliveryKey = new Map<string, string>();
  readonly #events = new Map<string, ProjectEvent>();
  readonly #eventsByDeliveryKey = new Map<string, string>();
  readonly #wakes = new Map<string, WakeRequest>();
  /** Every observation recorded, keyed by the input it describes. */
  readonly #observations = new Map<string, WakeObservation[]>();
  /** Routing windows (#97), keyed by window id. */
  readonly #windows = new Map<string, RoutingWindow>();
  /** Window membership (the durable cursor), in join order. */
  readonly #windowInputs = new Map<string, string[]>();
  readonly #batches = new Map<string, RoutingBatch>();
  readonly #batchInputs = new Map<string, RoutingBatchInput[]>();
  readonly #attempts = new Map<string, RoutingAttempt[]>();
  readonly #outcomes = new Map<string, RoutingInputOutcome[]>();

  async unreadCount(scopeId: string, humanId: string): Promise<number> {
    const cursor = this.#readMarkers.get(JSON.stringify([scopeId, humanId])) ?? 0;
    return [...this.#messages.values()].filter((m, index) => index + 1 > cursor && m.scopeId === scopeId && m.author.id !== humanId).length;
  }

  async markReadThrough(scopeId: string, humanId: string, messageId: string): Promise<void> {
    const messages = [...this.#messages.values()];
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0 || messages[index]!.scopeId !== scopeId) throw new Error('Message does not belong to this scope');
    const key = JSON.stringify([scopeId, humanId]);
    this.#readMarkers.set(key, Math.max(this.#readMarkers.get(key) ?? 0, index + 1));
  }

  async postMessage(input: {
    readonly message: Message;
    readonly plan: WakePlan;
    readonly now: number;
    readonly collect?: RoutingWindowCollect;
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
    this.#storePlan(input.plan, input.message.projectId, input.now);
    const window =
      input.collect !== undefined
        ? this.#collectWindow(input.message.projectId, input.message.id, input.now, input.collect.intervalMs)
        : undefined;
    return {
      message: input.message,
      wakes: this.#wakesFor(input.message.id),
      duplicate: false,
      ...(window !== undefined ? { window } : {}),
    };
  }

  async publishEvent(input: {
    readonly event: ProjectEvent;
    readonly plan: WakePlan;
    readonly now: number;
    readonly collect?: RoutingWindowCollect;
  }): Promise<PublishEventResult> {
    const existingId = this.#eventsByDeliveryKey.get(input.event.deliveryKey);
    if (existingId !== undefined) {
      const existing = this.#events.get(existingId);
      if (existing) {
        return { event: existing, wakes: this.#wakesFor(existing.id), duplicate: true };
      }
    }
    this.#events.set(input.event.id, input.event);
    this.#eventsByDeliveryKey.set(input.event.deliveryKey, input.event.id);
    this.#storePlan(input.plan, input.event.projectId, input.now);
    const window =
      input.collect !== undefined
        ? this.#collectWindow(input.event.projectId, input.event.id, input.now, input.collect.intervalMs)
        : undefined;
    return {
      event: input.event,
      wakes: this.#wakesFor(input.event.id),
      duplicate: false,
      ...(window !== undefined ? { window } : {}),
    };
  }

  /**
   * Join the Project's open routing window, or open the fixed one.
   *
   * The first eligible input opens a window whose deadline is fixed at
   * `now + intervalMs`; later inputs join without moving that deadline — the
   * no-debounce rule that keeps a busy channel from starving its own routing.
   */
  #collectWindow(projectId: string, inputId: string, now: number, intervalMs: number): RoutingWindow {
    let window = [...this.#windows.values()].find(
      (candidate) => candidate.projectId === projectId && candidate.status === 'open',
    );
    if (window === undefined) {
      window = {
        id: `win-${projectId}-${now}-${this.#windows.size}`,
        projectId,
        openedAt: now,
        deadlineAt: now + intervalMs,
        intervalMs,
        status: 'open',
        cursor: inputId,
        inputCount: 1,
      };
      this.#windows.set(window.id, window);
      this.#windowInputs.set(window.id, [inputId]);
      return window;
    }
    const membership = this.#windowInputs.get(window.id) ?? [];
    if (!membership.includes(inputId)) membership.push(inputId);
    this.#windowInputs.set(window.id, membership);
    window = { ...window, cursor: inputId, inputCount: membership.length };
    this.#windows.set(window.id, window);
    return window;
  }

  #storePlan(plan: WakePlan, projectId: string, now: number): void {
    for (const decision of plan.decisions) {
      const wake = wakeFromDecision({
        id: `wake-${plan.inputId}-${decision.agentId}`,
        inputId: plan.inputId,
        projectId,
        agentId: decision.agentId,
        reason: decision.reason,
        now,
      });
      this.#wakes.set(wake.idempotencyKey, wake);
    }
    if (plan.observations.some(o => o.status === 'failed')) this.#observationTimes.set(plan.inputId, now);
    for (const observation of plan.observations) {
      this.#observations.set(plan.inputId, [
        ...(this.#observations.get(plan.inputId) ?? []),
        observation,
      ]);
    }
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

  async resolveAttention(input: ResolveCollaborationAttention): Promise<void> {
    const resolution = await validateAttentionResolution(this, input);
    const key = JSON.stringify([input.kind, input.sourceId]);
    const existing = this.#resolutions.get(key);
    if (existing === undefined || (input.kind === 'wake-input' && resolution.sourceVersion > existing.sourceVersion)) {
      this.#resolutions.set(key, resolution);
    }
  }

  async listAttentionResolutions(): Promise<readonly CollaborationAttentionResolution[]> {
    return [...this.#resolutions.values()];
  }

  async listWakeFailures(): Promise<readonly FailedWakeInput[]> {
    return [...this.#observations.entries()].flatMap(([inputId, observations]) => {
      const owner = this.#messages.get(inputId) ?? this.#events.get(inputId);
      const failures = observations.filter(o => o.status === 'failed');
      return owner === undefined || failures.length === 0 ? [] : [{
        inputId, inputKind: this.#messages.has(inputId) ? 'message' as const : 'event' as const, projectId: owner.projectId, failedTargetCount: new Set(failures.map(o => o.agentId)).size, version: failures.length,
        at: this.#observationTimes.get(inputId) ?? owner.createdAt,
      }];
    });
  }

  async getEvent(eventId: string): Promise<ProjectEvent | undefined> {
    return this.#events.get(eventId);
  }

  async getEventByDeliveryKey(deliveryKey: string): Promise<ProjectEvent | undefined> {
    const id = this.#eventsByDeliveryKey.get(deliveryKey);
    return id === undefined ? undefined : this.#events.get(id);
  }

  async listEvents(projectId?: string): Promise<readonly ProjectEvent[]> {
    return [...this.#events.values()]
      .filter((event) => projectId === undefined || event.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt);
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
    readonly inputId: string;
    readonly observation: WakeObservation;
    readonly now: number;
  }): Promise<void> {
    if (input.observation.status === 'failed') this.#observationTimes.set(input.inputId, input.now);
    this.#observations.set(input.inputId, [
      ...(this.#observations.get(input.inputId) ?? []),
      input.observation,
    ]);
  }

  async listObservations(inputId: string): Promise<readonly WakeObservation[]> {
    return this.#observations.get(inputId) ?? [];
  }

  async listRoutingWindows(projectId?: string): Promise<readonly RoutingWindow[]> {
    return [...this.#windows.values()]
      .filter((window) => projectId === undefined || window.projectId === projectId)
      .sort((a, b) => a.openedAt - b.openedAt);
  }

  async freezeRoutingWindow(input: {
    readonly windowId: string;
    readonly now: number;
    readonly batches: readonly FrozenRoutingBatchPlan[];
  }): Promise<readonly RoutingBatch[]> {
    const window = this.#windows.get(input.windowId);
    if (window === undefined || window.status !== 'open') return [];
    this.#windows.set(window.id, { ...window, status: 'closed', closedAt: input.now });
    const frozen = input.batches.map((plan) => {
      const batch: RoutingBatch = {
        id: plan.batchId,
        projectId: window.projectId,
        windowId: window.id,
        splitIndex: plan.splitIndex,
        splitCount: plan.splitCount,
        cutoffAt: plan.cutoffAt,
        status: 'frozen',
        bounds: plan.bounds,
        manifest: plan.manifest,
        context: plan.context,
        createdAt: input.now,
      };
      this.#batches.set(batch.id, batch);
      this.#batchInputs.set(batch.id, [...plan.inputs]);
      return batch;
    });
    return frozen;
  }

  async listRoutingBatches(projectId?: string): Promise<readonly RoutingBatch[]> {
    return [...this.#batches.values()]
      .filter((batch) => projectId === undefined || batch.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt || a.splitIndex - b.splitIndex);
  }

  async listRoutingWindowInputs(windowId: string): Promise<readonly string[]> {
    return [...(this.#windowInputs.get(windowId) ?? [])];
  }

  async getRoutingBatch(batchId: string): Promise<RoutingBatch | undefined> {
    return this.#batches.get(batchId);
  }

  async listRoutingBatchInputs(batchId: string): Promise<readonly RoutingBatchInput[]> {
    return [...(this.#batchInputs.get(batchId) ?? [])].sort((a, b) => a.position - b.position);
  }

  async recordRoutingAttempt(attempt: RoutingAttempt): Promise<void> {
    const attempts = this.#attempts.get(attempt.batchId) ?? [];
    const index = attempts.findIndex((row) => row.attemptNumber === attempt.attemptNumber);
    if (index < 0) attempts.push(attempt);
    else if (attempts[index]!.id === attempt.id && attempts[index]!.status === 'started') attempts[index] = attempt;
    else throw new Error('routing attempt already completed');
    this.#attempts.set(attempt.batchId, attempts);
  }

  async listRoutingAttempts(batchId: string): Promise<readonly RoutingAttempt[]> {
    return [...(this.#attempts.get(batchId) ?? [])].sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async settleRoutingBatch(input: {
    readonly batchId: string;
    readonly status: Extract<RoutingBatch['status'], 'routed' | 'suppressed' | 'failed'>;
    readonly error?: string;
    readonly outcomes: readonly RoutingInputOutcome[];
    readonly wakes?: readonly WakeRequest[];
    readonly now: number;
  }): Promise<void> {
    const batch = this.#batches.get(input.batchId);
    if (batch === undefined) throw new Error(`unknown routing batch: ${input.batchId}`);
    // Same compare-and-set as the SQLite store: the first settle wins, a repeat
    // is an idempotent no-op (one outcome set, one wake per selected Agent).
    if (batch.status !== 'frozen') return;
    this.#batches.set(batch.id, {
      ...batch,
      status: input.status,
      ...(input.error !== undefined ? { error: input.error } : {}),
      settledAt: input.now,
    });
    this.#outcomes.set(input.batchId, [...input.outcomes]);
    for (const wake of input.wakes ?? []) {
      this.#wakes.set(wake.idempotencyKey, wake);
    }
  }

  async listRoutingOutcomes(batchId: string): Promise<readonly RoutingInputOutcome[]> {
    return [...(this.#outcomes.get(batchId) ?? [])];
  }

  async listRoutingOutcomesForInput(inputId: string): Promise<readonly RoutingInputOutcome[]> {
    return [...this.#outcomes.values()]
      .flat()
      .filter((outcome) => outcome.inputId === inputId);
  }

  #wakesFor(inputId: string): readonly WakeRequest[] {
    return [...this.#wakes.values()].filter((wake) => wake.inputId === inputId);
  }
}
