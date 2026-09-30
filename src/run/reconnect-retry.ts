/**
 * Bounded reconnect retry for environment-disconnected run admissions (#181).
 *
 * The owner's decision (recorded on #77): when any Environment in a Project
 * reconnects, the Agent runs that failed **because that Project's Environments
 * were disconnected** are retried — gated on the first Environment reconnect
 * after **all** Environments of that Project were disconnected, exactly once
 * per run, durably and idempotently.
 *
 * ## One durable state machine
 *
 * `RunReconnectRetryStore` holds three records and nothing else: a per-Project
 * gate (armed while every granted Environment is disconnected), a trigger per
 * consumed gate (the first reconnect that can admit work again), and one retry
 * row per eligible original run (`queued → dispatched → settled`). Every
 * record is persisted before the action it authorizes, so a crash at any point
 * is finished by the next pass rather than lost or redone:
 *
 * - gate armed, crash before the trigger → the gate stays armed; the next
 *   qualifying reconnect triggers;
 * - trigger recorded, crash before eligibility → reconciliation rebuilds the
 *   eligible set idempotently (rows are keyed by the original run id);
 * - rows queued, crash before dispatch → reconciliation dispatches them;
 * - row dispatched, crash before submit → the durably named retry run id does
 *   not exist yet, so the same id is submitted — never a second one;
 * - retry run settled, crash before reply projection → reconciliation
 *   re-projects idempotently (the reply delivery key is wake-derived).
 *
 * ## Eligibility is durable and narrow
 *
 * A failed run qualifies only when its durable record says the failure was
 * `no available environment for capability: …` (disconnection/absence for the
 * required capability), it failed **before** any environment resolved — and
 * therefore before any engine could accept it — it carries a Project scope,
 * and it is not itself a retry. Engine-accepted interrupted runs stay under
 * the existing recovery semantics (no silent replay); every unrelated failure
 * stays fail-fast; and a retry run that fails again is never retried, because
 * its own record carries `retryOfRunId`.
 *
 * ## The trigger waits for a reconnect that can actually work
 *
 * The consumed gate fires the first time a granted Environment of the armed
 * Project is both reconnected and able to admit work (`canAdmitWork`). A
 * socket-level reconnect whose readiness has not been re-established would
 * only fail the retry again, burning the one bounded attempt; while armed,
 * nothing else can make an Environment admissible, so this moment is exactly
 * "the first Environment reconnect after all Environments were disconnected",
 * observed when it is real. Because arming requires **zero** connected
 * Environments, a reconnect while any other Environment stayed connected never
 * consumes the gate.
 *
 * All entry points are serialized on one internal chain: connection/catalog
 * observations, run-settlement notifications, and restart reconciliation can
 * interleave but never race a trigger or a dispatch.
 */

import type { IdFactory } from '../ids.ts';
import { createIdFactory } from '../ids.ts';
import type { AgentRun } from './model.ts';
import type {
  RunReconnectRetryStore,
  RunReconnectTrigger,
} from './reconnect-retry-store.ts';

/**
 * The one failure class the bounded retry admits (#181).
 *
 * The orchestrator produces this message — and only this message — when run
 * admission cannot resolve any Environment instance for the Agent's required
 * capability, before a lease is taken and before any engine session starts. It
 * carries only the capability name, so it is sanitized by construction. A
 * permission failure (`no project grants …`), a compatibility failure (`no
 * compatible work option …`), a lease/busy failure, and every engine-phase
 * failure produce different messages and remain fail-fast.
 */
const ENVIRONMENT_DISCONNECTED_FAILURE =
  /^no available environment for capability: [A-Za-z0-9_-]+$/;

/**
 * Whether one durable run record is eligible for the bounded reconnect retry.
 *
 * Deliberately a pure function of the run record: eligibility is durable, so
 * the same predicate decides at trigger time and during restart reconciliation
 * without re-deriving any transient connection fact.
 */
