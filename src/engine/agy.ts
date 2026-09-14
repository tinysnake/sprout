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
import { mapAgyEvent, newAgyTurnState } from './agy-protocol.ts';
import { deliverContractToWorkingDirectory, type ContractDelivery } from './contract-file.ts';

/**
 * `agy` (Antigravity) engine adapter.
 *
 * Measured on `agy 1.2.2` on this host, and the details below are load-bearing:
 *
 * - **The prompt must be attached to `--print`** (`--print=<prompt>`). A bare
 *   `--print` swallows the next flag as its prompt, so
 *   `--print <prompt> --dangerously-skip-permissions` silently runs with the
 *   wrong prompt and prints plain text instead of the protocol. Every other flag
 *   therefore has to precede `--print`.
 * - `--output-format stream-json` frames events as
 *   `{"event": "init" | "step_update" | "result"}`.
 * - `--conversation <id>` resumes a prior conversation; the id comes from the
 *   `init` frame, so Sprout owns session identity by reading it rather than by
 *   choosing it. This is the opposite of Pi and is worth knowing when assembling
 *   context.
 * - **There is no flag for standing instructions.** Unlike Pi's
 *   `--append-system-prompt`, `agy` has no system-prompt surface at all, so the
 *   project contract is delivered as a Sprout-owned file in the working
 *   directory (`contract-file.ts`) rather than injected into argv or the prompt.
 *   That is the `working-directory` standing-instructions channel (#14, #15,
 *   #19); the adapter declares it and performs the write, so "delivery" is an
 *   explicit, testable act rather than an assumption about what `agy` read.
 *   **Probed limitation:** in this build `agy 1.2.2`, headless (`--print`) runs
 *   loaded only worktree rules under `~/.gemini`; a project `AGENTS.md` and
 *   `.agents/rules/*.md` in the working directory did **not** change the run even
 *   in a workspace already present in `trustedWorkspaces`, and a 6,000-word
 *   `AGENTS.md` did not move the reported input-token count. The file is written
 *   to the channel #19/`agy` documents (`AGENTS.md`), the write is verified by
 *   test, and whether this build *honors* it is an engine fact recorded here
 *   rather than asserted. That is a real gap, not a Sprout one, and it is
 *   reported in the #21 work record as evidence rather than silently assumed
 *   away.
 * - **Headless mode auto-denies tools it cannot prompt for**, so a run that needs
 *   a tool either gets an allow rule from settings or runs with
 *   `--dangerously-skip-permissions`. Sprout passes the latter only when the
 *   environment is itself the isolation boundary, mirroring the Codex sandbox
 *   decision.
 * - `agy` **loses partial output when interrupted** (#7). Accepted for M1: the
 *   run's recorded events are the system of record, and an interrupted run is
 *   re-runnable.
 */

export interface AgyAdapterOptions {
  /** Path to the `agy` executable. Resolved with `realpath` before launch. */
  readonly binaryPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly args?: readonly string[];
  /**
   * Auto-approve tools.
   *
   * Required for any run that uses a tool, since headless mode cannot prompt.
   * The environment decides this, exactly as it decides the Codex sandbox.
   */
  readonly skipPermissions?: boolean;
  /** Overrides for tests; production spawns the real process. */
  readonly spawnProcess?: (
    binaryPath: string,
    args: readonly string[],
  ) => {
    readonly stdout: NodeJS.ReadableStream;
    readonly stderr: NodeJS.ReadableStream;
    kill(): void;
    onExit(handler: (code: number | null) => void): void;
  onSpawnError(handler: (error: Error) => void): void;
  };
}

export class AgyEngineAdapter implements EngineAdapter {
  readonly id = 'agy';
  readonly capabilities = {
    streaming: 'incremental',
    supportsInterrupt: true,
    // `agy` has no system-prompt surface, so the contract reaches it only
    // through a Sprout-owned file in the working directory (see AgySession).
    standingInstructions: 'working-directory',
  } as const;
  readonly #options: AgyAdapterOptions;
  #sessionCounter = 0;

