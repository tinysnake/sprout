/**
 * The environment port over the enrollment-backed Worker gateway (#115).
 *
 * Accepted Worker connections arrive outbound from the host, so this Module
 * adapts each accepted connection to the same `RuntimeEnvironment` seam the M1
 * configured carriers satisfy: engines, Task contexts, workspace validation, and
 * neutral `worker/info` facts. Nothing above it learns how the Worker connected.
 *
 * Identification is **lazy**: the core asks for an instance's adapters or facts
 * only when it has work or an observation, and only then does it issue the
 * neutral `worker/info` handshake over the already-authenticated channel. This
 * keeps an accepted-but-idle connection from racing a Worker process that has not
 * finished wiring its own server.
 *
 * A connection is keyed by its accepted epoch. A newer epoch for the same
 * instance replaces the cached handle, so a stale connection's sessions cannot be
 * reached through this port.
 */

import { WorkerClient, WorkerContextClient } from './client.ts';
import type { WorkerConnection } from './carrier.ts';
import type { WorkerGateway, WorkerGatewayAcceptance } from './gateway.ts';
import type { RuntimeEnvironment } from '../runtime.ts';
import type { EngineAdapter } from '../engine/port.ts';
import type {
  ValidateWorkspaceParams,
  ValidateWorkspaceResult,
  WorkerInfo,
} from './protocol.ts';

interface CachedConnection {
  readonly connectionId: string;
  readonly connection: WorkerConnection;
}

export interface EnrollmentWorkerPortOptions {
  readonly gateway: WorkerGateway;
  readonly onLog?: (line: string) => void;
}

/**
 * A `RuntimeEnvironment` whose connections are the enrollment-backed outbound
 * channels accepted by the gateway.
 */
export class EnrollmentWorkerPort implements RuntimeEnvironment {
  readonly #gateway: WorkerGateway;
  readonly #onLog: ((line: string) => void) | undefined;
  /** Accepted connections awaiting identification or already identified. */
  readonly #accepted = new Map<string, WorkerGatewayAcceptance>();
  readonly #identified = new Map<string, CachedConnection>();
  #closed = false;

  constructor(options: EnrollmentWorkerPortOptions) {
    this.#gateway = options.gateway;
    this.#onLog = options.onLog;
    this.#gateway.onAccept((acceptance) => {
      const instanceId = acceptance.enrollment.environmentInstanceId;
      // A newer epoch supersedes the old handle immediately; the old connection's
      // transport was already closed by the gateway.
      this.#identified.delete(instanceId);
      this.#accepted.set(instanceId, acceptance);
    });
  }

  /**
   * Identify (once) the accepted connection for one instance.
   *
   * `WorkerClient.connect` issues `worker/info`, which is where the neutral
   * Worker JSON-RPC starts flowing over the authenticated channel.
   */
  async #connection(instanceId: string): Promise<WorkerConnection | undefined> {
    const existing = this.#identified.get(instanceId);
    if (existing !== undefined && existing.connection.alive) return existing.connection;

    const acceptance = this.#accepted.get(instanceId);
    if (acceptance === undefined) return undefined;
    // A newer accepted epoch may have replaced the one we are identifying.
    if (this.#gateway.liveFor(instanceId)?.epoch.connectionId !== acceptance.epoch.connectionId) {
      this.#accepted.delete(instanceId);
      return undefined;
    }

    try {
      const connected = await WorkerClient.connect(acceptance.transport);
      const connection: WorkerConnection = {
        info: connected.info,
        adapters: connected.adapters,
        contexts: new WorkerContextClient(acceptance.transport),
        get alive() {
          for (const adapter of connected.adapters.values()) {
            if ((adapter as { alive?: boolean }).alive === false) return false;
          }
          return true;
        },
        close: async () => acceptance.close(),
      };
      this.#identified.set(instanceId, { connectionId: acceptance.epoch.connectionId, connection });
      this.#onLog?.(
        `enrollment worker identified: ${instanceId} epoch ${acceptance.epoch.epoch}`,
      );
      return connection;
    } catch (error) {
      // A connection that fails to identify itself is closed rather than cached,
      // so the next attempt can start cleanly.
      this.#onLog?.(
        `enrollment worker failed to identify: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.#accepted.delete(instanceId);
      acceptance.close();
      return undefined;
    }
  }

  async adapters(environmentInstanceId: string): Promise<ReadonlyMap<string, EngineAdapter>> {
    const connection = await this.#connection(environmentInstanceId);
    if (connection === undefined) {
      throw new Error(
        `environment instance ${environmentInstanceId} has no accepted enrollment-backed Worker connection`,
      );
    }
    return connection.adapters;
  }

  async contexts(environmentInstanceId: string): Promise<WorkerContextClient> {
    const connection = await this.#connection(environmentInstanceId);
    if (connection === undefined) {
      throw new Error(
        `environment instance ${environmentInstanceId} has no accepted enrollment-backed Worker connection`,
      );
    }
    return connection.contexts;
  }

  async validateWorkspace(
    environmentInstanceId: string,
    input: ValidateWorkspaceParams,
  ): Promise<ValidateWorkspaceResult> {
    const connection = await this.#connection(environmentInstanceId);
    if (connection === undefined) {
      throw new Error(
        `environment instance ${environmentInstanceId} has no accepted enrollment-backed Worker connection`,
      );
    }
    return connection.contexts.validateWorkspace(input);
  }

  /**
   * The neutral facts the connected Worker reported on `worker/info`.
   *
   * Observation never starts a Worker and never fabricates a fact: an absent
   * connection reports `undefined`.
   */
  async info(environmentInstanceId: string): Promise<WorkerInfo | undefined> {
    if (this.#closed) return undefined;
    const connection = await this.#connection(environmentInstanceId);
    return connection?.info;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const connections = [...this.#identified.values()];
    this.#identified.clear();
    this.#accepted.clear();
    await Promise.all(connections.map(({ connection }) => connection.close()));
  }
}
