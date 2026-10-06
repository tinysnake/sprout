/**
 * Durable conversation scopes and Working group authority (ADR-0008, #95).
 *
 * `CONTEXT.md` defines a **Working group** as "a temporary collaboration scope
 * within one Project, containing a subset of current Project members together
 * with an optional goal and rules, its own channel, and durable membership
 * history", and the ticket's **conversation scope** is the durable identity of
 * one of four communication contexts:
 *
 * 1. the one Project channel every Project has (an invariant of the Project);
 * 2. one Project-scoped direct conversation between two current members —
 *    its identity is bound to exactly one Project, so a pair that shares two
 *    Projects has two distinct conversations;
 * 3. one Working group channel, whose participants are the current members of
 *    one Working group inside exactly one Project; and
 * 4. one Task group, bound to exactly one Task and shared by current Project
 *    members for the duration of that Task (ADR-0014).
 *
 * A Working group and its channel are the same durable document. A Task group
 * is one document bound to a Task and carries versioned Task context. Nothing
 * here stores a Message: conversation history stays in the collaboration
 * store, and a read-only scope never deletes it.
 *
 * An archived Project, a disbanded Working group, an ended membership, or a
 * terminal Task makes its affected scope read-only while its recorded facts
 * and attribution remain durable.
 *
 * Privacy: no field here may carry a credential, provider/account identity,
 * hostname, address, absolute path, or raw command. Free text passes the
 * shared privacy boundary before it becomes durable.
 */

import { createHash } from 'node:crypto';
import { redactSensitiveText, sanitizeOperatorText } from '../environment/privacy.ts';

/** Which conversation scope a durable record describes. */
export type ConversationScopeKind = 'project' | 'direct' | 'working-group' | 'task-group';

/** Which kind of member a member id names: the local Human or an Agent. */
export type ConversationMemberKind = 'human' | 'agent';

/**
 * The member on whose authority a scope command runs.
 *
 * Routes behind the operator browser boundary construct the local Human's
 * actor from the Project's membership; the service still validates every
 * actor against the Project so authority is never assumed from transport
 * shape alone.
 */
export interface ConversationActor {
  readonly memberId: string;
  readonly kind: ConversationMemberKind;
}

