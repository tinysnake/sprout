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
  const agentsModule = (await vite.ssrLoadModule('/src/modules/agents/adapters/fixture-adapter.ts')) as typeof import('../modules/agents/adapters/fixture-adapter.ts');
  const projectsModule = (await vite.ssrLoadModule('/src/modules/projects/adapters/fixture-adapter.ts')) as typeof import('../modules/projects/adapters/fixture-adapter.ts');
  const chatModule = (await vite.ssrLoadModule('/src/modules/chat/adapters/fixture-adapter.ts')) as typeof import('../modules/chat/adapters/fixture-adapter.ts');
  const environmentService = new module.FixtureEnvironmentService();
  const agentService = new agentsModule.FixtureAgentService();
  return {
    routerBase: '/app/',
    environmentService,
    agentService,
    projectService: new projectsModule.FixtureProjectService(agentService, environmentService),
    chatService: new chatModule.FixtureChatService(),
  };
}

/** Routes the operator can actually reach, with the content each must compose. */
const REACHABLE_ROUTES: readonly { path: string; destination: string; tab?: string; expect: RegExp }[] = [
  { path: '/feed', destination: 'feed', expect: /Operations Feed & Human Attention/ },
  { path: '/project/overview', destination: 'project', tab: 'overview', expect: /Project Contract & Purpose/ },
  { path: '/project/tasks', destination: 'project', tab: 'tasks', expect: /Project Tasks & Operating Loop/ },
  { path: '/project/tasks/101', destination: 'project', tab: 'tasks', expect: /Task Operating Stage & Specification/ },
  { path: '/project/chat', destination: 'project', tab: 'chat', expect: /Conversations & Groups/ },
  { path: '/project/chat/wg-frontend', destination: 'project', tab: 'chat', expect: /wg-frontend/ },
  { path: '/manage/environments', destination: 'manage', tab: 'environments', expect: /Environments & Host Infrastructure/ },
  { path: '/manage/environments/env-ready', destination: 'manage', tab: 'environments', expect: /6 Independent Health Dimensions/ },
  { path: '/manage/agents', destination: 'manage', tab: 'agents', expect: /Agents & Work Option Preferences/ },
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

test('Project Chat groups scopes, preserves empty and read-only history, and authors only in a writable scope', async () => {
  const { vite, doc, dom, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/project/chat');
    app.mount(mount);
    await settle(160);
    assert.match(doc.body.textContent ?? '', /Project Channels.*Working Groups.*Direct Messages/s);
    assert.ok(doc.querySelector('[data-event-id="event-review"]'), 'Project events have their own authored, ordered entry');
    assert.ok(doc.querySelector('[data-message-id="msg-addressed"]'), 'messages render in the channel');
    await router.push('/project/chat/dm-empty');
    await settle(100);
    assert.match(doc.querySelector('.chat-empty-state')?.textContent ?? '', /No messages yet/);
    const input = doc.querySelector('.chat-composer input') as HTMLInputElement;
    assert.equal(input.disabled, false);
    input.value = 'First message';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(20);
    (doc.querySelector('.chat-composer button') as HTMLButtonElement).click();
    await settle(100);
    assert.match(doc.querySelector('.chat-messages-body')?.textContent ?? '', /First message/);
    await router.push('/project/chat');
    await settle(70);
    (doc.querySelector('.chat-direct-unopened') as HTMLButtonElement).click();
    await settle(100);
    assert.equal(router.currentRoute.value.params['scopeId'], 'dm-programmer', 'a project Agent opens an idempotent Project-scoped direct conversation');
    assert.ok(doc.querySelector('[data-scope-id="dm-programmer"]'));
    await router.push('/project/chat');
    await settle(70);
    const infoButton = doc.querySelector('.chat-info-btn') as HTMLButtonElement;
    infoButton.focus();
    infoButton.click();
    await settle(60);
    assert.match(doc.body.textContent ?? '', /Conversation Details —/, 'info dialog works after navigating back');
    const infoDialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    assert.ok(infoDialog.contains(doc.activeElement), 'dialog owns focus');
    infoDialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(60);
    assert.equal(doc.querySelector('[role="dialog"]'), null, 'Escape closes the dialog');
    assert.equal(doc.activeElement, infoButton, 'closing returns focus to the opener');
    (doc.querySelector('.chat-create-wg') as HTMLButtonElement).click();
    await settle(120);
    const name = doc.querySelector('#chat-wg-name') as HTMLInputElement;
    assert.ok(name, 'the Working Group composer opens');
    const members = doc.querySelector('#chat-wg-name')?.closest('[role="dialog"]')?.querySelector('fieldset');
    assert.match(members?.textContent ?? '', /@Programmer.*Implement verified changes/s);
    assert.doesNotMatch(members?.textContent ?? '', /@programmer\b/, 'a raw agent ID is not a display name');
    name.value = 'Focused Review';
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(20);
    (doc.querySelector('.chat-create-wg-submit') as HTMLButtonElement).click();
    await settle(100);
    assert.match(doc.querySelector('.chat-messages-body')?.textContent ?? '', /No messages yet/);
    assert.ok([...doc.querySelectorAll('[data-scope-kind="working-group"]')].some((item) => /Focused Review/.test(item.textContent ?? '')));
    await router.push('/project/chat/wg-retired');
    await settle(100);
    assert.match(doc.querySelector('.chat-readonly-banner')?.textContent ?? '', /disbanded.*read-only/i);
    assert.equal((doc.querySelector('.chat-composer input') as HTMLInputElement).disabled, true);
    (doc.querySelector('.chat-readonly-banner button') as HTMLButtonElement).click();
    await settle(100);
    assert.equal(doc.querySelector('.chat-readonly-banner'), null, 'restore rechecks server admission');
    assert.equal((doc.querySelector('.chat-composer input') as HTMLInputElement).disabled, false);
    await router.push('/project/chat/dm-ended');
    await settle(100);
    assert.match(doc.querySelector('.chat-readonly-banner')?.textContent ?? '', /membership has ended/i);
    await router.push('/project/chat/channel-project-archived?project=project-archived');
    await settle(120);
    assert.match(doc.querySelector('.chat-readonly-banner')?.textContent ?? '', /Project is archived/);
    app.unmount();
  } finally { await cleanup(); }
});

test('Working Group details edit content and disband without erasing history', async () => {
  const { vite, doc, dom, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/project/chat/wg-frontend?project=project-sprout');
    app.mount(mount);
    await settle(160);
    assert.equal((doc.querySelector('#chat-project-selector') as HTMLSelectElement).value, 'project-sprout');
    (doc.querySelector('.chat-info-btn') as HTMLButtonElement).click();
    await settle(30);
    ([...doc.querySelectorAll('button')].find((button) => button.textContent?.includes('Edit Working Group')) as HTMLButtonElement).click();
    await settle(30);
    const name = doc.querySelector('#chat-edit-name') as HTMLInputElement;
    name.value = 'Revised group';
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(20);
    ([...doc.querySelectorAll('button')].find((button) => button.textContent?.includes('Save Changes')) as HTMLButtonElement).click();
    await settle(100);
    assert.match(doc.querySelector('.chat-messages-body')?.textContent ?? '', /Focus ring contrast/);
    assert.match(doc.querySelector('.chat-scope-card[aria-current="page"]')?.textContent ?? '', /Revised group/);
    (doc.querySelector('.chat-info-btn') as HTMLButtonElement).click();
    await settle(30);
    ([...doc.querySelectorAll('button')].find((button) => button.textContent?.includes('Edit Working Group')) as HTMLButtonElement).click();
    await settle(30);
    ([...doc.querySelectorAll('button')].find((button) => button.textContent?.includes('Disband Working Group')) as HTMLButtonElement).click();
    await settle(20);
    ([...doc.querySelectorAll('button')].find((button) => button.textContent?.includes('Confirm Disband')) as HTMLButtonElement).click();
    await settle(100);
    assert.match(doc.querySelector('.chat-readonly-banner')?.textContent ?? '', /disbanded.*read-only/i);
    assert.match(doc.querySelector('.chat-messages-body')?.textContent ?? '', /Focus ring contrast/);
    app.unmount();
  } finally { await cleanup(); }
});

test('Project Chat distinguishes pending, suppressed and failed evidence; batch and attempt URLs never substitute Chat', async () => {
  const { vite, doc, dom, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/project/chat');
    app.mount(mount);
    await settle(160);
    for (const [id, state, language] of [
      ['msg-pending', 'pending', /window open|judgement is pending/i],
      ['msg-suppressed', 'suppressed', /Suppressed — durable decision/],
      ['msg-failed', 'failed', /Routing failed closed/],
    ] as const) {
      const trigger = doc.querySelector(`[data-message-id="${id}"] .chat-evidence-trigger`) as HTMLButtonElement;
      assert.ok(trigger, `evidence trigger exists for ${id}`);
      trigger.click();
      await settle(70);
      const popup = doc.querySelector('.chat-evidence-popup') as HTMLElement;
      assert.equal(popup?.dataset['evidenceState'], state, id);
      assert.match(popup.textContent ?? '', language);
      doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(20);
      assert.equal(doc.querySelector('.chat-evidence-popup'), null);
      assert.equal(doc.activeElement, trigger, 'Escape restores focus to the evidence trigger');
    }
    await router.push('/project/chat/routing/batch-failed?attempt=1');
    await settle(100);
    assert.equal(doc.querySelector('.routing-inspector-view')?.getAttribute('data-inspector-state'), 'ready');
    assert.match(doc.body.textContent ?? '', /Batch ID: batch-failed/);
    assert.ok(doc.querySelector('[data-attempt-id="attempt-batch-failed-1"]'));
    assert.equal(doc.activeElement?.getAttribute('data-attempt-id'), 'attempt-batch-failed-1', 'attempt deep links focus the exact attempt');
    assert.equal(doc.querySelector('[data-scope-id]'), null, 'the inspector is not generic Chat');
    await router.push('/project/chat/routing/batch-failed?attempt=999');
    await settle(60);
    assert.ok(doc.querySelector('.routing-attempt-not-found'));
    assert.ok(doc.activeElement?.classList.contains('routing-attempt-not-found'), 'a missing attempt is announced and focused');
    await router.push('/project/chat/routing/missing-batch');
    await settle(80);
    assert.ok(doc.querySelector('.routing-not-found-state'));
    assert.equal(doc.querySelector('[data-scope-id]'), null);
    app.unmount();
  } finally { await cleanup(); }
});

test('a colon-bearing Agent reply opens projected evidence and its provenance', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/project/chat');
    app.mount(mount);
    await settle(160);
    const trigger = doc.querySelector('[data-message-id="reply-msg-addressed:programmer"] .chat-evidence-trigger') as HTMLButtonElement;
    assert.ok(trigger, 'the projected reply is available for inspection');
    trigger.click();
    await settle(100);
    const popup = doc.querySelector('.chat-evidence-popup') as HTMLElement;
    assert.equal(popup?.dataset['evidenceState'], 'projected');
    assert.match(popup.textContent ?? '', /Projected Reply · Non-Routing/);
    assert.match(popup.textContent ?? '', /Triggered by:.*msg-addressed/);
    assert.match(popup.textContent ?? '', /Run:.*run-projected/);
    assert.doesNotMatch(popup.textContent ?? '', /Routing evidence unavailable/);
    app.unmount();
  } finally { await cleanup(); }
});

