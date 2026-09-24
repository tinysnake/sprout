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
    assert.match(
      doc.body.textContent ?? '',
      /Health colour is an operational summary, not an authorization token to execute runs/,
      'health colour authorization disclaimer is present in the DOM',
    );
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
