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
import { deliverContractToWorkingDirectory, type ContractDelivery } from './contract-file.ts';
import { registerOpenCodeInstructionPath } from './opencode-instructions.ts';

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
 * - **`--dir` must be passed explicitly.** The process otherwise inherits the
 *   worker's cwd, so a project `AGENTS.md` Sprout delivered to the run's own
 *   directory is never read. Found live: the delivered contract had no effect on
 *   the answer until `--dir <workingDirectory>` was added.
 * - **`AGENTS.md` in the working directory is the standing-instructions channel.**
 *   `opencode run` has no system-prompt flag; it discovers `AGENTS.md`
 *   (and `CLAUDE.md`/`CONTEXT.md`) upward from the working directory. Verified
 *   live: a contract delivered there changed the run's answer.
 * - **Discovery is by those three names only**, so Sprout's fallback
 *   `SPROUT-PROJECT-CONTRACT.md` is invisible to it. When the primary file cannot
 *   be used, the adapter registers the fallback path through `opencode`'s own
 *   config `instructions` list (`OPENCODE_CONFIG_CONTENT`, merged over the loaded
 *   config) instead of reporting a delivery the engine never receives. Verified
 *   live: an unregistered fallback file changed nothing, and the same file
 *   registered through the config list changed the answer.
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
    env: NodeJS.ProcessEnv | undefined,
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
  readonly capabilities = {
    streaming: 'turn',
    supportsInterrupt: true,
    // `opencode run` has no system-prompt flag; it reads `AGENTS.md` from the
    // working directory, so the contract is delivered the same way as `agy`.
    standingInstructions: 'working-directory',
  } as const;
  readonly #options: OpenCodeAdapterOptions;
  #sessionCounter = 0;

  constructor(options: OpenCodeAdapterOptions) {
    this.#options = options;
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    // Sandboxed launch cannot traverse a symlink chain, so the real path is
    // resolved before spawn rather than relying on PATH.
    const binaryPath = realpathSync(this.#options.binaryPath);
    // `opencode run` has no system-prompt flag; it reads `AGENTS.md` from the
    // working directory, so the contract is delivered there. Confirmed live:
    // an `AGENTS.md` with a distinctive instruction changed the run's answer.
    const written = deliverContractToWorkingDirectory({
      workingDirectory: request.workingDirectory,
      ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
    });
    // A fallback write is only a delivery if the engine can read the file, and
    // `opencode` does not discover Sprout's fallback name. The path is
    // registered through the engine's own config `instructions` list; if that
    // cannot be done — an operator config Sprout refuses to rewrite, for
    // example — the delivery is downgraded to `unavailable` rather than being
    // reported as reaching the engine.
    const { delivery, contractEnv } = this.#registerDelivery(written);
    return new OpenCodeSession({
      binaryPath,
      workingDirectory: request.workingDirectory,
      options: this.#options,
      sessionId: `oc-${++this.#sessionCounter}-${Date.now().toString(36)}`,
      ...(delivery !== undefined ? { contractDelivery: delivery } : {}),
      ...(contractEnv !== undefined ? { contractEnv } : {}),
      ...(request.resumeSessionKey !== undefined
        ? { resumeSessionId: request.resumeSessionKey }
        : {}),
    });
  }

  /**
   * Make a Sprout-written contract file readable by `opencode`.
   *
   * The primary `AGENTS.md` needs nothing: the engine discovers it. Sprout's
   * fallback file does not, so its path is added to the config `instructions`
   * list through the inline `OPENCODE_CONFIG_CONTENT` overlay. A failure to
   * register downgrades the report to `unavailable`; a run must never report a
   * successful delivery the engine did not receive (C21-004).
   */
  #registerDelivery(written: ContractDelivery | undefined): {
    readonly delivery: ContractDelivery | undefined;
    readonly contractEnv: Readonly<Record<string, string>> | undefined;
  } {
    if (written === undefined) return { delivery: undefined, contractEnv: undefined };
    if (written.mechanism !== 'sprout-contract-file' || written.path === undefined) {
      return { delivery: written, contractEnv: undefined };
    }

    const registration = registerOpenCodeInstructionPath({
      // The spawned process inherits `process.env` when the adapter was given no
      // explicit environment, so registration must read the *effective* source:
      // an operator's shell-level `OPENCODE_CONFIG_CONTENT` would otherwise be
      // replaced by a fresh overlay instead of merged.
      env: this.#options.env ?? process.env,
      path: written.path,
    });
    if (registration.env === undefined) {
      return {
        delivery: {
          mechanism: 'unavailable',
          path: written.path,
          ...(written.agentsMdSkipped !== undefined
            ? { agentsMdSkipped: written.agentsMdSkipped }
            : {}),
          reason:
            `the contract was written to ${written.path} but could not be registered with ` +
            `opencode's instruction list (${registration.reason ?? 'unknown reason'})`,
        },
        contractEnv: undefined,
      };
    }
    return { delivery: written, contractEnv: registration.env };
  }
}

