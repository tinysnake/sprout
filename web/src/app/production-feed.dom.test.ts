import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { feedTarget, type FeedFilter, type FeedSnapshot, type FeedTarget } from '../../../src/web/feed.ts';
import type { BrowserTransportState } from '../transport/browser-transport.js';
import type { FeedBrowserAdapter } from '../adapters/feed-api.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://sprout-test.invalid/app/feed',
  pretendToBeVisual: true,
});
(dom.window as unknown as Record<string, unknown>).__SPROUT_TEST_MANUAL_MOUNT__ = true;

const replacements: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  HTMLFormElement: dom.window.HTMLFormElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  SVGElement: dom.window.SVGElement,
  Element: dom.window.Element,
  Document: dom.window.Document,
  DocumentFragment: dom.window.DocumentFragment,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  navigator: dom.window.navigator,
  getComputedStyle: dom.window.getComputedStyle,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  FocusEvent: dom.window.FocusEvent,
  CustomEvent: dom.window.CustomEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 10),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: dom.window.MutationObserver,
  NodeFilter: dom.window.NodeFilter,
};
for (const [key, value] of Object.entries(replacements)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { createServer } = await import('vite');
const { default: vue } = await import('@vitejs/plugin-vue');
const vite = await createServer({
  root: new URL('../..', import.meta.url).pathname,
  appType: 'custom',
  logLevel: 'error',
  plugins: [
    {
      name: 'force-client-vue',
      enforce: 'pre',
      transform(_code, _id, options) {
        if (options) options.ssr = false;
      },
    },
    vue(),
  ],
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true },
});

const scopes: FeedSnapshot['scopes'] = [
  { id: 'feed:all', kind: 'all', label: 'All Projects', attentionCount: 4 },
  { id: 'all', kind: 'project', label: 'Project named all', attentionCount: 2 },
  { id: 'infra', kind: 'project', label: 'Project named infra', attentionCount: 1 },
  { id: 'feed:infra', kind: 'infrastructure', label: 'Infrastructure', attentionCount: 1 },
];
const baseSnapshot: FeedSnapshot = {
  scopes,
  attention: [
    {
      id: 'blocker:task-1', severity: 'action_required', category: 'task-blocker',
      reason: 'A Task needs a Human decision.', lifecycle: 'Task blocked · No active Agent run · Lease held',
      target: feedTarget({ surface: 'project-task-detail', projectId: 'all', taskId: 'task-1' }),
      scopes: ['all'], source: { kind: 'task', id: 'task-1' }, at: 1_700_000_000_000,
    },
    {
      id: 'proposal:proposal-1', severity: 'info', category: 'proposal-pending',
      reason: 'A proposed Task awaits approval.', lifecycle: 'Proposal proposed · No lease · No runs',
      target: feedTarget({ surface: 'project-tasks', projectId: 'all', proposalId: 'proposal-1' }),
      scopes: ['all'], source: { kind: 'proposal', id: 'proposal-1' }, at: 1_700_000_000_001,
    },
    {
      id: 'enrollment:env-1', severity: 'attention', category: 'enrollment-pending',
      reason: 'An Environment enrollment awaits approval.', lifecycle: 'Enrollment pending · Approval not granted · Work admission barred',
      target: feedTarget({ surface: 'environment-detail', environmentId: 'env-1' }),
      scopes: ['feed:infra'], source: { kind: 'enrollment', id: 'env-1' }, at: 1_700_000_000_002,
    },
    {
      id: 'event:event-infra', severity: 'action_required', category: 'human-action-required',
      reason: 'A Project event needs Human review.', lifecycle: 'Project event · Human action required · review',
      target: feedTarget({ surface: 'project-overview', projectId: 'infra' }),
      scopes: ['infra'], source: { kind: 'event', id: 'event-infra' }, at: 1_700_000_000_003,
    },
  ],
  inFlight: [
    {
      id: 'run:run-1', kind: 'run', lifecycle: 'Run running · Agent agent-1 · Task task-1',
      scopes: ['all'], target: feedTarget({ surface: 'project-task-detail', projectId: 'all', taskId: 'task-1' }),
      projectId: 'all', taskId: 'task-1', runId: 'run-1', agentId: 'agent-1', engine: 'codex', model: 'gpt-5.4', at: 1_700_000_000_003,
    },
    {
      id: 'run:run-unscoped', kind: 'run', lifecycle: 'Run running · Agent agent-2',
      scopes: [], target: feedTarget({ surface: 'agent-detail', agentId: 'agent-2' }),
      runId: 'run-unscoped', agentId: 'agent-2', at: 1_700_000_000_006,
    },
  ],
  activity: [
    {
      id: 'event:event-1', kind: 'task-blocker', summary: 'Task blocker was recorded.', scopes: ['all'],
      target: feedTarget({ surface: 'project-overview', projectId: 'all' }), projectId: 'all', at: 1_700_000_000_004,
    },
    {
      id: 'event:event-2', kind: 'environment-readiness', summary: 'Environment readiness was checked.', scopes: ['feed:infra'],
      target: feedTarget({ surface: 'environments' }), at: 1_700_000_000_005,
    },
    {
      id: 'message:chat-1', kind: 'message', summary: 'A Project Message is available.', scopes: ['all'],
      target: feedTarget({ surface: 'project-chat', projectId: 'all' }), projectId: 'all', at: 1_700_000_000_007,
    },
    {
      id: 'event:hostile-target', kind: 'task-event', summary: 'A malformed destination must be rejected.', scopes: ['all'],
      target: { surface: 'agent-detail', agentId: '../settings', path: '/manage/settings' } as FeedTarget,
      at: 1_700_000_000_008,
    },
  ],
};

