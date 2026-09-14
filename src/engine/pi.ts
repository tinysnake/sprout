import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';

import type {
  AgentRunEvent,
  EngineAdapter,
  EngineSession,
  EngineTurn,
  EngineTurnResult,
  StartSessionRequest,
} from './port.ts';
import { EventQueue } from './event-queue.ts';
import { mapPiEvent, newPiTurnState } from './pi-protocol.ts';

/**
 * Pi engine adapter.
 *
 * Pi's lifecycle is the opposite of Codex's in the way that matters to this seam:
 * Codex is one long-lived supervised daemon, while Pi is **one process per turn**
 * resumed by session id. Nothing in `src/engine/port.ts` had to change for that,
 * which is the finding this adapter exists to produce.
 *
 * Measured on `pi 0.85.1`:
 *
 * - `--mode json` with an attached `-p <prompt>` streams line-delimited events.
 * - `--session-id <id>` is caller-chosen, so Sprout owns session identity; the
 *   same id resumes a prior conversation, which is how context continues across
 *   runs even though each turn is a new process.
 * - `--append-system-prompt` is the out-of-band channel for standing
 *   instructions, so they are not re-sent every turn.
 * - `agent_settled` terminates a turn.
 */

export interface PiAdapterOptions {
  /** Path to the `pi` executable. Resolved with `realpath` before launch. */
  readonly binaryPath: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Extra argv, e.g. a model selection. */
  readonly args?: readonly string[];
  /** Where Pi stores sessions; keeps Sprout's sessions out of the user's default. */
  readonly sessionDirectory?: string;
  /** Overrides for tests; production spawns the real process. */
  readonly spawnProcess?: (
    binaryPath: string,
    args: readonly string[],
  ) => PiSpawnedProcess;
}

export class PiEngineAdapter implements EngineAdapter {
  readonly id = 'pi';
  /**
   * Pi streams incrementally: text arrives as `text_delta` and tool calls become
   * visible when they execute. Declared rather than assumed, per ADR-0001.
   */
  readonly capabilities = {
    streaming: 'incremental',
    supportsInterrupt: true,
    // Pi takes standing instructions out-of-band through `--append-system-prompt`.
    standingInstructions: 'out-of-band',
  } as const;
  readonly #options: PiAdapterOptions;
  #sessionCounter = 0;

  constructor(options: PiAdapterOptions) {
    this.#options = options;
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    // Sandboxed launch cannot traverse a symlink chain, so the real path is
    // resolved before spawn rather than relying on PATH.
    const binaryPath = realpathSync(this.#options.binaryPath);
    // Sprout owns session identity: it is the caller-chosen id, not something the
    // CLI invents. A stored key from a previous run is that id, so resuming is
    // the same code path as starting (#19: Pi chooses per `--session-id`).
    const sessionId =
      request.resumeSessionKey ??
      `${request.agentId}-${++this.#sessionCounter}-${Date.now().toString(36)}`;
    return new PiSession({
      binaryPath,
      sessionId,
      workingDirectory: request.workingDirectory,
      ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
      options: this.#options,
    });
  }
}

interface PiSessionOptions {
  readonly binaryPath: string;
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly instructions?: string;
  readonly options: PiAdapterOptions;
}

/**
 * One Pi conversation.
 *
 * The session is a Sprout concept held across turns; the *process* is per turn,
 * which is where Pi differs from Codex. Sprout keeps the session id and passes it
 * to each new process, so context continues without Sprout supervising a daemon.
 */
export class PiSession implements EngineSession {
  readonly sessionId: string;
  /**
   * Pi's engine session key is the caller-chosen id: Sprout supplies it and Pi
   * either resumes it or creates it (#19 soft fallback). It is therefore always
   * equal to `sessionId`.
   */
  readonly engineSessionKey: string;
  readonly #binaryPath: string;
  readonly #workingDirectory: string;
  readonly #instructions: string | undefined;
  readonly #options: PiAdapterOptions;
  /** The process for the turn in flight, if any. */
  #current: { kill(): void } | undefined;
  #settle: ((result: EngineTurnResult) => void) | undefined;
  #closed = false;

  constructor(options: PiSessionOptions) {
    this.sessionId = options.sessionId;
    this.engineSessionKey = options.sessionId;
    this.#binaryPath = options.binaryPath;
    this.#workingDirectory = options.workingDirectory;
    this.#instructions = options.instructions;
    this.#options = options.options;
  }

