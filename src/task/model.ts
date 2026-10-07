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
 * the Task to `in-progress`. Status family and Task-group freeze behavior are
 * defined together in `TASK_STATUS_DATA`; `stopped` keeps live intent while its
 * Force Released Task group stays frozen until a Human resumes it.
 */
export const TASK_STATUS_DATA = {
  todo: { family: 'active-intent', freezeTaskGroup: false },
  'in-progress': { family: 'active-intent', freezeTaskGroup: false },
  blocked: { family: 'active-intent', freezeTaskGroup: false },
  done: { family: 'ended', freezeTaskGroup: true },
  failed: { family: 'ended', freezeTaskGroup: true },
  stopped: { family: 'active-intent', freezeTaskGroup: true },
  cancelled: { family: 'ended', freezeTaskGroup: true },
} as const satisfies Record<string, { readonly family: 'active-intent' | 'ended'; readonly freezeTaskGroup: boolean }>;

export type TaskStatus = keyof typeof TASK_STATUS_DATA;
type TaskStatusInFamily<Family extends 'active-intent' | 'ended'> = {
  [Status in TaskStatus]: typeof TASK_STATUS_DATA[Status]['family'] extends Family ? Status : never
}[TaskStatus];
export type ActiveIntentTaskStatus = TaskStatusInFamily<'active-intent'>;
export type EndedTaskStatus = TaskStatusInFamily<'ended'>;

/** Every status, for validation and for the store's SQL CHECK arguments. */
export const TASK_STATUSES: readonly TaskStatus[] = Object.keys(TASK_STATUS_DATA) as TaskStatus[];


/** The outer Task-held-environment lifecycle (#32), separate from Task progress. */
export type TaskEnvironmentLifecycleState =
  | 'beginning'
  | 'idle'
  | 'running'
  | 'blocked'
  | 'awaiting-validation'
  | 'ending'
  | 'recovery'
  | 'ended'
  | 'discarded';

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
export interface TaskActor {
  readonly memberId: string;
  readonly memberKind: 'human' | 'agent';
}

export type TaskPauseState = 'requested' | 'paused' | 'retry-required';

export type TaskBlockerResponsibility =
  | { readonly kind: 'human' | 'agent'; readonly memberId: string }
  | { readonly kind: 'external-condition'; readonly condition: string }
  | { readonly kind: 'recovery'; readonly mechanism: string };

/** A routable wait with an explicit owner, action, and next Task advancer. */
export interface TaskBlocker {
  readonly reason: string;
  readonly requiredAction: string;
  readonly responsible: TaskBlockerResponsibility;
  readonly nextAdvancer: TaskActor;
  readonly createdBy: TaskActor | { readonly memberKind: 'system'; readonly memberId: 'sprout' };
  readonly createdAt: number;
}

/** Fact-form completion evidence. No free-form reasoning or transcript field exists. */
export interface TaskCompletionClaim {
  readonly id: string;
  readonly contentVersion: number;
  readonly actor: TaskActor;
  /** Set when a Human submits on behalf of an Agent Task lead. */
  readonly substitutedFor?: TaskActor;
  readonly at: number;
  readonly outcomeSummary: string;
  readonly validationEvidence: readonly string[];
  readonly durableChanges: readonly string[];
  readonly limitations: readonly string[];
  readonly recommendedDisposition: 'complete' | 'continue';
}

export interface TaskContent {
  readonly title: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly validationCriteria: readonly string[];
  readonly lead: TaskActor;
}

export type TaskControlEvent =
  | { readonly action: 'content-revised'; readonly actor: TaskActor; readonly at: number; readonly reason: string; readonly contentVersion: number; readonly previous: TaskContent; readonly content: TaskContent }
  | { readonly action: 'pause-requested'; readonly actor: TaskActor; readonly at: number; readonly reason: string }
  | { readonly action: 'pause-retry-required' | 'pause-request-cancelled'; readonly actor: TaskActor; readonly at: number; readonly reason: string }
  | { readonly action: 'paused' | 'interrupt-requested'; readonly actor: TaskActor; readonly at: number; readonly reason: string }
  | { readonly action: 'resumed'; readonly actor: TaskActor; readonly at: number; readonly reason: string; readonly fromStatus?: 'stopped' }
  | { readonly action: 'subordinate-run-stop-requested'; readonly actor: TaskActor; readonly at: number; readonly runId: string; readonly reason: string }
  | { readonly action: 'blocker-raised'; readonly actor: TaskActor; readonly at: number; readonly blocker: TaskBlocker }
  | { readonly action: 'blocker-cleared'; readonly actor: TaskActor; readonly at: number; readonly reason: string }
  | { readonly action: 'completion-claimed'; readonly actor: TaskActor; readonly at: number; readonly claimId: string; readonly substitutedFor?: TaskActor }
  | { readonly action: 'validation-accepted' | 'validation-corrected'; readonly actor: TaskActor; readonly at: number; readonly claimId: string; readonly reason: string }
  | { readonly action: 'end-requested'; readonly actor: TaskActor; readonly at: number; readonly disposition: 'completed' | 'cancelled'; readonly reason: string }
  | { readonly action: 'recovery-requested'; readonly actor: TaskActor; readonly at: number; readonly recoveryAction: 'resume' | 'discard'; readonly reason: string }
  | { readonly action: 'reopened'; readonly actor: TaskActor; readonly at: number; readonly reason: string; readonly fromStatus: TaskStatus; readonly previousCompletedAt?: number; readonly previousEndDisposition?: 'completed' | 'cancelled' };

