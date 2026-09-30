import type { MessageView, ProjectEventView, WakeView } from '../../../src/web/views.ts';
import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.ts';

/** The browser only submits Human messages. Server authority resolves the author when authenticated. */
export interface MessageBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  listMessages(scopeId?: string): Promise<readonly MessageView[]>;
  postMessage(input: { readonly scopeId: string; readonly body: string; readonly deliveryKey: string }): Promise<{
    readonly message: MessageView;
    readonly duplicate: boolean;
    readonly wakes: readonly WakeView[];
    readonly admittedRunIds: readonly string[];
  }>;
  listProjectEvents(projectId: string): Promise<readonly ProjectEventView[]>;
  messageObservations(id: string): Promise<{ readonly observations: readonly unknown[]; readonly wakes: readonly WakeView[] }>;
  eventObservations(id: string): Promise<{ readonly event: ProjectEventView; readonly observations: readonly unknown[]; readonly wakes: readonly WakeView[] }>;
}

export function createMessageBrowserAdapter(transport: BrowserTransport): MessageBrowserAdapter {
  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    async listMessages(scopeId) {
      const query = scopeId === undefined ? '' : `?scopeId=${encodeURIComponent(scopeId)}`;
      const response = await transport.request<{ readonly messages: readonly MessageView[] }>(`/api/messages${query}`);
      return response.messages;
    },
    postMessage(input) {
      return transport.request('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, authorId: 'operator', authorKind: 'human', awaitReply: false }),
      });
    },
    async listProjectEvents(projectId) {
      const response = await transport.request<{ readonly events: readonly ProjectEventView[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/events`,
      );
      return response.events;
    },
    messageObservations: (id) => transport.request(`/api/messages/${encodeURIComponent(id)}/observations`),
    eventObservations: (id) => transport.request(`/api/project-events/${encodeURIComponent(id)}/observations`),
  };
}
