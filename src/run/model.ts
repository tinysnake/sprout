import type { AgentRunEvent, EngineTurnResult } from '../engine/port.ts';

/** The observable lifecycle of one agent run. */
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

/**
 * One bounded activation of an agent, as the core and the Web client see it.
 *
 * `events` is the run's progress record. It is the system of record for what
 * happened, which is why an engine that loses its own partial output on
 * interrupt (see `agy` in #7) costs Sprout nothing: the events it already
 * emitted are durable here.
 */
export interface AgentRun {
  readonly id: string;
  readonly agentId: string;
  readonly prompt: string;
  /**
   * The environment instance this run actually used, resolved from the agent's
   * project at submission. Persisted so the choice survives a restart.
   */
  readonly environmentInstanceId: string;
  /** The project whose environment set produced `environmentInstanceId`. */
  readonly projectId?: string;
  readonly status: AgentRunStatus;
  readonly events: readonly AgentRunEvent[];
  readonly leaseId?: string;
  readonly failure?: string;
  readonly result?: EngineTurnResult;
  readonly createdAt: number;
  readonly completedAt?: number;
}

export type RunObserver = (run: AgentRun) => void;
