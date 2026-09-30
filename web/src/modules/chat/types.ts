import type { InjectionKey } from 'vue';
import type { MessageView, ProjectEventView, RunView } from '../../../../src/web/views.ts';
import type { BrowserTransportState } from '../../transport/browser-transport.ts';
import type { ConversationScopeView, ScopeInspectionView } from '../../adapters/conversation-api.ts';
import type { RoutingBatchDetailView, RoutingBatchSummaryView, RoutingEvidenceView, RoutingWindowView } from '../../adapters/routing-api.ts';
import type { MessageBrowserAdapter } from '../../adapters/message-api.ts';

/** One page-owned seam; production composes accepted conversation, message, event, routing and run ports. */
export interface ChatService {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  listScopes(projectId: string): Promise<readonly ConversationScopeView[]>;
  inspectScope(scopeId: string): Promise<ScopeInspectionView>;
  openDirectConversation(projectId: string, participants: readonly string[]): Promise<ConversationScopeView>;
  listMessages(scopeId?: string): ReturnType<MessageBrowserAdapter['listMessages']>;
  postMessage(input: { readonly scopeId: string; readonly body: string; readonly deliveryKey: string }): ReturnType<MessageBrowserAdapter['postMessage']>;
  listProjectEvents(projectId: string): Promise<readonly ProjectEventView[]>;
  messageRouting(id: string): Promise<RoutingEvidenceView>;
  eventRouting(id: string): Promise<RoutingEvidenceView>;
  listRoutingBatches(projectId: string): Promise<{ readonly windows: readonly RoutingWindowView[]; readonly batches: readonly RoutingBatchSummaryView[] }>;
  getRoutingBatch(id: string): Promise<RoutingBatchDetailView>;
  getRun(id: string): Promise<RunView>;
  subscribeRuns(listener: (run: RunView) => void): () => void;
}

export const CHAT_SERVICE: InjectionKey<ChatService> = Symbol('sprout.chat.service');
export type ChatTimelineItem = { readonly kind: 'message'; readonly message: MessageView } | { readonly kind: 'event'; readonly event: ProjectEventView };
