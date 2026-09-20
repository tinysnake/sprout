/**
 * Route hierarchy: URL addressability, deep links, browser history, and the
 * guarantee that no destination the operator can reach renders non-product
 * content or a prototype-only control.
 *
 * The router is exercised through its real configuration and a real
 * `createWebHistory` instance, so these assertions cover the shipped route table
 * rather than a copy of it. Each test gets a fresh document and history, so one
 * test's navigation cannot leak into the next.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer, type ViteDevServer } from 'vite';

const repoRoot = process.cwd();
const html = await readFile(`${repoRoot}/web/app/index.html`, 'utf8');

const GLOBALS = [
  'HTMLElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'SVGElement', 'Element', 'Document', 'DocumentFragment', 'location',
  'history', 'localStorage', 'navigator', 'getComputedStyle', 'Node', 'NodeFilter', 'Event',
  'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'TouchEvent', 'CustomEvent',
] as const;

interface Harness {
  dom: JSDOM;
  doc: Document;
  mount: HTMLElement;
  vite: ViteDevServer;
  cleanup: () => Promise<void>;
}

async function setupHarness(url = 'http://sprout-operator.test/app/feed'): Promise<Harness> {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
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

  // Vue's runtime-dom reads `document` at module evaluation, and the plugin must
  // compile templates for the browser (not SSR), so both imports happen here.
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

  return {
    dom,
    doc: dom.window.document,
    mount: dom.window.document.getElementById('app') as unknown as HTMLElement,
    vite,
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

const settle = (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The route suite injects the deterministic fixture authority explicitly.
 * Production never defaults to it: an omitted adapter renders an unavailable
 * state rather than fixture facts.
 */
async function deterministicAppOptions(vite: ViteDevServer) {
  const module = (await vite.ssrLoadModule(
    '/src/modules/environments/adapters/fixture-adapter.ts'
  )) as typeof import('../modules/environments/adapters/fixture-adapter.ts');
  return { routerBase: '/app/', environmentService: new module.FixtureEnvironmentService() };
}

/** Routes the operator can actually reach, with the content each must compose. */
const REACHABLE_ROUTES: readonly { path: string; destination: string; tab?: string; expect: RegExp }[] = [
  { path: '/feed', destination: 'feed', expect: /Operations Feed & Human Attention/ },
  { path: '/project/overview', destination: 'project', tab: 'overview', expect: /Project Collaboration Agreement/ },
  { path: '/project/tasks', destination: 'project', tab: 'tasks', expect: /Project Tasks & Operating Loop/ },
  { path: '/project/tasks/101', destination: 'project', tab: 'tasks', expect: /Task Operating Stage & Specification/ },
  { path: '/project/chat', destination: 'project', tab: 'chat', expect: /Conversations & Groups/ },
  { path: '/project/chat/wg-frontend', destination: 'project', tab: 'chat', expect: /wg-frontend/ },
  { path: '/manage/environments', destination: 'manage', tab: 'environments', expect: /Environments & Host Infrastructure/ },
  { path: '/manage/environments/env-ready', destination: 'manage', tab: 'environments', expect: /6 Independent Health Dimensions/ },
  { path: '/manage/agents', destination: 'manage', tab: 'agents', expect: /Agents & Worker Personas/ },
  { path: '/manage/usage', destination: 'manage', tab: 'usage', expect: /Usage & Cost Telemetry/ },
  { path: '/manage/settings', destination: 'manage', tab: 'settings', expect: /General & Operator Settings/ },
];

