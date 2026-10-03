import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { journeyWire } from './production-journey-wire.ts';

// Exercise local midnight and the 23-hour DST day, independently of the host timezone.
process.env['TZ'] = 'America/New_York';
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://sprout-test.invalid/app/project/chat/channel-a?project=project-a',
  pretendToBeVisual: true,
});
(dom.window as unknown as Record<string, unknown>)['__SPROUT_TEST_MANUAL_MOUNT__'] = true;
const replacements: Record<string, unknown> = {
  window: dom.window, document: dom.window.document,
  location: dom.window.location, history: dom.window.history,
  localStorage: dom.window.localStorage, navigator: dom.window.navigator,
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 10),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
};
for (const key of ['HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'SVGElement', 'Element', 'Document', 'DocumentFragment', 'Node',
  'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'CustomEvent', 'MutationObserver', 'NodeFilter']) {
  replacements[key] = (dom.window as unknown as Record<string, unknown>)[key];
}
for (const [key, value] of Object.entries(replacements)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createServer } = await import('vite');
const { default: vue } = await import('@vitejs/plugin-vue');
const vite = await createServer({
  root: new URL('../..', import.meta.url).pathname,
  appType: 'custom', logLevel: 'error',
  plugins: [
    { name: 'force-client-vue', enforce: 'pre', transform(_code, _id, options) { if (options) options.ssr = false; } },
    vue(),
  ],
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true },
});
after(async () => { await vite.close(); dom.window.close(); });
const { createSproutApp, createProductionAppOptions } = await vite.ssrLoadModule('/src/app/main.ts') as typeof import('./main.ts');
const { createBrowserTransport } = await vite.ssrLoadModule('/src/transport/browser-transport.ts') as typeof import('../transport/browser-transport.ts');
const doc = dom.window.document;
const at = (year: number, month: number, day: number, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime();
const now = at(2026, 3, 9, 0, 1);
const message = (id: string, createdAt: number) => ({
  id, createdAt, scopeId: 'channel-a', projectId: 'project-a',
  authorId: 'operator', authorKind: 'human', body: id,
});
async function waitFor(probe: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(probe(), label);
}
function labels() {
  return [...doc.querySelectorAll('.chat-date-separator')].map(row => row.textContent?.trim());
}
function assertBefore(id: string, label: string) {
  const row = doc.querySelector(`[data-message-id="${id}"]`);
  assert.ok(row, `message ${id} is rendered`);
  assert.ok(row.previousElementSibling?.classList.contains('chat-date-separator'), `date row immediately precedes ${id}`);
  assert.equal(row.previousElementSibling.textContent?.trim(), label);
}
async function harness(initial: ReturnType<typeof message>[], includeEvents = false) {
  dom.window.history.replaceState(null, '', '/app/project/chat/channel-a?project=project-a');
  doc.body.innerHTML = '<div id="app"></div>';
  const wire = journeyWire();
  wire.messages.splice(0, wire.messages.length, ...initial);
  const transport = createBrowserTransport({
    fetch: async (input, init) => {
      if (!includeEvents && String(input).includes('/events')) return Response.json({ events: [] });
      return wire.respond(String(input), init);
    },
    eventSource: () => {
      const source: import('../transport/browser-transport.ts').BrowserEventSource = {
        onopen: null, onmessage: null, onerror: null, addEventListener() {}, close() {},
      };
      queueMicrotask(() => source.onopen?.(new Event('open')));
      return source;
    },
  });
  const mounted = createSproutApp({ ...createProductionAppOptions(transport), routerBase: '/app/' });
  await mounted.router.isReady();
  mounted.app.mount(doc.getElementById('app')!);
  await waitFor(() => !!doc.querySelector('.chat-messages-body') && !doc.querySelector('.chat-detail-loading')
    && doc.querySelector('.chat-messages-body')?.getAttribute('aria-busy') === 'false', 'Chat loaded');
  return {
    wire,
    async refresh(expectedIds: string[]) {
      doc.dispatchEvent(new dom.window.Event('visibilitychange'));
      await waitFor(() => expectedIds.every(id => doc.querySelector(`[data-message-id="${id}"]`)), 'refreshed messages rendered');
    },
    close() { mounted.app.unmount(); mounted.router.options.history.destroy(); },
  };
}

test('same-day messages have a first-day label and no separator between them; empty Chat has none', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const page = await harness([]);
  try {
    assert.deepEqual(labels(), []);
    page.wire.messages.push(message('first', at(2026, 3, 9)), message('second', at(2026, 3, 9, 0, 1)));
    await page.refresh(['first', 'second']);
    assert.deepEqual(labels(), ['Today']);
    assertBefore('first', 'Today');
    assert.equal(doc.querySelector('[data-message-id="second"]')?.previousElementSibling?.getAttribute('data-message-id'), 'first');
  } finally { page.close(); }
});

test('cross-day labels use local Today, Yesterday across DST, and an absolute older date with year', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const older = at(2025, 12, 31, 23, 59);
  const page = await harness([
    message('older', older), message('yesterday-start', at(2026, 3, 8)),
    message('yesterday-end', at(2026, 3, 8, 23, 59)), message('today', at(2026, 3, 9)),
  ]);
  try {
    const absolute = new Date(older).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    assert.deepEqual(labels(), [absolute, 'Yesterday', 'Today']);
    assertBefore('older', absolute);
    assertBefore('yesterday-start', 'Yesterday');
    assertBefore('today', 'Today');
  } finally { page.close(); }
});

test('prepending an older chunk that splits a day moves its separator to the first message without duplication', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const page = await harness([message('newer-chunk', at(2026, 3, 9, 0, 1))]);
  try {
    assert.deepEqual(labels(), ['Today']);
    page.wire.messages.unshift(message('older-chunk', at(2026, 3, 9)));
    await page.refresh(['older-chunk', 'newer-chunk']);
    assert.deepEqual(labels(), ['Today']);
    assertBefore('older-chunk', 'Today');
    assert.equal(doc.querySelector('[data-message-id="newer-chunk"]')?.previousElementSibling?.getAttribute('data-message-id'), 'older-chunk');
  } finally { page.close(); }
});

test('a live append crossing local midnight adds a date row and updates the previous day label', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: at(2026, 3, 8, 23, 59) });
  const page = await harness([message('before-midnight', at(2026, 3, 8, 23, 59))]);
  try {
    assert.deepEqual(labels(), ['Today']);
    t.mock.timers.tick(120_000);
    page.wire.messages.push(message('after-midnight', at(2026, 3, 9, 0, 1)));
    await page.refresh(['before-midnight', 'after-midnight']);
    assert.deepEqual(labels(), ['Yesterday', 'Today']);
    assertBefore('after-midnight', 'Today');
  } finally { page.close(); }
});

test('interleaved Project events do not replace message adjacency or create extra day separators', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const page = await harness([
    message('yesterday', at(2026, 3, 8, 23, 59)), message('today', now + 10),
  ], true);
  try {
    assert.ok(doc.querySelector('[data-event-id="event-chat-a"]'));
    assert.deepEqual(labels(), ['Yesterday', 'Today']);
    assertBefore('today', 'Today');
  } finally { page.close(); }
});
