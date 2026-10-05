import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { MessageView, ProjectEventView } from '../../../../../src/web/views.ts';
import type { ActiveChatRun, ChatService } from '../types.ts';
import type { ConversationScopeView } from '../../../adapters/conversation-api.ts';

// Vue renders the real ChatView. JSDOM supplies events; only layout measurements,
// animation frames and ResizeObserver deliveries are simulated (JSDOM has no layout).
const dom = new JSDOM('<!doctype html><div id="app"></div>', {
  url: 'http://sprout-test.invalid/chat/channel?project=project', pretendToBeVisual: true,
});
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const observers = new Set<LayoutObserver>();
class LayoutObserver {
  connected = true;
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.add(this); }
  observe() {}
  disconnect() { this.connected = false; observers.delete(this); }
  unobserve() {}
  deliver() { this.callback([], this as unknown as ResizeObserver); }
}
const originals = new Map<string, PropertyDescriptor | undefined>();
const globals: Record<string, unknown> = {
  // Cadence is exercised by existing production tests. Here each refresh is
  // requested through visibilitychange so tests don't wait for a 15s timer.
  setInterval: () => ++frameId,
  clearInterval: () => {},
  window: dom.window, document: dom.window.document, history: dom.window.history, location: dom.window.location, localStorage: dom.window.localStorage,
  ResizeObserver: LayoutObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
  cancelAnimationFrame: (id: number) => frames.delete(id),
};
for (const key of ['HTMLElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'SVGElement', 'Document', 'DocumentFragment', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'navigator', 'getComputedStyle']) {
  globals[key] = (dom.window as unknown as Record<string, unknown>)[key];
}
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
let extraHeight = 0;
let viewportHeight = 200;
let automaticScrollEvents = false;
const pageSize = Number(readFileSync(new URL('./ChatView.vue', import.meta.url), 'utf8').match(/const CHAT_MESSAGE_PAGE_SIZE = (\d+)/)![1]);
const historyLimit = Number(readFileSync(new URL('./ChatView.vue', import.meta.url), 'utf8').match(/const CHAT_TIMELINE_MEMORY_LIMIT = (\d+)/)![1]);
const positions = new WeakMap<Element, number>();
let scrollWrites = 0;
Object.defineProperties(dom.window.HTMLElement.prototype, {
  clientHeight: { configurable: true, get() { return this.classList.contains('chat-messages-body') ? viewportHeight : 0; } },
  scrollHeight: { configurable: true, get() { return this.classList.contains('chat-messages-body') ? this.querySelectorAll('.chat-msg').length * 100 + extraHeight : 0; } },
  scrollTop: {
    configurable: true,
    get() { return positions.get(this) ?? 0; },
    set(value: number) {
      scrollWrites++;
      const previous = positions.get(this) ?? 0;
      const top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
      positions.set(this, top);
      // Native scroll delivery is asynchronous and only occurs on a changed position.
      if (automaticScrollEvents && top !== previous) queueMicrotask(() => this.dispatchEvent(new dom.window.Event('scroll')));
    },
  },
});
const { createServer } = await import('vite');
const { default: vuePlugin } = await import('@vitejs/plugin-vue');
const vite = await createServer({
  configFile: false,
  root: new URL('../../../..', import.meta.url).pathname,
  appType: 'custom', logLevel: 'error',
  plugins: [{ name: 'force-client-vue', enforce: 'pre', transform(_code, _id, options) { if (options) options.ssr = false; } }, vuePlugin()],
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true },
});
const { createApp, nextTick } = await import('vue');
const { createRouter, createMemoryHistory } = await import('vue-router');
const { default: ChatView } = await vite.ssrLoadModule('/src/modules/chat/views/ChatView.vue');
const { default: AppShell } = await vite.ssrLoadModule('/src/shell/AppShell.vue');
const { createPinia } = await import('pinia');
const { h } = await import('vue');
const { CHAT_SERVICE } = await vite.ssrLoadModule('/src/modules/chat/types.ts');
const { PROJECT_SERVICE } = await vite.ssrLoadModule('/src/modules/projects/types.ts');
const { SHELL_CONNECTION_SOURCE } = await vite.ssrLoadModule('/src/shell/use-shell-connection.ts');

