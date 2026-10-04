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
const positions = new WeakMap<Element, number>();
let scrollWrites = 0;
Object.defineProperties(dom.window.HTMLElement.prototype, {
  clientHeight: { configurable: true, get() { return this.classList.contains('chat-messages-body') ? 200 : 0; } },
  scrollHeight: { configurable: true, get() { return this.classList.contains('chat-messages-body') ? this.querySelectorAll('.chat-msg').length * 100 + extraHeight : 0; } },
  scrollTop: {
    configurable: true,
    get() { return positions.get(this) ?? 0; },
    set(value: number) { scrollWrites++; positions.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
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
async function page(query = '', options: { channelMessages?: number; shell?: boolean } = {}) {
  frames.clear(); extraHeight = 0; scrollWrites = 0;
  dom.window.document.body.innerHTML = '<div id="app"></div>';
  const scopes: ConversationScopeView[] = [
    { id: 'channel', projectId: 'project', kind: 'project', createdAt: 1, updatedAt: 1 },
    { id: 'direct', projectId: 'project', kind: 'direct', participants: ['operator', 'agent'], createdAt: 1, updatedAt: 1 },
  ];
  let messages = Array.from({ length: options.channelMessages ?? 8 }, (_, i) => message(`message-${i + 1}`));
  messages.push(...Array.from({ length: 5 }, (_, i) => message(`direct-${i + 1}`, 'direct')));
  let events: ProjectEventView[] = [];
  let activeRuns: readonly ActiveChatRun[] = [];
  let runStatusListener: Parameters<ChatService['subscribeRunStatuses']>[0] | undefined;
  const state = () => ({ status: 'online' as const, connection: 'online' as const, loading: false });
  const service = {
    state, subscribeState: () => () => {},
    listScopes: async () => scopes.map((scope) => ({ ...scope })),
    listMessages: async (id?: string, options?: { limit?: number; before?: string }) => {
      const rows = messages.filter((item) => item.scopeId === id)
        .sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      if (options?.before !== undefined) {
        const index = rows.findIndex((item) => item.id === options.before);
        const older = index < 0 ? [] : rows.slice(0, index);
        return (options.limit !== undefined ? older.slice(-options.limit) : older).map((item) => ({ ...item }));
      }
      return (options?.limit !== undefined ? rows.slice(-options.limit) : rows).map((item) => ({ ...item }));
    },
    listProjectEvents: async () => events.map((item) => ({ ...item })),
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
    async setRunStatus(status: 'queued' | 'running' | 'completed') {
      activeRuns = status === 'completed' ? [] : [{ id: 'chat-run', agentId: 'agent', status }];
      runStatusListener?.({ id: 'chat-run', status });
      await flush();
    },
    button: () => dom.window.document.querySelector<HTMLButtonElement>('.chat-jump-latest'),
    scroll(top: number) { list.scrollTop = top; list.dispatchEvent(new dom.window.Event('scroll')); },
    async refresh() { dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); await flush(); },
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

test('composer shows truthful run motion and removes it on settlement without duplicate live announcements', async () => {
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
      for (const className of ['h-2', 'w-2', 'rounded-full', 'bg-[var(--accent-primary)]', 'animate-pulse', 'motion-reduce:animate-none']) {
        assert.ok(dot.classList.contains(className), `indicator includes ${className}`);
      }
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
  } finally { p.close(); }
});

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

test('opening a conversation aligns its rendered history to the bottom', async () => {
  const p = await page();
  try { assert.equal(p.list.scrollTop, bottom(p.list)); assert.equal(p.button(), null); }
  finally { p.close(); }
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
  const p = await page('', { channelMessages: 55 });
  try {
    // 55 messages; the newest window loads 50 so hasOlder is true and entry lands at bottom.
    assert.equal(p.list.scrollTop, bottom(p.list), 'entry opens at the bottom');
    p.scroll(0); // reading at the top triggers the older-page fetch
    await flush(); await paint();
    const rows = p.list.querySelectorAll('.chat-msg').length;
    assert.equal(rows, 55, 'older page was prepended into the loaded window');
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
