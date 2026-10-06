/**
 * Human Attention, in-flight work, and operational activity projection (#103).
 *
 * The Feed discovers and contextualizes work; it never executes domain actions
 * and it is never a second authority (ADR-0006, ADR-0007,
 * `docs/prototype-feed-attention.md`). Everything here is derived read-only
 * from authoritative domain state through {@link FeedSources}: Task proposals,
 * completion claims awaiting validation, routable blockers, Task and lease
 * recovery, pending enrollments, failed wake observations and routing batches, and
 * Project events declared `human-action-required`.
 *
 * The projection stores nothing and mutates nothing. There is deliberately no
 * dismiss or snooze command on any surface: an attention item disappears only
 * when its authoritative source clears, and a restart recomputes the identical
 * snapshot from the same durable facts.
 *
 * **Privacy.** Activity summaries are bounded, fact-form one-liners built from
 * curated Project events and terminal run settlements. Engine prose, prompts,
 * raw run events/results/failures, frozen routing context, and conversation
 * content never cross this boundary. Every interpolated source string passes
 * through the shared redaction boundary (`environment/privacy.ts`) and is
 * length-bounded before it becomes part of an item.
 *
 * **Scoping.** Every item carries the scope ids it belongs to. A Project item
 * belongs to its Project; a generic infrastructure fact belongs to `feed:infra`;
 * an infrastructure fact that directly blocks a Project's Task (a recovery
 * record holding that Task's lease) additionally belongs to that Project's
 * scope — the transcolation rule (story 17). The implicit `feed:all` scope includes
 * every item.
 *
 * Deep links are identities, not controls: `target` names the owning domain
 * surface and the authoritative entity ids, and `isFeedDeepLink` validates the
 * shape so the browser can navigate without guessing a route.
 */

import { redactSensitiveText } from '../environment/privacy.ts';
import type { CollaborationAttentionResolution, FailedWakeInput } from '../collaboration/attention.ts';
import type { ProjectEvent } from '../collaboration/events.ts';
import type { TaskGroupMessageKind } from '../collaboration/model.ts';
import type { RoutingBatch } from '../collaboration/routing.ts';
import type { EnvironmentEnrollment } from '../environment/enrollment.ts';
import type { EnvironmentRecoveryRecord } from '../environment/recovery.ts';
import type { AgentRun } from '../run/model.ts';
import { isTerminalTaskStatus, type Task } from '../task/model.ts';
import type { TaskProposal } from '../task/proposal-model.ts';

/** Synthetic scopes contain a colon, which sanitizeProjectId cannot preserve. */
export const FEED_ALL_SCOPE = 'feed:all';
/** The generic infrastructure scope; never a Project id. */
export const FEED_INFRASTRUCTURE_SCOPE = 'feed:infra';
/** Newest-first bound on the operational activity stream. */
export const FEED_ACTIVITY_LIMIT = 50;
/** The character bound on any summary or reason text the Feed emits. */
export const FEED_TEXT_LIMIT = 400;

/** Categories projected from the durable task-group-unanswered signal. */
export const TASK_GROUP_UNANSWERED_EVENT_KIND = 'task-group-unanswered';
const TASK_GROUP_ATTENTION_EVENT_CATEGORIES = new Map<string, FeedAttentionCategory>([
  [TASK_GROUP_UNANSWERED_EVENT_KIND, 'task-group-escalation'],
]);

/** Urgency tiers, most urgent first (story 15). */
export type FeedSeverity = 'action_required' | 'attention' | 'info';
export const FEED_SEVERITIES: readonly FeedSeverity[] = ['action_required', 'attention', 'info'];

/** Why one attention item exists, naming its authoritative source shape. */
export type FeedAttentionCategory =
  | 'proposal-pending'
  | 'task-validation'
  | 'task-blocker'
  | 'task-recovery'
  | 'lease-recovery'
  | 'enrollment-pending'
  | 'routing-failure'
  | 'human-action-required'
  | 'task-group-escalation'
  | 'task-group-human-waiting'
  | 'task-group-human-question';

/** The domain surfaces a Feed deep link may own (story 18). */
export type FeedTargetSurface =
  | 'project-overview'
  | 'project-tasks'
  | 'project-task-detail'
  | 'project-chat'
  | 'project-chat-routing'
  | 'environments'
  | 'environment-detail'
  | 'agent-detail';

/**
 * Route templates per surface, keyed by the FeedTarget field each path segment
 * carries. These mirror `web/src/router/index.ts`; the browser adapter test
 * pins the two together.
 */
export const FEED_SURFACE_TEMPLATES: Readonly<Record<FeedTargetSurface, string>> = {
  'project-overview': '/project/overview',
  'project-tasks': '/project/tasks',
  'project-task-detail': '/project/tasks/:taskId',
  'project-chat': '/project/chat',
  'project-chat-routing': '/project/chat/routing/:batchId',
  environments: '/manage/environments',
  'environment-detail': '/manage/environments/:environmentId',
  'agent-detail': '/manage/agents/:agentId',
};

/** The authoritative entity identities one deep link may carry. */
export interface FeedTargetIdentity {
  readonly surface: FeedTargetSurface;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly proposalId?: string;
  readonly batchId?: string;
  /** Conversation scope for a project-chat destination. */
  readonly scopeId?: string;
  /** Exact Chat timeline item to reveal. */
  readonly messageId?: string;
  readonly eventId?: string;
  /** Causal Agent run identity carried as safe routing evidence. */
  readonly runId?: string;
  readonly agentId?: string;
  /** The Manage Environments route key (enrollment key), not the instance id. */
  readonly environmentId?: string;
}

/** One deep-link identity: the owning surface plus a concrete route path. */
export interface FeedTarget extends FeedTargetIdentity {
  /** Canonical route path relative to the router root; no origin, no base. */
  readonly path: string;
}

