import type { AgentRunEvent, EngineTurnResult, StandingInstructionsChannel, StreamingGranularity } from '../engine/port.ts';

/**
 * The core-to-worker protocol.
 *
 * This protocol expresses the **engine port**, not any engine's own protocol: it
 * has sessions, turns, run events, interrupt, and close. Codex's `app-server`
 * methods, argv, and file paths must never appear here, because the core is not
 * allowed to learn how any environment starts a process (ADR-0003).
 *
 * Carried as line-framed JSON-RPC. Only the carrier differs per environment — a
 * loopback TCP connection for a local machine, the container runtime's exec
 * channel for a container — so the protocol and its semantics are identical
 * everywhere and there is no local-versus-network special case.
 */

export const WORKER_METHODS = {
  /** Identify the worker and the engines it can host. */
  info: 'worker/info',
  /** Create an engine session for one run. */
  startSession: 'session/start',
  /** Begin one turn on an existing session. */
  run: 'session/run',
  /** Ask the in-flight turn to stop. */
  interrupt: 'session/interrupt',
  /** Tear down a session and its engine process. */
  close: 'session/close',
  /** Materialize one Task's owned context below its Project workspace. */
  prepareTaskContext: 'context/prepare',
  /** Verify and recycle one owned Task context. */
  recycleTaskContext: 'context/recycle',
  /** Validate or prepare one Project workspace selection (#93). */
  validateWorkspace: 'workspace/validate',
} as const;

export const WORKER_NOTIFICATIONS = {
  /** One run event, in order, for a turn in flight. */
  event: 'turn/event',
  /** A turn's terminal result. Always sent after that turn's events. */
  settled: 'turn/settled',
} as const;

/**
 * The Worker protocol version this build speaks.
 *
 * Reported on `worker/info` so the core can derive compatibility without
 * guessing. It is a Sprout protocol fact, not an engine fact (ADR-0003).
 */
export const WORKER_PROTOCOL_VERSION = '2';

/**
 * One engine's neutral readiness fact, as the Environment Worker sees it.
 *
 * These are the sanitized, portable facts ADR-0009 and the enrollment research
 * require: installation, authentication readiness, and available models. No
 * token, cookie, auth file, account identifier, or raw stderr has a field here.
 */
export interface WorkerEngineReadinessFact {
  readonly engine: string;
  /** Whether the engine's executable was located on this Environment host. */
  readonly installed: boolean;
  readonly readiness: 'ready' | 'login-required' | 'missing' | 'unknown';
  readonly modelAvailability: 'available' | 'none' | 'unknown';
  readonly models: readonly string[];
}

/**
 * The Worker's neutral readiness projection.
 *
 * Additive to `worker/info`; the method and its required fields are unchanged.
 * A Worker that does not implement this simply omits it, and the core records
 * `unknown` rather than inventing a value.
 */
export interface WorkerReadinessFacts {
  readonly protocolVersion: string;
  readonly engines: readonly WorkerEngineReadinessFact[];
}

/**
 * JSON-RPC error codes private to the worker protocol.
 *
 * `resumeRefused` is the neutral classification of an engine's rejected resume,
 * carried across the worker boundary so the core can retry a fresh session only
 * for that failure. It is a protocol fact, not a Codex or `opencode` fact: the
 * core learns "the engine refused this key" without learning which engine said
 * it or why.
 */
export const WORKER_ERROR_CODES = {
  /** The engine explicitly refused the supplied resume key and did no work. */
  resumeRefused: -32_610,
} as const;

export interface WorkerEngineDescription {
  readonly id: string;
  readonly streaming: StreamingGranularity;
  readonly supportsInterrupt: boolean;
  /**
   * How this engine's adapter delivers standing instructions.
   *
   * Carried across the worker boundary so the core can state per run how the
   * assembled project contract reached the engine, without learning any engine
   * detail (ADR-0003): the channel is a neutral fact, not a Codex or `agy` one.
   */
  readonly standingInstructions: StandingInstructionsChannel;
}

export interface WorkerInfo {
  readonly pid: number;
  /** The environment instance this worker serves. */
  readonly environmentInstanceId: string;
  readonly engines: readonly WorkerEngineDescription[];
  /** Neutral protocol and engine readiness, when this Worker can report it. */
  readonly readiness?: WorkerReadinessFacts;
}

