import { randomUUID } from 'node:crypto';
import { sanitizeOperatorText } from '../environment/privacy.ts';
import type { AgentRun } from '../run/model.ts';
import type { Task, TaskActor, TaskBlocker, TaskBlockerResponsibility, TaskCompletionClaim, TaskContent } from './model.ts';
import type { TaskService } from './service.ts';
import type { TaskEnvironmentLifecycle, TaskRecoveryAction } from './environment-lifecycle.ts';
import type { TaskProposalService } from './proposal-service.ts';

export type TaskBlockerInput = Omit<TaskBlocker, 'createdBy' | 'createdAt'>;
export type TaskCompletionClaimInput = Omit<TaskCompletionClaim, 'id' | 'actor' | 'at' | 'contentVersion'>;
export type TaskControlErrorCode = 'unknown-task' | 'authority-required' | 'invalid-command' | 'lifecycle-conflict';

export class TaskControlError extends Error {
  readonly code: TaskControlErrorCode;
  constructor(code: TaskControlErrorCode, message: string = code) {
    super(message);
    this.name = 'TaskControlError';
    this.code = code;
  }
}

export interface TaskControlRunPort {
  stop(runId: string): Promise<AgentRun>;
}

/** Human Task controls and narrowly bounded Task-lead reports, claims, and stops. */
export class TaskControlService {
  readonly #tasks: TaskService;
  readonly #lifecycle: TaskEnvironmentLifecycle;
  readonly #proposals: TaskProposalService;
  readonly #runs: TaskControlRunPort;
  readonly #now: () => number;
  readonly #id: () => string;

  constructor(options: {
    readonly tasks: TaskService;
    readonly lifecycle: TaskEnvironmentLifecycle;
    readonly proposals: TaskProposalService;
    readonly runs: TaskControlRunPort;
    readonly now?: () => number;
    readonly id?: () => string;
  }) {
    this.#tasks = options.tasks;
    this.#lifecycle = options.lifecycle;
    this.#proposals = options.proposals;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? (() => `claim-${randomUUID()}`);
  }

