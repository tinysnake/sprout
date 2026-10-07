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
 * gate (armed after every granted Environment disconnects), a trigger per
 * consumed gate (an accepted connection witnessed while armed, once it can
 * admit work), and one retry
 * row per eligible original run (`queued → dispatched → settled`). Every
 * record is persisted before the action it authorizes, so a crash at any point
 * is finished by the next pass rather than lost or redone:
 *
 * - gate armed, crash before the trigger → the gate stays armed; the next
 *   qualifying reconnect triggers;
 * - trigger/eligible rows/gate disarm commit together; a crash before commit
 *   leaves the armed gate for a later accepted connection, and a crash after
 *   commit finds the same queued rows without another trigger;
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
 * Only an accepted connection transition witnessed for a granted Environment
 * while the gate is armed can consume it. The transition is held until its
 * readiness permits admission; a later grant of an already-connected Worker
 * cannot consume the gate. Because arming requires zero connected granted
 * Environments, a reconnect while another stayed connected never qualifies.
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
 * Maximum wait budget for reconnect observations. Runtime starts this drain
 * alongside Web and Worker teardown, leaving five seconds for ordinary store
 * latency while keeping the retry queue from extending operator shutdown
 * indefinitely after those longer lifecycle waits have already begun.
 */
export const RUN_RECONNECT_RETRY_SHUTDOWN_DEADLINE_MS = 5_000;

export class RunReconnectRetryShutdownError extends Error {
  constructor() {
    super('reconnect observation stopped during runtime shutdown');
    this.name = 'RunReconnectRetryShutdownError';
  }
}

