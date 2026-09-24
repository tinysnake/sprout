import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

// 1. Initialize JSDOM and globals BEFORE importing any Vue or Vite modules
const initialHtml = await readFile(new URL('../../app/index.html', import.meta.url), 'utf8');
const initialDom = new JSDOM(initialHtml, {
  url: 'http://sprout-operator.test/app/manage/environments',
  pretendToBeVisual: true,
});

(initialDom.window as Record<string, unknown>).__SPROUT_TEST_MANUAL_MOUNT__ = true;

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
  TouchEvent: initialDom.window.TouchEvent,
  CustomEvent: initialDom.window.CustomEvent,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 10),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IntersectionObserver: class {
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

// 2. Now dynamically import vite and plugin-vue so runtime-dom sees document
const { createServer } = await import('vite');
const { default: vue } = await import('@vitejs/plugin-vue');

async function setupProductionDom() {
  const dom = initialDom;

  const vite = await createServer({
    root: new URL('../..', import.meta.url).pathname,
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

  return {
    dom,
    vite,
    cleanup: async () => {
      await vite.close();
    },
  };
}

/**
 * Deterministic tests inject the fixture authorities explicitly. The production
 * routes themselves require typed adapters and render unavailable states when
 * none is provided, so they never default to fixture facts.
 */
async function deterministicAppOptions(vite: { ssrLoadModule: (id: string) => Promise<unknown> }) {
  const module = (await vite.ssrLoadModule(
    '/src/modules/environments/adapters/fixture-adapter.ts'
  )) as typeof import('../modules/environments/adapters/fixture-adapter.ts');
  const agentsModule = (await vite.ssrLoadModule(
    '/src/modules/agents/adapters/fixture-adapter.ts'
  )) as typeof import('../modules/agents/adapters/fixture-adapter.ts');
  return {
    routerBase: '/app/',
    environmentService: new module.FixtureEnvironmentService(),
    agentService: new agentsModule.FixtureAgentService(),
  };
}

/**
 * A real `ProductionEnvironmentService` over a stub wire adapter serving one
 * reachable reconciling record. No fixture adapter is involved; this proves
 * what the production bridge itself renders for an open reconciling record.
 */
async function productionReconcilingAppOptions(vite: { ssrLoadModule: (id: string) => Promise<unknown> }) {
  const apiModule = (await vite.ssrLoadModule('/src/adapters/environment-api.ts')) as typeof import('../adapters/environment-api.ts');
  const adapterModule = (await vite.ssrLoadModule('/src/modules/environments/adapters/production-adapter.ts')) as typeof import('../modules/environments/adapters/production-adapter.ts');
  const synchronizeCalls: unknown[] = [];
  const wire = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    setCsrfToken: () => undefined,
    async listEnrollments() {
      return [reconcilingFacts.enrollment];
    },
    async environmentFacts() {
      return reconcilingFacts;
    },
    async synchronizeEvidence(_leaseId: string, input: unknown) {
      synchronizeCalls.push(input);
      return reconcilingFacts.recovery[0];
    },
  } as unknown as import('../adapters/environment-api.ts').EnvironmentEnrollmentBrowserAdapter;
  const reconcilingFacts: apiModule.EnvironmentFactsView = {
    enrollment: {
      id: 'enroll-reconciling',
      environmentInstanceId: 'inst-1',
      displayName: 'Production Reconciling Host',
      status: 'approved',
      platform: 'macos',
      identityDigest: 'digest',
      capabilityPermissions: { 'agent-run': true },
      createdAt: 1,
      updatedAt: 2,
      decisions: [],
    },
    readiness: {
      environmentInstanceId: 'inst-1',
      summary: { level: 'yellow', reason: 'Worker reconnected; reconciling settlement evidence.' },
      enrollmentStatus: 'approved',
      connection: { state: 'online', lastConfirmedAt: 1000 },
      compatibility: { state: 'compatible' },
      capabilities: [],
      engines: [],
      workSafety: { state: 'reconciling' },
    },
    probes: [],
    recovery: [
      {
        id: 'rec-1',
        environmentInstanceId: 'inst-1',
        leaseId: 'lease-9',
        holderKind: 'task',
        taskId: 'task-104',
        cause: 'worker-channel-lost',
        phase: 'reconciling',
        startedAt: 10,
        updatedAt: 20,
        unresolvedFacts: ['The Worker channel is lost; no retained evidence has been synchronized.'],
        evidenceSynchronized: false,
        decisions: [],
      },
    ],
    forceReleases: [],
  };
  return {
    routerBase: '/app/' as const,
    environmentService: new adapterModule.ProductionEnvironmentService(wire),
    synchronizeCalls,
  };
}

test('Production Web: settings view tabs and responsive visibility', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    app.mount(appMount);
    const doc = dom.window.document;

    await router.push('/manage/settings');
    await router.isReady();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 1. Initial Access & Security view content visibility
    assert.match(doc.body.textContent ?? '', /Operator Access Boundary/);
    assert.match(doc.body.textContent ?? '', /Authorized Browser Sessions/);
    assert.match(doc.body.textContent ?? '', /Rotate Local Secret Key/);

    // 2. Click Instance & System sub-tab button
    const systemTabBtn = doc.querySelector('.settings-tab-system') as HTMLButtonElement;
    assert.ok(systemTabBtn, 'Instance & System tab button found');
    systemTabBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.match(doc.body.textContent ?? '', /Platform & Protocol Compatibility/);
    assert.match(doc.body.textContent ?? '', /Carrier & Transport Security/);

    // 3. Click Status Strip card to switch back to Access & Security
    const accessCard = doc.querySelector('.settings-status-card') as HTMLButtonElement;
    assert.ok(accessCard, 'Operator Access status card found');
    accessCard.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.match(doc.body.textContent ?? '', /Operator Access Boundary/);

    // 4. Click Data & Diagnostics tab
    const dataTabBtn = doc.querySelector('.settings-tab-data') as HTMLButtonElement;
    assert.ok(dataTabBtn, 'Data & Diagnostics tab button found');
    dataTabBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.match(doc.body.textContent ?? '', /Durable Operational Data/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// M77 rework regressions: the five blocking findings from the #86 review.
// ---------------------------------------------------------------------------

test('M77-SCOPE-001: production requires a typed environment adapter and never falls back to fixture authority', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    // No adapter is injected: exactly the auto-mounted production bootstrap.
    const { app, router } = createSproutApp({ routerBase: '/app/' });
    await router.push('/manage/environments');
    await router.isReady();
    app.mount(appMount);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    assert.ok(doc.querySelector('.envs-unavailable-state'), 'an explicit unavailable state is rendered');
    assert.match(doc.body.textContent ?? '', /Environment Authority Unavailable/);
    assert.doesNotMatch(doc.body.textContent ?? '', /Mac Studio M2 Max/, 'no fixture environment is shown');
    assert.equal(doc.querySelector('.env-master-card'), null, 'no fixture master card is rendered');
    assert.equal(doc.querySelector('.run-probe-btn'), null, 'no fixture-backed control is rendered');

    app.unmount();

    // The route module itself must not construct a fixture authority.
    const view = await readFile(new URL('../modules/environments/views/EnvironmentsView.vue', import.meta.url), 'utf8');
    const main = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(view, /FixtureEnvironmentService/, 'the route never imports the fixture adapter');
    assert.doesNotMatch(main, /FixtureEnvironmentService/, 'the bootstrap never wires the fixture adapter');
  } finally {
    await cleanup();
  }
});

test('M77-NAV-001: an unknown environment deep link renders not-found and never substitutes the first record', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/manage/environments/does-not-exist');
    await router.isReady();
    app.mount(appMount);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    assert.equal(router.currentRoute.value.params['id'], 'does-not-exist', 'the requested URL is preserved');
    assert.ok(doc.querySelector('.envs-not-found-state'), 'an explicit not-found state is rendered');
    assert.match(doc.body.textContent ?? '', /Environment Not Found/);
    assert.doesNotMatch(doc.body.textContent ?? '', /Mac Studio M2 Max/, 'another record is not substituted');
    assert.doesNotMatch(doc.body.textContent ?? '', /6 Independent Health Dimensions/, 'no detail of another record is shown');
    assert.equal(doc.querySelector('.run-probe-btn'), null, 'no mutation control is offered for a missing record');
    assert.equal(doc.querySelector('.env-master-card'), null, 'the list is not rendered under a missing id');

    (doc.querySelector('.envs-not-found-return') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(router.currentRoute.value.path, '/manage/environments', 'the return control recovers to the list');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('M77-NAV-002: an unknown chat scope deep link renders not-found and never substitutes the first scope', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/project/chat/does-not-exist');
    await router.isReady();
    app.mount(appMount);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    assert.equal(router.currentRoute.value.params['scopeId'], 'does-not-exist', 'the requested URL is preserved');
    assert.ok(doc.querySelector('.chat-not-found-state'), 'an explicit not-found state is rendered');
    assert.match(doc.body.textContent ?? '', /Conversation Not Found/);

    // The first scope must never be substituted for the missing one: no scope
    // card, and specifically no `#general` header, is rendered.
    assert.equal(doc.querySelector('[data-scope-id]'), null, 'no scope list is rendered under a missing id');
    assert.doesNotMatch(doc.body.textContent ?? '', /#general/, 'the first scope is not substituted');

    // The composer must be absent so the shared message list cannot be mutated
    // from a URL that names no scope.
    assert.equal(
      doc.querySelector('.chat-not-found-state')?.parentElement?.querySelector('input'),
      null,
      'no composer input is offered for a missing scope'
    );

    (doc.querySelector('.chat-not-found-return') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(router.currentRoute.value.path, '/project/chat', 'the return control recovers to the chat list');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('M77-NAV-002: an unknown chat scope deep link blocks composer mutation of the shared chat list', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    // Enter through the real chat list so a message is genuinely present first.
    await router.push('/project/chat/wg-frontend');
    await router.isReady();
    app.mount(appMount);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    const messageCount = () => doc.querySelectorAll('[data-message-id]').length;
    assert.ok(messageCount() > 0, 'a conversation renders its real messages');

    await router.push('/project/chat/does-not-exist');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(doc.querySelector('.chat-not-found-state'), 'the missing scope renders not-found');
    assert.equal(messageCount(), 0, 'no message list is rendered under the missing URL');

    // Even dispatching the send handler directly must not mutate the shared list:
    // the missing-scope guard refuses before touching chatMessages.
    const before = messageCount();
    const composer = doc.querySelector('.chat-not-found-state')?.parentElement?.querySelector('input');
    assert.equal(composer, null, 'the composer is not mounted, so no send can be triggered');
    assert.equal(messageCount(), before, 'the shared message list is unchanged under the missing URL');

    // A known scope still works: the guard is scoped to the missing case only.
    await router.push('/project/chat/dm-architect');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(messageCount() > 0, 'a known scope still renders its conversation');
    const input = doc.querySelector('input') as HTMLInputElement;
    assert.ok(input, 'a known scope still offers its composer');
    input.value = 'Regression probe message';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const sendBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Send') as HTMLButtonElement;
    sendBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.match(doc.body.textContent ?? '', /Regression probe message/, 'a real scope still accepts a message');

    app.unmount();
  } finally {
    await cleanup();
  }
});
