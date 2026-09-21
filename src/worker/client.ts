import type {
  EngineAdapter,
  EngineCapabilities,
  EngineSession,
  EngineTurn,
  EngineTurnResult,
  StartSessionRequest,
  StandingInstructionsChannel,
  StreamingGranularity,
} from '../engine/port.ts';
import { EngineResumeRefusedError } from '../engine/port.ts';
import { EventQueue } from '../engine/event-queue.ts';
import { JsonRpcError, type JsonRpcTransport } from '../engine/jsonrpc.ts';
import {
  WORKER_ERROR_CODES,
  WORKER_METHODS,
  WORKER_NOTIFICATIONS,
  type RunResult,
  type StartSessionResult,
  type PrepareTaskContextResult,
  type RecycleTaskContextParams,
  type TaskContextMaterialization,
  type TurnEventParams,
  type TurnSettledParams,
  type ValidateWorkspaceParams,
  type ValidateWorkspaceResult,
  type WorkerInfo,
} from './protocol.ts';

/**
 * The core-side handle on one environment's worker.
 *
 * From the core's point of view a `WorkerClient` *is* an `EngineAdapter`, which
 * is the point of ADR-0003: the core orchestrates runs while the worker owns
 * process execution, so nothing above this seam learns that a worker, a
 * container, or a socket exists.
 *
 * It also cannot leak engine protocol details upward, because it never receives
 * any: the worker sends neutral run events and terminal results, so there is no
 * Codex method name to accidentally depend on.
 */

export interface WorkerEngineDeclaration {
  readonly id: string;
  readonly streaming: StreamingGranularity;
  readonly supportsInterrupt: boolean;
  readonly standingInstructions: StandingInstructionsChannel;
}

export interface WorkerClientOptions {
  readonly transport: JsonRpcTransport;
  /** The environment instance this worker serves. */
  readonly environmentInstanceId: string;
  readonly engines: readonly WorkerEngineDeclaration[];
}

/** Raised when the channel to a worker dies while a session is still live. */
type ChannelClosedHandler = (reason: string) => void;

export class WorkerClient implements EngineAdapter {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  readonly #transport: JsonRpcTransport;
  /** Live sessions, so a dead channel can fail their in-flight turns. */
  readonly #live = new Set<(reason: string) => void>();
  #closed = false;

  constructor(options: WorkerClientOptions, engineId: string) {
    const engine = options.engines.find((candidate) => candidate.id === engineId);
    if (!engine) {
      throw new Error(
        `worker for ${options.environmentInstanceId} does not host engine: ${engineId}`,
      );
    }
    this.id = engine.id;
    this.capabilities = {
      streaming: engine.streaming,
      supportsInterrupt: engine.supportsInterrupt,
      standingInstructions: engine.standingInstructions,
    };
    this.#transport = options.transport;
  }

  /**
   * Identify a connected worker and build one adapter per engine it hosts.
   *
   * The channel's lifetime is registered here rather than per session, because a
   * dead channel invalidates every session on it at once.
   */
  static async connect(
    transport: JsonRpcTransport,
  ): Promise<{ readonly info: WorkerInfo; readonly adapters: ReadonlyMap<string, WorkerClient> }> {
    const info = await transport.request<WorkerInfo>(WORKER_METHODS.info);
    const options: WorkerClientOptions = {
      transport,
      environmentInstanceId: info.environmentInstanceId,
      engines: info.engines,
    };
    const adapters = new Map<string, WorkerClient>();
    for (const engine of info.engines) {
      adapters.set(engine.id, new WorkerClient(options, engine.id));
    }
    return { info, adapters };
  }

  /** Called by the carrier when the channel to this worker ends. */
  notifyChannelClosed(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of this.#live) handler(reason);
    this.#live.clear();
  }

  /** Whether the channel to the worker is still usable. */
  get alive(): boolean {
    return !this.#closed;
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    if (this.#closed) throw new Error('environment worker channel is closed');

    let started: StartSessionResult;
    try {
      started = await this.#transport.request<StartSessionResult>(
        WORKER_METHODS.startSession,
        {
          engine: this.id,
          agentId: request.agentId,
          workingDirectory: request.workingDirectory,
          ...(request.model !== undefined ? { model: request.model } : {}),
          ...(request.effort !== undefined ? { effort: request.effort } : {}),
          ...(request.projectWorkspaceId !== undefined ? { projectWorkspaceId: request.projectWorkspaceId } : {}),
          ...(request.projectWorkspacePath !== undefined ? { projectWorkspacePath: request.projectWorkspacePath } : {}),
          ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
          ...(request.resumeSessionKey !== undefined
            ? { resumeSessionKey: request.resumeSessionKey }
            : {}),
        },
      );
    } catch (error) {
      // The worker marks an engine's rejected resume with a protocol code. Turn
      // it back into the neutral port error so the core retries only for a real
      // refusal; every other worker failure stays a plain error.
      if (
        error instanceof JsonRpcError &&
        error.code === WORKER_ERROR_CODES.resumeRefused &&
        request.resumeSessionKey !== undefined
      ) {
        throw new EngineResumeRefusedError(request.resumeSessionKey, error.message);
      }
      throw error;
    }

    return new WorkerEngineSession(
      {
        transport: this.#transport,
        sessionId: started.sessionId,
        supportsInterrupt: this.capabilities.supportsInterrupt,
        // Known up front for engines whose key the worker already holds (Pi,
        // Codex). For `agy`/`opencode` it arrives with the settlement below.
        ...(started.engineSessionKey !== undefined
          ? { engineSessionKey: started.engineSessionKey }
          : {}),
      },
      (handler: ChannelClosedHandler) => {
        this.#live.add(handler);
        return () => this.#live.delete(handler);
      },
    );
  }
}