async function flush() {
  for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick(); }
}
async function paint() {
  await flush();
  // Two browser paints settle initial content; no polling or real-time sleeps.
  for (let i = 0; i < 2; i++) {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(i * 16);
    await flush();
  }
}
function message(id: string, scopeId = 'channel', authorKind: 'human' | 'agent' = 'agent'): MessageView {
  return { id, scopeId, projectId: 'project', channel: scopeId, recipients: [], authorId: authorKind === 'human' ? 'operator' : 'agent', authorKind, body: id, createdAt: Number(id.replace(/\D/g, '')) || 1 };
}
function event(id: string, createdAt: number, originScopeIds?: readonly string[]): ProjectEventView {
  return { id, projectId: 'project', kind: 'agent-run-failure', summary: id, producerId: 'agent', producerKind: 'agent', disposition: 'recorded', responsibleAgentIds: [], ...(originScopeIds !== undefined ? { originScopeIds } : {}), createdAt };
}
async function page(query = '', options: { channelMessages?: number; directMessages?: number; events?: readonly ProjectEventView[]; taskGroup?: boolean; shell?: boolean; height?: number; automaticEvents?: boolean } = {}) {
  frames.clear(); extraHeight = 0; scrollWrites = 0;
  viewportHeight = options.height ?? 200;
  automaticScrollEvents = options.automaticEvents ?? false;
  let olderRequests = 0;
  let olderEventRequests = 0;
  let olderGate: Promise<void> | undefined;
  let releaseOlder: (() => void) | undefined;
  let refreshGate: Promise<void> | undefined;
  let releaseRefresh: (() => void) | undefined;
  const eventOriginRequests: string[] = [];
  dom.window.document.body.innerHTML = '<div id="app"></div>';
  const scopes: ConversationScopeView[] = [
    { id: 'channel', projectId: 'project', kind: 'project', createdAt: 1, updatedAt: 1 },
    { id: 'direct', projectId: 'project', kind: 'direct', participants: ['operator', 'agent'], createdAt: 1, updatedAt: 1 },
  ];
  if (options.taskGroup) scopes.push({
    id: 'task-group-42', projectId: 'project', kind: 'task-group', taskId: 'task-42',
    taskTitle: 'Verify migration rollback coverage', status: 'active', createdAt: 1, updatedAt: 1,
    content: { currentVersion: 1, versions: [{ version: 1, taskContentVersion: 1, at: 1, actorMemberId: 'operator', reason: 'Task admitted.', taskTitle: 'Verify migration rollback coverage', goal: 'Verify migrations.', rules: ['Keep history isolated.'] }] },
  });
  let messages = Array.from({ length: options.channelMessages ?? 8 }, (_, i) => message(`message-${i + 1}`));
  messages.push(...Array.from({ length: options.directMessages ?? 5 }, (_, i) => message(`direct-${i + 1}`, 'direct')));
  let events: ProjectEventView[] = [...(options.events ?? [])];
  let activeRuns: readonly ActiveChatRun[] = [];
  let runStatusListener: Parameters<ChatService['subscribeRunStatuses']>[0] | undefined;
  const state = () => ({ status: 'online' as const, connection: 'online' as const, loading: false });
  const service = {
    state, subscribeState: () => () => {},
    listScopes: async () => { await refreshGate; return scopes.map((scope) => ({ ...scope })); },
    listMessages: async (id?: string, options?: { limit?: number; before?: string }) => {
      const rows = messages.filter((item) => item.scopeId === id)
        .sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      if (options?.before !== undefined) {
        olderRequests++;
        await olderGate;
        const index = rows.findIndex((item) => item.id === options.before);
        const older = index < 0 ? [] : rows.slice(0, index);
        return (options.limit !== undefined ? older.slice(-options.limit) : older).map((item) => ({ ...item }));
      }
      return (options?.limit !== undefined ? rows.slice(-options.limit) : rows).map((item) => ({ ...item }));
    },
    listProjectEvents: async (_id: string, options?: { limit?: number; before?: string; originScopeId?: string }) => {
      const rows = events.filter((item) => options?.originScopeId === undefined || item.originScopeIds?.includes(options.originScopeId))
        .sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const end = options?.before === undefined ? rows.length : rows.findIndex((item) => item.id === options.before);
      if (options?.before !== undefined) {
        olderEventRequests++;
        await olderGate;
        eventOriginRequests.push(options.originScopeId ?? '');
      }
      if (end < 0) return { events: [], hasOlder: false };
      const limit = options?.limit ?? 50;
      const start = Math.max(0, end - limit);
      return { events: rows.slice(start, end).map((item) => ({ ...item })), hasOlder: start > 0 };
    },
    listRoutingBatches: async () => ({ batches: [], windows: [] }),
    listActiveRuns: async () => activeRuns,
    inspectScope: async (id: string) => ({ scope: scopes.find((scope) => scope.id === id)!, state: { scopeId: id, writable: true }, context: { scopeId: id, projectId: 'project', kind: 'project', project: { contentVersion: 1, goal: '', rules: [] } } }),
    subscribeRunStatuses: (listener) => { runStatusListener = listener; return () => { runStatusListener = undefined; }; },
    postMessage: async (input: { scopeId: string; body: string }) => {
      const sent = message('message-20', input.scopeId, 'human'); messages.push(sent);
      return { message: sent, admittedRunIds: [] };
    },
  } satisfies Partial<ChatService>;
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { name: 'project-chat-scope', path: '/chat/:scopeId', component: ChatView, meta: { destination: 'project', tab: 'chat' } },
    ...['feed', 'project-overview', 'project-tasks', 'project-chat', 'environments', 'agents', 'usage', 'settings']
      .map((name) => ({ name, path: `/${name}`, component: { render: () => null } })),
  ] });
  await router.push(`/chat/channel?project=project${query}`); await router.isReady();
  const app = createApp(options.shell ? { render: () => h(AppShell, null, { default: () => h(ChatView) }) } : ChatView);
  app.use(createPinia());
  app.use(router);
  app.provide(CHAT_SERVICE, service);
  app.provide(PROJECT_SERVICE, { listProjects: async () => [{ id: 'project', displayName: 'Project', status: 'active', content: { currentVersion: 1, versions: [{ version: 1, memberships: [], goal: '', rules: [] }] } }] });
  app.provide(SHELL_CONNECTION_SOURCE, service);
  app.mount(dom.window.document.getElementById('app')!);
  await paint();
  const list = dom.window.document.querySelector<HTMLElement>('.chat-messages-body')!;
  assert.ok(list, 'real conversation list rendered');
  let closed = false;
  return {
    list, router,
    olderRequests: () => olderRequests,
    olderEventRequests: () => olderEventRequests,
    eventOriginRequests: () => eventOriginRequests,
    holdRefresh() { refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; }); },
    releaseRefresh() { releaseRefresh?.(); refreshGate = undefined; },
    holdOlder() { olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; }); },
    releaseOlder() { releaseOlder?.(); olderGate = undefined; },
    async setRunStatus(status: 'queued' | 'running' | 'completed') {
      activeRuns = status === 'completed' ? [] : [{ id: 'chat-run', agentId: 'agent', status }];
      runStatusListener?.({ id: 'chat-run', status });
      await flush();
    },
    button: () => dom.window.document.querySelector<HTMLButtonElement>('.chat-jump-latest'),
    scroll(top: number) { list.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -100 })); positions.set(list, top); list.dispatchEvent(new dom.window.Event('scroll')); },
    async refresh() { dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); await flush(); },
    async addEvent(item: ProjectEventView) { events.push(item); await this.refresh(); await paint(); },
    async addMessage(item: MessageView) { messages.push(item); await this.refresh(); await paint(); },
    dataRows: () => [...list.querySelectorAll<HTMLElement>('[data-message-id], [data-event-id]')],
    async append(kind: 'human' | 'agent' | 'notice') {
      if (kind === 'notice') events.push({ id: 'notice', projectId: 'project', kind: 'agent-run-interruption', summary: 'Agent stopped', producerId: 'agent', producerKind: 'agent', responsibleAgentIds: [], disposition: 'recorded', createdAt: 30 });
      else messages.push(message(`message-${messages.length + 10}`, 'channel', kind));
      await this.refresh(); await paint();
    },
    close() { if (!closed) { closed = true; app.unmount(); } },
  };
}
function bottom(list: HTMLElement) { return list.scrollHeight - list.clientHeight; }

