import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMessageBrowserAdapter } from './message-api.ts';
import type { BrowserTransport } from '../transport/browser-transport.ts';

test('Message and Project-event adapter uses exact accepted routes and immediate Human delivery', async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const transport: BrowserTransport = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => {},
    setCsrfToken: () => {},
    events: () => () => {},
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      calls.push({ path, ...(init ? { init } : {}) });
      if (path.startsWith('/api/projects/')) return { events: [] } as T;
      if (path.includes('/observations')) return { observations: [], wakes: [] } as T;
      if (init) return { message: { id: 'msg-1' }, duplicate: false, wakes: [], admittedRunIds: [] } as T;
      return { messages: [] } as T;
    },
  };
  const adapter = createMessageBrowserAdapter(transport);
  await adapter.listMessages('wg/name & more');
  await adapter.listProjectEvents('project/name');
  await adapter.messageObservations('message/1');
  await adapter.eventObservations('event/1');
  const result = await adapter.postMessage({ scopeId: 'wg-1', body: '@programmer please check', deliveryKey: 'web-key' });
  assert.equal(result.message.id, 'msg-1');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/messages?scopeId=wg%2Fname+%26+more',
    '/api/projects/project%2Fname/events',
    '/api/messages/message%2F1/observations',
    '/api/project-events/event%2F1/observations',
    '/api/messages',
  ]);
  assert.deepEqual(JSON.parse(calls[4]!.init!.body as string), {
    scopeId: 'wg-1', body: '@programmer please check', deliveryKey: 'web-key', authorId: 'operator', authorKind: 'human', awaitReply: false,
  });
});

test('Message adapter encodes a bounded backward cursor request', async () => {
  const calls: string[] = [];
  const adapter = createMessageBrowserAdapter({
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => {}, setCsrfToken: () => {}, events: () => () => {},
    async request<T>(path: string): Promise<T> {
      calls.push(path);
      return { messages: [] } as T;
    },
  });
  await adapter.listMessages('wg/name & more', { limit: 25, before: 'message / 1' });
  assert.deepEqual(calls, ['/api/messages?scopeId=wg%2Fname+%26+more&limit=25&before=message+%2F+1']);
});

test('Message adapter propagates transport refusals without queueing or fabricating a message', async () => {
  const adapter = createMessageBrowserAdapter({
    state: () => ({ status: 'offline', connection: 'offline', loading: false }),
    subscribeState: () => () => {}, setCsrfToken: () => {}, events: () => () => {},
    request: async () => { throw new Error('offline'); },
  });
  await assert.rejects(adapter.postMessage({ scopeId: '#general', body: 'Hello', deliveryKey: 'web-key' }), /offline/);
});