interface ConversationScopeBase {
  /** The stable scope identity; also the channel identity consumers address. */
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The one Project channel (ADR-0008: an invariant of a Project, not template
 * content). Its participants are all current Project members; its read-only
 * state follows the Project's lifecycle.
 */
export interface ProjectChannelScope extends ConversationScopeBase {
  readonly kind: 'project';
}

/**
 * One Project-scoped direct conversation between two current members.
 *
 * The identity of the pair is canonicalized (sorted) and hashed together with
 * the Project, so opening the same pair twice yields one durable conversation
 * while the same pair in another Project yields a distinct one.
 */
export interface DirectConversationScope extends ConversationScopeBase {
  readonly kind: 'direct';
  /** The canonical (lexicographically sorted) participant pair. */
  readonly participants: readonly [string, string];
}

/**
 * One member's durable participation in one Working group.
 *
 * Ending a participation records the end of the relationship rather than
 * erasing it (ADR-0008): `addedAt`/`addedBy` and `endedAt`/`endedBy`/
 * `endedReason` all stay so historical attribution survives. A later re-add
 * appends a new entry instead of rewriting this one.
 */
export interface WorkingGroupMembership {
  readonly memberId: string;
  readonly memberKind: ConversationMemberKind;
  readonly addedAt: number;
  /** The member who added this participant (the creator at creation). */
  readonly addedBy: string;
  /** The sanitized operator reason recorded when the participant was added. */
  readonly addedReason?: string;
  readonly endedAt?: number;
  /**
   * Who ended the participation: an acting member's id, or the marker
   * `project-membership` when an ended Project membership cascaded here.
   */
  readonly endedBy?: string;
  readonly endedReason?: string;
}

/**
 * One append-only version of a Working group's editable content.
 *
 * The version is what makes the group's goal and rules attributable for later
 * routing and run context: a past admission resolves to the version it saw,
 * and Sprout presents the Project's and the group's versions side by side
 * without interpreting conflicts (ADR-0008).
 */
export interface WorkingGroupContentVersion {
  readonly version: number;
  readonly at: number;
  /** The member who made this edit. */
  readonly actorMemberId: string;
  readonly reason: string;
  readonly displayName: string;
  /** The sanitized group goal (may be empty: a Working group goal is optional). */
  readonly goal: string;
  readonly rules: readonly string[];
}

/**
 * One durable lifecycle transition of a Working group.
 *
 * Every disband and restore appends one entry instead of overwriting scalar
 * fields, so each transition stays durably attributable (who, when, why) and
 * every prior transition remains auditable — the same append-only attribution
 * rule content versions and memberships already follow (ADR-0008: "Every
 * effective edit records its actor, time, and changed version or facts").
 */
export interface WorkingGroupLifecycleEvent {
  readonly action: 'disband' | 'restore';
  readonly at: number;
  /** The member on whose authority the transition ran (creator or Human). */
  readonly actorMemberId: string;
  /** The sanitized operator reason recorded at the transition. */
  readonly reason: string;
}

/**
 * A durable Working group: identity, channel (the record itself), creator,
 * lifecycle history, version-attributed content, and membership history.
 *
 * Disbanded is a derived status over the append-only lifecycle history, never
 * a delete: its channel becomes read-only and all facts — every prior
 * transition included — remain available for audit and possible restore
 * (ADR-0008).
 */
export interface WorkingGroupScope extends ConversationScopeBase {
  readonly kind: 'working-group';
  readonly creatorId: string;
  readonly content: {
    readonly currentVersion: number;
    readonly versions: readonly WorkingGroupContentVersion[];
  };
  /** Current and historical participations; never rewritten in place. */
  readonly memberships: readonly WorkingGroupMembership[];
  /** Append-only disband/restore history; empty for a group never transitioned. */
  readonly lifecycle: readonly WorkingGroupLifecycleEvent[];
}

/** One immutable snapshot of the Task content governing a Task group. */
export interface TaskGroupContentVersion {
  readonly version: number;
  /** The Task content version this scope version was copied from. */
  readonly taskContentVersion: number;
  readonly at: number;
  readonly actorMemberId: string;
  readonly reason: string;
  readonly taskTitle: string;
  readonly goal: string;
  readonly rules: readonly string[];
}

/**
 * A temporary conversation scope bound permanently to one Task. Participation
 * is projected from current Project membership at read time. Content versions
 * preserve the exact Task goal and constraints presented to the group; a
 * terminal Task freezes the scope without deleting its history.
 */
export interface TaskGroupScope extends ConversationScopeBase {
  readonly kind: 'task-group';
  readonly taskId: string;
  readonly content: {
    readonly currentVersion: number;
    readonly versions: readonly TaskGroupContentVersion[];
  };
  readonly frozenAt?: number;
  readonly terminalTaskStatus?: 'done' | 'failed' | 'stopped' | 'cancelled';
}

/** One durable conversation scope. */
export type ConversationScope =
  | ProjectChannelScope
  | DirectConversationScope
  | WorkingGroupScope
  | TaskGroupScope;

export type ConversationScopeErrorCode =
  | 'invalid-identity'
  | 'invalid-display-name'
  | 'invalid-participants'
  | 'invalid-content'
  | 'unknown-project'
  | 'unknown-scope'
  | 'unknown-working-group'
  | 'not-a-project-member'
  | 'not-a-participant'
  | 'member-not-current'
  | 'already-a-member'
  | 'membership-not-active'
  | 'management-authority-required'
  | 'human-membership-required'
  | 'archived-project-is-read-only'
  | 'working-group-disbanded'
  | 'task-group-binding-conflict'
  | 'task-group-content-conflict'
  | 'task-group-frozen'
  | 'not-disbanded'
  | 'members-not-eligible'
  | 'stale-scope-write';

export class ConversationScopeError extends Error {
  readonly code: ConversationScopeErrorCode;

