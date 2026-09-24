/**
 * Shell composition: the page frame on phone and desktop, connection state
 * including loading/offline/reconnecting, the single live announcement region,
 * and the shared primitives' accessible behaviour.
 *
 * Each test gets a fresh document, so a navigation or overlay in one test cannot
 * leak into the next.
 */
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

import { test } from 'node:test';

import { JSDOM } from 'jsdom';

import type { ViteDevServer } from 'vite';


const repoRoot = process.cwd();

const html = await readFile(`${repoRoot}/web/app/index.html`, 'utf8');


const GLOBALS = [
  'HTMLElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'HTMLAnchorElement', 'SVGElement', 'Element', 'Document', 'DocumentFragment',
  'location', 'history', 'localStorage', 'navigator', 'getComputedStyle', 'Node', 'NodeFilter',
  'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'TouchEvent', 'CustomEvent',
] as const;


interface Connection {
  status: string;
  connection: string;
  loading: boolean;
}


interface Harness {
  dom: JSDOM;
  doc: Document;
  vite: ViteDevServer;
  mountInto: (app: { mount: (el: Element) => unknown }) => void;
  cleanup: () => Promise<void>;
}


async function setupHarness(): Promise<Harness> {
  const dom = new JSDOM(html, { url: 'http://sprout-operator.test/app/feed', pretendToBeVisual: true });
  (dom.window as unknown as Record<string, unknown>)['__SPROUT_TEST_MANUAL_MOUNT__'] = true;

  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 10),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  };
  for (const key of GLOBALS) values[key] = (dom.window as unknown as Record<string, unknown>)[key];

  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const [{ createServer }, { default: vuePlugin }] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-vue'),
  ]);
  const vite = await createServer({
    root: `${repoRoot}/web`,
    appType: 'custom',
    logLevel: 'error',
    plugins: [
      { name: 'force-client-vue', enforce: 'pre', transform(_code, _id, opt) { if (opt) opt.ssr = false; } },
      vuePlugin(),
    ],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
  });

  const root = dom.window.document.getElementById('app');
  assert.ok(root, 'the app mounts into #app');

  return {
    dom,
    doc: dom.window.document,
    vite,
    mountInto: (app) => app.mount(root),
    cleanup: async () => {
      await vite.close();
      for (const [key, original] of originals) {
        if (original === undefined) Reflect.deleteProperty(globalThis, key);
        else Object.defineProperty(globalThis, key, original);
      }
      dom.window.close();
    },
  };
}


const settle = (ms = 110) => new Promise((resolve) => setTimeout(resolve, ms));


/** Vite's module namespace object needs unwrapping before Vue can render it. */
function componentOf(module: unknown): unknown {
  return (module as { default: unknown }).default;
}


test('the tab strip provides real tab semantics with roving focus and arrow-key movement', async () => {
  const { vite, dom, cleanup } = await setupHarness();
  try {
    const { createApp, h, ref } = await import('vue');
    const TabStrip = componentOf(await vite.ssrLoadModule('/src/primitives/TabStrip.vue'));

    const host = document.createElement('div');
    document.body.append(host);

    const app = createApp({
      setup() {
        const value = ref('overview');
        return () =>
          h(TabStrip as never, {
            items: [
              { key: 'overview', label: 'Overview', icon: 'overview' },
              { key: 'tasks', label: 'Tasks', icon: 'tasks' },
              { key: 'chat', label: 'Chat', icon: 'chat' },
            ],
            modelValue: value.value,
            label: 'Project views',
            'onUpdate:modelValue': (next: string) => { value.value = next; },
          });
      },
    });
    app.mount(host);
    await settle(60);

    const list = host.querySelector('[role="tablist"]');
    assert.ok(list, 'the strip is a tab list');
    assert.equal(list.getAttribute('aria-label'), 'Project views');

    const tabs = [...host.querySelectorAll('[role="tab"]')];
    assert.equal(tabs.length, 3);
    assert.equal(tabs[0]?.getAttribute('aria-selected'), 'true', 'the active tab is marked selected');
    assert.equal(tabs[1]?.getAttribute('aria-selected'), 'false');

    // Roving focus: only the active tab is in the tab sequence.
    assert.equal(tabs[0]?.getAttribute('tabindex'), '0', 'the active tab is tabbable');
    assert.deepEqual(tabs.slice(1).map((tab) => tab.getAttribute('tabindex')), ['-1', '-1'], 'inactive tabs are not in the tab sequence');

    // A pointer activation changes the selected tab.
    (tabs[2] as HTMLElement).click();
    await settle(60);
    const afterClick = [...host.querySelectorAll('[role="tab"]')];
    assert.equal(afterClick[2]?.getAttribute('aria-selected'), 'true', 'activating a tab selects it');
    assert.equal(afterClick[0]?.getAttribute('aria-selected'), 'false');

    // Arrow keys move focus between tabs.
    (afterClick[2] as HTMLElement).focus();
    afterClick[2]?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    await settle(60);
    assert.equal(document.activeElement, afterClick[1], 'ArrowLeft moves focus to the previous tab');

    app.unmount();
  } finally {
    await cleanup();
  }
});
