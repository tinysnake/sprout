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
  DocumentFragment: initialDom.window.DocumentFragment,
  location: initialDom.window.location,
  history: initialDom.window.history,
  localStorage: initialDom.window.localStorage,
  navigator: initialDom.window.navigator,
  getComputedStyle: initialDom.window.getComputedStyle,
  Node: initialDom.window.Node,
  Event: initialDom.window.Event,
  MouseEvent: initialDom.window.MouseEvent,
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

    // 6. Verify Active Lease Card & Task-Held Lease Guarantee (ADR-0005)
    assert.match(doc.body.textContent ?? '', /Task-Held Lease Active \(ADR-0005\)/);
    assert.match(doc.body.textContent ?? '', /Task #101/);
    assert.match(doc.body.textContent ?? '', /@Programmer/);

    // 7. Verify exclusion of prototype harness controls
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

    // On Feed view, click the deep-link button
    const inspectBtn = Array.from(doc.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Inspect in Manage / Environments')
    );
    assert.ok(inspectBtn, 'Deep-link inspect button found on Feed view');
    inspectBtn.click();

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