  constructor(code: ConversationScopeErrorCode, message: string) {
    super(message);
    this.name = 'ConversationScopeError';
    this.code = code;
  }
}

const MAX_DISPLAY_NAME = 120;
const MAX_TEXT = 4_000;
const MAX_REASON = 320;

/** The fallback for a content edit that carried no usable reason. */
export const DEFAULT_WORKING_GROUP_EDIT_REASON =
  'The Working group content was edited; its prior versions are preserved.';

/** The fallback for a disband that carried no usable reason. */
export const DEFAULT_WORKING_GROUP_DISBAND_REASON =
  'The Human or creator disbanded this Working group; its channel is read-only and its facts are preserved.';

/** The fallback for a cascade end caused by an ended Project membership. */
export const DEFAULT_PROJECT_MEMBERSHIP_END_REASON =
  'The Project membership ended, so this Working group participation ended with it; its history is preserved.';

/** The marker recording that an ended Project membership cascaded a participation end. */
export const PROJECT_MEMBERSHIP_ENDED_BY = 'project-membership';

/**
 * The stable identity of one Project's single Project channel.
 *
 * Deterministic so creation is idempotent across restarts and retries: the
 * Project's id is already unique, and the `channel-` prefix keeps this
 * namespace apart from `dm-` direct conversations and `wg-` Working groups.
 */
export function projectChannelScopeId(projectId: string): string {
  return `channel-${projectId}`;
}

/**
 * The stable identity of one Project-scoped direct conversation.
 *
 * The pair is sorted so participant order is irrelevant, and the digest binds
 * the pair to its Project: the same pair in two Projects hashes to two
 * distinct conversations, while a repeated open resolves to the same record.
 */
export function directConversationScopeId(
  projectId: string,
  participants: readonly [string, string],
): string {
  const pair = [...participants].sort();
  const digest = createHash('sha256')
    .update(JSON.stringify([projectId, pair]))
    .digest('hex');
  return `dm-${digest.slice(0, 32)}`;
}

/**
 * The canonical participant pair, or an error when the input is not two
 * distinct members of one Project.
 */
export function canonicalDirectParticipants(
  participants: readonly string[] | undefined,
): readonly [string, string] {
  const usable = (participants ?? []).filter(
    (entry): entry is string => typeof entry === 'string' && entry !== '',
  );
  if (usable.length !== 2 || usable[0] === usable[1]) {
    throw new ConversationScopeError(
      'invalid-participants',
      'a direct conversation requires exactly two distinct participants',
    );
  }
  const [first, second] = [...usable].sort();
  return [first!, second!];
}

/** The sanitized display name of a Working group, refusing an empty one. */
export function sanitizeWorkingGroupDisplayName(value: string | undefined): string {
  const name = sanitizeOperatorText(value, { fallback: '', maxLength: MAX_DISPLAY_NAME });
  if (name === '') {
    throw new ConversationScopeError(
      'invalid-display-name',
      'a Working group requires a non-empty display name',
    );
  }
  return name;
}

/**
 * The sanitized group goal.
 *
 * The goal is optional narrative: an omitted, empty, or fully-redacted goal
 * yields an empty goal rather than an invalid Working group (ADR-0008: optional
 * narrative must never become invalid identity).
 */
export function sanitizeWorkingGroupGoal(value: string | undefined): string {
  const text = redactSensitiveText((value ?? '').trim());
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1).trimEnd()}\u2026`;
}

/** Sanitize the group rules; unusable entries are dropped, the list may be empty. */
export function sanitizeWorkingGroupRules(
  value: readonly string[] | undefined,
): readonly string[] {
  const rules: string[] = [];
  for (const entry of value ?? []) {
    if (typeof entry !== 'string') continue;
    const text = redactSensitiveText(entry.trim());
    if (text === '') continue;
    rules.push(text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1).trimEnd()}\u2026`);
  }
  return rules;
}

/** The sanitized operator reason recorded for one Working group edit. */
export function sanitizeWorkingGroupReason(
  value: string | undefined,
  fallback: string = DEFAULT_WORKING_GROUP_EDIT_REASON,
): string {
  return sanitizeOperatorText(value, { fallback, maxLength: MAX_REASON });
}

/**
 * The Working group's current lifecycle status, derived from its history.
 *
 * The last transition decides: an empty history is a fresh `active` group, a
 * trailing `disband` renders it `disbanded`, a trailing `restore` renders it
 * `active`. Deriving keeps the status from ever diverging from the recorded
 * facts.
 */
export function workingGroupStatus(
  group: WorkingGroupScope,
): 'active' | 'disbanded' {
  const last = group.lifecycle[group.lifecycle.length - 1];
  return last !== undefined && last.action === 'disband' ? 'disbanded' : 'active';
}

