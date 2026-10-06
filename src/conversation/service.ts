/**
 * The caller-facing conversation scope and Working group capability (ADR-0008, #95).
 *
 * This Module owns the one rule set for four routine communication scopes:
 * the invariant Project channel, Project-scoped direct conversations,
 * temporary Working groups with explicit membership, and Task groups bound to
 * one Task. It owns no Message, wake, run, or Task lifecycle. Task title,
 * content, and status arrive through narrow read-only Task ports; Task
 * admission and lifecycle remain owned by the Task authority:
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
 * Lifecycle: disbanding makes a Working group's channel read-only without
 * deleting configuration, membership changes, or messages; restore rechecks
 * member eligibility; an ended Project membership ends that member's current
 * participation in every Working group without erasing history. A Task group
 * follows its Task content and becomes read-only at terminal status while
 * preserving its snapshots and messages. Read-only scopes are never
 * destructive. Every disband and restore appends an attributed lifecycle
 * event (actor, time, reason) instead of overwriting scalar fields, so prior
 * transitions stay auditable (ADR-0008: every effective edit records its
 * actor, time, and changed facts). Every rewrite of a recorded group — a
 * lifecycle transition, a content version, a membership change — commits
 * through the store's serialized conditional update, so an accepted change
 * can never be overwritten by an interleaved command and a command computed
 * against a stale snapshot is refused instead of succeeding (ADR-0008 audit
 * clause).
 *
 * Context: `scopeContext` returns the governing Project, Working group, or
 * Task group versions verbatim, side by side. Sprout does not merge them,
 * order them, or interpret conflicts between them (ADR-0008); later routing
 * and run context (#96) receives the versions as facts.
 */

import {
  DEFAULT_PROJECT_MEMBERSHIP_END_REASON,
  DEFAULT_WORKING_GROUP_DISBAND_REASON,
  PROJECT_MEMBERSHIP_ENDED_BY,
  ConversationScopeError,
  activeWorkingGroupMembers,
  canonicalDirectParticipants,
  currentWorkingGroupContent,
  currentTaskGroupContent,
  directConversationScopeId,
  isWorkingGroup,
  projectChannelScopeId,
  taskGroupScopeId,
  taskGroupStatus,
  workingGroupStatus,
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
  type TaskGroupScope,
  type WorkingGroupMembership,
  type WorkingGroupScope,
} from './model.ts';
import type { ConversationScopeStore } from './store.ts';
import { redactSensitiveText, sanitizeOperatorText } from '../environment/privacy.ts';
import {
  sanitizeRoutingIntervalMs,
  sanitizeWakePolicy,
  type WakePolicy,
} from '../project/authority-model.ts';

/** One current or ended member of a Project, as a scope validates against. */
export interface ConversationProjectMemberFacts {
  readonly memberId: string;
  readonly memberKind: 'human' | 'agent';
  readonly endedAt?: number;
  readonly endedReason?: string;
  /**
   * The member's Project-declared facts (#97): routing context presents them
   * to the wake model as Project-shared responsibility evidence. Absent for a
   * host-configured M1 Project that declares none.
   */
  readonly responsibilities?: readonly string[];
  readonly collaborationInstructions?: string;
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
  /**
   * The Project's wake policy and fixed routing interval (#97).
   *
   * Optional on the port so an existing fixture that predates assisted routing
   * keeps compiling; readers apply the ADR-0007 defaults (`explicit-only`,
   * 30 seconds) — the migration and template defaults — when a Project fact
   * source does not declare them.
   */
  readonly wakePolicy?: WakePolicy;
  readonly routingIntervalMs?: number;
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

/**
 * One prepared Project-channel write: the durable row a Project creation
 * records during the authority's prepare phase.
 *
 * `commit` is infallible (the row is already durable). `rollback` removes
 * exactly the row this preparation created — and only that row — when the
 * Project persistence it belongs to fails, so a failed Project creation
 * leaves no orphan scope row behind (ADR-0008's atomic Project-creation
 * invariant). Preparations that found an existing channel roll back nothing.
 * The preparation stays marked in flight until commit or rollback runs, so
 * restart reconciliation reaps only preparations the process abandoned —
 * never one whose Project persistence is still running here.
 */
export interface PreparedProjectChannel {
  readonly commit: () => void;
  readonly rollback: () => Promise<void>;
}

export interface ConversationTaskFacts {
  readonly projectId: string;
  readonly status: string;
}

/** The Task authority facts needed to fail closed after Task termination. */
export interface ConversationTaskPort {
  taskFacts(taskId: string): Promise<ConversationTaskFacts | undefined>;
}

export interface ConversationScopeServiceOptions {
  readonly store: ConversationScopeStore;
  readonly projects: ConversationProjectPort;
  /** Optional in small fixtures; production uses it to close crash windows. */
  readonly tasks?: ConversationTaskPort;
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

export interface TaskGroupSyncInput {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly lead: ConversationActor;
  readonly contentVersion: number;
  readonly status: string;
  /** A durable Human reopen event is required to thaw a terminal Task group. */
  readonly allowThaw?: boolean;
  readonly versionActor?: ConversationActor;
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
  readonly #tasks: ConversationTaskPort | undefined;
  readonly #clock: () => number;
  readonly #createId: () => string;
  /**
   * Channel preparations whose Project persistence has not settled in this
   * process: prepare returned and neither commit nor rollback ran yet.
   *
   * Restart reconciliation must not reap a preparation that is still running
   * (the bridge writes the channel before the Project save, so the row
   * legitimately has no Project behind it for that window). The set is
   * process memory: a fresh process holds only the rows an interrupted
   * preparation abandoned — exactly the incomplete ones reconciliation may
   * remove.
   */
  readonly #preparing = new Set<string>();
  /** Hold a scope's preparation turn until its Project persistence settles. */
  readonly #preparationTurns = new Map<string, Promise<void>>();
  /** Serialize Task group posts with terminal Task commits for the same Task. */
  readonly #taskGroupTurns = new Map<string, Promise<void>>();

