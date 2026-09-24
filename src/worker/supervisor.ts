import type { EngineAdapter } from '../engine/port.ts';
import type { WorkerConnection } from './carrier.ts';
import type { WorkerContextClient } from './client.ts';
import type { ValidateWorkspaceParams, ValidateWorkspaceResult, WorkerInfo } from './protocol.ts';

/**
 * Keeps an environment's worker alive across its death.
 *
 * A worker is a separate process, so it can die while the core keeps running.
 * Without this, one worker death would permanently poison the environment: every
 * later run would fail against a closed channel and no worker would ever come
 * back, turning a transient crash into a permanent outage.
 *
 * Reconnection is **lazy**: a worker is only started when there is work for it,
 * so a crash cannot cause a hot restart loop, and an environment nobody is using
 * costs no process.
 *
 * What this deliberately does **not** do is revive the run that was in flight
 * when the worker died. That run already failed explicitly, and resuming it is
 * O4's durable-work recovery, not the worker seam's job.
 */

export interface WorkerSupervisorOptions {
  /** Starts a worker and connects to it. Called again after a death. */
  readonly connect: () => Promise<WorkerConnection>;
  readonly onLog?: (line: string) => void;
}

export class WorkerSupervisor {
  readonly #options: WorkerSupervisorOptions;
  #connection: WorkerConnection | undefined;
  #connecting: Promise<WorkerConnection> | undefined;
  #closed = false;
  #starts = 0;

  constructor(options: WorkerSupervisorOptions) {
    this.#options = options;
  }

  /** How many times a worker was started, so restarts are observable. */
  get starts(): number {
    return this.#starts;
  }

  /** Whether a worker is currently live. */
  get alive(): boolean {
    return this.#connection !== undefined && this.#connection.alive;
  }

  /**
   * The engines the worker currently hosts.
   *
   * Called once per run, so a dead worker is replaced before the run starts
   * rather than failing it. The returned adapters belong to one connection: a
   * session that starts on a worker stays on that worker, so a run never
   * silently migrates to a different machine midway.
   */
  async adapters(): Promise<ReadonlyMap<string, EngineAdapter>> {
    const connection = await this.#ensure();
    return connection.adapters;
  }

  /**
   * The live worker connection, starting one if needed.
   *
   * Exposed so the instance-keyed worker registry can verify that a worker's own
   * declared instance matches the instance a run resolved and leased.
   */
  async connection(): Promise<WorkerConnection> {
    return this.#ensure();
  }

  /**
   * The currently live connection, or `undefined`.
   *
   * Observation must never have the side effect of starting a worker: reading
   * readiness from a dead environment would otherwise revive it, turning an
   * inspection into work. This returns only a connection that already exists and
   * is alive, so a caller can report `offline`/`unknown` honestly instead of
   * fabricating a fresh Worker to observe.
   */
  liveConnection(): WorkerConnection | undefined {
    return this.#connection !== undefined && this.#connection.alive ? this.#connection : undefined;
  }

  async #ensure(): Promise<WorkerConnection> {
    if (this.#closed) throw new Error('environment worker supervisor is closed');

    if (this.#connection?.alive) {
      return this.#connection;
    }
    if (this.#connecting) return this.#connecting;

    // Any previous connection is dead by definition here.
    this.#connection = undefined;

    const pending = this.#options
      .connect()
      .then((connection) => {
        this.#starts += 1;
        this.#connection = connection;
        this.#options.onLog?.(
          `worker ready: pid ${connection.info.pid}, ` +
            `engines ${[...connection.adapters.keys()].join(', ') || '(none)'}`,
        );
        return connection;
      })
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.#options.onLog?.(`worker failed to start: ${failure.message}`);
        throw failure;
      })
      .finally(() => {
        this.#connecting = undefined;
      });

    this.#connecting = pending;
    return pending;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection) await connection.close();
  }
}

/**
 * Engine adapters keyed by the environment instance they execute in.
 *
 * This is the seam the orchestrator crosses: it resolves and leases one instance
 * and asks here for **that instance's** engines, so a run cannot lease
 * `container-1` and then execute on a worker serving a different instance. A
 * plain `Map` remains the simple case for tests and for callers with one fixed
 * worker; this is the multi-instance case production needs (F1, #18).
 *
 * Each instance owns its own `WorkerSupervisor`, so ADR-0003's lazy
 * start-and-replace behaviour applies per environment rather than to one global
 * worker. A worker's own `worker/info` instance id is asserted against the
 * requested id: a mismatch is a wiring error to surface, not something to paper
 * over, because executing on the wrong machine while recording another is exactly
 * the bug this exists to prevent.
 */