test('Project Chat marks offline facts stale and disables controls; loading and live unread are distinct', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { FixtureChatService } = (await vite.ssrLoadModule('/src/modules/chat/adapters/fixture-adapter.ts')) as typeof import('../modules/chat/adapters/fixture-adapter.ts');
    const { createShellConnectionController, OFFLINE_CONNECTION } = (await vite.ssrLoadModule('/src/shell/connection.ts')) as typeof import('../shell/connection.ts');
    const fixture = new FixtureChatService();
    const controller = createShellConnectionController({ status: 'online', connection: 'online', loading: false });
    const { app, router } = createSproutApp({ ...(await deterministicAppOptions(vite)), chatService: fixture, connectionSource: controller });
    await router.push('/project/chat');
    app.mount(mount);
    await settle(160);
    await fixture.pushIncoming('wg-frontend', 'New agent update');
    await settle(80);
    assert.match(doc.querySelector('.shell-announcer')?.textContent ?? '', /1 new message in /i);
    assert.match(doc.querySelector('[data-scope-id="wg-frontend"] .chat-unread-badge')?.textContent ?? '', /1 new/);
    (doc.querySelector('[data-scope-id="wg-frontend"]') as HTMLButtonElement).click();
    await settle(90);
    assert.equal(doc.querySelector('[data-scope-id="wg-frontend"] .chat-unread-badge'), null);
    assert.equal(router.currentRoute.value.params['scopeId'], 'wg-frontend');
    assert.equal(doc.activeElement?.classList.contains('chat-mobile-back'), true, 'drill-down moves keyboard focus');
    controller.set(OFFLINE_CONNECTION);
    await settle(30);
    assert.equal(doc.querySelector('.chat-offline-banner'), null, 'transient offline state does not blink');
    assert.equal((doc.querySelector('.chat-composer input') as HTMLInputElement).disabled, true);
    assert.equal((doc.querySelector('.chat-composer button') as HTMLButtonElement).disabled, true);
    app.unmount();
  } finally { await cleanup(); }

  const loadingHarness = await setupHarness();
  try {
    const { createSproutApp } = (await loadingHarness.vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { FixtureChatService } = (await loadingHarness.vite.ssrLoadModule('/src/modules/chat/adapters/fixture-adapter.ts')) as typeof import('../modules/chat/adapters/fixture-adapter.ts');
    const { app, router } = createSproutApp({ ...(await deterministicAppOptions(loadingHarness.vite)), chatService: new FixtureChatService({ loading: true }) });
    await router.push('/project/chat');
    app.mount(loadingHarness.mount);
    await settle(90);
    assert.equal(loadingHarness.doc.querySelector('.chat-loading-state')?.getAttribute('aria-busy'), 'true');
    app.unmount();
  } finally { await loadingHarness.cleanup(); }
});

