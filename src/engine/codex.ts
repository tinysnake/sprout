import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';

import type {
  EngineAdapter,
  EngineSession,
  EngineTurn,
  EngineTurnResult,
  StartSessionRequest,
} from './port.ts';
import { LineJsonRpcTransport, type JsonRpcTransport } from './jsonrpc.ts';
import { EventQueue } from './event-queue.ts';
import { mapCodexNotification, type CodexTurnState } from './codex-protocol.ts';

/**
 * Codex engine adapter (ADR-0001).
 *
 * Codex runs through `app-server`, a supervised long-lived child process
 * speaking JSON-RPC over stdio, rather than `exec`, because `exec --json` does
 * not stream. Two details found during probing are load-bearing here:
 *
 * 1. The binary must be launched through its resolved real path. A PATH symlink
 *    is not traversable under the sandbox profile and fails with
 *    `sandbox-exec: execvp() … Operation not permitted`.
 * 2. `app-server`'s `turn/completed` carries no token usage, so usage is only
 *    observable from `thread/tokenUsage/updated`; nothing here assumes the
 *    completion event reports it.
 *
 * For this slice, readiness is a successful `initialize`; supervising restarts
 * of a dead daemon is O4 work.
 */

export interface CodexAdapterOptions {
  /** Path to the `codex` executable. Resolved with `realpath` before launch. */
  readonly binaryPath: string;
  /** Extra argv, e.g. `['--strict-config']`. Configuration is the caller's job. */
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The Codex sandbox mode for sessions this adapter starts.
   *
   * Defaults to `read-only`, which is Sprout's posture on a shared host where
   * Codex is not the only thing running. An environment that is *itself* the
   * isolation boundary — a container — sets `danger-full-access`, because Codex's
   * own sandbox is then both redundant and, inside an unprivileged container,
   * broken: `bwrap` cannot create a user namespace and every turn fails with
   * "No permissions to create a new namespace".
   *
   * This is an engine-level setting rather than a Sprout policy decision: what a
   * run may touch is the environment's business, and the environment told Sprout
   * it is a container.
   */
  readonly sandbox?: CodexSandboxMode;
  /** Overrides for tests; production uses the real child process. */
  readonly spawnProcess?: (binaryPath: string, args: readonly string[]) => CodexProcess;
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): void;
  onExit(handler: (code: number | null) => void): void;
  onSpawnError(handler: (error: Error) => void): void;
}

export class CodexEngineAdapter implements EngineAdapter {
  readonly id = 'codex';
  readonly capabilities = { streaming: 'incremental', supportsInterrupt: true } as const;
  readonly #options: CodexAdapterOptions;

