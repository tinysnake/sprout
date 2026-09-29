import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ProjectEnvironmentAccessView } from '../adapters/project-api.js';

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
  const projectsModule = (await vite.ssrLoadModule('/src/modules/projects/adapters/fixture-adapter.ts')) as typeof import('../modules/projects/adapters/fixture-adapter.ts');
  const environmentService = new module.FixtureEnvironmentService();
  const agentService = new agentsModule.FixtureAgentService();
  return {
    routerBase: '/app/',
    environmentService,
    agentService,
    projectService: new projectsModule.FixtureProjectService(agentService, environmentService),
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
    assert.equal(filterPills.length, 6, '6 discrete health filter buttons rendered, including Revoked');

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

test('Project Overview loads authority states and completes create-to-ready-to-archive safely', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const projectsViewSource = await readFile(new URL('../modules/projects/views/ProjectsView.vue', import.meta.url), 'utf8');
    const appBootstrapSource = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(projectsViewSource, /FixtureProjectService|fixture-adapter/);
    assert.doesNotMatch(appBootstrapSource, /FixtureProjectService|fixture-adapter/);
    const options = await deterministicAppOptions(vite);
    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    const onlineState = { status: 'online' as const, connection: 'online' as const, loading: false };
    const { app, router } = createSproutApp({
      ...options,
      connectionSource: {
        state: () => onlineState,
        subscribeState(listener) { listener(onlineState); return () => undefined; },
      },
    });
    await router.push('/project/overview');
    await router.isReady();
    app.mount(appMount);
    const doc = dom.window.document;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
    const pageState = () => (doc.querySelector('.projects-overview-view [data-state]') as HTMLElement | null)?.dataset.state;
    await settle();

    const overview = doc.querySelector('.projects-overview-view') as HTMLElement;
    assert.ok(overview);
    assert.equal(pageState(), 'ready', 'the selected fixture Project is ready');
    assert.match(doc.body.textContent ?? '', /Project Contract & Purpose/);
    assert.match(doc.body.textContent ?? '', /Project Memberships/);
    assert.match(doc.body.textContent ?? '', /Bound Workspaces & Host Environments/);
    assert.doesNotMatch(doc.body.textContent ?? '', /(?:\/Users\/|[A-Z]:\\Users\\|192\.168\.|api[_-]?key\s*[:=])/i);
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 390 });
    assert.match((doc.querySelector('.project-workspaces-card') as HTMLElement).className, /project-workspaces-card/);
    assert.match((doc.querySelector('.project-memberships-card button') as HTMLButtonElement).className, /min-h-\[44px\]/);
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1280 });
    assert.match((doc.querySelector('.project-contract-card') as HTMLElement).className, /xl:col-span-2/);

    // Project selection is retained in the route and an incomplete identity is
    // never substituted with the ready Project.
    const selector = doc.querySelector('#project-selector') as HTMLSelectElement;
    selector.value = 'project-incomplete';
    selector.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    assert.equal(pageState(), 'incomplete', 'selected resource-incomplete Project is explicit');
    assert.match(doc.body.textContent ?? '', /Add or restore an active Agent/);
    assert.match(doc.body.textContent ?? '', /Grant Environment access and assign a Project workspace/);

    // Create identity as a valid incomplete Project, with keyboard-reachable
    // focus trapped by the accessible dialog and touch-sized controls.
    const createButton = doc.querySelector('.new-project-btn') as HTMLButtonElement;
    assert.match(createButton.className, /min-h-\[44px\]/);
    const infoButton = doc.querySelector('.project-info-btn') as HTMLButtonElement;
    infoButton.click();
    await settle();
    const infoDialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    assert.equal(infoDialog.contains(doc.activeElement), true, 'metadata dialog is keyboard reachable');
    (doc.activeElement as HTMLElement).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal(doc.querySelector('[role="dialog"]'), null, 'Escape closes the metadata dialog');
    createButton.click();
    await settle();
    const dialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    assert.ok(dialog);
    assert.equal(dialog.contains(doc.activeElement), true, 'dialog opening places focus inside the dialog');
    const nameInput = dialog.querySelector('.project-name-input') as HTMLInputElement;
    nameInput.value = 'New Work Project';
    nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle();
    const createConfirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Create Project')) as HTMLButtonElement;
    assert.equal(createConfirm.disabled, false, `new Project submit should be enabled (name field: ${nameInput.value})`);
    createConfirm.click();
    await settle();
    assert.match(doc.body.textContent ?? '', /New Work Project/);
    assert.equal(pageState(), 'incomplete', 'created identity remains valid while incomplete');
    // The blank goal/rules fields were submitted as explicit empties, so the
    // created Project does not silently restore the template's goal guidance
    // and suggested rules (F4).
    assert.match(doc.body.textContent ?? '', /No explicit goal defined\./);
    assert.match(doc.body.textContent ?? '', /Project Rules \(0\)/);
    assert.equal(new URL(router.currentRoute.value.fullPath, 'http://sprout-operator.test').searchParams.get('project')?.startsWith('project-fixture-'), true);

    // Assign an Environment workspace via the access authority, then add an
    // Agent membership. The UI only displays the Worker-relative path.
    (doc.querySelector('.project-workspaces-card button') as HTMLButtonElement).click();
    await settle();
    const accessDialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    const selects = accessDialog.querySelectorAll('select');
    assert.equal((selects[0] as HTMLSelectElement).querySelector('option')?.value, 'inst-ready');
    (selects[0] as HTMLSelectElement).value = 'inst-ready';
    (selects[0] as HTMLSelectElement).dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    (selects[1] as HTMLSelectElement).value = 'relative';
    (selects[1] as HTMLSelectElement).dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    const pathInput = accessDialog.querySelector('input') as HTMLInputElement;
    pathInput.value = 'repos/new-work-project';
    pathInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    [...accessDialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Grant Access'))?.click();
    await settle();
    assert.match(doc.body.textContent ?? '', /repos\/new-work-project/);
    assert.match(doc.querySelector('.project-workspaces-card')?.textContent ?? '', /Mac Studio M2 Max/);
    assert.equal([...doc.querySelectorAll('.project-workspaces-card select option')].some((option) => option.getAttribute('value') === 'env-ready'), false);
    assert.doesNotMatch(doc.body.textContent ?? '', /(?:\/Users\/|[A-Z]:\\Users\\)/i);

    (doc.querySelector('.project-memberships-card button') as HTMLButtonElement).click();
    await settle();
    const memberDialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    const memberSelect = memberDialog.querySelector('select') as HTMLSelectElement;
    memberSelect.value = 'programmer';
    memberSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    [...memberDialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Add Agent Member'))?.click();
    await settle();
    assert.equal(pageState(), 'ready', 'Agent membership and Environment workspace satisfy prerequisites');
    assert.match(doc.body.textContent ?? '', /Task-begin prerequisites met/);

    (doc.querySelector('[aria-label="Edit Programmer membership"]') as HTMLButtonElement).click();
    await settle();
    const memberEdit = doc.querySelector('[role="dialog"]') as HTMLElement;
    const memberFields = memberEdit.querySelectorAll('input, textarea');
    (memberFields[0] as HTMLInputElement).value = 'Review changes, own verification';
    (memberFields[0] as HTMLInputElement).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    (memberFields[1] as HTMLTextAreaElement).value = 'Check each claim against evidence.';
    (memberFields[1] as HTMLTextAreaElement).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    [...memberEdit.querySelectorAll('button')].find((button) => button.textContent?.includes('Save Membership'))?.click();
    await settle();
    assert.match(doc.body.textContent ?? '', /Check each claim against evidence/);

    (doc.querySelector('[aria-label="End Programmer membership"]') as HTMLButtonElement).click();
    await settle();
    const endMembershipDialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    [...endMembershipDialog.querySelectorAll('button')].find((button) => button.textContent?.includes('End Membership'))?.click();
    await settle();
    assert.equal(pageState(), 'incomplete', 'ended Agent membership removes a begin prerequisite');
    [...doc.querySelectorAll('.project-memberships-card button')].find((button) => button.textContent?.includes('Restore'))?.click();
    await settle();
    assert.equal(pageState(), 'ready', 'restoring membership restores the prerequisite');

    [...doc.querySelectorAll('.project-workspaces-card button')].find((button) => button.textContent?.includes('Change workspace'))?.click();
    await settle();
    const workspaceDialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    const workspacePathField = workspaceDialog.querySelector('input') as HTMLInputElement;
    workspacePathField.value = 'repos/workspace-v2';
    workspacePathField.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    [...workspaceDialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Change Workspace'))?.click();
    await settle();
    assert.match(doc.body.textContent ?? '', /repos\/workspace-v2/);
    assert.match(doc.body.textContent ?? '', /Workspace binding history \(2\)/);

    // Editing identity/content/wake policy is one versioned write. Archive and
    // restore preserve the assigned workspace rather than deleting it.
    [...doc.querySelectorAll('.project-contract-card button')].find((button) => button.textContent?.includes('Edit Project'))?.click();
    await settle();
    const editDialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    const editName = editDialog.querySelector('.project-name-input') as HTMLInputElement;
    editName.value = 'Renamed Work Project';
    editName.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const policySelect = editDialog.querySelector('.project-wake-policy') as HTMLSelectElement;
    policySelect.value = 'wake-model-assisted';
    policySelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const guidance = editDialog.querySelector('.project-completion-guidance-input') as HTMLTextAreaElement;
    guidance.value = 'Accept only when the validation evidence is reproducible.';
    guidance.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const interval = editDialog.querySelector('.project-routing-interval-input') as HTMLInputElement;
    interval.value = '75';
    interval.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    [...editDialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Save Project'))?.click();
    await settle();
    assert.match(doc.body.textContent ?? '', /Renamed Work Project/);
    assert.match(doc.body.textContent ?? '', /Wake-model-assisted/);
    assert.match(doc.body.textContent ?? '', /Accept only when the validation evidence is reproducible/);
    assert.match(doc.body.textContent ?? '', /75s bounded window/);

    const archiveButton = [...doc.querySelectorAll('.project-contract-card button')].find((button) => button.textContent?.includes('Archive Project')) as HTMLButtonElement;
    archiveButton.click();
    await settle();
    const archiveDialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    assert.match(archiveDialog.textContent ?? '', /Renamed Work Project/, 'archive confirmation identifies the exact Project');
    const archiveConfirm = [...archiveDialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Archive Project')) as HTMLButtonElement;
    const archiveNameInput = archiveDialog.querySelector('input') as HTMLInputElement | null;
    assert.ok(archiveNameInput, 'archive confirmation requires typing the Project name');
    assert.equal(archiveConfirm.disabled, true, 'archive is disabled until the exact name is entered');
    archiveNameInput.value = 'Renamed Work';
    archiveNameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle();
    assert.equal(archiveConfirm.disabled, true, 'a partial Project name does not authorize archival');
    archiveNameInput.value = 'Renamed Work Project';
    archiveNameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle();
    assert.equal(archiveConfirm.disabled, false, 'the exact Project name enables archival');
    archiveConfirm.click();
    await settle();
    assert.equal(pageState(), 'archived', 'archive state is distinct');
    assert.match(doc.body.textContent ?? '', /repos\/new-work-project/);
    [...doc.querySelectorAll('.project-contract-card button')].find((button) => button.textContent?.includes('Restore Project'))?.click();
    await settle();
    const restoreDialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    [...restoreDialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore Project'))?.click();
    await settle();
    assert.equal(pageState(), 'ready', 'restore re-enables the same resources');
    assert.match(doc.body.textContent ?? '', /Workspace binding history/);
    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Project Overview hides project identity details in the zero-Project header', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  let app: { unmount(): void } | undefined;
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const options = await deterministicAppOptions(vite);
    const projectsModule = (await vite.ssrLoadModule('/src/modules/projects/adapters/fixture-adapter.ts')) as typeof import('../modules/projects/adapters/fixture-adapter.ts');
    const projectService = new projectsModule.FixtureProjectService(options.agentService, options.environmentService, []);
    const doc = dom.window.document;
    doc.body.innerHTML = '<div id="app"></div>';
    dom.window.history.replaceState(null, '', '/app/project/overview');
    const mounted = createSproutApp({ routerBase: '/app/', projectService });
    app = mounted.app;
    await mounted.router.push('/project/overview');
    await mounted.router.isReady();
    app.mount(doc.getElementById('app')!);
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(doc.querySelector('.projects-overview-view [data-state]')?.getAttribute('data-state'), 'empty');
    const header = doc.querySelector('.projects-overview-view header') as HTMLElement;
    assert.ok(header);
    assert.equal(header.querySelector('#project-selector'), null, 'no empty Project selector is rendered');
    assert.doesNotMatch(header.textContent ?? '', /Project authority/, 'no fallback Project label is shown as if it were a selected identity');
    assert.ok(header.querySelector('.new-project-btn'), 'the deliberate create action remains available');
  } finally {
    app?.unmount();
    await cleanup();
  }
});

test('Add Agent explains the exhausted choice set without rendering an empty selector', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  let app: { unmount(): void } | undefined;
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const options = await deterministicAppOptions(vite);
    const projectsModule = (await vite.ssrLoadModule('/src/modules/projects/adapters/fixture-adapter.ts')) as typeof import('../modules/projects/adapters/fixture-adapter.ts');
    const projectService = new projectsModule.FixtureProjectService(options.agentService, options.environmentService);
    const activeAgents = (await options.agentService.listAgents()).filter((agent) => agent.status === 'active');
    for (const agent of activeAgents) {
      await projectService.addProjectMembership('project-sprout', { agentId: agent.id });
    }
    const doc = dom.window.document;
    doc.body.innerHTML = '<div id="app"></div>';
    dom.window.history.replaceState(null, '', '/app/project/overview');
    const mounted = createSproutApp({ routerBase: '/app/', projectService });
    app = mounted.app;
    await mounted.router.push('/project/overview');
    await mounted.router.isReady();
    app.mount(doc.getElementById('app')!);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    await settle();

    (doc.querySelector('.project-memberships-card button') as HTMLButtonElement).click();
    await settle();
    const dialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    assert.match(dialog.textContent ?? '', /Every active Agent is already a member, or no active Agent exists/);
    assert.equal(dialog.querySelector('select'), null, 'no dead empty Agent control accompanies the explanation');
    assert.doesNotMatch(dialog.textContent ?? '', /Responsibilities/,
      'the pointless Responsibilities field is hidden with the selector when no Agent can be added');
    assert.doesNotMatch(dialog.textContent ?? '', /Collaboration Instructions/,
      'the pointless Collaboration Instructions field is hidden with the selector when no Agent can be added');
    assert.equal([...dialog.querySelectorAll('button')].some((button) => button.textContent?.includes('Add Agent Member')), false,
      'no add action is offered when the choice set is exhausted');
  } finally {
    app?.unmount();
    await cleanup();
  }
});

test('Add Environment refreshes access and omits an already-assigned instance from choices', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  let app: { unmount(): void } | undefined;
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const options = await deterministicAppOptions(vite);
    const projectsModule = (await vite.ssrLoadModule('/src/modules/projects/adapters/fixture-adapter.ts')) as typeof import('../modules/projects/adapters/fixture-adapter.ts');
    const base = new projectsModule.FixtureProjectService(options.agentService, options.environmentService);
    const readyEnvironment = (await options.environmentService.listEnvironments()).find((environment) => environment.environmentInstanceId === 'inst-ready');
    assert.ok(readyEnvironment);
    assert.notEqual(readyEnvironment.id, readyEnvironment.environmentInstanceId, 'enrollment and instance identities remain distinct');
    let overviewReads = 0;
    const projectService = new Proxy(base, {
      get(target, property) {
        if (property === 'loadOverview') {
          return async (id: string) => {
            const snapshot = await target.loadOverview(id);
            // Simulate the page's initial snapshot predating an access grant by
            // another authorized action; opening the dialog must refresh it.
            if (overviewReads++ === 0) return { ...snapshot, access: [] };
            return snapshot;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const doc = dom.window.document;
    doc.body.innerHTML = '<div id="app"></div>';
    dom.window.history.replaceState(null, '', '/app/project/overview');
    const mounted = createSproutApp({ routerBase: '/app/', projectService });
    app = mounted.app;
    await mounted.router.push('/project/overview');
    await mounted.router.isReady();
    app.mount(doc.getElementById('app')!);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    await settle();

    (doc.querySelector('.project-workspaces-card button') as HTMLButtonElement).click();
    await settle();
    const dialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    const environmentSelect = dialog.querySelector('select') as HTMLSelectElement;
    assert.ok(environmentSelect, 'available Environment choices remain selectable');
    assert.ok(environmentSelect.options.length > 0);
    assert.equal([...environmentSelect.options].some((option) => option.value === readyEnvironment.environmentInstanceId), false,
      'an instance with active access is excluded even though its enrollment id differs');
  } finally {
    app?.unmount();
    await cleanup();
  }
});

test('Project Overview degrades an unlistable access row, ends it by its stored identifier, and keeps granted Environments out of the choices', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  let app: { unmount(): void } | undefined;
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const options = await deterministicAppOptions(vite);
    const projectsModule = (await vite.ssrLoadModule('/src/modules/projects/adapters/fixture-adapter.ts')) as typeof import('../modules/projects/adapters/fixture-adapter.ts');
    const base = new projectsModule.FixtureProjectService(options.agentService, options.environmentService);
    // What the access authority can hand the page (#94 H4): one active row
    // stored under the listed Environment's *enrollment* identity (the other
    // identifier space), and one legacy row whose stored identifier matches
    // nothing in the current Environments list.
    const binding = { bindingId: 'binding-legacy', workspaceId: 'workspace-legacy', kind: 'default', boundAt: 900 } as const;
    const legacyAccess: readonly ProjectEnvironmentAccessView[] = [
      { projectId: 'project-sprout', environmentInstanceId: 'env-ready', status: 'active', startedAt: 1_000, updatedAt: 1_000, current: binding, history: [binding] },
      { projectId: 'project-sprout', environmentInstanceId: 'mac-mini-1', status: 'active', startedAt: 900, updatedAt: 900, current: binding, history: [binding] },
    ];
    const endedIdentifiers: string[] = [];
    const projectService = new Proxy(base, {
      get(target, property) {
        if (property === 'loadOverview') {
          return async (id: string) => ({ ...(await target.loadOverview(id)), access: legacyAccess });
        }
        if (property === 'endProjectAccess') {
          return (id: string, environmentInstanceId: string) => {
            endedIdentifiers.push(environmentInstanceId);
            const row = legacyAccess.find((entry) => entry.environmentInstanceId === environmentInstanceId);
            if (row === undefined) return Promise.reject(new Error('unknown access row'));
            return Promise.resolve({ ...row, status: 'ended' });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const doc = dom.window.document;
    doc.body.innerHTML = '<div id="app"></div>';
    dom.window.history.replaceState(null, '', '/app/project/overview');
    const mounted = createSproutApp({ routerBase: '/app/', projectService });
    app = mounted.app;
    await mounted.router.push('/project/overview');
    await mounted.router.isReady();
    app.mount(doc.getElementById('app')!);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    await settle();

    // Add-flow filter first: the Environment granted under the enrollment
    // identity is recognized as assigned across both identifier spaces and is
    // absent from the add choices, while other approved Environments remain
    // offered. Opening the dialog runs the stale-data refresh from the
    // previous fix, so this also proves the refresh cooperates with the filter.
    const assignButton = [...doc.querySelectorAll('.project-workspaces-card button')].find((button) => button.textContent?.includes('Assign Environment')) as HTMLButtonElement;
    assert.ok(assignButton, 'the assign action remains available for the unassigned Environments');
    assert.equal(assignButton.disabled, false, 'unassigned approved Environments keep the assign action usable');
    assignButton.click();
    await settle();
    const addDialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    const environmentSelect = addDialog.querySelector('select') as HTMLSelectElement;
    assert.ok(environmentSelect, 'other approved Environments remain selectable');
    const optionValues = [...environmentSelect.options].map((option) => option.value);
    assert.ok(optionValues.length > 0, 'the choice set is not empty');
    assert.equal(optionValues.includes('inst-ready'), false,
      'the granted Environment is absent from the add choices across both identifier spaces');
    [...addDialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Cancel'))?.click();
    await settle();

    const cards = () => [...doc.querySelectorAll('.project-workspaces-card .space-y-2 > div')] as HTMLElement[];
    const cardWith = (name: string) => cards().find((card) => card.querySelector('strong')?.textContent === name);

    // Display: a row stored under the enrollment identity resolves to the
    // listed Environment's name, and a row that resolves to nothing degrades
    // to a harmless display label — never to a raw identifier presented as a
    // name, and never to a value that later drives an action.
    const resolvedCard = cardWith('Mac Studio M2 Max');
    assert.ok(resolvedCard, 'a row stored under the other identifier space resolves to the listed Environment name');
    const legacyCard = cardWith('unknown-environment');
    assert.ok(legacyCard, 'an access row that resolves to no listed Environment degrades to the harmless display label');
    assert.doesNotMatch(legacyCard.textContent ?? '', /mac-mini-1/, 'the raw stored identifier is not presented as an Environment name');

    // Removal issues the access row's own stored identifier — what the server
    // matches on — not a display label and not a resolved value.
    const endButton = legacyCard.querySelector('button[aria-label^="End access"]') as HTMLButtonElement;
    assert.ok(endButton, 'the degraded row still exposes its removal action');
    endButton.click();
    await settle();
    const confirmDialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    [...confirmDialog.querySelectorAll('button')].find((button) => button.textContent?.includes('End Access'))?.click();
    await settle();
    assert.deepEqual(endedIdentifiers, ['mac-mini-1'], "the end action carries the access row's own stored identifier");
  } finally {
    app?.unmount();
    await cleanup();
  }
});

test('Project creation submits selected memberships and default workspaces as one authority command', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  let app: { unmount(): void } | undefined;
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const options = await deterministicAppOptions(vite);
    const projectsModule = (await vite.ssrLoadModule('/src/modules/projects/adapters/fixture-adapter.ts')) as typeof import('../modules/projects/adapters/fixture-adapter.ts');
    const base = new projectsModule.FixtureProjectService(options.agentService, options.environmentService, []);
    const submissions: Parameters<typeof base.createProject>[0][] = [];
    let laterMembershipWrites = 0;
    let laterWorkspaceWrites = 0;
    const service = new Proxy(base, {
      get(target, property) {
        if (property === 'createProject') {
          return async (input: Parameters<typeof base.createProject>[0]) => {
            submissions.push(input);
            return target.createProject(input);
          };
        }
        if (property === 'addProjectMembership') return (...args: Parameters<typeof base.addProjectMembership>) => {
          laterMembershipWrites += 1;
          return target.addProjectMembership(...args);
        };
        if (property === 'grantProjectAccess') return (...args: Parameters<typeof base.grantProjectAccess>) => {
          laterWorkspaceWrites += 1;
          return target.grantProjectAccess(...args);
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const doc = dom.window.document;
    doc.body.innerHTML = '<div id="app"></div>';
    dom.window.history.replaceState(null, '', '/app/project/overview');
    const mounted = createSproutApp({ routerBase: '/app/', projectService: service });
    app = mounted.app;
    await mounted.router.push('/project/overview');
    await mounted.router.isReady();
    app.mount(doc.getElementById('app')!);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    await settle();

    (doc.querySelector('.new-project-btn') as HTMLButtonElement).click();
    await settle();
    const dialog = doc.querySelector('[role="dialog"]') as HTMLElement;
    const name = dialog.querySelector('.project-name-input') as HTMLInputElement;
    name.value = 'Ready at creation';
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    for (const value of ['programmer', 'inst-ready']) {
      const checkbox = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.value === value);
      assert.ok(checkbox, `creation option ${value} is available`);
      checkbox.checked = true;
      checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
    await settle();
    const workspaceKind = dialog.querySelector('.project-create-workspace-kind') as HTMLSelectElement;
    workspaceKind.value = 'relative';
    workspaceKind.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    const workspacePath = dialog.querySelector('.project-create-workspace-path') as HTMLInputElement;
    workspacePath.value = 'repos/selected-project';
    workspacePath.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle();
    const submit = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Create Project')) as HTMLButtonElement;
    assert.ok(submit, 'creation dialog exposes its submit action');
    assert.equal(submit.disabled, false, `creation submit is enabled: ${doc.body.textContent}`);
    submit.click();
    await settle();

    assert.equal(submissions.length, 1);
    // Blank fields are explicit empties in the submission: authority must not
    // interpret them as absent and restore template content (F4).
    assert.equal(submissions[0]?.goal, '');
    assert.deepEqual(submissions[0]?.rules, []);
    assert.deepEqual(submissions[0]?.agentMemberships, [{ agentId: 'programmer' }]);
    assert.deepEqual(submissions[0]?.environmentAssignments, [{
      environmentInstanceId: 'inst-ready',
      workspace: { kind: 'relative', path: 'repos/selected-project' },
    }]);
    assert.equal(laterMembershipWrites, 0);
    assert.equal(laterWorkspaceWrites, 0);
    assert.match(doc.body.textContent ?? '', /Task-begin prerequisites met/);
    assert.match(doc.body.textContent ?? '', /repos\/selected-project/);
    assert.match(doc.querySelector('.project-workspaces-card')?.textContent ?? '', /Mac Studio M2 Max/,
      'the access row resolves to its approved Environment, not the raw instance id');
    (doc.querySelector('.project-workspaces-card button') as HTMLButtonElement).click();
    await settle();
    assert.equal([...doc.querySelectorAll('[role="dialog"] select option')].some((option) => option.getAttribute('value') === 'inst-ready'), false,
      'the already assigned instance cannot be granted twice under its enrollment identity');
  } finally {
    app?.unmount();
    await cleanup();
  }
});

test('Project Overview distinguishes unavailable, empty, failed, and unconfirmed compatibility states', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const doc = dom.window.document;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    const mountAtProject = async (options: Parameters<typeof createSproutApp>[0] = {}) => {
      doc.body.innerHTML = '<div id="app"></div>';
      dom.window.history.replaceState(null, '', '/app/project/overview');
      const { app, router } = createSproutApp({ routerBase: '/app/', ...options });
      await router.push('/project/overview');
      await router.isReady();
      app.mount(doc.getElementById('app')!);
      await settle();
      return app;
    };

    const unavailable = await mountAtProject();
    assert.equal((doc.querySelector('.projects-overview-view [data-state]') as HTMLElement).dataset.state, 'unavailable');
    assert.doesNotMatch(doc.body.textContent ?? '', /Sprout M2 Operator/);
    unavailable.unmount();

    const options = await deterministicAppOptions(vite);
    const projectsModule = (await vite.ssrLoadModule('/src/modules/projects/adapters/fixture-adapter.ts')) as typeof import('../modules/projects/adapters/fixture-adapter.ts');
    const emptyService = new projectsModule.FixtureProjectService(options.agentService, options.environmentService, []);
    const empty = await mountAtProject({ ...options, projectService: emptyService });
    assert.equal((doc.querySelector('.projects-overview-view [data-state]') as HTMLElement).dataset.state, 'empty');
    assert.match(doc.body.textContent ?? '', /No Projects yet/);
    empty.unmount();

    class FailedProjectService extends projectsModule.FixtureProjectService {
      override async listProjects() { throw new Error('private adapter diagnostic'); }
    }
    const failedService = new FailedProjectService(options.agentService, options.environmentService, []);
    const failed = await mountAtProject({ ...options, projectService: failedService });
    assert.equal((doc.querySelector('.projects-overview-view [data-state]') as HTMLElement).dataset.state, 'failure');
    assert.match(doc.body.textContent ?? '', /Project authority is unreachable/);
    assert.doesNotMatch(doc.body.textContent ?? '', /private adapter diagnostic/);
    failed.unmount();

    class IncompatibleAgentService extends (await vite.ssrLoadModule('/src/modules/agents/adapters/fixture-adapter.ts') as typeof import('../modules/agents/adapters/fixture-adapter.ts')).FixtureAgentService {
      override async compatibilityForEnvironment() {
        return { environmentAvailable: false, unavailableReason: 'No available work option on this Environment.' };
      }
    }
    const incompatibleAgents = new IncompatibleAgentService();
    const warningService = new projectsModule.FixtureProjectService(incompatibleAgents, options.environmentService);
    const warning = await mountAtProject({ ...options, agentService: incompatibleAgents, projectService: warningService });
    assert.equal((doc.querySelector('.projects-overview-view [data-state]') as HTMLElement).dataset.state, 'warning');
    assert.match(doc.body.textContent ?? '', /Compatibility needs attention/);
    warning.unmount();
  } finally {
    await cleanup();
  }
});

test('Project Environment notices use the same severity treatment as Environment readiness', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('./main.ts');
    const environmentModule = (await vite.ssrLoadModule('/src/modules/environments/adapters/fixture-adapter.ts')) as typeof import('../modules/environments/adapters/fixture-adapter.ts');
    const agentsModule = (await vite.ssrLoadModule('/src/modules/agents/adapters/fixture-adapter.ts')) as typeof import('../modules/agents/adapters/fixture-adapter.ts');
    const projectsModule = (await vite.ssrLoadModule('/src/modules/projects/adapters/fixture-adapter.ts')) as typeof import('../modules/projects/adapters/fixture-adapter.ts');
    const doc = dom.window.document;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    const environments = await new environmentModule.FixtureEnvironmentService().listEnvironments();
    const readyEnvironment = environments.find((environment) => environment.id === 'env-ready');
    assert.ok(readyEnvironment, 'the Project fixture access resolves to an approved Environment');

    const cases = [
      {
        severity: 'green' as const,
        reason: 'Environment readiness is confirmed.',
        variantClass: 'bg-[var(--green-ready-bg)]',
      },
      {
        severity: 'yellow' as const,
        reason: 'Engine "agy" is unknown.',
        variantClass: 'bg-[var(--yellow-attention-bg)]',
      },
      {
        severity: 'red' as const,
        reason: 'Environment readiness failed.',
        variantClass: 'bg-[var(--red-action-bg)]',
      },
    ];

    for (const { severity, reason, variantClass } of cases) {
      doc.body.innerHTML = '<div id="app"></div>';
      dom.window.history.replaceState(null, '', '/app/project/overview');
      const environmentService = new environmentModule.FixtureEnvironmentService(environments.map((environment) =>
        environment.id === readyEnvironment.id
          ? { ...environment, trafficLight: severity, trafficLightReason: reason }
          : environment,
      ));
      const agentService = new agentsModule.FixtureAgentService();
      const projectService = new projectsModule.FixtureProjectService(agentService, environmentService);
      const { app, router } = createSproutApp({
        routerBase: '/app/',
        environmentService,
        agentService,
        projectService,
      });
      await router.push('/project/overview');
      await router.isReady();
      app.mount(doc.getElementById('app')!);
      await settle();

      try {
        const notice = [...doc.querySelectorAll('.project-workspaces-card span')]
          .find((element) => element.textContent?.trim() === reason);
        assert.ok(notice, `the original readiness notice is preserved: ${reason}`);
        assert.ok(notice.className.includes(variantClass), `${severity} readiness uses ${variantClass}`);
      } finally {
        app.unmount();
      }
    }
  } finally {
    await cleanup();
  }
});