after(async () => {
  await vite.close(); dom.window.close();
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key);
  }
});

for (const reducedMotion of [false, true]) {
  test(`composer distinguishes active states without motion (${reducedMotion ? 'reduce' : 'no-preference'}) and removes them on settlement`, async () => {
    const originalMedia = Object.getOwnPropertyDescriptor(dom.window, 'matchMedia');
    Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: (query: string) => ({ matches: reducedMotion && query === '(prefers-reduced-motion: reduce)' }) });
    const p = await page();
    const doc = dom.window.document;
    try {
      const composer = doc.querySelector('.chat-composer');
      assert.equal(doc.querySelector('.chat-run-actions'), null, 'idle composer has no action bar');
      for (const [status, label, announcement] of [
        ['queued', '@agent · starting…', '@agent is starting…'],
        ['running', '@agent · working…', '@agent is working'],
      ] as const) {
        await p.setRunStatus(status);
        const actions = doc.querySelector('.chat-run-actions');
        assert.ok(actions);
        assert.equal(composer?.previousElementSibling, actions, 'status stays beside Stop above the input');
        const indicator = actions.querySelector('.chat-run-indicator');
        assert.ok(indicator, 'active run has a dynamic composer indicator');
        assert.equal(indicator.textContent?.trim(), label);
        const dot = indicator.querySelector('[aria-hidden="true"]');
        assert.ok(dot);
        for (const className of ['h-2', 'w-2', 'shrink-0', 'rounded-full', 'ring-2', 'ring-[var(--accent-primary)]', 'ring-offset-2', 'ring-offset-[var(--bg-surface-elevated)]', 'animate-pulse', 'motion-reduce:animate-none']) {
          assert.ok(dot.classList.contains(className), `indicator includes ${className}`);
        }
        assert.equal(dot.classList.contains('bg-[var(--accent-primary)]'), status === 'running', 'working fills the ring even when motion is disabled');
        assert.equal(dot.classList.contains('bg-transparent'), status === 'queued', 'starting remains a hollow ring');
        assert.ok(indicator.classList.contains('min-w-0'));
        assert.ok(indicator.querySelector('.truncate'), 'status label still truncates at narrow widths');
        assert.equal(actions.querySelector('[role="status"], [aria-live]'), null, 'composer does not repeat the live announcement');
        const strip = doc.querySelector('.chat-working-state');
        assert.ok(strip);
        assert.equal(strip.getAttribute('role'), 'status');
        assert.equal(strip.getAttribute('aria-live'), 'polite');
        assert.equal(strip.textContent?.trim(), announcement);
        assert.equal(strip.querySelector('.animate-pulse'), null, 'only the composer animates');
        const stop = actions.querySelector<HTMLButtonElement>('.chat-stop-run');
        assert.ok(stop);
        assert.equal(stop.textContent?.trim(), 'Stop');
        assert.equal(stop.getAttribute('aria-label'), 'Stop @agent');
        assert.equal(stop.disabled, false);
      }
      await p.setRunStatus('completed');
      assert.equal(doc.querySelector('.chat-run-indicator'), null, 'settled run leaves no animated indicator');
      assert.equal(doc.querySelector('.chat-run-actions'), null, 'settlement removes the entire bar');
      assert.equal(doc.querySelector('.chat-working-state'), null, 'settlement removes the live strip');
      assert.equal(doc.querySelector('.chat-composer'), composer, 'composer remains mounted');
    } finally {
      p.close();
      if (originalMedia) Object.defineProperty(dom.window, 'matchMedia', originalMedia);
      else Reflect.deleteProperty(dom.window, 'matchMedia');
    }
  });
}

