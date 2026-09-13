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

/** How much detail an adapter can deliver while a run is still in progress. */
export type StreamingGranularity = 'incremental' | 'turn' | 'none';

export interface EngineCapabilities {
  /** What the adapter promises to emit before the run finishes. */
  readonly streaming: StreamingGranularity;
  /** Whether the adapter can interrupt a run that is already in progress. */
  readonly supportsInterrupt: boolean;
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
  /** Standing instructions assembled by the core, if the adapter accepts them. */
  readonly instructions?: string;
}

export interface EngineSession {
  /** The adapter's session key, so the core can resume rather than re-derive. */
  readonly sessionId: string;
  /** Send one prompt and observe its events. Resolves when the turn ends. */
  run(prompt: string): EngineTurn;
  /** Interrupt the in-progress turn. Returns whether an interrupt was possible. */
  interrupt(): Promise<boolean>;
  /** Terminate the session and any process it supervises. */
  close(): Promise<void>;
}

export interface EngineTurn {
  readonly events: AsyncIterable<AgentRunEvent>;
  /** The turn's terminal text, once the turn settles. */
  readonly completion: Promise<EngineTurnResult>;
}

export type EngineTurnResult =
  | { readonly status: 'completed'; readonly text: string }
  | { readonly status: 'interrupted' }
  | { readonly status: 'failed'; readonly message: string };

export interface EngineAdapter {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  /** Establish a session. Readiness is the adapter's responsibility. */
  startSession(request: StartSessionRequest): Promise<EngineSession>;
}

export class EngineStartError extends Error {
  override readonly name = 'EngineStartError';
}
