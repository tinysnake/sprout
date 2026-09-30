import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.js';
import type { TaskProposal, TaskProposalContent, TaskContentVersion, ReviseTaskProposal, ProposalDecision, TaskProposalOrigin } from '../../../src/task/proposal-model.ts';

// Shared portable types, not a second wire vocabulary. No backend runtime import.
export type { TaskProposal, TaskProposalContent, TaskContentVersion, ReviseTaskProposal, ProposalDecision, TaskProposalOrigin } from '../../../src/task/proposal-model.ts';
export interface TaskProposalBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  list(projectId: string): Promise<readonly TaskProposal[]>;
  get(id: string): Promise<TaskProposal>;
  contentVersion(id: string, version: number): Promise<TaskContentVersion>;
  validate(projectId: string, content: TaskProposalContent): Promise<TaskProposalContent>;
  propose(projectId: string, content: TaskProposalContent, origin?: TaskProposalOrigin | null): Promise<TaskProposal>;
  revise(id: string, input: ReviseTaskProposal): Promise<TaskProposal>;
  withdraw(id: string, input: ProposalDecision): Promise<TaskProposal>;
  reject(id: string, input: ProposalDecision): Promise<TaskProposal>;
}
/** No authority fields, local command queue, or offline retry; shared transport owns session/CSRF. */
export function createTaskProposalBrowserAdapter(transport: BrowserTransport): TaskProposalBrowserAdapter {
  const collection = (id: string) => `/api/projects/${encodeURIComponent(id)}/task-proposals`;
  const detail = (id: string) => `/api/task-proposals/${encodeURIComponent(id)}`;
  const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const command = async (path: string, body: unknown): Promise<TaskProposal> =>
    (await transport.request<{ proposal: TaskProposal }>(path, post(body))).proposal;
  return {
    state: () => transport.state(),
    subscribeState: listener => transport.subscribeState(listener),
    list: async id => (await transport.request<{ proposals: readonly TaskProposal[] }>(collection(id))).proposals,
    get: async id => (await transport.request<{ proposal: TaskProposal }>(detail(id))).proposal,
    contentVersion: async (id, version) => (await transport.request<{ contentVersion: TaskContentVersion }>(`${detail(id)}/versions/${version}`)).contentVersion,
    validate: async (id, content) => (await transport.request<{ content: TaskProposalContent }>(`${collection(id)}/validate`, post(content))).content,
    propose: (id, content, origin = null) => command(collection(id), { ...content, origin }),
    revise: (id, input) => command(`${detail(id)}/content`, input),
    withdraw: (id, input) => command(`${detail(id)}/withdraw`, input),
    reject: (id, input) => command(`${detail(id)}/reject`, input),
  };
}
