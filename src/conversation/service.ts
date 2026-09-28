/**
 * The caller-facing conversation scope and Working group capability (ADR-0008, #95).
 *
 * This Module owns the one rule set for the three routine communication
 * scopes: the invariant Project channel, Project-scoped direct conversations,
 * and temporary Working groups with explicit membership and history. It
 * deliberately owns no Message, no wake, no run, and no Task:
 *
 * - conversation history stays in the collaboration store, so creating or
 *   disbanding a scope can never create, wake, or delete work by itself; and
 * - the Project facts a scope validates against (status, versioned goal and
 *   rules, membership) arrive through a narrow read-only port, so the Project
 *   authority remains the one owner of Project lifecycle (#92).
 *
 * Authority (ADR-0008): a Human or Agent Project member may create a Working
 * group and is included as its first member; only current Project members may
 * be included; the creator and the Human may manage it. Routes behind the
 * operator browser boundary construct the Human's actor, so every HTTP caller
 * is the authenticated Human by construction — the service itself stays
 * transport-free and validates every actor against the Project anyway.
 *
 * Lifecycle: disbanding makes the channel read-only without deleting
 * configuration, membership changes, or messages; restore rechecks member
 * eligibility; an ended Project membership ends that member's current
 * participation in every Working group without erasing history. Read-only is
 * always derived (archived Project, disbanded group, ended membership), never
 * destructive.
 *
 * Context: `scopeContext` returns the governing Project and Working group
 * goal/rules versions verbatim, side by side. Sprout does not merge them,
 * order them, or interpret conflicts between them (ADR-0008); later routing
 * and run context (#96) receives both versions as facts.
 */

import {
  DEFAULT_PROJECT_MEMBERSHIP_END_REASON,
  DEFAULT_WORKING_GROUP_DISBAND_REASON,
  PROJECT_MEMBERSHIP_ENDED_BY,
  ConversationScopeError,
  activeWorkingGroupMembers,
  canonicalDirectParticipants,
  currentWorkingGroupContent,
  directConversationScopeId,
  isWorkingGroup,
  projectChannelScopeId,
  sanitizeWorkingGroupDisplayName,
  sanitizeWorkingGroupGoal,
  sanitizeWorkingGroupReason,
  sanitizeWorkingGroupRules,
  type ConversationActor,
  type ConversationScope,
  type DirectConversationScope,
  type ProjectChannelScope,
  type ScopeContext,
  type ScopeState,
  type WorkingGroupMembership,
  type WorkingGroupScope,
} from './model.ts';
import type { ConversationScopeStore } from './store.ts';
import { redactSensitiveText } from '../environment/privacy.ts';

/** One current or ended member of a Project, as a scope validates against. */
export interface ConversationProjectMemberFacts {
  readonly memberId: string;
  readonly memberKind: 'human' | 'agent';
  readonly endedAt?: number;
  readonly endedReason?: string;
}

/**
 * The Project facts a conversation scope validates and projects against.
 *
 * A narrow read-only projection of the Project authority (#92): lifecycle
 * status, the current versioned goal/rules, and membership facts. `contentVersion`
 * is `0` only for a host-configured M1 Project, which carries no version
 * history.
 */
export interface ConversationProjectFacts {
  readonly projectId: string;
  readonly status: 'active' | 'archived';
  readonly contentVersion: number;
  readonly goal: string;
  readonly rules: readonly string[];
  readonly members: readonly ConversationProjectMemberFacts[];
}

/**
 * The narrow read-only port this Module needs from the Project authority.
 *
 * Required at construction: every command fails closed without it, so a
 * missing composition can never admit a scope against unknown membership.
 */
export interface ConversationProjectPort {
  projectFacts(projectId: string): Promise<ConversationProjectFacts | undefined>;
}

export interface ConversationScopeServiceOptions {
  readonly store: ConversationScopeStore;
  readonly projects: ConversationProjectPort;
  readonly clock?: () => number;
  /** Stable Working group id generator, injectable so tests control identity. */
  readonly createId?: () => string;
}