test('Chat floating notice waits five continuous seconds, clears on recovery, and never resizes the detail', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { createShellConnectionController, OFFLINE_CONNECTION } = (await vite.ssrLoadModule('/src/shell/connection.ts')) as typeof import('../shell/connection.ts');
    const controller = createShellConnectionController({ status: 'online', connection: 'online', loading: false });
    const { app, router } = createSproutApp({ ...(await deterministicAppOptions(vite)), connectionSource: controller });
    await router.push('/project/chat/dm-architect');
    app.mount(mount);
    await settle(150);
    const notice = () => doc.querySelector('.chat-offline-banner');
    const detail = doc.querySelector('[aria-label="Conversation detail"]');
    const body = doc.querySelector('.chat-messages-body');
    assert.ok(detail && body);
    const geometry = () => [detail, body].map((element) => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    });
    const before = geometry();
    const bodyClasses = body.className;
    assert.equal(body.classList.contains('pt-32'), false, 'hidden notices reserve no message lane');
    controller.set(OFFLINE_CONNECTION);
    await settle(150);
    assert.equal(notice(), null);
    assert.equal((doc.querySelector('.chat-composer button') as HTMLButtonElement).disabled, true,
      'Send refuses immediately despite display debounce');
    controller.set({ status: 'online', connection: 'online', loading: false });
    await settle(50);
    controller.set(OFFLINE_CONNECTION);
    await settle(4900);
    assert.equal(notice(), null, 'the recovered interval does not count toward five seconds');
    await settle(180);
    assert.match(notice()?.textContent ?? '', /Offline.*disabled, not queued/s);
    assert.equal(notice()?.getAttribute('role'), 'status');
    assert.ok(notice()?.classList.contains('absolute'));
    assert.equal(body.classList.contains('pt-32'), false, 'visible notices reserve no message lane');
    assert.equal(body.className, bodyClasses, 'connection visibility never changes message padding or layout classes');
    assert.ok(notice()?.classList.contains('pointer-events-none'));
    assert.ok(notice()?.classList.contains('bg-[var(--bg-surface)]'), 'the overlay is readable over messages');
    assert.ok(notice()?.classList.contains('z-20'));
    assert.deepEqual(geometry(), before, 'mounting an overlay does not change detail or message geometry');
    controller.set({ status: 'online', connection: 'online', loading: false });
    await settle(30);
    assert.equal(notice(), null, 'recovery clears the visible notice immediately');
    app.unmount();
  } finally { await cleanup(); }
});

