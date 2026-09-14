/**
 * The run seam's Task linkage (#28).
 *
 * A durable Task advances through several sequential `AgentRun`s, but the
 * orchestrator that owns runs must not learn the Task domain model. These two
 * small interfaces are the whole seam:
 *
 * - `TaskContextProvider` is how a Task run's prompt is assembled from the Task
 *   and its prior run summaries, and how the admitted run is linked into the
 *   Task's run sequence. The orchestrator calls it; it never assembles Task
 *   context itself.
 * - `TaskRunObserver` is how a Task run's settlement is reported back so the Task
 *   can record a summary and advance its state.
 *
 * Both are optional on `RunOrchestratorOptions`, so a one-round-only build (and
 * every run test that never names a Task) is unchanged. Because the dependency is
 * one-way — the run layer knows two method shapes, the Task service knows the run
 * layer — the Message lifecycle and the Task lifecycle stay independent rather
 * than one wrapping the other.
 */

import type { AgentRun } from './model.ts';

/** How the run seam assembles and records a Task run. */
export interface TaskContextProvider {
  /**
   * Render the prompt a Task run is presented with.
   *
   * The returned text contains the Task goal, its constraints, and the curated
   * summaries of prior runs — never a prior run's raw events. Rejects when the
   * Task is unknown, which the orchestrator turns into an explicit failed run
   * rather than a run with no Task context.
   */
  prompt(input: { readonly taskId: string; readonly prompt: string }): Promise<string>;

  /** Link an admitted run into its Task's run sequence. Idempotent per run id. */
  link(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly agentId: string;
  }): Promise<void>;
}

/**
 * Told when a Task-linked run settles, so the Task can record a summary and
 * advance its state. Errors are isolated by the orchestrator: a Task bookkeeping
 * failure must not change the run's own terminal state.
 */
export type TaskRunObserver = (input: {
  readonly taskId: string;
  readonly run: AgentRun;
}) => Promise<void> | void;