function usable(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function safeChatIdentity(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,159}$/.test(value) && value !== '.' && value !== '..';
}

/**
 * Build a validated deep-link target.
 *
 * Throws when the identity does not carry the fields its surface template
 * requires: a deep link without its entity id would silently land the operator
 * on a list page while claiming to be a detail link.
 */
export function feedTarget(identity: FeedTargetIdentity): FeedTarget {
  const template = FEED_SURFACE_TEMPLATES[identity.surface];
  if (template === undefined) throw new Error(`unknown Feed surface: ${String(identity.surface)}`);
  const segments = template.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment;
    const field = segment.slice(1) as keyof FeedTargetIdentity;
    const value = identity[field];
    if (!usable(value)) throw new Error(`Feed surface ${identity.surface} requires ${field}`);
    return encodeURIComponent(value!);
  });
  let path = segments.join('/');
  if (identity.surface === 'project-chat') {
    const { scopeId, messageId, eventId, runId, agentId } = identity;
    if (scopeId !== undefined && !safeChatIdentity(scopeId)) throw new Error('project-chat requires a safe scopeId');
    if (messageId !== undefined && !safeChatIdentity(messageId)) throw new Error('project-chat requires a safe messageId');
    if (eventId !== undefined && !safeChatIdentity(eventId)) throw new Error('project-chat requires a safe eventId');
    if (runId !== undefined && !safeChatIdentity(runId)) throw new Error('project-chat requires a safe runId');
    if (agentId !== undefined && !safeChatIdentity(agentId)) throw new Error('project-chat requires a safe agentId');
    if (messageId !== undefined && scopeId === undefined) throw new Error('a message deep link requires a conversation scope');
    if (messageId !== undefined && eventId !== undefined) throw new Error('a Chat deep link may focus one timeline item');
    if (scopeId !== undefined) path += `/${encodeURIComponent(scopeId)}`;
    if (messageId !== undefined) path += `?message=${encodeURIComponent(messageId)}`;
    else if (eventId !== undefined) path += `?event=${encodeURIComponent(eventId)}`;
  } else if (identity.scopeId !== undefined || identity.messageId !== undefined || identity.eventId !== undefined || identity.runId !== undefined) {
    throw new Error('conversation identity belongs to the project-chat surface');
  }
  if (usable(identity.proposalId)) {
    if (identity.surface !== 'project-tasks') throw new Error('a proposal deep link owns the project-tasks surface');
    path += `?proposal=${encodeURIComponent(identity.proposalId!)}`;
  } else if (identity.surface === 'project-tasks' && identity.proposalId !== undefined) {
    throw new Error('a proposal deep link requires a proposalId');
  }
  return { ...identity, path };
}

/** Whether an unknown value is a coherent deep link for a real Feed surface. */
export function isFeedDeepLink(value: unknown): value is FeedTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  if (typeof target.surface !== 'string' || typeof target.path !== 'string') return false;
  if (!Object.hasOwn(FEED_SURFACE_TEMPLATES, target.surface)) return false;
  try {
    return feedTarget(target as unknown as FeedTargetIdentity).path === target.path;
  } catch {
    return false;
  }
}

/** One Project as the Feed labels and scopes it. */
export interface FeedProjectRef {
  readonly id: string;
  readonly displayName: string;
}

/** Minimal Task-group identity used for Feed labels and exact Chat targets. */
export interface FeedTaskGroup {
  readonly scopeId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly leadKind?: 'human' | 'agent';
  readonly createdAt: number;
}

/** Kind-stamped Task-group Messages and their reply links, without body content. */
export interface FeedTaskGroupMessage {
  readonly id: string;
  readonly projectId: string;
  readonly scopeId: string;
  readonly kind: TaskGroupMessageKind;
  readonly authorKind: 'human' | 'agent';
  readonly inReplyTo?: string;
  readonly createdAt: number;
}

/** Durable #211 notification-only escalation identity. */
export interface FeedTaskGroupEscalation {
  readonly eventId: string;
  readonly messageId: string;
  readonly scopeId: string;
  readonly projectId: string;
  readonly at: number;
}

export interface FeedChatActivityOrigin {
  readonly runId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly scopeId: string;
  readonly messageId?: string;
  readonly eventId?: string;
}

/**
 * The authoritative reads one snapshot derives from. Ports, not state: the
 * projection never writes through them, holds no cache, and cannot clear,
 * dismiss, or snooze anything they report.
 */
export interface FeedSources {
  /** Every Project the operator can scope the Feed to. */
  projects(): Promise<readonly FeedProjectRef[]>;
  tasks(): Promise<readonly Task[]>;
  proposals(): Promise<readonly TaskProposal[]>;
  events(): Promise<readonly ProjectEvent[]>;
  enrollments(): Promise<readonly EnvironmentEnrollment[]>;
  recoveries(): Promise<readonly EnvironmentRecoveryRecord[]>;
  runs(): Promise<readonly AgentRun[]>;
  routingBatches(): Promise<readonly RoutingBatch[]>;
  wakeFailures(): Promise<readonly FailedWakeInput[]>;
  attentionResolutions(): Promise<readonly CollaborationAttentionResolution[]>;
  /** Current and historical Task groups as minimal, read-only identities. */
  taskGroups?(): Promise<readonly FeedTaskGroup[]>;
  /** Kind-stamped Task-group Messages without body content. */
  taskGroupMessages?(): Promise<readonly FeedTaskGroupMessage[]>;
  /** Durable notification-only escalation signals from task-group orchestration (#211). */
  taskGroupEscalations?(): Promise<readonly FeedTaskGroupEscalation[]>;
  /** Durable run-to-Message/Event identity links for exact Chat activity destinations. */
  chatActivityOrigins?(context: {
    readonly events: readonly ProjectEvent[];
    readonly routingBatches: readonly RoutingBatch[];
  }): Promise<readonly FeedChatActivityOrigin[]>;
}

