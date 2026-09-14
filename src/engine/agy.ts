import { spawn, type ChildProcess } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import type {
  EngineAdapter,
  EngineSession,
  EngineTurn,
  EngineTurnResult,
  StartSessionRequest,
} from './port.ts';
import type { ContractDelivery } from './port.ts';
import { EventQueue } from './event-queue.ts';
import { mapAgyEvent, newAgyTurnState } from './agy-protocol.ts';
import {
  AGY_CONTRACT_PAYLOAD_ENV,
  deliverContractThroughAgyHook,
  removeAgyContractPayload,
  type AgyContractDelivery,
} from './agy-contract-hook.ts';

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
 * - **There is no system-prompt flag, and the working directory is not read.**
 *   Unlike Pi's `--append-system-prompt`, `agy` has no system-prompt surface,
 *   and its headless runs do **not** load a project `AGENTS.md` or
 *   `.agents/rules/*.md` (probed on 1.2.2: a worktree rule changed nothing, in a
 *   plain directory, a git repository, and a trusted workspace, and a
 *   6,000-word `AGENTS.md` did not move the reported input-token count). The
 *   project contract is therefore delivered through the channel `agy` *does* read
 *   in headless mode: a `SessionStart` hook in its **global** customization root
 *   (`~/.gemini/config/`), returning an injected ephemeral system message.
 *   Sprout installs that hook once, idempotently, and gates it on an env var so
 *   it is inert for agy runs Sprout did not start. The adapter declares the
 *   `out-of-band` channel, because that is what it is: a system message injected
 *   separately from the user prompt, not a file the engine discovers. The write
 *   and the payload are both verified, and a customization root that cannot be
 *   prepared is reported `unavailable` rather than claimed as delivered.
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
   * `agy`'s global customization root, where the contract hook is installed.
   *
   * Defaults to `~/.gemini/config`, the root `agy 1.2.2` reads in headless mode.
   * Overridable so tests can use a scratch directory rather than the operator's
   * real configuration.
   */
  readonly configDirectory?: string;
  /** Where per-run contract payloads are written; defaults under the OS temp dir. */
  readonly payloadDirectory?: string;
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
    env: NodeJS.ProcessEnv | undefined,
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
    // `agy` has no system-prompt flag, but it does read a `SessionStart` hook
    // from its global customization root, which injects a system message before
    // the model runs. That is an out-of-band channel: the contract is delivered
    // as engine-side instructions, never as part of the user prompt.
    standingInstructions: 'out-of-band',
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
    // The contract is delivered through `agy`'s own config hook. Doing it here,
    // per session, keeps the contract fresh for the environment the run actually
    // resolved to (#18) and lets the delivery mechanism be reported per run.
    const delivery = this.#deliverContract(request);
    const session = new AgySession({
      binaryPath,
      workingDirectory: request.workingDirectory,
      options: this.#options,
      sessionId: `agy-${++this.#sessionCounter}-${Date.now().toString(36)}`,
      ...(delivery !== undefined ? { contractDelivery: delivery.delivery } : {}),
      ...(delivery !== undefined && delivery.env[AGY_CONTRACT_PAYLOAD_ENV] !== undefined
        ? { contractEnv: delivery.env }
        : {}),
      ...(delivery?.payloadPath !== undefined ? { contractPayloadPath: delivery.payloadPath } : {}),
    });
    // A stored key from a previous run resumes `agy`'s conversation. `agy`
    // assigns conversation ids, so this is a *hint*: if it is stale the engine
    // warns and starts a fresh conversation with a new id (#19 soft fallback).
    if (request.resumeSessionKey !== undefined) {
      session.hintConversationId(request.resumeSessionKey);
    }
    return session;
  }

  #deliverContract(request: StartSessionRequest): AgyContractDelivery | undefined {
    if (request.instructions === undefined || request.instructions === '') return undefined;
    const configDirectory =
      this.#options.configDirectory ?? join(homedir(), '.gemini', 'config');
    // Payloads are per-run scratch, so they default to the OS temp directory
    // rather than accumulating inside agy's configuration tree.
    const payloadDirectory =
      this.#options.payloadDirectory ?? join(tmpdir(), 'sprout-agy-contract-payloads');
    return deliverContractThroughAgyHook({
      configDirectory,
      payloadPath: join(
        payloadDirectory,
        `contract-${Date.now().toString(36)}-${this.#sessionCounter}.json`,
      ),
      instructions: request.instructions,
    });
  }
}

interface AgySessionOptions {
  readonly binaryPath: string;
  readonly workingDirectory: string;
  readonly options: AgyAdapterOptions;
  readonly sessionId: string;
  /** How standing instructions were delivered for this run, if attempted. */
  readonly contractDelivery?: ContractDelivery;
  /** The env addition that selects this run's contract payload. */
  readonly contractEnv?: Readonly<Record<string, string>>;
  /** The payload file to remove when the session closes. */
  readonly contractPayloadPath?: string;
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
   * How standing instructions were delivered for this run.
   *
   * Read by tests to verify that a run in a project receives the contract
   * through `agy`'s actual channel, and by the worker to report a delivery it
   * could not make.
   */
  readonly contractDelivery: ContractDelivery | undefined;
  /** The env addition that selects this run's contract payload. */
  readonly #contractEnv: Readonly<Record<string, string>>;
  /** The per-run payload file Sprout owns and cleans up. */
  readonly #contractPayloadPath: string | undefined;

  constructor(options: AgySessionOptions) {
    this.#binaryPath = options.binaryPath;
    this.#workingDirectory = options.workingDirectory;
    this.#options = options.options;
    this.sessionId = options.sessionId;
    this.contractDelivery = options.contractDelivery;
    this.#contractEnv = options.contractEnv ?? {};
    this.#contractPayloadPath = options.contractPayloadPath;
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
    const turnEnv = this.#turnEnv();
    const turnProcess = this.#options.spawnProcess
      ? this.#options.spawnProcess(this.#binaryPath, args, turnEnv)
      : spawnAgy(this.#binaryPath, args, this.#workingDirectory, turnEnv);
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
      ...(conversation),
      ...(this.#options.args ?? []),
      // Standing instructions are delivered through `agy`'s config hook before
      // this turn starts (`agy-contract-hook.ts`), never injected into argv:
      // `agy` has no system-prompt flag and prepending the contract to the prompt
      // would make it per-turn user content.
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
    removeAgyContractPayload(this.#contractPayloadPath);
  }

  /**
   * The environment for a turn.
   *
   * The contract env var is merged over the adapter's configured environment so
   * the hook selects this run's payload. When the adapter was given no explicit
   * environment, the payload variable is added to the inherited environment
   * rather than replacing it, so `agy` still finds its own configuration.
   */
  #turnEnv(): NodeJS.ProcessEnv | undefined {
    if (Object.keys(this.#contractEnv).length === 0) return this.#options.env;
    return { ...(this.#options.env ?? process.env), ...this.#contractEnv };
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
