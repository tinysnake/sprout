import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { FeedTarget } from '../../../src/web/feed.ts';

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
const scrollRequests: { readonly target?: string; readonly block?: ScrollLogicalPosition }[] = [];
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value(this: HTMLElement, options?: ScrollIntoViewOptions) {
    scrollRequests.push({ target: this.dataset['messageId'] ?? this.dataset['eventId'], block: options?.block });
  },
});

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


const { createSproutApp, createProductionAppOptions } = await vite.ssrLoadModule('/src/app/main.ts') as typeof import('./main.ts');
const { createBrowserTransport } = await vite.ssrLoadModule('/src/transport/browser-transport.ts') as typeof import('../transport/browser-transport.ts');
const { journeyWire } = await import('./production-journey-wire.ts');
const doc = dom.window.document;
const settle = () => new Promise(resolve => setTimeout(resolve, 100));
async function waitFor(predicate: () => boolean, failure: string) {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(predicate(), failure);
}

async function harness(width: number, initial = '/project/overview?project=project-a') {
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: width < 768 ? 844 : 900 });
  dom.window.history.replaceState(null, '', '/app' + initial);
  doc.body.innerHTML = '<div id="app"></div>';
  const wire = journeyWire();
  const announcements: string[] = [];
  const observer = new dom.window.MutationObserver(() => {
    const message = doc.querySelector('.shell-announcer')?.textContent?.trim();
    if (message) announcements.push(message);
  });
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
  const calls: { path: string; method: string; csrf: string | null }[] = [];
  const sources: import('../transport/browser-transport.ts').BrowserEventSource[] = [];
  const runListeners = new Set<(event: MessageEvent<string>) => void>();
  const timers = new Map<number, () => void>();
  let timer = 0;
  const transport = createBrowserTransport({
    fetch: async (input, init) => {
      calls.push({ path: String(input), method: init?.method ?? 'GET', csrf: new Headers(init?.headers).get('x-sprout-csrf') });
      return wire.respond(String(input), init);
    },
    eventSource: () => {
      const source: import('../transport/browser-transport.ts').BrowserEventSource = { onopen: null, onmessage: null, onerror: null, addEventListener(type, listener) { if (type === 'run') runListeners.add(listener); }, close() {} };
      sources.push(source);
      queueMicrotask(() => source.onopen?.(new Event('open')));
      return source;
    },
    setTimeout: ((callback: TimerHandler) => { const id = ++timer; if (typeof callback === 'function') timers.set(id, callback as () => void); return id; }) as typeof globalThis.setTimeout,
    clearTimeout: ((id: ReturnType<typeof globalThis.setTimeout>) => { timers.delete(Number(id)); }) as typeof globalThis.clearTimeout,
  });
  const options = { ...createProductionAppOptions(transport), routerBase: '/app/' };
  let mounted = createSproutApp(options);
  await mounted.router.isReady();
  mounted.app.mount(doc.getElementById('app')!);
  await settle();
  const stopEvents = transport.events(() => {});
  for (const source of sources) source.onopen?.(new Event('open'));
  await settle();
  return {
    wire, calls, transport, sources, timers, announcements,
    async emitRun() {
      const event = new dom.window.MessageEvent('run', { data: JSON.stringify({ id: 'run-a', status: 'completed' }) });
      for (const listener of runListeners) listener(event);
      await settle();
    },
    get router() { return mounted.router; },
    async go(path: string) { await mounted.router.push(path); await settle(); },
    async back() { mounted.router.back(); await settle(); },
    async forward() { mounted.router.forward(); await settle(); },
    async refresh() {
      mounted.app.unmount();
      mounted.router.options.history.destroy();
      doc.body.innerHTML = '<div id="app"></div>';
      mounted = createSproutApp({ ...createProductionAppOptions(transport), routerBase: '/app/' });
      await mounted.router.isReady(); mounted.app.mount(doc.getElementById('app')!); await settle();
    },
    close() { observer.disconnect(); mounted.app.unmount(); mounted.router.options.history.destroy(); stopEvents(); },
  };
}