/** Approval and the exact proposal snapshot bound by one approve-and-begin command. */
export interface TaskAdmission {
  readonly proposalId: string;
  /** Proposal revision consumed atomically with the Task-held lease. */
  readonly proposalRevision: number;
  readonly contentVersion: number;
  readonly validationCriteria: readonly string[];
  readonly lead: TaskActor;
  /** Agent identity used to materialize Worker-owned Task context. */
  readonly contextAgentId: string;
  readonly approvedBy: TaskActor;
  readonly approvedAt: number;
  readonly approvalReason?: string;
  /** Set durably when the separately admitted initial Agent run could not be submitted. */
  readonly initialRunFailed?: boolean;
}

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
  /** Present for Tasks created by Human approve-and-begin; binds immutable proposal facts. */
  readonly admission?: TaskAdmission;
  /** Legacy plain-text reason; new blockers use the complete routable shape below. */
  readonly blockerReason?: string;
  readonly blocker?: TaskBlocker;
  readonly completionClaims?: readonly TaskCompletionClaim[];
  /** The only claim eligible for a Human validation decision. */
  readonly pendingCompletionClaimId?: string;
  /** Admission hold orthogonal to run and Environment lease lifecycles. */
  readonly pauseState?: TaskPauseState;
  readonly controlHistory?: readonly TaskControlEvent[];
  /** Durable intent survives cleanup/release recovery without changing disposition. */
  readonly endDisposition?: 'completed' | 'cancelled';
  readonly forcedRelease?: { readonly actor: string; readonly reason: string; readonly unresolvedFacts: readonly string[]; readonly at: number };
  /** Fixed only by Task begin; absent for an unbegun Task. */
  readonly environmentInstanceId?: string;
  /** The Task-held lease, never a nested run-held lease. */
  readonly environmentLeaseId?: string;
  readonly environmentLifecycleState?: TaskEnvironmentLifecycleState;
  /** The state interrupted by recovery, used only for an explicit retry. */
  readonly recoveryState?: TaskEnvironmentLifecycleState;
  /** The one admitted nested run, when there is one. */
  readonly activeRunId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export function serializeTaskControlDocument(task: Task): string | null {
  const document = {
    ...(task.blocker !== undefined ? { blocker: task.blocker } : {}),
    ...(task.completionClaims !== undefined ? { completionClaims: task.completionClaims } : {}),
    ...(task.pendingCompletionClaimId !== undefined ? { pendingCompletionClaimId: task.pendingCompletionClaimId } : {}),
    ...(task.pauseState !== undefined ? { pauseState: task.pauseState } : {}),
    ...(task.controlHistory !== undefined ? { controlHistory: task.controlHistory } : {}),
    ...(task.endDisposition !== undefined ? { endDisposition: task.endDisposition } : {}),
    ...(task.forcedRelease !== undefined ? { forcedRelease: task.forcedRelease } : {}),
  };
  return Object.keys(document).length > 0 ? JSON.stringify(document) : null;
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
  readonly status: 'completed' | 'failed' | 'stopped' | 'interrupted';
  /** The bounded fact-form outcome; empty when the run produced no text. */
  readonly summary: string;
  readonly recordedAt: number;
}

/** One Task linked to one run, in Task order. */
export interface TaskRunLink {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  /** Present for an explicitly attributed Task-lead or Human advance. */
  readonly actor?: TaskActor;
  readonly reason?: string;
  readonly contentVersion?: number;
  readonly requestedAt?: number;
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

/** Whether the Task still carries live intent, including stopped and paused work. */
export function isActiveIntentTaskStatus(status: TaskStatus): status is ActiveIntentTaskStatus {
  return TASK_STATUS_DATA[status].family === 'active-intent';
}

/** Whether the Task intent has ended; stopped is deliberately excluded. */
export function isEndedTaskStatus(status: TaskStatus): status is EndedTaskStatus {
  return TASK_STATUS_DATA[status].family === 'ended';
}

/** Whether advancing a Task from `status` is permitted. */
export function canAdvanceTask(status: TaskStatus): boolean {
  return status === 'todo' || status === 'blocked' || status === 'in-progress';
}
