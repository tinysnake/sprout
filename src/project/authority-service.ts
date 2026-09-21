import {
  DEFAULT_END_MEMBERSHIP_REASON,
  DEFAULT_PROJECT_EDIT_REASON,
  ProjectAuthorityError,
  currentProjectContent,
  sanitizeMembershipText,
  sanitizeProjectDisplayName,
  sanitizeProjectGoal,
  sanitizeProjectId,
  sanitizeProjectRules,
  sanitizeRoutingIntervalMs,
  sanitizeWakePolicy,
  type ProjectAuthority,
  type ProjectContentVersion,
  type ProjectMembership,
  type WakePolicy,
} from './authority-model.ts';
import type { ProjectAuthorityStore } from './authority-store.ts';
import { GENERAL_COLLABORATION_TEMPLATE, type ProjectTemplate } from './template.ts';
import { sanitizeOperatorText } from '../environment/privacy.ts';

/**
 * The caller-facing Project, template, and membership authority (ADR-0008, #92).
 *
 * This Module owns the one lifecycle rule set for durable Projects: create
 * from the built-in template, edit content as a new version, add and end
 * memberships, and archive/restore. It deliberately owns no run, no lease, and
 * no Task:
 *
 * - the active-work facts an archive or membership end checks arrive through a
 *   narrow read-only port, so the run and Task domains remain the one owners
 *   of work state; and
 * - every effective edit appends a new durable content version, so a past
 *   run's or Task's contract version always resolves to the content it was
 *   admitted under.
 *
 * Authority: only the Human may create Projects and add or end Agent Project
 * memberships (ADR-0008). The routes are mounted behind the operator browser
 * boundary, so every caller of this service through HTTP is the authenticated
 * Human; the service itself stays transport-free.
 *
 * Archive/restore and membership ending are non-destructive: identity,
 * template attribution, content versions, and membership history are retained
 * verbatim, and an archived Project is read-only.
 */

/**
 * The narrow read-only surface this Module needs to prove no active work
 * depends on a Project or its member.
 */
export interface ProjectWorkSafetyPort {
  /** Whether any queued or running run is executing inside this Project. */
  hasActiveRun(projectId: string): Promise<boolean> | boolean;
  /** Whether the Project owns a Task that has not reached a terminal status. */
  hasUnfinishedTask(projectId: string): Promise<boolean> | boolean;
  /** Whether the member has a run that is queued or running in this Project. */
  memberHasActiveRun(projectId: string, memberId: string): Promise<boolean> | boolean;
  /**
   * Whether the member leads, or is the assigned agent of, a Task in this
   * Project that has not reached a terminal status.
   */
  memberHasUnfinishedTask(projectId: string, memberId: string): Promise<boolean> | boolean;
}

export interface ProjectServiceOptions {
  readonly store: ProjectAuthorityStore;
  readonly workSafety?: ProjectWorkSafetyPort;
  /** The template source; production uses the built-in General template. */
  readonly template?: ProjectTemplate;
  readonly clock?: () => number;
  /** Stable id generator, injectable so tests control identity. */
  readonly createId?: () => string;
  /** Who created the Project: the local Human operator's member id. */
  readonly operatorMemberId?: string;
}

export interface CreateProjectInput {
  /** The stable identity slug. Omitted ids are generated. */
  readonly id?: string;
  readonly displayName: string;
  /** Optional goal: an absent or empty goal never invalidates the Project. */
  readonly goal?: string;
  readonly rules?: readonly string[];
  readonly wakePolicy?: string;
  readonly routingIntervalMs?: number;
  /**
   * Agent memberships to create atomically with the Project. The local
   * Human's membership is always created with it (ADR-0008).
   */
  readonly agentMemberships?: readonly {
    readonly agentId: string;
    readonly responsibilities?: readonly string[];
    readonly collaborationInstructions?: string;
  }[];
  /** The sanitized operator reason recorded on the first content version. */
  readonly reason?: string;
}

export interface UpdateProjectContentInput {
  /** `undefined` keeps the current goal; a string (possibly empty) replaces it. */
  readonly goal?: string;
  /** `undefined` keeps the current rules; an array (possibly empty) replaces them. */
  readonly rules?: readonly string[];
  readonly wakePolicy?: string;
  readonly routingIntervalMs?: number;
  /** The sanitized operator reason recorded on the new version. */
  readonly reason?: string;
}

