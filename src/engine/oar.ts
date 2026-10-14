import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Writable, Readable } from 'node:stream';

import type {
  DetailedTokenDimensions,
  EngineAdapter,
  EngineCapabilities,
  EngineSession,
  EngineTurn,
  EngineTurnResult,
  StartSessionRequest,
  TokenUsage,
} from './port.ts';
import { EngineResumeRefusedError, EngineStartError } from './port.ts';
import { EventQueue } from './event-queue.ts';
import { assertSupportedNodeVersion } from './oar-node-support.ts';
import {
  prepareOarRuntimePolicy,
  hostPiConfigurationProvider,
  OAR_PI_DISALLOWED_BUILTIN_TOOLS,
  type OarPiConfigurationProvider,
} from './oar-runtime-policy.ts';
import { createOarMcpBridge, type OarMcpBridgeHandle } from './oar-mcp-bridge.ts';
import type { RunnerCommand, RunnerMessage } from './oar-runner-protocol.ts';
import type { SessionOptions, SessionUsage, TokenTotals } from '@botiverse/oar';
import { redactSensitiveText } from '../environment/privacy.ts';
import { runtimeCatalogEntry, OAR_ADAPTER_VERSION, ENGINE_RUNTIME_CATALOG } from './runtime-catalog.ts';
import type { CodexSandboxMode } from './runtime-catalog.ts';

export const OAR_PACKAGE_VERSION = OAR_ADAPTER_VERSION;

/** Verified OAR behavior projected from the shared runtime catalog. */
export const OAR_RUNTIME_REGISTRATIONS = {
  codex: ENGINE_RUNTIME_CATALOG.codex,
  pi: ENGINE_RUNTIME_CATALOG.pi,
  claude: ENGINE_RUNTIME_CATALOG.claude,
} as const;

/** Builtins excluded from the Claude candidate; this is not an OS sandbox. */
export const OAR_CLAUDE_DISALLOWED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
  'Agent', 'Task', 'Skill', 'ToolSearch', 'WebFetch', 'WebSearch',
  'NotebookEdit',
] as const;

export interface OarRunnerProcess {
  readonly pid?: number;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr?: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean | void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export interface OarAdapterOptions {
  /** The OAR runtime identifier (e.g. 'codex', 'claude', 'pi'). */
  readonly runtimeId: string;
  /** Host-selected executable, passed as data rather than a process-wide override. */
  readonly binaryPath?: string;
  readonly capabilities?: Partial<EngineCapabilities>;
  /** Optional Codex sandbox posture ('read-only' vs 'danger-full-access'). */
  readonly sandbox?: CodexSandboxMode;
  /** Optional Pi session directory (checked for bounded compatibility refusal). */
  readonly sessionDirectory?: string;
  /** Replaceable source of the host Pi agent directory; resolved once per OAR Pi session. */
  readonly piConfigurationProvider?: OarPiConfigurationProvider;
  /** Injectable process spawner for tests or customized environments. */
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly detached?: boolean;
      readonly stdio?: readonly ['pipe', 'pipe', 'pipe'];
    },
  ) => OarRunnerProcess;
  readonly runnerScriptPath?: string;
  readonly clock?: () => number;
  readonly sourceVersion?: string;
}

export class OarEngineAdapter implements EngineAdapter {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  readonly #options: OarAdapterOptions;