function phoneViewport(width = 390, coarse = false) {
  const viewport = new dom.window.EventTarget();
  const geometry = { height: 800, offsetTop: 0, scale: 1 };
  Object.defineProperties(viewport, Object.fromEntries(Object.keys(geometry).map((key) => [key, {
    get: () => geometry[key as keyof typeof geometry], configurable: true,
  }])));
  const original = Object.getOwnPropertyDescriptor(dom.window, 'visualViewport');
  const originalMedia = Object.getOwnPropertyDescriptor(dom.window, 'matchMedia');
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: (query: string) => ({ matches: coarse && query === '(pointer: coarse)' }) });
  const originalWidth = dom.window.innerWidth;
  Object.defineProperty(dom.window, 'visualViewport', { configurable: true, value: viewport });
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: width });
  return {
    viewport, geometry,
    change(event = 'resize') { viewport.dispatchEvent(new dom.window.Event(event)); },
    restore() {
      Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: originalWidth });
      if (original) Object.defineProperty(dom.window, 'visualViewport', original);
      else Reflect.deleteProperty(dom.window, 'visualViewport');
      if (originalMedia) Object.defineProperty(dom.window, 'matchMedia', originalMedia);
      else Reflect.deleteProperty(dom.window, 'matchMedia');
    },
  };
}

test('phone keyboard resize constrains the shell and reveals an occluded composer without typing loops', async () => {
  const vv = phoneViewport();
  const { viewport, geometry } = vv;
  const p = await page('', { shell: true });
  const shell = dom.window.document.querySelector<HTMLElement>('.sprout-app-shell')!;
  const input = dom.window.document.querySelector<HTMLInputElement>('.chat-composer input')!;
  let revealCount = 0;
  let inputBottom = 740;
  input.getBoundingClientRect = () => ({ top: inputBottom - 44, bottom: inputBottom } as DOMRect);
  input.scrollIntoView = (options) => {
    assert.deepEqual(options, { block: 'nearest', inline: 'nearest', behavior: 'instant' });
    revealCount++; inputBottom = 400;
  };
  try {
    assert.equal(shell.style.height, '800px');
    assert.ok(shell.querySelector('.h-full'), 'inner shell follows the constrained outer height');
    const pane = dom.window.document.querySelector('[data-chat-layout="split"]')!;
    assert.ok(pane.classList.contains('min-h-0'), 'message pane can shrink below the old 520px floor');
    assert.ok(pane.classList.contains('md:min-h-[520px]'), 'desktop minimum is preserved');
    input.focus(); await paint();
    assert.equal(revealCount, 0, 'already visible focus does not move the page');
    geometry.height = 420;
    viewport.dispatchEvent(new dom.window.Event('resize'));
    viewport.dispatchEvent(new dom.window.Event('resize'));
    await paint();
    assert.equal(shell.style.height, '420px', 'shell shrinks to the area above the keyboard');
    assert.equal(revealCount, 1, 'occluded input is revealed after layout shrinks');
    for (const value of ['a', 'ab', 'abc']) {
      input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      viewport.dispatchEvent(new dom.window.Event('resize')); await paint();
    }
    assert.equal(input.value, 'abc'); assert.equal(dom.window.document.activeElement, input);
    assert.equal(revealCount, 1, 'typing and unchanged resize events do not jump');
    assert.equal(frames.size, 0, 'no self-scheduled frame loop');
    geometry.height = 800; viewport.dispatchEvent(new dom.window.Event('resize')); await paint();
    assert.equal(shell.style.height, '800px', 'keyboard dismissal restores the frame');
    geometry.height = 420; viewport.dispatchEvent(new dom.window.Event('resize'));
    p.close(); await paint();
    assert.equal(shell.style.height, '800px', 'queued work cannot mutate the removed shell');
    assert.equal(revealCount, 1);
    geometry.height = 300;
    viewport.dispatchEvent(new dom.window.Event('resize'));
    shell.dispatchEvent(new dom.window.Event('focusin')); await paint();
    assert.equal(frames.size, 0, 'viewport and focus listeners are removed on teardown');
  } finally { p.close(); vv.restore(); }
});

test('phone viewport panning and focus after keyboard opening reveal only the composer', async () => {
  const vv = phoneViewport();
  vv.geometry.height = 420;
  const p = await page('', { shell: true });
  const input = dom.window.document.querySelector<HTMLInputElement>('.chat-composer input')!;
  const selector = dom.window.document.querySelector<HTMLSelectElement>('#chat-project-selector')!;
  let reveals = 0;
  let top = 10;
  input.getBoundingClientRect = () => ({ top, bottom: top + 44 } as DOMRect);
  input.scrollIntoView = () => { reveals++; top = vv.geometry.offsetTop + 20; };
  selector.getBoundingClientRect = () => ({ top: 900, bottom: 944 } as DOMRect);
  selector.scrollIntoView = () => { throw new Error('Chat viewport handling must not scroll another focused control'); };
  try {
    selector.focus(); vv.geometry.offsetTop = 50; vv.change('scroll'); await paint();
    assert.equal(reveals, 0);
    input.focus(); await paint();
    assert.equal(reveals, 1, 'focus reveals the input when the keyboard is already open');
    vv.geometry.offsetTop = 100; vv.change('scroll'); await paint();
    assert.equal(reveals, 2, 'a pan can occlude the input at the visual viewport top');
    vv.change('scroll'); await paint();
    assert.equal(reveals, 2, 'unchanged panning does not repeat the scroll');
    assert.equal(dom.window.document.querySelector<HTMLElement>('.sprout-app-shell')!.style.height, '420px');
  } finally { p.close(); vv.restore(); }
});