function filteredSnapshot(scope: string): FeedSnapshot {
  if (scope === 'feed:all') return baseSnapshot;
  const includes = (itemScopes: readonly string[]) => itemScopes.includes(scope);
  return {
    ...baseSnapshot,
    attention: baseSnapshot.attention.filter((item) => includes(item.scopes)),
    inFlight: baseSnapshot.inFlight.filter((item) => includes(item.scopes)),
    activity: baseSnapshot.activity.filter((item) => includes(item.scopes)),
  };
}

function createFeedService(options: { readonly fail?: boolean } = {}) {
  const calls: FeedFilter[] = [];
  const listeners = new Set<(state: BrowserTransportState) => void>();
  let connection: BrowserTransportState['connection'] = 'online';
  const service: FeedBrowserAdapter = {
    state: () => ({ status: connection, connection, loading: false }),
    subscribeState(listener) {
      listeners.add(listener);
      listener(service.state());
      return () => listeners.delete(listener);
    },
    async load(filter: FeedFilter = {}) {
      calls.push(filter);
      if (options.fail) {
        connection = 'offline';
        for (const listener of listeners) listener(service.state());
        throw Object.assign(new Error('private transport diagnostic'), { kind: 'unavailable' });
      }
      return filteredSnapshot(filter.scope ?? 'feed:all');
    },
  };
  return { service, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

async function routeToFeed(url = '/app/feed'): Promise<void> {
  dom.window.history.replaceState(null, '', url);
  dom.window.document.body.innerHTML = '<div id="app"></div>';
}

test('production Feed wires its read adapter, restores namespaced scope context, and reports explicit states', async (t) => {
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { FEED_CLOCK } = (await vite.ssrLoadModule('/src/views/feed-port.ts')) as typeof import('../views/feed-port.ts');
    const feed = createFeedService();
    await routeToFeed('/app/feed?scope=all&urgency=action_required&activity=all');
    const { app, router } = createSproutApp({ routerBase: '/app/', feedService: feed.service, connectionSource: feed.service });
    app.provide(FEED_CLOCK, () => 1_700_000_120_003);
    await router.isReady();
    app.mount(dom.window.document.getElementById('app')!);
    await settle();

    assert.equal(dom.window.document.querySelector('.feed-view')?.getAttribute('data-state'), 'ready');
    await t.test('in-flight cards show configured engine, model, and elapsed duration', () => {
      const card = dom.window.document.querySelector('[data-inflight-id="run:run-1"]');
      assert.ok(card);
      assert.match(card.textContent ?? '', /Engine: codex/);
      assert.match(card.textContent ?? '', /Model: gpt-5\.4/);
      assert.match(card.textContent ?? '', /Elapsed 2m/);
    });
    await t.test('every interactive Feed control meets the 44px minimum height', () => {
      const controls = [...dom.window.document.querySelectorAll(
        '.feed-view button, .feed-view select, .feed-view input, .feed-view textarea, .feed-view a[href], .feed-view [role="button"]',
      )];
      assert.ok(controls.length > 0, 'the rendered Feed contains interactive controls');
      for (const control of controls) {
        const match = control.className.match(/(?:^|\s)min-h-\[(\d+)px\](?:\s|$)/);
        assert.ok(match, `${control.tagName} declares a minimum height`);
        assert.ok(Number(match[1]) >= 44, `${control.tagName} minimum height is at least 44px`);
      }
    });
    assert.deepEqual(feed.calls.slice(0, 2).map((filter) => filter.scope), ['feed:all', 'all']);
    let scope = dom.window.document.querySelector('#feed-scope-select') as HTMLSelectElement;
    assert.equal(scope.value, 'all', 'Project id "all" remains distinct from synthetic feed:all');
    assert.equal(dom.window.document.querySelectorAll('[data-attention-id]').length, 1, 'urgency filter is applied to Attention');
    assert.ok(dom.window.document.querySelector('[data-inflight-id="run:run-1"]'));
    assert.ok(dom.window.document.querySelector('[data-activity-id="event:event-1"]'));
    assert.equal(dom.window.document.activeElement?.textContent?.includes('Feed & Human Attention'), true, 'page heading receives focus');

    (dom.window.document.querySelector('[data-attention-id="blocker:task-1"]') as HTMLButtonElement).click();
    await settle();
    assert.equal(router.currentRoute.value.path, '/project/tasks/task-1');
    assert.equal(router.currentRoute.value.query['project'], 'all', 'deep link carries the exact Project identity');
    assert.ok(dom.window.document.querySelector('#btn-pop-return'), 'return-to-Feed context is available');
    assert.match(dom.window.document.querySelector('[data-testid="shell-announcer"]')?.textContent ?? '', /Back to Feed is available/);

    (dom.window.document.querySelector('#btn-pop-return') as HTMLButtonElement).click();
    await settle();
    assert.equal(router.currentRoute.value.path, '/feed');
    assert.equal(router.currentRoute.value.query['scope'], 'all');
    assert.equal(router.currentRoute.value.query['urgency'], 'action_required');
    assert.equal(dom.window.document.activeElement?.textContent?.includes('Feed & Human Attention'), true, 'return focuses the Feed heading');

    (dom.window.document.querySelector('[data-activity-id="event:hostile-target"]') as HTMLButtonElement).click();
    await settle();
    assert.equal(router.currentRoute.value.name, 'feed', 'a malformed target cannot escape to another authority');
    assert.equal(dom.window.document.querySelector('#btn-pop-return'), null, 'rejected route data creates no return context');

    (dom.window.document.querySelector('[data-activity-id="message:chat-1"]') as HTMLButtonElement).click();
    await settle();
    assert.equal(router.currentRoute.value.name, 'project-chat');
    assert.equal(router.currentRoute.value.query['project'], 'all', 'Chat receives the exact Project identity');
    assert.ok(dom.window.document.querySelector('#btn-pop-return'), 'Chat keeps return-to-Feed context');
    (dom.window.document.querySelector('#btn-pop-return') as HTMLButtonElement).click();
    await settle();
    assert.equal(router.currentRoute.value.name, 'feed');
    assert.equal(router.currentRoute.value.query['scope'], 'all');
    assert.equal(router.currentRoute.value.query['urgency'], 'action_required');

    scope = dom.window.document.querySelector('#feed-scope-select') as HTMLSelectElement;
    scope.value = 'feed:infra';
    scope.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    assert.ok(feed.calls.some((filter) => filter.scope === 'feed:infra'), 'infrastructure uses its namespaced token');
    const attentionUrgency = [...dom.window.document.querySelectorAll('[aria-label="Filter Attention by urgency"] button')]
      .find((button) => button.textContent?.startsWith('Attention (')) as HTMLButtonElement | undefined;
    assert.ok(attentionUrgency, 'the Attention urgency option remains available');
    attentionUrgency.click();
    await settle();
    assert.ok(dom.window.document.querySelector('[data-attention-id="enrollment:env-1"]'));
    (dom.window.document.querySelector('[data-attention-id="enrollment:env-1"]') as HTMLButtonElement).click();
    await settle();
    assert.equal(router.currentRoute.value.path, '/manage/environments/env-1');
    assert.equal(router.currentRoute.value.query['project'], undefined);
    (dom.window.document.querySelector('#btn-pop-return') as HTMLButtonElement).click();
    await settle();
    assert.equal(router.currentRoute.value.query['scope'], 'feed:infra');
    assert.equal(router.currentRoute.value.query['urgency'], 'attention');

    scope = dom.window.document.querySelector('#feed-scope-select') as HTMLSelectElement;
    scope.value = 'infra';
    scope.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    assert.equal(dom.window.document.querySelector('[data-attention-id="enrollment:env-1"]'), null,
      'Project id infra remains distinct from feed:infra');
    const actionUrgency = [...dom.window.document.querySelectorAll('[aria-label="Filter Attention by urgency"] button')]
      .find((button) => button.textContent?.toLowerCase().startsWith('action required (')) as HTMLButtonElement | undefined;
    assert.ok(actionUrgency);
    actionUrgency.click();
    await settle();
    assert.ok(dom.window.document.querySelector('[data-attention-id="event:event-infra"]'));
    (dom.window.document.querySelector('[data-attention-id="event:event-infra"]') as HTMLButtonElement).click();
    await settle();
    assert.equal(router.currentRoute.value.path, '/project/overview');
    assert.equal(router.currentRoute.value.query['project'], 'infra');
    (dom.window.document.querySelector('#btn-pop-return') as HTMLButtonElement).click();
    await settle();
    assert.equal(router.currentRoute.value.query['scope'], 'infra');
    assert.equal(router.currentRoute.value.query['urgency'], 'action_required');

    scope = dom.window.document.querySelector('#feed-scope-select') as HTMLSelectElement;
    scope.value = 'feed:all';
    scope.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    const unscopedRun = dom.window.document.querySelector('[data-inflight-id="run:run-unscoped"]') as HTMLButtonElement | null;
    assert.ok(unscopedRun, 'an unscoped Agent run remains visible under All Projects');
    unscopedRun.click();
    await settle();
    assert.equal(router.currentRoute.value.path, '/manage/agents/agent-2');
    assert.ok(dom.window.document.querySelector('#btn-pop-return'), 'Agent detail retains return-to-Feed context');
    (dom.window.document.querySelector('#btn-pop-return') as HTMLButtonElement).click();
    await settle();
    assert.equal(router.currentRoute.value.query['scope'], 'feed:all');
    assert.equal(router.currentRoute.value.query['urgency'], 'action_required');
    app.unmount();

    await routeToFeed();
    const missing = createSproutApp({ routerBase: '/app/' });
    await missing.router.isReady();
    missing.app.mount(dom.window.document.getElementById('app')!);
    await settle();
    assert.equal(dom.window.document.querySelector('.feed-view')?.getAttribute('data-state'), 'unavailable');
    missing.app.unmount();

    await routeToFeed();
    const failed = createFeedService({ fail: true });
    const offline = createSproutApp({ routerBase: '/app/', feedService: failed.service, connectionSource: failed.service });
    await offline.router.isReady();
    offline.app.mount(dom.window.document.getElementById('app')!);
    await settle();
    assert.equal(dom.window.document.querySelector('.feed-view')?.getAttribute('data-state'), 'offline');
    assert.match(dom.window.document.querySelector('.feed-view')?.textContent ?? '', /Feed is offline/);
    assert.doesNotMatch(dom.window.document.querySelector('.feed-view')?.textContent ?? '', /private transport diagnostic/);
    offline.app.unmount();
  } finally {
    await vite.close();
    dom.window.close();
  }
});