  constructor(options: OarAdapterOptions) {
    this.#options = options;
    this.id = options.runtimeId;
    this.capabilities = {
      ...(runtimeCatalogEntry(options.runtimeId)?.capabilities ?? {
        streaming: 'incremental',
        supportsInterrupt: true,
        standingInstructions: 'out-of-band',
      }),
      ...options.capabilities,
    };
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    assertSupportedNodeVersion();

    if (!request.workingDirectory) {
      throw new EngineStartError('Working directory is required for OAR session');
    }

    // The shared policy is acquired below, after creating only the approved bridge.

    // OAR's permission bypass and ambient loaders do not establish host isolation.
    if (this.id === 'claude' && (request.remoteWorkspace || request.remoteProjectMcp)) {
      throw new EngineStartError('OAR Claude Host-run authority is unproved; a validated host isolation policy is required');
    }

    if (this.#options.runtimeId === 'pi' && this.#options.sessionDirectory !== undefined) {
      throw new EngineStartError(
        runtimeCatalogEntry('pi')!.policy.unsupportedWorkerConfigurations![0]!.explanation,
      );
    }

    // Build SessionOptions
    const sessionOptions: SessionOptions = {
      ...(this.id === 'claude' ? { disallowedTools: [...OAR_CLAUDE_DISALLOWED_TOOLS] } : {}),
      ...(this.id === 'pi' ? { disallowedTools: [...OAR_PI_DISALLOWED_BUILTIN_TOOLS] } : {}),
      cwd: request.workingDirectory,
      ...(request.projectWorkspacePath !== undefined && this.#options.runtimeId !== 'pi'
        ? { additionalDirectories: [request.projectWorkspacePath] }
        : {}),
      ...(request.instructions !== undefined
        ? { appendSystemPrompt: request.instructions }
        : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.resumeSessionKey !== undefined ? { resume: request.resumeSessionKey } : {}),
      ...(request.sessionEnvironment !== undefined && this.id !== 'pi'
        ? { env: request.sessionEnvironment as Record<string, string> }
        : {}),
    };

    let mcpBridge: OarMcpBridgeHandle | undefined;
    if (request.remoteWorkspace !== undefined || request.remoteProjectMcp !== undefined) {
      mcpBridge = await createOarMcpBridge({
        ...(request.remoteWorkspace !== undefined ? { remoteWorkspace: request.remoteWorkspace } : {}),
        ...(request.remoteProjectMcp !== undefined ? { remoteProjectMcp: request.remoteProjectMcp } : {}),
      });
      if (mcpBridge) {
        (sessionOptions as { mcpServers?: readonly import('@botiverse/oar').McpServer[] }).mcpServers = [mcpBridge.mcpServer];
      }
    }

    let policy;
    try {
      const piConfiguration = this.id === 'pi'
        ? (this.#options.piConfigurationProvider ?? hostPiConfigurationProvider).resolve()
        : undefined;
      policy = prepareOarRuntimePolicy(this.id, request.workingDirectory, {
        ...(piConfiguration ? { agentDir: piConfiguration.agentDir } : {}),
        ...(mcpBridge ? { approvedMcp: mcpBridge.mcpServer } : {}),
      });
      if (policy) (sessionOptions as { cwd: string }).cwd = policy.descriptor.cwd;
    } catch (error) {
      await mcpBridge?.close();
      throw error;
    }

    const runnerScript = this.#options.runnerScriptPath ?? fileURLToPath(new URL('./oar-runner-entry.ts', import.meta.url));

    const runnerCwd = existsSync(request.workingDirectory) ? request.workingDirectory : process.cwd();
    let runner: OarRunnerProcess;
    try {
      runner = this.#options.spawnProcess
      ? this.#options.spawnProcess(process.execPath, [runnerScript], {
          cwd: runnerCwd,
          env: {
            ...process.env,
            ...(request.sessionEnvironment ?? {}),
            ...(this.#options.sandbox ? { OAR_CODEX_SANDBOX: this.#options.sandbox } : {}),
          },
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : (spawn(process.execPath, [runnerScript], {
          cwd: runnerCwd,
          env: {
            ...process.env,
            ...(request.sessionEnvironment ?? {}),
            ...(this.#options.sandbox ? { OAR_CODEX_SANDBOX: this.#options.sandbox } : {}),
          },
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as unknown as OarRunnerProcess);
    } catch (error) {
      policy?.close();
      await mcpBridge?.close();
      throw error;
    }
    runner.on('exit', () => {
      // Forced runner death preserves restoration only after the detached
      // process group is observed empty; parent exit alone does not release it.
      void waitForProcessTreeStopped(runner, 2_000).then((stopped) => {
        if (stopped) policy?.close();
      }).catch(() => undefined);
    });
    runner.on('error', () => {
      // A spawn error without a process has no descendants; otherwise the
      // bounded start-failure cleanup releases this only after tree proof.
      if (runner.pid === undefined) policy?.close();
    });

    const clock = this.#options.clock ?? (() => Date.now());

    return new Promise<EngineSession>((resolve, reject) => {
      let settled = false;
      let buffer = '';

      const cleanupPolicyAfterProvedTreeStop = () => {
        if (runner.pid === undefined) {
          policy?.close();
          return;
        }
        void waitForProcessTreeStopped(runner, 2_000).then((stopped) => {
          if (stopped) policy?.close();
        }).catch(() => undefined);
      };

      const startTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killProcessTree(runner);
        cleanupPolicyAfterProvedTreeStop();
        void mcpBridge?.close();
        reject(new EngineStartError('OAR runner failed to become ready within timeout'));
      }, 25_000);

      const failStart = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        killProcessTree(runner);
        cleanupPolicyAfterProvedTreeStop();
        void mcpBridge?.close();
        reject(error);
      };

      runner.on('error', (err) => {
        failStart(new EngineStartError(`Failed to spawn OAR runner: ${err.message}`));
      });

      runner.on('exit', (code, signal) => {
        if (!settled) {
          failStart(new EngineStartError(`OAR runner exited before becoming ready (code=${code}, signal=${signal})`));
        }
      });

      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            try {
              const msg = JSON.parse(line) as RunnerMessage;
              if (!settled) {
                if (msg.kind === 'ready') {
                  settled = true;
                  clearTimeout(startTimer);
                  // Remove this initial listener so the session can attach its own
                  runner.stdout?.removeListener('data', onData);
                  const session = new OarEngineSession({
                    runner,
                    sessionId: msg.sessionId,
                    engineSessionKey: msg.engineSessionKey,
                    runtimeId: this.#options.runtimeId,
                    sourceVersion: this.#options.sourceVersion ?? OAR_PACKAGE_VERSION,
                    freshSession: msg.freshSession ?? request.resumeSessionKey === undefined,
                    ...(msg.usageBaseline !== undefined ? { usageBaseline: msg.usageBaseline } : {}),
                    mcpBridge,
                    onTerminationProved: () => policy?.close(),
                    clock,
                  });
                  // Feed any trailing buffer into the session
                  if (buffer.length > 0) {
                    session.pushData(buffer);
                    buffer = '';
                  }
                  resolve(session);
                  return;
                }
                if (msg.kind === 'error') {
                  const sanitized = redactSensitiveText(msg.message);
                  if (request.resumeSessionKey !== undefined && msg.code === 'session_not_found') {
                    failStart(new EngineResumeRefusedError(
                      request.resumeSessionKey,
                      'The OAR runtime could not find the saved native session. No work was started; the existing one-time fresh-session retry may now run.',
                    ));
                  } else {
                    failStart(new EngineStartError(sanitized));
                  }
                  return;
                }
              }
            } catch {
              // Ignore unparseable lines during startup
            }
          }
          newline = buffer.indexOf('\n');
        }
      };

      runner.stdout?.on('data', onData);

      // Send start command to runner
      const startCmd: RunnerCommand = {
        op: 'start',
        runtimeId: this.#options.runtimeId,
        ...(this.#options.binaryPath ? { binaryPath: this.#options.binaryPath } : {}),
        options: sessionOptions,
        hostPolicy: {
          ...(this.#options.sandbox ? { sandbox: this.#options.sandbox } : {}),
          ...(policy ? { pi: policy.descriptor } : {}),
        },
      };
      runner.stdin?.write(`${JSON.stringify(startCmd)}\n`);
    });
  }
}

interface OarEngineSessionParams {
  readonly runner: OarRunnerProcess;
  readonly sessionId: string;
  readonly engineSessionKey: string;
  readonly runtimeId: string;
  readonly sourceVersion: string;
  readonly freshSession: boolean;
  readonly usageBaseline?: SessionUsage | null | undefined;
  readonly mcpBridge?: OarMcpBridgeHandle | undefined;
  readonly onTerminationProved?: (() => void) | undefined;
  readonly clock: () => number;
}

export class OarEngineSession implements EngineSession {
  readonly sessionId: string;
  readonly engineSessionKey: string;
  readonly contractDelivery = undefined;