  async reviseForHuman(taskId: string, input: {
    readonly expectedContentVersion: number; readonly content: unknown; readonly reason: string;
  }): Promise<Task> {
    const actor = await this.#humanForTask(taskId);
    const task = await this.#task(taskId);
    const content = validateContent(input?.content);
    const lead = await this.#proposals.authorizeActor(task.projectId, content.lead);
    if (lead.memberKind === 'agent' && !(await this.#lifecycle.eligibleAgents(task.projectId, task.environmentInstanceId!)).includes(lead.memberId)) {
      throw new TaskControlError('invalid-command', 'the new Task lead is not eligible on the bound Environment');
    }
    return this.#lifecycle.reviseContent(taskId, actor, {
      expectedContentVersion: input.expectedContentVersion, content: { ...content, lead }, reason: commandReason(input.reason),
    });
  }

  async pauseForHuman(taskId: string, input: { readonly reason: string }): Promise<Task> {
    const actor = await this.#humanForTask(taskId);
    return this.#lifecycle.requestPause(taskId, actor, commandReason(input?.reason));
  }

  async interruptForHuman(taskId: string, input: { readonly reason: string }): Promise<Task> {
    const actor = await this.#humanForTask(taskId);
    const reason = commandReason(input?.reason);
    const task = await this.#task(taskId);
    if (task.pauseState !== 'requested' || task.activeRunId === undefined) {
      throw new TaskControlError('lifecycle-conflict', 'Interrupt is available only while a paused Task still has an active run');
    }
    await this.#lifecycle.recordInterruptRequest(taskId, actor, reason);
    const run = await this.#runs.stop(task.activeRunId);
    if (run.status !== 'stopped') throw new TaskControlError('lifecycle-conflict', 'the active run did not settle as stopped');
    await this.#tasks.onRunSettled({ taskId, run });
    return this.#task(taskId);
  }

  async resumeForHuman(taskId: string, input: { readonly reason: string }): Promise<Task> {
    const actor = await this.#humanForTask(taskId);
    return this.#lifecycle.resumePause(taskId, actor, commandReason(input?.reason));
  }

  async raiseBlocker(taskId: string, actorInput: TaskActor, input: unknown): Promise<Task> {
    const task = await this.#task(taskId);
    const actor = await this.#authorizeLeadOrHuman(task, actorInput);
    const blockerInput = validateBlocker(input);
    const responsible = await this.#validateResponsibility(task, blockerInput.responsible);
    const nextAdvancer = await this.#proposals.authorizeActor(task.projectId, actorSnapshot(blockerInput.nextAdvancer));
    const blocker: TaskBlocker = {
      ...blockerInput,
      responsible,
      nextAdvancer,
      createdBy: actor,
      createdAt: this.#now(),
    };
    return this.#lifecycle.raiseBlocker(taskId, actor, blocker);
  }

  async raiseBlockerForHuman(taskId: string, input: unknown): Promise<Task> {
    const actor = await this.#humanForTask(taskId);
    return this.raiseBlocker(taskId, actor, input);
  }

  async clearBlockerForHuman(taskId: string, input: { readonly reason: string }): Promise<Task> {
    const actor = await this.#humanForTask(taskId);
    return this.#lifecycle.clearBlocker(taskId, actor, commandReason(input?.reason));
  }

  async submitCompletionClaim(taskId: string, actorInput: TaskActor, input: unknown): Promise<Task> {
    const task = await this.#task(taskId);
    const actor = await this.#authorizeLead(task, actorInput);
    const claimInput = validateClaim(input);
    const links = (await this.#tasks.getWithRuns(taskId))?.runs ?? [];
    const contentVersion = links.at(-1)?.contentVersion ?? task.admission?.contentVersion;
    if (contentVersion === undefined) throw new TaskControlError('lifecycle-conflict', 'claim requires an admitted Task content version');
    const claim: TaskCompletionClaim = { ...claimInput, id: this.#id(), actor, at: this.#now(), contentVersion };
    return this.#lifecycle.submitCompletionClaim(taskId, claim);
  }

  async submitCompletionClaimForHuman(taskId: string, input: unknown): Promise<Task> {
    const actor = await this.#humanForTask(taskId);
    return this.submitCompletionClaim(taskId, actor, input);
  }

  async validateForHuman(taskId: string, input: {
    readonly claimId: string;
    readonly decision: 'accept' | 'correct';
    readonly reason: string;
  }): Promise<Task> {
    const actor = await this.#humanForTask(taskId);
    if (!input || typeof input.claimId !== 'string' || !input.claimId.trim()
      || (input.decision !== 'accept' && input.decision !== 'correct')) {
      throw new TaskControlError('invalid-command', 'claimId and a valid validation decision are required');
    }
    return this.#lifecycle.validateCompletionClaim(taskId, actor, {
      claimId: input.claimId,
      decision: input.decision,
      reason: commandReason(input.reason),
    });
  }

  async endForHuman(taskId: string, input: { readonly reason: string }): Promise<Task> {
    await this.#humanForTask(taskId);
    const task = await this.#task(taskId);
    const reason = commandReason(input?.reason);
    if (task.status === 'done' && task.endDisposition === 'completed') return task;
    if (task.endDisposition !== 'completed' || !['ending', 'recovery'].includes(task.environmentLifecycleState ?? '')) {
      throw new TaskControlError('lifecycle-conflict', 'a Task may end as completed only after Human acceptance of its completion claim');
    }
    if (task.environmentLifecycleState === 'recovery') {
      return this.#lifecycle.recoverForHuman(taskId, 'resume', await this.#humanForTask(taskId), reason);
    }
    return this.#lifecycle.end(taskId);
  }

  async discardForHuman(taskId: string, input: { readonly reason: string }): Promise<Task> {
    const actor = await this.#humanForTask(taskId);
    return this.#lifecycle.discardForHuman(taskId, actor, commandReason(input?.reason));
  }

  async recoverForHuman(taskId: string, input: { readonly action: TaskRecoveryAction; readonly reason: string }): Promise<Task> {
    const actor = await this.#humanForTask(taskId);
    const current = await this.#task(taskId);
    if (input?.action === 'discard' && current.environmentLifecycleState === 'discarded') return current;
    if (input?.action !== 'resume' && input?.action !== 'discard') {
      throw new TaskControlError('invalid-command', 'action must be resume or discard');
    }
    return this.#lifecycle.recoverForHuman(taskId, input.action, actor, commandReason(input.reason));
  }

  async stopSubordinateForHumanLead(taskId: string, input: { readonly runId: string; readonly reason: string }): Promise<Task> {
    const actor = await this.#humanForTask(taskId);
    return this.stopSubordinateForLead(taskId, actor, input);
  }

  async stopSubordinateForLead(taskId: string, actorInput: TaskActor, input: { readonly runId: string; readonly reason: string }): Promise<Task> {
    const task = await this.#task(taskId);
    const actor = await this.#authorizeLead(task, actorInput);
    if (typeof input?.runId !== 'string' || !input.runId.trim()) throw new TaskControlError('invalid-command', 'runId is required');
    const link = (await this.#tasks.getWithRuns(taskId))?.runs.find(run => run.runId === input.runId);
    if (!link?.actor || !sameActor(link.actor, actor)) {
      throw new TaskControlError('authority-required', 'a Task lead may stop only a run they initiated');
    }
    await this.#lifecycle.recordSubordinateStopRequest(taskId, actor, input.runId, commandReason(input.reason));
    const run = await this.#runs.stop(input.runId);
    if (run.status !== 'stopped') throw new TaskControlError('lifecycle-conflict', 'the subordinate run did not settle as stopped');
    await this.#tasks.onRunSettled({ taskId, run });
    return this.#task(taskId);
  }

  async #task(taskId: string): Promise<Task> {
    const task = await this.#tasks.get(taskId);
    if (!task) throw new TaskControlError('unknown-task', 'unknown Task');
    return task;
  }

  async #humanForTask(taskId: string): Promise<TaskActor> {
    const task = await this.#task(taskId);
    return actorSnapshot(await this.#proposals.humanAuthority(task.projectId));
  }

  async #authorizeLead(task: Task, input: TaskActor): Promise<TaskActor> {
    const actor = actorSnapshot(input);
    await this.#proposals.authorizeActor(task.projectId, actor);
    const lead = task.admission?.lead;
    if (!lead || !sameActor(lead, actor)) throw new TaskControlError('authority-required', 'only the current Task lead may submit this action');
    return actor;
  }

  async #authorizeLeadOrHuman(task: Task, input: TaskActor): Promise<TaskActor> {
    const actor = actorSnapshot(input);
    await this.#proposals.authorizeActor(task.projectId, actor);
    if (actor.memberKind !== 'human' && (!task.admission?.lead || !sameActor(task.admission.lead, actor))) {
      throw new TaskControlError('authority-required', 'only the Human or current Task lead may raise a blocker');
    }
    return actor;
  }

  async #validateResponsibility(task: Task, input: TaskBlockerResponsibility): Promise<TaskBlockerResponsibility> {
    if (input.kind === 'human' || input.kind === 'agent') {
      await this.#proposals.authorizeActor(task.projectId, { memberId: input.memberId, memberKind: input.kind });
      return { kind: input.kind, memberId: input.memberId };
    }
    return input;
  }
}