function mainText() { return doc.querySelector('#sprout-main-content')?.textContent ?? ''; }
function exactTask() {
  assert.match(mainText(), /Journey Task A/);
  assert.match(mainText(), /Exact Task goal A/);
  assert.match(mainText(), /Exact constraint A/);
  assert.match(mainText(), /Exact validation A/);
}
async function click(selector: string) {
  let control = doc.querySelector<HTMLElement>(selector);
  for (let attempt = 0; !control && attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
    control = doc.querySelector<HTMLElement>(selector);
  }
  assert.ok(control, 'reachable action: ' + selector + '\nRendered main: ' + mainText());
  control.focus(); control.click(); await settle();
}
const parity = new Map<string, string[]>();
function actionParity(width: number, stage: string, selector: string) {
  const actions = [...doc.querySelectorAll<HTMLElement>(selector)].map(control => [control.tagName, control.getAttribute('href'), control.getAttribute('data-task-authority'), control.getAttribute('data-usage-activity'), control.getAttribute('aria-label'), control.getAttribute('disabled')].join('|'));
  assert.ok(actions.length, 'action inventory exists at ' + stage);
  if (width === 390) parity.set(stage, actions);
  else assert.deepEqual(actions, parity.get(stage), 'phone/desktop action parity at ' + stage);
}
function continuity() {
  assert.ok(doc.activeElement && doc.activeElement !== doc.body && doc.contains(doc.activeElement), 'navigation retains focus in the mounted product');
  assert.equal(doc.querySelector('.shell-announcer')?.getAttribute('aria-live'), 'polite');
}

// Risk map: production wiring/identity -> same mounted journey at two widths;
// untrusted destinations -> click matrices; shared liveness -> rendered controls.
for (const width of [390, 1440]) {
  test('production composition preserves exact records, actions and continuity at width ' + width, async () => {
    const h = await harness(width);
    try {
      assert.match(mainText(), /Journey Project A/);
      assert.match(mainText(), /Exact Project goal A/);
      actionParity(width, 'overview', '.project-contract-card button, .new-project-btn');
      const nav = width === 390 ? '.mobile-bottom-nav' : '.desktop-sidebar';
      await click(nav + ' a[href*="/project/chat"]');
      assert.match(mainText(), /Exact Chat message A/); continuity();
      await h.back(); assert.match(mainText(), /Exact Project goal A/);
      await click(nav + ' a[href*="/project/tasks"]');
      assert.ok(doc.querySelector('[data-record-id="task-a"]'));
      await click('[data-record-id="task-a"]'); exactTask(); continuity();
      actionParity(width, 'task', '[data-task-authority], [data-task-run-target]');
      for (const [authority, proof] of [
        ['project', /Exact Project goal A/], ['agent', /Exact Agent instructions A/], ['environment', /Exact recovery reason A/],
      ] as const) {
        const link = doc.querySelector('[data-task-authority="' + authority + '"]');
        assert.match(link?.className ?? '', /min-h-\[44px\]/);
        await click('[data-task-authority="' + authority + '"]');
        assert.match(mainText(), proof); continuity();
        if (authority === 'agent') assert.match(mainText(), /Exact compatible option A/);
        if (authority === 'environment') assert.match(mainText(), /Exact retained evidence A/);
        await h.back(); exactTask();
        await h.forward(); assert.match(mainText(), proof);
        await h.back(); exactTask();
      }
      await click('[data-task-run-target="run-a"]');
      assert.match(mainText(), /Exact Agent instructions A/);
      assert.equal(doc.querySelector('[data-run-id="run-a"]')?.getAttribute('aria-current'), 'true');
      await h.back(); exactTask();
      await h.refresh(); exactTask();
      // A refresh creates a new browser composition/session check. Route changes do not.
      assert.equal(h.calls.filter(c => c.path === '/api/auth/sessions').length, 2);
      await h.go('/feed?scope=project-a&urgency=all&activity=all');
      const proofs = [/Exact Chat message A/, /Exact recovery reason A/, /Exact Agent instructions A/, /Exact Project goal A/, /Exact Task goal A/];
      for (let i = 0; i < proofs.length; i++) {
        const announcementStart = h.announcements.length;
        await click('[data-activity-id="journey-' + i + '"]');
        assert.match(mainText(), proofs[i]!); continuity();
        assert.ok(h.announcements.slice(announcementStart).some(message => /Back to Feed is available/.test(message)), 'return navigation emits a live-region announcement');
        await click('#btn-pop-return');
        assert.equal(h.router.currentRoute.value.query.scope, 'project-a');
        assert.equal(h.router.currentRoute.value.query.urgency, 'all');
        assert.equal(h.router.currentRoute.value.query.activity, 'all');
        assert.ok(doc.querySelector('[data-activity-id="journey-' + i + '"]'));
        assert.match(doc.activeElement?.textContent ?? '', /Feed & Human Attention/);
      }
      await h.go('/manage/usage');
      assert.ok(doc.querySelector('[data-usage-backing-activity="usage-a"]'), 'Usage retains the exact activity identity');
      assert.match(mainText(), /journey-model/);
      actionParity(width, 'usage', '[data-usage-tab], [data-usage-activity]');
      await click('[data-usage-activity="usage-a"]');
      assert.equal(doc.querySelector('[data-usage-activity="usage-a"]')?.getAttribute('aria-expanded'), 'true');
      assert.match(doc.querySelector('.usage-detail-panel')?.textContent ?? '', /usage-a.*project-a.*task-a.*agent-a.*journey-model/s);
      continuity();
      await h.go('/manage/settings');
      assert.match(mainText(), /2 active sessions/);
      actionParity(width, 'settings', '.session-revoke-btn, .revoke-others-btn');
      await click('.session-revoke-btn');
      const confirm = doc.querySelector<HTMLButtonElement>('.confirm-revoke-one-btn');
      assert.ok(confirm); confirm.click(); await settle();
      assert.match(mainText(), /1 active session/);
      assert.equal(h.calls.find(c => c.path === '/api/auth/sessions/session-other/revoke')?.csrf, 'journey-test-proof');
      await h.go('/project/chat/channel-a?project=project-a');
      assert.match(mainText(), /Exact Chat message A/);
      await h.refresh(); assert.match(mainText(), /Exact Chat message A/);
      h.wire.messages.push({ id: 'message-update-a', scopeId: 'channel-a', projectId: 'project-a', authorId: 'agent-a', authorKind: 'agent', body: 'Authoritative SSE arrival A', createdAt: Date.now() });
      await h.emitRun();
      assert.match(mainText(), /Authoritative SSE arrival A/);
      await waitFor(() => h.announcements.some(message => /1 new message/.test(message)), 'SSE-triggered authoritative catch-up announces the arrival');
      await h.go('/project/tasks/task-a?project=project-a'); exactTask();
      assert.deepEqual(h.wire.unknown, [], 'all reads have explicit wire contracts');
    } finally { h.close(); }
  });
}

