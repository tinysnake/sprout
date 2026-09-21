/**
 * Durable Project, membership, and template-snapshot authority (ADR-0008, #92).
 *
 * `CONTEXT.md` defines a **Project** as "a durable collaboration and management
 * boundary with its own members, optional goal and rules, Environment access,
 * Project workspaces, channels, and history. A Project remains complete when it
 * has no Agent or Environment, although it cannot begin Agent work until the
 * required resources are present."
 *
 * The vocabulary here is the M2 authority boundary the orchestrator's M1
 * `Project` (`model.ts`) is a working projection of:
 *
 * - Project creation requires only a stable identity, a non-empty display
 *   name, the local Human's membership, and its Project channel (an invariant,
 *   not stored content). Missing Agents or Environments limit what the Project
 *   can do; they never invalidate its identity (ADR-0008, rejected
 *   alternative).
 * - Project creation copies the immutable General collaboration template into
 *   an **editable, version-attributed snapshot** and never links the Project to
 *   the template afterwards; later template changes do not rewrite an
 *   established Project.
 * - Every effective edit appends a durable content version, so goal, rules,
 *   wake policy, routing interval, Agent membership, responsibilities, and
 *   collaboration instructions are attributable for later work.
 * - Membership ending and Project archive/restore are non-destructive: they
 *   record the end of a relationship rather than erasing it, and they refuse
 *   while active work depends on the Project or member.
 *
 * Privacy: no field here may carry a credential, provider/account identity,
 * hostname, address, absolute path, or raw command. Free text passes the
 * shared privacy boundary before it becomes durable.
 */

import { sanitizeIdentifier, sanitizeOperatorText, redactSensitiveText } from '../environment/privacy.ts';

/** The Project lifecycle. Archived is a status, never a delete (ADR-0008). */
export type ProjectStatus = 'active' | 'archived';

/**
 * The Project-level routing choice (ADR-0007).
 *
 * `explicit-only` routes deterministically addressed inputs and leaves
 * unaddressed ones durable without model evaluation; `wake-model-assisted`
 * collects eligible unaddressed inputs for model judgement. This is the
 * Project's declared policy, persisted and versioned with its content.
 */
export type WakePolicy = 'explicit-only' | 'wake-model-assisted';

/** Which kind of member a membership names: the local Human or an Agent. */
export type ProjectMemberKind = 'human' | 'agent';

/**
 * One member's responsibilities and collaboration instructions within a
 * project (CONTEXT.md, **Project membership**).
 *
 * A membership references a global Human or Agent; it does not copy or own
 * that identity (ADR-0008).
 */
export interface ProjectMembership {
  readonly memberId: string;
  readonly memberKind: ProjectMemberKind;
  /** What this member is responsible for in the project. */
  readonly responsibilities: readonly string[];
  /** How this member should collaborate with the rest of the project. */
  readonly collaborationInstructions: string;
  /** When the membership began, in epoch milliseconds. */
  readonly startedAt: number;
  /**
   * When the membership ended, if it did. An ended membership keeps its
   * responsibilities, instructions, and history for attribution; it only stops
   * new communication and new runs (ADR-0008).
   */
  readonly endedAt?: number;
  /** The sanitized operator reason recorded when the membership ended. */
  readonly endedReason?: string;
}

/**
 * One append-only version of a Project's editable content.
 *
 * The version is what makes goal, rules, wake policy, routing interval,
 * memberships, responsibilities, and collaboration instructions attributable
 * for later work: an old version is never rewritten, so a past run's or Task's
 * contract version always resolves to the content it was admitted under — the
 * same guarantee Agent configuration versions give run attribution.
 */
export interface ProjectContentVersion {
  readonly version: number;
  readonly at: number;
  /** The sanitized operator reason recorded for this version. */
  readonly reason: string;
  /** The sanitized shared goal (may be empty: goal is optional). */
  readonly goal: string;
  readonly rules: readonly string[];
  readonly wakePolicy: WakePolicy;
  readonly routingIntervalMs: number;
  /** Current memberships, including already-ended ones for history. */
  readonly memberships: readonly ProjectMembership[];
}

/** The template attribution recorded once, at creation. */
export interface ProjectTemplateSnapshot {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateName: string;
  /** The snapshot of the template's collaboration guidance, taken at creation. */
  readonly collaborationGuidance: string;
  readonly completionGuidance: string;
}

/** A durable Project authority record. */
export interface ProjectAuthority {
  readonly id: string;
  /** The non-empty display name. */
  readonly displayName: string;
  readonly status: ProjectStatus;
  readonly template: ProjectTemplateSnapshot;
  readonly content: {
    readonly currentVersion: number;
    readonly versions: readonly ProjectContentVersion[];
  };
  readonly createdAt: number;
  readonly updatedAt: number;
  /** When the Project was archived, if it is. */
  readonly archivedAt?: number;
  /** The sanitized operator reason recorded when the Project was archived. */
  readonly archivedReason?: string;
  /** When the Project was restored, if it ever was. */
  readonly restoredAt?: number;
}