/** Core-side client for the Worker-owned workspace/context operations. */
export class WorkerContextClient {
  readonly #transport: JsonRpcTransport;

  constructor(transport: JsonRpcTransport) {
    this.#transport = transport;
  }

  prepare(input: TaskContextMaterialization): Promise<PrepareTaskContextResult> {
    return this.#transport.request(WORKER_METHODS.prepareTaskContext, input);
  }

  recycle(input: RecycleTaskContextParams): Promise<void> {
    return this.#transport.request(WORKER_METHODS.recycleTaskContext, input);
  }

  validateWorkspace(input: ValidateWorkspaceParams): Promise<ValidateWorkspaceResult> {
    return this.#transport.request(WORKER_METHODS.validateWorkspace, input);
  }
}

interface WorkerSessionOptions {
  readonly transport: JsonRpcTransport;
  readonly sessionId: string;
  readonly supportsInterrupt: boolean;
  readonly engineSessionKey?: string;
}

class WorkerEngineSession implements EngineSession {
  readonly sessionId: string;
  /**
   * The engine-native key, mirrored from the worker.
   *
   * It is seeded from the session-start response and updated when a settlement
   * carries the key the engine actually used, so a resumed-then-refused key is
   * replaced by the fresh one rather than reported stale.
   */
  engineSessionKey: string | undefined;
  readonly #transport: JsonRpcTransport;
  readonly #supportsInterrupt: boolean;
  readonly #watchChannel: (handler: ChannelClosedHandler) => () => void;
  #settle: ((result: EngineTurnResult) => void) | undefined;
  #closed = false;

  constructor(
    options: WorkerSessionOptions,
    watchChannel: (handler: ChannelClosedHandler) => () => void,
  ) {
    this.#transport = options.transport;
    this.sessionId = options.sessionId;
    this.engineSessionKey = options.engineSessionKey;
    this.#supportsInterrupt = options.supportsInterrupt;
    this.#watchChannel = watchChannel;
  }

  run(prompt: string): EngineTurn {
    const queue = new EventQueue();
    let settled = false;
    let resolveCompletion: (result: EngineTurnResult) => void = () => {};
    const completion = new Promise<EngineTurnResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const finish = (result: EngineTurnResult) => {
      if (settled) return;
      settled = true;
      this.#settle = undefined;
      if (result.status === 'failed') queue.fail(new Error(result.message));
      else queue.end();
      resolveCompletion(result);
    };
    this.#settle = finish;

    const offEvent = this.#transport.onNotification((notification) => {
      if (notification.method !== WORKER_NOTIFICATIONS.event) return;
      const params = notification.params as TurnEventParams;
      if (params.sessionId !== this.sessionId) return;
      queue.push(params.event);
    });
    const offSettled = this.#transport.onNotification((notification) => {
      if (notification.method !== WORKER_NOTIFICATIONS.settled) return;
      const params = notification.params as TurnSettledParams;
      if (params.sessionId !== this.sessionId) return;
      if (params.engineSessionKey !== undefined) {
        this.engineSessionKey = params.engineSessionKey;
      }
      finish(params.result);
    });
    // A dead channel must fail the turn: the worker can never report on it again,
    // so waiting for a settlement that cannot arrive would hang the run.
    const offClosed = this.#watchChannel((reason) => {
      finish({ status: 'failed', message: `environment worker channel closed: ${reason}` });
    });

    void this.#transport
      .request<RunResult>(WORKER_METHODS.run, { sessionId: this.sessionId, prompt })
      .catch((error: unknown) => {
        finish({
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return {
      events: queue,
      completion: completion.finally(() => {
        offEvent();
        offSettled();
        offClosed();
      }),
    };
  }

  /**
   * Stop the in-flight turn.
   *
   * The turn is settled locally before the request is sent, for the same reason
   * the Codex adapter does it (see `src/engine/codex.ts`): the user's stop must
   * not depend on a worker answering, and `finish` is idempotent.
   */
  async interrupt(): Promise<boolean> {
    this.#settle?.({ status: 'interrupted' });
    if (this.#closed || !this.#supportsInterrupt) return false;
    try {
      await this.#transport.request(WORKER_METHODS.interrupt, { sessionId: this.sessionId });
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#settle?.({ status: 'interrupted' });
    await this.#transport
      .request(WORKER_METHODS.close, { sessionId: this.sessionId })
      .catch(() => undefined);
  }
}
