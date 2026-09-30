import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeConnection } from '../shell/connection.ts';
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
  heartbeat(): void {
    this.#listeners.get('heartbeat')?.({ data: '' } as MessageEvent<string>);
  }
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
  assert.equal(transport.state().status, 'online');
  assert.equal(transport.state().loading, true);
  assert.equal(new Headers(request?.headers).get('x-sprout-csrf'), 'csrf-private-value');
  assert.ok(resolveFetch);
  resolveFetch(new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  assert.deepEqual(await pending, { accepted: true });
  assert.equal(transport.state().status, 'online');
  assert.ok(states.every((status) => status === 'online'));
  // A completed command has no retained input and cannot be replayed later.
  assert.equal(request?.body, undefined);
});

test('browser transport remains loading until every concurrent request settles', async () => {
  const resolvers: Array<(response: Response) => void> = [];
  const transport = createBrowserTransport({
    fetch: () => new Promise<Response>((resolve) => resolvers.push(resolve)),
  });

  const first = transport.request<{ readonly request: number }>('/api/first');
  const second = transport.request<{ readonly request: number }>('/api/second');
  assert.equal(transport.state().loading, true);
  assert.equal(resolvers.length, 2);

  resolvers[0]!(new Response(JSON.stringify({ request: 1 }), { status: 200 }));
  assert.deepEqual(await first, { request: 1 });
  assert.equal(transport.state().loading, true, 'the second request is still pending');

  resolvers[1]!(new Response(JSON.stringify({ request: 2 }), { status: 200 }));
  assert.deepEqual(await second, { request: 2 });
  assert.equal(transport.state().loading, false);
  assert.equal(transport.state().connection, 'online');
});

test('an in-flight API read does not degrade presentation or revoke control', async () => {
  let resolveFetch: ((response: Response) => void) | undefined;
  const transport = createBrowserTransport({
    fetch: () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
  });
  const presentations: ReturnType<typeof describeConnection>[] = [];
  transport.subscribeState((state) => presentations.push(describeConnection(state)));
  const before = describeConnection(transport.state());
  const pending = transport.request('/api/read');
  assert.equal(transport.state().loading, true);
  assert.deepEqual(describeConnection(transport.state()), before);
  assert.ok(presentations.every((presentation) => presentation.announce === before.announce && presentation.controlAvailable));
  resolveFetch!(new Response('{}'));
  await pending;
  assert.deepEqual(describeConnection(transport.state()), before);
});

test('only SSE traffic restores staleness; heartbeat renews quiet-stream liveness', async () => {
  const source = new FakeEventSource();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const transport = createBrowserTransport({
    eventSource: () => source,
    fetch: async (path) => path === '/api/unauthorized' ? new Response('', { status: 401 }) : new Response('{}'),
    setTimeout: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback as () => void);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id) => { timers.delete(id as unknown as number); },
  });
  const arrivals: unknown[] = [];
  const stop = transport.events((event) => arrivals.push(event));
  source.open();
  assert.equal(timers.size, 1);
  const firstTimer = nextTimer;
  source.heartbeat();
  assert.equal(transport.state().connection, 'online');
  assert.equal(timers.has(firstTimer), false, 'a heartbeat renews the watchdog');
  assert.equal(timers.size, 1);
  assert.deepEqual(arrivals, [], 'heartbeat does not reach chat or wake subscribers');
  for (let interval = 0; interval < 3; interval += 1) {
    source.heartbeat();
    assert.equal(transport.state().connection, 'online', 'a quiet healthy stream remains fresh each interval');
    assert.equal(timers.size, 1);
  }
  timers.get(nextTimer)!();
  assert.equal(transport.state().connection, 'stale');
  assert.equal(describeConnection(transport.state()).controlAvailable, false);
  await transport.request('/api/read');
  assert.equal(transport.state().connection, 'stale', 'fetch success does not manufacture SSE liveness');
  assert.equal(timers.size, 1, 'fetch does not arm the watchdog');
  await assert.rejects(() => transport.request('/api/unauthorized'), BrowserRequestError);
  assert.equal(transport.state().connection, 'stale', 'an HTTP error response is not SSE liveness either');
  source.heartbeat();
  assert.equal(transport.state().connection, 'online');
  assert.equal(describeConnection(transport.state()).controlAvailable, true);
  stop();
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

test('browser transport parses typed 409 refusal bodies into safe error properties', async () => {
  const transport = createBrowserTransport({
    fetch: async () => new Response(JSON.stringify({
      error: 'Only a pending enrollment can be cancelled.',
      code: 'not-pending',
      disposition: 'conflict',
    }), { status: 409, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    () => transport.request('/api/environments/enrollments/env-1/cancel', { method: 'POST' }),
    (error: unknown) => {
      assert.ok(error instanceof BrowserRequestError);
      assert.equal(error.kind, 'rejected');
      assert.equal(error.status, 409);
      assert.equal(error.code, 'not-pending');
      assert.equal(error.refusal, 'Only a pending enrollment can be cancelled.');
      assert.equal(error.message, 'Only a pending enrollment can be cancelled.');
      assert.equal(error.disposition, 'conflict');
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
  source.emitRun({ id: 'run-1' }, 'v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  source.emitRun({ id: 'run-1' }, 'v2:1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
  source.emitRun({ id: 'run-1', status: 'completed' }, 'v2:2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.deepEqual(received, [
    { type: 'run', data: { id: 'run-1' }, cursor: 'v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    {
      type: 'run', data: { id: 'run-1', status: 'completed' },
      cursor: 'v2:2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  ]);
  assert.ok(stale);
  stale();
  assert.equal(transport.state().connection, 'stale');
  source.error();
  assert.equal(transport.state().connection, 'reconnecting');
  stop();
  assert.equal(source.closed, true);
});
