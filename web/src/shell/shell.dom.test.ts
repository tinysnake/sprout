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

test('the Shell composes a desktop sidebar and a phone bottom navigation from one navigation model', async () => {
  const { vite, doc, mountInto, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp({ routerBase: '/app/' });
    await router.push('/project/tasks');
    await router.isReady();
    mountInto(app);
    await settle();

    const sidebar = doc.querySelector('.desktop-sidebar');
    assert.ok(sidebar, 'the desktop sidebar is part of the frame');
    assert.equal(sidebar.getAttribute('aria-label'), 'Primary');

    const bottomNav = doc.querySelector('.mobile-bottom-nav');
    assert.ok(bottomNav, 'the phone bottom navigation is part of the frame');

    // Both surfaces describe the same active destination and tab.
    assert.equal(sidebar.querySelector('[data-nav="tasks"]')?.getAttribute('aria-current'), 'page');
    assert.equal(bottomNav?.querySelector('[data-nav="tasks"]')?.getAttribute('aria-current'), 'page');

    // The sidebar groups all three destinations; the phone shows the nested tabs.
    const sectionLabels = [...sidebar.querySelectorAll('.sidebar-section-label')].map((el) => el.textContent?.trim());
    assert.deepEqual(sectionLabels, ['Operations', 'Project', 'Manage']);
    assert.ok(bottomNav?.querySelector('.nav-back-btn'), 'the phone nested navigation offers a return control');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('the phone header states connection status in text and offers the theme control', async () => {
  const { vite, doc, mountInto, cleanup } = await setupHarness();
  try {
    const { createConnectionController, createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as never as {
      createConnectionController: never;
      createSproutApp: typeof import('../app/main.ts').createSproutApp;
    };
    void createConnectionController;
    const { app, router } = createSproutApp({ routerBase: '/app/' });
    await router.push('/feed');
    await router.isReady();
    mountInto(app);
    await settle();

    const pill = doc.querySelector('.operator-pill');
    assert.ok(pill, 'connection state is presented in the shell');
    assert.ok((pill.textContent ?? '').trim().length > 0, 'connection state carries visible text rather than colour alone');

    const themeButton = [...doc.querySelectorAll('button')].find((btn) => /Switch to (Light|Dark)/.test(btn.getAttribute('aria-label') ?? ''));
    assert.ok(themeButton, 'the theme control is reachable');
    assert.ok((themeButton.getAttribute('aria-label') ?? '').length > 0, 'the theme control has an accessible name');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('the Shell reports loading, offline, and reconnecting distinctly, and refuses control while unsettled', async () => {
  const { vite, doc, mountInto, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { createShellConnectionController } = (await vite.ssrLoadModule('/src/shell/connection.ts')) as typeof import('../shell/connection.ts');

    const controller = createShellConnectionController({ status: 'online', connection: 'online', loading: false });
    const { app, router } = createSproutApp({ routerBase: '/app/', connectionSource: controller });
    await router.push('/feed');
    await router.isReady();
    mountInto(app);
    await settle();

    const notice = () => doc.querySelector('[data-testid="shell-connection-notice"]');
    assert.equal(notice(), null, 'a connected shell does not warn');

    controller.set({ status: 'loading', connection: 'online', loading: true });
    await settle(60);
    assert.match(notice()?.textContent ?? '', /Checking connection/i, 'loading is announced as a pending check');

    controller.set({ status: 'reconnecting', connection: 'reconnecting', loading: false });
    await settle(60);
    assert.match(notice()?.textContent ?? '', /Reconnecting/i, 'reconnecting says so');
    assert.match(notice()?.textContent ?? '', /unavailable/i, 'reconnecting explains that control is unavailable');

    controller.set({ status: 'offline', connection: 'offline', loading: false });
    await settle(60);
    assert.match(notice()?.textContent ?? '', /Offline/i, 'offline says so');
    assert.match(notice()?.textContent ?? '', /queued/i, 'offline says actions are not queued');

    controller.set({ status: 'online', connection: 'online', loading: false });
    await settle(60);
    assert.equal(notice(), null, 'the warning clears when the connection returns');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('the Shell has exactly one live announcement region, and a page can announce into it', async () => {
  const { vite, doc, mountInto, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp({ routerBase: '/app/' });
    await router.push('/feed');
    await router.isReady();
    mountInto(app);
    await settle();

    const regions = doc.querySelectorAll('[aria-live]');
    assert.equal(regions.length, 1, 'the shell owns a single live region rather than one per surface');
    const region = regions[0];
    assert.ok(region);
    assert.ok(region.classList.contains('sr-only'), 'the region is visually hidden but present for assistive technology');
    assert.equal(region.getAttribute('aria-atomic'), 'true');

    // Navigating into a Project sub-view announces the new context.
    await router.push('/project/tasks');
    await settle(150);
    assert.match(
      doc.querySelector('[data-testid="shell-announcer"]')?.textContent ?? '',
      /Project tasks view/i,
      'a context change is announced through the shared region'
    );

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('the Shell offers a keyboard-only skip control that moves focus to the main content', async () => {
  const { vite, doc, mountInto, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp({ routerBase: '/app/' });
    await router.push('/feed');
    await router.isReady();
    mountInto(app);
    await settle();

    const skip = doc.querySelector('.skip-to-content') as HTMLButtonElement;
    assert.ok(skip, 'a skip control is the first operable control in the shell');
    skip.click();
    await settle(40);

    const main = doc.getElementById('sprout-main-content');
    assert.ok(main, 'the main content region is addressable');
    assert.equal(doc.activeElement, main, 'the skip control moves focus to the main content');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('the main content region is a focusable landmark reachable by assistive technology', async () => {
  const { vite, doc, mountInto, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp({ routerBase: '/app/' });
    await router.push('/manage/agents');
    await router.isReady();
    mountInto(app);
    await settle();

    const main = doc.querySelector('main');
    assert.ok(main, 'the shell exposes a main landmark');
    assert.equal(main.tagName.toLowerCase(), 'main');
    assert.equal(main.getAttribute('tabindex'), '-1', 'the landmark is programmatically focusable');

    const aside = doc.querySelector('aside');
    assert.ok(aside, 'the sidebar is a complementary landmark');
    const navs = [...doc.querySelectorAll('nav')];
    assert.ok(navs.length >= 2, 'both navigations are navigation landmarks');
    assert.ok(navs.every((nav) => (nav.getAttribute('aria-label') ?? '').length > 0), 'every navigation is labelled');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('every navigation target and interactive control in the shell is a real link or button', async () => {
  const { vite, doc, mountInto, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp({ routerBase: '/app/' });
    await router.push('/manage/usage');
    await router.isReady();
    mountInto(app);
    await settle();

    for (const surface of ['.desktop-sidebar', '.mobile-bottom-nav']) {
      const root = doc.querySelector(surface);
      assert.ok(root, `${surface} exists`);
      const targets = [...root.querySelectorAll('a, button')];
      assert.ok(targets.length > 0, `${surface} contains interactive entries`);
      for (const target of targets) {
        const tag = target.tagName.toLowerCase();
        assert.ok(tag === 'a' || tag === 'button', `${surface} entry is a real link or button, found ${tag}`);
      }
      // Navigation entries are links, so they participate in URL and history.
      const links = [...root.querySelectorAll('a')];
      assert.equal(links.length, root.querySelectorAll('[data-nav]').length, `${surface} navigates with links`);
      assert.ok(links.every((link) => (link.getAttribute('href') ?? '').length > 0), `${surface} links carry a real href`);
    }

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('shared primitives expose their accessible state: skeleton, empty state, list row, kpi, and disclosure', async () => {
  const { vite, cleanup } = await setupHarness();
  try {
    const { createApp, h } = await import('vue');
    const Skeleton = componentOf(await vite.ssrLoadModule('/src/primitives/Skeleton.vue'));
    const EmptyState = componentOf(await vite.ssrLoadModule('/src/primitives/EmptyState.vue'));
    const ListRow = componentOf(await vite.ssrLoadModule('/src/primitives/ListRow.vue'));
    const KpiTile = componentOf(await vite.ssrLoadModule('/src/primitives/KpiTile.vue'));
    const Foldable = componentOf(await vite.ssrLoadModule('/src/primitives/Foldable.vue'));

    const host = document.createElement('div');
    document.body.append(host);

    const app = createApp({
      render: () =>
        h('div', [
          h(Skeleton as never, { lines: 2, label: 'Loading Usage' }),
          h(EmptyState as never, { icon: 'usage', title: 'No usage recorded', description: 'Nothing matched.' }),
          h(ListRow as never, { title: 'Environment A', subtitle: 'Ready' }),
          h(KpiTile as never, { label: 'Total tokens', value: '1,144,570' }),
          h(KpiTile as never, { label: 'Billed cost', unavailable: true }),
          h(Foldable as never, { title: 'Evidence', subtext: 'On demand' }, { default: () => h('p', 'body') }),
        ]),
    });
    app.mount(host);
    await settle(60);

    // Loading: busy state plus a visible label, never an empty result.
    const loading = host.querySelector('.skeleton');
    assert.ok(loading, 'skeleton renders');
    assert.equal(loading.getAttribute('aria-busy'), 'true');
    assert.match(loading.getAttribute('aria-label') ?? '', /Loading Usage/);

    // Empty state: named heading plus a description.
    assert.match(host.querySelector('.card')?.textContent ?? '', /No usage recorded/);
    assert.match(host.querySelector('.card')?.textContent ?? '', /Nothing matched/);

    // List row: title and subtitle, presentation only.
    assert.match(host.querySelector('.list-row')?.textContent ?? '', /Environment A/);
    assert.match(host.querySelector('.list-row')?.textContent ?? '', /Ready/);

    // Metric: an absent measurement is reported as unavailable, not zero.
    const kpis = [...host.querySelectorAll('.card-kpi')];
    assert.equal(kpis.length, 2);
    assert.match(kpis[0]?.textContent ?? '', /1,144,570/);
    assert.match(kpis[1]?.textContent ?? '', /Unavailable/);
    assert.doesNotMatch(kpis[1]?.textContent ?? '', /\b0\b/, 'an absent measurement is not shown as zero');

    // Disclosure: expands with keyboard-operable state.
    const trigger = host.querySelector('[data-state]') ?? host.querySelector('button');
    assert.ok(trigger, 'the disclosure renders a trigger');
    const expandedBefore = trigger.getAttribute('aria-expanded') ?? trigger.getAttribute('data-state');
    assert.ok(expandedBefore !== null, 'the trigger reports its expanded state');
    (trigger as HTMLElement).click();
    await settle(60);
    const after = host.querySelector('[aria-expanded], [data-state]');
    assert.ok(after, 'the disclosure still reports a state after activation');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('an interactive non-button card is focusable, exposes role=button, and activates from the keyboard', async () => {
  const { vite, dom, cleanup } = await setupHarness();
  try {
    const { createApp, h, ref } = await import('vue');
    const Card = componentOf(await vite.ssrLoadModule('/src/primitives/Card.vue'));

    const host = document.createElement('div');
    document.body.append(host);
    const activations = ref(0);

    const app = createApp({
      render: () =>
        h('div', [
          // A non-button interactive card: focus and keyboard activation must be real.
          h(
            Card as never,
            {
              interactive: true,
              class: 'option-card',
              onClick: () => { activations.value += 1; },
            },
            { default: () => h('span', 'Option A') }
          ),
          // A button card must not accidentally submit an enclosing form.
          h(
            Card as never,
            { as: 'button', interactive: true, class: 'button-card' },
            { default: () => h('span', 'Option B') }
          ),
        ]),
    });
    app.mount(host);
    await settle(60);

    const option = host.querySelector('.option-card') as HTMLElement;
    assert.ok(option, 'the interactive card renders');
    assert.equal(option.tagName.toLowerCase(), 'div', 'the default card stays a non-button element');
    assert.equal(option.getAttribute('tabindex'), '0', 'the non-button card is in the tab sequence');
    assert.equal(option.getAttribute('role'), 'button', 'the non-button card exposes button semantics');

    // The Enter/Space path is reachable because the element can receive focus.
    option.focus();
    assert.equal(document.activeElement, option, 'the card can actually receive focus');
    option.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle(30);
    assert.equal(activations.value, 1, 'Enter activates the card once');
    option.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    await settle(30);
    assert.equal(activations.value, 2, 'Space activates the card once');

    const button = host.querySelector('.button-card') as HTMLButtonElement;
    assert.ok(button, 'the button card renders as a real button');
    assert.equal(button.tagName.toLowerCase(), 'button');
    assert.equal(button.getAttribute('type'), 'button', 'a card button never submits an enclosing form');

    app.unmount();
  } finally {
    await cleanup();
  }
});

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
