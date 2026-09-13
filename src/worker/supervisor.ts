import type { EngineAdapter } from '../engine/port.ts';
import type { WorkerConnection } from './carrier.ts';

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
