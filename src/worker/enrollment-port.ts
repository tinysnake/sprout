/**
 * The enrollment-backed Environment worker registry (#115, E2 #116, ADR-0012).
 *
 * Accepted Worker connections arrive outbound from the host, so this Module is
 * the production, instance-keyed Worker registry: every accepted connection is
 * keyed by its environment instance id and adapted to the same
 * `RuntimeEnvironment` seam the M1 configured carriers satisfy — engines, Task
 * contexts, workspace validation, and neutral `worker/info` facts. Nothing above
 * it learns how the Worker connected.
 *
 * It never starts or dials a Worker: an adapter, context, or readiness lookup
 * only reaches a channel the gateway already authenticated and accepted, and a
 * lookup for an instance with no accepted connection fails closed. This is what
 * makes an authenticated inbound connection the one production admission path
 * (E2) rather than a remote start.
 *
 * Identification is **lazy**: the core asks for an instance's adapters or facts
 * only when it has work or an observation, and only then does it issue the
 * neutral `worker/info` handshake over the already-authenticated channel. This
 * keeps an accepted-but-idle connection from racing a Worker process that has not
 * finished wiring its own server.
 *
 * A connection is keyed by its accepted epoch. A newer epoch for the same
 * instance replaces the cached handle, so a stale connection's sessions cannot be
 * reached through this registry.
 */

import { WorkerClient, WorkerContextClient, WorkerReadinessClient } from './client.ts';
import type { WorkerConnection } from './carrier.ts';
import type { WorkerGateway, WorkerGatewayAcceptance } from './gateway.ts';
import type { RuntimeEnvironment } from '../runtime.ts';
import type { EngineAdapter } from '../engine/port.ts';
import type {
  ValidateWorkspaceParams,
  ValidateWorkspaceResult,
  WorkerInfo,
  WorkerReadinessProbeResult,
} from './protocol.ts';
import { WORKER_DIAGNOSTICS } from './diagnostics.ts';

interface CachedConnection {
  readonly connectionId: string;
  readonly connection: WorkerConnection;
  /** The concrete clients, so a dead channel can mark each adapter dead. */
  readonly clients: readonly WorkerClient[];
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
  /** One in-flight `worker/info` request per accepted instance/epoch. */
  readonly #identifying = new Map<string, Promise<WorkerConnection | undefined>>();
  #closed = false;

