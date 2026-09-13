import type { Readable, Writable } from 'node:stream';

import type {
  AgentRunEvent,
  EngineAdapter,
  EngineSession,
  EngineTurnResult,
} from '../engine/port.ts';
import { LineJsonRpcTransport, type JsonRpcTransport } from '../engine/jsonrpc.ts';
import {
  WORKER_METHODS,
  WORKER_NOTIFICATIONS,
  type CloseParams,
  type InterruptParams,
  type InterruptResult,
  type RunParams,
  type RunResult,
  type StartSessionParams,
  type StartSessionResult,
  type WorkerInfo,
} from './protocol.ts';

/**
 * The worker: the part of Sprout that runs *inside* an environment.
 *
 * It hosts engine processes and reports their events. The core never talks to an
 * engine directly (ADR-0003), so this is where engine protocol details live —
 * and where they stay.
 *
 * What this module deliberately is **not**: it does not own run status, run
 * persistence, agent identity, or leases. Those stay with the core, which is
 * what keeps the worker a place a run executes rather than a second source of
 * truth.
 */

export interface EnvironmentWorkerOptions {
  /** The environment instance this worker serves. */
  readonly environmentInstanceId: string;
  /** The engines this worker can host, keyed by engine id. */
  readonly engines: ReadonlyMap<string, EngineAdapter>;
  readonly input: Readable;
  readonly output: Writable;
  readonly onLog?: (line: string) => void;
}

interface LiveSession {
  readonly engine: string;
  readonly session: EngineSession;
  readonly events: EventSink;
  turnId: string | undefined;
}

/** Where a session's run events go. Swappable so the worker is testable. */
export interface EventSink {
  event(turnId: string, event: AgentRunEvent): void;
  settled(turnId: string, result: EngineTurnResult): void;
}

export class EnvironmentWorker {
  readonly #options: EnvironmentWorkerOptions;
  readonly #transport: JsonRpcTransport;
  readonly #sessions = new Map<string, LiveSession>();
  #counter = 0;
  #closed = false;

  constructor(options: EnvironmentWorkerOptions) {
    this.#options = options;
    this.#transport = new LineJsonRpcTransport({
      input: options.input,
      output: options.output,
      onClose: () => {
        void this.shutdown();
      },
    });
    this.#serve();
  }

  /** Exposed for tests; production drives this through the streams. */
  get transport(): JsonRpcTransport {
    return this.#transport;
  }

  #serve(): void {
    this.#transport.onServerRequest((request) => {
      void this.#dispatch(request.method, request.params, request.id);
    });
  }

  async #dispatch(method: string, params: unknown, id: number | string): Promise<void> {
    try {
      switch (method) {
        case WORKER_METHODS.info:
          this.#transport.respond(id, this.#info());
          return;
        case WORKER_METHODS.startSession:
          this.#transport.respond(id, await this.#startSession(params as StartSessionParams));
          return;
        case WORKER_METHODS.run:
          this.#transport.respond(id, this.#run(params as RunParams));
          return;
        case WORKER_METHODS.interrupt:
          this.#transport.respond(id, await this.#interrupt(params as InterruptParams));
          return;
        case WORKER_METHODS.close:
          this.#transport.respond(id, await this.#closeSession(params as CloseParams));
          return;
        default:
          this.#transport.respondError(id, -32_601, `unknown worker method: ${method}`);
      }
    } catch (error) {
      this.#transport.respondError(
        id,
        -32_603,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #info(): WorkerInfo {
    return {
      pid: process.pid,
      environmentInstanceId: this.#options.environmentInstanceId,
      engines: [...this.#options.engines.values()].map((engine) => ({
        id: engine.id,
        streaming: engine.capabilities.streaming,
        supportsInterrupt: engine.capabilities.supportsInterrupt,
      })),
    };
  }

  async #startSession(params: StartSessionParams): Promise<StartSessionResult> {
    const adapter = this.#options.engines.get(params.engine);
    if (!adapter) {
      throw new Error(`worker does not host engine: ${params.engine}`);
    }

    const session = await adapter.startSession({
      agentId: params.agentId,
      workingDirectory: params.workingDirectory,
      ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
    });

    const sessionId = `session-${++this.#counter}`;
    this.#sessions.set(sessionId, {
      engine: params.engine,
      session,
      turnId: undefined,
      events: {
        event: (turnId, event) =>
          this.#transport.notify(WORKER_NOTIFICATIONS.event, {
            sessionId,
            turnId,
            event,
          }),
        settled: (turnId, result) =>
          this.#transport.notify(WORKER_NOTIFICATIONS.settled, {
            sessionId,
            turnId,
            result,
          }),
      },
    });
    return { sessionId };
  }

  /**
   * Start one turn. Returns immediately with the turn id, then streams that
   * turn's events and its terminal result as notifications, so the core can
   * observe progress instead of awaiting a whole turn.
   */
  #run(params: RunParams): RunResult {
    const live = this.#require(params.sessionId);
    const turnId = `${params.sessionId}-turn-${++this.#counter}`;
    live.turnId = turnId;

    void (async () => {
      try {
        const turn = live.session.run(params.prompt);
        for await (const event of turn.events) {
          live.events.event(turnId, event);
        }
        live.events.settled(turnId, await turn.completion);
      } catch (error) {
        live.events.settled(turnId, {
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (live.turnId === turnId) live.turnId = undefined;
      }
    })();

    return { turnId };
  }

  async #interrupt(params: InterruptParams): Promise<InterruptResult> {
    const live = this.#require(params.sessionId);
    return { interrupted: await live.session.interrupt() };
  }

  async #closeSession(params: CloseParams): Promise<Record<string, never>> {
    const live = this.#sessions.get(params.sessionId);
    if (live) {
      this.#sessions.delete(params.sessionId);
      await live.session.close();
    }
    return {};
  }

  #require(sessionId: string): LiveSession {
    const live = this.#sessions.get(sessionId);
    if (!live) throw new Error(`unknown session: ${sessionId}`);
    return live;
  }

  /**
   * Tear every engine down. Called when the channel closes, so a worker cannot
   * leave orphaned engine processes behind on a machine it no longer serves.
   */
  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const [sessionId, live] of this.#sessions) {
      this.#sessions.delete(sessionId);
      await live.session.close().catch(() => undefined);
    }
  }
}
