import type { InjectionKey } from 'vue';
import type { RunHistoryTotals, RunView } from '../../../src/web/views.ts';
import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.ts';

/** Typed browser port over the existing M1 run routes and #78 wire contract. */
export interface RunBrowserAdapter {
  /** Loading, online, reconnecting, stale, or offline transport state. */
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  listRuns(): Promise<{ readonly runs: readonly RunView[]; readonly totals: RunHistoryTotals }>;
  getRun(id: string): Promise<RunView>;
  getRunStatus(id: string): Promise<{ readonly id: string; readonly status: RunView['status']; readonly failureReason?: string }>;
  submitRun(input: { readonly agentId: string; readonly prompt: string }): Promise<{ readonly id: string }>;
  stopRun(id: string): Promise<RunView>;
  listActiveChatRuns(scopeId: string): Promise<{ readonly runs: readonly { readonly id: string; readonly agentId: string; readonly status: 'queued' | 'running' }[] }>;
  stopChatRun(scopeId: string, id: string): Promise<{ readonly id: string; readonly status: RunView['status'] }>;
  subscribeRuns(listener: (run: RunView) => void): () => void;
}

/** Read-only run inspector, provided over the shared authenticated transport. */
export const RUN_INSPECTOR: InjectionKey<Pick<RunBrowserAdapter, 'getRun'>> = Symbol('sprout.run.inspector');

export function createRunBrowserAdapter(transport: BrowserTransport): RunBrowserAdapter {
  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    listRuns: () => transport.request('/api/runs'),
    getRun: (id) => transport.request(`/api/runs/${encodeURIComponent(id)}`),
    getRunStatus: (id) => transport.request(`/api/runs/${encodeURIComponent(id)}/status`),
    submitRun: (input) => transport.request('/api/runs', jsonCommand(input)),
    stopRun: (id) => transport.request(`/api/runs/${encodeURIComponent(id)}/stop`, jsonCommand()),
    listActiveChatRuns: (scopeId) => transport.request(`/api/chat/scopes/${encodeURIComponent(scopeId)}/active-runs`),
    stopChatRun: (scopeId, id) => transport.request(`/api/chat/scopes/${encodeURIComponent(scopeId)}/runs/${encodeURIComponent(id)}/stop`, jsonCommand()),
    subscribeRuns(listener) {
      return transport.events((event) => {
        if (event.type === 'run') listener(event.data as RunView);
      });
    },
  };
}

function jsonCommand(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}
