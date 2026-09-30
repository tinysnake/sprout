import type { MessageView, ProjectEventView, RunView } from '../../../../../src/web/views.ts';
import type { ConversationScopeView, ScopeInspectionView, WorkingGroupScopeView } from '../../../adapters/conversation-api.ts';
import type { RoutingBatchDetailView, RoutingEvidenceView } from '../../../adapters/routing-api.ts';
import { BrowserRequestError, type BrowserTransportState } from '../../../transport/browser-transport.ts';
import type { ChatService } from '../types.ts';

const at = 1_800_000_000_000;
const projectId = 'project-sprout';
const channel: ConversationScopeView = { id: '#general', kind: 'project', projectId, createdAt: at, updatedAt: at };
function group(id: string, status = 'active'): WorkingGroupScopeView {
  return { id, kind: 'working-group', projectId, createdAt: at, updatedAt: at, creatorId: 'operator', status,
    content: { currentVersion: 1, versions: [{ version: 1, at, actorMemberId: 'operator', reason: 'Created', displayName: id, goal: 'Coordinate focused work.', rules: ['Share checkable evidence.'] }] },
    memberships: [{ memberId: 'operator', memberKind: 'human', addedAt: at, addedBy: 'operator' }, { memberId: 'programmer', memberKind: 'agent', addedAt: at, addedBy: 'operator' }], lifecycle: [] };
}
const scopes: ConversationScopeView[] = [channel, group('wg-frontend'), group('wg-retired', 'disbanded'),
  ...['dm-architect', 'dm-empty', 'dm-ended'].map((id) => ({ id, kind: 'direct' as const, projectId, participants: ['operator', id.slice(3)], createdAt: at, updatedAt: at }))];
const makeMessage = (id: string, scopeId: string, body: string, createdAt: number, authorId = 'operator', authorKind = 'human', inReplyTo?: string): MessageView => ({
  id, projectId, scopeId, channel: scopeId === '#general' ? 'project' : scopeId.startsWith('wg-') ? 'working-group' : 'direct',
  authorId, authorKind, body, recipients: [], ...(inReplyTo ? { inReplyTo } : {}), createdAt,
});
const fixtureMessages: MessageView[] = [
  makeMessage('msg-addressed', '#general', 'Please check the verification results @programmer.', at + 1),
  makeMessage('msg-pending', '#general', 'Review the new project plan.', at + 2),
  makeMessage('msg-suppressed', '#general', 'This update needs no Agent wake.', at + 3),
  makeMessage('msg-failed', '#general', 'Investigate the routing failure.', at + 4),
  makeMessage('reply-msg-addressed:programmer', '#general', 'All accessible dialog checks pass.', at + 5, 'programmer', 'agent', 'msg-addressed'),
  makeMessage('msg-wg', 'wg-frontend', 'Focus ring contrast measured at 5.1:1.', at + 6),
  makeMessage('msg-retired', 'wg-retired', 'History is preserved.', at + 7),
  makeMessage('msg-dm', 'dm-architect', 'Lease recovery evidence attached.', at + 8),
  makeMessage('msg-ended', 'dm-ended', 'Previous collaboration.', at + 9),
];
const event: ProjectEventView = { id: 'event-review', projectId, kind: 'task-update', summary: 'Task review completed.', producerId: 'system', producerKind: 'system', disposition: 'informational', responsibleAgentIds: [], createdAt: at + 3.5 };
const bounds = { inputContentChars: 4_000, contextMessageChars: 1_000, recentContextMessages: 12, totalContextChars: 48_000 };
function batch(id: string, inputId: string, status: string): RoutingBatchDetailView {
  const window = { id: `window-${id}`, projectId, openedAt: at, deadlineAt: at + 30_000, intervalMs: 30_000, status: 'closed', inputCount: 1 };
  return { batch: { id, projectId, windowId: window.id, splitIndex: 0, splitCount: 1, cutoffAt: at + 30_000, status, createdAt: at + 30_000, settledAt: at + 30_200,
    bounds, contextChars: 900, manifest: { projectId, windowId: window.id, cutoffAt: at + 30_000, policy: 'wake-model-assisted', bounds,
      inputs: [{ inputId, kind: 'message', authorId: 'operator', createdAt: at, scopeId: '#general', candidates: ['programmer'], excerptChars: 18, contentChars: 18, truncated: false }],
      candidates: [{ agentId: 'programmer', responsibilities: ['Implement verified changes'], collaborationInstructions: '' }], tasks: [], recentContextIds: [], ancestorContextIds: [], exclusions: ['direct messages', 'private memory', 'host paths', 'credentials', 'engine transcripts'], contextChars: 900 } },
    window, inputs: [{ inputId, position: 0, excerpt: 'Project update excerpt', truncated: false, excerptChars: 18, contentChars: 18 }],
    attempts: [{ id: `attempt-${id}-1`, batchId: id, attemptNumber: 1, modelId: 'routing-model', startedAt: at + 30_000, finishedAt: at + 30_100, status: status === 'failed' ? 'failed' : 'succeeded', ...(status === 'failed' ? { errorKind: 'invalid-output', errorDetail: 'No valid decision.' } : {}) }],
    outcomes: [{ inputId, status: status === 'failed' ? 'failed' : status === 'suppressed' ? 'suppressed' : 'selected', assignments: status === 'routed' ? [{ agentId: 'programmer', rationale: 'Fits the declared responsibility.' }] : [], ...(status === 'suppressed' ? { rationale: 'No eligible Agent selected.' } : {}), settledAt: at + 30_200 }],
    wakes: status === 'routed' ? [{ agentId: 'programmer', reason: 'model-assigned', status: 'settled', runId: 'run-projected', batchId: id }] : [], replies: [] };
}
const batches = [batch('batch-suppressed', 'msg-suppressed', 'suppressed'), batch('batch-failed', 'msg-failed', 'failed')];
function evidence(input: RoutingEvidenceView['input'], id: string): RoutingEvidenceView {
  if (id === 'msg-pending') return { input, window: { id: 'window-open', projectId, openedAt: at, deadlineAt: at + 30_000, intervalMs: 30_000, status: 'open', inputCount: 1 }, batches: [], deterministicWakes: [], observations: [] };
  if (id === 'msg-addressed') return { input, batches: [], deterministicWakes: [{ agentId: 'programmer', reason: 'mention', status: 'settled', runId: 'run-projected' }], observations: [] };
  return { input, batches: batches.filter((detail) => detail.inputs.some((entry) => entry.inputId === id)), deterministicWakes: [], observations: id.startsWith('reply-') ? [] : [{ agentId: '', status: 'suppressed', reason: 'unaddressed', detail: 'Explicit-only policy.' }] };
}

