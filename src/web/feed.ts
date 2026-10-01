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
import type { RoutingBatch } from '../collaboration/routing.ts';
import type { EnvironmentEnrollment } from '../environment/enrollment.ts';
import type { EnvironmentRecoveryRecord } from '../environment/recovery.ts';
import type { AgentRun } from '../run/model.ts';
import type { Task } from '../task/model.ts';
import type { TaskProposal } from '../task/proposal-model.ts';

/** Synthetic scopes contain a colon, which sanitizeProjectId cannot preserve. */
export const FEED_ALL_SCOPE = 'feed:all';
/** The generic infrastructure scope; never a Project id. */
export const FEED_INFRASTRUCTURE_SCOPE = 'feed:infra';
/** Newest-first bound on the operational activity stream. */
export const FEED_ACTIVITY_LIMIT = 50;
/** The character bound on any summary or reason text the Feed emits. */
export const FEED_TEXT_LIMIT = 400;

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
  | 'human-action-required';

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
  /** The Manage Environments route key (enrollment key), not the instance id. */
  readonly environmentId?: string;
  readonly agentId?: string;
}

/** One deep-link identity: the owning surface plus a concrete route path. */
export interface FeedTarget extends FeedTargetIdentity {
  /** Canonical route path relative to the router root; no origin, no base. */
  readonly path: string;
}

function usable(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
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
  readonly source: { readonly kind: 'proposal' | 'task' | 'recovery' | 'enrollment' | 'routing-batch' | 'wake-input' | 'event'; readonly id: string };
  readonly at: number;
}

/** One currently executing Task or Agent run (story 14). */
export interface FeedInFlightItem {
  readonly id: string;
  readonly kind: 'task' | 'run';
  readonly lifecycle: string;
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
      return task.endDisposition === 'cancelled' ? 'Task cancelled' : 'Task completed';
    case 'recovery':
      return 'Task recovery';
    case 'discarded':
      return 'Task cancelled';
    default:
      switch (task.status) {
        case 'in-progress':
          return 'Task active';
        case 'blocked':
          return 'Task blocked';
        case 'done':
          return 'Task completed';
        case 'cancelled':
        case 'failed':
          return 'Task cancelled';
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
  const [projects, tasks, proposals, events, enrollments, recoveries, runs, batches, wakeFailures, resolutions] = await Promise.all([
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
  ]);

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
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
  const knownProject = (projectId: string | undefined): projectId is string =>
    usable(projectId) && projectRefs.has(projectId!);

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
      && !['done', 'cancelled', 'failed'].includes(task.status)) {
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

  // 8. Authoritative human-action-required Project events (ADR-0007). Other
  // dispositions never become attention: an addressed event has an Agent, and
  // an informational event is background activity.
  for (const event of events) {
    if (event.disposition !== 'human-action-required' || !knownProject(event.projectId) || resolved('event', event.id, event.projectId)) continue;
    attention.push({
      id: `event:${event.id}`,
      severity: 'action_required',
      category: 'human-action-required',
      reason: boundText(event.summary),
      lifecycle: boundText(`Project event · Human action required · ${event.kind}`),
      target: feedTarget({ surface: 'project-overview', projectId: event.projectId }),
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
  // running Agent run (story 14). Identity and lifecycle only — a run's
  // prompt, events, result, and failure are never projected.
  const inFlight: FeedInFlightItem[] = [];
  for (const task of tasks) {
    if (task.environmentLifecycleState !== 'beginning' && task.environmentLifecycleState !== 'running') continue;
    if (!knownProject(task.projectId)) continue;
    inFlight.push({
      id: `task:${task.id}`,
      kind: 'task',
      lifecycle: taskLifecycleSentence(task),
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
  for (const event of events) {
    const summary = boundText(event.summary, 300);
    if (summary === '') continue;
    const projectKnown = knownProject(event.projectId);
    activityDrafts.push({
      id: `event:${event.id}`,
      kind: event.kind,
      summary,
      scopes: projectKnown ? [event.projectId] : [],
      ...(projectKnown
        ? { target: feedTarget({ surface: 'project-overview', projectId: event.projectId }), projectId: event.projectId }
        : {}),
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
          ? feedTarget({ surface: 'project-chat', projectId: run.projectId })
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
