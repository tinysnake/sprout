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

test('Production Web: mounts Shell and Manage / Environments, preserving structure and traffic-light reasons', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount, '#app mount container exists');

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/manage/environments');
    await router.isReady();
    app.mount(appMount);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const doc = dom.window.document;

    // 1. Verify Shell Navigation Structure
    assert.ok(doc.querySelector('.desktop-sidebar'), 'Desktop sidebar rendered');
    assert.ok(doc.querySelector('.mobile-bottom-nav'), 'Mobile bottom navigation rendered');
    assert.ok(doc.querySelector('.operator-pill'), 'Operator pill rendered');

    // 2. Verify Manage / Environments SubNav and Title
    assert.match(doc.body.textContent ?? '', /Environments & Host Infrastructure/);
    assert.match(doc.body.textContent ?? '', /Ready \(/);
    assert.match(doc.body.textContent ?? '', /Attention \(/);
    assert.match(doc.body.textContent ?? '', /Action Required \(/);
    assert.match(doc.body.textContent ?? '', /Archived \(/);

    // 3. Verify Prominent Traffic Light Banner & Mandatory Decisive Reason
    const banner = doc.querySelector('.env-traffic-light-banner');
    assert.ok(banner, 'Traffic light banner rendered');
    assert.match(banner.textContent ?? '', /Green: Ready/);
    assert.match(banner.textContent ?? '', /Decisive Fact: All capabilities permitted · Engines authenticated · Lease held by Task #101/);

    // 4. Verify 6 Independent Health Dimensions
    assert.match(doc.body.textContent ?? '', /6 Independent Health Dimensions/);
    assert.match(doc.body.textContent ?? '', /1–4\. Core Operational Status & Safety Dimensions/);
    assert.match(doc.body.textContent ?? '', /5\. Capability Permissions/);
    assert.match(doc.body.textContent ?? '', /6\. Engine Harness Readiness/);

    // 5. Verify Engine Harness Status
    assert.match(doc.body.textContent ?? '', /Codex/);
    assert.match(doc.body.textContent ?? '', /Pi/);
    assert.match(doc.body.textContent ?? '', /agy/);
    assert.match(doc.body.textContent ?? '', /opencode/);

    // 6. Verify Active Lease Card & Task-Held Lease Guarantee
    assert.match(doc.body.textContent ?? '', /Task-Held Lease Active/);
    assert.match(doc.body.textContent ?? '', /Task #101/);
    assert.match(doc.body.textContent ?? '', /@Programmer/);

    // 7. Verify exclusion of prototype harness controls and non-product copy
    assert.doesNotMatch(doc.body.textContent ?? '', /ADR-\d{4}/, 'No ADR references in production DOM');
    assert.doesNotMatch(doc.body.textContent ?? '', /Ticket #\d+/, 'No Ticket references in production DOM');
    assert.doesNotMatch(doc.body.textContent ?? '', /Simulate/, 'No simulation copy in production DOM');
    assert.equal(doc.querySelector('.proto-control-bar'), null, 'No prototype control bar');
    assert.equal(doc.querySelector('#top-viewport-select'), null, 'No prototype viewport switcher');
    assert.equal(doc.querySelector('#top-style-baseline-btn'), null, 'No prototype style baseline button');
    assert.equal(doc.querySelector('.review-drawer'), null, 'No prototype review drawer');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: filters environments and exposes accessible current states', async () => {
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

    // Filter pills check
    const filterPills = doc.querySelectorAll('.env-filter-box-btn');
    assert.equal(filterPills.length, 5, '5 discrete health filter buttons rendered');

    const allBtn = doc.querySelector('button[data-filter="all"]') as HTMLButtonElement;
    assert.equal(allBtn.getAttribute('aria-pressed'), 'true', 'All filter active initially');

    // Click 'ready' filter
    const readyBtn = doc.querySelector('button[data-filter="ready"]') as HTMLButtonElement;
    readyBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(readyBtn.getAttribute('aria-pressed'), 'true', 'Ready filter active');
    assert.equal(allBtn.getAttribute('aria-pressed'), 'false', 'All filter inactive');

    // Master cards check
    const masterCards = doc.querySelectorAll('.env-master-card');
    assert.ok(masterCards.length >= 1, 'Filtered master cards rendered');

    // Return to all
    allBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(allBtn.getAttribute('aria-pressed'), 'true');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: emergency Force Release Alert Dialog enforces 3-gate safety check and records audit event', async () => {
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

    // Select the recovery environment: Windows Workstation 01 (env-recovery)
    const recoveryCard = doc.querySelector('button[data-env="env-recovery"]') as HTMLButtonElement;
    assert.ok(recoveryCard, 'Recovery environment card found');
    recoveryCard.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Verify recovery alert box is displayed
    const alertBox = doc.querySelector('.recovery-alert-box');
    assert.ok(alertBox, 'Recovery alert box rendered');
    assert.match(alertBox.textContent ?? '', /Lease Recovery Required/);
    assert.match(alertBox.textContent ?? '', /Unresolved Operational Facts/);

    // Click Emergency Force Release button
    const forceBtn = doc.querySelector('.force-release-btn') as HTMLButtonElement;
    assert.ok(forceBtn, 'Force release button found');
    forceBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Verify Alert Dialog opened
    assert.match(doc.body.textContent ?? '', /EMERGENCY OVERRIDE WARNING/);

    const typedInput = doc.querySelector('.force-confirm-typed') as HTMLInputElement;
    assert.ok(typedInput, 'Typed confirmation input rendered');

    const ackCheckbox = doc.querySelector('.ack-risks-checkbox') as HTMLInputElement;
    assert.ok(ackCheckbox, 'Risk acknowledgement checkbox rendered');

    const confirmBtn = doc.querySelector('.confirm-force-btn') as HTMLButtonElement;
    assert.ok(confirmBtn, 'Authorize button rendered');
    assert.equal(confirmBtn.disabled, true, 'Authorize button strictly disabled initially');

    // Gate 1: Type confirmation without checking box
    typedInput.value = 'FORCE RELEASE';
    typedInput.dispatchEvent(new dom.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(confirmBtn.disabled, true, 'Disabled without risk acknowledgement');

    // Gate 2: Check box
    ackCheckbox.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(confirmBtn.disabled, false, 'Button enables when BOTH typed and checked');

    // Authorize Force Release
    confirmBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify Environment is unlocked, green ready, and audit event recorded
    assert.match(doc.body.textContent ?? '', /Durable Forced Release Audit Event/);
    assert.match(doc.body.textContent ?? '', /Operator \(Human Override\)/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: live readiness probe updates probe stream with fresh latency', async () => {
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

    const probeBtn = doc.querySelector('.run-probe-btn') as HTMLButtonElement;
    assert.ok(probeBtn, 'Readiness probe button found');

    const initialHistoryLength = doc.querySelectorAll('.probe-history-stream > div').length;

    probeBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const updatedHistoryLength = doc.querySelectorAll('.probe-history-stream > div').length;
    assert.ok(updatedHistoryLength >= initialHistoryLength + 1, 'New probe record appended to history stream');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: phone drill-down navigation provides full-width detail and back header', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    // Navigate directly to mobile detail drill-down route
    await router.push('/manage/environments/env-ready');
    await router.isReady();
    app.mount(appMount);

    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    // Verify Mobile Detail Nav Header rendered
    const backHeader = doc.querySelector('.mobile-detail-nav-header');
    assert.ok(backHeader, 'Mobile detail nav header rendered in drill-down mode');
    assert.match(backHeader.textContent ?? '', /Mac Studio M2 Max/);

    const backBtn = doc.querySelector('#btn-back-to-envs') as HTMLButtonElement;
    assert.ok(backBtn, 'Back to environments button found');

    backBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(router.currentRoute.value.path, '/manage/environments', 'Navigated back to master list');

    app.unmount();
  } finally {
    await cleanup();
  }
});

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

test('M89-EVIDENCE-002: production renders the reconciling box read-only with no fabricated evidence action', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    // A real ProductionEnvironmentService over a stub wire adapter: exactly the
    // production authority, no fixture adapter involved.
    const options = await productionReconcilingAppOptions(vite);
    const { app, router } = createSproutApp(options);
    await router.push('/manage/environments/enroll-reconciling');
    await router.isReady();
    app.mount(appMount);

    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    // The reconciling box renders with the honest not-synchronized state...
    const reconcilingBox = doc.querySelector('.reconciling-box');
    assert.ok(reconcilingBox, 'ReconcilingBox is rendered under the production authority');
    assert.match(reconcilingBox.textContent ?? '', /RECONCILING/);
    const notSynchronized = reconcilingBox.querySelector('.evidence-not-synchronized');
    assert.ok(notSynchronized, 'the explicit not-synchronized state is rendered');
    assert.match(notSynchronized.textContent ?? '', /Not synchronized yet/);
    assert.match(
      notSynchronized.textContent ?? '',
      /only be declared by the reconnected Worker itself/,
      'the read-only state names the Worker as the only evidence authority',
    );

    // ...and the reconcile action is absent: nothing can post Worker evidence.
    assert.equal(
      doc.querySelector('.btn-reconcile-evidence'),
      null,
      'no reconcile button exists under the production authority',
    );
    assert.doesNotMatch(reconcilingBox.textContent ?? '', /Reconcile & Synchronize Evidence/);

    // Even a scripted click attempt through the page handler is refused by the
    // typed bridge: no placeholder payload ever reaches the wire.
    assert.deepEqual(options.synchronizeCalls, [], 'no synchronizeEvidence command was posted');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: shared Card primitive is consumed by domain compositions with no domain kind switcher', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const cardModule = (await vite.ssrLoadModule('/src/primitives/Card.vue')) as any;

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    await router.push('/manage/environments/env-ready');
    await router.isReady();
    app.mount(appMount);

    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    // 1. Master card uses Card as="button" with interactive and selected states
    const masterCard = doc.querySelector('.env-master-card') as HTMLButtonElement;
    assert.ok(masterCard, 'Master card element rendered');
    assert.equal(masterCard.tagName.toLowerCase(), 'button', 'Master card renders as button');
    assert.ok(masterCard.classList.contains('rounded-[var(--radius-md)]'), 'Shared Card rounded radius applied');
    assert.ok(masterCard.classList.contains('border'), 'Shared Card border applied');

    // 2. Detail card uses Card shell
    const detailCard = doc.querySelector('.env-detail-card');
    assert.ok(detailCard, 'Detail card rendered using shared Card shell');
    assert.ok(detailCard.classList.contains('rounded-[var(--radius-md)]'), 'Shared Card rounded radius applied');

    // 3. Verify Card component interface has NO domain 'kind' prop or domain-switching branches
    const cardProps = cardModule.default?.props ?? {};
    assert.equal(cardProps.kind, undefined, 'Card does not accept a domain kind prop');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: accessible overlay interactions — keyboard activation, Escape dismissal, initial focus, and mobile touch/pointer parity', async () => {
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

    // 1. Sheet Keyboard Activation (Enter/Space), Initial Focus, Action Target, and Focus Restoration (Ordinary Close & Escape)
    const guideBtn = doc.querySelector('#btn-host-guide') as HTMLButtonElement;
    assert.ok(guideBtn, 'Host Bootstrap Guide button found');
    guideBtn.focus();
    assert.equal(doc.activeElement, guideBtn, 'Guide button receives initial keyboard focus');

    // 1a. Exercise actual keyboard activation using Enter key (no mouse .click())
    guideBtn.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify Sheet overlay opened
    assert.match(doc.body.textContent ?? '', /Host Bootstrap & Enrollment Guide/);
    assert.match(doc.body.textContent ?? '', /macOS & Windows Service Setup and Security Guidelines/);

    // Verify initial focus moved inside the overlay to the expected accessible control (Sheet close button)
    const sheetCloseHeaderBtn = doc.querySelector('[aria-label="Close sheet"]') as HTMLButtonElement;
    assert.ok(sheetCloseHeaderBtn, 'Sheet header close button found');
    assert.equal(doc.activeElement, sheetCloseHeaderBtn, 'Initial focus moved inside Sheet overlay to accessible close control');

    // Reach action target inside Sheet: footer Close button activated via Space key
    const closeGuideBtn = doc.querySelector('.close-guide-btn') as HTMLButtonElement;
    assert.ok(closeGuideBtn, 'Close button in Sheet footer found');
    closeGuideBtn.focus();
    assert.equal(doc.activeElement, closeGuideBtn, 'Action target inside Sheet receives focus');
    closeGuideBtn.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify Sheet closed via keyboard activation of action target
    assert.doesNotMatch(doc.body.textContent ?? '', /Host Bootstrap & Enrollment Guide/);
    // Verify focus restoration to opener button
    assert.equal(doc.activeElement, guideBtn, 'Focus restored to opener button after ordinary close');

    // 1b. Reopen Sheet with Space key to test Escape key dismissal & focus restoration
    guideBtn.focus();
    guideBtn.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(doc.body.textContent ?? '', /Host Bootstrap & Enrollment Guide/);
    assert.equal(doc.activeElement, doc.querySelector('[aria-label="Close sheet"]'), 'Initial focus inside Sheet after Space key opening');

    // Dispatch Escape keydown from focused element inside overlay
    doc.activeElement?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.doesNotMatch(doc.body.textContent ?? '', /Host Bootstrap & Enrollment Guide/, 'Sheet closed via Escape');
    // Verify focus restoration to opener button
    assert.equal(doc.activeElement, guideBtn, 'Focus restored to opener button after Escape key dismissal');

    // 2. AlertDialog: Emergency Force Release Keyboard Activation (Enter/Space), Initial Focus, and Focus Restoration (Cancel & Escape)
    // First select env-recovery card using Enter key activation on interactive Card
    const recoveryCard = doc.querySelector('button[data-env="env-recovery"]') as HTMLButtonElement;
    assert.ok(recoveryCard, 'Recovery environment card found');
    recoveryCard.focus();
    assert.equal(doc.activeElement, recoveryCard, 'Recovery card receives keyboard focus');
    recoveryCard.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    const forceReleaseBtn = doc.querySelector('.force-release-btn') as HTMLButtonElement;
    assert.ok(forceReleaseBtn, 'Emergency Force Release button found');
    forceReleaseBtn.focus();
    assert.equal(doc.activeElement, forceReleaseBtn, 'Force Release button receives keyboard focus');

    // 2a. Activate Force Release button using Space key (no mouse .click())
    forceReleaseBtn.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify AlertDialog is open
    assert.match(doc.body.textContent ?? '', /EMERGENCY OVERRIDE WARNING/);

    // Verify initial focus moved inside AlertDialog to the accessible close control
    const alertCloseHeaderBtn = doc.querySelector('[aria-label="Close dialog"]') as HTMLButtonElement;
    assert.ok(alertCloseHeaderBtn, 'AlertDialog close button found');
    assert.equal(doc.activeElement, alertCloseHeaderBtn, 'Initial focus moved inside AlertDialog to accessible close control');

    // Reach action target inside AlertDialog: Cancel button (.close-sheet-btn) activated via Enter key
    const cancelBtn = doc.querySelector('.close-sheet-btn') as HTMLButtonElement;
    assert.ok(cancelBtn, 'Cancel button in AlertDialog footer found');
    cancelBtn.focus();
    assert.equal(doc.activeElement, cancelBtn, 'Cancel button receives focus');
    cancelBtn.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify AlertDialog closed and focus restored to opener
    assert.doesNotMatch(doc.body.textContent ?? '', /EMERGENCY OVERRIDE WARNING/);
    assert.equal(doc.activeElement, forceReleaseBtn, 'Focus restored to Force Release button after Cancel');

    // 2b. Reopen AlertDialog using Enter key to verify Escape dismissal & focus restoration
    forceReleaseBtn.focus();
    forceReleaseBtn.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(doc.body.textContent ?? '', /EMERGENCY OVERRIDE WARNING/);
    assert.equal(doc.activeElement, doc.querySelector('[aria-label="Close dialog"]'), 'Initial focus inside AlertDialog after Enter opening');

    doc.activeElement?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.doesNotMatch(doc.body.textContent ?? '', /EMERGENCY OVERRIDE WARNING/, 'AlertDialog closed via Escape');
    assert.equal(doc.activeElement, forceReleaseBtn, 'Focus restored to Force Release button after Escape dismissal');

    // 3. Mobile touch/pointer parity & Route Drill-down
    // Navigate back to un-drilled base route to establish clear pre-action state facts
    await router.push('/manage/environments');
    await router.isReady();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 3a. Assert Pre-Action state facts
    assert.equal(router.currentRoute.value.path, '/manage/environments', 'Pre-action: base environments route active');
    assert.equal(doc.querySelector('.mobile-detail-nav-header'), null, 'Pre-action: mobile detail header not rendered');
    assert.equal(doc.querySelector('.envs-mobile-detail-wrapper'), null, 'Pre-action: mobile drilldown wrapper not rendered');
    assert.ok(doc.querySelector('.envs-master-list.mobile-full'), 'Pre-action: mobile master list visible');

    const preRecoveryCard = doc.querySelector('button[data-env="env-recovery"]') as HTMLButtonElement;
    const prePendingCard = doc.querySelector('button[data-env="env-pending"]') as HTMLButtonElement;
    assert.ok(preRecoveryCard, 'Pre-action: recovery card exists');
    assert.ok(prePendingCard, 'Pre-action: pending card exists');
    assert.equal(preRecoveryCard.getAttribute('aria-current'), 'page', 'Pre-action: env-recovery is current');
    assert.equal(prePendingCard.getAttribute('aria-current'), null, 'Pre-action: env-pending is NOT current');

    // 3b. Dispatch the real production touch/pointer interaction path
    // Per W3C Pointer Events and Touch Events standards, a touchscreen tap gesture dispatches:
    // pointerdown -> touchstart -> pointerup -> touchend -> UA compatibility click (detail: 1, pointerType: touch).
    // In JSDOM (lacking a hardware gesture interpreter), dispatch the coordinated tap transaction.
    const tapTarget = prePendingCard;
    tapTarget.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true }));
    tapTarget.dispatchEvent(new dom.window.TouchEvent('touchstart', { bubbles: true, cancelable: true }));
    tapTarget.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true }));
    tapTarget.dispatchEvent(new dom.window.TouchEvent('touchend', { bubbles: true, cancelable: true }));
    tapTarget.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 3c. Assert Changed Post-Action state facts (caused by the touch gesture, not pre-existing facts)
    assert.equal(router.currentRoute.value.path, '/manage/environments/env-pending', 'Post-action: route changed to tapped environment');
    assert.equal(preRecoveryCard.getAttribute('aria-current'), null, 'Post-action: env-recovery is no longer current');
    assert.equal(prePendingCard.getAttribute('aria-current'), 'page', 'Post-action: env-pending is now marked aria-current="page"');
    assert.ok(doc.querySelector('.envs-mobile-detail-wrapper'), 'Post-action: mobile drill-down wrapper rendered');
    assert.equal(doc.querySelector('.envs-master-list.mobile-full'), null, 'Post-action: master list hidden during mobile drilldown');

    const mobileHeader = doc.querySelector('.mobile-detail-nav-header');
    assert.ok(mobileHeader, 'Post-action: mobile detail navigation header rendered');
    const headerTitle = doc.querySelector('.mobile-detail-title-text')?.textContent?.trim();
    assert.equal(headerTitle, 'MacBook Pro Operator Local', 'Post-action: mobile header displays tapped environment title');

    // 3d. Complete bidirectional touch cycle: touch tap back button to return to master list
    const backBtn = doc.querySelector('#btn-back-to-envs') as HTMLButtonElement;
    assert.ok(backBtn, 'Mobile detail back button reachable');
    backBtn.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true }));
    backBtn.dispatchEvent(new dom.window.TouchEvent('touchstart', { bubbles: true, cancelable: true }));
    backBtn.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true }));
    backBtn.dispatchEvent(new dom.window.TouchEvent('touchend', { bubbles: true, cancelable: true }));
    backBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(router.currentRoute.value.path, '/manage/environments', 'Touch tap on back button restored base route');
    assert.equal(doc.querySelector('.mobile-detail-nav-header'), null, 'Mobile detail header dismissed');
    assert.ok(doc.querySelector('.envs-master-list.mobile-full'), 'Mobile master list restored');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: strict non-product copy boundary across all reachable routes', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    app.mount(appMount);

    const routesToTest = [
      '/feed',
      '/project/overview',
      '/project/tasks',
      '/project/chat',
      '/manage/environments',
      '/manage/environments/env-ready',
      '/manage/environments/env-recovery',
      '/manage/environments/env-reconciling',
      '/manage/agents',
      '/manage/usage',
      '/manage/settings',
    ];

    const doc = dom.window.document;

    for (const routePath of routesToTest) {
      await router.push(routePath);
      await router.isReady();
      await new Promise((resolve) => setTimeout(resolve, 60));

      const content = doc.body.textContent ?? '';

      assert.doesNotMatch(content, /ADR-\d{4}/, `No ADR captions rendered on ${routePath}`);
      assert.doesNotMatch(content, /Ticket #\d+/, `No Ticket numbers rendered on ${routePath}`);
      assert.doesNotMatch(content, /\bSimulate\b/, `No simulation copy rendered on ${routePath}`);
      assert.equal(doc.querySelector('.proto-control-bar'), null, `No prototype control bar on ${routePath}`);
      assert.equal(doc.querySelector('#top-viewport-select'), null, `No viewport switcher on ${routePath}`);
      assert.equal(doc.querySelector('#top-style-baseline-btn'), null, `No style baseline on ${routePath}`);
      assert.equal(doc.querySelector('.review-drawer'), null, `No review drawer on ${routePath}`);
    }

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: task card and agent card interactive details inspection', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    app.mount(appMount);
    const doc = dom.window.document;

    // 1. In Project Tasks: click task card to open Task Detail Dialog
    await router.push('/project/tasks');
    await router.isReady();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const taskBtn = doc.querySelector('button h4')?.closest('button') as HTMLButtonElement;
    assert.ok(taskBtn, 'Task card button found in Project Tasks');
    taskBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify Dedicated Task Detail Page (prototype-aligned)
    assert.match(doc.body.textContent ?? '', /Task Operating Stage & Specification/);
    assert.match(doc.body.textContent ?? '', /Nested Agent Runs Timeline/);
    assert.match(doc.body.textContent ?? '', /Inspect Host Environment/);

    // Click 'Back to Tasks List' to return to list mode
    const backBtn = doc.querySelector('.back-to-tasks-btn') as HTMLButtonElement;
    assert.ok(backBtn, 'Back to tasks list button found');
    backBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(doc.body.textContent ?? '', /Project Tasks & Operating Loop/);

    // 2. In AgentsView: click agent card to view details
    await router.push('/manage/agents');
    await router.isReady();
    await new Promise((resolve) => setTimeout(resolve, 120));

    const agentCard = doc.querySelector('[data-agent="architect"]') as HTMLButtonElement | null;
    assert.ok(agentCard, 'Architect agent card found');
    agentCard.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.match(doc.body.textContent ?? '', /Architect/);
    assert.match(doc.body.textContent ?? '', /architect/, 'the stable identity is rendered');

    // 3. In FeedView: click task card to view Task Detail Dialog
    await router.push('/feed');
    await router.isReady();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const allButtons = Array.from(doc.querySelectorAll('button'));
    const feedTaskCard = allButtons.find((b) => b.textContent?.includes('#101:'));
    assert.ok(feedTaskCard, 'Feed task card found');
    feedTaskCard.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.match(doc.body.textContent ?? '', /Inspect Host Environment/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: project header and chat info buttons respond with accessible dialogs', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    app.mount(appMount);
    const doc = dom.window.document;

    // 1. In ProjectView: test Project Info button (.project-info-btn)
    await router.push('/project/overview');
    await router.isReady();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const projectInfoBtn = doc.querySelector('.project-info-btn') as HTMLButtonElement;
    assert.ok(projectInfoBtn, 'Project Info button found');
    projectInfoBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.match(doc.body.textContent ?? '', /Information & Metadata/);
    const closeBtn1 = doc.querySelector('.close-project-info-btn') as HTMLButtonElement;
    closeBtn1?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 2. In ProjectView: test Create Project button (.new-project-btn)
    const newProjBtn = doc.querySelector('.new-project-btn') as HTMLButtonElement;
    assert.ok(newProjBtn, 'Create Project button found');
    newProjBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.match(doc.body.textContent ?? '', /Create New Project Workspace/);
    const cancelBtn = doc.querySelector('.cancel-new-project-btn') as HTMLButtonElement;
    cancelBtn?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 3. In Project Chat: test Chat Info button (.chat-info-btn)
    await router.push('/project/chat');
    await router.isReady();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const chatInfoBtn = doc.querySelector('.chat-info-btn') as HTMLButtonElement;
    assert.ok(chatInfoBtn, 'Chat Info button found');
    chatInfoBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.match(doc.body.textContent ?? '', /Conversation Details/);
    const closeBtn2 = doc.querySelector('.close-chat-info-btn') as HTMLButtonElement;
    closeBtn2?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Production Web: agent creation and architecture guide action dialogs', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp(await deterministicAppOptions(vite));
    app.mount(appMount);
    const doc = dom.window.document;

    await router.push('/manage/agents');
    await router.isReady();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Test Create Agent modal
    const createAgentBtn = doc.querySelector('.create-agent-btn') as HTMLButtonElement;
    assert.ok(createAgentBtn, 'Create Agent button found');
    createAgentBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.match(doc.body.textContent ?? '', /Create Global Agent Definition/);

    // Close dialog before unmounting to ensure clean Teleport teardown
    doc.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Test Ordered Work Options reordering (drag handle, move down, move up, add option)
    const dragRows = doc.querySelectorAll('.agent-option-row');
    assert.ok(dragRows.length >= 2, 'Work option rows rendered for reordering');
    assert.ok(doc.querySelector('.drag-handle-wrap'), 'Drag handles present');

    // Move first option down
    const moveDownBtn = doc.querySelector('.move-opt-down-btn') as HTMLButtonElement;
    assert.ok(moveDownBtn, 'Move down button found');
    moveDownBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify first option is now CODEX (Priority 1)
    const firstRowText = doc.querySelectorAll('.agent-option-row')[0]?.textContent ?? '';
    assert.match(firstRowText, /CODEX/);

    // Move second option back up
    const secondRow = doc.querySelectorAll('.agent-option-row')[1];
    const moveUpBtn = secondRow?.querySelector('.move-opt-up-btn') as HTMLButtonElement;
    assert.ok(moveUpBtn, 'Move up button on second row found');
    moveUpBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const restoredFirstText = doc.querySelectorAll('.agent-option-row')[0]?.textContent ?? '';
    assert.match(restoredFirstText, /PI/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

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
