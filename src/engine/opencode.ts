import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';

import type {
  EngineAdapter,
  EngineSession,
  EngineTurn,
  EngineTurnResult,
  StartSessionRequest,
} from './port.ts';
import { EventQueue } from './event-queue.ts';
import { mapOpenCodeEvent, newOpenCodeTurnState } from './opencode-protocol.ts';

/**
 * `opencode` engine adapter — the deliberately **non-streaming** one.
 *
 * Having this adapter is what makes ADR-0001's policy real rather than
 * theoretical: `opencode` delivers assistant text one whole block per provider
 * hop, so Sprout cannot show partial text or tool output mid-run. The adapter
 * declares `turn` and the core treats that as acceptable, which is exactly the
 * agreement the policy describes.
 *
 * Facts contract-verified against `opencode 1.18.x`:
 *
 * - `opencode run --format json` is one-shot; the prompt travels on **stdin**, and
 *   the protocol is stdout-only. Stderr must never contribute session state or
 *   errors.
 * - `--auto` lets the agent use its tools headlessly, the same reason the
 *   container sets Codex to `danger-full-access` and `agy` to skip permissions.
 * - Continuity comes from passing the emitted `sessionID` back through
 *   `--session <id>`. The id is `opencode`'s; Sprout captures it rather than
 *   choosing it.
 * - **Process exit 0 is authoritative.** The event loop can race the terminal
 *   event and omit it after a successful run, so the adapter settles on exit and
 *   treats a zero exit as success.
 */

export interface OpenCodeAdapterOptions {
  /** Path to the `opencode` executable. Resolved with `realpath` before launch. */
  readonly binaryPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly args?: readonly string[];
  /** Overrides for tests; production spawns the real process. */
  readonly spawnProcess?: (
    binaryPath: string,
    args: readonly string[],
  ) => {
    readonly stdout: NodeJS.ReadableStream;
    readonly stderr: NodeJS.ReadableStream;
    /** Writes the prompt to the process's stdin. */
    writeStdin(text: string): void;
    endStdin(): void;
    kill(): void;
    onExit(handler: (code: number | null) => void): void;
  onSpawnError(handler: (error: Error) => void): void;
  };
}

export class OpenCodeEngineAdapter implements EngineAdapter {
  readonly id = 'opencode';
  /**
   * One whole text block per provider hop, with no tool output until the hop
   * ends. Declared `turn`, not `incremental`, and this is the adapter that makes
   * the declaration meaningful.
   */
  readonly capabilities = { streaming: 'turn', supportsInterrupt: true } as const;
  readonly #options: OpenCodeAdapterOptions;
  #sessionCounter = 0;

  constructor(options: OpenCodeAdapterOptions) {
    this.#options = options;
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    // Sandboxed launch cannot traverse a symlink chain, so the real path is
    // resolved before spawn rather than relying on PATH.
    const binaryPath = realpathSync(this.#options.binaryPath);
    return new OpenCodeSession({
      binaryPath,
      workingDirectory: request.workingDirectory,
      options: this.#options,
      sessionId: `oc-${++this.#sessionCounter}-${Date.now().toString(36)}`,
    });
  }
}

interface OpenCodeSessionOptions {
  readonly binaryPath: string;
  readonly workingDirectory: string;
  readonly options: OpenCodeAdapterOptions;
  readonly sessionId: string;
}

/**
 * One `opencode` conversation.
 *
 * As with `agy`, the session id is assigned by the engine and captured by
 * Sprout, then passed back with `--session` on later turns.
 */
export class OpenCodeSession implements EngineSession {
  readonly sessionId: string;
  readonly #binaryPath: string;
  readonly #workingDirectory: string;
  readonly #options: OpenCodeAdapterOptions;
  #lastSessionId: string | undefined;
  #current: { kill(): void } | undefined;
  #settle: ((result: EngineTurnResult) => void) | undefined;
  #closed = false;

  constructor(options: OpenCodeSessionOptions) {
    this.#binaryPath = options.binaryPath;
    this.#workingDirectory = options.workingDirectory;
    this.#options = options.options;
    this.sessionId = options.sessionId;
  }

