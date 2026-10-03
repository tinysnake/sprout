import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { MessageView, ProjectEventView } from '../../../../../src/web/views.ts';
import type { ChatService } from '../types.ts';
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
  window: dom.window, document: dom.window.document, history: dom.window.history, location: dom.window.location,
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
async function page(query = '') {
  frames.clear(); extraHeight = 0; scrollWrites = 0;
  dom.window.document.body.innerHTML = '<div id="app"></div>';
  const scopes: ConversationScopeView[] = [
    { id: 'channel', projectId: 'project', kind: 'project', createdAt: 1, updatedAt: 1 },
    { id: 'direct', projectId: 'project', kind: 'direct', participants: ['operator', 'agent'], createdAt: 1, updatedAt: 1 },
  ];
  let messages = Array.from({ length: 8 }, (_, i) => message(`message-${i + 1}`));
  messages.push(...Array.from({ length: 5 }, (_, i) => message(`direct-${i + 1}`, 'direct')));
  let events: ProjectEventView[] = [];
  const state = () => ({ status: 'online' as const, connection: 'online' as const, loading: false });
  const service = {
    state, subscribeState: () => () => {},
    listScopes: async () => scopes.map((scope) => ({ ...scope })),
    listMessages: async (id?: string) => messages.filter((item) => item.scopeId === id).map((item) => ({ ...item })),
    listProjectEvents: async () => events.map((item) => ({ ...item })),
    listRoutingBatches: async () => ({ batches: [], windows: [] }),
    listActiveRuns: async () => [],
    inspectScope: async (id: string) => ({ scope: scopes.find((scope) => scope.id === id)!, state: { scopeId: id, writable: true }, context: { scopeId: id, projectId: 'project', kind: 'project', project: { contentVersion: 1, goal: '', rules: [] } } }),
    subscribeRunStatuses: () => () => {},
    postMessage: async (input: { scopeId: string; body: string }) => {
      const sent = message('message-20', input.scopeId, 'human'); messages.push(sent);
      return { message: sent, admittedRunIds: [] };
    },
  } satisfies Partial<ChatService>;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ name: 'project-chat-scope', path: '/chat/:scopeId', component: ChatView }] });
  await router.push(`/chat/channel?project=project${query}`); await router.isReady();
  const app = createApp(ChatView);
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