test('desktop, pinch zoom and browsers without visualViewport keep their CSS frame', async () => {
  const vv = phoneViewport(1280);
  const p = await page('', { shell: true });
  const shell = dom.window.document.querySelector<HTMLElement>('.sprout-app-shell')!;
  try {
    vv.geometry.height = 420; vv.change(); await paint();
    assert.equal(shell.style.height, '', 'desktop viewport resizing does not override h-screen');
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 390 });
    dom.window.dispatchEvent(new dom.window.Event('resize')); await paint();
    assert.equal(shell.style.height, '420px', 'crossing to the phone layout updates the frame');
    vv.geometry.scale = 1.5; vv.change(); await paint();
    assert.equal(shell.style.height, '', 'pinch zoom does not collapse the layout');
    vv.geometry.scale = 1; vv.change(); await paint();
    assert.equal(shell.style.height, '420px', 'returning to normal scale restores keyboard sizing');
  } finally { p.close(); vv.restore(); }
  const fallbackWidth = dom.window.innerWidth;
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 390 });
  const fallback = await page('', { shell: true });
  try {
    dom.window.dispatchEvent(new dom.window.Event('resize')); await paint();
    assert.equal(dom.window.document.querySelector<HTMLElement>('.sprout-app-shell')!.style.height, '');
  } finally {
    fallback.close();
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: fallbackWidth });
  }
});

test('landscape touch devices above the desktop breakpoint still follow keyboard height', async () => {
  const vv = phoneViewport(844, true);
  vv.geometry.height = 420;
  const p = await page('', { shell: true });
  try {
    assert.equal(dom.window.document.querySelector<HTMLElement>('.sprout-app-shell')!.style.height, '420px');
    vv.geometry.height = 300; vv.change(); await paint();
    assert.equal(dom.window.document.querySelector<HTMLElement>('.sprout-app-shell')!.style.height, '300px');
  } finally { p.close(); vv.restore(); }
});

test('task-groups appear with a task marker and title and open from the Human scope list', async () => {
  const p = await page('', { taskGroup: true });
  try {
    const card = dom.window.document.querySelector<HTMLButtonElement>('[data-scope-id="task-group-42"]');
    assert.ok(card, 'the task-group is visible in the default scope list');
    assert.equal(card.dataset['scopeKind'], 'task-group');
    assert.match(card.textContent ?? '', /Verify migration rollback coverage/);
    assert.match(card.textContent ?? '', /Task group/);
    card.click();
    await flush();
    assert.equal(p.router.currentRoute.value.params['scopeId'], 'task-group-42');
  } finally { p.close(); }
});

test('opening a conversation aligns its rendered history to the bottom', async () => {
  const p = await page();
  try { assert.equal(p.list.scrollTop, bottom(p.list)); assert.equal(p.button(), null); }
  finally { p.close(); }
});

test('the newest mixed timeline page is bounded across messages and project events', async () => {
  const events = Array.from({ length: pageSize * 2 }, (_, index) => event(`event-${index + 1}`, index + 1));
  const p = await page('', { channelMessages: pageSize * 2, events });
  try {
    const rows = p.dataRows();
    assert.equal(rows.length, pageSize);
    assert.equal(rows.filter((row) => row.dataset['messageId'] !== undefined).length, pageSize / 2);
    assert.equal(rows.filter((row) => row.dataset['eventId'] !== undefined).length, pageSize / 2);
    assert.equal(rows[0]?.previousElementSibling?.classList.contains('chat-date-separator'), true, 'the first visible event has its date separator attached');
    assert.equal(p.olderRequests(), 0);
    assert.equal(p.olderEventRequests(), 0);
  } finally { p.close(); }
});

test('same Message and Project event IDs retain distinct timeline identity', async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
    originalWarn(...args);
  };
  const p = await page('', { channelMessages: 1, events: [event('message-1', 1)] });
  try {
    assert.deepEqual(p.dataRows().map((row) => row.dataset['eventId'] !== undefined
      ? `event:${row.dataset['eventId']}` : `message:${row.dataset['messageId']}`), ['event:message-1', 'message:message-1']);
    assert.equal(warnings.some((warning) => warning.includes('Duplicate keys')), false);
  } finally {
    p.close();
    console.warn = originalWarn;
  }
});

test('older merged pages resume both source boundaries without gaps or duplicates', async () => {
  const messages = Array.from({ length: pageSize * 2 }, (_, index) => message(`message-${index + 1}`));
  const events = Array.from({ length: pageSize * 2 }, (_, index) => event(`event-${index + 1}`, index + 1));
  const expected = [
    ...messages.map((item) => ({ key: `message:${item.id}`, createdAt: item.createdAt })),
    ...events.map((item) => ({ key: `event:${item.id}`, createdAt: item.createdAt })),
  ].sort((left, right) => left.createdAt - right.createdAt || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)).map((item) => item.key);
  const p = await page('', { channelMessages: pageSize * 2, events });
  const renderedKeys = () => p.dataRows().map((row) => row.dataset['messageId'] !== undefined
    ? `message:${row.dataset['messageId']}` : `event:${row.dataset['eventId']}`);
  try {
    assert.deepEqual(renderedKeys(), expected.slice(-pageSize));
    p.scroll(0); await paint();
    assert.deepEqual(renderedKeys(), expected.slice(-pageSize * 2));
    assert.equal(p.olderRequests(), 1, 'the message cursor advances to compare with the final buffered event');
    assert.equal(p.olderEventRequests(), 0);
    p.scroll(0); await paint();
    assert.deepEqual(renderedKeys(), expected.slice(-pageSize * 3));
    assert.equal(p.olderRequests(), 1);
    assert.equal(p.olderEventRequests(), 1, 'the event cursor advances when its retained page ends');
    p.scroll(0); await paint();
    assert.deepEqual(renderedKeys(), expected);
    assert.equal(new Set(renderedKeys()).size, expected.length);
  } finally { p.close(); }
});

