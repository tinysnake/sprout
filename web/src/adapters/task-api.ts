import type { TaskActor, TaskBlockerResponsibility, TaskContent } from '../../../src/task/model.ts';
import type { TaskCompletionClaimInput } from '../../../src/task/control-service.ts';
import type { TaskProposal, TaskProposalContent, TaskContentVersion, ProposalDecision, ReviseTaskProposal, TaskProposalBeginInput } from '../../../src/task/proposal-model.ts';
import type { TaskView, TaskWithRunsView, TaskRunLinkView } from '../../../src/web/views.ts';
import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.ts';
import { createTaskProposalBrowserAdapter } from './task-proposal-api.ts';

export interface TaskAdvanceInput {
  readonly targetAgentId: string;
  readonly reason: string;
}

export interface TaskAdvanceResult {
  readonly task: TaskView;
  readonly runId: string;
  readonly advance: TaskRunLinkView;
}

export interface TaskContentRevision {
  readonly expectedContentVersion: number;
  readonly content: TaskContent;
  readonly reason: string;
}

export interface TaskBlockerInput {
  readonly reason: string;
  readonly requiredAction: string;
  readonly responsible: TaskBlockerResponsibility;
  readonly nextAdvancer: TaskActor;
}

export type TaskControlAction =
  | 'content'
  | 'pause'
  | 'interrupt'
  | 'resume'
  | 'subordinate-stop'
  | 'blockers'
  | 'clear-blocker'
  | 'completion-claims'
  | 'validation'
  | 'end'
  | 'discard'
  | 'reopen'
  | 'recovery';

/** Browser authority over proposals, approved Tasks, their runs, and controls. */
export interface TaskBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  listProposals(projectId: string): Promise<readonly TaskProposal[]>;
  getProposal(id: string): Promise<TaskProposal>;
  getContentVersion(id: string, version: number): Promise<TaskContentVersion>;
  validateProposal(projectId: string, content: TaskProposalContent): Promise<TaskProposalContent>;
  propose(projectId: string, content: TaskProposalContent): Promise<TaskProposal>;
  reviseProposal(id: string, input: ReviseTaskProposal): Promise<TaskProposal>;
  withdrawProposal(id: string, input: ProposalDecision): Promise<TaskProposal>;
  rejectProposal(id: string, input: ProposalDecision): Promise<TaskProposal>;
  beginProposal(id: string, input: TaskProposalBeginInput): Promise<{ readonly task: TaskView; readonly duplicate: boolean; readonly initialRunId?: string; readonly initialRunFailed?: boolean }>;
  listTasks(projectId: string): Promise<readonly TaskView[]>;
  getTask(id: string): Promise<TaskWithRunsView>;
  advance(id: string, input: TaskAdvanceInput): Promise<TaskAdvanceResult>;
  reviseTaskContent(id: string, input: TaskContentRevision): Promise<TaskView>;
  pause(id: string, reason: string): Promise<TaskView>;
  interrupt(id: string, reason: string): Promise<TaskView>;
  resume(id: string, reason: string): Promise<TaskView>;
  stopSubordinate(id: string, input: { readonly runId: string; readonly reason: string }): Promise<TaskView>;
  raiseBlocker(id: string, input: TaskBlockerInput): Promise<TaskView>;
  clearBlocker(id: string, reason: string): Promise<TaskView>;
  submitCompletionClaim(id: string, input: TaskCompletionClaimInput): Promise<TaskView>;
  validate(id: string, input: { readonly claimId: string; readonly decision: 'accept' | 'correct'; readonly reason: string }): Promise<TaskView>;
  end(id: string, reason: string): Promise<TaskView>;
  discard(id: string, reason: string): Promise<TaskView>;
  reopen(id: string, reason: string): Promise<TaskView>;
  recover(id: string, input: { readonly action: 'resume' | 'discard'; readonly reason: string }): Promise<TaskView>;
}

/** Thin production adapter: shared transport owns session, CSRF, and non-replay. */
export function createTaskBrowserAdapter(transport: BrowserTransport): TaskBrowserAdapter {
  const proposals = createTaskProposalBrowserAdapter(transport);
  const taskPath = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
  const post = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const control = async (id: string, action: TaskControlAction, body: unknown): Promise<TaskView> =>
    (await transport.request<{ readonly task: TaskView }>(`${taskPath(id)}/${action}`, post(body))).task;

  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    listProposals: (id) => proposals.list(id),
    getProposal: (id) => proposals.get(id),
    getContentVersion: (id, version) => proposals.contentVersion(id, version),
    validateProposal: (id, content) => proposals.validate(id, content),
    propose: (id, content) => proposals.propose(id, content),
    reviseProposal: (id, input) => proposals.revise(id, input),
    withdrawProposal: (id, input) => proposals.withdraw(id, input),
    rejectProposal: (id, input) => proposals.reject(id, input),
    beginProposal: (id, input) => proposals.begin(id, input),
    listTasks: async (projectId) => (await transport.request<{ readonly tasks: readonly TaskView[] }>(`/api/tasks?projectId=${encodeURIComponent(projectId)}`)).tasks,
    getTask: (id) => transport.request(taskPath(id)),
    advance: (id, input) => transport.request(`${taskPath(id)}/advances`, post(input)),
    reviseTaskContent: (id, input) => control(id, 'content', input),
    pause: (id, reason) => control(id, 'pause', { reason }),
    interrupt: (id, reason) => control(id, 'interrupt', { reason }),
    resume: (id, reason) => control(id, 'resume', { reason }),
    stopSubordinate: (id, input) => control(id, 'subordinate-stop', input),
    raiseBlocker: (id, input) => control(id, 'blockers', input),
    clearBlocker: (id, reason) => control(id, 'clear-blocker', { reason }),
    submitCompletionClaim: (id, input) => control(id, 'completion-claims', input),
    validate: (id, input) => control(id, 'validation', input),
    end: (id, reason) => control(id, 'end', { reason }),
    discard: (id, reason) => control(id, 'discard', { reason }),
    reopen: (id, reason) => control(id, 'reopen', { reason }),
    recover: (id, input) => control(id, 'recovery', input),
  };
}

export type { TaskActor, TaskBlockerResponsibility, TaskContent } from '../../../src/task/model.ts';
export type { TaskCompletionClaimInput } from '../../../src/task/control-service.ts';
export type { TaskProposal, TaskProposalContent, TaskContentVersion, ProposalDecision, ReviseTaskProposal, TaskProposalBeginInput } from '../../../src/task/proposal-model.ts';
export type { TaskView, TaskWithRunsView, TaskRunLinkView } from '../../../src/web/views.ts';