  constructor(options: EnrollmentWorkerPortOptions) {
    this.#gateway = options.gateway;
    this.#onLog = options.onLog;
    this.#gateway.onAccept((acceptance) => {
      const instanceId = acceptance.enrollment.environmentInstanceId;
      // A newer epoch supersedes the old handle immediately; the old connection's
      // transport was already closed by the gateway.
      this.#invalidate(instanceId);
      this.#accepted.set(instanceId, acceptance);
      // Channel loss must invalidate the cached handle, not just the gateway's
      // live epoch: otherwise a cached `worker/info` or adapter would keep
      // reporting a dead socket as live (#115).
      acceptance.onChannelClosed(() => {
        this.#invalidate(instanceId, acceptance.epoch.connectionId);
      });
    });
  }

  /**
   * Drop the cached connection for one instance and mark its adapters dead.
   *
   * When `connectionId` is given, only that accepted connection is invalidated,
   * so a close callback from a superseded channel cannot evict the newer one.
   */
  #invalidate(instanceId: string, connectionId?: string): void {
    const existing = this.#identified.get(instanceId);
    if (existing !== undefined && (connectionId === undefined || existing.connectionId === connectionId)) {
      for (const client of existing.clients) {
        client.notifyChannelClosed('the accepted Worker channel closed');
      }
      this.#identified.delete(instanceId);
    }
    const accepted = this.#accepted.get(instanceId);
    if (connectionId === undefined || accepted?.epoch.connectionId === connectionId) {
      this.#accepted.delete(instanceId);
    }
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
    const inFlight = this.#identifying.get(instanceId);
    if (inFlight !== undefined) return inFlight;
    const identifying = this.#connect(instanceId);
    this.#identifying.set(instanceId, identifying);
    try {
      return await identifying;
    } finally {
      if (this.#identifying.get(instanceId) === identifying) this.#identifying.delete(instanceId);
    }
  }

  async #connect(instanceId: string): Promise<WorkerConnection | undefined> {
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
      // The identify request awaited, during which a newer epoch may have been
      // accepted and identified. Re-check before caching so a delayed older
      // connection can never overwrite the newer routable handle (#115).
      if (this.#gateway.liveFor(instanceId)?.epoch.connectionId !== acceptance.epoch.connectionId) {
        for (const client of connected.adapters.values()) {
          client.notifyChannelClosed('a newer Worker connection epoch superseded this connection');
        }
        acceptance.close();
        return undefined;
      }
      const connection: WorkerConnection = {
        info: connected.info,
        adapters: connected.adapters,
        contexts: new WorkerContextClient(acceptance.transport),
        readiness: new WorkerReadinessClient(acceptance.transport),
        get alive() {
          for (const adapter of connected.adapters.values()) {
            if ((adapter as { alive?: boolean }).alive === false) return false;
          }
          return true;
        },
        close: async () => acceptance.close(),
      };
      this.#identified.set(instanceId, {
        connectionId: acceptance.epoch.connectionId,
        connection,
        clients: [...connected.adapters.values()],
      });
      this.#onLog?.(
        WORKER_DIAGNOSTICS.identificationSucceeded,
      );
      return connection;
    } catch {
      // A connection that fails to identify itself is closed rather than cached,
      // so the next attempt can start cleanly.
      this.#onLog?.(
        WORKER_DIAGNOSTICS.identificationFailed,
      );
      this.#accepted.delete(instanceId);
      acceptance.close();
      return undefined;
    }
  }

  async adapters(environmentInstanceId: string): Promise<ReadonlyMap<string, EngineAdapter>> {
    const connection = await this.#connection(environmentInstanceId);
    if (connection === undefined) {
      throw new Error(WORKER_DIAGNOSTICS.connectionUnavailable);
    }
    return connection.adapters;
  }

  async contexts(environmentInstanceId: string): Promise<WorkerContextClient> {
    const connection = await this.#connection(environmentInstanceId);
    if (connection === undefined) {
      throw new Error(WORKER_DIAGNOSTICS.connectionUnavailable);
    }
    return connection.contexts;
  }

  async validateWorkspace(
    environmentInstanceId: string,
    input: ValidateWorkspaceParams,
  ): Promise<ValidateWorkspaceResult> {
    const connection = await this.#connection(environmentInstanceId);
    if (connection === undefined) {
      throw new Error(WORKER_DIAGNOSTICS.connectionUnavailable);
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

  /** Request a probe from the already accepted Worker; never accepts browser facts. */
  async probeReadiness(environmentInstanceId: string, attemptId?: string): Promise<WorkerReadinessProbeResult | undefined> {
    if (this.#closed) return undefined;
    const connection = await this.#connection(environmentInstanceId);
    if (connection === undefined || !connection.alive) return undefined;
    // The core captured these configured targets at gateway acceptance. They
    // are never browser request data and travel only on the authenticated
    // Worker JSON-RPC channel.
    const acceptance = this.#accepted.get(environmentInstanceId);
    return connection.readiness?.probe({
      ...(attemptId !== undefined ? { attemptId } : {}),
      ...(acceptance !== undefined && acceptance.requiredModels.length > 0
        ? { requiredModels: acceptance.requiredModels }
        : {}),
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const connections = [...this.#identified.values()];
    const acceptances = [...this.#accepted.values()];
    this.#identified.clear();
    this.#accepted.clear();
    await Promise.all([
      ...connections.map(({ connection }) => connection.close()),
      ...acceptances.map((acceptance) => Promise.resolve(acceptance.close())),
    ]);
  }
}
