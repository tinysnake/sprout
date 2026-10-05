import type { MessageView, ProjectEventView, WakeView } from '../../../src/web/views.ts';
import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.ts';

export interface MessagePageOptions {
  readonly limit?: number;
  readonly before?: string;
}

export interface ProjectEventPageOptions extends MessagePageOptions {
  readonly originScopeId?: string;
}

export interface ProjectEventPage {
  readonly events: readonly ProjectEventView[];
  readonly hasOlder: boolean;
}

/** The browser only submits Human messages. Server authority resolves the author when authenticated. */
export interface MessageBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  listMessages(scopeId?: string, options?: MessagePageOptions): Promise<readonly MessageView[]>;
  postMessage(input: { readonly scopeId: string; readonly body: string; readonly deliveryKey: string }): Promise<{
    readonly message: MessageView;
    readonly duplicate: boolean;
    readonly wakes: readonly WakeView[];
    readonly admittedRunIds: readonly string[];
  }>;
  listProjectEvents(projectId: string, options?: ProjectEventPageOptions): Promise<ProjectEventPage>;
  messageObservations(id: string): Promise<{ readonly observations: readonly unknown[]; readonly wakes: readonly WakeView[] }>;
  eventObservations(id: string): Promise<{ readonly event: ProjectEventView; readonly observations: readonly unknown[]; readonly wakes: readonly WakeView[] }>;
}

export function createMessageBrowserAdapter(transport: BrowserTransport): MessageBrowserAdapter {
  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    async listMessages(scopeId, options) {
      const query = new URLSearchParams();
      if (scopeId !== undefined) query.set('scopeId', scopeId);
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      if (options?.before !== undefined) query.set('before', options.before);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      const response = await transport.request<{ readonly messages: readonly MessageView[] }>(`/api/messages${suffix}`);
      return response.messages;
    },
    postMessage(input) {
      return transport.request('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, authorId: 'operator', authorKind: 'human', awaitReply: false }),
      });
    },
    async listProjectEvents(projectId, options) {
      const query = new URLSearchParams();
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      if (options?.before !== undefined) query.set('before', options.before);
      if (options?.originScopeId !== undefined) query.set('originScopeId', options.originScopeId);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return transport.request<ProjectEventPage>(
        `/api/projects/${encodeURIComponent(projectId)}/events${suffix}`,
      );
    },
    messageObservations: (id) => transport.request(`/api/messages/${encodeURIComponent(id)}/observations`),
    eventObservations: (id) => transport.request(`/api/project-events/${encodeURIComponent(id)}/observations`),
  };
}