  run(prompt: string): EngineTurn {
    const queue = new EventQueue();
    const state = newOpenCodeTurnState();
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

    const args = this.#turnArgs();
    const turnProcess = this.#options.spawnProcess
      ? this.#options.spawnProcess(this.#binaryPath, args)
      : spawnOpenCode(this.#binaryPath, args, this.#workingDirectory, this.#options.env);
    this.#current = turnProcess;

    turnProcess.onExit((code) => {
      if (settled) return;
      // Process exit is authoritative: the event loop can omit the terminal
      // event entirely, so a zero exit with accumulated text is a success.
      if (code === 0) {
        finish({ status: 'completed', text: state.text });
        return;
      }
      finish({
        status: 'failed',
        message: state.failure ?? `opencode exited without settling the turn (code ${String(code)})`,
      });
    });
    turnProcess.onSpawnError((error) => {
      // Spawn failures fire 'error' without 'exit'; without this the turn
      // would hang forever after a bad working directory or missing binary.
      if (!settled) {
        finish({ status: 'failed', message: `opencode failed to start: ${error.message}` });
      }
    });

    let buffer = '';
    turnProcess.stdout.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === '') continue;
        try {
          const decoded = JSON.parse(line) as Record<string, unknown>;
          if (typeof decoded['sessionID'] === 'string' && decoded['sessionID'] !== '') {
            this.#lastSessionId = decoded['sessionID'];
          }
          const outcome = mapOpenCodeEvent(decoded, state);
          for (const event of outcome.events) queue.push(event);
          if (outcome.finish) finish(outcome.finish);
        } catch {
          // Non-JSON lines are engine chatter on the protocol channel.
        }
        newline = buffer.indexOf('\n');
      }
    });

    // The protocol is stdout-only, so stderr is never treated as session state
    // or as a provider error; it is only forwarded for diagnostics.
    turnProcess.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim() !== '' && this.#options.env?.['SPROUT_OPENCODE_VERBOSE'] === '1') {
        process.stderr.write(`[opencode] ${text}`);
      }
    });

    // The prompt travels on stdin, not argv.
    turnProcess.writeStdin(prompt);
    turnProcess.endStdin();

    return { events: queue, completion };
  }

  #turnArgs(): string[] {
    const session = this.#lastSessionId !== undefined ? ['--session', this.#lastSessionId] : [];
    return [
      // The subcommand is what makes this a run rather than a bare CLI invocation;
      // without it `opencode` prints its help and exits 1.
      'run',
      '--format',
      'json',
      // The daemon is headless and the agent's home is operator-owned, so tools
      // must be permitted for a run to be able to do anything.
      '--auto',
      ...session,
      ...(this.#options.args ?? []),
    ];
  }

  /**
   * Stop the turn.
   *
   * Settled locally before the kill, matching the other adapters.
   */
  async interrupt(): Promise<boolean> {
    if (this.#closed) return false;
    const turnProcess = this.#current;
    this.#settle?.({ status: 'interrupted' });
    if (!turnProcess) return false;
    turnProcess.kill();
    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#settle?.({ status: 'interrupted' });
    this.#current?.kill();
    this.#current = undefined;
  }
}

function spawnOpenCode(
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  writeStdin(text: string): void;
  endStdin(): void;
  kill(): void;
  onExit(handler: (code: number | null) => void): void;
  onSpawnError(handler: (error: Error) => void): void;
} {
  const child: ChildProcess = spawn(binaryPath, [...args], {
    cwd,
    // On Windows the resolved binary is often a .cmd shim, which node only
    // executes through the shell. Without this, spawn fails with ENOENT.
    ...(process.platform === 'win32' ? { shell: true } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(env !== undefined ? { env } : {}),
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdin || !stdout || !stderr) {
    child.kill('SIGTERM');
    throw new Error('opencode did not expose stdin/stdout/stderr');
  }
  return {
    stdout,
    stderr,
    writeStdin: (text) => {
      stdin.write(text);
    },
    endStdin: () => {
      stdin.end();
    },
    kill: () => {
      child.kill('SIGTERM');
    },
    onExit: (handler) => {
      child.on('exit', (code) => handler(code));
    },
    // Spawn failures fire 'error' without 'exit'; without this the turn would
    // hang forever after a bad working directory or missing binary.
    onSpawnError: (handler) => {
      child.on('error', (error: Error) => handler(error));
    },
  };
}
