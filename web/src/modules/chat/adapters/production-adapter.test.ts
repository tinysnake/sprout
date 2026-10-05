import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductionChatService } from './production-adapter.ts';
import { createMessageBrowserAdapter } from '../../../adapters/message-api.ts';
import { createConversationBrowserAdapter } from '../../../adapters/conversation-api.ts';
import { createRoutingBrowserAdapter } from '../../../adapters/routing-api.ts';
import { createRunBrowserAdapter } from '../../../adapters/run-api.ts';
import type { BrowserTransport } from '../../../transport/browser-transport.ts';

test('production Chat preserves newest-window and backward-cursor queries on the wire', async () => {
  const calls: string[] = [];
  const transport: BrowserTransport = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => {}, setCsrfToken: () => {}, events: () => () => {},
    async request<T>(path: string): Promise<T> {
      calls.push(path);
      return { messages: [] } as T;
    },
  };
  const service = new ProductionChatService({
    messages: createMessageBrowserAdapter(transport),
    conversations: createConversationBrowserAdapter(transport),
    routing: createRoutingBrowserAdapter(transport),
    runs: createRunBrowserAdapter(transport),
  });
  await service.listMessages('scope / 1', { limit: 10 });
  await service.listMessages('scope / 1', { limit: 10, before: 'message / 1' });
  assert.deepEqual(calls, [
    '/api/messages?scopeId=scope+%2F+1&limit=10',
    '/api/messages?scopeId=scope+%2F+1&limit=10&before=message+%2F+1',
  ]);
});