/** One unresolved Human Attention item. Cleared only by its source clearing. */
export interface FeedAttentionItem {
  readonly id: string;
  readonly severity: FeedSeverity;
  readonly category: FeedAttentionCategory;
  /** The textual reason Human attention is needed (story 15). */
  readonly reason: string;
  /** The disambiguated `Task · Run · Lease` state sentence (story 15). */
  readonly lifecycle: string;
  readonly target: FeedTarget;
  /** Scope ids this item belongs to: Project ids and/or `feed:infra`. */
  readonly scopes: readonly string[];
  /** The authoritative source this item projects; never a second copy. */
  readonly source: { readonly kind: 'proposal' | 'task' | 'recovery' | 'enrollment' | 'routing-batch' | 'wake-input' | 'event' | 'message'; readonly id: string };
  readonly at: number;
}

/** One currently executing Task or Agent run (story 14). */
export interface FeedInFlightItem {
  readonly id: string;
  readonly kind: 'task' | 'run';
  readonly lifecycle: string;
  /** The product-configured engine and work model captured by the active run. */
  readonly engine?: string;
  readonly model?: string;
  readonly scopes: readonly string[];
  readonly target?: FeedTarget;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly environmentInstanceId?: string;
  readonly at: number;
}

/** One bounded, sanitized operational activity entry (story 14). */
export interface FeedActivityItem {
  readonly id: string;
  readonly kind: string;
  /** The bounded fact-form one-liner; never prose, prompts, or raw results. */
  readonly summary: string;
  readonly scopes: readonly string[];
  readonly target?: FeedTarget;
  readonly projectId?: string;
  readonly at: number;
}

/** One selectable Feed scope with its current attention count. */
export interface FeedScopeOption {
  readonly id: string;
  readonly kind: 'all' | 'project' | 'infrastructure';
  readonly label: string;
  readonly attentionCount: number;
}

export interface FeedSnapshot {
  readonly attention: readonly FeedAttentionItem[];
  readonly inFlight: readonly FeedInFlightItem[];
  readonly activity: readonly FeedActivityItem[];
  readonly scopes: readonly FeedScopeOption[];
}

export interface FeedFilter {
  /** `feed:all`, `feed:infra`, or a Project id. Absent means `feed:all`. */
  readonly scope?: string;
  /** Restricts attention to one urgency tier; never hides in-flight or activity. */
  readonly urgency?: FeedSeverity;
}

/** The read-only Feed capability composed by the runtime and served by the API. */
export interface FeedProjection {
  snapshot(): Promise<FeedSnapshot>;
}

export function createFeedProjection(sources: FeedSources): FeedProjection {
  return { snapshot: () => projectFeed(sources) };
}

const SEVERITY_RANK: Readonly<Record<FeedSeverity, number>> = {
  action_required: 0,
  attention: 1,
  info: 2,
};