test('chat activity opens its exact conversation and highlights the originating message', async () => {
  scrollRequests.length = 0;
  const h = await harness(390, '/feed?scope=project-a&urgency=all&activity=messages');
  try {
    await click('[data-activity-id="chat-completed:chat-run-a"]');
    assert.equal(h.router.currentRoute.value.name, 'project-chat-scope');
    assert.equal(h.router.currentRoute.value.params.scopeId, 'dm-a');
    assert.equal(h.router.currentRoute.value.query.project, 'project-a');
    assert.equal(h.router.currentRoute.value.query.message, 'message-a');
    const target = doc.querySelector('[data-message-id="message-a"]');
    assert.equal(target?.getAttribute('data-targeted'), 'message');
    assert.equal(doc.activeElement, target, 'focus follows the exact target message');
    assert.match(target?.textContent ?? '', /Exact Chat message A/);
    assert.match(doc.querySelector('[aria-label="Conversation detail"] header')?.textContent ?? '', /@Journey Agent A/, 'the specific Agent direct conversation is open');
    assert.ok(scrollRequests.some((request) => request.target === 'message-a' && request.block === 'center'), 'the exact message is scrolled to the center');
    assert.ok(doc.querySelector('#btn-pop-return'), 'the exact Chat destination retains Feed return context');
    await click('#btn-pop-return');
    assert.equal(h.router.currentRoute.value.name, 'feed');
    assert.equal(h.router.currentRoute.value.query.scope, 'project-a');
    assert.equal(h.router.currentRoute.value.query.urgency, 'all');
    assert.equal(h.router.currentRoute.value.query.activity, 'messages');
  } finally { h.close(); }
});

test('a chat Project event opens its Chat timeline entry', async () => {
  scrollRequests.length = 0;
  const h = await harness(390, '/feed?scope=project-a&activity=messages');
  try {
    await click('[data-activity-id="event:chat-completed"]');
    assert.equal(h.router.currentRoute.value.name, 'project-chat');
    assert.equal(h.router.currentRoute.value.query.project, 'project-a');
    assert.equal(h.router.currentRoute.value.query.event, 'event-chat-a');
    const target = doc.querySelector('[data-event-id="event-chat-a"]');
    assert.equal(target?.getAttribute('data-targeted'), 'event');
    assert.equal(doc.activeElement, target);
    assert.ok(scrollRequests.some((request) => request.target === 'event-chat-a' && request.block === 'center'));
    assert.match(target?.textContent ?? '', /Exact Chat event A/);
  } finally { h.close(); }
});