test('conversation admission gates Send immediately but only floats after five continuous seconds', async () => {
  const { vite, doc, dom, mount, cleanup } = await setupHarness();
  let unmount = () => {};
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { FixtureChatService } = (await vite.ssrLoadModule('/src/modules/chat/adapters/fixture-adapter.ts')) as typeof import('../modules/chat/adapters/fixture-adapter.ts');
    const fixture = new FixtureChatService();
    const inspect = fixture.inspectScope.bind(fixture);
    let resolve!: (value: Awaited<ReturnType<typeof inspect>>) => void;
    fixture.inspectScope = (id) => new Promise((done) => { resolve = done; }).then(() => inspect(id));
    const { app, router } = createSproutApp({ ...(await deterministicAppOptions(vite)), chatService: fixture });
    unmount = () => app.unmount();
    await router.push('/project/chat/dm-architect');
    app.mount(mount);
    await settle(150);
    const body = doc.querySelector('.chat-messages-body');
    const detail = doc.querySelector('[aria-label="Conversation detail"]');
    assert.ok(body && detail);
    const geometry = () => [body, detail].map((element) => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    });
    const before = geometry();
    const bodyClasses = body.className;
    const notice = () => doc.querySelector('.chat-detail-loading');
    const status = doc.querySelector('.chat-admission-announcement');
    assert.ok(status?.classList.contains('sr-only'), 'the admission live status has no visual footprint');
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.match(status.textContent ?? '', /Checking conversation admission/, 'pending admission announces immediately');
    assert.equal(notice(), null, 'the initial admission check does not flash');
    assert.equal(body.classList.contains('pt-32'), false, 'admission reserves no vertical lane');
    assert.equal(body.getAttribute('aria-busy'), 'true', 'raw admission remains exposed immediately');
    const input = doc.querySelector('.chat-composer input') as HTMLInputElement;
    input.value = 'Keep this draft';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(20);
    assert.equal(input.disabled, false, 'the admission check does not interrupt typing');
    assert.equal((doc.querySelector('.chat-composer button') as HTMLButtonElement).disabled, true);
    assert.match(doc.querySelector('#chat-send-reason')?.textContent ?? '', /Checking conversation admission before sending/);
    await settle(4500);
    assert.equal(notice(), null, 'a still-pending short check has no visible status');
    assert.match(status.textContent ?? '', /Checking conversation admission/, 'the live status does not wait for visual persistence');
    await settle(600);
    assert.equal(notice()?.getAttribute('aria-hidden'), 'true', 'the visual overlay does not repeat the live announcement');
    assert.match(notice()?.textContent ?? '', /Checking conversation admission/);
    assert.ok(notice()?.classList.contains('absolute'));
    assert.ok(notice()?.classList.contains('pointer-events-none'));
    assert.ok(notice()?.classList.contains('bg-[var(--bg-surface)]'));
    assert.ok(notice()?.classList.contains('z-20'));
    assert.equal(body.className, bodyClasses, 'admission visibility never changes message padding or layout classes');
    assert.deepEqual(geometry(), before, 'the admission overlay cannot push messages or resize detail');
    resolve(await inspect('dm-architect'));
    await settle(50);
    assert.equal(notice(), null, 'resolution clears the status immediately');
    assert.equal(status.textContent, '', 'resolution clears the live status immediately');
    assert.equal(body.getAttribute('aria-busy'), 'false');
    assert.equal((doc.querySelector('.chat-composer button') as HTMLButtonElement).disabled, false, 'Send resumes with the same draft');
    assert.equal(doc.querySelector('#chat-send-reason'), null, 'admission no longer blocks Send');
    assert.deepEqual(geometry(), before);
    await router.push('/project/chat/wg-frontend');
    await settle(50);
    assert.equal((doc.querySelector('.chat-composer button') as HTMLButtonElement).disabled, true,
      'a new admission check gates Send immediately');
    assert.equal(notice(), null, 'a new check starts its own display interval');
    assert.match(status.textContent ?? '', /Checking conversation admission/, 'even a brief check announces before its visual interval');
    assert.equal(body.getAttribute('aria-busy'), 'true');
    resolve(await inspect('wg-frontend'));
    await settle(60);
    assert.equal(notice(), null, 'a short admission flap never shows a status');
    assert.equal(status.textContent, '', 'a short check also clears the live status on recovery');
    assert.equal(body.getAttribute('aria-busy'), 'false');
  } finally { unmount(); await cleanup(); }
});