/** Redact then bound one interpolated source string. */
function boundText(value: unknown, max: number = FEED_TEXT_LIMIT): string {
  const text = redactSensitiveText(typeof value === 'string' ? value : '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}\u2026`;
}

/** The ADR-0006 operator-visible sentence for one Task (story 15). */
export function taskLifecycleSentence(task: Task): string {
  const phase =
    task.environmentLifecycleState === 'recovery'
      ? 'Task recovery'
      : task.pauseState === 'paused'
        ? 'Task paused'
        : task.pauseState === 'requested'
          ? 'Task pause requested'
          : lifecyclePhase(task);
  const run = usable(task.activeRunId) ? 'Agent run active' : 'No active Agent run';
  const lease = usable(task.environmentLeaseId)
    ? task.environmentLifecycleState === 'recovery'
      ? 'Lease recovering'
      : task.environmentLifecycleState === 'ended' || task.environmentLifecycleState === 'discarded'
        ? 'Lease released'
        : 'Lease held'
    : 'No lease';
  return `${phase} · ${run} · ${lease}`;
}

function lifecyclePhase(task: Task): string {
  // `default` rather than `case undefined`: under exactOptionalPropertyTypes a
  // switch on an optional property is not exhaustive over `undefined`.
  switch (task.environmentLifecycleState) {
    case 'beginning':
      return 'Task beginning';
    case 'idle':
    case 'running':
      return 'Task active';
    case 'blocked':
      return 'Task blocked';
    case 'awaiting-validation':
      return 'Task awaiting validation';
    case 'ending':
      return 'Task ending';
    case 'ended':
      if (task.status === 'stopped') return 'Task stopped';
      if (task.status === 'cancelled' || task.endDisposition === 'cancelled') return 'Task cancelled';
      if (task.status === 'failed') return 'Task failed';
      return 'Task completed';
    case 'recovery':
      return 'Task recovery';
    case 'discarded':
      if (task.status === 'stopped') return 'Task stopped';
      return task.status === 'cancelled' ? 'Task cancelled' : 'Task discarded';
    default:
      switch (task.status) {
        case 'in-progress':
          return 'Task active';
        case 'blocked':
          return 'Task blocked';
        case 'done':
          return 'Task completed';
        case 'stopped':
          return 'Task stopped';
        case 'cancelled':
          return 'Task cancelled';
        case 'failed':
          return 'Task failed';
        default:
          return `Task ${task.status}`;
      }
  }
}

/** Whether one item belongs to one scope id (`all` is handled by the caller). */
export function feedScopeIncludes(scopes: readonly string[], scopeId: string): boolean {
  return scopes.includes(scopeId);
}

/** Apply one scope/urgency filter to a snapshot (stories 16–17). */
export function filterFeed(snapshot: FeedSnapshot, filter: FeedFilter = {}): FeedSnapshot {
  const scope = filter.scope ?? FEED_ALL_SCOPE;
  const inScope = (scopes: readonly string[]): boolean =>
    scope === FEED_ALL_SCOPE || feedScopeIncludes(scopes, scope);
  return {
    attention: snapshot.attention.filter(
      (item) => inScope(item.scopes) && (filter.urgency === undefined || item.severity === filter.urgency),
    ),
    inFlight: snapshot.inFlight.filter((item) => inScope(item.scopes)),
    activity: snapshot.activity.filter((item) => inScope(item.scopes)),
    scopes: snapshot.scopes,
  };
}

/**
 * Derive one Feed snapshot from the authoritative sources.
 *
 * Ordering is deterministic: attention by severity then newest first, in-flight
 * and activity newest first, scopes as `all`, Projects by id, then `infra`.
 */
export async function projectFeed(sources: FeedSources): Promise<FeedSnapshot> {
  const [projects, tasks, proposals, rawEvents, enrollments, recoveries, runs, batches, wakeFailures, resolutions, taskGroups, taskGroupMessages, taskGroupEscalations] = await Promise.all([
    sources.projects(),
    sources.tasks(),
    sources.proposals(),
    sources.events(),
    sources.enrollments(),
    sources.recoveries(),
    sources.runs(),
    sources.routingBatches(),
    sources.wakeFailures(),
    sources.attentionResolutions(),
    sources.taskGroups?.() ?? Promise.resolve([]),
    sources.taskGroupMessages?.() ?? Promise.resolve([]),
    sources.taskGroupEscalations?.() ?? Promise.resolve([]),
  ]);
  const eventsByDelivery = new Map<string, ProjectEvent>();
  for (const event of rawEvents) {
    const identity = `${event.projectId}\u0000${event.deliveryKey}`;
    if (!eventsByDelivery.has(identity)) eventsByDelivery.set(identity, event);
  }
  const events = [...eventsByDelivery.values()];
  const chatOrigins = await sources.chatActivityOrigins?.({ events, routingBatches: batches }) ?? [];

  const taskGroupsByScope = new Map(taskGroups.map((group) => [group.scopeId, group]));
  const taskGroupMessagesById = new Map(taskGroupMessages.map((message) => [message.id, message]));
  const taskGroupEscalationsByEventId = new Map(taskGroupEscalations.map((signal) => [signal.eventId, signal]));
  const taskGroupByScope = (projectId: string, scopeId: string): FeedTaskGroup | undefined => {
    const group = taskGroupsByScope.get(scopeId);
    return group?.projectId === projectId ? group : undefined;
  };
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const enrollmentsById = new Map(enrollments.map((enrollment) => [enrollment.id, enrollment]));
  // Known Projects = durable authority plus every Project a Task actually
  // references. A proposal, event, or batch in a Project that owns neither is
  // omitted from attention rather than deep-linked to a surface that cannot
  // exist (referential integrity).
  const projectRefs = new Map<string, FeedProjectRef>();
  for (const project of projects) {
    if (usable(project.id)) projectRefs.set(project.id, { id: project.id, displayName: project.displayName });
  }
  for (const task of tasks) {
    if (usable(task.projectId) && !projectRefs.has(task.projectId)) {
      projectRefs.set(task.projectId, { id: task.projectId, displayName: task.projectId });
    }
  }
  for (const group of taskGroups) {
    if (usable(group.projectId) && !projectRefs.has(group.projectId)) {
      projectRefs.set(group.projectId, { id: group.projectId, displayName: group.projectId });
    }
  }
  const knownProject = (projectId: string | undefined): projectId is string =>
    usable(projectId) && projectRefs.has(projectId!);
  const chatOriginsByRun = new Map(chatOrigins.map((origin) => [origin.runId, origin]));
  const chatTarget = (projectId: string, origin: FeedChatActivityOrigin | undefined, expectedAgentId?: string, focusEventId?: string): FeedTarget | undefined => {
    if (!origin || origin.projectId !== projectId || (expectedAgentId !== undefined && origin.agentId !== expectedAgentId) || !safeChatIdentity(origin.scopeId) ||
        (origin.messageId !== undefined && !safeChatIdentity(origin.messageId)) ||
        (origin.eventId !== undefined && !safeChatIdentity(origin.eventId)) ||
        (origin.messageId === undefined && origin.eventId === undefined) ||
        (origin.messageId !== undefined && origin.eventId !== undefined) ||
        (focusEventId !== undefined && !safeChatIdentity(focusEventId)) ||
        !safeChatIdentity(origin.runId) || !safeChatIdentity(origin.agentId)) return undefined;
    return feedTarget({
      surface: 'project-chat', projectId, scopeId: origin.scopeId,
      ...(focusEventId !== undefined
        ? { eventId: focusEventId }
        : origin.messageId !== undefined
          ? { messageId: origin.messageId }
          : origin.eventId !== undefined ? { eventId: origin.eventId } : {}),
      runId: origin.runId, agentId: origin.agentId,
    });
  };

  const taskGroupTarget = (
    group: FeedTaskGroup,
    focus: { readonly messageId?: string; readonly eventId?: string } = {},
  ): FeedTarget | undefined => {
    if (!safeChatIdentity(group.scopeId)) return undefined;
    if (focus.messageId !== undefined && !safeChatIdentity(focus.messageId)) return undefined;
    if (focus.eventId !== undefined && !safeChatIdentity(focus.eventId)) return undefined;
    if (focus.messageId !== undefined && focus.eventId !== undefined) return undefined;
    return feedTarget({
      surface: 'project-chat', projectId: group.projectId, scopeId: group.scopeId,
      ...(focus.messageId !== undefined ? { messageId: focus.messageId } : {}),
      ...(focus.eventId !== undefined ? { eventId: focus.eventId } : {}),
    });
  };

  const instanceToEnvironmentId = new Map<string, string>();
  for (const enrollment of enrollments) {
    if (usable(enrollment.id) && usable(enrollment.environmentInstanceId)) {
      instanceToEnvironmentId.set(enrollment.environmentInstanceId, enrollment.id);
    }
  }

  const attention: FeedAttentionItem[] = [];
  const resolved = (kind: CollaborationAttentionResolution['kind'], sourceId: string, projectId: string, sourceVersion = 0): boolean =>
    resolutions.some(r => r.kind === kind && r.sourceId === sourceId && r.projectId === projectId && r.sourceVersion >= sourceVersion);

  // 1. Task proposals awaiting Human approval and begin authority (ADR-0006).
  for (const proposal of proposals) {
    if (proposal.status !== 'proposed' || !knownProject(proposal.projectId)) continue;
    const content = proposal.versions.find((version) => version.version === proposal.currentContentVersion);
    const title = boundText(content?.title ?? 'Task proposal', 120);
    attention.push({
      id: `proposal:${proposal.id}`,
      severity: 'info',
      category: 'proposal-pending',
      reason: `Task proposal "${title}" awaits Human approval and begin authority.`,
      lifecycle: 'Proposal proposed · No lease · No runs',
      target: feedTarget({ surface: 'project-tasks', projectId: proposal.projectId, proposalId: proposal.id }),
      scopes: [proposal.projectId],
      source: { kind: 'proposal', id: proposal.id },
      at: proposal.updatedAt,
    });
  }

  // Active recovery records make Task-level recovery redundant: one condition,
  // one item, transcolated below through the record instead of duplicated.
  const recoveredTaskIds = new Set(
    recoveries.filter((record) => record.phase !== 'resolved' && usable(record.taskId)).map((record) => record.taskId!),
  );

  for (const task of tasks) {
    if (!knownProject(task.projectId)) continue;
    const base = { scopes: [task.projectId], target: feedTarget({ surface: 'project-task-detail', projectId: task.projectId, taskId: task.id }) };

    // 2. Completion claims awaiting Human validation (ADR-0006).
    if (usable(task.pendingCompletionClaimId)) {
      attention.push({
        id: `validation:${task.id}:${task.pendingCompletionClaimId}`,
        severity: 'attention',
        category: 'task-validation',
        reason: boundText(`Task completion claim ${task.pendingCompletionClaimId} awaits Human validation.`),
        lifecycle: taskLifecycleSentence(task),
        target: base.target,
        scopes: base.scopes,
        source: { kind: 'task', id: task.id },
        at: task.updatedAt,
      });
    }

    // 3. Routable blockers with owner, action, and next advancer (ADR-0006).
    if (task.blocker !== undefined && !['ended', 'discarded'].includes(task.environmentLifecycleState ?? '')
      && !isTerminalTaskStatus(task.status)) {
      attention.push({
        id: `blocker:${task.id}`,
        severity: 'action_required',
        category: 'task-blocker',
        reason: boundText(`${task.blocker.reason} Required action: ${task.blocker.requiredAction}`),
        lifecycle: taskLifecycleSentence(task),
        target: base.target,
        scopes: base.scopes,
        source: { kind: 'task', id: task.id },
        at: task.blocker.createdAt,
      });
    }

    // 4. Task-level recovery with no Environment recovery record covering it.
    if (task.environmentLifecycleState === 'recovery' && !recoveredTaskIds.has(task.id)) {
      attention.push({
        id: `task-recovery:${task.id}`,
        severity: 'action_required',
        category: 'task-recovery',
        reason: boundText('Task and its lease are in recovery; only a Human may resume, discard, or Force Release.'),
        lifecycle: taskLifecycleSentence(task),
        target: base.target,
        scopes: base.scopes,
        source: { kind: 'task', id: task.id },
        at: task.updatedAt,
      });
    }
  }

  // 5. Lease recovery: an infrastructure fact. When the record holds a Task's
  // lease, it directly blocks that Project's work and transcolates into the
  // Project scope (story 17); a run-held or unattributed lease stays generic.
  for (const record of recoveries) {
    if (record.phase === 'resolved' || !usable(record.leaseId)) continue;
    const task = usable(record.taskId) ? tasksById.get(record.taskId) : undefined;
    const scopes = [FEED_INFRASTRUCTURE_SCOPE];
    if (task !== undefined && knownProject(task.projectId)) scopes.push(task.projectId);
    const environmentId = usable(record.enrollmentId)
      ? record.enrollmentId
      : instanceToEnvironmentId.get(record.environmentInstanceId);
    const unresolved = record.unresolvedFacts.slice(0, 3).map((fact) => boundText(fact, 160)).filter((fact) => fact !== '');
    const why = record.phase === 'recovery'
      ? `Environment lease in recovery${unresolved.length > 0 ? `: ${unresolved.join('; ')}` : ''}.`
      : 'Recovery evidence is still synchronizing after a Worker channel loss.';
    attention.push({
      id: `lease-recovery:${record.id}`,
      severity: record.phase === 'recovery' ? 'action_required' : 'attention',
      category: 'lease-recovery',
      reason: boundText(why),
      lifecycle: boundText(`Environment lease ${record.phase} · ${record.holderKind === 'task' ? `Task ${record.holderId}` : `Run ${record.holderId}`} · Cause ${record.cause}`),
      target: environmentId !== undefined && enrollmentsById.has(environmentId)
        ? feedTarget({ surface: 'environment-detail', environmentId })
        : feedTarget({ surface: 'environments' }),
      scopes,
      source: { kind: 'recovery', id: record.id },
      at: record.updatedAt,
    });
  }

  // 6. Pending enrollments awaiting Human approval; generic infrastructure.
  for (const enrollment of enrollments) {
    if (enrollment.status !== 'pending') continue;
    attention.push({
      id: `enrollment:${enrollment.id}`,
      severity: 'attention',
      category: 'enrollment-pending',
      reason: boundText(`Environment enrollment "${enrollment.displayName}" awaits Human approval.`),
      lifecycle: 'Enrollment pending · Approval not granted · Work admission barred',
      target: feedTarget({ surface: 'environment-detail', environmentId: enrollment.id }),
      scopes: [FEED_INFRASTRUCTURE_SCOPE],
      source: { kind: 'enrollment', id: enrollment.id },
      at: enrollment.updatedAt,
    });
  }

  // 7. Wake-model routing that failed closed: its inputs never routed.
  // A batch in `frozen` is transient (the sweep re-submits it) and a batch in
  // `routed`/`suppressed` settled deliberately, so neither is attention.
  for (const batch of batches) {
    if (batch.status !== 'failed' || !knownProject(batch.projectId) || resolved('routing-batch', batch.id, batch.projectId)) continue;
    const detail = usable(batch.error) ? boundText(batch.error, 200) : '';
    attention.push({
      id: `routing-failure:${batch.id}`,
      severity: 'action_required',
      category: 'routing-failure',
      reason: boundText(`Wake-model routing failed closed for batch ${batch.id}; its inputs were not routed.${detail !== '' ? ` ${detail}` : ''}`),
      lifecycle: 'Routing batch failed · Attempt budget exhausted · Inputs unaddressed',
      target: feedTarget({ surface: 'project-chat-routing', projectId: batch.projectId, batchId: batch.id }),
      scopes: [batch.projectId],
      source: { kind: 'routing-batch', id: batch.id },
      at: batch.settledAt ?? batch.createdAt,
    });
  }

  // Deterministic addressing and admission failures live beside batch failures.
  // The read port excludes Message bodies, target identities, and diagnostic prose.
  for (const failure of wakeFailures) {
    if (!knownProject(failure.projectId) || resolved('wake-input', failure.inputId, failure.projectId, failure.version)) continue;
    attention.push({
      id: `wake-failure:${failure.inputId}`,
      severity: 'action_required',
      category: 'routing-failure',
      reason: `Routing failed for ${failure.failedTargetCount} addressed Agent target(s); inspect the input's routing evidence.`,
      lifecycle: 'Routing failed · Input preserved · Human correction required',
      target: feedTarget({ surface: failure.inputKind === 'event' ? 'project-overview' : 'project-chat', projectId: failure.projectId }),
      scopes: [failure.projectId],
      source: { kind: 'wake-input', id: failure.inputId },
      at: failure.at,
    });
  }

  const repliedMessageIds = new Set<string>();
  for (const reply of taskGroupMessages) {
    if (reply.inReplyTo === undefined) continue;
    const parent = taskGroupMessagesById.get(reply.inReplyTo);
    if (parent?.projectId === reply.projectId && parent.scopeId === reply.scopeId) repliedMessageIds.add(parent.id);
  }
  for (const message of taskGroupMessages) {
    if (message.kind !== 'question' || message.authorKind !== 'agent' || repliedMessageIds.has(message.id) || !knownProject(message.projectId)) continue;
    const group = taskGroupByScope(message.projectId, message.scopeId);
    if (group?.leadKind !== 'human' || !safeChatIdentity(message.id)) continue;
    const target = taskGroupTarget(group, { messageId: message.id });
    if (target === undefined) continue;
    attention.push({
      id: `task-group-human-question:${message.id}`,
      severity: 'attention',
      category: 'task-group-human-question',
      reason: boundText(`Question in “${group.taskTitle}” is routed to its Human lead.`),
      lifecycle: 'Task group · Human lead asked to answer · No Human wake is sent',
      target,
      scopes: [message.projectId],
      source: { kind: 'message', id: message.id },
      at: message.createdAt,
    });
  }

  // 8. Authoritative human-action-required Project events (ADR-0007). Other
  // dispositions never become attention: an addressed event has an Agent, and
  // an informational event is background activity.
  for (const event of events) {
    if (event.disposition !== 'human-action-required' || !knownProject(event.projectId) || resolved('event', event.id, event.projectId)) continue;
    const escalation = taskGroupEscalationsByEventId.get(event.id);
    if (escalation !== undefined && (escalation.projectId !== event.projectId || !safeChatIdentity(escalation.messageId))) continue;
    const groupScopeId = escalation?.scopeId ?? (event.originScopeIds?.length === 1 ? event.originScopeIds[0] : undefined);
    const taskGroup = groupScopeId !== undefined ? taskGroupByScope(event.projectId, groupScopeId) : undefined;
    const messageOriginId = escalation?.messageId ?? event.originMessageId;
    const messageOrigin = messageOriginId !== undefined
      ? taskGroupMessagesById.get(messageOriginId)
      : undefined;
    if (escalation !== undefined && (taskGroup === undefined
      || messageOrigin?.projectId !== event.projectId
      || messageOrigin.scopeId !== taskGroup.scopeId)) continue;
    const focus = messageOrigin?.projectId === event.projectId && messageOrigin.scopeId === taskGroup?.scopeId
      ? { messageId: messageOrigin.id }
      : safeChatIdentity(event.id) ? { eventId: event.id } : {};
    const category = escalation !== undefined && taskGroup?.leadKind === 'human'
      ? 'task-group-human-waiting'
      : taskGroup !== undefined ? TASK_GROUP_ATTENTION_EVENT_CATEGORIES.get(event.kind) : undefined;
    const target = taskGroup !== undefined ? taskGroupTarget(taskGroup, focus) : undefined;
    attention.push({
      id: `event:${event.id}`,
      severity: 'action_required',
      category: category ?? 'human-action-required',
      reason: boundText(taskGroup !== undefined ? `Task group “${taskGroup.taskTitle}” needs Human attention.` : event.summary),
      lifecycle: boundText(taskGroup !== undefined
        ? `Task group · Human attention required · ${event.kind}`
        : `Project event · Human action required · ${event.kind}`),
      target: target ?? feedTarget({ surface: 'project-overview', projectId: event.projectId }),
      scopes: [event.projectId],
      source: { kind: 'event', id: event.id },
      at: event.createdAt,
    });
  }

  attention.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || b.at - a.at
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // In-flight work: Tasks actively beginning/running plus every queued or
  // running Agent run (story 14). Engine/model come only from the run's
  // captured product configuration; prompts, events, results, and failures
  // are never projected.
  const configuredIdentity = (run: AgentRun | undefined): Pick<FeedInFlightItem, 'engine' | 'model'> => {
    const option = run?.workOption;
    if (option === undefined || !usable(option.engine) || !usable(option.workModel)) return {};
    return { engine: option.engine, model: option.workModel };
  };
  const inFlight: FeedInFlightItem[] = [];
  for (const task of tasks) {
    if (task.environmentLifecycleState !== 'beginning' && task.environmentLifecycleState !== 'running') continue;
    if (!knownProject(task.projectId)) continue;
    const activeRun = usable(task.activeRunId) ? runsById.get(task.activeRunId) : undefined;
    inFlight.push({
      id: `task:${task.id}`,
      kind: 'task',
      lifecycle: taskLifecycleSentence(task),
      ...configuredIdentity(activeRun?.status === 'queued' || activeRun?.status === 'running' ? activeRun : undefined),
      scopes: [task.projectId],
      target: feedTarget({ surface: 'project-task-detail', projectId: task.projectId, taskId: task.id }),
      projectId: task.projectId,
      taskId: task.id,
      ...(usable(task.environmentInstanceId) ? { environmentInstanceId: task.environmentInstanceId } : {}),
      at: task.updatedAt,
    });
  }
  for (const run of runs) {
    if (run.status !== 'queued' && run.status !== 'running') continue;
    const task = usable(run.taskId) ? tasksById.get(run.taskId) : undefined;
    const target =
      task !== undefined && knownProject(task.projectId)
        ? feedTarget({ surface: 'project-task-detail', projectId: task.projectId, taskId: task.id })
        : knownProject(run.projectId)
          ? feedTarget({ surface: 'project-chat', projectId: run.projectId })
          : feedTarget({ surface: 'agent-detail', agentId: run.agentId });
    inFlight.push({
      id: `run:${run.id}`,
      kind: 'run',
      lifecycle: boundText(`Run ${run.status} · Agent ${run.agentId}${usable(run.taskId) ? ` · Task ${run.taskId}` : ''}${usable(run.environmentInstanceId) ? ` · Environment ${run.environmentInstanceId}` : ''}`),
      ...configuredIdentity(run),
      scopes: knownProject(run.projectId) ? [run.projectId] : [],
      ...(target !== undefined ? { target } : {}),
      ...(knownProject(run.projectId) ? { projectId: run.projectId } : {}),
      ...(usable(run.taskId) ? { taskId: run.taskId } : {}),
      agentId: run.agentId,
      ...(usable(run.environmentInstanceId) ? { environmentInstanceId: run.environmentInstanceId } : {}),
      at: run.createdAt,
    });
  }
  inFlight.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Operational activity: curated Project events plus terminal run
  // settlements as fact-form one-liners. A Project-scoped failed run already
  // has its durable `agent-run-failure` event, so only the event represents it
  // here; the run-derived entry covers the runs no event is published for.
  type ActivityDraft = { id: string; kind: string; summary: string; scopes: readonly string[]; target?: FeedTarget; projectId?: string; at: number };
  const activityDrafts: ActivityDraft[] = [];
  const seenTaskGroupActivity = new Set<string>();
  for (const task of tasks) {
    if (!knownProject(task.projectId)) continue;
    const target = feedTarget({ surface: 'project-task-detail', projectId: task.projectId, taskId: task.id });
    for (const [index, event] of (task.controlHistory ?? []).entries()) {
      if (event.action !== 'reopened') continue;
      const actor = `${event.actor.memberKind === 'human' ? 'Human' : 'Agent'} ${event.actor.memberId}`;
      activityDrafts.push({
        id: `task-reopened:${task.id}:${event.at}:${index}`,
        kind: 'task-reopened',
        summary: boundText(`Task reopened by ${actor}: ${event.reason}`, 300),
        scopes: [task.projectId],
        target,
        projectId: task.projectId,
        at: event.at,
      });
    }
  }
  for (const group of taskGroups) {
    if (!knownProject(group.projectId) || !safeChatIdentity(group.scopeId)) continue;
    const identity = `created:${group.scopeId}`;
    if (seenTaskGroupActivity.has(identity)) continue;
    seenTaskGroupActivity.add(identity);
    const title = boundText(group.taskTitle, 120);
    const target = taskGroupTarget(group);
    activityDrafts.push({
      id: `task-group-created:${group.scopeId}`,
      kind: 'task-group-created',
      summary: boundText(`Task group created for “${title || 'Task'}”.`, 300),
      scopes: [group.projectId],
      ...(target !== undefined ? { target } : {}),
      projectId: group.projectId,
      at: group.createdAt,
    });
  }
  for (const message of taskGroupMessages) {
    if (!knownProject(message.projectId) || (message.kind !== 'handoff' && message.kind !== 'assignment')) continue;
    const group = taskGroupByScope(message.projectId, message.scopeId);
    if (group === undefined || !safeChatIdentity(message.id)) continue;
    const identity = `message:${message.id}`;
    if (seenTaskGroupActivity.has(identity)) continue;
    seenTaskGroupActivity.add(identity);
    const title = boundText(group.taskTitle, 120);
    const kind = message.kind === 'handoff' ? 'task-group-handoff' : 'task-group-assignment';
    const target = taskGroupTarget(group, { messageId: message.id });
    activityDrafts.push({
      id: `task-group-message:${message.id}`,
      kind,
      summary: boundText(`${message.kind === 'handoff' ? 'Handoff' : 'Assignment'} posted in “${title || 'Task group'}”.`, 300),
      scopes: [message.projectId],
      ...(target !== undefined ? { target } : {}),
      projectId: message.projectId,
      at: message.createdAt,
    });
  }
  for (const event of events) {
    const summary = boundText(event.summary, 300);
    if (summary === '') continue;
    const projectKnown = knownProject(event.projectId);
    const eventRunId = event.deliveryKey.startsWith('run-failure:')
      ? event.deliveryKey.slice('run-failure:'.length)
      : undefined;
    const linkedFailureRun = eventRunId !== undefined ? runsById.get(eventRunId) : undefined;
    // This is a Project event row, so its own event takes focus over the linked run's causal Message; run activity below still focuses that Message.
    const linkedFailureEventTarget = projectKnown && linkedFailureRun?.projectId === event.projectId
      ? chatTarget(event.projectId, chatOriginsByRun.get(eventRunId!), linkedFailureRun.agentId, event.id)
      : undefined;
    const isChatEvent = /chat|message|routing|wake|run/i.test(event.kind);
    const escalation = taskGroupEscalationsByEventId.get(event.id);
    const eventScopeId = escalation?.scopeId ?? (event.originScopeIds?.length === 1 ? event.originScopeIds[0] : undefined);
    const taskGroup = eventScopeId !== undefined ? taskGroupByScope(event.projectId, eventScopeId) : undefined;
    const originMessageId = escalation?.messageId ?? event.originMessageId;
    const taskGroupEventTarget = taskGroup !== undefined && event.kind.startsWith('task-group-')
      ? taskGroupTarget(taskGroup, originMessageId !== undefined
        ? { messageId: originMessageId }
        : safeChatIdentity(event.id) ? { eventId: event.id } : {})
      : undefined;
    const chatEventTarget = projectKnown && isChatEvent && safeChatIdentity(event.id)
      ? feedTarget({
          surface: 'project-chat', projectId: event.projectId,
          ...(eventScopeId !== undefined && safeChatIdentity(eventScopeId) ? { scopeId: eventScopeId } : {}),
          eventId: event.id,
          ...(eventRunId !== undefined && safeChatIdentity(eventRunId) ? { runId: eventRunId } : {}),
          ...(event.producer.kind === 'agent' && safeChatIdentity(event.producer.id) ? { agentId: event.producer.id } : {}),
        })
      : undefined;
    const eventTarget = projectKnown
      ? linkedFailureEventTarget ?? taskGroupEventTarget ?? (isChatEvent
          ? chatEventTarget
          : feedTarget({ surface: 'project-overview', projectId: event.projectId }))
      : undefined;
    const eventSummary = boundText(taskGroup !== undefined && event.kind.startsWith('task-group-')
      ? `Task group “${boundText(taskGroup.taskTitle, 120)}”: ${summary}`
      : summary, 300);
    activityDrafts.push({
      id: `event:${event.id}`,
      kind: escalation !== undefined ? 'task-group-escalation' : event.kind,
      summary: eventSummary,
      scopes: projectKnown ? [event.projectId] : [],
      ...(eventTarget !== undefined ? { target: eventTarget } : {}),
      ...(projectKnown ? { projectId: event.projectId } : {}),
      at: event.createdAt,
    });
  }
  for (const run of runs) {
    if (!['completed', 'failed', 'stopped', 'interrupted'].includes(run.status)) continue;
    if (run.status === 'failed' && knownProject(run.projectId)) continue;
    const task = usable(run.taskId) ? tasksById.get(run.taskId) : undefined;
    const summary = boundText(`Agent run ${run.status} · ${run.agentId}${usable(run.taskId) ? ` · Task ${run.taskId}` : ''}`, 300);
    const target =
      task !== undefined && knownProject(task.projectId)
        ? feedTarget({ surface: 'project-task-detail', projectId: task.projectId, taskId: task.id })
        : knownProject(run.projectId)
          ? chatTarget(run.projectId, chatOriginsByRun.get(run.id), run.agentId)
          : feedTarget({ surface: 'agent-detail', agentId: run.agentId });
    activityDrafts.push({
      id: `run:${run.id}`,
      kind: 'agent-run',
      summary,
      scopes: knownProject(run.projectId) ? [run.projectId] : [],
      ...(target !== undefined ? { target } : {}),
      ...(knownProject(run.projectId) ? { projectId: run.projectId } : {}),
      at: run.completedAt ?? run.createdAt,
    });
  }
  activityDrafts.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const activity: FeedActivityItem[] = activityDrafts.slice(0, FEED_ACTIVITY_LIMIT);

  const projectIds = [...projectRefs.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const attentionCount = (id: string): number =>
    id === FEED_ALL_SCOPE
      ? attention.length
      : attention.reduce((count, item) => count + (feedScopeIncludes(item.scopes, id) ? 1 : 0), 0);
  const scopes: FeedScopeOption[] = [
    { id: FEED_ALL_SCOPE, kind: 'all', label: 'All Projects', attentionCount: attentionCount(FEED_ALL_SCOPE) },
    ...projectIds.map((id) => ({
      id,
      kind: 'project' as const,
      label: projectRefs.get(id)?.displayName ?? id,
      attentionCount: attentionCount(id),
    })),
    {
      id: FEED_INFRASTRUCTURE_SCOPE,
      kind: 'infrastructure',
      label: 'Infrastructure',
      attentionCount: attentionCount(FEED_INFRASTRUCTURE_SCOPE),
    },
  ];

  return { attention, inFlight, activity, scopes };
}