  constructor(options: ConversationScopeServiceOptions) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#tasks = options.tasks;
    this.#clock = options.clock ?? Date.now;
    this.#createId = options.createId ?? (() => Math.random().toString(36).slice(2, 10));
  }

  /**
   * Serialize one Task group's post admission and Task terminal transition.
   * Both the collaboration write path and Task lifecycle hold this turn from
   * checking Task status through durable Message or terminal persistence, so a
   * post cannot slip between terminal status commit and the scope freeze.
   */
  async withTaskGroupLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#taskGroupTurns.get(taskId);
    let unlock!: () => void;
    const turn = new Promise<void>((resolve) => { unlock = resolve; });
    this.#taskGroupTurns.set(taskId, turn);
    if (previous !== undefined) await previous;
    try {
      return await action();
    } finally {
      if (this.#taskGroupTurns.get(taskId) === turn) this.#taskGroupTurns.delete(taskId);
      unlock();
    }
  }

  /**
   * Prepare the Project channel invariant for one Project being persisted.
   *
   * Composed into the Project authority's prepare/commit bridge so a Project
   * creation records its one Project channel in the same prepared flow: a
   * failed channel write refuses the Project change before persistence, and
   * the returned commit publishes nothing in-memory (the durable write already
   * happened). If the Project itself then fails to persist, the returned
   * rollback removes the channel row this call created so no orphan scope row
   * survives a failed Project creation; a channel that already existed is
   * never removed, and a retried creation finds it idempotently.
   */
  async prepareProjectChannel(project: { readonly id: string }): Promise<PreparedProjectChannel> {
    const id = projectChannelScopeId(project.id);
    const previous = this.#preparationTurns.get(id);
    let unlock!: () => void;
    const turn = new Promise<void>((resolve) => { unlock = resolve; });
    this.#preparationTurns.set(id, turn);
    if (previous !== undefined) await previous;
    const release = () => {
      if (this.#preparationTurns.get(id) === turn) this.#preparationTurns.delete(id);
      unlock();
    };
    this.#preparing.add(id);
    try {
      const existing = await this.#store.get(id);
      if (existing !== undefined && existing.kind !== 'project') {
        throw new Error(`refusing to replace non-Project scope ${id} during Project preparation`);
      }
      const created = existing === undefined;
      if (created) {
        const now = this.#clock();
        await this.#store.save({
          id,
          kind: 'project',
          projectId: project.id,
          createdAt: now,
          updatedAt: now,
        });
      }
      let settled = false;
      let rollingBack: Promise<void> | undefined;
      return {
        commit: () => {
          if (settled) return;
          settled = true;
          this.#preparing.delete(id);
          release();
        },
        rollback: () => {
          if (settled) return rollingBack ?? Promise.resolve();
          settled = true;
          rollingBack = this.#settlePreparation(id, created).finally(release);
          return rollingBack;
        },
      };
    } catch (error) {
      this.#preparing.delete(id);
      release();
      throw error;
    }
  }