function actorSnapshot(value: unknown): TaskActor {
  if (!isRecord(value) || !hasOnly(value, ['memberId', 'memberKind'])
    || typeof value.memberId !== 'string' || !value.memberId.trim()
    || (value.memberKind !== 'human' && value.memberKind !== 'agent')) {
    throw new TaskControlError('invalid-command', 'a valid Task actor is required');
  }
  return { memberId: value.memberId, memberKind: value.memberKind };
}

function validateBlocker(value: unknown): Omit<TaskBlocker, 'createdBy' | 'createdAt'> {
  if (!isRecord(value) || !hasOnly(value, ['reason', 'requiredAction', 'responsible', 'nextAdvancer'])) {
    throw new TaskControlError('invalid-command', 'blocker must contain only reason, requiredAction, responsible, and nextAdvancer');
  }
  const responsible = validateResponsibilityShape(value.responsible);
  return {
    reason: text(value.reason, 'reason', 2000),
    requiredAction: text(value.requiredAction, 'requiredAction', 2000),
    responsible,
    nextAdvancer: actorSnapshot(value.nextAdvancer),
  };
}

function validateResponsibilityShape(value: unknown): TaskBlockerResponsibility {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new TaskControlError('invalid-command', 'blocker responsibility is required');
  if (value.kind === 'human' || value.kind === 'agent') {
    if (!hasOnly(value, ['kind', 'memberId']) || typeof value.memberId !== 'string' || !value.memberId.trim()) {
      throw new TaskControlError('invalid-command', 'blocker responsibility requires a member id');
    }
    return { kind: value.kind, memberId: value.memberId };
  }
  if (value.kind === 'external-condition') {
    if (!hasOnly(value, ['kind', 'condition'])) throw new TaskControlError('invalid-command', 'invalid external condition responsibility');
    return { kind: 'external-condition', condition: text(value.condition, 'condition', 2000) };
  }
  if (value.kind === 'recovery') {
    if (!hasOnly(value, ['kind', 'mechanism'])) throw new TaskControlError('invalid-command', 'invalid recovery responsibility');
    return { kind: 'recovery', mechanism: text(value.mechanism, 'mechanism', 2000) };
  }
  throw new TaskControlError('invalid-command', 'unknown blocker responsibility kind');
}

