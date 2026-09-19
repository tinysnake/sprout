/**
 * The Web wire contract and view projections.
 *
 * This Module is the single ownership boundary between the domain and the Web
 * transport. It defines the client-facing wire types (`RunView`, `TaskView`, …)
 * and the pure projections that produce them from domain records. The transport
 * (`api.ts`) imports these; it never re-declares a wire shape and never reaches
 * into a domain record to build a response body field by field.
 *
 * Two rules keep the boundary honest:
 *
 * - Projections are pure functions over domain records. They hold no `node:http`
 *   dependency, open no connection, and read no environment fact, so a later M2
 *   router or a browser adapter can consume the same contract.
 * - Privacy is enforced here, at the projection boundary (M2 testing decision
 *   32): a view exposes only what the client needs, so lease ids, engine
 *   internals, adapter details, and raw run events have no path into a payload.
 *
 * Adding a field is an additive wire-contract change owned by this Module.
 * Changing an existing field's presence or meaning is a product decision, not a
 * cleanup.
 */

import type { Message, WakeRequest } from '../collaboration/model.ts';
import type { AgentRun, TokenUsage } from '../run/model.ts';
import type { Task, TaskRunLink, TaskWithRuns } from '../task/model.ts';

/**
 * The client-facing shape of a run.
 *
 * Status, progress, and the terminal result only: lease ids, engine internals,
 * and adapter details stay inside the server, so the Web client cannot come to
 * depend on them.
 */
export interface RunView {
  readonly id: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly status: string;
  readonly events: readonly { readonly type: string; readonly [key: string]: unknown }[];
  /**
   * The durable Task this run advances, when it is a Task run (#28).
   *
   * Absent for a one-round run. Exposing the link lets a client place a run in
   * its Task without giving the client any Task domain logic.
   */
  readonly taskId?: string;
  /**
   * Whether a cross-environment hand-off was attached to this run's input.
   *
   * A boolean rather than the text: the fact is useful to the client (so it can
   * see that context was re-presented after a move), while the summary itself and
   * the environment identity stay server-side like the other run internals.
   */
  readonly handOffAttached: boolean;
  readonly failure?: string;
  readonly result?: unknown;
  readonly tokenUsage?: TokenUsage;
  readonly createdAt: number;
  readonly completedAt?: number;
}

/** Cumulative, observable consumption across the returned durable history. */
export interface RunHistoryTotals {
  /** Sum of terminal run elapsed time; active runs are not estimated. */
  readonly durationMs: number;
  readonly tokenUsage: TokenUsage;
  readonly completedRunCount: number;
  /** Runs whose provider supplied usage, so an absent metric is never hidden. */
  readonly runsWithTokenUsage: number;
}

export function summarizeRunHistory(runs: readonly RunView[]): RunHistoryTotals {
  let durationMs = 0;
  let completedRunCount = 0;
  let runsWithTokenUsage = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  for (const run of runs) {
    if (run.completedAt !== undefined) {
      completedRunCount += 1;
      durationMs += Math.max(0, run.completedAt - run.createdAt);
    }
    if (run.tokenUsage !== undefined) {
      runsWithTokenUsage += 1;
      promptTokens += run.tokenUsage.promptTokens;
      completionTokens += run.tokenUsage.completionTokens;
      totalTokens += run.tokenUsage.totalTokens;
    }
  }
  return {
    durationMs,
    tokenUsage: { promptTokens, completionTokens, totalTokens },
    completedRunCount,
    runsWithTokenUsage,
  };
}

export function toRunView(run: AgentRun): RunView {
  return {
    id: run.id,
    agentId: run.agentId,
    prompt: run.prompt,
    status: run.status,
    events: run.events,
    ...(run.taskId !== undefined ? { taskId: run.taskId } : {}),
    handOffAttached: run.handOff !== undefined,
    ...(run.failure !== undefined ? { failure: run.failure } : {}),
    ...(run.result !== undefined ? { result: run.result } : {}),
    ...(run.tokenUsage !== undefined ? { tokenUsage: run.tokenUsage } : {}),
    createdAt: run.createdAt,
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
  };
}

/**
 * The client-facing shape of one Message.
 *
 * The conversation unit only: author, body, reply link, and ordering. A reply's
 * body is already the run's final assistant text, so tool calls, tool output, and
 * raw reasoning have no path into this view — they were never stored as a
 * Message in the first place.
 */
export interface MessageView {
  readonly id: string;
  readonly projectId: string;
  readonly channel: string;
  readonly authorId: string;
  readonly authorKind: string;
  readonly body: string;
  readonly recipients: readonly string[];
  readonly inReplyTo?: string;
  readonly createdAt: number;
}

export function toMessageView(message: Message): MessageView {
  return {
    id: message.id,
    projectId: message.projectId,
    channel: message.channel,
    authorId: message.author.id,
    authorKind: message.author.kind,
    body: message.body,
    recipients: message.recipients,
    ...(message.inReplyTo !== undefined ? { inReplyTo: message.inReplyTo } : {}),
    createdAt: message.createdAt,
  };
}