export type ProjectAuthorityErrorCode =
  | 'invalid-display-name'
  | 'invalid-identity'
  | 'invalid-content'
  | 'unknown-project'
  | 'unknown-agent'
  | 'already-archived'
  | 'not-archived'
  | 'archived-project-is-read-only'
  | 'active-work-depends-on-project'
  | 'membership-not-active'
  | 'human-membership-required';

export class ProjectAuthorityError extends Error {
  readonly code: ProjectAuthorityErrorCode;

  constructor(code: ProjectAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'ProjectAuthorityError';
    this.code = code;
  }
}

const MAX_DISPLAY_NAME = 120;
const MAX_TEXT = 4_000;
const MIN_ROUTING_INTERVAL_MS = 1_000;
const MAX_ROUTING_INTERVAL_MS = 3_600_000;

/** The fallback for an edit reason that sanitized to nothing. */
export const DEFAULT_PROJECT_EDIT_REASON = 'The Project content was edited; its prior versions are preserved.';

/** The fallback for an ended-membership reason that sanitized to nothing. */
export const DEFAULT_END_MEMBERSHIP_REASON =
  'The Human ended this Project membership; its history and attribution are preserved.';

/** The sanitized display name, or an error when nothing usable remains. */
export function sanitizeProjectDisplayName(value: string | undefined): string {
  const name = sanitizeOperatorText(value, { fallback: '', maxLength: MAX_DISPLAY_NAME });
  if (name === '') {
    throw new ProjectAuthorityError('invalid-display-name', 'a Project requires a non-empty display name');
  }
  return name;
}

/**
 * Sanitize the shared goal.
 *
 * The goal is optional narrative: an omitted, empty, or fully-redacted goal
 * yields an empty goal rather than an invalid Project (ADR-0008: optional
 * narrative must never become invalid identity).
 */
export function sanitizeProjectGoal(value: string | undefined): string {
  const text = redactSensitiveText((value ?? '').trim());
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1).trimEnd()}\u2026`;
}

/**
 * Sanitize the rules list. Rules are free operator text; entries that reduce
 * to nothing usable are dropped, and the whole list may be empty.
 */
export function sanitizeProjectRules(value: readonly string[] | undefined): readonly string[] {
  const rules: string[] = [];
  for (const entry of value ?? []) {
    if (typeof entry !== 'string') continue;
    const text = redactSensitiveText(entry.trim());
    if (text === '') continue;
    rules.push(text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1).trimEnd()}\u2026`);
  }
  return rules;
}

/** Validate and clamp the routing interval (ADR-0007: fixed, bounded window). */
export function sanitizeRoutingIntervalMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 30_000;
  const bounded = Math.floor(value);
  if (bounded < MIN_ROUTING_INTERVAL_MS) return MIN_ROUTING_INTERVAL_MS;
  if (bounded > MAX_ROUTING_INTERVAL_MS) return MAX_ROUTING_INTERVAL_MS;
  return bounded;
}

/** Validate the wake policy, defaulting to explicit-only for migrated inputs. */
export function sanitizeWakePolicy(value: string | undefined): WakePolicy {
  return value === 'wake-model-assisted' ? 'wake-model-assisted' : 'explicit-only';
}

/**
 * Sanitize one membership's free-text fields.
 *
 * Responsibilities and collaboration instructions are optional; text that
 * reduces to nothing usable becomes an empty value, not a refusal, because a
 * membership is valid without them (ADR-0008: "Membership-specific
 * responsibilities and collaboration instructions are optional").
 */
export function sanitizeMembershipText(input: {
  readonly responsibilities?: readonly string[];
  readonly collaborationInstructions?: string;
}): { readonly responsibilities: readonly string[]; readonly collaborationInstructions: string } {
  return {
    responsibilities: sanitizeProjectRules(input.responsibilities),
    collaborationInstructions: sanitizeProjectGoal(input.collaborationInstructions),
  };
}

/** Sanitize a stable Project identity slug, or refuse it. */
export function sanitizeProjectId(value: string | undefined): string | undefined {
  const id = sanitizeIdentifier(value ?? '', { fallback: '', kind: 'generic', maxLength: 64 });
  return id === '' ? undefined : id;
}

/** The membership with this member id, if the Project records one. */
export function membershipForMemberId(
  project: ProjectAuthority,
  memberId: string,
): ProjectMembership | undefined {
  const current = currentProjectContent(project);
  return current.memberships.find((membership) => membership.memberId === memberId);
}

/** Whether this member's membership exists and has not ended. */
export function membershipIsActive(project: ProjectAuthority, memberId: string): boolean {
  const membership = membershipForMemberId(project, memberId);
  return membership !== undefined && membership.endedAt === undefined;
}

/** The Project's current Agent member ids, excluding ended memberships. */
export function activeAgentMemberIds(project: ProjectAuthority): readonly string[] {
  return currentProjectContent(project)
    .memberships.filter((membership) => membership.memberKind === 'agent' && membership.endedAt === undefined)
    .map((membership) => membership.memberId);
}

/** The Project's latest content version. */
export function currentProjectContent(project: ProjectAuthority): ProjectContentVersion {
  const versions = project.content.versions;
  const latest = versions[versions.length - 1];
  if (latest === undefined || latest.version !== project.content.currentVersion) {
    throw new ProjectAuthorityError('invalid-content', `project ${project.id} content history is inconsistent`);
  }
  return latest;
}
