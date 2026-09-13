import type {
  AgentRunEvent,
  EngineAdapter,
  EngineSession,
  EngineTurn,
  EngineTurnResult,
  StartSessionRequest,
} from './port.ts';

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
  /** When set, `startSession` rejects with this message. */
  readonly failStart?: string;
}

export class ScriptedEngineAdapter implements EngineAdapter {
  readonly id = 'scripted';
  readonly capabilities = { streaming: 'incremental', supportsInterrupt: true } as const;
  readonly requests: StartSessionRequest[] = [];
  readonly sessions: ScriptedEngineSession[] = [];
  readonly #options: ScriptedAdapterOptions;
  #next = 0;

  constructor(options: ScriptedAdapterOptions) {
    this.#options = options;
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    this.#options.onStartSession?.(request);
    this.requests.push(request);
    if (this.#options.failStart !== undefined) {
      throw new Error(this.#options.failStart);
    }
    const turn = this.#options.turns[this.#next] ?? this.#options.turns.at(-1);
    this.#next += 1;
    if (!turn) throw new Error('scripted adapter has no turns');
    const session = new ScriptedEngineSession(
      `scripted-session-${this.#next}`,
      turn,
      this.#options.onInterrupt,
    );
    this.sessions.push(session);
    return session;
  }
}

export class ScriptedEngineSession implements EngineSession {
  readonly sessionId: string;
  readonly #turn: ScriptedTurn;
  readonly #onInterrupt: (() => void) | undefined;
  #settled = false;
  #interrupted = false;
  #resolveCompletion: ((result: EngineTurnResult) => void) | undefined;

  constructor(
    sessionId: string,
    turn: ScriptedTurn,
    onInterrupt?: () => void,
  ) {
    this.sessionId = sessionId;
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