test('only admitted input can queue one older page behind a live refresh', async () => {
  const p = await page('', { channelMessages: pageSize * 3 });
  try {
    p.holdRefresh(); await p.refresh();
    positions.set(p.list, 0); p.list.dispatchEvent(new dom.window.Event('scroll')); await flush();
    p.releaseRefresh(); await paint();
    assert.equal(p.olderRequests(), 0, 'layout scroll during refresh cannot queue history');
    p.holdRefresh(); await p.refresh();
    p.scroll(0); await flush();
    assert.equal(p.olderRequests(), 0, 'source mutation waits for refresh');
    p.releaseRefresh(); await paint();
    assert.equal(p.olderRequests(), 1, 'the admitted gesture resumes once refresh settles');
    assert.equal(p.dataRows().length, pageSize * 2);
    assert.equal(p.button(), null);
  } finally { p.releaseRefresh(); p.close(); }
});

test('one admitted older load shows status, survives refresh, and preserves the visible anchor', async () => {
  const events = Array.from({ length: pageSize * 3 }, (_, index) => event(`event-${index + 1}`, index + 1));
  const p = await page('', { channelMessages: pageSize * 3, events });
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const rows = p.dataRows();
    const index = rows.indexOf(this);
    const top = index < 0 ? 0 : index * 100 - p.list.scrollTop;
    return { top, bottom: top + (index < 0 ? viewportHeight : 100), left: 0, right: 100, width: 100, height: 100, x: 0, y: top, toJSON: () => ({}) };
  };
  try {
    const anchor = p.dataRows()[0]!;
    p.holdOlder(); p.scroll(0); await flush();
    assert.ok(p.list.querySelector('.chat-older-loading'), 'status remains visible while the bounded source request waits');
    const reads = p.olderRequests() + p.olderEventRequests();
    p.scroll(0); await p.refresh(); await flush();
    assert.equal(p.olderRequests() + p.olderEventRequests(), reads, 'the loading guard rejects duplicate input and serializes refresh');
    assert.equal(p.dataRows().length, pageSize);
    p.releaseOlder(); await paint();
    assert.equal(p.dataRows().length, pageSize * 2);
    assert.equal(anchor.getBoundingClientRect().top, 0, 'the existing row stays at the same viewport position');
    assert.equal(p.list.querySelector('.chat-older-loading'), null);
    assert.equal(p.button(), null, 'prepended history is not announced as an arrival');
  } finally { p.releaseOlder(); dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect; p.close(); }
});

for (const eventOffset of [-historyLimit * 2, -0.25, 0.25, historyLimit * 2]) {
  test(`mixed boundary ${eventOffset}: refresh and paging preserve the full retained row sequence`, async () => {
    const count = historyLimit + pageSize;
    const events = Array.from({ length: count }, (_, index) => event(`event-${index + 1}`, index + 1 + eventOffset));
    const expected = [
      ...Array.from({ length: count }, (_, index) => ({ key: `message:message-${index + 1}`, time: index + 1 })),
      ...events.map((item) => ({ key: `event:${item.id}`, time: item.createdAt })),
    ].sort((a, b) => a.time - b.time).map((item) => item.key);
    const p = await page('', { channelMessages: count, events });
    const keys = () => p.dataRows().map((row) => row.dataset['messageId'] ? `message:${row.dataset['messageId']}` : `event:${row.dataset['eventId']}`);
    try {
      for (let size = pageSize; size <= historyLimit; size += pageSize) {
        assert.deepEqual(keys(), expected.slice(-size));
        assert.equal(new Set(keys()).size, size);
        await p.refresh(); await paint();
        assert.deepEqual(keys(), expected.slice(-size), 'refresh does not consume or discard buffered history');
        if (size < historyLimit) { p.scroll(0); await paint(); }
      }
      for (let index = 1; index <= pageSize * 2; index++) {
        const item = index % 2 ? event(`fresh-${index}`, count + Math.max(eventOffset, 0) + index) : { ...message(`message-${count + index}`), createdAt: count + Math.max(eventOffset, 0) + index };
        if ('scopeId' in item) await p.addMessage(item); else await p.addEvent(item);
        expected.push('scopeId' in item ? `message:${item.id}` : `event:${item.id}`);
        assert.deepEqual(keys(), expected.slice(-historyLimit), 'refresh evicts only oldest visible rows at the merged cap');
      }
      const reads = p.olderRequests() + p.olderEventRequests();
      p.scroll(0); await paint();
      assert.equal(p.olderRequests() + p.olderEventRequests(), reads, 'retained-history cap stops additional paging');
    } finally { p.close(); }
  });
}

test('refresh soak keeps the mixed conversation window bounded', async () => {
  const events = Array.from({ length: pageSize * 2 }, (_, index) => event(`event-${index + 1}`, index + 1));
  const p = await page('', { channelMessages: pageSize * 2, events });
  try {
    for (let index = 1; index <= pageSize * 2; index++) {
      await p.addEvent(event(`live-${index}`, pageSize * 2 + index));
      assert.equal(p.dataRows().length, pageSize);
      assert.ok(p.dataRows().filter((row) => row.dataset['messageId'] !== undefined).length <= pageSize);
      assert.ok(p.dataRows().filter((row) => row.dataset['eventId'] !== undefined).length <= pageSize);
    }
    assert.equal(p.olderRequests(), 0, 'refreshes alone do not page messages');
    assert.equal(p.olderEventRequests(), 0, 'refreshes alone do not page project events');
  } finally { p.close(); }
});