export interface CreateWorkingGroupInput {
  readonly projectId: string;
  readonly displayName: string;
  /** The creating member; always included as the first membership. */
  readonly creator: ConversationActor;
  /** Additional current Project members; the creator is deduplicated into one entry. */
  readonly memberIds?: readonly string[];
  readonly goal?: string;
  readonly rules?: readonly string[];
  /** The sanitized operator reason recorded on the first content version. */
  readonly reason?: string;
}

export interface UpdateWorkingGroupInput {
  /** `undefined` keeps the current display name; a string replaces it. */
  readonly displayName?: string;
  /** `undefined` keeps the current goal; a string (possibly empty) replaces it. */
  readonly goal?: string;
  /** `undefined` keeps the current rules; an array (possibly empty) replaces them. */
  readonly rules?: readonly string[];
  readonly reason?: string;
}

export interface MemberCommandInput {
  readonly reason?: string;
}

/** The durable record, its admission state, and its governing context. */
export interface ScopeInspection {
  readonly scope: ConversationScope;
  readonly state: ScopeState;
  readonly context: ScopeContext;
}

export class ConversationScopeService {
  readonly #store: ConversationScopeStore;
  readonly #projects: ConversationProjectPort;
  readonly #clock: () => number;
  readonly #createId: () => string;

