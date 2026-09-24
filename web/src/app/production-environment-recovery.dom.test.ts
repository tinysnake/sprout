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

test('Production Web: approving pending enrollment updates status, connectivity, and traffic light', async () => {
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

    // Select pending environment: MacBook Pro Operator Local (env-pending)
    const pendingCard = doc.querySelector('button[data-env="env-pending"]') as HTMLButtonElement;
    assert.ok(pendingCard, 'Pending environment card found');
    pendingCard.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Verify initial pending status and yellow traffic light
    assert.match(doc.body.textContent ?? '', /Pending enrollment approval/);

    // Find and click Approve Enrollment button
    const approveBtn = doc.querySelector('.approve-enroll-btn') as HTMLButtonElement;
    assert.ok(approveBtn, 'Approve enrollment button found');
    approveBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify status changed to Approved and traffic light turns green
    assert.match(doc.body.textContent ?? '', /Green: Ready/);
    assert.match(doc.body.textContent ?? '', /Approved by operator/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: capability permission toggling and unbind workspace', async () => {
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

    // Select ready environment (env-ready)
    const guiBtn = doc.querySelector('button[data-cap="guiAutomation"]') as HTMLButtonElement;
    assert.ok(guiBtn, 'GUI Auto permission toggle button found');
    assert.match(guiBtn.textContent ?? '', /Granted/);

    // Click to toggle
    guiBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const updatedGuiBtn = doc.querySelector('button[data-cap="guiAutomation"]') as HTMLButtonElement;
    assert.match(updatedGuiBtn.textContent ?? '', /Refused/);

    // Unbind workspace
    const unbindBtn = doc.querySelector('.unbind-env-btn') as HTMLButtonElement;
    assert.ok(unbindBtn, 'Unbind workspace button found');
    unbindBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.match(doc.body.textContent ?? '', /No projects currently bound/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: deep-link return context banner preserves navigation history', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/feed');
    await router.isReady();
    app.mount(appMount);

    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    // On Feed view, click the attention card directly (clean clickable card with no redundant inspect button)
    const attentionCard = doc.querySelector('.feed-attention-card') as HTMLButtonElement;
    assert.ok(attentionCard, 'Attention card found on Feed view');
    attentionCard.click();

    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify Return Context banner is visible
    const returnBanner = doc.querySelector('.return-context-banner');
    assert.ok(returnBanner, 'Return context banner visible after deep-link');
    assert.match(returnBanner.textContent ?? '', /Back to Feed/);

    // Click return
    const returnBtn = doc.querySelector('#btn-pop-return') as HTMLButtonElement;
    assert.ok(returnBtn);
    returnBtn.click();

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(router.currentRoute.value.path, '/feed', 'Returned to Feed view');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: deterministic loading state and empty state rendered in EnvironmentsView', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const { FixtureEnvironmentService } = (await vite.ssrLoadModule(
      '/src/modules/environments/adapters/fixture-adapter.ts'
    )) as typeof import('../modules/environments/adapters/fixture-adapter.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    // 1. Test Loading State with deferred promise
    let resolveList: (val: any) => void = () => {};
    const deferredPromise = new Promise((resolve) => {
      resolveList = resolve;
    });

    class LoadingEnvironmentService extends FixtureEnvironmentService {
      override async listEnvironments() {
        return deferredPromise as any;
      }
    }

    const { app: loadingApp, router: loadingRouter } = createSproutApp({
      routerBase: '/app/',
      environmentService: new LoadingEnvironmentService(),
    });
    await loadingRouter.push('/manage/environments');
    await loadingRouter.isReady();
    loadingApp.mount(appMount);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const doc = dom.window.document;

    const loadingState = doc.querySelector('.envs-loading-state');
    assert.ok(loadingState, 'Loading state indicator rendered while query pending');
    assert.match(loadingState.textContent ?? '', /Loading Environments & Host States/);

    // Resolve deferred promise and unmount
    resolveList([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    loadingApp.unmount();

    // 2. Test Empty State with service returning zero environments
    class EmptyEnvironmentService extends FixtureEnvironmentService {
      override async listEnvironments() {
        return [];
      }
    }

    const { app: emptyApp, router: emptyRouter } = createSproutApp({
      routerBase: '/app/',
      environmentService: new EmptyEnvironmentService(),
    });
    await emptyRouter.push('/manage/environments');
    await emptyRouter.isReady();
    emptyApp.mount(appMount);

    await new Promise((resolve) => setTimeout(resolve, 60));
    const emptyState = doc.querySelector('.envs-empty-state');
    assert.ok(emptyState, 'Empty state rendered when no environments enrolled');
    assert.match(emptyState.textContent ?? '', /No Environments Enrolled/);
    assert.match(emptyState.textContent ?? '', /Register New Host/);

    emptyApp.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: reachable reconciling state presents ReconcilingBox and resolves to recovery decision with proof', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/manage/environments/env-reconciling');
    await router.isReady();
    app.mount(appMount);

    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    // Verify ReconcilingBox is rendered
    const reconcilingBox = doc.querySelector('.reconciling-box');
    assert.ok(reconcilingBox, 'ReconcilingBox is rendered for env-reconciling');
    assert.match(reconcilingBox.textContent ?? '', /Worker Reconnected · Reconciling Settlement Evidence/);
    assert.match(reconcilingBox.textContent ?? '', /RECONCILING/);

    // Verify independent health & recovery semantics: reconciling has NOT collapsed into recovery
    assert.equal(doc.querySelector('.recovery-alert-box'), null, 'RecoveryAlertBox is NOT rendered during reconciling');

    // Click 'Reconcile & Synchronize Evidence'
    const reconcileBtn = doc.querySelector('.btn-reconcile-evidence') as HTMLButtonElement;
    assert.ok(reconcileBtn, 'Reconcile evidence button found');
    reconcileBtn.click();

    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify ReconcilingBox is gone and RecoveryAlertBox is rendered with proof
    assert.equal(doc.querySelector('.reconciling-box'), null, 'ReconcilingBox dismissed after synchronization');
    const recoveryAlertBox = doc.querySelector('.recovery-alert-box');
    assert.ok(recoveryAlertBox, 'RecoveryAlertBox rendered after evidence synchronization');
    assert.match(
      recoveryAlertBox.textContent ?? '',
      /Reconciliation Proof: Retained 4 events, verified engine session stopped/
    );

    // Verify operator recovery actions are now available
    assert.ok(doc.querySelector('.btn-resume-recovery'), 'Resume action available');
    assert.ok(doc.querySelector('.btn-discard-recovery'), 'Discard action available');
    assert.ok(doc.querySelector('.force-release-btn'), 'Force release action available');

    app.unmount();
  } finally {
    await cleanup();
  }
});
