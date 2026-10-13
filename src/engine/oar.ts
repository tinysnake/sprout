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
import { prepareOarRuntimePolicy } from './oar-runtime-policy.ts';
import { createOarMcpBridge, type OarMcpBridgeHandle } from './oar-mcp-bridge.ts';
import type { RunnerCommand, RunnerMessage } from './oar-runner-protocol.ts';
import type { SessionOptions, TokenTotals } from '@botiverse/oar';
import { redactSensitiveText } from '../environment/privacy.ts';
import type { CodexSandboxMode } from './codex.ts';

export const OAR_PACKAGE_VERSION = '0.59.1';

/** Verified runtime facts; registration does not grant Host-run authority. */
export const OAR_RUNTIME_REGISTRATIONS = {
  codex: { finalAnswer: 'turn-text', standingInstructions: 'out-of-band' },
  pi: { finalAnswer: 'turn-text', standingInstructions: 'out-of-band' },
  claude: {
    finalAnswer: 'last-message',
    standingInstructions: 'out-of-band',
    verifiedPlatforms: ['darwin'],
    verifiedCliVersion: '2.1.294',
    readiness: 'non-inference-auth-status',
    hostRun: 'unproved',
  },
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
  /** Optional Pi agent directory (maps to OAR_PI_AGENT_DIR in runner). */
  readonly agentDirectory?: string;
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
  /** Host-owned provider configuration; never copied from ambient Pi directories. */
  readonly piModels?: Readonly<Record<string, unknown>>;
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
      streaming: 'incremental',
      supportsInterrupt: true,
      standingInstructions: 'out-of-band',
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
      const message =
        `OAR Pi adapter does not support custom session directory (${this.#options.sessionDirectory}); ` +
        `use native Pi adapter to preserve configured session storage location`;
      if (request.resumeSessionKey) {
        throw new EngineResumeRefusedError(request.resumeSessionKey, message);
      }
      throw new EngineStartError(message);
    }

    // Build SessionOptions
    const sessionOptions: SessionOptions = {
      ...(this.id === 'claude' ? { disallowedTools: [...OAR_CLAUDE_DISALLOWED_TOOLS] } : {}),
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
      policy = prepareOarRuntimePolicy(this.id, request.workingDirectory, {
        ...(mcpBridge ? { approvedMcp: mcpBridge.mcpServer } : {}),
        ...(this.#options.piModels ? { models: this.#options.piModels } : {}),
        ...(request.model ? { targetModel: request.model } : {}),
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
            ...(this.#options.agentDirectory ? { OAR_PI_AGENT_DIR: this.#options.agentDirectory } : {}),
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
            ...(this.#options.agentDirectory ? { OAR_PI_AGENT_DIR: this.#options.agentDirectory } : {}),
          },
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as unknown as OarRunnerProcess);
    } catch (error) {
      policy?.close();
      await mcpBridge?.close();
      throw error;
    }
    // Parent owns restoration even when the runner is killed before graceful disposal.
    runner.on('exit', () => policy?.close());
    runner.on('error', () => {
      // Spawn errors have no process; other errors must not release a still-live loader.
      if (runner.pid === undefined) policy?.close();
    });

    const clock = this.#options.clock ?? (() => Date.now());

    return new Promise<EngineSession>((resolve, reject) => {
      let settled = false;
      let buffer = '';

      const startTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killProcessTree(runner);
        void mcpBridge?.close();
        reject(new EngineStartError('OAR runner failed to become ready within timeout'));
      }, 25_000);

      const failStart = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        killProcessTree(runner);
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
                    mcpBridge,
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
                  if (
                    request.resumeSessionKey &&
                    (sanitized.includes('no rollout') ||
                      sanitized.includes('SessionNotFoundError') ||
                      sanitized.includes('session not found') ||
                      sanitized.includes('unknown thread') ||
                      sanitized.includes('resume refused') ||
                      /\bsession\b.*\bnot found\b/i.test(sanitized) ||
                      sanitized.includes('no session file'))
                  ) {
                    failStart(new EngineResumeRefusedError(request.resumeSessionKey, sanitized));
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
  readonly mcpBridge?: OarMcpBridgeHandle | undefined;
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
  readonly #clock: () => number;

  #closed = false;
  #currentTurnFinish: ((result: EngineTurnResult) => void) | undefined;
  #currentEventQueue: EventQueue | undefined;
  #buffer = '';
  #baselineUsage: TokenTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  #interrupted = false;

  constructor(params: OarEngineSessionParams) {
    this.#runner = params.runner;
    this.sessionId = params.sessionId;
    this.engineSessionKey = params.engineSessionKey;
    this.#sourceVersion = params.sourceVersion;
    this.#runtimeId = params.runtimeId;
    this.#mcpBridge = params.mcpBridge;
    this.#clock = params.clock;

    this.#runner.stdout?.on('data', (chunk: Buffer | string) => {
      this.pushData(chunk.toString());
    });

    this.#runner.on('exit', () => {
      this.#onRunnerExit();
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

    const activationId = randomUUID();
    let currentSpanId: string | undefined;

    // Attach local state handlers before sending the command, so synchronous
    // test fixtures or fast responses cannot race turn context attachment.
    this.#activeTurnContext = {
      activationId,
      getSpanId: () => currentSpanId,
      setSpanId: (spanId: string) => {
        if (!currentSpanId) currentSpanId = spanId;
      },
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
    appendRootText(text: string, messageId?: string): void;
    getRootText(): string;
    finish(result: EngineTurnResult): void;
  };

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
        }
        break;
      }

      case 'prompt_rejected': {
        if (!turn) return;
        if (msg.activationId && msg.activationId !== turn.activationId) return;
        const sanitized = redactSensitiveText(msg.reason);
        turn.finish({
          status: 'failed',
          message: `OAR prompt rejected (${msg.code}): ${sanitized || 'engine busy or refused'}`,
        });
        break;
      }

      case 'event': {
        if (turn && msg.activationId !== undefined && msg.activationId !== turn.activationId) {
          break;
        }

        const ev = msg.event;
        const isRoot = (!ev.agentPath || ev.agentPath.length === 0) && ev.sessionId === this.sessionId;

        if (isRoot) {
          // If turn is active, enforce span attribution:
          // A background or stale root event must NOT contribute text or progress to the active turn.
          if (turn) {
            const boundSpanId = turn.getSpanId();
            if (boundSpanId !== undefined && ev.spanId !== undefined && ev.spanId !== boundSpanId) {
              // Stale or background root event — do NOT attribute to active turn
              break;
            }
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

      case 'turn_ended': {
        if (!turn) return;

        // Verify activation and span attribution:
        // Background or stale root endings must neither settle nor contribute to the current turn.
        if (msg.activationId !== undefined && msg.activationId !== turn.activationId) {
          return;
        }

        const boundSpanId = turn.getSpanId();
        if (boundSpanId !== undefined && msg.spanId !== undefined && msg.spanId !== boundSpanId) {
          return;
        }

        const outcome = msg.outcome;
        const usage = msg.usage;

        let tokenUsage: TokenUsage | undefined;
        let detailedTokens: DetailedTokenDimensions | undefined;

        if (usage?.total) {
          const inputDelta = Math.max(0, usage.total.input - this.#baselineUsage.input);
          const outputDelta = Math.max(0, usage.total.output - this.#baselineUsage.output);
          tokenUsage = {
            promptTokens: inputDelta,
            completionTokens: outputDelta,
            totalTokens: inputDelta + outputDelta,
          };
          detailedTokens = {
            inputTokens: inputDelta,
            outputTokens: outputDelta,
            ...(usage.total.reasoning !== undefined
              ? { reasoningOutputTokens: Math.max(0, usage.total.reasoning - (this.#baselineUsage.reasoning ?? 0)) }
              : {}),
            ...(usage.total.cacheRead !== undefined
              ? { cachedInputTokens: Math.max(0, usage.total.cacheRead - (this.#baselineUsage.cacheRead ?? 0)) }
              : {}),
            ...(this.#runtimeId === 'claude' && usage.total.cacheWrite !== undefined
              ? { cacheWriteInputTokens: Math.max(0, usage.total.cacheWrite - (this.#baselineUsage.cacheWrite ?? 0)) }
              : {}),
          };
          this.#baselineUsage = {
            input: usage.total.input,
            output: usage.total.output,
            ...(usage.total.reasoning !== undefined ? { reasoning: usage.total.reasoning } : {}),
            ...(usage.total.cacheRead !== undefined ? { cacheRead: usage.total.cacheRead } : {}),
            ...(usage.total.cacheWrite !== undefined ? { cacheWrite: usage.total.cacheWrite } : {}),
          };
        }

        if (outcome.kind === 'completed') {
          turn.finish({
            status: 'completed',
            text: turn.getRootText(),
            ...(tokenUsage !== undefined ? { tokenUsage } : {}),
            ...(detailedTokens !== undefined ? { detailedTokens } : {}),
            source: 'oar',
            sourceVersion: this.#sourceVersion,
          });
        } else if (outcome.kind === 'aborted' || this.#interrupted) {
          turn.finish({
            status: 'interrupted',
            ...(tokenUsage !== undefined ? { tokenUsage } : {}),
            ...(detailedTokens !== undefined ? { detailedTokens } : {}),
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
            ...(tokenUsage !== undefined ? { tokenUsage } : {}),
            ...(detailedTokens !== undefined ? { detailedTokens } : {}),
            source: 'oar',
            sourceVersion: this.#sourceVersion,
          });
        }
        break;
      }

      case 'error': {
        const sanitized = redactSensitiveText(msg.message) || 'OAR runner error';
        turn?.finish({
          status: 'failed',
          message: sanitized,
        });
        break;
      }
    }
  }

  async interrupt(): Promise<boolean> {
    if (this.#closed || this.#runner.exitCode !== null) return false;
    this.#interrupted = true;
    try {
      this.#runner.stdin?.write('{"op":"abort"}\n');
    } catch {
      // Stream may be closed
    }

    // Schedule bounded escalation
    const child = this.#runner;
    const escalationTimer = setTimeout(() => {
      if (this.#currentTurnFinish !== undefined) {
        killProcessTree(child, 'SIGINT');
        const termTimer = setTimeout(() => {
          if (this.#currentTurnFinish !== undefined) {
            killProcessTree(child, 'SIGTERM');
            const killTimer = setTimeout(() => {
              if (this.#currentTurnFinish !== undefined) {
                killProcessTree(child, 'SIGKILL');
              }
            }, 2_000);
            killTimer.unref?.();
          }
        }, 2_000);
        termTimer.unref?.();
      }
    }, 4_000);
    escalationTimer.unref?.();

    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#currentTurnFinish !== undefined) {
      this.#currentTurnFinish({ status: 'interrupted' });
    }

    if (this.#runner.exitCode !== null) {
      if (this.#mcpBridge) {
        await this.#mcpBridge.close();
      }
      return;
    }

    try {
      if (this.#runner.stdin && !this.#runner.stdin.destroyed && this.#runner.stdin.writable) {
        this.#runner.stdin.write('{"op":"dispose"}\n');
      }
    } catch {
      // Child stdin might be closed
    }

    if (this.#runner.exitCode !== null) {
      if (this.#mcpBridge) {
        await this.#mcpBridge.close();
      }
      return;
    }

    // Wait for exit with bounded escalation to killProcessTree
    const exited = await new Promise<boolean>((resolve) => {
      let settled = false;
      const onExit = () => {
        if (!settled) {
          settled = true;
          clearTimeout(disposeTimer);
          clearTimeout(killTimer);
          resolve(true);
        }
      };

      this.#runner.on('exit', onExit);

      const disposeTimer = setTimeout(() => {
        if (settled) return;
        killProcessTree(this.#runner, 'SIGKILL');
      }, 1_000);
      disposeTimer.unref?.();

      const killTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          clearTimeout(disposeTimer);
          resolve(false);
        }
      }, 2_500);
      killTimer.unref?.();
    });

    if (this.#mcpBridge) {
      await this.#mcpBridge.close();
    }

    if (!exited && this.#runner.exitCode === null && this.#runner.signalCode === null) {
      throw new Error('OAR runner process tree did not terminate; stop uncertainty preserved');
    }
  }

  #onRunnerExit(): void {
    if (this.#currentTurnFinish !== undefined) {
      if (this.#interrupted) {
        this.#currentTurnFinish({ status: 'interrupted' });
      } else {
        this.#currentTurnFinish({
          status: 'failed',
          message: 'OAR runner connection was lost',
        });
      }
    }
  }
}

function killProcessTree(child: OarRunnerProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Ignore
      }
    }
  } else {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Ignore
      }
    }
  }
}