  run(prompt: string): EngineTurn {
    const queue = new EventQueue();
    const state = newPiTurnState();
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

    const args = this.#turnArgs(prompt);
    // Named `turnProcess`, not `process`: shadowing the global would break the
    // stderr forwarding below.
    const turnProcess = this.#options.spawnProcess
      ? this.#options.spawnProcess(this.#binaryPath, args)
      : spawnPi(this.#binaryPath, args, this.#workingDirectory, this.#options.env);
    this.#current = turnProcess;

    turnProcess.onExit((code) => {
      // The process ending without a terminal event means the turn did not
      // complete; without this the caller would wait for a settlement that can
      // never arrive.
      if (!settled) {
        finish({
          status: 'failed',
          message: state.failure ?? `pi exited without settling the turn (code ${String(code)})`,
        });
      }
    });
    turnProcess.onSpawnError((error) => {
      // Spawn failures fire 'error' without 'exit'; without this the turn
      // would hang forever after a bad working directory or missing binary.
      if (!settled) {
        finish({ status: 'failed', message: `pi failed to start: ${error.message}` });
      }
    });

    let buffer = '';
    turnProcess.stdout.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== '') {
          try {
            const outcome = mapPiEvent(JSON.parse(line), state);
            for (const event of outcome.events) queue.push(event);
            if (outcome.finish) finish(outcome.finish);
          } catch {
            // A non-JSON line is engine chatter on the protocol channel;
            // ignoring it keeps one stray line from failing a healthy run.
          }
        }
        newline = buffer.indexOf('\n');
      }
    });

    // Pi's diagnostics explain a failure; forward them rather than letting them
    // fill a pipe nobody reads.
    turnProcess.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim() !== '' && this.#options.env?.['SPROUT_PI_VERBOSE'] === '1') {
        process.stderr.write(`[pi] ${text}`);
      }
    });

    return { events: queue, completion };
  }

  /** The argv for one turn; each turn is a fresh process resuming the session. */
  #turnArgs(prompt: string): string[] {
    return [
      '--mode',
      'json',
      '--print',
      '--session-id',
      this.sessionId,
      ...(this.#options.sessionDirectory !== undefined
        ? ['--session-dir', this.#options.sessionDirectory]
        : []),
      ...(this.#instructions !== undefined ? ['--append-system-prompt', this.#instructions] : []),
      ...(this.#options.args ?? []),
      // The prompt is a POSITIONAL argument: `--print`/`-p` is a boolean flag.
      // Passing `-p=<prompt>` is silently accepted and does nothing, so the
      // prompt must follow the flags as its own argument.
      prompt,
    ];
  }

  /**
   * Stop the turn.
   *
   * Pi's process is killed, because that is what stopping means when a turn is a
   * process. The turn is settled locally *before* the kill, so the user's stop
   * never waits on the engine, matching the Codex adapter's guarantee.
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

function spawnPi(
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): PiSpawnedProcess {
  // With shell:true node joins argv into a single command line that cmd.exe
  // re-parses — WITHOUT adding quotes itself, so any argument containing
  // spaces (prompts, system-prompt text) arrives split into pieces (found
  // live: the engine saw one message per word). Quote such arguments in the
  // joined form; cmd.exe's own quoting rules use doubled quotes for literals.
  const joinedArgs = process.platform === 'win32'
    ? args.map((arg) => (/^[A-Za-z0-9_.:/=-]+$/.test(arg) ? arg : `\"${arg.replaceAll('"', '\\\"')}\"`))
    : args;
  const child: ChildProcess = spawn(binaryPath, [...joinedArgs], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // On Windows the resolved binary is often a .cmd shim, which node only
    // executes through the shell. Without this, spawn fails with ENOENT.
    ...(process.platform === 'win32' ? { shell: true } : {}),
    ...(env !== undefined ? { env } : {}),
  });
  if (!child.stdout || !child.stderr) {
    child.kill('SIGTERM');
    throw new Error('pi did not expose stdout/stderr');
  }
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      child.kill('SIGTERM');
    },
    onExit: (handler) => {
      child.on('exit', (code) => handler(code));
    },
    // A spawn failure (bad cwd, missing binary) fires 'error' and NEVER 'exit':
    // swallowing the error would hang the turn forever, and leaving it
    // unhandled would crash the whole worker (both found live on Windows).
    onSpawnError: (handler) => {
      child.on('error', (error: Error) => handler(error));
    },
  };
}

export interface PiSpawnedProcess {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(): void;
  onExit(h: (code: number | null) => void): void;
  onSpawnError(h: (error: Error) => void): void;
}

export type { AgentRunEvent };