test('idle Message and Project-event arrivals announce without run status; hidden Chat catches up on return', async () => {
  const { vite, doc, dom, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { FixtureChatService } = (await vite.ssrLoadModule('/src/modules/chat/adapters/fixture-adapter.ts')) as typeof import('../modules/chat/adapters/fixture-adapter.ts');
    const fixture = new FixtureChatService();
    const { app, router } = createSproutApp({ ...(await deterministicAppOptions(vite)), chatService: fixture });
    await router.push('/project/chat');
    app.mount(mount);
    await settle(170);
    fixture.pushIdleMessage('wg-frontend', 'Unrouted conversation update');
    await settle(15100); // The bounded idle poll, not an injected run-status notification.
    assert.match(doc.querySelector('.shell-announcer')?.textContent ?? '', /1 new message in /i);
    assert.match(doc.querySelector('[data-scope-id="wg-frontend"] .chat-unread-badge')?.textContent ?? '', /1 new/);

    Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'hidden' });
    doc.dispatchEvent(new dom.window.Event('visibilitychange'));
    fixture.pushIdleEvent('Review is awaiting Human action.');
    await settle(100);
    assert.equal(doc.querySelector('[data-event-id="idle-event-1"]'), null, 'hidden Chat does not fetch');
    Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'visible' });
    doc.dispatchEvent(new dom.window.Event('visibilitychange'));
    await settle(100);
    assert.ok(doc.querySelector('[data-event-id="idle-event-1"]'), 'visibility restores Project-event observation');
    assert.match(doc.querySelector('.shell-announcer')?.textContent ?? '', /1 new Project event in /i);
    app.unmount();
  } finally { await cleanup(); }
});