test('a run-failure activity focuses its own Project event instead of its originating Message', async () => {
  scrollRequests.length = 0;
  const h = await harness(390, '/feed?scope=project-a&urgency=all&activity=messages');
  try {
    await click('[data-activity-id="event:agent-run-failure"]');
    assert.equal(h.router.currentRoute.value.name, 'project-chat-scope');
    assert.equal(h.router.currentRoute.value.params.scopeId, 'dm-a');
    assert.equal(h.router.currentRoute.value.query.project, 'project-a');
    assert.equal(h.router.currentRoute.value.query.event, 'event-run-failure-a');
    assert.equal(h.router.currentRoute.value.query.message, undefined);
    const target = doc.querySelector('[data-event-id="event-run-failure-a"]');
    assert.equal(target?.getAttribute('data-targeted'), 'event');
    assert.equal(doc.activeElement, target, 'event activity focuses its own timeline event');
    assert.ok(scrollRequests.some((request) => request.target === 'event-run-failure-a' && request.block === 'center'));
    assert.match(target?.textContent ?? '', /Exact Agent run failure event A/);
    assert.ok(doc.querySelector('#btn-pop-return'), 'the event destination retains Feed return context');
    await click('#btn-pop-return');
    assert.equal(h.router.currentRoute.value.name, 'feed');
    assert.equal(h.router.currentRoute.value.query.scope, 'project-a');
    assert.equal(h.router.currentRoute.value.query.urgency, 'all');
    assert.equal(h.router.currentRoute.value.query.activity, 'messages');
  } finally { h.close(); }
});

test('a pruned Feed target opens the conversation without claiming message focus', async () => {
  scrollRequests.length = 0;
  const h = await harness(390, '/feed?scope=project-a&activity=messages');
  try {
    h.wire.messages.splice(1, 1);
    await click('[data-activity-id="chat-completed:chat-run-a"]');
    assert.equal(h.router.currentRoute.value.name, 'project-chat-scope');
    assert.equal(h.router.currentRoute.value.params.scopeId, 'dm-a');
    assert.equal(doc.querySelector('[data-message-id="message-a"]'), null);
    assert.ok(!scrollRequests.some((request) => request.target === 'message-a'), 'a missing target is not scrolled into false focus');
    assert.match(doc.querySelector('.chat-target-announcement')?.textContent ?? '', /unavailable.*without message focus/i);
    assert.doesNotMatch(doc.querySelector('.chat-target-announcement')?.textContent ?? '', /highlighted/i);
  } finally { h.close(); }
});

test('hostile Feed targets are exercised through the production click path', async () => {
  const h = await harness(390, '/feed?scope=project-a');
  try {
    const hostile = [
      { surface: 'agent-detail', agentId: '<img src=x onerror=alert(1)>', path: '/manage/agents/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E' },
      { surface: 'agent-detail', agentId: 'enroll-a', path: '/manage/agents/enroll-a' },
      { surface: 'agent-detail', agentId: 'agent-a', path: '/manage/settings' },
      { surface: 'project-chat', projectId: 'project-a', scopeId: '../settings', messageId: 'message-a', path: '/project/chat/%2E%2E%2Fsettings?message=message-a' },
      { surface: 'project-chat', projectId: 'project-a', messageId: 'message-a', path: '/project/chat?message=message-a' },
    ];
    for (const [i, target] of hostile.entries()) {
      h.wire.feed.activity = [{ id: 'hostile-' + i, kind: 'message', summary: 'Untrusted target', scopes: ['project-a'], at: Date.now(), target: target as FeedTarget }];
      await h.go('/manage/usage'); await h.go('/feed?scope=project-a');
      await click('[data-activity-id="hostile-' + i + '"]');
      if (i >= 3) assert.equal(h.router.currentRoute.value.name, 'feed', 'hostile or incomplete Chat identities keep the operator on Feed');
      if (h.router.currentRoute.value.name === 'feed') assert.equal(doc.querySelector('#btn-pop-return'), null);
      else {
        assert.match(mainText(), /not found|unavailable/i);
        assert.doesNotMatch(mainText(), /Exact Agent instructions A/);
      }
      assert.equal(doc.querySelector('img[onerror]'), null);
      assert.notEqual(h.router.currentRoute.value.name, 'settings');
      if (doc.querySelector('#btn-pop-return')) await click('#btn-pop-return');
    }
  } finally { h.close(); }
});