test('every reachable route is URL-addressable and resolves to its destination and tab', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    app.mount(mount);

    for (const route of REACHABLE_ROUTES) {
      // Address the route the way an operator does: by URL, not by a route name.
      await router.push(route.path);
      await router.isReady();
      await settle(80);

      assert.equal(router.currentRoute.value.path, route.path, `${route.path} is preserved as the current URL`);
      assert.equal(router.currentRoute.value.meta['destination'], route.destination, `${route.path} reports its destination`);
      if (route.tab) {
        assert.equal(router.currentRoute.value.meta['tab'], route.tab, `${route.path} reports its tab`);
      }
      assert.match(doc.body.textContent ?? '', route.expect, `${route.path} renders its own content`);
    }

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('a pasted deep link renders the same record a click would, without navigator history', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    // A cold start at a detail URL: no prior navigation, so this is exactly a
    // pasted link or a page refresh.
    await router.push('/manage/environments/env-recovery');
    await router.isReady();
    app.mount(mount);
    await settle(120);

    assert.equal(router.currentRoute.value.params['id'], 'env-recovery', 'the deep link restores the record identity');
    assert.match(doc.body.textContent ?? '', /Lease Recovery Required/, 'the deep link restores the record detail');
    const selected = doc.querySelector('button[data-env="env-recovery"]');
    assert.ok(selected, 'the deep-linked record is present in the list');
    assert.equal(selected.getAttribute('aria-current'), 'page', 'the deep-linked record is marked current');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('browser history moves between nested records and restores each context', async () => {
  const { vite, dom, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    app.mount(mount);

    await router.push('/feed');
    await router.push('/project/tasks');
    await settle(80);
    await router.push('/project/tasks/104');
    await settle(80);
    assert.match(doc.body.textContent ?? '', /#104/, 'the second record is open');
    assert.match(doc.body.textContent ?? '', /Distributed Agent Orchestration/, 'the second record content is shown');

    dom.window.history.back();
    await settle(160);
    assert.equal(router.currentRoute.value.path, '/project/tasks', 'Back returns to the Tasks list');
    assert.match(doc.body.textContent ?? '', /Project Tasks & Operating Loop/, 'the list content is restored');

    dom.window.history.forward();
    await settle(160);
    assert.equal(router.currentRoute.value.path, '/project/tasks/104', 'Forward returns to the record');
    assert.match(doc.body.textContent ?? '', /Distributed Agent Orchestration/, 'the record content is restored');

    dom.window.history.back();
    await settle(160);
    dom.window.history.back();
    await settle(160);
    assert.equal(router.currentRoute.value.path, '/feed', 'Back reaches the Feed landing surface');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('the return context restores the Feed with the filters the operator had set', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    app.mount(mount);

    // Narrow the Feed, then deep-link out of it.
    await router.push('/feed?scope=infra&urgency=attention&activity=envs');
    await router.isReady();
    await settle(80);

    const attentionCard = doc.querySelector('.feed-attention-card') as HTMLButtonElement;
    assert.ok(attentionCard, 'an attention card is available in the narrowed Feed');
    attentionCard.click();
    await settle(120);

    assert.notEqual(router.currentRoute.value.path, '/feed', 'the card left the Feed for an authoritative surface');
    const banner = doc.querySelector('.return-context-banner');
    assert.ok(banner, 'a return control is offered');
    assert.match(banner.textContent ?? '', /Back to Feed/);

    (doc.querySelector('#btn-pop-return') as HTMLButtonElement).click();
    await settle(120);

    assert.equal(router.currentRoute.value.path, '/feed', 'the return control restores the Feed');
    assert.deepEqual(
      router.currentRoute.value.query,
      { scope: 'infra', urgency: 'attention', activity: 'envs' },
      'the Feed filters the operator had set are restored, not reset'
    );

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('a destination URL that is reached directly keeps its destination current in both navigations', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/manage/usage');
    await router.isReady();
    app.mount(mount);
    await settle(110);

    const sidebarCurrent = doc.querySelector('.desktop-sidebar [aria-current="page"]');
    assert.ok(sidebarCurrent, 'the sidebar marks a current entry');
    assert.equal(sidebarCurrent.getAttribute('data-nav'), 'usage');

    const phoneCurrent = doc.querySelector('.mobile-bottom-nav [aria-current="page"]');
    assert.ok(phoneCurrent, 'the phone navigation marks a current entry');
    assert.equal(phoneCurrent.getAttribute('data-nav'), 'usage');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('the phone bottom navigation shows the nested entries of the active destination only', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    app.mount(mount);

    const navKeys = () => [...doc.querySelectorAll('.mobile-bottom-nav [data-nav]')].map((el) => el.getAttribute('data-nav'));

    await router.push('/feed');
    await settle(90);
    assert.deepEqual(navKeys(), ['feed', 'project', 'manage'], 'the Feed root shows the three destinations');

    await router.push('/project/tasks');
    await settle(90);
    assert.deepEqual(navKeys(), ['overview', 'tasks', 'chat'], 'Project shows its own sub-navigation');
    assert.ok(doc.querySelector('.mobile-bottom-nav .nav-back-btn'), 'Project offers a return to the root destinations');

    await router.push('/manage/settings');
    await settle(90);
    assert.deepEqual(navKeys(), ['environments', 'agents', 'usage', 'settings'], 'Manage shows its own sub-navigation');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('the phone return control leaves the nested destination for the root destinations', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/manage/agents');
    await router.isReady();
    app.mount(mount);
    await settle(110);

    const back = doc.querySelector('.mobile-bottom-nav .nav-back-btn') as HTMLButtonElement;
    assert.ok(back, 'the nested navigation offers a return control');
    back.click();
    await settle(110);

    assert.equal(router.currentRoute.value.path, '/feed', 'the return control reaches the root destinations');
    assert.deepEqual(
      [...doc.querySelectorAll('.mobile-bottom-nav [data-nav]')].map((el) => el.getAttribute('data-nav')),
      ['feed', 'project', 'manage'],
      'the root destinations are shown again'
    );

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('no reachable route renders a fixture control, viewport switcher, review UI, or provenance caption', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    app.mount(mount);

    for (const route of REACHABLE_ROUTES) {
      await router.push(route.path);
      await router.isReady();
      await settle(70);

      const text = doc.body.textContent ?? '';
      assert.doesNotMatch(text, /ADR-\d{4}/, `no architecture-decision caption on ${route.path}`);
      assert.doesNotMatch(text, /Ticket #\d+/, `no ticket caption on ${route.path}`);
      assert.doesNotMatch(text, /\bSimulate\b/, `no simulation control on ${route.path}`);
      assert.doesNotMatch(text, /State Matrix|Owner Review|Style Baseline|Layout Variant/i, `no review harness copy on ${route.path}`);

      for (const selector of [
        '.proto-control-bar',
        '#top-viewport-select',
        '#top-style-baseline-btn',
        '#top-density-btn',
        '.review-drawer',
        '.variant-switcher',
        '[data-prototype-link]',
      ]) {
        assert.equal(doc.querySelector(selector), null, `${selector} is absent on ${route.path}`);
      }
    }

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('the prototype archive is not reachable from any production navigation or page', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    app.mount(mount);

    // The production route table itself must contain no prototype path.
    for (const record of router.getRoutes()) {
      assert.doesNotMatch(record.path, /prototype/i, 'no prototype path exists in the production route table');
    }

    for (const route of REACHABLE_ROUTES) {
      await router.push(route.path);
      await router.isReady();
      await settle(70);
      const links = [...doc.querySelectorAll('a[href]')].map((el) => el.getAttribute('href') ?? '');
      assert.equal(links.some((href) => /prototype/i.test(href)), false, `no prototype archive link is offered on ${route.path}`);
    }

    app.unmount();
  } finally {
    await cleanup();
  }
});
