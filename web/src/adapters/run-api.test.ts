import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunBrowserAdapter } from './run-api.ts';
import type { BrowserTransport, BrowserEvent } from '../transport/browser-transport.ts';

test('Run adapter exposes status-only active Chat reads and Human stop commands over encoded scoped routes', async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const transport: BrowserTransport = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    setCsrfToken: () => undefined,
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      calls.push({ path, ...(init === undefined ? {} : { init }) });
      if (init !== undefined) return { id: 'run/1', status: 'interrupted' } as T;
      return { runs: [{ id: 'run/1', agentId: 'agent-1', status: 'running' }] } as T;
    },
    events: (_listener: (event: BrowserEvent) => void) => () => undefined,
  };
  const adapter = createRunBrowserAdapter(transport);

  assert.deepEqual(await adapter.listActiveChatRuns('scope/one'), {
    runs: [{ id: 'run/1', agentId: 'agent-1', status: 'running' }],
  });
  assert.deepEqual(await adapter.stopChatRun('scope/one', 'run/1'), { id: 'run/1', status: 'interrupted' });
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/chat/scopes/scope%2Fone/active-runs',
    '/api/chat/scopes/scope%2Fone/runs/run%2F1/stop',
  ]);
  assert.equal(calls[0]?.init, undefined);
  assert.equal(calls[1]?.init?.method, 'POST');
});
