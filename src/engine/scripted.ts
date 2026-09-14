import type {
  AgentRunEvent,
  EngineAdapter,
  EngineSession,
  EngineTurn,
  EngineTurnResult,
  StartSessionRequest,
} from './port.ts';
import { EngineResumeRefusedError } from './port.ts';

/**
 * A controlled engine adapter used by tests.
 *
 * It exists so the core's orchestration can be verified without launching a real
 * engine, which is a requirement on the run seam rather than a convenience.
 * Each session replays one scripted turn.
 */
export interface ScriptedTurn {
  readonly events: readonly AgentRunEvent[];
  readonly result: EngineTurnResult;
  /** How long the turn stays open before settling. */
  readonly settleAfterMs?: number;
}

export interface ScriptedAdapterOptions {
  readonly turns: readonly ScriptedTurn[];
  /** Records every request so tests can assert ordering against other seams. */
  readonly onStartSession?: (request: StartSessionRequest) => void;
  readonly onInterrupt?: () => void;
  /**
   * When set, `startSession` rejects with this message as a plain failure.
   *
   * This models an engine that cannot start at all — a missing binary, a failed
   * initialization, an authentication failure — as opposed to one that refused a
   * supplied resume key. A plain start failure must never be retried fresh and
   * must never delete a stored key.
   */
  readonly failStart?: string;
  /** When set, `startSession` rejects as an explicit resume refusal. */
  readonly refuseStartKey?: string;
  /**
   * Engine session keys this fake accepts as resumable.
   *
   * Omit to accept any supplied `resumeSessionKey` (a healthy resume). When set,
   * a key outside this list is stale, and the fake behaves as
   * `staleResumeKey` says: start a fresh session (`'fresh'`, the default, which
   * models Pi and `agy`'s documented soft fallback), reject the start as a
   * resume refusal (`'fail'`, which models Codex's `thread/resume` hard
   * failure in #19), or fail the first turn as a resume refusal without
   * emitting events (`'fail-turn'`, which models `opencode` exiting 1 on a
   * stale `--session`).
   */
  readonly knownSessionKeys?: readonly string[];
  readonly staleResumeKey?: 'fresh' | 'fail' | 'fail-turn';
}

export class ScriptedEngineAdapter implements EngineAdapter {
  readonly id = 'scripted';
  readonly capabilities = { streaming: 'incremental', supportsInterrupt: true } as const;
  readonly requests: StartSessionRequest[] = [];
  readonly sessions: ScriptedEngineSession[] = [];
  readonly #options: ScriptedAdapterOptions;
  #next = 0;
  #keyCounter = 0;

  constructor(options: ScriptedAdapterOptions) {
    this.#options = options;
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    this.#options.onStartSession?.(request);
    this.requests.push(request);
    if (this.#options.refuseStartKey !== undefined) {
      throw new EngineResumeRefusedError(
        request.resumeSessionKey ?? this.#options.refuseStartKey,
        `unknown session: ${this.#options.refuseStartKey}`,
      );
    }
    if (this.#options.failStart !== undefined) {
      throw new Error(this.#options.failStart);
    }
    const turn = this.#options.turns[this.#next] ?? this.#options.turns.at(-1);
    this.#next += 1;
    if (!turn) throw new Error('scripted adapter has no turns');

    const requested = request.resumeSessionKey;
    const known = this.#options.knownSessionKeys;
    const stale = requested !== undefined && known !== undefined && !known.includes(requested);
    if (stale && this.#options.staleResumeKey === 'fail') {
      throw new EngineResumeRefusedError(requested, `unknown session: ${requested}`);
    }
    // A healthy resume reuses the supplied key; a stale key (or no key) starts
    // a fresh engine session with an engine-assigned key.
    const engineSessionKey =
      requested !== undefined && !stale ? requested : `scripted-key-${++this.#keyCounter}`;
    // `fail-turn` models opencode: the session starts, but the stale key makes
    // the turn fail as a resume refusal without the engine ever doing work.
    const failFirstTurn = stale && this.#options.staleResumeKey === 'fail-turn';

    const session = new ScriptedEngineSession(
      `scripted-session-${this.#next}`,
      engineSessionKey,
      failFirstTurn
        ? {
            events: [],
            result: {
              status: 'failed',
              message: `unknown session: ${requested}`,
              resumeRefused: true,
            },
          }
        : turn,
      this.#options.onInterrupt,
    );
    this.sessions.push(session);
    return session;
  }
}

export class ScriptedEngineSession implements EngineSession {
  readonly sessionId: string;
  readonly engineSessionKey: string;
  readonly #turn: ScriptedTurn;
  readonly #onInterrupt: (() => void) | undefined;
  #settled = false;
  #interrupted = false;
  #resolveCompletion: ((result: EngineTurnResult) => void) | undefined;

  constructor(
    sessionId: string,
    engineSessionKey: string,
    turn: ScriptedTurn,
    onInterrupt?: () => void,
  ) {
    this.sessionId = sessionId;
    this.engineSessionKey = engineSessionKey;
    this.#turn = turn;
    this.#onInterrupt = onInterrupt;
  }

  run(_prompt: string): EngineTurn {
    const self = this;
    const completion = new Promise<EngineTurnResult>((resolve) => {
      self.#resolveCompletion = resolve;
      const timer = setTimeout(() => {
        if (!self.#settled) self.#settle(self.#turn.result);
      }, this.#turn.settleAfterMs ?? 0);
      timer.unref?.();
    });

    async function* events(): AsyncIterable<AgentRunEvent> {
      for (const event of self.#turn.events) {
        yield event;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await completion.catch(() => undefined);
    }

    return { events: events(), completion };
  }

  async interrupt(): Promise<boolean> {
    if (this.#settled) return false;
    this.#interrupted = true;
    this.#onInterrupt?.();
    this.#settle({ status: 'interrupted' });
    return true;
  }

  async close(): Promise<void> {
    if (!this.#settled) this.#settle({ status: 'interrupted' });
  }

  #settle(result: EngineTurnResult): void {
    this.#settled = true;
    this.#resolveCompletion?.(this.#interrupted ? { status: 'interrupted' } : result);
    this.#resolveCompletion = undefined;
  }
}
