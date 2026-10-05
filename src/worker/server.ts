import type { Readable, Writable } from 'node:stream';

import type {
  AgentRunEvent,
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
  WORKER_PROTOCOL_VERSION,
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
  type ValidateWorkspaceParams,
  type ValidateWorkspaceResult,
  type WorkerInfo,
  type WorkerReadinessFacts,
  type WorkerReadinessProbeParams,
  type WorkerReadinessProbeResult,
} from './protocol.ts';
import { createAgentMessageBridge } from './agent-message-bridge.ts';
import { createAgentTaskGroupMessageBridge } from './agent-task-group-bridge.ts';
import { WorkerWorkspace } from './workspace.ts';
import type { WorkerRecoveryJournal } from './recovery-journal.ts';
import {
  contractDeliveryDiagnostic,
  sanitizeEngineTurnResult,
  WORKER_DIAGNOSTICS,
  type WorkerDiagnostic,
} from './diagnostics.ts';

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
  readonly onLog?: (line: WorkerDiagnostic) => void;
  /** Root owned by this Worker for persistent Project workspaces. */
  readonly workspaceRoot?: string;
  /**
   * Neutral readiness facts this Worker reports on `worker/info`, when known.
   *
   * It is a provider rather than a value because readiness is Environment-local
   * and may change after the Worker starts (an engine login can expire). A Worker
   * that cannot determine a fact reports `unknown` rather than inventing one.
   */
  readonly readiness?: () => WorkerReadinessFacts;
  /** Executes on this host; it never accepts facts from the caller. */
  readonly readinessProbe?: (
    params: WorkerReadinessProbeParams,
  ) => Promise<WorkerReadinessProbeResult>;
  readonly recoveryJournal?: WorkerRecoveryJournal;
}
interface LiveSession {
  readonly closeMessageBridge?: () => Promise<void>;
  readonly closeTaskGroupMessageBridge?: () => Promise<void>;
  readonly engine: string;
  readonly session: EngineSession;
  readonly events: EventSink;
  readonly runId: string | undefined;
  turnId: string | undefined;
  running: Promise<void> | undefined;
}
/**
 * The honest fallback when a Worker has no readiness source: it knows which
 * engines it hosts, but not their installation or login, so it says `unknown`
 * rather than claiming readiness it did not verify.
 */