  /** Release one preparation; only a row this preparation created is removed. */
  async #settlePreparation(scopeId: string, removeRow: boolean): Promise<void> {
    this.#preparing.delete(scopeId);
    if (removeRow) await this.#store.removeProjectChannel(scopeId);
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

  /**
   * The Project's member facts (current and ended), for routing consumers (#96).
   *
   * A read-only projection of the same Project facts this service validates
   * against: deterministic Message and Project-event routing resolves its
   * recipients from here, so "current Project Agents" is decided by one
   * authority rather than by a second membership copy. Returns `undefined` for
   * an unknown Project, so a caller can distinguish "no such Project" from
   * "a Project with no members".
   */
  async projectMembers(
    projectId: string,
  ): Promise<readonly ConversationProjectMemberFacts[] | undefined> {
    return (await this.#projects.projectFacts(projectId))?.members;
  }

  /**
   * The Project's wake policy and fixed routing interval (#97), with the
   * ADR-0007 defaults applied when the fact source declares neither
   * (`explicit-only`, 30 seconds — the migration, template, and new-Project
   * defaults). Returns `undefined` for an unknown Project so a caller can
   * distinguish "no such Project" from "defaults".
   */
  async routingPolicy(
    projectId: string,
  ): Promise<{ readonly wakePolicy: WakePolicy; readonly intervalMs: number } | undefined> {
    const facts = await this.#projects.projectFacts(projectId);
    if (facts === undefined) return undefined;
    return {
      wakePolicy: sanitizeWakePolicy(facts.wakePolicy),
      intervalMs: sanitizeRoutingIntervalMs(facts.routingIntervalMs),
    };
  }

  /**
   * The Project-shared contract facts a routing attempt freezes (#97): the
   * Project goal and rules plus every member's declared responsibilities and
   * collaboration instructions. Read-only; the Project authority stays the
   * one owner of these facts.
   */
  async projectContract(projectId: string): Promise<ConversationProjectFacts | undefined> {
    return this.#projects.projectFacts(projectId);
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
      lifecycle: [],
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
   * Create or refresh the one scope permanently bound to a Task.
   *
   * Membership is deliberately not copied: scope-state reads the current
   * Project membership facts, so every current Project member is included and
   * later joiners take part without a membership write. Task content versions
   * are snapshotted append-only, and terminal status freezes the document.
   */
  async syncTaskGroup(input: TaskGroupSyncInput): Promise<TaskGroupScope> {
    const facts = await this.#facts(input.projectId);
    if (typeof input.taskId !== 'string' || input.taskId.trim() === ''
      || !Number.isSafeInteger(input.contentVersion) || input.contentVersion < 1
      || !['todo', 'in-progress', 'blocked', 'done', 'failed', 'stopped', 'cancelled'].includes(input.status)) {
      throw new ConversationScopeError('task-group-content-conflict', 'Task group requires a valid Task binding and content version');
    }
    const id = taskGroupScopeId(input.taskId);
    const taskTitle = sanitizeOperatorText(input.title, { fallback: 'Task group', maxLength: 120 });
    const goal = sanitizeWorkingGroupGoal(input.goal);
    const rules = sanitizeWorkingGroupRules(input.constraints);
    const terminalStatus = isTerminalTaskStatus(input.status) ? input.status : undefined;
    const actor = input.versionActor ?? input.lead;
    const reason = sanitizeWorkingGroupReason(
      input.reason ?? `Task content version ${input.contentVersion} was bound to this Task group.`,
      'Task content was bound to this Task group; prior versions are preserved.',
    );
    let saved: TaskGroupScope | undefined;
    await this.#store.update(id, (current) => {
      const now = this.#clock();
      if (current !== undefined && (current.kind !== 'task-group' || current.taskId !== input.taskId
        || current.projectId !== facts.projectId)) {
        throw new ConversationScopeError(
          'task-group-binding-conflict',
          `Task group ${id} is already bound to a different Task or Project and cannot be rebound`,
        );
      }
      if (current === undefined) {
        const group: TaskGroupScope = {
          id,
          kind: 'task-group',
          projectId: facts.projectId,
          taskId: input.taskId,
          content: {
            currentVersion: 1,
            versions: [{
              version: 1,
              taskContentVersion: input.contentVersion,
              at: now,
              actorMemberId: actor.memberId,
              reason,
              taskTitle,
              goal,
              rules,
            }],
          },
          ...(terminalStatus !== undefined ? { frozenAt: now, terminalTaskStatus: terminalStatus } : {}),
          createdAt: now,
          updatedAt: now,
        };
        saved = group;
        return group;
      }
      const group = current as TaskGroupScope;
      const latest = currentTaskGroupContent(group);
      let next = group;
      if (group.frozenAt !== undefined) {
        if (terminalStatus !== undefined) {
          if (group.terminalTaskStatus !== terminalStatus || latest.taskContentVersion !== input.contentVersion
            || latest.taskTitle !== taskTitle || latest.goal !== goal || JSON.stringify(latest.rules) !== JSON.stringify(rules)) {
            throw new ConversationScopeError('task-group-binding-conflict', `frozen Task group ${group.id} cannot be rebound or revised`);
          }
          saved = group;
          return group;
        }
        if (input.allowThaw !== true) {
          throw new ConversationScopeError('task-group-frozen', `Task group ${group.id} is frozen and its content cannot change`);
        }
        const { frozenAt: _frozenAt, terminalTaskStatus: _terminalTaskStatus, ...unfrozen } = group;
        next = { ...unfrozen, updatedAt: now };
      }
      if (input.contentVersion < latest.taskContentVersion) {
        throw new ConversationScopeError('task-group-content-conflict', `Task group ${group.id} cannot move to an older Task content version`);
      }
      if (input.contentVersion === latest.taskContentVersion) {
        if (latest.taskTitle !== taskTitle || latest.goal !== goal || JSON.stringify(latest.rules) !== JSON.stringify(rules)) {
          throw new ConversationScopeError('task-group-content-conflict', `Task content version ${input.contentVersion} changed after it was bound`);
        }
      } else {
        next = {
          ...next,
          content: {
            currentVersion: group.content.currentVersion + 1,
            versions: [...group.content.versions, {
              version: group.content.currentVersion + 1,
              taskContentVersion: input.contentVersion,
              at: now,
              actorMemberId: actor.memberId,
              reason,
              taskTitle,
              goal,
              rules,
            }],
          },
          updatedAt: now,
        };
      }
      if (terminalStatus !== undefined) {
        next = { ...next, frozenAt: now, terminalTaskStatus: terminalStatus, updatedAt: now };
      }
      saved = next;
      return next;
    });
    if (saved === undefined) throw new ConversationScopeError('unknown-scope', `Task group for Task ${input.taskId} could not be stored`);
    return saved;
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
    // Precondition, version numbering, and content all resolve against the
    // row at commit time (#commitGroup): an interleaved edit can neither
    // duplicate a version number nor survive as a stale overwrite.
    return this.#commitGroup(groupId, (fresh) => {
      this.#assertActiveGroup(fresh);
      const now = this.#clock();
      const current = currentWorkingGroupContent(fresh);
      const version = fresh.content.currentVersion + 1;
      return {
        ...fresh,
        content: {
          currentVersion: version,
          versions: [
            ...fresh.content.versions,
            {
              version,
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
    });
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
    return this.#commitGroup(groupId, (fresh) => {
      this.#assertActiveGroup(fresh);
      const member = facts.members.find((entry) => entry.memberId === memberId);
      if (member === undefined || member.endedAt !== undefined) {
        throw new ConversationScopeError(
          'member-not-current',
          `${memberId} is not a current member of ${facts.projectId}`,
        );
      }
      if (activeWorkingGroupMembers(fresh).some((entry) => entry.memberId === memberId)) {
        throw new ConversationScopeError('already-a-member', `${memberId} is already a member of ${fresh.id}`);
      }
      const now = this.#clock();
      return {
        ...fresh,
        memberships: [
          ...fresh.memberships,
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
    });
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
    return this.#commitGroup(groupId, (fresh) => {
      this.#assertActiveGroup(fresh);
      const entry = activeWorkingGroupMembers(fresh).find((member) => member.memberId === memberId);
      if (entry === undefined) {
        throw new ConversationScopeError(
          'membership-not-active',
          `${memberId} has no active participation in ${fresh.id}`,
        );
      }
      const now = this.#clock();
      return {
        ...fresh,
        memberships: fresh.memberships.map((member) =>
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
    });
  }

  /**
   * Disband one Working group (ADR-0008).
   *
   * The channel becomes read-only; configuration, membership changes, content
   * versions, and the group's identity all remain durable for audit and
   * possible restore. The transition appends one attributed lifecycle event
   * (actor, time, reason), so a later restore or re-disband never erases it,
   * and it is validated against the row at commit time: a concurrent
   * transition that already committed makes this stale disband refuse rather
   * than append onto superseded history. Only the creator or the Human may
   * disband.
   */
  async disbandWorkingGroup(
    groupId: string,
    actor: ConversationActor,
    input: MemberCommandInput = {},
  ): Promise<WorkingGroupScope> {
    const group = await this.#loadGroup(groupId);
    const facts = await this.#facts(group.projectId);
    this.#assertManageAuthority(group, actor, facts);
    return this.#commitGroup(groupId, (fresh) => {
      this.#assertActiveGroup(fresh);
      const now = this.#clock();
      return {
        ...fresh,
        lifecycle: [
          ...fresh.lifecycle,
          {
            action: 'disband',
            at: now,
            actorMemberId: actor.memberId,
            reason: sanitizeWorkingGroupReason(input.reason, DEFAULT_WORKING_GROUP_DISBAND_REASON),
          },
        ],
        updatedAt: now,
      };
    });
  }

