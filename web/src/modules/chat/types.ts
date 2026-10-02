import type { InjectionKey } from 'vue';
import type { MessageView, ProjectEventView, RunView } from '../../../../src/web/views.ts';
import type { BrowserTransportState } from '../../transport/browser-transport.ts';
import type { ConversationScopeView, CreateWorkingGroupInput, ScopeInspectionView, WorkingGroupScopeView } from '../../adapters/conversation-api.ts';
import type { RoutingBatchDetailView, RoutingBatchSummaryView, RoutingEvidenceView, RoutingWindowView } from '../../adapters/routing-api.ts';
import type { MessageBrowserAdapter } from '../../adapters/message-api.ts';

/** One page-owned seam; production composes accepted conversation, message, event, routing and run ports. */
export interface ChatService {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  listUnread(): Promise<readonly import('../../../../src/web/chat-read-router.ts').UnreadScopeCount[]>;
  markRead(scopeId: string, messageIds: readonly string[]): Promise<import('../../../../src/web/chat-read-router.ts').UnreadScopeCount>;
  listScopes(projectId: string): Promise<readonly ConversationScopeView[]>;
  inspectScope(scopeId: string): Promise<ScopeInspectionView>;
  openDirectConversation(projectId: string, participants: readonly string[]): Promise<ConversationScopeView>;
  createWorkingGroup(projectId: string, input: CreateWorkingGroupInput): Promise<WorkingGroupScopeView>;
  updateWorkingGroupContent(id: string, input: { readonly displayName: string; readonly goal: string | null; readonly rules: readonly string[] }): Promise<WorkingGroupScopeView>;
  addWorkingGroupMember(id: string, memberId: string): Promise<WorkingGroupScopeView>;
  endWorkingGroupMember(id: string, memberId: string): Promise<WorkingGroupScopeView>;
  disbandWorkingGroup(id: string): Promise<WorkingGroupScopeView>;
  restoreWorkingGroup(id: string): Promise<WorkingGroupScopeView>;
  listMessages(scopeId?: string): ReturnType<MessageBrowserAdapter['listMessages']>;
  postMessage(input: { readonly scopeId: string; readonly body: string; readonly deliveryKey: string }): ReturnType<MessageBrowserAdapter['postMessage']>;
  listProjectEvents(projectId: string): Promise<readonly ProjectEventView[]>;
  messageRouting(id: string): Promise<RoutingEvidenceView>;
  eventRouting(id: string): Promise<RoutingEvidenceView>;
  listRoutingBatches(projectId: string): Promise<{ readonly windows: readonly RoutingWindowView[]; readonly batches: readonly RoutingBatchSummaryView[] }>;
  getRoutingBatch(id: string): Promise<RoutingBatchDetailView>;
  getRunStatus(id: string): Promise<{ readonly id: string; readonly status: RunView['status']; readonly failureReason?: string }>;
  subscribeRunStatuses(listener: (run: { readonly id: string; readonly status: RunView['status'] }) => void): () => void;
}

export const CHAT_SERVICE: InjectionKey<ChatService> = Symbol('sprout.chat.service');
export type ChatTimelineItem = { readonly kind: 'message'; readonly message: MessageView } | { readonly kind: 'event'; readonly event: ProjectEventView };
