/**
 * Shared JSDOM + Vite stage for the app's DOM test files.
 *
 * Vue captures `document` while its modules evaluate, so swapping globals
 * between tests while reusing loaded modules is not a safe isolation
 * strategy. Every DOM test file therefore installs one fixed set of browser
 * globals and one Vite dev server for the whole file; per-test isolation
 * comes from giving each case a fresh application (app, Pinia, router,
 * services) on an emptied mount point, not from rebuilding this stage.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import type { ViteDevServer } from 'vite';

const GLOBALS = [
  'HTMLElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'SVGElement', 'Element', 'Document', 'DocumentFragment', 'location',
  'history', 'localStorage', 'navigator', 'getComputedStyle', 'Node', 'NodeFilter', 'Event',
  'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'TouchEvent', 'CustomEvent',
] as const;

export type DomStage = {
  dom: JSDOM;
  doc: Document;
  mount: HTMLElement;
  vite: ViteDevServer;
};

export async function createSharedDomStage(url: string): Promise<DomStage> {
  const html = await readFile(`${process.cwd()}/web/app/index.html`, 'utf8');
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  (dom.window as unknown as Record<string, unknown>)['__SPROUT_TEST_MANUAL_MOUNT__'] = true;

  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 10),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  };
  for (const key of GLOBALS) values[key] = (dom.window as unknown as Record<string, unknown>)[key];
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  // The plugin must compile templates for the browser (not SSR), so the import
  // happens after the browser globals exist.
  const [{ createServer }, { default: vuePlugin }] = await Promise.all([import('vite'), import('@vitejs/plugin-vue')]);
  const vite = await createServer({
    root: `${process.cwd()}/web`,
    appType: 'custom',
    logLevel: 'error',
    plugins: [
      { name: 'force-client-vue', enforce: 'pre', transform(_code, _id, options) { if (options) options.ssr = false; } },
      vuePlugin(),
    ],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
  });

  const mount = dom.window.document.querySelector('#app');
  assert.ok(mount);
  return { dom, doc: dom.window.document, mount: mount as unknown as HTMLElement, vite };
}

/**
 * Vue marks a mounted app on its container and guards its own unmount; tests
 * also unmount directly. Never let a second unmount or a stale reference fail
 * an unrelated case — accepts either an app object or the mount element a
 * leftover app was mounted on.
 */
export function unmountQuietly(target: { unmount(): void } | HTMLElement | undefined): void {
  if (target === undefined) return;
  const app = 'unmount' in target
    ? target
    : (target as HTMLElement & { __vue_app__?: { unmount(): void } }).__vue_app__;
  try { app?.unmount(); } catch { /* already unmounted */ }
}

/** File-scoped teardown for the shared stage; registered by each test file. */
export async function closeDomStage(stage: Pick<DomStage, 'vite' | 'dom'> | undefined): Promise<void> {
  if (stage === undefined) return;
  await stage.vite.close();
  stage.dom.window.close();
}