interface OpenCodeSessionOptions {
  readonly binaryPath: string;
  readonly workingDirectory: string;
  readonly options: OpenCodeAdapterOptions;
  readonly sessionId: string;
  /** A stored engine session id to continue (`--session`). */
  readonly resumeSessionId?: string;
  /** How the project contract reached this run's working directory, if at all. */
  readonly contractDelivery?: ContractDelivery;
  /**
   * The environment overlay that registers Sprout's contract file with the
   * engine, when the primary `AGENTS.md` could not be used.
   */
  readonly contractEnv?: Readonly<Record<string, string>>;
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
  /** How the assembled contract reached this run's working directory. */
  readonly contractDelivery: ContractDelivery | undefined;
  /** The environment overlay that registers Sprout's contract file, if any. */
  readonly #contractEnv: Readonly<Record<string, string>>;

  constructor(options: OpenCodeSessionOptions) {
    this.#binaryPath = options.binaryPath;
    this.#workingDirectory = options.workingDirectory;
    this.#options = options.options;
    this.sessionId = options.sessionId;
    this.contractDelivery = options.contractDelivery;
    this.#contractEnv = options.contractEnv ?? {};
    // A stored id from a previous run is offered through `--session`. If it is
    // stale the engine fails the turn hard (#19), which is why the core only
    // offers keys it can trust and records what the run actually used.
    this.#lastSessionId = options.resumeSessionId;
  }

  /**
   * The engine session key to hand to the core.
   *
   * `opencode` assigns `ses_…` ids and reports them on every frame, so this is
   * the id seen so far. A stored id that was never confirmed by the engine is
   * still the honest answer for a run that produced nothing.
   */
  get engineSessionKey(): string | undefined {
    return this.#lastSessionId;
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
    const turnEnv = this.#turnEnv();
    const turnProcess = this.#options.spawnProcess
      ? this.#options.spawnProcess(this.#binaryPath, args, turnEnv)
      : spawnOpenCode(this.#binaryPath, args, this.#workingDirectory, turnEnv);
    this.#current = turnProcess;

    // stderr is never session state (the protocol is stdout-only), but it is the
    // only place opencode states *why* a resume was refused, so it is buffered
    // solely to classify a session-start refusal for the core.
    let stderrText = '';
    turnProcess.onExit((code) => {
      if (settled) return;
      // Process exit is authoritative: the event loop can omit the terminal
      // event entirely, so a zero exit with accumulated text is a success.
      if (code === 0) {
        finish({ status: 'completed', text: state.text });
        return;
      }
      const refused =
        this.#lastSessionId !== undefined &&
        state.failure === undefined &&
        isSessionNotFound(stderrText);
      const message =
        state.failure ?? `opencode exited without settling the turn (code ${String(code)})`;
      finish({
        status: 'failed',
        message,
        ...(refused ? { resumeRefused: true } : {}),
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
    // or as a provider error; it is only forwarded for diagnostics and inspected
    // to recognise a refused resume (see the exit handler above).
    turnProcess.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrText += text;
      if (text.trim() !== '' && this.#options.env?.['SPROUT_OPENCODE_VERBOSE'] === '1') {
        process.stderr.write(`[opencode] ${text}`);
      }
    });

    // The prompt travels on stdin, not argv.
    turnProcess.writeStdin(prompt);
    turnProcess.endStdin();

    return { events: queue, completion };
  }

  /**
   * The environment for a turn.
   *
   * When the fallback contract file must be registered, the inline config
   * overlay is merged over the adapter's configured environment. With no
   * explicit environment the variable is added to the inherited one, so
   * `opencode` still finds its own configuration and credentials.
   */
  #turnEnv(): NodeJS.ProcessEnv | undefined {
    if (Object.keys(this.#contractEnv).length === 0) return this.#options.env;
    return { ...(this.#options.env ?? process.env), ...this.#contractEnv };
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
      // `--dir` pins the run to the working directory Sprout resolved. Without it
      // the process inherits the *worker's* cwd, so a project `AGENTS.md` written
      // there is never read — found live: a contract delivered to the run's
      // directory had no effect until the directory was passed explicitly.
      '--dir',
      this.#workingDirectory,
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

/**
 * Whether stderr is opencode's refused-resume diagnostic.
 *
 * opencode writes `Error: Session not found` to stderr and exits 1 when
 * `--session <id>` names a session it does not have (#19, re-probed against
 * 1.18.30). Nothing else it prints for a missing session-start key looks like
 * this, and an unrelated failure (provider error, bad cwd) does not, so the
 * core only degrades a key that was actually refused.
 */
function isSessionNotFound(stderr: string): boolean {
  return /session not found/i.test(stderr);
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