test('direct timeline paging filters project events by origin scope', async () => {
  const events = [
    ...Array.from({ length: pageSize * 2 }, (_, index) => event(`direct-event-${index + 1}`, index + 1, ['direct'])),
    ...Array.from({ length: pageSize * 3 }, (_, index) => event(`unrelated-event-${index + 1}`, pageSize * 3 + index + 1, ['other-scope'])),
  ];
  const p = await page('', { directMessages: pageSize * 2, events });
  try {
    await p.router.push('/chat/direct?project=project'); await paint();
    const eventIds = () => p.dataRows().flatMap((row) => row.dataset['eventId'] ? [row.dataset['eventId']] : []);
    assert.ok(eventIds().length > 0);
    assert.ok(eventIds().every((id) => id.startsWith('direct-event-')));
    p.scroll(0); await paint();
    p.scroll(0); await paint();
    assert.ok(p.olderEventRequests() > 0, 'older event rows were paged');
    assert.ok(p.eventOriginRequests().every((scopeId) => scopeId === 'direct'), 'older event cursors carry the active direct scope');
    assert.ok(eventIds().every((id) => id.startsWith('direct-event-')), 'unrelated project events stay filtered');
  } finally { p.close(); }
});

test('at bottom, own send, agent reply and run notice keep the latest entry visible', async () => {
  const p = await page();
  try {
    p.scroll(bottom(p.list));
    const input = dom.window.document.querySelector<HTMLInputElement>('.chat-composer input')!;
    input.value = 'send'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await flush();
    dom.window.document.querySelector('.chat-composer')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await paint();
    assert.ok(dom.window.document.querySelector('[data-message-id="message-20"]'), 'send refreshed the real timeline');
    assert.equal(p.list.scrollTop, bottom(p.list), 'own send stays pinned');
    for (const kind of ['human', 'agent', 'notice'] as const) { await p.append(kind); assert.equal(p.list.scrollTop, bottom(p.list), `${kind} stays pinned`); }
  } finally { p.close(); }
});
test('new arrivals preserve history reading position and jump to latest restores following', async () => {
  const p = await page();
  try {
    p.scroll(100); await p.append('agent');
    assert.equal(p.list.scrollTop, 100);
    const button = p.button(); assert.ok(button, 'jump to latest appears for new arrivals');
    assert.match(button.textContent ?? '', /jump to latest/i);
    button.click(); await paint();
    assert.equal(p.list.scrollTop, bottom(p.list)); assert.equal(p.button(), null);
    await p.append('notice'); assert.equal(p.list.scrollTop, bottom(p.list));
  } finally { p.close(); }
});
test('scope switch clears the arrival affordance and resets bottom alignment', async () => {
  const p = await page();
  try {
    p.scroll(100); await p.append('agent');
    await p.router.push('/chat/direct?project=project'); await paint();
    assert.equal(p.list.scrollTop, bottom(p.list)); assert.equal(p.button(), null);
    await p.router.push('/chat/channel?project=project'); await paint();
    assert.equal(p.list.scrollTop, bottom(p.list));
  } finally { p.close(); }
});
test('identical refreshed records and repeated layout deliveries cause no scroll loop', async () => {
  const p = await page();
  try {
    p.scroll(bottom(p.list)); const writes = scrollWrites;
    for (let i = 0; i < 5; i++) {
      await p.refresh(); for (const observer of observers) observer.deliver(); await paint();
    }
    assert.equal(scrollWrites, writes, 'no repeated bottom writes for unchanged content');
    assert.equal(frames.size, 0, 'settlement leaves no frame loop');
    p.scroll(100); const readingWrites = scrollWrites;
    for (let i = 0; i < 3; i++) { await p.refresh(); await paint(); }
    assert.equal(scrollWrites, readingWrites); assert.equal(p.list.scrollTop, 100);
  } finally { p.close(); }
});
test('late image or code sizing keeps bottom alignment but respects reading history', async () => {
  const p = await page();
  try {
    p.scroll(bottom(p.list)); extraHeight = 240;
    for (const observer of observers) observer.deliver(); await paint();
    assert.equal(p.list.scrollTop, bottom(p.list), 'late rendered height remains at bottom');
    p.scroll(100); extraHeight += 200;
    for (const observer of observers) observer.deliver(); await paint();
    assert.equal(p.list.scrollTop, 100);
  } finally { p.close(); }
});
test('older-page prepend is history, not a live arrival; a later append still raises jump to latest', async () => {
  const p = await page('', { channelMessages: pageSize + 5 });
  try {
    // One full newest page plus five historical messages.
    assert.equal(p.list.scrollTop, bottom(p.list), 'entry opens at the bottom');
    p.scroll(0); // reading at the top triggers the older-page fetch
    await flush(); await paint();
    const rows = p.list.querySelectorAll('.chat-msg').length;
    assert.equal(rows, pageSize + 5, 'older page was prepended into the loaded window');
    assert.equal(p.button(), null, 'prepend must not raise jump-to-latest (history is not an arrival)');
    assert.equal(p.list.scrollTop, 0, 'reading position stays where the operator left it');
    await p.append('agent');
    assert.ok(p.button(), 'a live arrival while scrolled up still raises jump-to-latest');
  } finally { p.close(); }
});
test('queued old-scope layout work is invalidated by scope switch and unmount', async () => {
  const p = await page();
  try {
    p.scroll(bottom(p.list));
    const stale = [...observers]; extraHeight = 200;
    for (const observer of stale) observer.deliver();
    await p.router.push('/chat/direct?project=project'); await paint();
    p.scroll(50); const writes = scrollWrites;
    for (const observer of stale) observer.deliver(); await paint();
    assert.equal(p.list.scrollTop, 50); assert.equal(scrollWrites, writes);
    p.scroll(bottom(p.list)); extraHeight += 100;
    for (const observer of observers) observer.deliver();
    assert.equal(frames.size, 1, 'layout work is queued before teardown');
    const teardownWrites = scrollWrites;
    p.close();
    assert.equal(frames.size, 0, 'unmount cancels pending layout work');
    for (const observer of stale) observer.deliver(); await paint();
    assert.equal(scrollWrites, teardownWrites); assert.equal(observers.size, 0); assert.equal(frames.size, 0);
  } finally { p.close(); }
});
test('a targeted historical message keeps the existing deep-link centering behavior', async () => {
  let centered = '';
  dom.window.HTMLElement.prototype.scrollIntoView = function () { centered = this.dataset['messageId'] ?? ''; positions.set(this.closest('.chat-messages-body')!, 100); };
  const p = await page('&message=message-2');
  try { assert.equal(centered, 'message-2'); assert.equal(p.list.scrollTop, 100); }
  finally { p.close(); delete (dom.window.HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView; }
});


test('scope switch does not let an old lost positioning event suppress the first user scroll', async () => {
  dom.window.HTMLElement.prototype.scrollIntoView = function () {
    positions.set(this.closest('.chat-messages-body')!, 0);
  };
  const p = await page('&message=message-' + (pageSize * 3), {
    channelMessages: pageSize * 3, directMessages: pageSize * 3,
  });
  try {
    p.scroll(bottom(p.list)); await paint();
    await p.router.push('/chat/channel?project=project&message=message-' + (pageSize * 3 - 1));
    await p.router.push('/chat/direct?project=project');
    p.scroll(0); await flush();
    assert.equal(p.olderRequests(), 1, 'the first wheel scroll in the new scope pages immediately');
  } finally {
    p.close();
    delete (dom.window.HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
});

test('automatic positioning: a queued user gesture does not turn a script write into paging', async () => {
  const p = await page('', { channelMessages: pageSize * 3, height: pageSize * 100 - 20, automaticEvents: true });
  try {
    p.list.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -100 }));
    extraHeight = 10;
    for (const observer of observers) observer.deliver(); await paint();
    assert.equal(p.olderRequests(), 0, 'programmatic write wins over pending input');
    p.scroll(0); await paint();
    assert.equal(p.olderRequests(), 1, 'the next real user gesture is admitted immediately');
  } finally { p.close(); }
});
test('automatic positioning: a lost event expires without suppressing a later user scroll at the same position', async () => {
  const p = await page('', { channelMessages: pageSize * 3, height: pageSize * 100 - 20 });
  try {
    // Initial write has no delivered event in this mode. Let its defensive
    // frame expiry run before a user gesture at the identical near-top offset.
    await paint();
    p.scroll(20); await paint();
    assert.equal(p.olderRequests(), 1);
  } finally { p.close(); }
});