  constructor(options: CodexAdapterOptions) {
    this.#options = options;
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    // Sandboxed launch cannot traverse a symlink chain, so the real path is
    // resolved before spawn rather than relying on PATH.
    const binaryPath = realpathSync(this.#options.binaryPath);
    const args = ['app-server', '--listen', 'stdio://', ...(this.#options.args ?? [])];
    const process = this.#options.spawnProcess
      ? this.#options.spawnProcess(binaryPath, args)
      : spawnCodex(binaryPath, args, this.#options.env);

    const transport = new LineJsonRpcTransport({
      input: process.stdout,
      output: process.stdin,
      onClose: (reason) => session?.handleTransportClosed(reason),
    });
    let session: CodexSession | undefined;

    // A spawn failure (bad binary, ENOENT) fires 'error' without 'exit':
    // without closing the transport here, the initialize request would hang
    // forever instead of failing.
    process.onSpawnError(() => {
      transport.close();
    });

    try {
      await transport.request('initialize', {
        clientInfo: { name: 'sprout', version: '0.0.0' },
      });
    } catch (error) {
      transport.close();
      process.kill('SIGTERM');
      throw new Error(
        `codex app-server failed to initialise: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    transport.notify('initialized', {});

    // Codex assigns thread ids, but `thread/resume` returns the same id, so a
    // stored key is passed straight through. A stale key is a hard failure
    // (`no rollout found for thread id …`, #19); the orchestrator owns degrading
    // that to a fresh session, so this adapter does not swallow it. The daemon is
    // closed before rethrowing, because a refused resume must not leak a process.
    let started: { thread: { id: string } };
    try {
      started = await this.#openThread(transport, request);
    } catch (error) {
      transport.close();
      process.kill('SIGTERM');
      throw error;
    }

    session = new CodexSession({
      transport,
      process,
      threadId: started.thread.id,
      agentId: request.agentId,
    });
    return session;
  }

  /** Open the thread for a session: resume a stored one, or start a fresh one. */
  async #openThread(
    transport: JsonRpcTransport,
    request: StartSessionRequest,
  ): Promise<{ thread: { id: string } }> {
    if (request.resumeSessionKey !== undefined) {
      return transport.request<{ thread: { id: string } }>('thread/resume', {
        threadId: request.resumeSessionKey,
        cwd: request.workingDirectory,
        sandbox: this.#options.sandbox ?? 'read-only',
        approvalPolicy: 'never',
        ...(request.instructions !== undefined ? { baseInstructions: request.instructions } : {}),
      });
    }
    return transport.request<{ thread: { id: string } }>('thread/start', {
      cwd: request.workingDirectory,
      sandbox: this.#options.sandbox ?? 'read-only',
      approvalPolicy: 'never',
      ...(request.instructions !== undefined ? { baseInstructions: request.instructions } : {}),
    });
  }
}

function spawnCodex(
  binaryPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): CodexProcess {
  const child: ChildProcess = spawn(binaryPath, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // On Windows the resolved binary may be a .cmd shim; see pi.ts.
    ...(process.platform === 'win32' ? { shell: true } : {}),
    ...(env !== undefined ? { env } : {}),
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error('codex app-server did not expose stdio');
  }
  // Engine diagnostics are how a failure is explained; forward them rather than
  // letting them fill a pipe buffer nobody reads.
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[codex] ${chunk.toString()}`);
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => {
      child.kill(signal);
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

interface CodexSessionOptions {
  readonly transport: JsonRpcTransport;
  readonly process: CodexProcess;
  readonly threadId: string;
  readonly agentId: string;
}

export class CodexSession implements EngineSession {
  readonly sessionId: string;
  /**
   * Codex's engine session key is the thread id. Because `thread/resume` keeps
   * the same id, it is known as soon as the session starts rather than only
   * after a turn.
   */
  readonly engineSessionKey: string;
  readonly #transport: JsonRpcTransport;
  readonly #process: CodexProcess;
  readonly #threadId: string;
  #turnId: string | undefined;
  #closed = false;
  /**
   * Settles the turn that is currently in flight.
   *
   * A turn only settles when `turn/completed` arrives, so if the daemon dies or
   * the session is closed first, nothing would ever resolve it and the caller
   * would wait forever. Keeping the resolver lets `interrupt`, `close`, and an
   * unexpected stream end all settle the turn explicitly.
   */
  #settleTurn: ((result: EngineTurnResult) => void) | undefined;

  constructor(options: CodexSessionOptions) {
    this.#transport = options.transport;
    this.#process = options.process;
    this.#threadId = options.threadId;
    this.sessionId = options.threadId;
    this.engineSessionKey = options.threadId;
  }

  run(prompt: string): EngineTurn {
    const state: CodexTurnState = { text: '', finalText: '', failure: undefined };
    const queue = new EventQueue();
    let settled = false;
    let resolveCompletion: (result: EngineTurnResult) => void = () => {};
    const completion = new Promise<EngineTurnResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const finish = (result: EngineTurnResult) => {
      if (settled) return;
      settled = true;
      this.#settleTurn = undefined;
      if (result.status === 'failed') queue.fail(new Error(result.message));
      else queue.end();
      resolveCompletion(result);
    };
    this.#settleTurn = finish;

    const unsubscribe = this.#transport.onNotification((notification) => {
      if (notification.method === 'thread/tokenUsage/updated') {
        // Usage is not on turn/completed for app-server; it is recorded here so
        // a later observer can read it without re-deriving the protocol.
        return;
      }
      const outcome = mapCodexNotification(notification, state);
      for (const event of outcome.events) queue.push(event);
      if (outcome.finish) finish(outcome.finish);
    });

    const onClose = this.#transport.onServerRequest((request) => {
      // M1 runs read-only and non-interactive, so approval prompts are declined
      // rather than silently hanging the turn.
      this.#transport.respondError(request.id, -32_601, 'sprout runs non-interactively');
    });

    void this.#startTurn(prompt).catch((error: unknown) => {
      finish({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    });

    return {
      events: queue,
      completion: completion.finally(() => {
        unsubscribe();
        onClose();
      }),
    };
  }

  async #startTurn(prompt: string): Promise<void> {
    const response = await this.#transport.request<{ turn: { id: string } }>('turn/start', {
      threadId: this.#threadId,
      input: [{ type: 'text', text: prompt }],
    });
    this.#turnId = response.turn.id;
  }

  async interrupt(): Promise<boolean> {
    // Settle the turn locally *before* talking to the engine, and never await
    // the engine's reply. Stopping must not depend on the daemon co-operating:
    // if it is wedged, unresponsive, or already gone, awaiting `turn/interrupt`
    // would hang the user's stop command. `settleTurn` is idempotent, so a real
    // `turn/completed` arriving later remains harmless.
    this.#settleTurn?.({ status: 'interrupted' });

    if (this.#closed || !this.#turnId) return false;

    // Best-effort: ask the engine to stop too, so it does not keep burning
    // tokens on work nobody will read.
    void this.#transport
      .request('turn/interrupt', { threadId: this.#threadId, turnId: this.#turnId })
      .catch(() => undefined);
    return true;
  }

  /**
   * Called when the transport closes for any reason.
   *
   * An explicit `close()` means the user stopped the run, so the turn is
   * interrupted. Any other close means the daemon died mid-turn, which is an
   * observable failure. Automatic daemon restart is O4 work.
   */
  handleTransportClosed(reason: string): void {
    this.#settleTurn?.(
      this.#closed
        ? { status: 'interrupted' }
        : { status: 'failed', message: `codex app-server closed unexpectedly: ${reason}` },
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#settleTurn?.({ status: 'interrupted' });
    this.#transport.close();
    this.#process.kill('SIGTERM');
  }
}