export function isEnvironmentDisconnectedFailure(run: AgentRun): boolean {
  return (
    run.status === 'failed' &&
    run.projectId !== undefined &&
    // A Task-nested run is bound to its Task's lease and environment; it is
    // never part of this run-level admission retry.
    run.taskId === undefined &&
    // Never resolved an environment → never leased → no engine could accept it.
    run.environmentInstanceId === '' &&
    // The one-retry bound lives on the run record itself.
    run.retryOfRunId === undefined &&
    run.failure !== undefined &&
    ENVIRONMENT_DISCONNECTED_FAILURE.test(run.failure)
  );
}

/** The Project Environment facts the gate and trigger resolve against. */
export interface RunReconnectRetryProjectFacts {
  readonly projectId: string;
  /** Every Environment instance the Project currently grants for work. */
  readonly instanceIds: readonly string[];
}

/** The slice of the run orchestrator the retry service uses. */
export interface RunReconnectRetryRunPort {
  /** Submit the linked retry run under a durably named id. */
  submit(request: {
    readonly runId: string;
    readonly agentId: string;
    readonly prompt: string;
    readonly projectId: string;
    readonly retryOfRunId: string;
  }): Promise<{ readonly id: string }>;
  load(runId: string): Promise<AgentRun | undefined>;
  list(): Promise<readonly AgentRun[]>;
  /** Terminal-state notifications, so a settled retry settles its row. */
  subscribe?(observer: (run: AgentRun) => void): () => void;
}

export interface RunReconnectRetryOptions {
  readonly store: RunReconnectRetryStore;
  readonly runs: RunReconnectRetryRunPort;
  /** Current Project Environment grants, in registry order. */
  readonly projects: () => readonly RunReconnectRetryProjectFacts[];
  /** Whether an Environment instance currently holds an accepted connection. */
  readonly isConnected: (instanceId: string) => boolean;
  /**
   * Whether an Environment instance can currently admit work: connected, in
   * the admission projection, and otherwise work-ready.
   */
  readonly canAdmitWork: (instanceId: string) => boolean;
  /**
   * Told once a retry run reaches its terminal state, so the wake's reply can
   * be projected idempotently (the reply key is wake-derived, so re-running
   * this can never duplicate a Message). Errors leave the row `dispatched`
   * and are retried by a later pass.
   */
  readonly onRetrySettled?: (input: {
    readonly originalRunId: string;
    readonly retryRunId: string;
  }) => Promise<unknown>;
  readonly ids?: IdFactory;
  readonly clock?: { now(): number };
}

/** What one pass over the state machine did; reconciliation evidence (#181). */
export interface RunReconnectRetryReconcileResult {
  /** Projects whose gate entered the armed (full-disconnect) state. */
  readonly armedProjects: readonly string[];
  /** Projects whose armed gate was consumed by a qualifying reconnect. */
  readonly triggeredProjects: readonly string[];
  /** Original runs queued as eligible by this pass. */
  readonly queuedRunIds: readonly string[];
  /** Linked retry run ids this pass durably dispatched. */
  readonly dispatchedRetryRunIds: readonly string[];
  /** Original runs whose retry reached its settled completion this pass. */
  readonly settledRunIds: readonly string[];
}