function validateContent(value: unknown): TaskContent {
  if (!isRecord(value) || !hasOnly(value, ['title', 'goal', 'constraints', 'validationCriteria', 'lead'])) {
    throw new TaskControlError('invalid-command', 'content requires title, goal, constraints, validationCriteria, and lead only');
  }
  return {
    title: text(value.title, 'title', 500), goal: text(value.goal, 'goal', 4000),
    constraints: stringList(value.constraints, 'constraints', false),
    validationCriteria: stringList(value.validationCriteria, 'validationCriteria', true), lead: actorSnapshot(value.lead),
  };
}

function validateClaim(value: unknown): TaskCompletionClaimInput {
  const keys = ['outcomeSummary', 'validationEvidence', 'durableChanges', 'limitations', 'recommendedDisposition'];
  if (!isRecord(value) || !hasOnly(value, keys)) {
    throw new TaskControlError('invalid-command', 'completion claim must contain only factual outcome, evidence, changes, limitations, and disposition');
  }
  if (value.recommendedDisposition !== 'complete' && value.recommendedDisposition !== 'continue') {
    throw new TaskControlError('invalid-command', 'recommendedDisposition must be complete or continue');
  }
  const evidence = stringList(value.validationEvidence, 'validationEvidence', true);
  return {
    outcomeSummary: text(value.outcomeSummary, 'outcomeSummary', 4000),
    validationEvidence: evidence,
    durableChanges: stringList(value.durableChanges, 'durableChanges', false),
    limitations: stringList(value.limitations, 'limitations', false),
    recommendedDisposition: value.recommendedDisposition,
  };
}

function stringList(value: unknown, field: string, required: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 100 || (required && value.length === 0)) {
    throw new TaskControlError('invalid-command', `${field} must be ${required ? 'a non-empty' : 'an'} array of factual strings`);
  }
  return value.map(item => text(item, field, 4000));
}

function commandReason(value: unknown): string {
  return text(value, 'reason', 2000);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TaskControlError('invalid-command', `${field} is required and must be at most ${max} characters`);
  }
  const sanitized = sanitizeOperatorText(value, { maxLength: max, fallback: '' });
  if (!sanitized.trim()) throw new TaskControlError('invalid-command', `${field} must contain usable text`);
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key)) && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function sameActor(a: TaskActor, b: TaskActor): boolean {
  return a.memberId === b.memberId && a.memberKind === b.memberKind;
}