/**
 * The client-facing shape of one wake request (#27).
 *
 * Every field the operator needs to answer "did this Message start a run, and
 * why?": the target Agent, the deterministic or modelled reason, the durable
 * status, and the linked run when one was admitted. Run internals stay out, so
 * the client still cannot depend on leases or engines.
 */
export interface WakeView {
  readonly agentId: string;
  readonly reason: string;
  readonly status: string;
  readonly runId?: string;
}

export function toWakeView(wake: WakeRequest): WakeView {
  return {
    agentId: wake.agentId,
    reason: wake.reason,
    status: wake.status,
    ...(wake.runId !== undefined ? { runId: wake.runId } : {}),
  };
}

/**
 * The client-facing shape of one project the composer may address (#27).
 *
 * The member ids are what the composer offers as `@agent` mentions and direct
 * recipients; nothing else about the project (environment access, rules) is
 * needed to write a Message.
 */
export interface ProjectView {
  readonly id: string;
  readonly goal: string;
  readonly memberIds: readonly string[];
}

export function toProjectView(project: {
  readonly id: string;
  readonly goal: string;
  readonly memberships: readonly { readonly agentId: string }[];
}): ProjectView {
  return {
    id: project.id,
    goal: project.goal,
    memberIds: project.memberships.map((membership) => membership.agentId),
  };
}

/**
 * The client-facing shape of one durable Task (#28).
 *
 * The whole Task record is safe to expose: it holds no lease, engine, or worker
 * detail. `environmentPreference` is included so a human can see which environment
 * was requested, and the run links (below) show what the Task actually did.
 */
export interface TaskView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly status: string;
  readonly assignedAgentId?: string;
  readonly environmentPreference?: { readonly kind: string; readonly id: string };
  readonly blockerReason?: string;
  readonly environmentInstanceId?: string;
  readonly environmentLeaseId?: string;
  readonly environmentLifecycleState?: string;
  /** A safe, operator-facing projection of the Worker-owned Task context. */
  readonly taskContextState: string;
  readonly recoveryState?: string;
  readonly activeRunId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export function toTaskView(task: Task): TaskView {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    goal: task.goal,
    constraints: task.constraints,
    status: task.status,
    ...(task.assignedAgentId !== undefined ? { assignedAgentId: task.assignedAgentId } : {}),
    ...(task.environmentPreference !== undefined
      ? { environmentPreference: task.environmentPreference }
      : {}),
    ...(task.blockerReason !== undefined ? { blockerReason: task.blockerReason } : {}),
    ...(task.environmentInstanceId !== undefined ? { environmentInstanceId: task.environmentInstanceId } : {}),
    ...(task.environmentLeaseId !== undefined ? { environmentLeaseId: task.environmentLeaseId } : {}),
    ...(task.environmentLifecycleState !== undefined ? { environmentLifecycleState: task.environmentLifecycleState } : {}),
    taskContextState: toTaskContextState(task),
    ...(task.recoveryState !== undefined ? { recoveryState: task.recoveryState } : {}),
    ...(task.activeRunId !== undefined ? { activeRunId: task.activeRunId } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
  };
}

/**
 * The Worker owns the filesystem facts; this is only the lifecycle projection
 * a human needs to decide whether cleanup is pending, retryable, or complete.
 */
export function toTaskContextState(task: Task): string {
  switch (task.environmentLifecycleState) {
    case undefined: return 'not-created';
    case 'beginning': return 'preparing';
    case 'idle':
    case 'running':
    case 'blocked':
    case 'awaiting-validation': return 'ready';
    case 'ending': return 'cleanup-in-progress';
    case 'recovery': return task.recoveryState === 'ending' ? 'cleanup-needs-recovery' : 'recovery-retained';
    case 'ended':
    case 'discarded': return 'recycled';
    default: return 'unknown';
  }
}

/** One Task plus its ordered run links, for `GET /api/tasks/:id`. */
export interface TaskWithRunsView {
  readonly task: TaskView;
  readonly runs: readonly TaskRunLinkView[];
}

/** One linked run. `summary` is absent until the run settles. */
export interface TaskRunLinkView {
  readonly runId: string;
  readonly agentId: string;
  readonly sequence: number;
  readonly linkedAt: number;
  readonly summary?: {
    readonly status: string;
    readonly summary: string;
    readonly recordedAt: number;
  };
}

export function toTaskWithRunsView(found: TaskWithRuns): TaskWithRunsView {
  return { task: toTaskView(found.task), runs: found.runs.map(toTaskRunLinkView) };
}

export function toTaskRunLinkView(link: TaskRunLink): TaskRunLinkView {
  return {
    runId: link.runId,
    agentId: link.agentId,
    sequence: link.sequence,
    linkedAt: link.linkedAt,
    ...(link.summary !== undefined
      ? {
          summary: {
            status: link.summary.status,
            summary: link.summary.summary,
            recordedAt: link.summary.recordedAt,
          },
        }
      : {}),
  };
}
