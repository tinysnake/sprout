import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.ts';

export interface BrowserSessionView {
  readonly id: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly absoluteExpiresAt: number;
  readonly idleExpiresAt: number;
  readonly current: boolean;
}

/** Browser-only wrapper for the #84 session endpoints; bearer cookies stay HTTP-only. */
export interface OperatorSessionBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  signIn(credential: string): Promise<void>;
  listSessions(): Promise<readonly BrowserSessionView[]>;
  signOut(): Promise<void>;
  revokeOtherSessions(): Promise<number>;
  revokeSession(id: string): Promise<void>;
}

export function createOperatorSessionBrowserAdapter(transport: BrowserTransport): OperatorSessionBrowserAdapter {
  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    async signIn(credential) {
      const response = await transport.request<{ readonly csrfToken: string }>('/api/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential }),
      });
      transport.setCsrfToken(response.csrfToken);
    },
    async listSessions() {
      const response = await transport.request<{ readonly sessions: readonly BrowserSessionView[] }>('/api/auth/sessions');
      return response.sessions;
    },
    async signOut() {
      await transport.request<{ readonly signedOut: true }>('/api/auth/session', { method: 'DELETE' });
      transport.setCsrfToken(undefined);
    },
    async revokeOtherSessions() {
      const response = await transport.request<{ readonly revoked: number }>('/api/auth/sessions/revoke-others', { method: 'POST' });
      return response.revoked;
    },
    async revokeSession(id) {
      await transport.request<{ readonly revoked: true }>(`/api/auth/sessions/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
    },
  };
}
