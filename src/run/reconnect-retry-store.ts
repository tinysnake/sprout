/**
 * Durable state for the bounded reconnect retry of environment-disconnected
 * run admissions (#181).
 *
 * One small state machine, persisted before any action:
 *
 * - A **gate** per Project records whether every Environment the Project
 *   grants is currently disconnected (`armed`). The first later Environment
 *   reconnect that can admit work consumes exactly one gate.
 * - A **trigger** is the durable record of one consumed gate: the first
 *   Environment reconnect after that Project's full disconnect. Its
 *   `eligibilitySettled` flag marks that the eligible-run set for this trigger
 *   has been persisted, so an interrupted build is finished by restart
 *   reconciliation instead of being lost or redone blindly.
 * - A **retry** row is one eligible original run, keyed by the original run id
 *   (so a run can be queued at most once, ever) and moving through
 *   `queued → dispatched → settled`. `dispatched` durably names the linked
 *   retry run id *before* the orchestrator is asked to submit it, which is what
 *   makes restart reconciliation idempotent: a dispatched row whose run is
 *   missing is re-submitted under the same id, never a second id.
 *
 * The SQLite adapter persists these rows beside the run domain's other tables;
 * the in-memory adapter serves tests and the no-filesystem composition.
 */

/** The per-Project full-disconnect gate (#181). */
export interface ProjectRetryGate {
  readonly projectId: string;
  /** True while every Environment the Project grants is disconnected. */
  readonly armed: boolean;
  /** When the gate last entered the armed state, if currently armed. */
  readonly armedAt?: number;
  readonly updatedAt: number;
}

/** One consumed gate: the first Environment reconnect after a full disconnect. */
export interface RunReconnectTrigger {
  readonly id: string;
  readonly projectId: string;
  readonly at: number;
  /**
   * True once the eligible-run set for this trigger has been fully persisted.
   * A trigger that is not settled is finished by reconciliation (idempotent
   * row inserts), never skipped.
   */
  readonly eligibilitySettled: boolean;
}

export type RunReconnectRetryState = 'queued' | 'dispatched' | 'settled';

/** One original run's bounded retry, from eligibility to settled completion. */
export interface RunReconnectRetry {
  /** The original failed run; the primary key of the single-retry bound. */
  readonly originalRunId: string;
  readonly triggerId: string;
  readonly projectId: string;
  readonly state: RunReconnectRetryState;
  /** The linked retry run, durably named before it is submitted. */
  readonly retryRunId?: string;
  readonly queuedAt: number;
  readonly dispatchedAt?: number;
  readonly settledAt?: number;
}

/** One row to queue during eligibility building. */
export interface QueueRunReconnectRetry {
  readonly originalRunId: string;
  readonly triggerId: string;
  readonly projectId: string;
  readonly now: number;
}

/**
 * Durable storage for the reconnect-retry state machine (#181).
 *
 * Every mutating method is idempotent or compare-and-set guarded, so the
 * service may re-run any step after a restart without double-retrying a run.
 */
export interface RunReconnectRetryStore {
  getGate(projectId: string): Promise<ProjectRetryGate | undefined>;
  /** Arm a Project's gate; idempotent while already armed. */
  armGate(projectId: string, now: number): Promise<void>;
  /**
   * Consume an armed gate into its trigger: record the trigger and disarm in
   * one step. Returns the trigger only when the gate was armed, so a reconnect
   * while any Environment stayed connected (or a second reconnect after the
   * first consumed the gate) can never create a second trigger.
   */
  createTriggerIfArmed(trigger: RunReconnectTrigger): Promise<RunReconnectTrigger | undefined>;
  /** Persist that the trigger's eligible-run set is complete. */
  settleTrigger(triggerId: string): Promise<void>;
  /** Triggers whose eligible-run set was never completed, for reconciliation. */
  listUnsettledTriggers(): Promise<readonly RunReconnectTrigger[]>;
  /** Queue one eligible original run; false when it already has a retry row. */
  queueRetry(row: QueueRunReconnectRetry): Promise<boolean>;
  getRetry(originalRunId: string): Promise<RunReconnectRetry | undefined>;
  /** `queued → dispatched`; false unless this row was still queued. */
  markDispatched(originalRunId: string, retryRunId: string, now: number): Promise<boolean>;
  /** `dispatched → settled`; idempotent. */
  markSettled(originalRunId: string, now: number): Promise<void>;
  listRetries(): Promise<readonly RunReconnectRetry[]>;
}

/** In-memory adapter for tests and the no-filesystem composition. */
export class InMemoryRunReconnectRetryStore implements RunReconnectRetryStore {
  readonly #gates = new Map<string, ProjectRetryGate>();
  readonly #triggers = new Map<string, RunReconnectTrigger>();
  readonly #retries = new Map<string, RunReconnectRetry>();

  async getGate(projectId: string): Promise<ProjectRetryGate | undefined> {
    return this.#gates.get(projectId);
  }

  async armGate(projectId: string, now: number): Promise<void> {
    const existing = this.#gates.get(projectId);
    if (existing?.armed === true) return;
    this.#gates.set(projectId, {
      projectId,
      armed: true,
      armedAt: now,
      updatedAt: now,
    });
  }

  async createTriggerIfArmed(
    trigger: RunReconnectTrigger,
  ): Promise<RunReconnectTrigger | undefined> {
    const gate = this.#gates.get(trigger.projectId);
    if (gate?.armed !== true) return undefined;
    this.#triggers.set(trigger.id, trigger);
    this.#gates.set(trigger.projectId, { ...gate, armed: false, updatedAt: trigger.at });
    return trigger;
  }

  async settleTrigger(triggerId: string): Promise<void> {
    const trigger = this.#triggers.get(triggerId);
    if (trigger === undefined || trigger.eligibilitySettled) return;
    this.#triggers.set(triggerId, { ...trigger, eligibilitySettled: true });
  }

  async listUnsettledTriggers(): Promise<readonly RunReconnectTrigger[]> {
    return [...this.#triggers.values()].filter((trigger) => !trigger.eligibilitySettled);
  }

  async queueRetry(row: QueueRunReconnectRetry): Promise<boolean> {
    if (this.#retries.has(row.originalRunId)) return false;
    this.#retries.set(row.originalRunId, {
      originalRunId: row.originalRunId,
      triggerId: row.triggerId,
      projectId: row.projectId,
      state: 'queued',
      queuedAt: row.now,
    });
    return true;
  }

  async getRetry(originalRunId: string): Promise<RunReconnectRetry | undefined> {
    return this.#retries.get(originalRunId);
  }

  async markDispatched(
    originalRunId: string,
    retryRunId: string,
    now: number,
  ): Promise<boolean> {
    const row = this.#retries.get(originalRunId);
    if (row === undefined || row.state !== 'queued') return false;
    this.#retries.set(originalRunId, {
      ...row,
      state: 'dispatched',
      retryRunId,
      dispatchedAt: now,
    });
    return true;
  }

  async markSettled(originalRunId: string, now: number): Promise<void> {
    const row = this.#retries.get(originalRunId);
    if (row === undefined || row.state !== 'dispatched') return;
    this.#retries.set(originalRunId, { ...row, state: 'settled', settledAt: now });
  }

  async listRetries(): Promise<readonly RunReconnectRetry[]> {
    return [...this.#retries.values()].sort((a, b) => a.queuedAt - b.queuedAt);
  }
}