  constructor(options: AgyAdapterOptions) {
    this.#options = options;
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    // Sandboxed launch cannot traverse a symlink chain, so the real path is
    // resolved before spawn rather than relying on PATH.
    const binaryPath = realpathSync(this.#options.binaryPath);
    // `agy` has no system-prompt surface, so the contract is delivered into the
    // working directory the run executes in. Doing it here, per session, keeps
    // the contract fresh for the environment the run actually resolved to (#18)
    // and lets the delivery mechanism be reported per run.
    const delivery = deliverContractToWorkingDirectory({
      workingDirectory: request.workingDirectory,
      ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
    });
    const session = new AgySession({
      binaryPath,
      workingDirectory: request.workingDirectory,
      options: this.#options,
      sessionId: `agy-${++this.#sessionCounter}-${Date.now().toString(36)}`,
      ...(delivery !== undefined ? { contractDelivery: delivery } : {}),
    });
    // A stored key from a previous run resumes `agy`'s conversation. `agy`
    // assigns conversation ids, so this is a *hint*: if it is stale the engine
    // warns and starts a fresh conversation with a new id (#19 soft fallback).
    if (request.resumeSessionKey !== undefined) {
      session.hintConversationId(request.resumeSessionKey);
    }
    return session;
  }
}

interface AgySessionOptions {
  readonly binaryPath: string;
  readonly workingDirectory: string;
  readonly options: AgyAdapterOptions;
  readonly sessionId: string;
  /** How the project contract reached this run's working directory, if at all. */
  readonly contractDelivery?: ContractDelivery;
}

/**
 * One `agy` conversation.
 *
 * Unlike Pi, `agy` does not accept a caller-chosen session id: it assigns one and
 * reports it in the `init` frame. Sprout therefore *captures* the id rather than
 * choosing it, and passes it back with `--conversation` on later turns.
 */
export class AgySession implements EngineSession {
  readonly sessionId: string;
  readonly #binaryPath: string;
  readonly #workingDirectory: string;
  readonly #options: AgyAdapterOptions;
  /** The conversation id `agy` reported, used to resume on later turns. */
  #conversationId: string | undefined;
  /** A stored id this session should try to resume before the first turn. */
  #resumeWith: string | undefined;
  #current: { kill(): void } | undefined;
  #settle: ((result: EngineTurnResult) => void) | undefined;
  #closed = false;
  /**
   * How the assembled contract reached this run's working directory.
   *
   * Read by tests to verify that a run in a project receives the contract
   * through `agy`'s only channel, and by the worker to log a delivery it could
   * not make (e.g. a user-owned `AGENTS.md` it refused to replace).
   */
  readonly contractDelivery: ContractDelivery | undefined;

  constructor(options: AgySessionOptions) {
    this.#binaryPath = options.binaryPath;
    this.#workingDirectory = options.workingDirectory;
    this.#options = options.options;
    this.sessionId = options.sessionId;
    this.contractDelivery = options.contractDelivery;
  }

  /** The id `agy` assigned, once a turn has started. */
  get conversationId(): string | undefined {
    return this.#conversationId;
  }

  /**
   * The engine session key to hand to the core.
   *
   * `agy` assigns the id, so it is only known after the `init` frame; before
   * that the stored hint is the best available answer. Reporting the hint when
   * the engine has not spoken yet is deliberate: a run that fails to start still
   * leaves the next run trying the same conversation rather than discarding it.
   */
  get engineSessionKey(): string | undefined {
    return this.#conversationId ?? this.#resumeWith;
  }

  /**
   * Try to resume `agy`'s conversation by id on the next turn.
   *
   * Set before the first turn. Once `agy` reports its `init` frame the reported
   * id wins, because `agy`'s own answer is authoritative about which
   * conversation the turn actually used (#19).
   */
  hintConversationId(id: string): void {
    this.#resumeWith = id;
  }