export interface AddMembershipInput {
  readonly agentId: string;
  readonly responsibilities?: readonly string[];
  readonly collaborationInstructions?: string;
  /** The sanitized operator reason recorded on the new content version. */
  readonly reason?: string;
}

export interface EndMembershipInput {
  /** The sanitized operator reason recorded on the ended membership. */
  readonly reason?: string;
}

export interface ArchiveInput {
  /** The sanitized operator reason recorded on the archive. */
  readonly reason?: string;
}

/**
 * The Project, template-snapshot, and membership capability.
 */
export class ProjectService {
  readonly #store: ProjectAuthorityStore;
  readonly #workSafety: ProjectWorkSafetyPort | undefined;
  readonly #template: ProjectTemplate;
  readonly #clock: () => number;
  readonly #createId: () => string;
  readonly #operatorMemberId: string;

  constructor(options: ProjectServiceOptions) {
    this.#store = options.store;
    this.#workSafety = options.workSafety;
    this.#template = options.template ?? GENERAL_COLLABORATION_TEMPLATE;
    this.#clock = options.clock ?? Date.now;
    this.#createId = options.createId ?? (() => `project-${Math.random().toString(36).slice(2, 10)}`);
    this.#operatorMemberId = options.operatorMemberId ?? 'operator';
  }

