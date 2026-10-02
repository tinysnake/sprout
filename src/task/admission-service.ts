import { createIdFactory, type IdFactory } from '../ids.ts';
import type { ProjectAgentAuthorityPort } from '../project/authority-service.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import { sanitizeOperatorText } from '../environment/privacy.ts';
import type { TaskActor, Task, TaskRunLink } from './model.ts';
import type { TaskService } from './service.ts';
import { TaskEnvironmentLeaseRefusal, type TaskEnvironmentLifecycle } from './environment-lifecycle.ts';
import type { TaskProposalService } from './proposal-service.ts';
import type { TaskProposalStore } from './proposal-store.ts';
import { TaskProposalError, type TaskProposalBeginInput } from './proposal-model.ts';

export type TaskAdmissionErrorCode = 'invalid-command' | 'lead-ineligible' | 'environment-ineligible'
  | 'no-compatible-agent' | 'task-not-admitted' | 'advance-forbidden' | 'target-ineligible'
  | 'environment-recovering' | 'environment-unavailable';

export class TaskAdmissionError extends Error {
  readonly code: TaskAdmissionErrorCode;
  constructor(code: TaskAdmissionErrorCode, message: string = code) {
    super(message);
    this.name = 'TaskAdmissionError';
    this.code = code;
  }
}

export type BeginTaskProposalInput = TaskProposalBeginInput;

export interface BeginTaskProposalResult {
  readonly task: Task;
  readonly duplicate: boolean;
  readonly initialRunId?: string;
  /** True when begin committed but an Agent-lead run could not be submitted. */
  readonly initialRunFailed?: boolean;
}

/** Human authority, proposal consumption, Task-held lease, context and advance boundary for #100. */
export class TaskAdmissionService {
  readonly #proposals: TaskProposalService;
  readonly #proposalStore: TaskProposalStore;
  readonly #tasks: TaskService;
  readonly #lifecycle: TaskEnvironmentLifecycle;
  readonly #projects: ProjectRegistry;
  readonly #agentAuthority: ProjectAgentAuthorityPort;
  readonly #ids: IdFactory;
  readonly #now: () => number;

  constructor(options: {
    readonly proposals: TaskProposalService;
    readonly proposalStore: TaskProposalStore;
    readonly tasks: TaskService;
    readonly lifecycle: TaskEnvironmentLifecycle;
    readonly projects: ProjectRegistry;
    readonly agentAuthority: ProjectAgentAuthorityPort;
    readonly ids?: IdFactory;
    readonly now?: () => number;
  }) {
    this.#proposals = options.proposals;
    this.#proposalStore = options.proposalStore;
    this.#tasks = options.tasks;
    this.#lifecycle = options.lifecycle;
    this.#projects = options.projects;
    this.#agentAuthority = options.agentAuthority;
    this.#ids = options.ids ?? createIdFactory();
    this.#now = options.now ?? Date.now;
  }

  async beginForHuman(proposalId: string, input: BeginTaskProposalInput): Promise<BeginTaskProposalResult> {
    const proposal = await this.#proposals.get(proposalId);
    const actor = await this.#proposals.humanAuthority(proposal.projectId);
    return this.beginProposal(proposalId, actor, input);
  }

  async advanceForHuman(taskId: string, input: { readonly targetAgentId: string; readonly reason: string; readonly prompt?: string }) {
    const actor = await this.humanAuthorityForTask(taskId);
    return this.advance(taskId, actor, input);
  }

