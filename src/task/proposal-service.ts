import { randomUUID } from 'node:crypto';
import type { ProjectAgentAuthorityPort } from '../project/authority-service.ts';
import type { ConversationProjectPort } from '../conversation/service.ts';
import type { WorkingGroupScope } from '../conversation/model.ts';
import type { Message } from '../collaboration/model.ts';
import { sanitizeOperatorText } from '../environment/privacy.ts';
import { TaskProposalError, type ProposalActor, type TaskProposal, type TaskProposalContent,
  type TaskContentVersion, type ProposalDecision, type ReviseTaskProposal, type TaskProposalInput,
  type TaskProposalOrigin } from './proposal-model.ts';
import type { TaskProposalStore } from './proposal-store.ts';

export interface ProposalOriginFactsPort {
  getWorkingGroup(id: string): Promise<WorkingGroupScope | undefined>;
  getMessage(id: string): Promise<Message | undefined>;
}

/**
 * Public proposal capability (#99). Only read-only membership/identity ports and storage:
 * validation cannot wake, submit, reserve, prepare context, or invoke a capability.
 * Agent callers supply a trusted internal actor; HTTP resolves Human membership itself.
 * #100 consumes contentVersion as a copy at admission; later edits cannot rewrite it.
 */
export class TaskProposalService {
  readonly #store: TaskProposalStore;
  readonly #projects: ConversationProjectPort;
  readonly #agents: ProjectAgentAuthorityPort;
  readonly #origins: ProposalOriginFactsPort | undefined;
  readonly #now: () => number;
  readonly #id: () => string;
  constructor(options: { store: TaskProposalStore; projects: ConversationProjectPort; agents: ProjectAgentAuthorityPort; origins?: ProposalOriginFactsPort; now?: () => number; id?: () => string }) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#agents = options.agents;
    this.#origins = options.origins;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? (() => `proposal-${randomUUID()}`);
  }
  async humanAuthority(projectId: string): Promise<ProposalActor> {
    const project = await this.#project(projectId);
    const member = project.members.find(m => m.memberKind === 'human' && m.endedAt === undefined);
    if (!member) throw new TaskProposalError('membership-required');
    return { memberId: member.memberId, memberKind: 'human' };
  }
  async validate(projectId: string, actor: ProposalActor, input: TaskProposalContent): Promise<TaskProposalContent> {
    await this.#authorize(projectId, actorSnapshot(actor));
    return validatedContent(input);
  }
  async propose(projectId: string, actor: ProposalActor, input: TaskProposalInput): Promise<TaskProposal> {
    actor = actorSnapshot(actor);
    const originInput = snapshotOriginInput(input && typeof input === 'object' ? input.origin : undefined);
    const content = await this.validate(projectId, actor, input);
    const origin = await this.#proposalOrigin(projectId, originInput);
    const now = this.#now();
    const proposal: TaskProposal = {
      id: this.#id(), projectId, proposer: actorSnapshot(actor), origin, status: 'proposed', revision: 1,
      currentContentVersion: 1, versions: [{ ...content, version: 1, actor: actorSnapshot(actor), at: now, reason: 'Proposed' }],
      lifecycle: [], createdAt: now, updatedAt: now,
    };
    await this.#store.create(proposal);
    return structuredClone(proposal);
  }
  async get(id: string): Promise<TaskProposal> {
    const proposal = await this.#store.get(id);
    if (!proposal) throw new TaskProposalError('unknown-proposal');
    return proposal;
  }
  async authorizeActor(projectId: string, actor: ProposalActor): Promise<ProposalActor> {
    actor = actorSnapshot(actor);
    await this.#authorize(projectId, actor);
    return actor;
  }
  async beginSnapshot(id: string, actor: ProposalActor, expectedRevision: number): Promise<TaskProposal> {
    actor = actorSnapshot(actor);
    const proposal = await this.get(id);
    await this.#authorize(proposal.projectId, actor);
    if (actor.memberKind !== 'human') throw new TaskProposalError('authority-required');
    if (proposal.revision !== revision(expectedRevision)) throw new TaskProposalError('stale-proposal');
    this.#open(proposal);
    if (!proposal.versions.some(version => version.version === proposal.currentContentVersion)) {
      throw new TaskProposalError('unknown-content-version');
    }
    return proposal;
  }
  async list(projectId: string): Promise<readonly TaskProposal[]> {
    await this.#project(projectId);
    return this.#store.listForProject(projectId);
  }
  async contentVersion(id: string, version: number): Promise<TaskContentVersion> {
    const proposal = await this.get(id);
    const content = proposal.versions.find(v => v.version === version);
    if (!content) throw new TaskProposalError('unknown-content-version');
    return structuredClone(content);
  }
  async revise(id: string, actor: ProposalActor, input: ReviseTaskProposal): Promise<TaskProposal> {
    actor = actorSnapshot(actor);
    const proposal = await this.get(id);
    await this.#authorize(proposal.projectId, actor);
    const content = validatedContent(input);
    const reason = text(input.reason, 'reason', 2000);
    return this.#store.change(id, revision(input.expectedRevision), current => {
      this.#open(current);
      if (actor.memberKind !== 'human' && !sameActor(current.proposer, actor)) throw new TaskProposalError('authority-required');
      const version = current.currentContentVersion + 1;
      const now = this.#now();
      return { ...current, revision: current.revision + 1, currentContentVersion: version, updatedAt: now,
        versions: [...current.versions, { ...content, version, actor: actorSnapshot(actor), at: now, reason }] };
    });
  }
  withdraw(id: string, actor: ProposalActor, input: ProposalDecision): Promise<TaskProposal> {
    return this.#decide(id, actor, input, 'withdraw');
  }
  reject(id: string, actor: ProposalActor, input: ProposalDecision): Promise<TaskProposal> {
    return this.#decide(id, actor, input, 'reject');
  }
  async #decide(id: string, actor: ProposalActor, input: ProposalDecision, action: 'withdraw' | 'reject'): Promise<TaskProposal> {
    actor = actorSnapshot(actor);
    const proposal = await this.get(id);
    await this.#authorize(proposal.projectId, actor);
    const reason = text(input.reason, 'reason', 2000);
    return this.#store.change(id, revision(input.expectedRevision), current => {
      this.#open(current);
      if (action === 'reject' ? actor.memberKind !== 'human' : !sameActor(current.proposer, actor)) throw new TaskProposalError('authority-required');
      const now = this.#now();
      return { ...current, status: action === 'reject' ? 'rejected' : 'withdrawn', revision: current.revision + 1, updatedAt: now,
        lifecycle: [...current.lifecycle, { action, actor: actorSnapshot(actor), at: now, reason, contentVersion: current.currentContentVersion }] };
    });
  }
  async #proposalOrigin(projectId: string, input: unknown): Promise<TaskProposalOrigin | null> {
    if (input === undefined || input === null) return null;
    if (typeof input !== 'object' || Array.isArray(input)) throw new TaskProposalError('invalid-content', 'invalid proposal origin');
    const candidate = input as Partial<TaskProposalOrigin>;
    if (typeof candidate.workingGroupId !== 'string' || !candidate.workingGroupId.trim()
      || typeof candidate.sourceMessageId !== 'string' || !candidate.sourceMessageId.trim()) {
      throw new TaskProposalError('invalid-content', 'invalid proposal origin');
    }
    const workingGroupId = candidate.workingGroupId;
    const sourceMessageId = candidate.sourceMessageId;
    const group = await this.#origins?.getWorkingGroup(workingGroupId);
    const message = await this.#origins?.getMessage(sourceMessageId);
    const authorWasParticipant = group?.memberships.some(member =>
      member.memberId === message?.author.id && member.memberKind === message.author.kind
      && member.addedAt <= message.createdAt && (member.endedAt === undefined || member.endedAt >= message.createdAt));
    if (!group || group.id !== workingGroupId || group.kind !== 'working-group' || group.projectId !== projectId
      || !message || message.id !== sourceMessageId || message.projectId !== projectId
      || message.channel !== 'working-group' || message.scopeId !== group.id || !authorWasParticipant) {
      throw new TaskProposalError('invalid-content', 'proposal origin does not identify a Working-group Message');
    }
    return { workingGroupId, sourceMessageId };
  }
  #open(proposal: TaskProposal): void {
    if (proposal.status !== 'proposed') throw new TaskProposalError('proposal-closed');
  }
  async #project(id: string) {
    const project = await this.#projects.projectFacts(id);
    if (!project) throw new TaskProposalError('unknown-project');
    return project;
  }
  async #authorize(id: string, actor: ProposalActor): Promise<void> {
    const project = await this.#project(id);
    if (project.status !== 'active') throw new TaskProposalError('project-read-only');
    if (!project.members.some(m => m.memberId === actor.memberId && m.memberKind === actor.memberKind && m.endedAt === undefined)) {
      throw new TaskProposalError('membership-required');
    }
    if (actor.memberKind === 'agent' && !await this.#agents.agentIsActive(actor.memberId)) throw new TaskProposalError('agent-read-only');
  }
}
function snapshotOriginInput(input: unknown): unknown {
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) return input;
  const candidate = input as Record<string, unknown>;
  return { workingGroupId: candidate.workingGroupId, sourceMessageId: candidate.sourceMessageId };
}
function actorSnapshot(actor: ProposalActor): ProposalActor {
  if (!actor || typeof actor !== 'object') throw new TaskProposalError('membership-required');
  return { memberId: actor.memberId, memberKind: actor.memberKind };
}
function sameActor(a: ProposalActor, b: ProposalActor): boolean {
  return a.memberId === b.memberId && a.memberKind === b.memberKind;
}
function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TaskProposalError('invalid-content', 'expectedRevision is required');
  return value;
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TaskProposalError('invalid-content', `invalid ${field}`);
  const sanitized = sanitizeOperatorText(value, { maxLength: max, fallback: '' });
  if (!sanitized.trim()) throw new TaskProposalError('invalid-content', `invalid ${field}`);
  return sanitized;
}
function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) throw new TaskProposalError('invalid-content', `invalid ${field}`);
  return value.map(v => text(v, field, 4000));
}
function validatedContent(input: TaskProposalContent): TaskProposalContent {
  if (!input || typeof input !== 'object') throw new TaskProposalError('invalid-content');
  return { title: text(input.title, 'title', 200), goal: text(input.goal, 'goal', 16000),
    constraints: strings(input.constraints, 'constraints'), validationCriteria: strings(input.validationCriteria, 'validationCriteria') };
}
