import type { Readable, Writable } from 'node:stream';

import type {
  AgentRunEvent,
  ContractDelivery,
  EngineAdapter,
  EngineSession,
  EngineTurnResult,
} from '../engine/port.ts';
import { EngineResumeRefusedError } from '../engine/port.ts';
import { LineJsonRpcTransport, type JsonRpcTransport } from '../engine/jsonrpc.ts';
import {
  WORKER_ERROR_CODES,
  WORKER_METHODS,
  WORKER_NOTIFICATIONS,
  type CloseParams,
  type InterruptParams,
  type InterruptResult,
  type RunParams,
  type RunResult,
  type StartSessionParams,
  type StartSessionResult,
  type PrepareTaskContextResult,
  type RecycleTaskContextParams,
  type TaskContextMaterialization,
  type WorkerInfo,
} from './protocol.ts';
import { WorkerWorkspace } from './workspace.ts';

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
  /** Root owned by this Worker for persistent Project workspaces. */
  readonly workspaceRoot?: string;
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
  settled(turnId: string, result: EngineTurnResult, engineSessionKey?: string): void;
}

export class EnvironmentWorker {
  readonly #options: EnvironmentWorkerOptions;
  readonly #transport: JsonRpcTransport;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #workspace: WorkerWorkspace | undefined;
  #counter = 0;
  #closed = false;

  constructor(options: EnvironmentWorkerOptions) {
    this.#options = options;
    this.#workspace = options.workspaceRoot === undefined ? undefined : new WorkerWorkspace(options.workspaceRoot);
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
        case WORKER_METHODS.prepareTaskContext:
          this.#transport.respond(id, await this.#prepareTaskContext(params as TaskContextMaterialization));
          return;
        case WORKER_METHODS.recycleTaskContext:
          this.#transport.respond(id, await this.#recycleTaskContext(params as RecycleTaskContextParams));
          return;
        default:
          this.#transport.respondError(id, -32_601, `unknown worker method: ${method}`);
      }
    } catch (error) {
      // An engine's rejected resume is a classifyable failure, not a generic
      // worker error: it is carried as a neutral code so the core can distinguish
      // "the engine refused this key" from "this worker failed". Everything else
      // is reported as an ordinary worker error and is never retried.
      if (error instanceof EngineResumeRefusedError) {
        this.#transport.respondError(id, WORKER_ERROR_CODES.resumeRefused, error.message);
        return;
      }
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
        standingInstructions: engine.capabilities.standingInstructions,
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
      workingDirectory: params.projectWorkspaceId === undefined
        ? params.workingDirectory
        : await this.#requireWorkspace().projectWorkingDirectory(
          params.projectWorkspaceId,
          params.projectWorkspacePath,
        ),
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.effort !== undefined ? { effort: params.effort } : {}),
      ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
      ...(params.resumeSessionKey !== undefined
        ? { resumeSessionKey: params.resumeSessionKey }
        : {}),
    });

    const sessionId = `session-${++this.#counter}`;
    // Every contract delivery is reported, not just a refusal. An operator must
    // be able to tell from the log whether the contract reached the engine and
    // through which mechanism, for every mechanism — including the two ordinary
    // successes, so a missing line can never be mistaken for either "delivered"
    // or "not delivered" (C21-002).
    const delivery = session.contractDelivery;
    if (delivery !== undefined) {
      const line = describeDelivery(params.agentId, params.workingDirectory, delivery);
      this.#options.onLog?.(line);
    }
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
        settled: (turnId, result, engineSessionKey) =>
          this.#transport.notify(WORKER_NOTIFICATIONS.settled, {
            sessionId,
            turnId,
            result,
            ...(engineSessionKey !== undefined ? { engineSessionKey } : {}),
          }),
      },
    });
    return {
      sessionId,
      ...(session.engineSessionKey !== undefined
        ? { engineSessionKey: session.engineSessionKey }
        : {}),
    };
  }

  #prepareTaskContext(params: TaskContextMaterialization): Promise<PrepareTaskContextResult> {
    return this.#requireWorkspace().prepare(params);
  }

  #recycleTaskContext(params: RecycleTaskContextParams): Promise<void> {
    return this.#requireWorkspace().recycle(params);
  }

  #requireWorkspace(): WorkerWorkspace {
    if (!this.#workspace) throw new Error('worker has no configured workspace root');
    return this.#workspace;
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
        // The events iterator throws when a turn fails, so the authoritative
        // outcome is `completion`. Reading it there preserves the engine's
        // `resumeRefused` classification across the worker boundary instead of
        // replacing it with the stream's generic error message.
        try {
          for await (const event of turn.events) {
            live.events.event(turnId, event);
          }
        } catch {
          // The completion below carries the real terminal result.
        }
        live.events.settled(turnId, await turn.completion, live.session.engineSessionKey);
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

/**
 * The line to log for a contract delivery.
 *
 * **Every mechanism a run can report is logged.** A delivery outcome is not
 * internal bookkeeping: it is how an operator confirms that the project contract
 * did or did not reach the engine, and the two "obvious" successes are exactly
 * the ones whose absence would be hardest to distinguish from a run that was
 * never given a contract at all (C21-002). Reporting is deliberately uniform —
 * one line per delivered contract, naming the mechanism and where it went — so
 * there is no outcome that is observable only by its silence.
 */
function describeDelivery(
  agentId: string,
  workingDirectory: string,
  delivery: ContractDelivery,
): string {
  const where =
    delivery.path !== undefined
      ? ` (${delivery.path})`
      : ` (${workingDirectory})`;
  switch (delivery.mechanism) {
    case 'agents.md':
      return (
        `project contract for agent ${agentId} was delivered to the engine's own ` +
        `AGENTS.md${where}`
      );
    case 'sprout-contract-file':
      return (
        `project contract for agent ${agentId} was delivered to Sprout's own ` +
        `file${where}, registered with the engine's instruction list because the ` +
        `engine does not discover that name`
      );
    case 'engine-hook':
      return (
        `project contract for agent ${agentId} was delivered through the engine's ` +
        `config hook${where}`
      );
    case 'skipped-user-owned':
      return (
        `project contract for agent ${agentId} was not delivered: ` +
        `a user-owned file in ${workingDirectory} was left intact`
      );
    case 'skipped-unreadable':
      return (
        `project contract for agent ${agentId} was not delivered: ` +
        `an existing file in ${workingDirectory} could not be read and was left intact`
      );
    case 'unavailable':
      return (
        `project contract for agent ${agentId} was not delivered: ` +
        `${delivery.reason ?? `no writable location in ${workingDirectory}`}`
      );
  }
}
