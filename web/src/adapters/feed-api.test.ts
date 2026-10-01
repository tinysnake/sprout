/**
 * Feed browser-adapter evidence (#103).
 *
 * The adapter is a typed read over the shared portable Feed vocabulary: it
 * encodes filters into the one GET route, maps refusals to safe typed errors,
 * and — because Attention has no dismiss or snooze — exposes no command method
 * at all. Deep-link identities produced by the projection are checked against
 * the shipped route table so a Feed card can never point at a route that does
 * not exist.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createFeedBrowserAdapter } from './feed-api.ts';
import { createBrowserTransport, BrowserRequestError } from '../transport/browser-transport.ts';
import { FEED_SURFACE_TEMPLATES, feedTarget, isFeedDeepLink } from '../../../src/web/feed.ts';

function stubTransport(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, calls: { url: string; init?: RequestInit }[] = []) {
  const transport = createBrowserTransport({
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
      return handler(String(url), init);
    }) as typeof fetch,
  });
  return { transport, calls };
}

test('load fetches the one GET route and encodes scope and urgency filters', async () => {
  const snapshot = { attention: [], inFlight: [], activity: [], scopes: [{ id: 'all', kind: 'all', label: 'All Projects', attentionCount: 0 }] };
  const { transport, calls } = stubTransport(() => new Response(JSON.stringify(snapshot), { status: 200 }));
  const feed = createFeedBrowserAdapter(transport);

  assert.deepEqual(await feed.load(), snapshot);
  await feed.load({ scope: 'project/with space', urgency: 'action_required' });
  await feed.load({ urgency: 'info' });

  assert.deepEqual(calls.map((call) => call.url), [
    '/api/feed',
    '/api/feed?scope=project%2Fwith+space&urgency=action_required',
    '/api/feed?urgency=info',
  ]);
  for (const call of calls) {
    assert.equal(call.init?.method ?? 'GET', 'GET', 'the Feed adapter never issues a command');
  }
});

test('the adapter exposes read capability only: no dismiss, snooze, or acknowledge command', () => {
  const { transport } = stubTransport(() => new Response('{}', { status: 200 }));
  const feed = createFeedBrowserAdapter(transport);
  assert.deepEqual(Object.keys(feed).sort(), ['load', 'state', 'subscribeState']);
  for (const forbidden of ['dismiss', 'snooze', 'acknowledge', 'clear'] as const) {
    assert.equal((feed as unknown as Record<string, unknown>)[forbidden], undefined);
  }
});

test('Feed refusals surface as safe typed errors, never raw diagnostics', async () => {
  const { transport } = stubTransport(
    () => new Response(JSON.stringify({ code: 'unknown-scope', error: 'unknown Feed scope: ghost' }), { status: 400 }),
  );
  const feed = createFeedBrowserAdapter(transport);
  await assert.rejects(
    () => feed.load({ scope: 'ghost' }),
    (error: unknown) => error instanceof BrowserRequestError
      && error.kind === 'rejected' && error.status === 400 && error.code === 'unknown-scope',
  );

  const unauthorized = stubTransport(() => new Response('{}', { status: 401 }));
  const denied = createFeedBrowserAdapter(unauthorized.transport);
  await assert.rejects(
    () => denied.load(),
    (error: unknown) => error instanceof BrowserRequestError && error.kind === 'authentication-required',
  );
});

test('every Feed deep-link surface resolves in the shipped route table', async () => {
  const source = await readFile(new URL('../router/index.ts', import.meta.url), 'utf8');
  const declared = [...source.matchAll(/path:\s*'([^']+)'/g)].map((match) => match[1]!);
  const normalize = (path: string): string =>
    path.replace(/\(\.\*\)\*/g, '').replace(/:[A-Za-z0-9_]+/g, ':p').replace(/\/+$/, '') || '/';
  const routeTable = new Set<string>(declared.map(normalize));
  for (const parent of declared.filter((path) => path.startsWith('/') && !path.startsWith('/:'))) {
    for (const child of declared.filter((path) => !path.startsWith('/'))) {
      routeTable.add(normalize(parent === '/' ? `/${child}` : `${parent}/${child}`));
    }
  }
  // The catch-all redirect is not a destination a deep link may claim.
  routeTable.delete('/:p');
  const resolves = (path: string): boolean =>
    [...routeTable].some((template) => new RegExp(`^${template.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:p/g, '[^/]+')}$`).test(path));

  const samples = [
    feedTarget({ surface: 'project-overview', projectId: 'proj-1' }),
    feedTarget({ surface: 'project-tasks', projectId: 'proj-1' }),
    feedTarget({ surface: 'project-tasks', projectId: 'proj-1', proposalId: 'proposal/1' }),
    feedTarget({ surface: 'project-task-detail', projectId: 'proj-1', taskId: 'task-1' }),
    feedTarget({ surface: 'project-chat', projectId: 'proj-1' }),
    feedTarget({ surface: 'project-chat-routing', projectId: 'proj-1', batchId: 'batch 1' }),
    feedTarget({ surface: 'environments' }),
    feedTarget({ surface: 'environment-detail', environmentId: 'enr-1' }),
  ];
  for (const template of Object.values(FEED_SURFACE_TEMPLATES)) {
    assert.ok(routeTable.has(normalize(template)), `template ${template} exists in the route table`);
  }
  for (const sample of samples) {
    assert.ok(isFeedDeepLink(sample), `sample identity is coherent: ${JSON.stringify(sample)}`);
    const [path] = sample.path.split('?');
    assert.ok(resolves(path!), `deep link ${sample.path} resolves to a shipped route`);
  }
});
