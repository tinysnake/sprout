/**
 * The run seam every engine adapter satisfies.
 *
 * Shape follows Cumora's `EngineAdapter`/`EngineSession` (MIT) as recommended by
 * #7, rather than a provider-shaped interface invented locally.
 *
 * Nothing here mentions JSON-RPC, stdio, or argv: those are implementation
 * details of a specific adapter, not facts the core may depend on. Streaming
 * granularity is a declared capability (ADR-0001), never an assumed guarantee.
 */

/**
 * How an adapter delivered standing instructions into a working directory, or
 * why it did not.
 *
 * Declared by `working-directory` adapters so the fact that a run's contract did
 * not reach the engine — because the directory's `AGENTS.md` is a user's file
 * Sprout refused to replace — is reportable rather than silent.
 */
export type ContractDeliveryMechanism =
  | 'agents.md'
  | 'sprout-contract-file'
  | 'skipped-user-owned';

export interface ContractDelivery {
  readonly mechanism: ContractDeliveryMechanism;
  readonly path?: string;
  readonly agentsMdSkipped?: 'user-owned';
}

/** How much detail an adapter can deliver while a run is still in progress. */
export type StreamingGranularity = 'incremental' | 'turn' | 'none';

/**
 * How an adapter can deliver standing instructions to its engine.
 *
 * The channels are not interchangeable and are a measured per-engine fact
 * (#14, #15, #19):
 *
 * - `out-of-band` — the engine has a system-prompt surface, so instructions are
 *   handed to it separately from the prompt. Codex (`baseInstructions`) and Pi
 *   (`--append-system-prompt`) do.
 * - `working-directory` — the engine has no system-prompt surface and reads
 *   instructions from a file in the working directory instead. `agy` reads the
 *   Sprout-owned contract file the adapter writes; nothing is injected into argv.
 * - `none` — the adapter knows of no standing-instructions surface for this
 *   engine, so the contract cannot be delivered without changing the engine or
 *   injecting it into every prompt. Declaring `none` is honest; the core then
 *   knows the contract reaches that engine through a different mechanism (or not
 *   at all) rather than assuming every engine takes instructions the same way.
 */
export type StandingInstructionsChannel = 'out-of-band' | 'working-directory' | 'none';

export interface EngineCapabilities {
  /** What the adapter promises to emit before the run finishes. */
  readonly streaming: StreamingGranularity;
  /** Whether the adapter can interrupt a run that is already in progress. */
  readonly supportsInterrupt: boolean;
  /**
   * How this adapter delivers the standing instructions a run is handed.
   *
   * Declared rather than assumed: the core assembles one project contract and
   * passes it as `instructions` on every run, and each adapter delivers it
   * through the surface its engine actually has.
   */
  readonly standingInstructions: StandingInstructionsChannel;
}

/**
 * A progress fact an adapter observed. Adapters translate provider events into
 * these; the core never learns what produced them.
 */
export type AgentRunEvent =
  | { readonly type: 'message'; readonly text: string; readonly final: boolean }
  | { readonly type: 'tool-call'; readonly name: string; readonly detail: string }
  | { readonly type: 'tool-output'; readonly text: string }
  | { readonly type: 'notice'; readonly text: string };

export interface StartSessionRequest {
  /** Sprout-owned agent identity. Never derived from the engine installation. */
  readonly agentId: string;
  /** The working directory inside the environment the run executes in. */
  readonly workingDirectory: string;
  /**
   * Standing instructions assembled by the core, if the adapter accepts them.
   *
   * This is the project contract. An `out-of-band` adapter passes it to the
   * engine's own system-prompt surface; a `working-directory` adapter writes it
   * to the Sprout-owned contract file so the engine discovers it from the
   * directory the run executes in.
   */
  readonly instructions?: string;
  /**
   * A previously persisted engine session key to resume, when the core has one
   * for this agent, engine, environment instance, and working directory.
   *
   * This is the one resume input the core supplies. An adapter passes it to the
   * engine's own resume path; an engine that cannot reuse a supplied key (or
   * refuses a stale one) behaves as the engine documents (#19). Sprout never
   * assumes resumption succeeded: it persists the key the run actually used.
   */
  readonly resumeSessionKey?: string;
}

export interface EngineSession {
  /** The adapter's session key, so the core can resume rather than re-derive. */
  readonly sessionId: string;
  /**
   * The engine-native key this session is actually using, once it is known.
   *
   * For an engine whose key Sprout chooses (Pi) this equals `sessionId`. For an
   * engine that assigns its own key (Codex, `agy`, `opencode`) it is only known
   * after the engine reports it, so the core reads it after a turn settles
   * rather than at construction. This — not `sessionId`, which may be a
   * Sprout-local handle — is what the core persists for continuation.
   *
   * `undefined` means the engine never reported a key for this session, so
   * there is nothing worth persisting.
   */
  readonly engineSessionKey: string | undefined;
  /** Send one prompt and observe its events. Resolves when the turn ends. */
  run(prompt: string): EngineTurn;
  /** Interrupt the in-progress turn. Returns whether an interrupt was possible. */
  interrupt(): Promise<boolean>;
  /** Terminate the session and any process it supervises. */
  close(): Promise<void>;
  /**
   * How standing instructions reached this run's working directory, when the
   * adapter's channel is `working-directory`.
   *
   * Absent for an `out-of-band` adapter (delivery is the engine call itself) and
   * for a run handed no instructions. Present so a skipped or fallback delivery
   * is visible above the worker boundary.
   */
  readonly contractDelivery?: ContractDelivery | undefined;
}

export interface EngineTurn {
  readonly events: AsyncIterable<AgentRunEvent>;
  /** The turn's terminal text, once the turn settles. */
  readonly completion: Promise<EngineTurnResult>;
}

export type EngineTurnResult =
  | { readonly status: 'completed'; readonly text: string }
  | { readonly status: 'interrupted' }
  | {
      readonly status: 'failed';
      readonly message: string;
      /**
       * The engine refused the supplied `resumeSessionKey` and did no work.
       *
       * Set only when the failure is a rejected resume — the conversation the
       * core asked to continue does not exist in the engine — so the core can
       * safely forget the key and retry once from a fresh session. A failure
       * for any other reason (missing binary, authentication, a provider error
       * on a *valid* resume) leaves this unset, so an unrelated failure is
       * never mistaken for a stale key and never discards a usable key.
       */
      readonly resumeRefused?: boolean;
    };

export interface EngineAdapter {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  /** Establish a session. Readiness is the adapter's responsibility. */
  startSession(request: StartSessionRequest): Promise<EngineSession>;
}

export class EngineStartError extends Error {
  override readonly name: string = 'EngineStartError';
}

/**
 * Raised by `startSession` when the engine explicitly refused the supplied
 * `resumeSessionKey` and performed no work.
 *
 * This is the neutral classification of a resume refusal at the run seam.
 * Adapters throw it for their engine's rejected-resume condition (Codex's
 * `no rollout found for thread id …`, a malformed key), and the core retries
 * from a fresh session only for this error. Every other start failure — a failed
 * initialization, a missing binary, an authentication failure — is reported
 * unchanged, so the core never mistakes it for a stale key.
 */
export class EngineResumeRefusedError extends EngineStartError {
  override readonly name: string = 'EngineResumeRefusedError';
  /** The key the engine refused. */
  readonly sessionKey: string;

  constructor(sessionKey: string, message: string) {
    super(message);
    this.sessionKey = sessionKey;
  }
}
