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

test('M77-NAV-002: an unknown task detail deep link renders not-found and never substitutes a record', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/project/tasks/does-not-exist');
    await router.isReady();
    app.mount(appMount);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    assert.equal(router.currentRoute.value.params['taskId'], 'does-not-exist', 'the requested URL is preserved');
    assert.ok(doc.querySelector('.tasks-not-found-state'), 'an explicit not-found state is rendered');
    assert.match(doc.body.textContent ?? '', /Task Not Found/);
    assert.doesNotMatch(doc.body.textContent ?? '', /#101/, 'the first task is not substituted');
    assert.equal(doc.querySelector('.operating-stage-card'), null, 'no other task detail is shown');

    (doc.querySelector('.tasks-not-found-return') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(router.currentRoute.value.path, '/project/tasks', 'the return control recovers to the task list');
    assert.match(doc.body.textContent ?? '', /Project Tasks & Operating Loop/, 'the task list is restored');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('M77-CONN-001: environment controls are disabled and refuse mutation while the connection is unsettled', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const { createShellConnectionController } = (await vite.ssrLoadModule(
      '/src/shell/connection.ts'
    )) as typeof import('../shell/connection.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const controller = createShellConnectionController({ status: 'online', connection: 'online', loading: false });
    const { app, router } = createSproutApp({
      ...(await deterministicAppOptions(vite)),
      connectionSource: controller,
    });
    await router.push('/manage/environments/env-ready');
    await router.isReady();
    app.mount(appMount);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    const probe = () => doc.querySelector('.run-probe-btn') as HTMLButtonElement;
    assert.equal(probe().disabled, false, 'a settled connection allows control');
    const before = doc.querySelectorAll('.probe-history-stream > div').length;

    controller.set({ status: 'reconnecting', connection: 'reconnecting', loading: false });
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(probe().disabled, true, 'the probe control is disabled while reconnecting');
    for (const selector of ['.approve-enroll-btn', '.unbind-env-btn', '.quick-probe-btn']) {
      const control = doc.querySelector(selector) as HTMLButtonElement | null;
      if (control) assert.equal(control.disabled, true, `${selector} is disabled while reconnecting`);
    }
    const masterCard = doc.querySelector('.env-master-card') as HTMLButtonElement;
    assert.equal(masterCard.disabled, true, 'the interactive master card is disabled while reconnecting');

    // Clicking a disabled control neither mutates nor queues anything.
    probe().click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      doc.querySelectorAll('.probe-history-stream > div').length,
      before,
      'no probe was applied or queued while the connection was unsettled'
    );

    // The control returns immediately when the connection settles.
    controller.set({ status: 'online', connection: 'online', loading: false });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(probe().disabled, false, 'control returns with the connection');
    probe().click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(
      doc.querySelectorAll('.probe-history-stream > div').length > before,
      'a settled connection applies the control immediately'
    );

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('M77-PROJECT-001: Project Chat renders each scope from its typed discriminator and label', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/project/chat');
    await router.isReady();
    app.mount(appMount);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    const scope = (id: string) => doc.querySelector(`[data-scope-id="${id}"]`) as HTMLElement;
    const channel = scope('#general');
    const group = scope('wg-frontend');
    const direct = scope('dm-architect');
    assert.ok(channel && group && direct, 'every chat scope is rendered');

    assert.equal(channel.dataset['scopeKind'], 'channel');
    assert.equal(group.dataset['scopeKind'], 'working-group');
    assert.equal(direct.dataset['scopeKind'], 'direct-message');

    assert.match(channel.textContent ?? '', /Project channel/);
    assert.match(group.textContent ?? '', /Working group/);
    assert.match(direct.textContent ?? '', /Direct message/);

    // Distinct scopes resolve distinct icons; they were previously all agents.
    const iconOf = (el: HTMLElement) => el.querySelector('svg')?.innerHTML ?? '';
    assert.notEqual(iconOf(channel), iconOf(direct), 'a channel and a direct message render different icons');
    assert.notEqual(iconOf(group), iconOf(direct), 'a working group and a direct message render different icons');
    assert.notEqual(iconOf(channel), iconOf(group), 'a channel and a working group render different icons');
    assert.equal(iconOf(direct), iconOf(direct), 'the direct message icon is stable');

    app.unmount();
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// #89: archive/restore parity on phone drill-down, and the offline state.
// ---------------------------------------------------------------------------

test('M89-PARITY: phone drill-down exposes the same archive and restore capabilities as desktop', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    // A cold start on the phone detail route: the same capabilities must be
    // reachable without a desktop master/detail split. The degraded row is
    // approved with no lease and clear work safety, so archive is offered.
    await router.push('/manage/environments/env-degraded');
    await router.isReady();
    app.mount(appMount);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    assert.ok(doc.querySelector('.envs-mobile-detail-wrapper'), 'the phone detail view renders');
    const archiveBtn = doc.querySelector('.archive-env-btn') as HTMLButtonElement;
    assert.ok(archiveBtn, 'Archive Instance is offered on phone drill-down');
    archiveBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.match(doc.body.textContent ?? '', /Archived Instance/, 'the row becomes archived');
    const restoreBtn = doc.querySelector('.restore-env-btn') as HTMLButtonElement;
    assert.ok(restoreBtn, 'Restore Instance is offered on phone drill-down');
    restoreBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(doc.body.textContent ?? '', /Degraded/, 'restore returns the row to its valid enrollment');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('M89-STATE: an environment with a force-release audit is distinct from an ordinary held lease', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/manage/environments');
    await router.isReady();
    app.mount(appMount);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    // Drive the recovery row through the three-gate Force Release.
    const recoveryCard = doc.querySelector('button[data-env="env-recovery"]') as HTMLButtonElement;
    recoveryCard.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    (doc.querySelector('.force-release-btn') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const typedInput = doc.querySelector('.force-confirm-typed') as HTMLInputElement;
    typedInput.value = 'FORCE RELEASE';
    typedInput.dispatchEvent(new dom.window.Event('input'));
    (doc.querySelector('.ack-risks-checkbox') as HTMLInputElement).click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    (doc.querySelector('.confirm-force-btn') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const banner = doc.querySelector('.env-traffic-light-banner');
    assert.ok(banner);
    assert.match(banner.textContent ?? '', /Green: Ready/, 'the row returns to Green');
    assert.match(doc.body.textContent ?? '', /Durable Forced Release Audit Event/, 'the audit box renders');
    assert.equal(doc.querySelector('.recovery-alert-box'), null, 'the recovery box is gone');
    assert.equal(doc.querySelector('.active-lease-box'), null, 'no lease box masquerades as the audit');
    // The audit is distinguishable from an ordinary held lease (env-ready).
    assert.ok(doc.querySelector('.forced-release-audit-box'), 'the audit box is rendered');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('M89-STATE: a pasted deep link to an archived environment renders its archived detail', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/manage/environments/env-archived');
    await router.isReady();
    app.mount(appMount);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    const banner = doc.querySelector('.env-traffic-light-banner');
    assert.ok(banner);
    assert.match(banner.textContent ?? '', /Archived Instance/, 'the archived state renders its own banner title');
    assert.match(banner.textContent ?? '', /New work admission barred/, 'the archived decisive reason renders');
    assert.ok(doc.querySelector('.restore-env-btn'), 'Restore is the offered action');
    assert.equal(doc.querySelector('.archive-env-btn'), null, 'Archive is not offered twice');

    app.unmount();
  } finally {
    await cleanup();
  }
});
