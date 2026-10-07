import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

// Initialize JSDOM and globals before importing Vue or Vite modules.
const initialHtml = await readFile(new URL('../../../app/index.html', import.meta.url), 'utf8');
const initialDom = new JSDOM(initialHtml, {
  url: 'http://sprout-operator.test/app/manage/environments',
  pretendToBeVisual: true,
});

const replacements: Record<string, unknown> = {
  window: initialDom.window,
  document: initialDom.window.document,
  HTMLElement: initialDom.window.HTMLElement,
  HTMLButtonElement: initialDom.window.HTMLButtonElement,
  HTMLFormElement: initialDom.window.HTMLFormElement,
  HTMLInputElement: initialDom.window.HTMLInputElement,
  HTMLSelectElement: initialDom.window.HTMLSelectElement,
  HTMLTextAreaElement: initialDom.window.HTMLTextAreaElement,
  SVGElement: initialDom.window.SVGElement,
  Element: initialDom.window.Element,
  Document: initialDom.window.Document,
  DocumentFragment: initialDom.window.DocumentFragment,
  location: initialDom.window.location,
  history: initialDom.window.history,
  localStorage: initialDom.window.localStorage,
  navigator: initialDom.window.navigator,
  getComputedStyle: initialDom.window.getComputedStyle,
  Node: initialDom.window.Node,
  Event: initialDom.window.Event,
  MouseEvent: initialDom.window.MouseEvent,
  KeyboardEvent: initialDom.window.KeyboardEvent,
  PointerEvent: initialDom.window.PointerEvent,
  FocusEvent: initialDom.window.FocusEvent,
  CustomEvent: initialDom.window.CustomEvent,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 10),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  MutationObserver: initialDom.window.MutationObserver,
  NodeFilter: initialDom.window.NodeFilter,
};
for (const [key, value] of Object.entries(replacements)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { createServer } = await import('vite');
const { default: vue } = await import('@vitejs/plugin-vue');

/**
 * #172: the post-approval model-authorization UI action.
 *
 * The Environments page must offer the Human a fix for an Agent that gained a
 * work model after approval, instead of a bare red card with no path. This
 * mounts the Environment detail, pre-checks the models already authorized, and
 * proves the action emits the full current selection keyed by engine.
 */
test('EnvironmentDetail: records the Human model-authorization selection in place', async () => {
  const vite = await createServer({
    root: new URL('../../..', import.meta.url).pathname,
    appType: 'custom',
    logLevel: 'error',
    plugins: [
      {
        name: 'force-client-vue',
        enforce: 'pre',
        transform(_code, _id, opt) {
          if (opt) opt.ssr = false;
        },
      },
      vue(),
    ],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const { createApp, h } = await import('vue');
    const { createMemoryHistory, createRouter } = await import('vue-router');
    const detail = (await vite.ssrLoadModule(
      '/src/modules/environments/components/EnvironmentDetail.vue',
    )) as { default: unknown };
    const fixtures = (await vite.ssrLoadModule(
      '/src/modules/environments/adapters/fixture-adapter.ts',
    )) as { FixtureEnvironmentService: new () => { listEnvironments(): Promise<any[]> } };
    const env = (await new fixtures.FixtureEnvironmentService().listEnvironments()).find(
      (candidate: any) => candidate.id === 'env-ready',
    );
    assert.ok(env, 'the approved fixture environment exists');
    env.targetModelsByEngine = { codex: ['target-model', 'late-model'] };
    env.engineDetails.codex.modelAuthorizations = [
      { engine: 'codex', model: 'target-model', source: 'human-approval', authorizedAt: 1 },
    ];

    let captured: unknown;
    const container = initialDom.window.document.createElement('div');
    initialDom.window.document.body.appendChild(container);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/project/tasks/:taskId', name: 'project-task-detail', component: { render: () => null } }],
    });
    const app = createApp({
      setup: () => () => h(detail.default as any, {
        env,
        onAuthorizeModels: (payload: unknown) => { captured = payload; },
      }),
    });
    app.use(router);
    app.mount(container);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const doc = initialDom.window.document;

    const panel = doc.querySelector('.model-authorization-panel');
    assert.ok(panel, 'the approved Environment offers a model-authorization panel');

    // The already-authorized model starts checked; the post-approval model does not.
    const late = doc.getElementById('env-auth-codex-late-model');
    assert.ok(late, 'the configured target model is offered');
    const existing = doc.getElementById('env-auth-codex-target-model') as HTMLInputElement;
    assert.ok(existing, 'the existing grant is displayed');
    assert.equal(existing.disabled, true, 'an existing grant cannot be unchecked in an add-only panel');
    assert.match(panel.textContent ?? '', /existing grants cannot be removed here/);
    existing.click();
    assert.equal(existing.getAttribute('aria-checked'), 'true', 'attempting to deselect a grant does not present a false revocation');
    (late as unknown as { click(): void }).click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const button = doc.querySelector('.authorize-models-btn') as unknown as { click(): void } | null;
    assert.ok(button, 'the record action is rendered');
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(captured, {
      id: 'env-ready',
      modelAuthorizations: { codex: ['target-model', 'late-model'] },
    });
  } finally {
    await vite.close();
  }
});