  /**
   * Restore one disbanded Working group (ADR-0008).
   *
   * Restore rechecks that the group's current members are still eligible:
   * after participation ends have been materialized, every remaining active
   * participation must name a current Project member. A member recorded but
   * absent from the Project makes restore refuse rather than reopen an
   * ineligible group. The transition appends one attributed lifecycle event,
   * leaving every prior disband and restore fact auditable; the status and
   * eligibility checks run against the row at commit time, so a stale restore
   * cannot succeed beside an already-committed transition.
   */
  async restoreWorkingGroup(
    groupId: string,
    actor: ConversationActor,
    input: MemberCommandInput = {},
  ): Promise<WorkingGroupScope> {
    const group = await this.#loadGroup(groupId);
    const facts = await this.#facts(group.projectId);
    this.#assertManageAuthority(group, actor, facts);
    return this.#commitGroup(groupId, (fresh) => {
      if (workingGroupStatus(fresh) !== 'disbanded') {
        throw new ConversationScopeError('not-disbanded', `working group ${fresh.id} is not disbanded`);
      }
      const ineligible = activeWorkingGroupMembers(fresh).find((member) => {
        const memberFacts = facts.members.find((entry) => entry.memberId === member.memberId);
        return memberFacts === undefined || memberFacts.endedAt !== undefined;
      });
      if (ineligible !== undefined) {
        throw new ConversationScopeError(
          'members-not-eligible',
          `${ineligible.memberId} is no longer eligible for ${fresh.id}; restore is refused until the membership is current`,
        );
      }
      const now = this.#clock();
      return {
        ...fresh,
        lifecycle: [
          ...fresh.lifecycle,
          {
            action: 'restore',
            at: now,
            actorMemberId: actor.memberId,
            reason: sanitizeWorkingGroupReason(
              input.reason,
              'The Human or creator restored this Working group; its prior facts are preserved.',
            ),
          },
        ],
        updatedAt: now,
      };
    });
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
      // The cascade is a recorded edit like any other: it runs as one
      // serialized conditional update per group, so it can never overwrite a
      // lifecycle transition or membership change committed concurrently.
      let closed = 0;
      const next = await this.#store.update(scope.id, (current) => {
        if (current === undefined || !isWorkingGroup(current)) return undefined;
        const closings = current.memberships.filter((entry) => {
          if (entry.endedAt !== undefined) return false;
          const member = facts.members.find((candidate) => candidate.memberId === entry.memberId);
          return member !== undefined && member.endedAt !== undefined;
        });
        if (closings.length === 0) return undefined;
        const now = this.#clock();
        closed = closings.length;
        return {
          ...current,
          memberships: current.memberships.map((entry) => {
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
      });
      if (next !== undefined) ended += closed;
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
   * Remove Project-channel preparations an interrupted process abandoned.
   *
   * A Project creation records its channel during the authority's prepare
   * phase, before the Project save. A *returned* failure rolls that row back,
   * but process termination inside the window bypasses the rollback, and
   * startup only ensured channels for Projects that exist — it never removed
   * the leftover row. Restart reconciliation runs this pass: a channel row
   * whose Project no longer resolves through the facts port is an incomplete
   * preparation and is removed, while every channel whose Project exists (the
   * AC1 invariant) and every non-channel scope — a Working group carries
   * lifecycle and membership history, which is never deleted (ADR-0008) — is
   * kept. A preparation still in flight in this process is not abandoned and
   * is never reaped.
   *
   * Returns how many incomplete preparations were removed.
   */
  async removeOrphanProjectChannels(): Promise<number> {
    let removed = 0;
    for (const scope of await this.#store.list()) {
      if (scope.kind !== 'project' || this.#preparing.has(scope.id)) continue;
      if ((await this.#projects.projectFacts(scope.projectId)) !== undefined) continue;
      await this.#store.removeProjectChannel(scope.id);
      removed += 1;
    }
    return removed;
  }

  /**
   * The admission state of one scope for one acting member.
   *
   * `writable: false` is the read-only contract later consumers enforce before
   * recording a Message: archived Project, disbanded Working group, terminal
   * Task group, ended membership, or a non-participant each blocks new messages
   * while history stays readable.
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

    if (scope.kind === 'task-group') {
      if (taskGroupStatus(scope) === 'frozen') {
        return { scopeId, writable: false, reason: 'task-group-frozen' };
      }
      if (this.#tasks !== undefined) {
        const task = await this.#tasks.taskFacts(scope.taskId);
        if (task === undefined || task.projectId !== scope.projectId) {
          return { scopeId, writable: false, reason: 'task-group-task-unavailable' };
        }
        if (isTerminalTaskStatus(task.status)) {
          return { scopeId, writable: false, reason: 'task-group-frozen' };
        }
      }
      if (actor === undefined) return { scopeId, writable: false, reason: 'not-a-member' };
      if (actor.endedAt !== undefined) return { scopeId, writable: false, reason: 'membership-ended' };
      return { scopeId, writable: true };
    }

    await this.syncProjectMembershipEnds(facts.projectId);
    const group = (await this.#store.get(scopeId)) as WorkingGroupScope;
    if (workingGroupStatus(group) === 'disbanded') {
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
   * Project and Working group versions, plus a Task group's bound Task
   * snapshot, are returned verbatim. This Module never merges them or decides
   * precedence (ADR-0008); it only makes each context attributable for later
   * routing and run context.
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
    if (scope.kind === 'task-group') {
      const content = currentTaskGroupContent(scope);
      return {
        scopeId,
        projectId: facts.projectId,
        kind: scope.kind,
        project,
        taskGroup: {
          taskId: scope.taskId,
          taskTitle: content.taskTitle,
          contentVersion: scope.content.currentVersion,
          taskContentVersion: content.taskContentVersion,
          goal: redactSensitiveText(content.goal),
          rules: content.rules.map((rule) => redactSensitiveText(rule)),
        },
      };
    }
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

  /**
   * Run one Working group edit as one serialized conditional update.
   *
   * The mutation receives the row as it is when the command commits — never
   * the earlier `#loadGroup` snapshot — so its precondition (an active group,
   * a free membership slot, an open participation) is validated against the
   * freshest recorded facts. A concurrent command that already committed
   * makes a stale command refuse with its normal typed error instead of
   * appending onto superseded history; and because the store performs the
   * read–mutate–write as one uninterruptible section, an accepted change can
   * never be overwritten by an interleaved command (F1, ADR-0008: every
   * accepted transition stays durable and attributable).
   */
  async #commitGroup(
    groupId: string,
    mutate: (fresh: WorkingGroupScope) => WorkingGroupScope,
  ): Promise<WorkingGroupScope> {
    let applied: WorkingGroupScope | undefined;
    await this.#store.update(groupId, (current) => {
      if (current === undefined || !isWorkingGroup(current)) {
        throw new ConversationScopeError('unknown-working-group', `unknown working group: ${groupId}`);
      }
      applied = mutate(current);
      return applied;
    });
    if (applied === undefined) {
      throw new ConversationScopeError('unknown-working-group', `unknown working group: ${groupId}`);
    }
    return applied;
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
    if (workingGroupStatus(group) === 'disbanded') {
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

function isTerminalTaskStatus(status: string): status is 'done' | 'failed' | 'stopped' | 'cancelled' {
  return status === 'done' || status === 'failed' || status === 'stopped' || status === 'cancelled';
}

export { ConversationScopeError } from './model.ts';
