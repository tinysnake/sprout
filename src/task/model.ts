/**
 * The durable Task vocabulary (ticket #28, O6 exit criterion 2).
 *
 * A **Task** is a durable unit of multi-run or automated work that preserves its
 * goal, state, constraints, and results across agent runs (`CONTEXT.md`). It is
 * deliberately **not** a Message and not an agent run:
 *
 * - A **Message** (`src/collaboration/model.ts`) is one piece of conversation. It
 *   is completed by a single agent run and carries no goal, status, or run
 *   history. A Task is multi-run, stateful work. Neither wraps or subclasses the
 *   other; the two lifecycles only meet at an `AgentRun`.
 * - An **Agent run** is one bounded activation. A Task *links* many of them, in
 *   order, and is the thing that accumulates context across them.
 *
 * This module lives entirely in the core. Nothing here is depended on by the
 * engine port or the environment-worker protocol (ADR-0003); persistence is
 * behind `TaskStore` (ADR-0002), with SQLite as the M1 backend.
 */

import type { EnvironmentPreference } from '../environment/model.ts';

/**
 * The durable lifecycle of one Task.
 *
 * `todo` and `blocked` are both *advanceable*: starting work from either moves
 * the Task to `in-progress`. The terminal states are `done`, `failed`, and
 * `cancelled`; a terminal Task is never silently reopened by advancement.
 */
export type TaskStatus =
  | 'todo'
  | 'in-progress'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

/** Every status, for validation and for the store's SQL CHECK arguments. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'todo',
  'in-progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
];

/**
 * A durable unit of multi-run work.
 *
 * The minimum fields that make a Task's progress reconstructible across runs and
 * restarts: what it is, what it must achieve, what it must respect, where it is,
 * which agent owns it, and which environment it prefers.
 *
 * `constraints` is a string array rather than a free string so a constraint can
 * be stated and read individually; an empty array means "no declared
 * constraints". `environmentPreference` is optional: absent means the Task leaves
 * environment choice entirely to project matching.
 */
export interface Task {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** What the Task must achieve, preserved across every run. */
  readonly goal: string;
  /** What each run must respect while pursuing the goal. */
  readonly constraints: readonly string[];
  readonly status: TaskStatus;
  /** The agent that owns advancing this Task, when one is assigned. */
  readonly assignedAgentId?: string;
  /** An explicitly selected environment, taking priority over project matching. */
  readonly environmentPreference?: EnvironmentPreference;
  /** Why the Task is `blocked`, when it is. */
  readonly blockerReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

/**
 * A Task-level summary of one linked run.
 *
 * Written when the run settles so later runs can be assembled context from
 * *curated* summaries rather than replaying the run's raw `events`. The summary
 * is fact-form: a status plus the run's bounded final text or failure, never a
 * transcript or any agent's private reasoning.
 */
export interface TaskRunSummary {
  readonly runId: string;
  readonly agentId: string;
  /** The run's terminal status at the time the summary was recorded. */
  readonly status: 'completed' | 'failed' | 'interrupted';
  /** The bounded fact-form outcome; empty when the run produced no text. */
  readonly summary: string;
  readonly recordedAt: number;
}

/** One Task linked to one run, in Task order. */
export interface TaskRunLink {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  /** Position in the Task's run sequence, starting at 1. */
  readonly sequence: number;
  readonly linkedAt: number;
  /**
   * The summary recorded for this run once it settled.
   *
   * Absent while the run is still in flight: a summary is only ever written for a
   * terminal run, so "no summary" means "this run has not settled yet".
   */
  readonly summary?: TaskRunSummary;
}

/**
 * A Task together with its ordered run history.
 *
 * This is the read shape `GET /api/tasks/:id` returns: the Task itself plus the
 * runs it advanced through, in sequence, so a human can see the multi-run
 * progression without querying run records separately.
 */
export interface TaskWithRuns {
  readonly task: Task;
  readonly runs: readonly TaskRunLink[];
}

/** The terminal statuses a Task can reach. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/** Whether advancing a Task from `status` is permitted. */
export function canAdvanceTask(status: TaskStatus): boolean {
  return status === 'todo' || status === 'blocked' || status === 'in-progress';
}