  readonly #runner: OarRunnerProcess;
  readonly #sourceVersion: string;
  readonly #runtimeId: string;
  readonly #mcpBridge: OarMcpBridgeHandle | undefined;
  readonly #onTerminationProved: (() => void) | undefined;
  readonly #clock: () => number;

  #closed = false;
  #currentTurnFinish: ((result: EngineTurnResult) => void) | undefined;
  #currentTurnCompletion: Promise<EngineTurnResult> | undefined;
  #currentEventQueue: EventQueue | undefined;
  #buffer = '';
  #baselineUsage: TokenTotals | undefined;
  #hasUsageBaseline: boolean;
  #latestTurnUsage: { readonly tokenUsage: TokenUsage; readonly detailedTokens: DetailedTokenDimensions } | undefined;
  #latestObservedTotals: TokenTotals | undefined;
  #usageInvalid = false;
  #interrupted = false;
  #escalation: Promise<boolean> | undefined;
  #runnerExited = false;
  #runnerOutputClosed = false;
  terminationEvidence: 'proved' | 'uncertain' | undefined;

  constructor(params: OarEngineSessionParams) {
    this.#runner = params.runner;
    this.sessionId = params.sessionId;
    this.engineSessionKey = params.engineSessionKey;
    this.#sourceVersion = params.sourceVersion;
    this.#runtimeId = params.runtimeId;
    this.#mcpBridge = params.mcpBridge;
    this.#onTerminationProved = params.onTerminationProved;
    const baseline = params.usageBaseline?.total;
    this.#baselineUsage = params.freshSession
      ? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
      : baseline ?? undefined;
    this.#hasUsageBaseline = params.freshSession || (baseline !== null && baseline !== undefined);
    this.#clock = params.clock;

    this.#runner.stdout?.on('data', (chunk: Buffer | string) => {
      this.pushData(chunk.toString());
    });
    this.#runner.stdout?.on('end', () => this.#observeRunnerOutputClosed());
    this.#runner.stdout?.on('close', () => this.#observeRunnerOutputClosed());