test('a refused Message response reuses its delivery key when the unchanged draft is retried', async () => {
  const { vite, doc, dom, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { FixtureChatService } = (await vite.ssrLoadModule('/src/modules/chat/adapters/fixture-adapter.ts')) as typeof import('../modules/chat/adapters/fixture-adapter.ts');
    const fixture = new FixtureChatService();
    const post = fixture.postMessage.bind(fixture);
    const keys: string[] = [];
    fixture.postMessage = async (input) => {
      keys.push(input.deliveryKey);
      if (keys.length === 1) throw new Error('response lost after delivery');
      return post(input);
    };
    const { app, router } = createSproutApp({ ...(await deterministicAppOptions(vite)), chatService: fixture });
    await router.push('/project/chat/dm-architect');
    app.mount(mount);
    await settle(140);
    const input = doc.querySelector('.chat-composer input') as HTMLInputElement;
    input.value = 'Please inspect the evidence';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(20);
    (doc.querySelector('.chat-composer button') as HTMLButtonElement).click();
    await settle(50);
    assert.match(doc.body.textContent ?? '', /Message was not sent/);
    assert.equal(input.value, 'Please inspect the evidence', 'the draft remains for retry');
    (doc.querySelector('.chat-composer button') as HTMLButtonElement).click();
    await settle(80);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], 'retry cannot create a second delivery/wake');
    assert.match(doc.querySelector('.chat-messages-body')?.textContent ?? '', /Please inspect the evidence/);
    app.unmount();
  } finally { await cleanup(); }
});