test('all Task authority links preserve hostile identities or reject without substitution', async () => {
  const h = await harness(1440, '/project/tasks/task-a?project=project-a');
  try {
    const hostile = '../settings?<script>alert(1)</script>';
    for (const kind of ['project', 'agent', 'environment', 'run'] as const) {
      h.wire.project.id = kind === 'project' ? hostile : 'project-a';
      h.wire.task.projectId = h.wire.project.id;
      h.wire.task.admission!.lead.memberId = kind === 'agent' ? hostile : 'agent-a';
      h.wire.enrollment.id = kind === 'environment' ? hostile : 'enroll-a';
      h.wire.taskRun.runId = kind === 'run' ? hostile : 'run-a';
      await h.go('/feed'); await h.go('/project/tasks/task-a?project=' + encodeURIComponent(h.wire.project.id)); exactTask();
      await click(kind === 'run' ? '[data-task-run-target]' : '[data-task-authority="' + kind + '"]');
      if (kind === 'run') {
        assert.match(mainText(), /Exact Agent instructions A/);
        assert.equal(doc.querySelector('[data-run-id][aria-current="true"]'), null, 'unknown run never selects a different run');
      } else if (kind === 'project' || kind === 'environment') {
        assert.match(mainText(), kind === 'project' ? /Exact Project goal A/ : /Exact recovery reason A/);
      } else {
        assert.match(mainText(), /not found|unavailable|could not/i);
        assert.doesNotMatch(mainText(), kind === 'project' ? /Exact Project goal A/ : kind === 'agent' ? /Exact Agent instructions A/ : /Exact recovery reason A/);
      }
      assert.equal(doc.querySelector('script'), null);
      await h.back(); exactTask();
    }
  } finally { h.close(); }
});

test('shared transport liveness gates rendered Environment, Agent, Project and Usage routes', async () => {
  const h = await harness(1440);
  try {
    assert.equal(h.calls.filter(c => c.path === '/api/auth/sessions').length, 1, 'one initial session/CSRF read for the whole mounted composition');
    for (const [path, proof, control] of [
      ['/manage/environments/enroll-a', /Exact recovery reason A/, '.environments-view button'],
      ['/manage/agents/agent-a', /Exact Agent instructions A/, '.agents-view button'],
      ['/project/overview?project=project-a', /Exact Project goal A/, '.new-project-btn'],
      ['/manage/usage', /journey-model/, ''],
    ] as const) {
      await h.go(path); assert.match(mainText(), proof);
      for (const state of ['reconnecting', 'stale', 'online'] as const) {
        if (state === 'reconnecting') for (const source of h.sources) source.onerror?.(new Event('error'));
        if (state === 'stale') [...h.timers.values()].at(-1)?.();
        if (state === 'online') for (const source of h.sources) source.onopen?.(new Event('open'));
        await settle();
        assert.equal(h.transport.state().connection, state);
        assert.match(doc.querySelector('.operator-pill')?.textContent ?? '', state === 'online' ? /Online/ : state === 'stale' ? /Stale/i : /Reconnecting/i);
        assert.match(mainText(), proof, 'liveness retains exact route facts');
        assert.ok(doc.querySelector('.shell-announcer')?.textContent?.trim(), 'liveness announces');
        if (control) {
          const buttons = [...doc.querySelectorAll<HTMLButtonElement>(control)].filter(b => /Register|Create|New|Edit|Revoke|Archive|Probe/.test(b.textContent ?? '') && !b.hasAttribute('aria-pressed') || b.classList.contains('new-project-btn'));
          assert.ok(buttons.length > 0);
          assert.ok(buttons.every(b => b.disabled === (state !== 'online')), 'rendered mutation authority tracks liveness: ' + path + ' ' + state + ' ' + buttons.map(b => (b.textContent ?? '') + ':' + b.disabled).join(','));
        }
      }
    }
    assert.equal(h.calls.filter(c => c.path === '/api/auth/sessions').length, 1, 'navigation does not reinitialize session/CSRF');
    assert.equal(h.calls.filter(c => c.path === '/api/auth/session').length, 0, 'an existing session never signs in again');
    assert.deepEqual(h.wire.unknown, []);
  } finally { h.close(); }
});

test('expired authority after browser remount renders sign-in instead of records', async () => {
  const h = await harness(390, '/project/tasks/task-a?project=project-a');
  try {
    exactTask(); h.wire.expire(); await h.refresh();
    assert.match(doc.body.textContent ?? '', /Sign in to Sprout/);
    assert.equal(doc.querySelector('[data-task-authority]'), null);
  } finally { h.close(); }
});

test.after(async () => { await vite.close(); dom.window.close(); });