// Recreate the diagnosed automatic-positioning matrix with native-like delivery.
for (const gap of [-20, 0, 20, 40, 150, 800]) {
  test(`automatic positioning: bottom gap ${gap} never pages without user input`, async () => {
    const p = await page('', { channelMessages: pageSize * 3, events: Array.from({ length: pageSize * 3 }, (_, i) => event(`event-${i + 1}`, i + 1)), height: pageSize * 100 - gap, automaticEvents: true });
    try {
      for (let cycle = 0; cycle < 10; cycle++) {
        extraHeight = cycle % 2 ? 27 : 0; // loading-row-sized growth and removal
        for (const observer of observers) observer.deliver();
        dom.window.dispatchEvent(new dom.window.Event('resize'));
        await p.refresh(); await paint();
      }
      assert.equal(p.olderRequests(), 0, 'zero input must issue zero older message reads');
      assert.equal(p.olderEventRequests(), 0, 'zero input must issue zero older event reads');
      assert.equal(p.list.querySelectorAll('.chat-msg').length, pageSize);
    } finally { p.close(); }
  });
}
for (const targetTop of [30, 150]) {
  test(`automatic positioning: deep-link at ${targetTop}px and scope switches never page`, async () => {
    dom.window.HTMLElement.prototype.scrollIntoView = function () {
      this.closest('.chat-messages-body')!.scrollTop = targetTop;
    };
    const p = await page('&message=message-' + (pageSize * 3), { channelMessages: pageSize * 3, automaticEvents: true });
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        await p.refresh(); await paint();
        await p.router.push('/chat/direct?project=project&message=message-' + (pageSize * 3)); await paint();
        await p.router.push('/chat/channel?project=project&message=message-' + (pageSize * 3)); await paint();
      }
      assert.equal(p.olderRequests(), 0);
      assert.equal(p.olderEventRequests(), 0);
      assert.equal(p.list.querySelectorAll('.chat-msg').length, pageSize);
    } finally { p.close(); delete (dom.window.HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView; }
  });
}
test('automatic positioning: unchanged bottom writes do not swallow the next user scroll', async () => {
  const p = await page('', { channelMessages: pageSize * 2 + 5, automaticEvents: true });
  try {
    for (const observer of observers) observer.deliver(); await paint();
    p.scroll(0); await paint();
    assert.equal(p.olderRequests(), 1);
    assert.equal(p.list.querySelectorAll('.chat-msg').length, pageSize * 2);
    p.scroll(0); await paint();
    assert.equal(p.list.querySelectorAll('.chat-msg').length, pageSize * 2 + 5);
    p.scroll(0); await paint();
    assert.equal(p.olderRequests(), 2, 'conversation start stops paging');
  } finally { p.close(); }
});
