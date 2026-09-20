import type { AgentRunEvent, EngineTurnResult, TokenUsage } from '../engine/port.ts';
import type { AgentWorkOption } from '../agent/model.ts';

export type { TokenUsage } from '../engine/port.ts';

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
  /**
   * The durable Task this run advances, when it is a Task run (#28).
   *
   * Absent for a one-round Message run. A Task is not a Message and a Message is
   * not a Task: this link is the only place the two lifecycles meet, and it never
   * makes one wrap the other.
   */
  readonly taskId?: string;
  readonly status: AgentRunStatus;
  readonly events: readonly AgentRunEvent[];
  /**
   * The work option this run was admitted under (#90, ADR-0008).
   *
   * Chosen from the Agent's ordered options before any engine accepted the
   * work, against the resolved Environment's current facts, and never revisited
   * afterwards. Recorded with the run so the engine, work model, and effort it
   * actually used remain historically attributable.
   */
  readonly workOption?: AgentWorkOption;
  /**
   * The Agent configuration version this run was admitted under (#90).
   *
   * Together with `workOption` this is what makes every run's actual
   * configuration historically attributable: an older version is never
   * rewritten, so this number always resolves to the options the run saw.
   */
  readonly configurationVersion?: number;
  /**
   * The hand-off context attached to this run's input, when there was one.
   *
   * Absent means no hand-off was attached — either the run continued on the same
   * environment instance as the previous run (ADR-0004 session continuation), or
   * there was no prior run to summarise.
   */
  readonly handOff?: RunHandOff;
  readonly leaseId?: string;
  readonly failure?: string;
  readonly result?: EngineTurnResult;
  /** Provider-reported consumption for this run, when the engine exposes it. */
  readonly tokenUsage?: TokenUsage;
  readonly createdAt: number;
  readonly completedAt?: number;
}

/**
 * `replaySequence` is the durable write position assigned before notification.
 * It is transport metadata, not part of the AgentRun domain record.
 */
export type RunObserver = (run: AgentRun, replaySequence: number) => void;

/**
 * The fact-form context attached to a run that moved to another environment.
 *
 * Present on an `AgentRun` exactly when a hand-off was attached, so "was a
 * hand-off attached?" is answered by the persisted record rather than inferred.
 * The text is the deterministic summary produced by `hand-off.ts`; it never
 * contains another run's raw events or transcripts.
 */
export interface RunHandOff {
  /** The environment instance the agent's previous run used. */
  readonly previousEnvironmentInstanceId: string;
  /** The bounded, fact-form summary attached to this run's input. */
  readonly text: string;
  /** Which prior runs contributed a fact, so the hand-off is auditable. */
  readonly sourceRunIds: readonly string[];
}