function isTerminal(status: AgentRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

export class RunReconnectRetry {
  readonly #store: RunReconnectRetryStore;
  readonly #runs: RunReconnectRetryRunPort;
  readonly #projects: () => readonly RunReconnectRetryProjectFacts[];
  readonly #isConnected: (instanceId: string) => boolean;
  readonly #canAdmitWork: (instanceId: string) => boolean;
  readonly #onRetrySettled: RunReconnectRetryOptions['onRetrySettled'];
  readonly #ids: IdFactory;
  readonly #fallbackIds = createIdFactory();
  readonly #clock: { now(): number };
  /** One serialized chain: observations, settlements, and passes never race. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: RunReconnectRetryOptions) {
    this.#store = options.store;
    this.#runs = options.runs;
    this.#projects = options.projects;
    this.#isConnected = options.isConnected;
    this.#canAdmitWork = options.canAdmitWork;
    this.#onRetrySettled = options.onRetrySettled;
    this.#ids = options.ids ?? createIdFactory();
    this.#clock = options.clock ?? { now: () => Date.now() };
    options.runs.subscribe?.((run) => {
      if (run.retryOfRunId === undefined || !isTerminal(run.status)) return;
      void this.#enqueue(() => this.#settleRetry(run.retryOfRunId!)).catch(() => undefined);
    });
    // Establish the durable gate for every Project as soon as the graph exists:
    // a process starts with no live Environment connections, so every Project
    // granting an Environment begins a full-disconnect episode that its first
    // qualifying reconnect may consume. Idempotent, and ordered ahead of any
    // later observation on the same chain.
    void this.#enqueue(() => this.#pass()).catch(() => {
      process.stderr.write(
        '[run-retry] reconnect-retry initialization could not be evaluated; durable state is unchanged\n',
      );
    });
  }

  /**
   * Re-evaluate gates, finish interrupted triggers, and advance retry rows.
   *
   * Called on every catalog/connection publication and safe to call often:
   * each step is durable-idempotent, so a redundant pass changes nothing. The
   * result reports what this pass did, for observability and tests.
   */
  noteEnvironmentState(): Promise<RunReconnectRetryReconcileResult> {
    return this.#enqueue(() => this.#pass());
  }

  /** Restart reconciliation: the same durable pass, reported as evidence. */
  reconcile(): Promise<RunReconnectRetryReconcileResult> {
    return this.#enqueue(() => this.#pass());
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(fn, fn);
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #pass(): Promise<RunReconnectRetryReconcileResult> {
    const armedProjects: string[] = [];
    const triggeredProjects: string[] = [];
    const queuedRunIds: string[] = [];
    const dispatchedRetryRunIds: string[] = [];
    const settledRunIds: string[] = [];

    for (const project of this.#projects()) {
      if (project.instanceIds.length === 0) {
        // A Project with no granted Environment has nothing that can reconnect;
        // its failures stay fail-fast until an Environment is granted.
        continue;
      }
      const connected = project.instanceIds.some((instanceId) => this.#isConnected(instanceId));
      if (!connected) {
        const gate = await this.#store.getGate(project.projectId);
        if (gate?.armed !== true) {
          await this.#store.armGate(project.projectId, this.#clock.now());
          armedProjects.push(project.projectId);
        }
      }
      const gate = await this.#store.getGate(project.projectId);
      if (gate?.armed === true && project.instanceIds.some((id) => this.#canAdmitWork(id))) {
        const trigger = await this.#consumeGate(project.projectId);
        if (trigger !== undefined) {
          triggeredProjects.push(project.projectId);
          queuedRunIds.push(...(await this.#buildEligibility(trigger)));
        }
      }
    }

    // Finish any eligibility build an interrupted process left open. Row
    // inserts are keyed by the original run id, so rebuilding is idempotent
    // and can never queue a run twice.
    for (const trigger of await this.#store.listUnsettledTriggers()) {
      queuedRunIds.push(...(await this.#buildEligibility(trigger)));
    }

    const advanced = await this.#advanceRetries();
    dispatchedRetryRunIds.push(...advanced.dispatchedRetryRunIds);
    settledRunIds.push(...advanced.settledRunIds);

    return {
      armedProjects,
      triggeredProjects,
      queuedRunIds: [...new Set(queuedRunIds)],
      dispatchedRetryRunIds: [...new Set(dispatchedRetryRunIds)],
      settledRunIds: [...new Set(settledRunIds)],
    };
  }

  /** Durably consume this Project's armed gate into its one trigger. */
  async #consumeGate(projectId: string): Promise<RunReconnectTrigger | undefined> {
    const trigger: RunReconnectTrigger = {
      id: this.#ids.retryTrigger?.() ?? this.#fallbackIds.retryTrigger!(),
      projectId,
      at: this.#clock.now(),
      eligibilitySettled: false,
    };
    return this.#store.createTriggerIfArmed(trigger);
  }

  /**
   * Persist the eligible-run set for one trigger, then mark it settled.
   *
   * Built from durable run records only, in chronological order, and filtered
   * to the trigger's own Project so another Project's failures can never be
   * swept into this wave.
   */
  async #buildEligibility(trigger: RunReconnectTrigger): Promise<readonly string[]> {
    const eligible = (await this.#runs.list())
      .filter((run) => run.projectId === trigger.projectId && isEnvironmentDisconnectedFailure(run))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const queued: string[] = [];
    for (const run of eligible) {
      const inserted = await this.#store.queueRetry({
        originalRunId: run.id,
        triggerId: trigger.id,
        projectId: trigger.projectId,
        now: this.#clock.now(),
      });
      if (inserted) queued.push(run.id);
    }
    await this.#store.settleTrigger(trigger.id);
    return queued;
  }

  /**
   * Dispatch queued rows, finish crash-window rows, and settle terminal
   * retries — always durable-first, always one retry per original run.
   */
  async #advanceRetries(): Promise<{
    readonly dispatchedRetryRunIds: readonly string[];
    readonly settledRunIds: readonly string[];
  }> {
    const dispatchedRetryRunIds: string[] = [];
    const settledRunIds: string[] = [];
    for (const row of await this.#store.listRetries()) {
      if (row.state === 'queued') {
        const retryRunId = this.#ids.run();
        // Durably name the linked retry run before submitting it. The claim is
        // compare-and-set, so a re-entered pass can never dispatch twice.
        const claimed = await this.#store.markDispatched(
          row.originalRunId,
          retryRunId,
          this.#clock.now(),
        );
        if (!claimed) continue;
        if (await this.#submitRetry(row.originalRunId, retryRunId)) {
          dispatchedRetryRunIds.push(retryRunId);
        }
        continue;
      }
      if (row.state !== 'dispatched' || row.retryRunId === undefined) continue;
      const retry = await this.#runs.load(row.retryRunId);
      if (retry === undefined) {
        // Crash window: the durable id exists but the run was never recorded.
        // Submit under exactly that id, so reconciliation can never create a
        // second linked run for one original.
        if (await this.#submitRetry(row.originalRunId, row.retryRunId)) {
          dispatchedRetryRunIds.push(row.retryRunId);
        }
        continue;
      }
      if (isTerminal(retry.status)) {
        const settled = await this.#settleRetry(row.originalRunId);
        if (settled !== undefined) settledRunIds.push(settled);
      }
    }
    return { dispatchedRetryRunIds, settledRunIds };
  }

  /** Submit one linked retry from the original run's own durable facts. */
  async #submitRetry(originalRunId: string, retryRunId: string): Promise<boolean> {
    const original = await this.#runs.load(originalRunId);
    // Never dispatch an original that is missing or no longer eligible: the
    // durable record is the authority, and an ambiguous row stays visible
    // rather than starting unowned work.
    if (original === undefined || original.projectId === undefined ||
        !isEnvironmentDisconnectedFailure(original)) {
      process.stderr.write(
        `[run-retry] durable retry for run ${originalRunId} is not dispatchable; retained for inspection\n`,
      );
      return false;
    }
    try {
      const submitted = await this.#runs.submit({
        runId: retryRunId,
        agentId: original.agentId,
        prompt: original.prompt,
        projectId: original.projectId,
        retryOfRunId: originalRunId,
      });
      if (submitted.id !== retryRunId) {
        process.stderr.write(
          `[run-retry] orchestrator renamed the retry of run ${originalRunId}; the durable row keeps the submitted id\n`,
        );
      }
      return true;
    } catch {
      // The row stays `dispatched` with its durable id; the next pass finds no
      // run and re-submits the same id. Never fail the caller's observation.
      process.stderr.write(
        `[run-retry] dispatch of the retry for run ${originalRunId} failed; it will be re-dispatched\n`,
      );
      return false;
    }
  }

  /**
   * Settle one dispatched retry whose run reached its terminal state: project
   * the wake's reply idempotently, then persist completion.
   */
  async #settleRetry(originalRunId: string): Promise<string | undefined> {
    const row = await this.#store.getRetry(originalRunId);
    if (row === undefined || row.state !== 'dispatched' || row.retryRunId === undefined) {
      return undefined;
    }
    const retry = await this.#runs.load(row.retryRunId);
    if (retry === undefined || !isTerminal(retry.status)) return undefined;
    if (this.#onRetrySettled !== undefined) {
      // A projection error propagates: the row stays `dispatched` and a later
      // pass retries it; the reply's wake-derived delivery key makes that safe.
      await this.#onRetrySettled({ originalRunId, retryRunId: row.retryRunId });
    }
    await this.#store.markSettled(originalRunId, this.#clock.now());
    return originalRunId;
  }
}