/** The Working group's latest content version. */
export function currentWorkingGroupContent(
  group: WorkingGroupScope,
): WorkingGroupContentVersion {
  const versions = group.content.versions;
  const latest = versions[versions.length - 1];
  if (latest === undefined || latest.version !== group.content.currentVersion) {
    throw new ConversationScopeError(
      'invalid-content',
      `working group ${group.id} content history is inconsistent`,
    );
  }
  return latest;
}

/** The Working group's current participations (the ones that have not ended). */
export function activeWorkingGroupMembers(
  group: WorkingGroupScope,
): readonly WorkingGroupMembership[] {
  return group.memberships.filter((membership) => membership.endedAt === undefined);
}

export function taskGroupScopeId(taskId: string): string {
  const digest = createHash('sha256').update(taskId).digest('hex');
  return `tg-${digest.slice(0, 32)}`;
}

/** The Task group's current lifecycle status, derived from its frozen fact. */
export function taskGroupStatus(group: TaskGroupScope): 'active' | 'frozen' {
  return group.frozenAt === undefined ? 'active' : 'frozen';
}

/** Whether a scope is a Task group record. */
export function isTaskGroup(scope: ConversationScope): scope is TaskGroupScope {
  return scope.kind === 'task-group';
}

/** The Task group's latest bound Task content version. */
export function currentTaskGroupContent(group: TaskGroupScope): TaskGroupContentVersion {
  const latest = group.content.versions.at(-1);
  if (latest === undefined || latest.version !== group.content.currentVersion) {
    throw new ConversationScopeError('task-group-content-conflict', `task group ${group.id} content history is inconsistent`);
  }
  return latest;
}

/** Whether a scope is a Working group record. */
export function isWorkingGroup(
  scope: ConversationScope,
): scope is WorkingGroupScope {
  return scope.kind === 'working-group';
}

/** Why a scope is read-only for one acting member, when it is. */
export type ScopeStateReason =
  | 'project-archived'
  | 'working-group-disbanded'
  | 'task-group-frozen'
  | 'task-group-task-unavailable'
  | 'task-group-lifecycle-unavailable'
  | 'membership-ended'
  | 'not-a-member'
  | 'not-a-participant';

/**
 * The admission state of one scope for one acting member.
 *
 * Later consumers (Messages and routing, #96) ask this before recording a
 * Message: `writable: false` means the scope is read-only for this actor, and
 * `reason` says which settled rule made it so. History is never affected.
 */
export interface ScopeState {
  readonly scopeId: string;
  readonly writable: boolean;
  readonly reason?: ScopeStateReason;
}

/** The governing Project facts a scope's run or routing context receives. */
export interface ScopeProjectContext {
  /**
   * The Project content version governing this scope. `0` means a
   * host-configured Project without version history (M1 projection).
   */
  readonly contentVersion: number;
  readonly goal: string;
  readonly rules: readonly string[];
}

/** The governing Working group facts a Working group scope adds. */
export interface ScopeWorkingGroupContext {
  readonly displayName: string;
  readonly contentVersion: number;
  readonly goal: string;
  readonly rules: readonly string[];
}

export interface ScopeTaskGroupContext {
  readonly taskId: string;
  readonly taskTitle: string;
  /** The version of this scope's Task-specific content projection. */
  readonly contentVersion: number;
  /** The originating Task content version. */
  readonly taskContentVersion: number;
  readonly goal: string;
  readonly rules: readonly string[];
}

/**
 * The durable goal/rules facts that govern one scope, ready for later routing
 * and run context.
 *
 * Both halves are returned verbatim as separate versioned facts: Sprout does
 * not merge them, order them, or interpret conflicts between them
 * (ADR-0008: "it does not interpret conflicts, enforce a rule-precedence
 * algorithm, or decide whether one rule weakens another").
 */
export interface ScopeContext {
  readonly scopeId: string;
  readonly projectId: string;
  readonly kind: ConversationScopeKind;
  readonly project: ScopeProjectContext;
  /** Present only for a Working group scope. */
  readonly workingGroup?: ScopeWorkingGroupContext;
  /** Present only for a Task group scope. */
  readonly taskGroup?: ScopeTaskGroupContext;
}
