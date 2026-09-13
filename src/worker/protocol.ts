import type { AgentRunEvent, EngineTurnResult, StreamingGranularity } from '../engine/port.ts';

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
} as const;

export const WORKER_NOTIFICATIONS = {
  /** One run event, in order, for a turn in flight. */
  event: 'turn/event',
  /** A turn's terminal result. Always sent after that turn's events. */
  settled: 'turn/settled',
} as const;

export interface WorkerEngineDescription {
  readonly id: string;
  readonly streaming: StreamingGranularity;
  readonly supportsInterrupt: boolean;
}

export interface WorkerInfo {
  readonly pid: number;
  /** The environment instance this worker serves. */
  readonly environmentInstanceId: string;
  readonly engines: readonly WorkerEngineDescription[];
}

export interface StartSessionParams {
  /** Which engine the worker should host for this session. */
  readonly engine: string;
  readonly agentId: string;
  readonly workingDirectory: string;
  readonly instructions?: string;
}

export interface StartSessionResult {
  readonly sessionId: string;
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
}