  constructor(options: ConversationScopeServiceOptions) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#clock = options.clock ?? Date.now;
    this.#createId = options.createId ?? (() => Math.random().toString(36).slice(2, 10));
  }

  /**
   * Prepare the Project channel invariant for one Project being persisted.
   *
   * Composed into the Project authority's prepare/commit bridge so a Project
   * creation records its one Project channel in the same prepared flow: a
   * failed channel write refuses the Project change before persistence, and
   * the returned commit publishes nothing in-memory (the durable write already
   * happened). A channel whose Project never persists is inert — every scope
   * read requires the Project's facts first — and a retried creation finds it
   * idempotently.
   */
  async prepareProjectChannel(project: { readonly id: string }): Promise<() => void> {
    await this.#ensureChannel(project.id);
    return () => undefined;
  }

  /** The Project's one Project channel, creating it on first touch. */
  async ensureProjectChannel(projectId: string): Promise<ProjectChannelScope> {
    const facts = await this.#facts(projectId);
    return this.#ensureChannel(facts.projectId);
  }

  /**
   * Open (or find) one Project-scoped direct conversation.
   *
   * Both participants must be current members of the Project, and the
   * conversation's identity is bound to that Project: the same pair in two
   * Projects opens two distinct durable conversations. Repeating the open
   * returns the same record.
   */
  async openDirect(input: {
    readonly projectId: string;
    readonly participants: readonly string[];
  }): Promise<DirectConversationScope> {
    const facts = await this.#facts(input.projectId);
    this.#assertProjectEditable(facts);
    const pair = canonicalDirectParticipants(input.participants);
    for (const memberId of pair) {
      const member = facts.members.find((entry) => entry.memberId === memberId);
      if (member === undefined || member.endedAt !== undefined) {
        throw new ConversationScopeError(
          'not-a-project-member',
          `${memberId} is not a current member of ${facts.projectId}`,
        );
      }
    }
    const id = directConversationScopeId(facts.projectId, pair);
    const existing = await this.#store.get(id);
    if (existing !== undefined && existing.kind === 'direct') return existing;
    const now = this.#clock();
    const scope: DirectConversationScope = {
      id,
      kind: 'direct',
      projectId: facts.projectId,
      participants: pair,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.save(scope);
    return scope;
  }

  /**
   * Every scope recorded for one Project, with the channel invariant ensured
   * and Working group participation ends materialized first.
   */
  async listScopes(projectId: string): Promise<readonly ConversationScope[]> {
    const facts = await this.#facts(projectId);
    await this.#ensureChannel(facts.projectId);
    await this.syncProjectMembershipEnds(facts.projectId);
    return this.#store.listForProject(facts.projectId);
  }

  /** One durable scope by identity, without any side effect. */
  async getScope(scopeId: string): Promise<ConversationScope | undefined> {
    return this.#store.get(scopeId);
  }

  /** One Working group by identity, after materializing participation ends. */
  async getWorkingGroup(groupId: string): Promise<WorkingGroupScope | undefined> {
    const scope = await this.#store.get(groupId);
    if (scope === undefined || !isWorkingGroup(scope)) return undefined;
    return this.#loadGroup(scope.id);
  }

  /** Every Working group in one Project, participation ends materialized. */
  async listWorkingGroups(projectId: string): Promise<readonly WorkingGroupScope[]> {
    const facts = await this.#facts(projectId);
    await this.syncProjectMembershipEnds(facts.projectId);
    return (await this.#store.listForProject(facts.projectId)).filter(isWorkingGroup);
  }

  /**
   * Create one Working group and its channel in one atomic durable write.
   *
   * The group and its channel are the same record, so the channel cannot exist
   * without the group or vice versa. The creator becomes the first member;
   * every requested member must be a current Project member; a non-Project
   * member is refused. This method holds no Message, wake, run, Task, or lease
   * port: creation itself sends no message, wakes no Agent, and creates no
   * work (ADR-0008).
   */
  async createWorkingGroup(input: CreateWorkingGroupInput): Promise<WorkingGroupScope> {
    const facts = await this.#facts(input.projectId);
    this.#assertProjectEditable(facts);
    const creator = this.#requireCurrentMember(facts, input.creator);
    const now = this.#clock();
    const displayName = sanitizeWorkingGroupDisplayName(input.displayName);
    const goal = sanitizeWorkingGroupGoal(input.goal);
    const rules = sanitizeWorkingGroupRules(input.rules);
    const reason = sanitizeWorkingGroupReason(input.reason);

    const memberIds: string[] = [];
    const collect = (memberId: string): void => {
      if (!memberIds.includes(memberId)) memberIds.push(memberId);
    };
    collect(creator.memberId);
    for (const entry of input.memberIds ?? []) {
      if (typeof entry !== 'string' || entry === '') {
        throw new ConversationScopeError('invalid-identity', 'a membership requires a valid member identity');
      }
      collect(entry);
    }
    const memberships: WorkingGroupMembership[] = memberIds.map((memberId) => {
      const member = facts.members.find((entry) => entry.memberId === memberId);
      if (member === undefined || member.endedAt !== undefined) {
        throw new ConversationScopeError(
          'member-not-current',
          `${memberId} is not a current member of ${facts.projectId}`,
        );
      }
      return {
        memberId,
        memberKind: member.memberKind,
        addedAt: now,
        addedBy: creator.memberId,
      };
    });

    const group: WorkingGroupScope = {
      id: `wg-${this.#createId()}`,
      kind: 'working-group',
      projectId: facts.projectId,
      creatorId: creator.memberId,
      status: 'active',
      content: {
        currentVersion: 1,
        versions: [
          {
            version: 1,
            at: now,
            actorMemberId: creator.memberId,
            reason,
            displayName,
            goal,
            rules,
          },
        ],
      },
      memberships,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.save(group);
    return group;
  }

  /**
   * Append one content version (name, goal, or rules).
   *
   * The edit affects only later message delivery, Task admission, and Agent
   * runs: an active run keeps the version it was admitted under, and previous
   * versions are never rewritten. Only the creator or the Human may manage.
   */
  async updateWorkingGroup(
    groupId: string,
    actor: ConversationActor,
    input: UpdateWorkingGroupInput,
  ): Promise<WorkingGroupScope> {
    const group = await this.#loadGroup(groupId);
    const facts = await this.#facts(group.projectId);
    this.#assertManageAuthority(group, actor, facts);
    this.#assertActiveGroup(group);
    const now = this.#clock();
    const current = currentWorkingGroupContent(group);
    const next: WorkingGroupScope = {
      ...group,
      content: {
        currentVersion: group.content.currentVersion + 1,
        versions: [
          ...group.content.versions,
          {
            version: group.content.currentVersion + 1,
            at: now,
            actorMemberId: actor.memberId,
            reason: sanitizeWorkingGroupReason(input.reason),
            displayName:
              input.displayName === undefined
                ? current.displayName
                : sanitizeWorkingGroupDisplayName(input.displayName),
            goal: input.goal === undefined ? current.goal : sanitizeWorkingGroupGoal(input.goal),
            rules: input.rules === undefined ? current.rules : sanitizeWorkingGroupRules(input.rules),
          },
        ],
      },
      updatedAt: now,
    };
    await this.#store.save(next);
    return next;
  }

  /** Add one current Project member to the Working group. */
  async addWorkingGroupMember(
    groupId: string,
    actor: ConversationActor,
    memberId: string,
    input: MemberCommandInput = {},
  ): Promise<WorkingGroupScope> {
    const group = await this.#loadGroup(groupId);
    const facts = await this.#facts(group.projectId);
    this.#assertManageAuthority(group, actor, facts);
    this.#assertActiveGroup(group);
    const member = facts.members.find((entry) => entry.memberId === memberId);
    if (member === undefined || member.endedAt !== undefined) {
      throw new ConversationScopeError(
        'member-not-current',
        `${memberId} is not a current member of ${facts.projectId}`,
      );
    }
    if (activeWorkingGroupMembers(group).some((entry) => entry.memberId === memberId)) {
      throw new ConversationScopeError('already-a-member', `${memberId} is already a member of ${group.id}`);
    }
    const now = this.#clock();
    const next: WorkingGroupScope = {
      ...group,
      memberships: [
        ...group.memberships,
        {
          memberId,
          memberKind: member.memberKind,
          addedAt: now,
          addedBy: actor.memberId,
          ...(input.reason !== undefined
            ? {
                addedReason: sanitizeWorkingGroupReason(
                  input.reason,
                  'The Working group membership was added; its history is preserved.',
                ),
              }
            : {}),
        },
      ],
      updatedAt: now,
    };
    await this.#store.save(next);
    return next;
  }

  /**
   * End one Working group participation, non-destructively.
   *
   * The entry keeps its add and end facts for attribution; a later re-add
   * appends a new entry instead of rewriting this one.
   */
  async endWorkingGroupMember(
    groupId: string,
    actor: ConversationActor,
    memberId: string,
    input: MemberCommandInput = {},
  ): Promise<WorkingGroupScope> {
    const group = await this.#loadGroup(groupId);
    const facts = await this.#facts(group.projectId);
    this.#assertManageAuthority(group, actor, facts);
    this.#assertActiveGroup(group);
    const entry = activeWorkingGroupMembers(group).find((member) => member.memberId === memberId);
    if (entry === undefined) {
      throw new ConversationScopeError(
        'membership-not-active',
        `${memberId} has no active participation in ${group.id}`,
      );
    }
    const now = this.#clock();
    const next: WorkingGroupScope = {
      ...group,
      memberships: group.memberships.map((member) =>
        member === entry
          ? {
              ...member,
              endedAt: now,
              endedBy: actor.memberId,
              endedReason: sanitizeWorkingGroupReason(
                input.reason,
                'The Working group participation ended; its history is preserved.',
              ),
            }
          : member,
      ),
      updatedAt: now,
    };
    await this.#store.save(next);
    return next;
  }

  /**
   * Disband one Working group (ADR-0008).
   *
   * The channel becomes read-only; configuration, membership changes, content
   * versions, and the group's identity all remain durable for audit and
   * possible restore. Only the creator or the Human may disband.
   */
  async disbandWorkingGroup(
    groupId: string,
    actor: ConversationActor,
    input: MemberCommandInput = {},
  ): Promise<WorkingGroupScope> {
    const group = await this.#loadGroup(groupId);
    const facts = await this.#facts(group.projectId);
    this.#assertManageAuthority(group, actor, facts);
    this.#assertActiveGroup(group);
    const now = this.#clock();
    const next: WorkingGroupScope = {
      ...group,
      status: 'disbanded',
      disbandedAt: now,
      disbandedReason: sanitizeWorkingGroupReason(input.reason, DEFAULT_WORKING_GROUP_DISBAND_REASON),
      updatedAt: now,
    };
    await this.#store.save(next);
    return next;
  }

  /**
   * Restore one disbanded Working group (ADR-0008).
   *
   * Restore rechecks that the group's current members are still eligible:
   * after participation ends have been materialized, every remaining active
   * participation must name a current Project member. A member recorded but
   * absent from the Project makes restore refuse rather than reopen an
   * ineligible group.
   */
  async restoreWorkingGroup(
    groupId: string,
    actor: ConversationActor,
    input: MemberCommandInput = {},
  ): Promise<WorkingGroupScope> {
    const group = await this.#loadGroup(groupId);
    const facts = await this.#facts(group.projectId);
    this.#assertManageAuthority(group, actor, facts);
    if (group.status !== 'disbanded') {
      throw new ConversationScopeError('not-disbanded', `working group ${group.id} is not disbanded`);
    }
    const ineligible = activeWorkingGroupMembers(group).find((member) => {
      const memberFacts = facts.members.find((entry) => entry.memberId === member.memberId);
      return memberFacts === undefined || memberFacts.endedAt !== undefined;
    });
    if (ineligible !== undefined) {
      throw new ConversationScopeError(
        'members-not-eligible',
        `${ineligible.memberId} is no longer eligible for ${group.id}; restore is refused until the membership is current`,
      );
    }
    const now = this.#clock();
    const next: WorkingGroupScope = {
      ...group,
      status: 'active',
      restoredAt: now,
      restoredReason: sanitizeWorkingGroupReason(
        input.reason,
        'The Human or creator restored this Working group; its prior facts are preserved.',
      ),
      updatedAt: now,
    };
    await this.#store.save(next);
    return next;
  }

  /**
   * End every Working group participation whose Project membership has ended.
   *
   * The cascade records the Project membership's own end facts (its
   * `endedAt`/`endedReason`) on the participation, so when the end is
   * materialized does not change the recorded history. It never erases a
   * membership entry, never touches a member whose Project membership is
   * active, and treats a member absent from the Project as ineligible rather
   * than ending it silently (an absent identity proves no end). Idempotent:
   * running it twice ends nothing twice.
   */
  async syncProjectMembershipEnds(projectId: string): Promise<number> {
    const facts = await this.#projects.projectFacts(projectId);
    if (facts === undefined) return 0;
    let ended = 0;
    for (const scope of await this.#store.listForProject(projectId)) {
      if (!isWorkingGroup(scope)) continue;
      const closings = scope.memberships.filter((entry) => {
        if (entry.endedAt !== undefined) return false;
        const member = facts.members.find((candidate) => candidate.memberId === entry.memberId);
        return member !== undefined && member.endedAt !== undefined;
      });
      if (closings.length === 0) continue;
      const now = this.#clock();
      const next: WorkingGroupScope = {
        ...scope,
        memberships: scope.memberships.map((entry) => {
          if (entry.endedAt !== undefined) return entry;
          const member = facts.members.find((candidate) => candidate.memberId === entry.memberId);
          if (member === undefined || member.endedAt === undefined) return entry;
          return {
            ...entry,
            endedAt: member.endedAt,
            endedBy: PROJECT_MEMBERSHIP_ENDED_BY,
            endedReason: sanitizeWorkingGroupReason(
              member.endedReason,
              DEFAULT_PROJECT_MEMBERSHIP_END_REASON,
            ),
          };
        }),
        updatedAt: now,
      };
      await this.#store.save(next);
      ended += closings.length;
    }
    return ended;
  }

  /**
   * Materialize participation ends for every Project that has a Working group.
   *
   * The startup/restart pass: a process that died between an ended Project
   * membership and its first scope read converges at once, and the pass is
   * idempotent by construction.
   */
  async syncAll(): Promise<number> {
    const groups = (await this.#store.list()).filter(isWorkingGroup);
    const projectIds = [...new Set(groups.map((group) => group.projectId))];
    let ended = 0;
    for (const projectId of projectIds) {
      ended += await this.syncProjectMembershipEnds(projectId);
    }
    return ended;
  }

  /**
   * The admission state of one scope for one acting member.
   *
   * `writable: false` is the read-only contract later consumers enforce before
   * recording a Message: archived Project, disbanded Working group, ended
   * membership, or a non-participant each block new messages while history
   * stays readable.
   */
  async scopeState(scopeId: string, actorId: string): Promise<ScopeState> {
    const scope = await this.#store.get(scopeId);
    if (scope === undefined) {
      throw new ConversationScopeError('unknown-scope', `unknown conversation scope: ${scopeId}`);
    }
    const facts = await this.#facts(scope.projectId);
    if (facts.status === 'archived') {
      return { scopeId, writable: false, reason: 'project-archived' };
    }
    const actor = facts.members.find((entry) => entry.memberId === actorId);

    if (scope.kind === 'project') {
      if (actor !== undefined && actor.endedAt === undefined) return { scopeId, writable: true };
      return {
        scopeId,
        writable: false,
        reason: actor !== undefined ? 'membership-ended' : 'not-a-member',
      };
    }

    if (scope.kind === 'direct') {
      if (!scope.participants.includes(actorId)) {
        return { scopeId, writable: false, reason: 'not-a-participant' };
      }
      // Every participant must be a current Project member for a new message:
      // an ended membership makes the old direct messages readable but sends
      // disabled in that Project (ADR-0008).
      for (const participant of scope.participants) {
        const member = facts.members.find((entry) => entry.memberId === participant);
        if (member === undefined) {
          return { scopeId, writable: false, reason: 'not-a-member' };
        }
        if (member.endedAt !== undefined) {
          return { scopeId, writable: false, reason: 'membership-ended' };
        }
      }
      return { scopeId, writable: true };
    }

    await this.syncProjectMembershipEnds(facts.projectId);
    const group = (await this.#store.get(scopeId)) as WorkingGroupScope;
    if (group.status === 'disbanded') {
      return { scopeId, writable: false, reason: 'working-group-disbanded' };
    }
    if (actor === undefined) return { scopeId, writable: false, reason: 'not-a-member' };
    if (actor.endedAt !== undefined) return { scopeId, writable: false, reason: 'membership-ended' };
    const entry = group.memberships.find((member) => member.memberId === actorId);
    if (entry === undefined) return { scopeId, writable: false, reason: 'not-a-member' };
    if (entry.endedAt !== undefined) return { scopeId, writable: false, reason: 'membership-ended' };
    return { scopeId, writable: true };
  }

  /**
   * The governing goal/rules facts for one scope.
   *
   * Project and Working group versions are returned side by side, verbatim:
   * this Module never merges them or decides precedence (ADR-0008), it only
   * makes both attributable for later routing and run context.
   */
  async scopeContext(scopeId: string): Promise<ScopeContext> {
    const scope = await this.#store.get(scopeId);
    if (scope === undefined) {
      throw new ConversationScopeError('unknown-scope', `unknown conversation scope: ${scopeId}`);
    }
    const facts = await this.#facts(scope.projectId);
    const project: ScopeContext['project'] = {
      contentVersion: facts.contentVersion,
      goal: redactSensitiveText(facts.goal),
      rules: facts.rules.map((rule) => redactSensitiveText(rule)),
    };
    if (scope.kind !== 'working-group') {
      return { scopeId, projectId: facts.projectId, kind: scope.kind, project };
    }
    const content = currentWorkingGroupContent(scope);
    return {
      scopeId,
      projectId: facts.projectId,
      kind: scope.kind,
      project,
      workingGroup: {
        displayName: content.displayName,
        contentVersion: scope.content.currentVersion,
        goal: redactSensitiveText(content.goal),
        rules: content.rules.map((rule) => redactSensitiveText(rule)),
      },
    };
  }

  /** One scope projected for one actor: record, admission state, context. */
  async inspectScope(scopeId: string, actor: ConversationActor): Promise<ScopeInspection> {
    const state = await this.scopeState(scopeId, actor.memberId);
    const scope = await this.#store.get(scopeId);
    if (scope === undefined) {
      throw new ConversationScopeError('unknown-scope', `unknown conversation scope: ${scopeId}`);
    }
    const context = await this.scopeContext(scopeId);
    return { scope, state, context };
  }

  /**
   * The local Human's actor identity in one Project.
   *
   * The HTTP routes use this so every scope command behind the operator
   * browser boundary runs as the authenticated Human — Human authority by
   * construction, with the membership itself still verified per command.
   */
  async humanAuthority(projectId: string): Promise<ConversationActor> {
    const facts = await this.#facts(projectId);
    const human = facts.members.find(
      (entry) => entry.memberKind === 'human' && entry.endedAt === undefined,
    );
    if (human === undefined) {
      throw new ConversationScopeError(
        'human-membership-required',
        `${projectId} has no current Human membership`,
      );
    }
    return { memberId: human.memberId, kind: 'human' };
  }

  async #facts(projectId: string): Promise<ConversationProjectFacts> {
    const facts = await this.#projects.projectFacts(projectId);
    if (facts === undefined) {
      throw new ConversationScopeError('unknown-project', `unknown project: ${projectId}`);
    }
    return facts;
  }

  async #ensureChannel(projectId: string): Promise<ProjectChannelScope> {
    const id = projectChannelScopeId(projectId);
    const existing = await this.#store.get(id);
    if (existing !== undefined && existing.kind === 'project') return existing;
    const now = this.#clock();
    const scope: ProjectChannelScope = {
      id,
      kind: 'project',
      projectId,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.save(scope);
    return scope;
  }

  /** Load one Working group with its ended participations materialized. */
  async #loadGroup(groupId: string): Promise<WorkingGroupScope> {
    const scope = await this.#store.get(groupId);
    if (scope === undefined || !isWorkingGroup(scope)) {
      throw new ConversationScopeError('unknown-working-group', `unknown working group: ${groupId}`);
    }
    await this.syncProjectMembershipEnds(scope.projectId);
    const synced = await this.#store.get(groupId);
    if (synced === undefined || !isWorkingGroup(synced)) {
      throw new ConversationScopeError('unknown-working-group', `unknown working group: ${groupId}`);
    }
    return synced;
  }

  #assertProjectEditable(facts: ConversationProjectFacts): void {
    if (facts.status === 'archived') {
      throw new ConversationScopeError(
        'archived-project-is-read-only',
        `project ${facts.projectId} is archived and read-only; restore it first`,
      );
    }
  }

  #assertActiveGroup(group: WorkingGroupScope): void {
    if (group.status === 'disbanded') {
      throw new ConversationScopeError(
        'working-group-disbanded',
        `working group ${group.id} is disbanded and read-only; restore it first`,
      );
    }
  }

  #requireCurrentMember(
    facts: ConversationProjectFacts,
    actor: ConversationActor,
  ): ConversationProjectMemberFacts {
    const member = facts.members.find((entry) => entry.memberId === actor.memberId);
    if (
      member === undefined ||
      member.endedAt !== undefined ||
      member.memberKind !== actor.kind
    ) {
      throw new ConversationScopeError(
        'not-a-project-member',
        `${actor.memberId} is not a current ${actor.kind} member of ${facts.projectId}`,
      );
    }
    return member;
  }

  /**
   * The management rule (ADR-0008): the creator may manage its Working group,
   * the Human may manage any Working group, both must be current Project
   * members, and an archived Project is read-only.
   */
  #assertManageAuthority(
    group: WorkingGroupScope,
    actor: ConversationActor,
    facts: ConversationProjectFacts,
  ): void {
    this.#assertProjectEditable(facts);
    const member = this.#requireCurrentMember(facts, actor);
    if (member.memberKind !== 'human' && actor.memberId !== group.creatorId) {
      throw new ConversationScopeError(
        'management-authority-required',
        `only the creator (${group.creatorId}) or the Human may manage ${group.id}`,
      );
    }
  }
}

export { ConversationScopeError } from './model.ts';