function defaultReadiness(engines: ReadonlyMap<string, EngineAdapter>): WorkerReadinessFacts {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    engines: [...engines.keys()].map((engine) => ({
      engine,
      // An adapter whose CLI the Worker located is installed by definition; its
      // login and models remain unverified, so they are honestly `unknown`.
      installed: true,
      readiness: 'unknown',
      modelAvailability: 'unknown',
      models: [],
    })),
  };
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
  #ownedEngineSession = false;
  #readiness: WorkerReadinessFacts | undefined;

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
        case WORKER_METHODS.recoverySnapshot:
          this.#transport.respond(id, this.#options.recoveryJournal?.snapshot() ?? null);
          return;
        case WORKER_METHODS.recoveryAcknowledge: {
          const ack = params as { epoch: number; turnId: string; sequence: number; settlement: boolean };
          this.#options.recoveryJournal?.acknowledge(ack.epoch, ack.turnId, ack.sequence, ack.settlement);
          this.#transport.respond(id, {});
          return;
        }
        case WORKER_METHODS.recoveryAcknowledgeContext: {
          const ack = params as { epoch: number; taskId: string; state: 'prepared' | 'recycled' };
          this.#options.recoveryJournal?.acknowledgeContext(ack.epoch, ack.taskId, ack.state);
          this.#transport.respond(id, {});
          return;
        }
        case WORKER_METHODS.readinessProbe:
          this.#transport.respond(id, await this.#probeReadiness(params as WorkerReadinessProbeParams));
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
        case WORKER_METHODS.inspectTaskContext:
          this.#transport.respond(id, await this.#requireWorkspace().inspectTaskContext(params as RecycleTaskContextParams));
          return;
        case WORKER_METHODS.validateWorkspace:
          this.#transport.respond(id, await this.#validateWorkspace(params as ValidateWorkspaceParams));
          return;
        default:
          this.#transport.respondError(id, -32_601, WORKER_DIAGNOSTICS.methodUnsupported);
      }
    } catch (error) {
      // An engine's rejected resume is a classifyable failure, not a generic
      // worker error: it is carried as a neutral code so the core can distinguish
      // "the engine refused this key" from "this worker failed". Everything else
      // is reported as an ordinary worker error and is never retried.
      if (error instanceof EngineResumeRefusedError) {
        this.#transport.respondError(id, WORKER_ERROR_CODES.resumeRefused, WORKER_DIAGNOSTICS.resumeRefused);
        return;
      }
      this.#transport.respondError(
        id,
        -32_603,
        method === WORKER_METHODS.startSession
          ? WORKER_DIAGNOSTICS.sessionStartFailed
          : WORKER_DIAGNOSTICS.requestFailed,
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
      ...(this.#readiness !== undefined
        ? { readiness: this.#readiness }
        : this.#options.readiness !== undefined
        ? { readiness: this.#options.readiness() }
        : { readiness: defaultReadiness(this.#options.engines) }),
    };
  }

  async #probeReadiness(params: WorkerReadinessProbeParams): Promise<WorkerReadinessProbeResult> {
    // Parameters are deliberately narrow. In particular, no browser-supplied
    // status, latency, protocol result, credential, prompt, or model turn can
    // enter this method. The only optional value is a list of model ids the
    // core may ask the host to compare locally; the current strict contract
    // still records account entitlement as unknown.
    const requiredModels = params !== null && typeof params === 'object' && Array.isArray(params?.requiredModels)
      ? params.requiredModels.filter((model): model is string => typeof model === 'string')
      : [];
    const result = await this.#options.readinessProbe?.({ requiredModels,
      ...(params?.requirements !== undefined ? { requirements: params.requirements } : {}),
      ...(params?.attemptId !== undefined ? { attemptId: params.attemptId } : {}) });
    if (result === undefined) {
      throw new Error('Worker has no non-inference readiness probe');
    }
    this.#readiness = result.readiness;
    if (result.readiness.protocolVersion === '3') {
      // Legacy-shaped test adapters may still return two probe copies. Never
      // discard a contradiction while translating to the single v3 wire fact.
      if (JSON.stringify(result.readiness.probe) !== JSON.stringify(result.probe)) {
        throw new Error('inconsistent Worker probe metadata');
      }
      // Preserve the identity of a deliberately redelivered attempt. Replacing
      // it with the request's new identity would append instead of replaying
      // the original receipt after flattening the v3 wire envelope.
      const attemptId = result.attemptId ?? params?.attemptId;
      return { protocolVersion: '3', observedAt: result.readiness.observedAt,
        engines: result.readiness.engines, probe: result.probe,
        ...(attemptId !== undefined ? { attemptId } : {}) } as unknown as WorkerReadinessProbeResult;
    }
    return params?.attemptId === undefined ? result : { ...result, attemptId: result.attemptId ?? params.attemptId };
  }

  async #startSession(params: StartSessionParams): Promise<StartSessionResult> {
    const adapter = this.#options.engines.get(params.engine);
    if (!adapter) {
      throw new Error(`worker does not host engine: ${params.engine}`);
    }

    // Fence conservatively before an engine can start, not after it returns.
    this.#options.recoveryJournal?.engineStarted();

    let messagesActive = true;
    const sendDirectMessage = params.directMessagesEnabled ? async (input: import('../engine/port.ts').AgentDirectMessageInput) => {
      if (!messagesActive || this.#closed || !this.#sessions.has(sessionId)) throw new Error('Agent message capability expired');
      return this.#transport.request<import('../engine/port.ts').AgentDirectMessageResult>(WORKER_METHODS.directMessage, { sessionId, input });
    } : undefined;
    let taskGroupMessagesActive = true;
    const postTaskGroupMessage = params.taskGroupMessagesEnabled ? async (input: import('../engine/port.ts').AgentTaskGroupMessageInput) => {
      if (!taskGroupMessagesActive || this.#closed || !this.#sessions.has(sessionId)) throw new Error('Task-group post capability expired');
      return this.#transport.request<import('../engine/port.ts').AgentTaskGroupMessageResult>(WORKER_METHODS.taskGroupMessage, { sessionId, input });
    } : undefined;
    const sessionId = `session-${this.#options.recoveryJournal?.snapshot().epoch ?? 'local'}-${++this.#counter}`;
    const bridge = sendDirectMessage ? await createAgentMessageBridge(sendDirectMessage) : undefined;
    const taskGroupBridge = postTaskGroupMessage ? await createAgentTaskGroupMessageBridge(postTaskGroupMessage) : undefined;
    let session: EngineSession;
    try {
      session = await adapter.startSession({
        ...(sendDirectMessage !== undefined ? { sendDirectMessage } : {}),
        ...(postTaskGroupMessage !== undefined ? { postTaskGroupMessage } : {}),
        ...((bridge !== undefined || taskGroupBridge !== undefined) ? {
          sessionEnvironment: { ...(bridge?.environment ?? {}), ...(taskGroupBridge?.environment ?? {}) },
        } : {}),
        agentId: params.agentId,
        workingDirectory: params.projectWorkspaceId === undefined
          ? params.workingDirectory
          : await this.#requireWorkspace().projectWorkingDirectory(
            params.projectWorkspaceId,
            params.projectWorkspacePath,
            params.projectWorkspaceKind,
          ),
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.effort !== undefined ? { effort: params.effort } : {}),
        ...(params.instructions !== undefined || bridge !== undefined || taskGroupBridge !== undefined ? {
          instructions: (params.instructions ?? '') + (bridge?.instructions ?? '') + (taskGroupBridge?.instructions ?? ''),
        } : {}),
        ...(params.resumeSessionKey !== undefined
          ? { resumeSessionKey: params.resumeSessionKey }
          : {}),
      });
    } catch (error) {
      messagesActive = false;
      taskGroupMessagesActive = false;
      await Promise.all([bridge?.close(), taskGroupBridge?.close()]);
      throw error;
    }

    // Every contract delivery is reported, not just a refusal. An operator must
    // be able to tell from the log whether the contract reached the engine and
    // through which mechanism, for every mechanism — including the two ordinary
    // successes, so a missing line can never be mistaken for either "delivered"
    // or "not delivered" (C21-002).
    const delivery = session.contractDelivery;
    if (delivery !== undefined) {
      this.#options.onLog?.(contractDeliveryDiagnostic(delivery));
    }
    this.#sessions.set(sessionId, {
      ...(bridge !== undefined ? { closeMessageBridge: async () => { messagesActive = false; await bridge.close(); } } : {}),
      ...(taskGroupBridge !== undefined ? { closeTaskGroupMessageBridge: async () => { taskGroupMessagesActive = false; await taskGroupBridge.close(); } } : {}),
      engine: params.engine,
      runId: params.runId,
      session,
      turnId: undefined,
      running: undefined,
      events: {
        event: (turnId, event) => {
          this.#options.recoveryJournal?.event(turnId, event);
          this.#transport.notify(WORKER_NOTIFICATIONS.event, {
            sessionId,
            turnId,
            event,
          });
        },
        settled: (turnId, result, engineSessionKey) => {
          this.#options.recoveryJournal?.settled(turnId, result);
          this.#transport.notify(WORKER_NOTIFICATIONS.settled, {
            sessionId,
            turnId,
            result,
            ...(engineSessionKey !== undefined ? { engineSessionKey } : {}),
          });
        },
      },
    });
    this.#ownedEngineSession = true;
    return {
      sessionId,
      ...(session.engineSessionKey !== undefined
        ? { engineSessionKey: session.engineSessionKey }
        : {}),
    };
  }

  async #prepareTaskContext(params: TaskContextMaterialization): Promise<PrepareTaskContextResult> {
    const prepared = await this.#requireWorkspace().prepare(params);
    this.#options.recoveryJournal?.context(params.taskId, 'prepared');
    if (this.#options.recoveryJournal !== undefined) this.#transport.notify(WORKER_NOTIFICATIONS.recoveryChanged);
    return prepared;
  }

  async #recycleTaskContext(params: RecycleTaskContextParams): Promise<void> {
    await this.#requireWorkspace().recycle(params);
    this.#options.recoveryJournal?.context(params.taskId, 'recycled');
    if (this.#options.recoveryJournal !== undefined) this.#transport.notify(WORKER_NOTIFICATIONS.recoveryChanged);
  }

  #validateWorkspace(params: ValidateWorkspaceParams): Promise<ValidateWorkspaceResult> {
    return this.#requireWorkspace().validateWorkspace(params);
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
    this.#options.recoveryJournal?.begin(params.sessionId, turnId, live.runId);
    live.turnId = turnId;

    live.running = (async () => {
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
        live.events.settled(
          turnId,
          sanitizeEngineTurnResult(await turn.completion, live.engine),
          live.session.engineSessionKey,
        );
      } catch {
        live.events.settled(turnId, {
          status: 'failed',
          message: WORKER_DIAGNOSTICS.turnFailed,
        });
      } finally {
        if (live.turnId === turnId) live.turnId = undefined;
        live.running = undefined;
      }
    })().catch(() => {
      // The journal refused an unsafe write (capacity or IO). Never turn that
      // into a fake settlement; the protected lease needs explicit recovery.
      this.#options.onLog?.(WORKER_DIAGNOSTICS.turnFailed);
    });

    return { turnId };
  }

  async #interrupt(params: InterruptParams): Promise<InterruptResult> {
    const live = this.#require(params.sessionId);
    return { interrupted: await live.session.interrupt() };
  }

  async #closeSession(params: CloseParams): Promise<Record<string, never>> {
    const live = this.#sessions.get(params.sessionId);
    if (live) {
      await live.closeMessageBridge?.();
      await live.closeTaskGroupMessageBridge?.();
      await live.session.close();
      if (live.running !== undefined) await settleOrTimeout([live.running]);
      this.#sessions.delete(params.sessionId);
      if (this.#sessions.size === 0) this.#options.recoveryJournal?.engineStopped();
      if (this.#options.recoveryJournal !== undefined) this.#transport.notify(WORKER_NOTIFICATIONS.recoveryChanged);
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
    let fenced = true;
    const running: Promise<void>[] = [];
    for (const [sessionId, live] of this.#sessions) {
      await live.closeMessageBridge?.();
      await live.closeTaskGroupMessageBridge?.();
      this.#sessions.delete(sessionId);
      if (live.running !== undefined) running.push(live.running);
      await live.session.close().catch(() => { fenced = false; });
    }
    if (fenced) {
      await settleOrTimeout(running);
      // A new process cannot fence an unknown engine left by an earlier killed
      // process simply by shutting down with no sessions of its own.
      if (this.#ownedEngineSession) this.#options.recoveryJournal?.engineStopped();
    }
  }
}

/** Engine close can succeed even if its event iterator never settles. */
async function settleOrTimeout(running: readonly Promise<void>[]): Promise<void> {
  if (running.length === 0) return;
  await Promise.race([
    Promise.allSettled(running),
    new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_000); timer.unref(); }),
  ]);
}
