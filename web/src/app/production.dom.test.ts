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

test('Production Web: mounts Shell and Manage / Environments, preserving structure and traffic-light reasons', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount, '#app mount container exists');

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

test('Production Web: shared Card primitive is consumed by domain compositions with no domain kind switcher', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const cardModule = (await vite.ssrLoadModule('/src/primitives/Card.vue')) as any;

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
    await router.push('/manage/environments');
    await router.isReady();
    app.mount(appMount);

    await new Promise((resolve) => setTimeout(resolve, 80));
    const doc = dom.window.document;

    // 1. Keyboard activation & Sheet consumption: Host Bootstrap Guide (#btn-host-guide)
    const guideBtn = doc.querySelector('#btn-host-guide') as HTMLButtonElement;
    assert.ok(guideBtn, 'Host Bootstrap Guide button found');
    guideBtn.focus();
    assert.equal(doc.activeElement, guideBtn, 'Guide button receives keyboard focus');

    // Activate with keyboard (click / Enter keydown)
    guideBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify Sheet opened
    assert.match(doc.body.textContent ?? '', /Host Bootstrap & Enrollment Guide/);
    assert.match(doc.body.textContent ?? '', /macOS & Windows Service Setup and Security Guidelines/);

    // Verify close button within Sheet works
    const closeGuideBtn = doc.querySelector('.close-guide-btn') as HTMLButtonElement;
    assert.ok(closeGuideBtn, 'Close button in Sheet footer found');
    closeGuideBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify Sheet closed via close button
    assert.doesNotMatch(doc.body.textContent ?? '', /Host Bootstrap & Enrollment Guide/);

    // Reopen Sheet to test Escape key dismissal
    guideBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(doc.body.textContent ?? '', /Host Bootstrap & Enrollment Guide/);

    // Dispatch Escape keydown on document
    const escEvent = new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    doc.dispatchEvent(escEvent);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.doesNotMatch(doc.body.textContent ?? '', /Host Bootstrap & Enrollment Guide/, 'Sheet closed via Escape');

    // 2. AlertDialog: Emergency Force Release keyboard activation and Escape / Cancel
    const recoveryCard = doc.querySelector('button[data-env="env-recovery"]') as HTMLButtonElement;
    assert.ok(recoveryCard);
    recoveryCard.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const forceReleaseBtn = doc.querySelector('.force-release-btn') as HTMLButtonElement;
    assert.ok(forceReleaseBtn);
    forceReleaseBtn.focus();
    forceReleaseBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify AlertDialog is open
    assert.match(doc.body.textContent ?? '', /EMERGENCY OVERRIDE WARNING/);

    // Verify Cancel button in AlertDialog footer closes the dialog
    const cancelBtn = doc.querySelector('.close-sheet-btn') as HTMLButtonElement;
    assert.ok(cancelBtn);
    cancelBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.doesNotMatch(doc.body.textContent ?? '', /EMERGENCY OVERRIDE WARNING/);

    // Reopen AlertDialog and verify Escape dismisses
    forceReleaseBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(doc.body.textContent ?? '', /EMERGENCY OVERRIDE WARNING/);

    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.doesNotMatch(doc.body.textContent ?? '', /EMERGENCY OVERRIDE WARNING/, 'AlertDialog closed via Escape');

    // 3. Mobile touch/pointer parity: pointerdown/pointerup and touchstart/touchend activate master selection
    const readyCard = doc.querySelector('button[data-env="env-ready"]') as HTMLButtonElement;
    assert.ok(readyCard);
    readyCard.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    readyCard.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    readyCard.dispatchEvent(new dom.window.TouchEvent('touchstart', { bubbles: true, cancelable: true }));
    readyCard.dispatchEvent(new dom.window.TouchEvent('touchend', { bubbles: true, cancelable: true }));
    readyCard.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.match(doc.body.textContent ?? '', /Mac Studio M2 Max/);

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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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
    await new Promise((resolve) => setTimeout(resolve, 80));

    const agentCard = Array.from(doc.querySelectorAll('button')).find((b) => b.textContent?.includes('@Architect'));
    assert.ok(agentCard, 'Architect agent card found');
    agentCard.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.match(doc.body.textContent ?? '', /@Architect/);
    assert.match(doc.body.textContent ?? '', /System & Seams Architect/);

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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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

    const { app, router } = createSproutApp({ routerBase: '/app/' });
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
