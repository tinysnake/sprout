import type { ConversationBrowserAdapter } from '../../../adapters/conversation-api.ts';
import type { MessageBrowserAdapter } from '../../../adapters/message-api.ts';
import type { RoutingBrowserAdapter } from '../../../adapters/routing-api.ts';
import type { RunBrowserAdapter } from '../../../adapters/run-api.ts';
import type { ChatService } from '../types.ts';

/** No fixture fallback, local queue, or independent routing decision. */
export class ProductionChatService implements ChatService {
  private readonly ports: {
    readonly conversations: ConversationBrowserAdapter;
    readonly messages: MessageBrowserAdapter;
    readonly routing: RoutingBrowserAdapter;
    readonly runs: RunBrowserAdapter;
  };
  constructor(ports: ProductionChatService['ports']) { this.ports = ports; }

  state = () => this.ports.messages.state();
  subscribeState: ChatService['subscribeState'] = (listener) => this.ports.messages.subscribeState(listener);
  listUnread: ChatService['listUnread'] = () => this.ports.conversations.listUnread();
  markRead: ChatService['markRead'] = (id, messages) => this.ports.conversations.markRead(id, messages);
  listScopes: ChatService['listScopes'] = (id) => this.ports.conversations.listScopes(id);
  inspectScope: ChatService['inspectScope'] = (id) => this.ports.conversations.inspectScope(id);
  openDirectConversation: ChatService['openDirectConversation'] = (id, participants) => this.ports.conversations.openDirectConversation(id, { participants });
  createWorkingGroup: ChatService['createWorkingGroup'] = (id, input) => this.ports.conversations.createWorkingGroup(id, input);
  updateWorkingGroupContent: ChatService['updateWorkingGroupContent'] = (id, input) => this.ports.conversations.updateWorkingGroupContent(id, input);
  addWorkingGroupMember: ChatService['addWorkingGroupMember'] = (id, memberId) => this.ports.conversations.addWorkingGroupMember(id, { memberId });
  endWorkingGroupMember: ChatService['endWorkingGroupMember'] = (id, memberId) => this.ports.conversations.endWorkingGroupMember(id, memberId);
  disbandWorkingGroup: ChatService['disbandWorkingGroup'] = (id) => this.ports.conversations.disbandWorkingGroup(id);
  restoreWorkingGroup: ChatService['restoreWorkingGroup'] = (id) => this.ports.conversations.restoreWorkingGroup(id);
  listMessages: ChatService['listMessages'] = (id, options) => this.ports.messages.listMessages(id, options);
  postMessage: ChatService['postMessage'] = (input) => this.ports.messages.postMessage(input);
  listProjectEvents: ChatService['listProjectEvents'] = (id, options) => this.ports.messages.listProjectEvents(id, options);
  messageRouting: ChatService['messageRouting'] = (id) => this.ports.routing.messageRouting(id);
  eventRouting: ChatService['eventRouting'] = (id) => this.ports.routing.eventRouting(id);
  listRoutingBatches: ChatService['listRoutingBatches'] = (id) => this.ports.routing.listRoutingBatches(id);
  getRoutingBatch: ChatService['getRoutingBatch'] = (id) => this.ports.routing.getRoutingBatch(id);
  getRunStatus: ChatService['getRunStatus'] = (id) => this.ports.runs.getRunStatus(id);
  listActiveRuns: ChatService['listActiveRuns'] = async (scopeId) => (await this.ports.runs.listActiveChatRuns(scopeId)).runs;
  stopChatRun: ChatService['stopChatRun'] = (scopeId, id) => this.ports.runs.stopChatRun(scopeId, id);
  subscribeRunStatuses: ChatService['subscribeRunStatuses'] = (listener) => this.ports.runs.subscribeRuns((run) => listener({ id: run.id, status: run.status }));
}
