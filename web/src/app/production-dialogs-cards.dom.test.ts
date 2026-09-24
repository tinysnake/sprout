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
