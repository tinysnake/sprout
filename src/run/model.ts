import type { AgentRunEvent, EngineTurnResult, TokenUsage, DetailedTokenDimensions } from '../engine/port.ts';
import type { AgentWorkOption } from '../agent/model.ts';
import type { WorkspaceSelectionKind } from '../project/access.ts';
import type { ExecutionPlacement, SessionKeyScope } from '../execution-placement.ts';

export type { TokenUsage, DetailedTokenDimensions } from '../engine/port.ts';

/**
 * The durable workspace facts one run was admitted under (#93, ADR-0008).
 *
 * Captured from the Project's access record at admission and never re-derived:
 * after a later workspace change or a restart, the run's history still names
 * the binding it actually used. `bindingId` and `workspaceId` are present for
 * an authority-recorded binding; a legacy configured Project workspace (which
 * has no binding identity) projects only its kind and relative location.
 */
export interface RunWorkspaceBinding {
  readonly bindingId?: string;
  readonly workspaceId?: string;
  readonly kind: WorkspaceSelectionKind;
  /** Worker-root-relative location, when the workspace named one. */
  readonly path?: string;
}

/** The observable lifecycle of one agent run. */
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';

/** Sprout's trusted classification at settlement, never inferred from failure text. */
export type RunFailureClass = 'admission' | 'environment' | 'restart' | 'execution';
/** A product-owned reason for an intentional Chat interruption. */
export type RunInterruptionReason = 'human-stop';

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
  /** Immutable placement selected when this run was admitted. Legacy rows are Environment-hosted. */
  readonly executionMode?: import('../execution-mode.ts').ExecutionMode;
  /** Opaque local Engine host profile identity for Host-run attribution and continuation partitioning. */
  readonly engineHostProfileId?: string;
  /**
   * The environment instance this run actually used, resolved from the agent's
   * project at submission. Persisted so the choice survives a restart.
   */
  readonly environmentInstanceId: string;
  /**
   * The project whose environment set produced `environmentInstanceId`.
   *
   * A run that failed before environment resolution records the Project scope
   * its submission named instead (#181), so an environment-disconnected
   * admission failure still durably belongs to a Project.
   */
  readonly projectId?: string;
  /**
   * The durable Task this run advances, when it is a Task run (#28).
   *
   * Absent for a one-round Message run. A Task is not a Message and a Message is
   * not a Task: this link is the only place the two lifecycles meet, and it never
   * makes one wrap the other.
   */
  readonly taskId?: string;
  /** Authorized continuation scope for a standalone run, when one exists. */
  readonly sessionKeyScope?: SessionKeyScope;
  /** The process mode and actual engine host/profile recorded at admission. */
  readonly executionPlacement?: ExecutionPlacement;
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
   * The Project workspace binding this run was admitted under (#93).
   *
   * A historical fact, like `workOption`: resolved once from the durable access
   * record before the engine accepted the work, persisted with the run, and
   * never revisited. A workspace change afterwards appends a new binding for
   * future runs; it cannot rewrite what this run used.
   */
  readonly workspaceBinding?: RunWorkspaceBinding;
  /**
   * The hand-off context attached to this run's input, when there was one.
   *
   * Absent means no hand-off was attached — either the run continued on the same
   * environment instance as the previous run (ADR-0004 session continuation), or
   * there was no prior run to summarise.
   */
  readonly handOff?: RunHandOff;
  /**
   * The original run this run is the bounded reconnect retry of (#181).
   *
   * Present on exactly the one linked retry run and absent on every original,
   * so "has this run already used its one retry?" is a durable fact on the run
   * record itself and a retry run can never re-enter the retry set.
   */
  readonly retryOfRunId?: string;
  readonly leaseId?: string;
  readonly failure?: string;
  /** Absent on legacy rows; consumers treat absence as execution. */
  readonly failureClass?: RunFailureClass;
  /** Product-owned reason when a Human stops a one-round run from Chat. */
  readonly interruptionReason?: RunInterruptionReason;
  readonly result?: EngineTurnResult;
  /** Distinct machine-evidence history; never silently replaces a run's interrupted outcome. */
  readonly recoverySettlement?: { readonly status: 'completed' | 'failed' | 'interrupted' | 'stopped'; readonly eventCount: number };
  /** At-least-once recovered frames with durable turn/sequence identity. */
  readonly recoveredEvents?: readonly { readonly turnId: string; readonly sequence: number; readonly event: AgentRunEvent }[];
  /** Provider-reported consumption for this run, when the engine exposes it. */
  readonly tokenUsage?: TokenUsage;
  /** Detailed token dimensions preserving input, cached, cache write, output, reasoning detail. */
  readonly detailedTokens?: DetailedTokenDimensions;
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