  run(prompt: string): EngineTurn {
    const queue = new EventQueue();
    const state = newAgyTurnState();
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
    const turnProcess = this.#options.spawnProcess
      ? this.#options.spawnProcess(this.#binaryPath, args)
      : spawnAgy(this.#binaryPath, args, this.#workingDirectory, this.#options.env);
    this.#current = turnProcess;

    turnProcess.onExit((code) => {
      // `agy` discards partial output when it is interrupted (#7), so a process
      // that ends without a result frame has nothing to recover. Failing
      // explicitly is what makes that loss safe rather than silent.
      if (!settled) {
        finish({
          status: 'failed',
          message: state.failure ?? `agy exited without settling the turn (code ${String(code)})`,
        });
      }
    });
    turnProcess.onSpawnError((error) => {
      // Spawn failures fire 'error' without 'exit'; without this the turn
      // would hang forever after a bad working directory or missing binary.
      if (!settled) {
        finish({ status: 'failed', message: `agy failed to start: ${error.message}` });
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
            const decoded = JSON.parse(line) as Record<string, unknown>;
            // agy puts the conversation id at the top level of the `init` frame,
            // alongside `init` itself rather than inside it.
            if (decoded['event'] === 'init' && typeof decoded['conversation_id'] === 'string') {
              this.#conversationId = decoded['conversation_id'];
              // `agy` is authoritative: a stale hint degrades to a fresh
              // conversation with a new id, and every later turn in this session
              // must use that new id rather than re-offering the refused one.
              this.#resumeWith = decoded['conversation_id'];
            }
            const outcome = mapAgyEvent(decoded, state);
            for (const event of outcome.events) queue.push(event);
            if (outcome.finish) finish(outcome.finish);
          } catch {
            // Non-JSON lines are engine chatter on the protocol channel.
          }
        }
        newline = buffer.indexOf('\n');
      }
    });

    turnProcess.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim() !== '' && this.#options.env?.['SPROUT_AGY_VERBOSE'] === '1') {
        process.stderr.write(`[agy] ${text}`);
      }
    });

    return { events: queue, completion };
  }

  /**
   * The argv for one turn.
   *
   * Every flag precedes `--print`, because a bare `--print` would swallow the
   * next flag as its prompt. The prompt itself is attached to the flag.
   */
  #turnArgs(prompt: string): string[] {
    const conversation = this.#resumeWith !== undefined ? ['--conversation', this.#resumeWith] : [];
    return [
      // Without this the prompt prints as plain text and there is no protocol to
      // parse, so the turn would exit having reported nothing.
      '--output-format',
      'stream-json',
      ...(this.#options.skipPermissions ? ['--dangerously-skip-permissions'] : []),
      ...conversation,
      ...(this.#options.args ?? []),
      // Standing instructions are delivered to the working directory before this
      // turn starts (`contract-file.ts`), never injected into argv: `agy` has no
      // system-prompt flag and prepending the contract to the prompt would make
      // it per-turn user content.
      //
      // Under shell:true (Windows .cmd shim) node joins argv into one command
      // line that cmd.exe re-parses, so the joined form needs Windows quoting
      // (found live).
      (process.platform === 'win32'
        ? `"--print=${prompt.replaceAll('"', '\\"')}"`
        : `--print=${prompt}`),
    ];
  }

  /**
   * Stop the turn.
   *
   * Settled locally before the kill, matching the other adapters. `agy` discards
   * whatever it had produced (#7), so nothing here tries to salvage partial text;
   * the events already reported are what survives.
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

function spawnAgy(
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(): void;
  onExit(handler: (code: number | null) => void): void;
  onSpawnError(handler: (error: Error) => void): void;
} {
  const child: ChildProcess = spawn(binaryPath, [...args], {
    // A spawn failure (ENOENT) must settle the turn, not crash the worker;
    // this handler swallows the error event so exit handling can run.
    // See pi.ts for the live finding from Windows.

    cwd,
    // On Windows the resolved binary is often a .cmd shim, which node only
    // executes through the shell. Without this, spawn fails with ENOENT.
    ...(process.platform === 'win32' ? { shell: true } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env !== undefined ? { env } : {}),
  });
  if (!child.stdout || !child.stderr) {
    child.kill('SIGTERM');
    throw new Error('agy did not expose stdout/stderr');
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
    // Spawn failures fire 'error' without 'exit'; without this the turn would
    // hang forever after a bad working directory or missing binary.
    onSpawnError: (handler) => {
      child.on('error', (error: Error) => handler(error));
    },
  };
}