    this.#runner.on('exit', () => {
      this.#runnerExited = true;
      if (this.#runner.stdout === null || this.#runnerOutputClosed) this.#onRunnerExit();
    });
  }

  pushData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) {
        this.#handleRunnerLine(line);
      }
      newline = this.#buffer.indexOf('\n');
    }
  }

  run(prompt: string): EngineTurn {
    if (this.#closed) {
      throw new Error('OAR session is closed');
    }
    if (this.#currentTurnFinish !== undefined) {
      throw new Error('OAR session is busy with an existing turn');
    }

    const queue = new EventQueue();
    this.#currentEventQueue = queue;
    this.#interrupted = false;
    this.#latestTurnUsage = undefined;
    this.#latestObservedTotals = undefined;

    let rootTurnText = '';
    let rootMessageId: string | undefined;
    let turnSettled = false;
    const startedAt = this.#clock();

    let resolveCompletion: (result: EngineTurnResult) => void = () => undefined;
    const completion = new Promise<EngineTurnResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const finish = (result: EngineTurnResult) => {
      if (turnSettled) return;
      turnSettled = true;
      this.#currentTurnFinish = undefined;
      this.#currentTurnCompletion = undefined;
      this.#currentEventQueue = undefined;
      const duration = Math.max(0, this.#clock() - startedAt);
      const measured: EngineTurnResult = {
        ...result,
        engineTurnDurationMs: result.engineTurnDurationMs ?? duration,
      };
      if (measured.status === 'failed') {
        queue.fail(new Error(measured.message));
      } else {
        queue.end();
      }
      resolveCompletion(measured);
    };

    this.#currentTurnFinish = finish;
    this.#currentTurnCompletion = completion;

    let currentSpanId: string | undefined;
    let sequenceFloor: number | undefined;
    const activationId = randomUUID();

    // Attach local state handlers before sending the command, so synchronous
    // test fixtures or fast responses cannot race turn context attachment.
    this.#activeTurnContext = {
      activationId,
      getSpanId: () => currentSpanId,
      setSpanId: (spanId: string) => {
        if (!currentSpanId) currentSpanId = spanId;
      },
      setSequenceFloor: (seq: number) => {
        sequenceFloor = seq;
      },
      getSequenceFloor: () => sequenceFloor,
      appendRootText: (text: string, messageId?: string) => {
        if (OAR_RUNTIME_REGISTRATIONS[this.#runtimeId as keyof typeof OAR_RUNTIME_REGISTRATIONS]?.finalAnswer === 'last-message' && messageId !== undefined && messageId !== rootMessageId) {
          rootTurnText = '';
          rootMessageId = messageId;
        }
        rootTurnText += text;
      },
      getRootText() {
        return rootTurnText;
      },
      finish,
    };

    // Send prompt to runner
    const promptCmd: RunnerCommand = {
      op: 'prompt',
      activationId,
      input: prompt,
    };
    this.#runner.stdin?.write(`${JSON.stringify(promptCmd)}\n`);

    return { events: queue, completion };
  }

  #activeTurnContext?: {
    activationId: string;
    getSpanId(): string | undefined;
    setSpanId(spanId: string): void;
    setSequenceFloor(seq: number): void;
    getSequenceFloor(): number | undefined;
    appendRootText(text: string, messageId?: string): void;
    getRootText(): string;
    finish(result: EngineTurnResult): void;
  };

  #observeUsage(usage: SessionUsage | null | undefined): void {
    const total = usage?.total;
    if (total === null || total === undefined) return;

    const previous = this.#latestObservedTotals;
    this.#latestObservedTotals = total;
    if (previous !== undefined && (total.input < previous.input || total.output < previous.output)) {
      this.#usageInvalid = true;
      this.#latestTurnUsage = undefined;
      return;
    }
    if (this.#usageInvalid || !this.#hasUsageBaseline || this.#baselineUsage === undefined) return;

    const inputDelta = total.input - this.#baselineUsage.input;
    const outputDelta = total.output - this.#baselineUsage.output;
    if (inputDelta < 0 || outputDelta < 0) {
      this.#usageInvalid = true;
      this.#latestTurnUsage = undefined;
      return;
    }

    const optionalDelta = (current: number | undefined, baseline: number | undefined): number | undefined => {
      if (current === undefined || baseline === undefined || current < baseline) return undefined;
      return current - baseline;
    };
    const reasoningOutputTokens = optionalDelta(total.reasoning, this.#baselineUsage.reasoning);
    const cachedInputTokens = optionalDelta(total.cacheRead, this.#baselineUsage.cacheRead);
    const cacheWriteInputTokens = this.#runtimeId === 'claude'
      ? optionalDelta(total.cacheWrite, this.#baselineUsage.cacheWrite)
      : undefined;

    this.#latestTurnUsage = {
      tokenUsage: {
        promptTokens: inputDelta,
        completionTokens: outputDelta,
        totalTokens: inputDelta + outputDelta,
      },
      detailedTokens: {
        inputTokens: inputDelta,
        outputTokens: outputDelta,
        ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
      },
    };
  }

  #settledUsage(usage?: SessionUsage | null): {
    readonly tokenUsage?: TokenUsage;
    readonly detailedTokens?: DetailedTokenDimensions;
  } {
    this.#observeUsage(usage);
    if (this.#latestObservedTotals !== undefined) {
      this.#baselineUsage = this.#latestObservedTotals;
      this.#hasUsageBaseline = true;
    }
    const latest = this.#usageInvalid ? undefined : this.#latestTurnUsage;
    this.#latestTurnUsage = undefined;
    this.#latestObservedTotals = undefined;
    this.#usageInvalid = false;
    return latest ?? {};
  }

  #handleRunnerLine(line: string): void {
    let msg: RunnerMessage;
    try {
      msg = JSON.parse(line) as RunnerMessage;
    } catch {
      return;
    }

    const turn = this.#activeTurnContext;

    switch (msg.kind) {
      case 'prompt_accepted': {
        if (turn && turn.activationId === msg.activationId) {
          if (msg.spanId) {
            turn.setSpanId(msg.spanId);
          }
          turn.setSequenceFloor(msg.seq);
        }
        break;
      }

      case 'prompt_rejected': {
        if (!turn) return;
        if (msg.activationId !== turn.activationId) return;
        const sanitized = redactSensitiveText(msg.reason);
        turn.finish({
          status: 'failed',
          message: `OAR prompt rejected (${msg.code}): ${sanitized || 'engine busy or refused'}`,
          ...this.#settledUsage(),
          source: 'oar',
          sourceVersion: this.#sourceVersion,
        });
        break;
      }

      case 'event': {
        if (turn && msg.activationId !== turn.activationId) {
          break;
        }

        const ev = msg.event;
        if (turn) {
          const boundSpanId = turn.getSpanId();
          const matchingNativeSpan = boundSpanId !== undefined && ev.spanId === boundSpanId;
          if (boundSpanId !== undefined && ev.spanId !== undefined && ev.spanId !== boundSpanId) {
            break;
          }
          const sequenceFloor = turn.getSequenceFloor();
          if (sequenceFloor !== undefined && !matchingNativeSpan && ev.seq <= sequenceFloor) {
            break;
          }
        }
        const isRoot = (!ev.agentPath || ev.agentPath.length === 0) && ev.sessionId === this.sessionId;

        if (isRoot) {
          // A span matching the accepted native turn is direct attribution. Without
          // it, only events after the prompt request's stream position are eligible.
          if (turn) {
            const boundSpanId = turn.getSpanId();
            if (boundSpanId === undefined && ev.spanId !== undefined) {
              if (this.#runtimeId === 'pi') {
                break;
              }
              turn.setSpanId(ev.spanId);
            }
          }

          if (ev.kind === 'text_delta') {
            turn?.appendRootText(ev.text, ev.messageId);
            this.#currentEventQueue?.push({ type: 'message', text: ev.text, final: false });
          } else if (ev.kind === 'tool_call_started') {
            const rawDetail = ev.input ?? '';
            const sanitizedDetail = redactSensitiveText(rawDetail);
            this.#currentEventQueue?.push({
              type: 'tool-call',
              name: ev.tool,
              detail: sanitizedDetail,
            });
          } else if (ev.kind === 'tool_call_ended') {
            const outputText = ev.content
              ?.map((c) => (c.type === 'text' ? c.text : ''))
              .filter(Boolean)
              .join('\n') ?? '';
            if (outputText) {
              const sanitizedOutput = redactSensitiveText(outputText);
              this.#currentEventQueue?.push({ type: 'tool-output', text: sanitizedOutput });
            }
          }
          // Note: reasoning is excluded from AgentRunEvents and final reply text
        }
        break;
      }

      case 'usage_snapshot': {
        if (!turn || msg.activationId !== turn.activationId) break;
        const sequenceFloor = turn.getSequenceFloor();
        if (sequenceFloor === undefined || msg.seq <= sequenceFloor) break;
        this.#observeUsage(msg.usage);
        break;
      }

      case 'turn_ended': {
        if (!turn) return;

        // Background or stale root endings cannot settle the current activation.
        if (msg.activationId !== turn.activationId) return;
        const boundSpanId = turn.getSpanId();
        const matchingNativeSpan = boundSpanId !== undefined && msg.spanId === boundSpanId;
        if (boundSpanId !== undefined && msg.spanId !== undefined && msg.spanId !== boundSpanId) {
          return;
        }
        const sequenceFloor = turn.getSequenceFloor();
        if (sequenceFloor !== undefined && !matchingNativeSpan &&
            (msg.seq === undefined || msg.seq <= sequenceFloor)) {
          return;
        }

        const outcome = msg.outcome;
        const usage = this.#settledUsage(msg.usage);

        if (outcome.kind === 'completed') {
          turn.finish({
            status: 'completed',
            text: turn.getRootText(),
            ...usage,
            source: 'oar',
            sourceVersion: this.#sourceVersion,
          });
        } else if (outcome.kind === 'aborted') {
          turn.finish({
            status: 'interrupted',
            ...usage,
            source: 'oar',
            sourceVersion: this.#sourceVersion,
          });
        } else if (outcome.kind === 'failed') {
          const reason = typeof outcome.reason === 'string' && outcome.reason.trim() !== ''
            ? redactSensitiveText(outcome.reason)
            : 'OAR turn failed';
          turn.finish({
            status: 'failed',
            message: reason,
            ...usage,
            source: 'oar',
            sourceVersion: this.#sourceVersion,
          });
        }
        break;
      }

      case 'abort_result': {
        // Only the native terminal event settles the turn's actual outcome.
        break;
      }

      case 'error': {
        const sanitized = redactSensitiveText(msg.message) || 'OAR runner error';
        turn?.finish({
          status: 'failed',
          message: sanitized,
          ...this.#settledUsage(),
          source: 'oar',
          sourceVersion: this.#sourceVersion,
        });
        break;
      }
    }
  }

  async interrupt(): Promise<boolean> {
    if (this.#closed || this.#currentTurnFinish === undefined ||
        this.#runner.exitCode !== null || this.#runner.signalCode !== null) return false;
    this.#interrupted = true;
    this.#sendAbort();
    this.#beginEscalation();
    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    const activeTurn = this.#currentTurnCompletion;
    if (activeTurn !== undefined && this.#currentTurnFinish !== undefined) {
      this.#interrupted = true;
      if (this.#escalation === undefined) this.#sendAbort();
      this.#beginEscalation();
      // Let an observed native terminal event win. Escalation records explicit
      // uncertainty when the native terminal never arrives.
      await activeTurn;
    }

    let stopped = false;
    try {
      stopped = await this.#disposeAndProveTreeStopped();
      this.terminationEvidence = stopped ? 'proved' : 'uncertain';
      if (stopped) this.#onTerminationProved?.();
    } finally {
      await this.#mcpBridge?.close();
    }
  }

  #sendAbort(): void {
    const activationId = this.#activeTurnContext?.activationId;
    if (activationId === undefined) return;
    try {
      this.#runner.stdin?.write(JSON.stringify({ op: 'abort', activationId }) + '\n');
    } catch {
      // Stream may be closed; bounded process-tree escalation still applies.
    }
  }

  #beginEscalation(): void {
    if (this.#escalation !== undefined) return;
    this.#escalation = this.#escalateAbort();
  }

  async #escalateAbort(): Promise<boolean> {
    await delay(4_000);
    for (const [signal, graceMs] of [['SIGINT', 2_000], ['SIGTERM', 2_000], ['SIGKILL', 2_000]] as const) {
      if (this.#currentTurnFinish === undefined) return true;
      killProcessTree(this.#runner, signal);
      if (await waitForProcessTreeStopped(this.#runner, graceMs)) {
        this.#finishUncertainTurn();
        return true;
      }
    }
    this.#finishUncertainTurn();
    return await waitForProcessTreeStopped(this.#runner, 0);
  }

  async #disposeAndProveTreeStopped(): Promise<boolean> {
    if (await waitForProcessTreeStopped(this.#runner, 0)) return true;
    try {
      if (this.#runner.stdin && !this.#runner.stdin.destroyed && this.#runner.stdin.writable) {
        this.#runner.stdin.write('{"op":"dispose"}\n');
      }
    } catch {
      // Child stdin might be closed; process-tree fencing still follows.
    }
    if (await waitForProcessTreeStopped(this.#runner, 1_000)) return true;
    killProcessTree(this.#runner, 'SIGKILL');
    return await waitForProcessTreeStopped(this.#runner, 2_000);
  }

  #finishUncertainTurn(): void {
    if (this.#currentTurnFinish === undefined) return;
    const usage = this.#settledUsage();
    this.#currentTurnFinish(this.#interrupted
      ? { status: 'interrupted', outcomeCertainty: 'uncertain', ...usage, source: 'oar', sourceVersion: this.#sourceVersion }
      : {
          status: 'failed', outcomeCertainty: 'uncertain',
          message: 'OAR turn outcome is uncertain because no terminal turn event was observed.',
          ...usage, source: 'oar', sourceVersion: this.#sourceVersion,
        });
  }

  #observeRunnerOutputClosed(): void {
    this.#runnerOutputClosed = true;
    if (this.#runnerExited) this.#onRunnerExit();
  }

  #onRunnerExit(): void {
    if (this.#currentTurnFinish === undefined) return;
    const usage = this.#settledUsage();
    this.#currentTurnFinish(this.#interrupted
      ? {
          status: 'interrupted', outcomeCertainty: 'uncertain', ...usage,
          source: 'oar', sourceVersion: this.#sourceVersion,
        }
      : {
          status: 'failed', outcomeCertainty: 'uncertain',
          message: 'OAR turn outcome is uncertain because the runner exited before terminal settlement.',
          ...usage, source: 'oar', sourceVersion: this.#sourceVersion,
        });
  }
}

function killProcessTree(child: OarRunnerProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 2_000,
      });
    } catch {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(signal); } catch { /* Ignore */ }
      }
    }
  } else {
    try {
      process.kill(-pid, signal);
    } catch {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(signal); } catch { /* Ignore */ }
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProcessTreeStopped(child: OarRunnerProcess, timeoutMs: number): Promise<boolean> {
  // Windows taskkill can request tree termination but is not an established
  // fence. Keep termination and lease settlement uncertain until Windows
  // Job-object or equivalent proof is implemented and accepted.
  if (process.platform === 'win32' || child.pid === undefined) return false;
  const deadline = Date.now() + timeoutMs;
  do {
    const parentExited = child.exitCode !== null || child.signalCode !== null;
    if (parentExited && !processGroupExists(child.pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (true);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