export class EnvironmentWorkerRegistry {
  readonly #connect: (instanceId: string) => Promise<WorkerConnection>;
  readonly #supervisors = new Map<string, WorkerSupervisor>();
  readonly #onLog: ((line: string) => void) | undefined;
  #closed = false;

  constructor(options: {
    readonly connect: (instanceId: string) => Promise<WorkerConnection>;
    readonly onLog?: (line: string) => void;
  }) {
    this.#connect = options.connect;
    this.#onLog = options.onLog;
  }

  /** The engines the worker serving `instanceId` currently hosts. */
  async adapters(instanceId: string): Promise<ReadonlyMap<string, EngineAdapter>> {
    if (this.#closed) throw new Error('environment worker registry is closed');
    const supervisor = this.#supervisor(instanceId);
    const connection = await supervisor.connection();
    const reported = connection.info.environmentInstanceId;
    if (reported !== instanceId) {
      // Do not cache a connection that serves the wrong instance; the next
      // attempt should be able to start a correct one.
      await supervisor.close();
      this.#supervisors.delete(instanceId);
      throw new Error(
        `environment instance mismatch: run resolved ${instanceId} but its worker serves ${reported}`,
      );
    }
    return connection.adapters;
  }

  /** Worker context seam for one resolved environment instance. */
  async contexts(instanceId: string): Promise<WorkerContextClient> {
    if (this.#closed) throw new Error('environment worker registry is closed');
    const supervisor = this.#supervisor(instanceId);
    const connection = await supervisor.connection();
    if (connection.info.environmentInstanceId !== instanceId) {
      await supervisor.close();
      this.#supervisors.delete(instanceId);
      throw new Error(`environment instance mismatch: Task resolved ${instanceId} but its worker serves ${connection.info.environmentInstanceId}`);
    }
    return connection.contexts;
  }

  /**
   * Ask the Worker serving one instance to validate or prepare a Project
   * workspace selection (#93). Starting a Worker here is intended: a grant or a
   * workspace change is explicit Human work, so it may revive a lazy Worker the
   * same way a run does.
   */
  async validateWorkspace(
    instanceId: string,
    input: ValidateWorkspaceParams,
  ): Promise<ValidateWorkspaceResult> {
    if (this.#closed) throw new Error('environment worker registry is closed');
    const supervisor = this.#supervisor(instanceId);
    const connection = await supervisor.connection();
    if (connection.info.environmentInstanceId !== instanceId) {
      await supervisor.close();
      this.#supervisors.delete(instanceId);
      throw new Error(`environment instance mismatch: workspace validation resolved ${instanceId} but its worker serves ${connection.info.environmentInstanceId}`);
    }
    return connection.contexts.validateWorkspace(input);
  }

  /**
   * The neutral facts the connected Worker reported on `worker/info`, or
   * `undefined` when no Worker is currently live.
   *
   * A dead channel must never fabricate a readiness fact, and observation must
   * not start a replacement Worker either: `supervisor.connection()` would revive
   * an environment just because someone asked for readiness. This reads only an
   * already-live connection, so a dead or never-started channel reports
   * `undefined` (unavailable/unknown) rather than spawning a Worker to observe.
   */
  async info(instanceId: string): Promise<WorkerInfo | undefined> {
    if (this.#closed) throw new Error('environment worker registry is closed');
    const supervisor = this.#supervisors.get(instanceId);
    if (supervisor === undefined) return undefined;
    const connection = supervisor.liveConnection();
    if (connection === undefined) return undefined;
    if (connection.info.environmentInstanceId !== instanceId) return undefined;
    return connection.info;
  }

  /** How many workers were started across all instances, so restarts stay observable. */
  get starts(): number {
    let total = 0;
    for (const supervisor of this.#supervisors.values()) total += supervisor.starts;
    return total;
  }

  #supervisor(instanceId: string): WorkerSupervisor {
    let supervisor = this.#supervisors.get(instanceId);
    if (supervisor === undefined) {
      supervisor = new WorkerSupervisor({
        connect: () => this.#connect(instanceId),
        ...(this.#onLog !== undefined ? { onLog: this.#onLog } : {}),
      });
      this.#supervisors.set(instanceId, supervisor);
    }
    return supervisor;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const supervisors = [...this.#supervisors.values()];
    this.#supervisors.clear();
    await Promise.all(supervisors.map((supervisor) => supervisor.close()));
  }
}