  /**
   * Create one Project from the immutable template.
   *
   * One submission atomically creates the Project record, the editable
   * version-attributed template snapshot, the Human's membership, and any
   * selected Agent memberships. Missing Agents or Environments limit what the
   * Project can do; they never invalidate its identity.
   */
  async create(input: CreateProjectInput): Promise<ProjectAuthority> {
    const now = this.#clock();
    const id = input.id !== undefined ? sanitizeProjectId(input.id) : this.#createId();
    if (id === undefined) {
      throw new ProjectAuthorityError('invalid-identity', 'a Project requires a valid stable identity');
    }
    if (await this.#store.get(id) !== undefined) {
      throw new ProjectAuthorityError('invalid-identity', `a Project with identity ${id} already exists`);
    }
    const memberships: ProjectMembership[] = [
      {
        memberId: this.#operatorMemberId,
        memberKind: 'human',
        responsibilities: [],
        collaborationInstructions: '',
        startedAt: now,
      },
    ];
    for (const membership of input.agentMemberships ?? []) {
      const agentId = sanitizeProjectId(membership.agentId);
      if (agentId === undefined) {
        throw new ProjectAuthorityError('invalid-identity', 'an Agent membership requires a valid Agent identity');
      }
      if (memberships.some((existing) => existing.memberId === agentId)) {
        throw new ProjectAuthorityError('invalid-identity', `duplicate membership for ${agentId}`);
      }
      memberships.push({
        memberId: agentId,
        memberKind: 'agent',
        ...sanitizeMembershipText(membership),
        startedAt: now,
      });
    }

    const firstVersion: ProjectContentVersion = {
      version: 1,
      at: now,
      reason: sanitizeEditReason(input.reason),
      goal: sanitizeProjectGoal(input.goal),
      rules: sanitizeProjectRules(input.rules),
      wakePolicy: sanitizeWakePolicy(input.wakePolicy),
      routingIntervalMs: sanitizeRoutingIntervalMs(input.routingIntervalMs),
      memberships,
    };

    const project: ProjectAuthority = {
      id,
      displayName: sanitizeProjectDisplayName(input.displayName),
      status: 'active',
      // The template attribution is a copy taken at creation. The Project is
      // never linked to the template afterwards: later template changes do not
      // rewrite an established Project (ADR-0008).
      template: {
        templateId: this.#template.id,
        templateVersion: this.#template.version,
        templateName: this.#template.name,
        collaborationGuidance: this.#template.collaborationGuidance,
        completionGuidance: this.#template.completionGuidance,
      },
      content: { currentVersion: 1, versions: [firstVersion] },
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.save(project);
    return project;
  }

  /** Every durable Project, including archived ones (archived is a status). */
  async list(): Promise<readonly ProjectAuthority[]> {
    return this.#store.list();
  }

  async get(projectId: string): Promise<ProjectAuthority | undefined> {
    return this.#store.get(projectId);
  }

  /**
   * Append one content version.
   *
   * The edit affects only later message delivery, Task admission, and Agent
   * runs: an active run keeps the version it was admitted under, and previous
   * versions are never rewritten. A policy or interval change takes effect on
   * the next routing window (ADR-0007). An archived Project is read-only.
   */
  async updateContent(projectId: string, input: UpdateProjectContentInput): Promise<ProjectAuthority> {
    const project = await this.#require(projectId);
    this.#assertEditable(project);
    const now = this.#clock();
    const current = currentProjectContent(project);
    const next: ProjectAuthority = {
      ...project,
      content: {
        currentVersion: project.content.currentVersion + 1,
        versions: [
          ...project.content.versions,
          {
            version: project.content.currentVersion + 1,
            at: now,
            reason: sanitizeEditReason(input.reason),
            goal: input.goal === undefined ? current.goal : sanitizeProjectGoal(input.goal),
            rules: input.rules === undefined ? current.rules : sanitizeProjectRules(input.rules),
            wakePolicy: input.wakePolicy === undefined ? current.wakePolicy : sanitizeWakePolicy(input.wakePolicy),
            routingIntervalMs: input.routingIntervalMs === undefined
              ? current.routingIntervalMs
              : sanitizeRoutingIntervalMs(input.routingIntervalMs),
            memberships: current.memberships,
          },
        ],
      },
      updatedAt: now,
    };
    await this.#store.save(next);
    return next;
  }

  /**
   * Add one Agent membership. Only the Human may do this; the routes behind
   * the operator boundary enforce it, and an Agent cannot join a Project or
   * invite another Agent (ADR-0008).
   */
  async addMembership(projectId: string, input: AddMembershipInput): Promise<ProjectAuthority> {
    const project = await this.#require(projectId);
    this.#assertEditable(project);
    const agentId = sanitizeProjectId(input.agentId);
    if (agentId === undefined) {
      throw new ProjectAuthorityError('invalid-identity', 'an Agent membership requires a valid Agent identity');
    }
    const now = this.#clock();
    const current = currentProjectContent(project);
    const existing = current.memberships.find((membership) => membership.memberId === agentId);
    if (existing !== undefined && existing.endedAt === undefined) {
      throw new ProjectAuthorityError('invalid-identity', `${agentId} is already a member of ${projectId}`);
    }
    // A previously ended membership is restored as a fresh relationship: the
    // old entry keeps its end facts for attribution, and the new one starts
    // its own history.
    const memberships = current.memberships.filter((membership) => membership.memberId !== agentId);
    memberships.push({
      memberId: agentId,
      memberKind: 'agent',
      ...sanitizeMembershipText(input),
      startedAt: now,
    });
    return this.#appendVersion(project, now, sanitizeEditReason(input.reason), { memberships });
  }

  /**
   * End one membership (ADR-0008, non-destructive).
   *
   * Ending prevents new Project communication and Agent runs while preserving
   * historical attribution: the membership entry keeps its responsibilities,
   * instructions, start, and now its end facts. Refused while the member has
   * active work depending on the Project; a run already admitted may settle
   * naturally or be interrupted by the Human, and an unfinished Task that
   * depends on the member exposes a blocker rather than a silent substitute.
   */
  async endMembership(projectId: string, memberId: string, input: EndMembershipInput = {}): Promise<ProjectAuthority> {
    const project = await this.#require(projectId);
    this.#assertEditable(project);
    const current = currentProjectContent(project);
    const membership = current.memberships.find((entry) => entry.memberId === memberId);
    if (membership === undefined || membership.endedAt !== undefined) {
      throw new ProjectAuthorityError('membership-not-active', `${memberId} has no active membership in ${projectId}`);
    }
    if (membership.memberKind === 'human') {
      throw new ProjectAuthorityError(
        'human-membership-required',
        'the local Human cannot be removed from the Project',
      );
    }
    if (this.#workSafety !== undefined) {
      if (await this.#workSafety.memberHasActiveRun(projectId, memberId)) {
        throw new ProjectAuthorityError(
          'active-work-depends-on-project',
          `${memberId} has an active run in ${projectId}; settle or stop it before ending the membership`,
        );
      }
      if (await this.#workSafety.memberHasUnfinishedTask(projectId, memberId)) {
        throw new ProjectAuthorityError(
          'active-work-depends-on-project',
          `${memberId} is assigned to an unfinished Task in ${projectId}; end or reassign it first`,
        );
      }
    }
    const now = this.#clock();
    const endedReason = sanitizeOperatorText(input.reason, {
      fallback: DEFAULT_END_MEMBERSHIP_REASON,
      maxLength: 320,
    });
    const memberships = current.memberships.map((entry) =>
      entry === membership
        ? { ...entry, endedAt: now, ...(endedReason !== '' ? { endedReason } : {}) }
        : entry,
    );
    return this.#appendVersion(project, now, sanitizeEditReason(input.reason), { memberships });
  }

  /**
   * Archive one Project (ADR-0008, non-destructive).
   *
   * Refused while the Project has an active run, an unfinished Task, or any
   * dependent work: the archive would make its channels read-only and bar
   * proposals and new work, so nothing may be mid-flight. Memberships,
   * history, bindings, and attribution are all retained.
   */
  async archive(projectId: string, input: ArchiveInput = {}): Promise<ProjectAuthority> {
    const project = await this.#require(projectId);
    if (project.status === 'archived') {
      throw new ProjectAuthorityError('already-archived', `project ${projectId} is already archived`);
    }
    if (this.#workSafety !== undefined) {
      if (await this.#workSafety.hasActiveRun(projectId)) {
        throw new ProjectAuthorityError(
          'active-work-depends-on-project',
          `project ${projectId} has an active run; settle or stop it before archiving`,
        );
      }
      if (await this.#workSafety.hasUnfinishedTask(projectId)) {
        throw new ProjectAuthorityError(
          'active-work-depends-on-project',
          `project ${projectId} has an unfinished Task; end it before archiving`,
        );
      }
    }
    const now = this.#clock();
    const archivedReason = sanitizeOperatorText(input.reason, {
      fallback: 'The Human archived this Project; its history and memberships are preserved.',
      maxLength: 320,
    });
    const next: ProjectAuthority = {
      ...project,
      status: 'archived',
      updatedAt: now,
      archivedAt: now,
      archivedReason,
    };
    await this.#store.save(next);
    return next;
  }

  /**
   * Restore one archived Project.
   *
   * Restore is always safe: nothing was deleted, so restoring only re-enables
   * new work. Compatibility is re-derived from current facts by the callers of
   * this Module's read paths, never stored here.
   */
  async restore(projectId: string): Promise<ProjectAuthority> {
    const project = await this.#require(projectId);
    if (project.status !== 'archived') {
      throw new ProjectAuthorityError('not-archived', `project ${projectId} is not archived`);
    }
    const now = this.#clock();
    const next: ProjectAuthority = {
      ...project,
      status: 'active',
      updatedAt: now,
      restoredAt: now,
    };
    await this.#store.save(next);
    return next;
  }

  /**
   * Append one content version carrying the given membership set.
   *
   * Every other content field is carried over unchanged, so a membership
   * change is one attributable version like any other edit.
   */
  async #appendVersion(
    project: ProjectAuthority,
    at: number,
    reason: string,
    overrides: { readonly memberships: readonly ProjectMembership[]; readonly wakePolicy?: WakePolicy },
  ): Promise<ProjectAuthority> {
    const current = currentProjectContent(project);
    const next: ProjectAuthority = {
      ...project,
      content: {
        currentVersion: project.content.currentVersion + 1,
        versions: [
          ...project.content.versions,
          {
            version: project.content.currentVersion + 1,
            at,
            reason,
            goal: current.goal,
            rules: current.rules,
            wakePolicy: overrides.wakePolicy ?? current.wakePolicy,
            routingIntervalMs: current.routingIntervalMs,
            memberships: overrides.memberships,
          },
        ],
      },
      updatedAt: at,
    };
    await this.#store.save(next);
    return next;
  }

  async #require(projectId: string): Promise<ProjectAuthority> {
    const project = await this.#store.get(projectId);
    if (project === undefined) {
      throw new ProjectAuthorityError('unknown-project', `unknown project: ${projectId}`);
    }
    return project;
  }

  /** An archived Project is read-only (ADR-0008). */
  #assertEditable(project: ProjectAuthority): void {
    if (project.status === 'archived') {
      throw new ProjectAuthorityError(
        'archived-project-is-read-only',
        `project ${project.id} is archived and read-only; restore it first`,
      );
    }
  }
}

function sanitizeEditReason(value: string | undefined): string {
  return sanitizeOperatorText(value, { fallback: DEFAULT_PROJECT_EDIT_REASON, maxLength: 320 });
}

export { ProjectAuthorityError } from './authority-model.ts';
