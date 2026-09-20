import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BrowserRequestError,
  createBrowserTransport,
  type BrowserEventSource,
} from './browser-transport.ts';

class FakeEventSource implements BrowserEventSource {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  #listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.#listeners.set(type, listener);
  }

  close(): void { this.closed = true; }
  open(): void { this.onopen?.(new Event('open')); }
  error(): void { this.onerror?.(new Event('error')); }
  emitRun(data: unknown, cursor = ''): void {
    this.#listeners.get('run')?.({ data: JSON.stringify(data), lastEventId: cursor } as MessageEvent<string>);
  }
}

test('browser transport sends CSRF only for immediate commands and exposes loading and online', async () => {
  let resolveFetch: ((response: Response) => void) | undefined;
  let request: RequestInit | undefined;
  const transport = createBrowserTransport({
    fetch: (_path, init) => new Promise<Response>((resolve) => {
      request = init;
      resolveFetch = resolve;
    }),
  });
  const states: string[] = [];
  transport.subscribeState((state) => states.push(state.status));
  transport.setCsrfToken('csrf-private-value');

  const pending = transport.request<{ readonly accepted: boolean }>('/api/command', { method: 'POST' });
  assert.equal(transport.state().status, 'loading');
  assert.equal(new Headers(request?.headers).get('x-sprout-csrf'), 'csrf-private-value');
  assert.ok(resolveFetch);
  resolveFetch(new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  assert.deepEqual(await pending, { accepted: true });
  assert.equal(transport.state().status, 'online');
  assert.ok(states.includes('loading'));
  // A completed command has no retained input and cannot be replayed later.
  assert.equal(request?.body, undefined);
});

test('browser transport identifies authenticated failures without exposing response bodies', async () => {
  const transport = createBrowserTransport({ fetch: async () => new Response('credential-or-host-detail', { status: 401 }) });
  await assert.rejects(
    () => transport.request('/api/runs'),
    (error: unknown) => {
      assert.ok(error instanceof BrowserRequestError);
      assert.equal(error.kind, 'authentication-required');
      assert.equal(error.message.includes('credential-or-host-detail'), false);
      return true;
    },
  );
  assert.equal(transport.state().connection, 'online');
});

test('an unreachable command becomes observable offline and is not retained for replay', async () => {
  let calls = 0;
  const transport = createBrowserTransport({
    fetch: async () => {
      calls += 1;
      throw new Error('unreachable private endpoint');
    },
  });
  await assert.rejects(() => transport.request('/api/tasks', { method: 'POST', body: '{}' }), BrowserRequestError);
  assert.equal(transport.state().connection, 'offline');
  assert.equal(calls, 1, 'the failed command was attempted once and was not queued');
});

test('browser transport reports reconnecting, online, stale, and offline SSE states without replaying events', () => {
  const source = new FakeEventSource();
  let stale: (() => void) | undefined;
  const transport = createBrowserTransport({
    eventSource: () => source,
    setTimeout: (callback) => {
      stale = callback as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => undefined,
  });
  const received: unknown[] = [];
  const stop = transport.events((event) => received.push(event));
  assert.equal(transport.state().connection, 'reconnecting');
  source.open();
  assert.equal(transport.state().connection, 'online');
  source.emitRun({ id: 'run-1' }, '12');
  assert.deepEqual(received, [{ type: 'run', data: { id: 'run-1' }, cursor: '12' }]);
  assert.ok(stale);
  stale();
  assert.equal(transport.state().connection, 'stale');
  source.error();
  assert.equal(transport.state().connection, 'reconnecting');
  stop();
  assert.equal(source.closed, true);
});