  async beginProposal(proposalId: string, actor: TaskActor, input: BeginTaskProposalInput): Promise<BeginTaskProposalResult> {
    actor = actorSnapshot(actor);
    const initial = await this.#proposals.get(proposalId);
    await this.#proposals.authorizeActor(initial.projectId, actor);
    if (actor.memberKind !== 'human') throw new TaskProposalError('authority-required');
    const reason = optionalReason(input.reason);

    // A lost HTTP response may retry the same command. The durable proposal event
    // identifies the single Task; it must never cause another lease or run.
    if (initial.status === 'begun') {
      const begun = [...initial.lifecycle].reverse().find(event => event.action === 'begun');
      if (!begun || begun.actor.memberId !== actor.memberId || begun.actor.memberKind !== actor.memberKind
        || !Number.isSafeInteger(input.expectedRevision) || initial.revision !== input.expectedRevision + 1) {
        throw new TaskProposalError('stale-proposal');
      }
      const task = await this.#tasks.get(begun.taskId);
      if (!task) throw new TaskAdmissionError('task-not-admitted', 'the begun Task record is unavailable');
      const repeatedLead = actorSnapshot(input.lead);
      if (!task.admission || task.environmentInstanceId !== input.environmentInstanceId
        || task.admission.lead.memberId !== repeatedLead.memberId || task.admission.lead.memberKind !== repeatedLead.memberKind
        || task.admission.approvalReason !== reason) throw new TaskProposalError('stale-proposal');
      const runLinks = (await this.#tasks.getWithRuns(task.id))?.runs ?? [];
      const initialRunFailed = task.admission?.initialRunFailed === true;
      return {
        task,
        duplicate: true,
        ...(task.admission?.lead.memberKind === 'agent' && !initialRunFailed && runLinks[0] ? { initialRunId: runLinks[0].runId } : {}),
        ...(initialRunFailed ? { initialRunFailed: true } : {}),
      };
    }

    const proposal = await this.#proposals.beginSnapshot(proposalId, actor, input.expectedRevision);
    if (!input || typeof input.environmentInstanceId !== 'string' || !input.environmentInstanceId.trim()) {
      throw new TaskAdmissionError('invalid-command', 'environmentInstanceId is required');
    }
    const lead = actorSnapshot(input.lead);
    await this.#proposals.authorizeActor(proposal.projectId, lead);
    const project = this.#projects.get(proposal.projectId);
    if (!project || !project.availableEnvironmentInstanceIds.includes(input.environmentInstanceId)) {
      throw new TaskAdmissionError('environment-ineligible', 'the selected Environment is not available to this Project');
    }
    const eligible = await this.#eligibleAgents(proposal.projectId, input.environmentInstanceId);
    if (eligible.length === 0) throw new TaskAdmissionError('no-compatible-agent', 'no current Project Agent can work on the selected Environment');
    if (lead.memberKind === 'agent' && !eligible.includes(lead.memberId)) {
      throw new TaskAdmissionError('lead-ineligible', 'the selected Agent lead is not compatible with the Environment');
    }
    const contextAgentId = lead.memberKind === 'agent' ? lead.memberId : eligible[0]!;
    const content = proposal.versions.find(version => version.version === proposal.currentContentVersion);
    if (!content) throw new TaskProposalError('unknown-content-version');
    const approvedAt = this.#now();
    const taskId = this.#ids.task();
    const task: Task = {
      id: taskId,
      projectId: proposal.projectId,
      title: content.title,
      goal: content.goal,
      constraints: [...content.constraints],
      status: 'todo',
      ...(lead.memberKind === 'agent' ? { assignedAgentId: lead.memberId } : {}),
      admission: {
        proposalId: proposal.id,
        proposalRevision: proposal.revision,
        contentVersion: content.version,
        validationCriteria: [...content.validationCriteria],
        lead,
        contextAgentId,
        approvedBy: actor,
        approvedAt,
        ...(reason !== undefined ? { approvalReason: reason } : {}),
      },
      createdAt: approvedAt,
      updatedAt: approvedAt,
    };
    try {
      await this.#lifecycle.beginApproved(task, {
        environmentInstanceId: input.environmentInstanceId,
        contextAgentId,
        consumeProposal: () => { this.#proposalStore.consumeForBegin(proposal.id, proposal.revision, {
          actor, at: approvedAt, ...(reason !== undefined ? { reason } : {}), taskId,
        }); },
      });
    } catch (error) {
      if (error instanceof TaskEnvironmentLeaseRefusal) {
        if (error.state === 'recovering') {
          throw new TaskAdmissionError('environment-recovering', 'the selected Environment is protected by Task lease recovery');
        }
        throw new TaskAdmissionError('environment-unavailable', 'the selected Environment is no longer available');
      }
      throw error;
    }

    if (lead.memberKind === 'human') {
      return { task: (await this.#tasks.get(taskId))!, duplicate: false };
    }

    // This is deliberately a second durable command after Task begin: the begin
    // boundary first establishes the active Task, bound Environment and context.
    try {
      const first = await this.#advance(taskId, actor, {
        targetAgentId: lead.memberId, ...(reason !== undefined ? { reason } : {}),
      });
      return { task: first.task, duplicate: false, initialRunId: first.runId };
    } catch {
      const begunTask = await this.#tasks.get(taskId);
      if (!begunTask) throw new TaskAdmissionError('task-not-admitted', 'Task begin committed but its Task record is unavailable');
      const failedTask = await this.#tasks.recordInitialRunFailure(taskId);
      return { task: failedTask, duplicate: false, initialRunFailed: true };
    }
  }

  async humanAuthorityForTask(taskId: string): Promise<TaskActor> {
    const task = await this.#tasks.get(taskId);
    if (!task) throw new TaskAdmissionError('task-not-admitted', `unknown task: ${taskId}`);
    return this.#proposals.humanAuthority(task.projectId);
  }

  async advance(taskId: string, actor: TaskActor, input: {
    readonly targetAgentId: string;
    readonly reason: string;
    readonly prompt?: string;
  }): Promise<{ readonly task: Task; readonly runId: string; readonly audit: TaskRunLink }> {
    const reason = safeReason(input.reason);
    return this.#advance(taskId, actor, { ...input, reason });
  }

  async #advance(taskId: string, actor: TaskActor, input: {
    readonly targetAgentId: string;
    readonly reason?: string;
    readonly prompt?: string;
  }): Promise<{ readonly task: Task; readonly runId: string; readonly audit: TaskRunLink }> {
    actor = actorSnapshot(actor);
    const task = await this.#tasks.get(taskId);
    if (!task) throw new TaskAdmissionError('task-not-admitted', `unknown task: ${taskId}`);
    if (!task.admission) throw new TaskAdmissionError('task-not-admitted', 'Task advances require a Human-approved proposal');
    await this.#proposals.authorizeActor(task.projectId, actor);
    if (actor.memberKind === 'agent' && (task.admission.lead.memberKind !== 'agent' || task.admission.lead.memberId !== actor.memberId)) {
      throw new TaskAdmissionError('advance-forbidden', 'only the Human or current Task lead may advance this Task');
    }
    const reason = optionalReason(input.reason);
    const prompt = input.prompt === undefined ? undefined : safePrompt(input.prompt);
    const eligible = await this.#eligibleAgents(task.projectId, task.environmentInstanceId!);
    if (!eligible.includes(input.targetAgentId)) throw new TaskAdmissionError('target-ineligible', 'the selected Agent is not eligible on the Task Environment');
    const advanced = await this.#tasks.advanceWithAttribution(taskId, {
      agentId: input.targetAgentId,
      actor,
      ...(reason !== undefined ? { reason } : {}),
      contentVersion: task.admission.contentVersion,
      ...(prompt !== undefined ? { prompt } : {}),
    });
    const links = (await this.#tasks.getWithRuns(taskId))?.runs ?? [];
    const audit = links.find(link => link.runId === advanced.runId);
    if (!audit) throw new TaskAdmissionError('task-not-admitted', 'the advance audit record is unavailable');
    return { ...advanced, audit };
  }

  async #eligibleAgents(projectId: string, environmentInstanceId: string): Promise<readonly string[]> {
    const candidates = await this.#lifecycle.eligibleAgents(projectId, environmentInstanceId);
    const active: string[] = [];
    for (const id of candidates) if (await this.#agentAuthority.agentIsActive(id)) active.push(id);
    return active;
  }
}

function actorSnapshot(actor: TaskActor): TaskActor {
  if (!actor || typeof actor !== 'object' || typeof actor.memberId !== 'string' || !actor.memberId.trim()
    || (actor.memberKind !== 'human' && actor.memberKind !== 'agent')) {
    throw new TaskAdmissionError('invalid-command', 'a valid Project member is required');
  }
  return { memberId: actor.memberId, memberKind: actor.memberKind };
}

function safePrompt(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_000) throw new TaskAdmissionError('invalid-command', 'prompt must be at most 16000 characters');
  const sanitized = sanitizeOperatorText(value, { maxLength: 16_000, fallback: '' });
  if (!sanitized.trim()) throw new TaskAdmissionError('invalid-command', 'prompt must contain usable text');
  return sanitized;
}

function optionalReason(value: unknown): string | undefined {
  return value === undefined ? undefined : safeReason(value);
}

function safeReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw new TaskAdmissionError('invalid-command', 'reason is required and must be at most 2000 characters');
  }
  const sanitized = sanitizeOperatorText(value, { maxLength: 2000, fallback: '' });
  if (!sanitized.trim()) throw new TaskAdmissionError('invalid-command', 'reason is required');
  return sanitized;
}