export interface StartSessionParams {
  /** Which engine the worker should host for this session. */
  readonly engine: string;
  readonly agentId: string;
  readonly workingDirectory: string;
  /** The engine-neutral model this session should use, when configured. */
  readonly model?: string;
  /** The engine-neutral reasoning effort this session should use, when configured. */
  readonly effort?: string;
  readonly projectWorkspaceId?: string;
  /**
   * Worker-root-relative registered repository location, when the Project has
   * one. Must be relative: an absolute location is refused at this boundary,
   * never resolved (#93, ADR-0009).
   */
  readonly projectWorkspacePath?: string;
  readonly instructions?: string;
  /**
   * The engine-native key of the conversation this session should continue.
   *
   * This is the resume-input seam of the engine port, carried unchanged to the
   * engine adapter inside the environment. The core decides which key belongs to
   * this run; the worker does not look one up itself.
   */
  readonly resumeSessionKey?: string;
}

/** Portable facts the Worker renders into Sprout-owned context files. */
export interface TaskContextMaterialization {
  readonly projectId: string;
  /** Worker-root-relative registered repository location, when the Project has one. */
  readonly projectWorkspacePath?: string;
  readonly projectGoal: string;
  readonly projectRules: readonly string[];
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskGoal: string;
  readonly taskConstraints: readonly string[];
  readonly taskStatus: string;
  readonly priorRunSummaries: string;
  readonly agentId: string;
  readonly responsibilities: readonly string[];
  readonly collaborationInstructions: string;
  readonly environmentInstanceId: string;
  readonly environmentLeaseId: string;
}

export interface PrepareTaskContextResult {
  /** Relative paths only: portable, deterministic bootstrap text for engines. */
  readonly bootstrapInstructions: string;
}

export interface RecycleTaskContextParams {
  readonly projectId: string;
  /** Worker-root-relative registered repository location, when the Project has one. */
  readonly projectWorkspacePath?: string;
  readonly taskId: string;
  readonly environmentInstanceId: string;
  readonly environmentLeaseId: string;
}

/**
 * One Project workspace selection the core asks the Worker to validate.
 *
 * The selection is portable: the Worker-managed default, or a relative location
 * beneath the Worker's configured workspace root. The absolute location never
 * crosses this boundary in either direction.
 */
export interface ValidateWorkspaceParams {
  readonly projectId: string;
  readonly environmentInstanceId: string;
  readonly kind: 'default' | 'relative';
  /** Worker-root-relative location; present only for a `relative` selection. */
  readonly path?: string;
}

/**
 * The portable workspace facts the Worker returns after validating or preparing
 * a selection. `workspaceId` is an opaque, host-derived identity, never a path.
 */
export interface ValidateWorkspaceResult {
  readonly workspaceId: string;
  readonly kind: 'default' | 'relative';
  /** Worker-root-relative location, when the selection named one. */
  readonly path?: string;
}

export interface StartSessionResult {
  readonly sessionId: string;
  /**
   * The engine-native key the adapter is using, when it knows one.
   *
   * `opencode` reports its id on frames and `agy` in its `init` frame, so their
   * keys may be unknown at session start. The core reads the key after the turn
   * settles through the session it already holds, so this field is the key known
   * at start time (Pi, Codex) and `undefined` otherwise.
   */
  readonly engineSessionKey?: string;
}

export interface RunParams {
  readonly sessionId: string;
  readonly prompt: string;
}

export interface RunResult {
  readonly turnId: string;
}

export interface InterruptParams {
  readonly sessionId: string;
}

export interface InterruptResult {
  readonly interrupted: boolean;
}

export interface CloseParams {
  readonly sessionId: string;
}

export interface TurnEventParams {
  readonly sessionId: string;
  readonly turnId: string;
  readonly event: AgentRunEvent;
}

export interface TurnSettledParams {
  readonly sessionId: string;
  readonly turnId: string;
  readonly result: EngineTurnResult;
  /**
   * The engine-native session key in effect once the turn settled.
   *
   * Engines that assign their own key (`agy`, `opencode`) only reveal it on the
   * stream, so the core cannot read it at session start; this is where it learns
   * the key to persist. It travels with the settlement rather than the session
   * start so it is never stale relative to the turn it describes.
   */
  readonly engineSessionKey?: string;
}
