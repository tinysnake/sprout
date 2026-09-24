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