/** Guard store ports so an abandoned pass cannot resume durable work post-close. */
function guardedPort<T extends object>(port: T, assertOpen: () => void): T {
  return new Proxy(port, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        assertOpen();
        return Reflect.apply(member, target, args);
      };
    },
  });
}

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
  #acceptingObservations = true;
  #abandonPendingObservations = false;
  #pendingObservations = 0;
  #inFlightObservations = 0;
  /** Accepted transitions witnessed while an armed Project grants the instance. */
  readonly #pendingConnections = new Map<string, Set<string>>();

  constructor(options: RunReconnectRetryOptions) {
    this.#store = guardedPort(options.store, () => this.#assertStoreAccessAllowed());
    this.#runs = guardedPort(options.runs, () => this.#assertStoreAccessAllowed());
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
    void this.noteEnvironmentState().catch(() => {
      process.stderr.write(
        '[run-retry] reconnect-retry initialization could not be evaluated; durable state is unchanged\n',
      );
    });
  }

  /**
   * Re-evaluate gates, finish interrupted triggers, and advance retry rows.
   *
   * Called on every catalog/connection publication; only the gateway's actual
   * accepted connection passes its instance id. Safe to call often:
   * each step is durable-idempotent, so a redundant pass changes nothing. The
   * result reports what this pass did, for observability and tests.
   */
  noteEnvironmentState(acceptedInstanceId?: string): Promise<RunReconnectRetryReconcileResult> {
    // Snapshot at publication, not after an asynchronous catalog refresh: a
    // rapid loss/reconnect must still arm before its accepted transition.
    const projects = this.#projects().map((project) => ({
      ...project,
      instanceIds: [...project.instanceIds],
      connected: project.instanceIds.some((id) => this.#isConnected(id)),
    }));
    return this.#enqueue(() => this.#pass(projects, acceptedInstanceId));
  }

  /** Restart reconciliation: the same durable pass, reported as evidence. */
  reconcile(): Promise<RunReconnectRetryReconcileResult> {
    return this.#enqueue(() => this.#pass());
  }

  /**
   * Stop accepting observations and wait up to the shutdown deadline for work
   * already accepted. Runtime starts this alongside transport teardown and
   * closes stores only after this promise settles.
   */
  async stopAcceptingAndDrain(
    timeoutMs = RUN_RECONNECT_RETRY_SHUTDOWN_DEADLINE_MS,
  ): Promise<void> {
    this.#acceptingObservations = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      this.#chain.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (drained || this.#pendingObservations === 0) return;

    // Mark the active pass as abandoned before returning. Its guarded ports
    // reject any later store/run operation, and queued passes reject without
    // starting, so closing stores cannot turn a late continuation into access
    // to a closed handle.
    this.#abandonPendingObservations = true;
    const abandoned = this.#pendingObservations;
    const queued = Math.max(0, abandoned - this.#inFlightObservations);
    process.stderr.write(
      `[run-retry] shutdown deadline exceeded; abandoned ${abandoned} pending observation(s) ` +
      `(${this.#inFlightObservations} in flight, ${queued} queued)\n`,
    );
  }

  #assertStoreAccessAllowed(): void {
    if (this.#abandonPendingObservations) {
      throw new RunReconnectRetryShutdownError();
    }
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.#acceptingObservations) {
      return Promise.reject(new RunReconnectRetryShutdownError());
    }
    this.#pendingObservations += 1;
    const result = this.#chain.then(async () => {
      if (this.#abandonPendingObservations) {
        throw new RunReconnectRetryShutdownError();
      }
      this.#inFlightObservations += 1;
      try {
        return await fn();
      } finally {
        this.#inFlightObservations -= 1;
      }
    });
    this.#chain = result.then(
      () => { this.#pendingObservations -= 1; },
      () => { this.#pendingObservations -= 1; },
    );
    return result;
  }

  async #pass(
    observed?: readonly (RunReconnectRetryProjectFacts & { readonly connected: boolean })[],
    acceptedInstanceId?: string,
  ): Promise<RunReconnectRetryReconcileResult> {
    const armedProjects: string[] = [];
    const triggeredProjects: string[] = [];
    const queuedRunIds: string[] = [];
    const dispatchedRetryRunIds: string[] = [];
    const settledRunIds: string[] = [];

    for (const project of observed ?? this.#projects().map((p) => ({
      ...p, connected: p.instanceIds.some((id) => this.#isConnected(id)),
    }))) {
      if (project.instanceIds.length === 0) {
        // A Project with no granted Environment has nothing that can reconnect;
        // its failures stay fail-fast until an Environment is granted.
        this.#pendingConnections.delete(project.projectId);
        continue;
      }
      if (!project.connected) {
        this.#pendingConnections.delete(project.projectId);
        const gate = await this.#store.getGate(project.projectId);
        if (gate?.armed !== true) {
          await this.#store.armGate(project.projectId, this.#clock.now());
          armedProjects.push(project.projectId);
        }
      }
      const gate = await this.#store.getGate(project.projectId);
      if (gate?.armed !== true) this.#pendingConnections.delete(project.projectId);
      const pending = this.#pendingConnections.get(project.projectId);
      // A grant or a catalog refresh cannot manufacture an accepted transition.
      // Retain every witnessed transition until it disconnects, loses its grant,
      // or the gate is consumed; readiness may arrive in any order.
      if (pending) {
        for (const id of pending) {
          if (!project.instanceIds.includes(id) || !this.#isConnected(id)) pending.delete(id);
        }
      }
      if (gate?.armed === true && acceptedInstanceId !== undefined &&
          project.instanceIds.includes(acceptedInstanceId) && this.#isConnected(acceptedInstanceId)) {
        const candidates = this.#pendingConnections.get(project.projectId) ?? new Set<string>();
        candidates.add(acceptedInstanceId);
        this.#pendingConnections.set(project.projectId, candidates);
      }
      const candidate = [...(this.#pendingConnections.get(project.projectId) ?? [])]
        .find((id) => this.#canAdmitWork(id));
      if (gate?.armed === true && candidate !== undefined) {
        const eligible = (await this.#runs.list())
          .filter((run) => run.projectId === project.projectId && isEnvironmentDisconnectedFailure(run))
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        const unqueued = [];
        for (const run of eligible) {
          if (await this.#store.getRetry(run.id) === undefined) unqueued.push(run.id);
        }
        const trigger = await this.#consumeGate(project.projectId, unqueued);
        if (trigger !== undefined) {
          triggeredProjects.push(project.projectId);
          queuedRunIds.push(...unqueued);
          this.#pendingConnections.delete(project.projectId);
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
  async #consumeGate(projectId: string, eligibleRunIds: readonly string[]): Promise<RunReconnectTrigger | undefined> {
    const trigger: RunReconnectTrigger = {
      id: this.#ids.retryTrigger?.() ?? this.#fallbackIds.retryTrigger!(),
      projectId,
      at: this.#clock.now(),
      eligibilitySettled: false,
    };
    return this.#store.createTriggerIfArmed(trigger, eligibleRunIds.map((originalRunId) => ({
      originalRunId, triggerId: trigger.id, projectId, now: trigger.at,
    })));
  }

  /**
   * Finish an older interrupted eligible-run build (new waves commit atomically).
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
