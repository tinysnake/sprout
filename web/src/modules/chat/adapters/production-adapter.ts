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
  listScopes: ChatService['listScopes'] = (id) => this.ports.conversations.listScopes(id);
  inspectScope: ChatService['inspectScope'] = (id) => this.ports.conversations.inspectScope(id);
  openDirectConversation: ChatService['openDirectConversation'] = (id, participants) => this.ports.conversations.openDirectConversation(id, { participants });
  listMessages: ChatService['listMessages'] = (id) => this.ports.messages.listMessages(id);
  postMessage: ChatService['postMessage'] = (input) => this.ports.messages.postMessage(input);
  listProjectEvents: ChatService['listProjectEvents'] = (id) => this.ports.messages.listProjectEvents(id);
  messageRouting: ChatService['messageRouting'] = (id) => this.ports.routing.messageRouting(id);
  eventRouting: ChatService['eventRouting'] = (id) => this.ports.routing.eventRouting(id);
  listRoutingBatches: ChatService['listRoutingBatches'] = (id) => this.ports.routing.listRoutingBatches(id);
  getRoutingBatch: ChatService['getRoutingBatch'] = (id) => this.ports.routing.getRoutingBatch(id);
  getRun: ChatService['getRun'] = (id) => this.ports.runs.getRun(id);
  subscribeRuns: ChatService['subscribeRuns'] = (listener) => this.ports.runs.subscribeRuns(listener);
}