/** Test-only authority. Production bootstrap never imports it. */
export class FixtureChatService implements ChatService {
  readonly #scopes = [...scopes];
  readonly #messages = [...fixtureMessages];
  readonly #events = [event];
  readonly #listeners = new Set<(run: { readonly id: string; readonly status: RunView['status'] }) => void>();
  private readonly options: { readonly archived?: boolean; readonly loading?: boolean };
  constructor(options: { readonly archived?: boolean; readonly loading?: boolean } = {}) { this.options = options; }
  state(): BrowserTransportState { return { status: 'online', connection: 'online', loading: false }; }
  subscribeState(listener: (state: BrowserTransportState) => void) { listener(this.state()); return () => {}; }
  async listScopes(id: string): Promise<readonly ConversationScopeView[]> {
    if (this.options.loading) return new Promise(() => {});
    return id === 'project-archived' ? [{ id: 'channel-project-archived', kind: 'project', projectId: id, createdAt: at, updatedAt: at }] : [...this.#scopes];
  }
  async inspectScope(id: string): Promise<ScopeInspectionView> {
    const scope = this.#scopes.find((candidate) => candidate.id === id) ?? { id, kind: 'project' as const, projectId: 'project-archived', createdAt: at, updatedAt: at };
    const reason = scope.projectId === 'project-archived' || this.options.archived ? 'project-archived' : scope.kind === 'working-group' && scope.status === 'disbanded' ? 'working-group-disbanded' : id === 'dm-ended' ? 'membership-ended' : undefined;
    return { scope, state: { scopeId: id, writable: reason === undefined, ...(reason ? { reason } : {}) }, context: { scopeId: id, projectId: scope.projectId, kind: scope.kind, project: { contentVersion: 1, goal: 'Coordinate durable work.', rules: ['Share checkable evidence.'] }, ...(scope.kind === 'working-group' ? { workingGroup: { displayName: id, contentVersion: 1, goal: 'Coordinate focused work.', rules: ['Share checkable evidence.'] } } : {}) } };
  }
  async openDirectConversation(id: string, participants: readonly string[]): Promise<ConversationScopeView> {
    const existing = this.#scopes.find((scope) => scope.kind === 'direct' && scope.projectId === id && participants.every((p) => scope.participants.includes(p)));
    if (existing) return existing;
    if (id !== projectId || !participants.includes('operator') || participants.length !== 2) throw new Error('Not a current Project member');
    const scope: ConversationScopeView = { id: `dm-${participants.find((p) => p !== 'operator')}`, kind: 'direct', projectId: id, participants, createdAt: at, updatedAt: at };
    this.#scopes.push(scope);
    return scope;
  }
  async createWorkingGroup(id: string, input: { readonly displayName: string; readonly goal?: string; readonly memberIds?: readonly string[] }): Promise<WorkingGroupScopeView> {
    if (id !== projectId || !input.displayName.trim()) throw new Error('Working Group unavailable');
    const created = group(`wg-created-${this.#scopes.length}`);
    const result: WorkingGroupScopeView = { ...created, content: { currentVersion: 1, versions: [{ ...created.content.versions[0]!, displayName: input.displayName, goal: input.goal ?? '' }] }, memberships: [created.memberships[0]!, ...(input.memberIds ?? []).map((memberId) => ({ memberId, memberKind: 'agent', addedAt: at, addedBy: 'operator' }))] };
    this.#scopes.push(result);
    return result;
  }
  async restoreWorkingGroup(id: string): Promise<WorkingGroupScopeView> {
    const index = this.#scopes.findIndex((scope) => scope.id === id && scope.kind === 'working-group' && scope.status === 'disbanded');
    if (index < 0) throw new Error('Restore unavailable');
    const before = this.#scopes[index] as WorkingGroupScopeView;
    const restored: WorkingGroupScopeView = { ...before, status: 'active', lifecycle: [...before.lifecycle, { action: 'restore', at: at + 50, actorMemberId: 'operator', reason: 'Restored' }] };
    this.#scopes[index] = restored;
    return restored;
  }
  async updateWorkingGroupContent(id: string, input: { readonly displayName: string; readonly goal: string | null; readonly rules: readonly string[] }) {
    return this.#changeGroup(id, (before) => ({ ...before, content: { currentVersion: before.content.currentVersion + 1, versions: [...before.content.versions, { ...before.content.versions.at(-1)!, version: before.content.currentVersion + 1, displayName: input.displayName, goal: input.goal ?? '', rules: input.rules }] } }));
  }
  async addWorkingGroupMember(id: string, memberId: string) {
    return this.#changeGroup(id, (before) => ({ ...before, memberships: [...before.memberships, { memberId, memberKind: 'agent', addedAt: at, addedBy: 'operator' }] }));
  }
  async endWorkingGroupMember(id: string, memberId: string) {
    return this.#changeGroup(id, (before) => ({ ...before, memberships: before.memberships.map((m) => m.memberId === memberId && !m.endedAt ? { ...m, endedAt: at + 60, endedBy: 'operator' } : m) }));
  }
  async disbandWorkingGroup(id: string) {
    return this.#changeGroup(id, (before) => ({ ...before, status: 'disbanded', lifecycle: [...before.lifecycle, { action: 'disband', at: at + 60, actorMemberId: 'operator', reason: 'Disbanded' }] }));
  }
  #changeGroup(id: string, change: (before: WorkingGroupScopeView) => WorkingGroupScopeView) {
    const index = this.#scopes.findIndex((scope) => scope.id === id && scope.kind === 'working-group');
    if (index < 0) throw new Error('Working Group unavailable');
    const updated = change(this.#scopes[index] as WorkingGroupScopeView);
    this.#scopes[index] = updated;
    return updated;
  }
  async listMessages(scopeId?: string) { return this.#messages.filter((message) => !scopeId || message.scopeId === scopeId); }
  async postMessage(input: { readonly scopeId: string; readonly body: string; readonly deliveryKey: string }) {
    const message = makeMessage(`msg-sent-${input.deliveryKey}`, input.scopeId, input.body, at + 50 + this.#messages.length);
    this.#messages.push(message);
    return { message, duplicate: false, wakes: [], admittedRunIds: [] };
  }
  async listProjectEvents(id: string) { return id === projectId ? [...this.#events] : []; }
  async messageRouting(id: string) { const message = this.#messages.find((item) => item.id === id); if (!message) throw new Error('Message not found'); return evidence({ kind: 'message', message: { ...message } }, id); }
  async eventRouting(id: string): Promise<RoutingEvidenceView> { if (id !== event.id) throw new Error('Event not found'); return evidence({ kind: 'event', event: { ...event } }, id); }
  async listRoutingBatches(id: string) { return { windows: batches.map((detail) => detail.window!), batches: id === projectId ? batches.map((detail) => detail.batch) : [] }; }
  async getRoutingBatch(id: string) { const detail = batches.find((entry) => entry.batch.id === id); if (!detail) throw new BrowserRequestError('rejected', 404); return detail; }
  async getRun(id: string): Promise<RunView> { return { id, agentId: 'programmer', prompt: '', status: 'completed', events: [], handOffAttached: false, createdAt: at, completedAt: at + 30_300 }; }
  async getRunStatus(id: string) { return { id, status: 'completed' as const }; }
  subscribeRunStatuses(listener: (run: { readonly id: string; readonly status: RunView['status'] }) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async pushIncoming(scopeId: string, body: string) {
    this.#messages.push(makeMessage(`incoming-${this.#messages.length}`, scopeId, body, at + 100 + this.#messages.length, 'programmer', 'agent'));
    const run = await this.getRunStatus('run-projected');
    for (const listener of this.#listeners) listener(run);
  }
  // Idle arrivals are durable but have no run-status signal.
  pushIdleMessage(scopeId: string, body: string) {
    this.#messages.push(makeMessage(`idle-${this.#messages.length}`, scopeId, body, at + 200 + this.#messages.length, 'programmer', 'agent'));
  }
  pushIdleEvent(summary: string) {
    this.#events.push({ ...event, id: `idle-event-${this.#events.length}`, summary, createdAt: at + 300 + this.#events.length });
  }
}