test('background reads preserve typing, focus and Send authority', async () => {
  const { vite, doc, dom, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { createShellConnectionController, OFFLINE_CONNECTION } = (await vite.ssrLoadModule('/src/shell/connection.ts')) as typeof import('../shell/connection.ts');
    const controller = createShellConnectionController({ status: 'online', connection: 'online', loading: false });
    const { app, router } = createSproutApp({ ...(await deterministicAppOptions(vite)), connectionSource: controller });
    await router.push('/project/chat/dm-architect');
    app.mount(mount);
    await settle(150);
    const input = doc.querySelector('.chat-composer input') as HTMLInputElement;
    input.focus();
    input.value = 'Draft';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    controller.set({ status: 'loading', connection: 'online', loading: true });
    await settle(30);
    assert.equal(input.disabled, false);
    assert.equal(doc.activeElement, input);
    input.value += ' still typing';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(20);
    assert.equal((doc.querySelector('.chat-composer button') as HTMLButtonElement).disabled, false);
    assert.equal(doc.querySelector('.chat-offline-banner'), null, 'a read is not a connection warning');
    controller.set({ status: 'online', connection: 'online', loading: false });
    await settle(25);
    assert.equal(input.value, 'Draft still typing');
    assert.equal(doc.activeElement, input);
    controller.set(OFFLINE_CONNECTION);
    await settle(25);
    assert.equal(input.disabled, true, 'a genuine offline state can disable text entry');
    assert.equal(input.value, 'Draft still typing', 'offline does not erase the draft');
    app.unmount();
  } finally { await cleanup(); }
});

test('Send uses a random-values UUID when randomUUID is unavailable on an insecure entry', async () => {
  const { vite, doc, dom, mount, cleanup } = await setupHarness();
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    const nativeCrypto = globalThis.crypto;
    let randomValuesUsed = false;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
      getRandomValues(bytes: Uint8Array) { randomValuesUsed = true; return nativeCrypto.getRandomValues(bytes); },
      randomUUID: undefined,
    } });
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { FixtureChatService } = (await vite.ssrLoadModule('/src/modules/chat/adapters/fixture-adapter.ts')) as typeof import('../modules/chat/adapters/fixture-adapter.ts');
    const fixture = new FixtureChatService();
    const post = fixture.postMessage.bind(fixture);
    let deliveryKey = '';
    fixture.postMessage = async (input) => { deliveryKey = input.deliveryKey; return post(input); };
    const { app, router } = createSproutApp({ ...(await deterministicAppOptions(vite)), chatService: fixture });
    await router.push('/project/chat/dm-architect');
    app.mount(mount);
    await settle(150);
    const input = doc.querySelector('.chat-composer input') as HTMLInputElement;
    input.value = 'Sent without secure context';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(20);
    (doc.querySelector('.chat-composer button') as HTMLButtonElement).click();
    await settle(90);
    assert.equal(randomValuesUsed, true);
    assert.match(deliveryKey, /^web-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    assert.match(doc.querySelector('.chat-messages-body')?.textContent ?? '', /Sent without secure context/);
    app.unmount();
  } finally {
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
    await cleanup();
  }
});

test('a disconnected inspector never presents an unverified batch as not found or substitutes Chat', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { FixtureChatService } = (await vite.ssrLoadModule('/src/modules/chat/adapters/fixture-adapter.ts')) as typeof import('../modules/chat/adapters/fixture-adapter.ts');
    const { BrowserRequestError } = (await vite.ssrLoadModule('/src/transport/browser-transport.ts')) as typeof import('../transport/browser-transport.ts');
    const fixture = new FixtureChatService();
    fixture.getRoutingBatch = async () => { throw new BrowserRequestError('unavailable'); };
    const { app, router } = createSproutApp({ ...(await deterministicAppOptions(vite)), chatService: fixture });
    await router.push('/project/chat/routing/batch-failed');
    app.mount(mount);
    await settle(100);
    assert.ok(doc.querySelector('.routing-unavailable-state'));
    assert.equal(doc.querySelector('.routing-not-found-state'), null);
    assert.equal(doc.querySelector('[data-scope-id]'), null);
    app.unmount();
  } finally { await cleanup(); }
});

test('an archived Agent preserves its Project direct history but cannot receive new messages', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const options = await deterministicAppOptions(vite);
    await options.chatService.openDirectConversation('project-sprout', ['operator', 'programmer']);
    await options.agentService.archiveAgent('programmer');
    const { app, router } = createSproutApp(options);
    await router.push('/project/chat/dm-programmer');
    app.mount(mount);
    await settle(150);
    assert.match(doc.querySelector('.chat-readonly-banner')?.textContent ?? '', /Agent @Programmer is archived/);
    assert.equal((doc.querySelector('.chat-composer input') as HTMLInputElement).disabled, true);
    assert.match(doc.querySelector('[data-scope-id="dm-programmer"]')?.textContent ?? '', /Archived/);
    app.unmount();
  } finally { await cleanup(); }
});
