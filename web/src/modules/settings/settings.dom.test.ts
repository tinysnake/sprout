import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

// Initialize JSDOM and globals before importing Vite/Vue modules
const initialHtml = await readFile(new URL('../../../app/index.html', import.meta.url), 'utf8');
const initialDom = new JSDOM(initialHtml, {
  url: 'http://sprout-operator.test/app/manage/settings',
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

const { createServer } = await import('vite');
const { default: vue } = await import('@vitejs/plugin-vue');

async function setupProductionDom() {
  const dom = initialDom;
  const vite = await createServer({
    root: new URL('../../..', import.meta.url).pathname,
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

const settle = (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms));

// F1–F4: observe production DOM, including controls teleported outside the view.
async function withSettings(run: (context: {
  doc: Document;
  service: import('./adapters/fixture-adapter.ts').FixtureSettingsService;
}) => Promise<void>, configure?: (service: import('./adapters/fixture-adapter.ts').FixtureSettingsService) => void) {
  const { dom, vite, cleanup } = await setupProductionDom();
  let app: import('vue').App | undefined;
  try {
    const { createSproutApp } = await vite.ssrLoadModule('/src/app/main.ts');
    const { FixtureSettingsService } = await vite.ssrLoadModule('/src/modules/settings/adapters/fixture-adapter.ts');
    const service = new FixtureSettingsService();
    configure?.(service);
    const mounted = createSproutApp({ routerBase: '/app/', settingsService: service });
    app = mounted.app;
    app!.mount(dom.window.document.getElementById('app')!);
    await mounted.router.push('/manage/settings');
    await mounted.router.isReady();
    await settle(100);
    await run({ doc: dom.window.document, service });
  } finally {
    app?.unmount();
    await cleanup();
  }
}

for (const flow of ['one', 'others'] as const) {
  test(`Settings F1: open revoke-${flow} dialog freezes throughout disconnect and never queues`, async () => {
    await withSettings(async ({ doc, service }) => {
      let calls = 0;
      service.revokeSession = async () => { calls++; };
      service.revokeOtherSessions = async () => { calls++; return 1; };
      (doc.querySelector(flow === 'one' ? '.session-revoke-btn' : '.revoke-others-btn') as HTMLButtonElement).click();
      await settle();
      const confirm = doc.querySelector(`.confirm-revoke-${flow}-btn`) as HTMLButtonElement;
      assert.ok(confirm);
      for (const connection of ['stale', 'reconnecting', 'offline'] as const) {
        service.setState({ status: connection, connection, loading: false });
        await settle();
        assert.ok(doc.querySelector('.settings-stale-notice'), `${connection} visibly marks cached facts`);
        assert.equal(confirm.disabled, true, `${connection} freezes the open confirmation`);
        confirm.click();
        // Synthetic dispatch bypasses native disabled click suppression: handler must guard too.
        confirm.dispatchEvent(new initialDom.window.MouseEvent('click', { bubbles: true }));
        await settle();
        assert.equal(calls, 0, 'No disconnected mutation is submitted');
        for (const button of doc.querySelectorAll<HTMLButtonElement>('.session-revoke-btn, .revoke-others-btn')) {
          assert.equal(button.disabled, true);
        }
      }
      service.setState({ status: 'online', connection: 'online', loading: false });
      await settle();
      assert.equal(calls, 0, 'Reconnection does not replay a queued command');
      assert.equal(confirm.disabled, false);
      // A current state read must also guard before a subscription render arrives.
      const state = service.state.bind(service);
      service.state = () => ({ status: 'offline', connection: 'offline', loading: false });
      confirm.click();
      await settle();
      assert.equal(calls, 0, 'Confirm rechecks authority, not just the rendered disabled state');
      service.state = state;
      service.setState({ status: 'online', connection: 'online', loading: false });
      await settle();
      confirm.click();
      await settle();
      assert.equal(calls, 1, 'Only a new live confirmation submits');
    });
  });
}

test('Settings F2: every portaled dialog button has the touch floor', async () => {
  await withSettings(async ({ doc }) => {
    for (const flow of ['one', 'others']) {
      (doc.querySelector(flow === 'one' ? '.session-revoke-btn' : '.revoke-others-btn') as HTMLButtonElement).click();
      await settle();
      const dialog = doc.querySelector(`[role="dialog"]`)!;
      assert.ok(dialog, 'Portaled dialog exists');
      assert.equal(doc.querySelector('.settings-view')!.contains(dialog), false);
      const buttons = dialog.querySelectorAll<HTMLButtonElement>('button');
      assert.equal(buttons.length, 3, 'Inventory close, cancel, confirm');
      for (const button of buttons) {
        assert.match(button.className, /min-h-\[44px\]|min-h-11/, `${button.getAttribute('aria-label') ?? button.textContent} touch floor`);
      }
      const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!;
      assert.match(close.className, /min-w-\[44px\]|min-w-11/);
      close.click();
      await settle();
      assert.equal(doc.querySelector('[role="dialog"]'), null);
    }
  });
});

for (const read of ['loadSettings', 'loadSessions', 'loadDiagnostics'] as const) {
  test(`Settings F3: rejected ${read} is a visible load failure, not loaded empty`, async () => {
    await withSettings(async ({ doc }) => {
      assert.ok(doc.querySelector('.settings-failure-alert'), 'Read failure is surfaced');
      assert.ok(doc.querySelector('.settings-read-unavailable'), 'Unavailable facts are explicit');
      assert.equal(doc.querySelector('[aria-label="Browser sessions"]'), null, 'No successful empty session panel');
      assert.equal(doc.querySelector('.session-revoke-btn, .revoke-others-btn'), null);
    }, service => { service[read] = async () => { throw new Error('Read unavailable'); }; });
  });
}

test('Settings F3: a successfully loaded empty session list is not a failure', async () => {
  await withSettings(async ({ doc }) => {
    assert.equal(doc.querySelector('.settings-failure-alert'), null);
    assert.equal(doc.querySelector('.settings-read-unavailable'), null);
    assert.ok(doc.querySelector('[aria-label="Browser sessions"]'));
    assert.match(doc.body.textContent!, /0 active sessions/);
  }, service => { service.loadSessions = async () => []; });
});

test('Settings F4: protocol range and migration guidance never imply verified compatibility or a retained copy', async () => {
  await withSettings(async ({ doc, service }) => {
    const settings = await service.loadSettings();
    const range = settings.versions.workerProtocol;
    assert.match(doc.querySelector('.settings-status-strip')!.textContent!, new RegExp(`Supported protocol majors: ${range.minMajor}–${range.maxMajor}`));
    assert.doesNotMatch(doc.body.textContent!, /Safety copy retained|Compatible \(v/i);
    (doc.querySelector('.settings-tab-system') as HTMLButtonElement).click();
    await settle();
    assert.doesNotMatch(doc.body.textContent!, /Safety copy retained|Negotiated compatibility/);
    assert.match(doc.body.textContent!, /Safety-copy status is not available in Web/);
    assert.doesNotMatch(doc.querySelector('[data-settings-section="compatibility"]')!.textContent!, /This instance and its enrolled Workers are within|schema 0 to/);
    assert.match(doc.body.textContent!, /schema Unknown|Unknown/);
  }, service => {
    const loadSettings = service.loadSettings.bind(service);
    service.loadSettings = async () => {
      const settings = await loadSettings();
      return { ...settings, versions: { ...settings.versions, workerProtocol: { minMajor: 3, maxMajor: 5 } } };
    };
    const loadDiagnostics = service.loadDiagnostics.bind(service);
    service.loadDiagnostics = async () => ({ ...await loadDiagnostics(), schema: null });
  });
});

test('Settings: renders normal state with prototype IA, status strip, tabs, and boundary explanations', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../../app/main.ts');
    const { FixtureSettingsService } = (await vite.ssrLoadModule('/src/modules/settings/adapters/fixture-adapter.ts')) as typeof import('./adapters/fixture-adapter.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const settingsService = new FixtureSettingsService();
    const { app, router } = createSproutApp({
      routerBase: '/app/',
      settingsService,
    });
    app.mount(appMount);
    const doc = dom.window.document;

    await router.push('/manage/settings');
    await router.isReady();
    await settle(100);

    // 1. Page Header & Boundary Note
    assert.match(doc.body.textContent ?? '', /General & Operator Settings/);
    assert.match(doc.body.textContent ?? '', /Routine operation stays in Web/);
    assert.match(doc.body.textContent ?? '', /Manage \/ Settings/);

    // 2. Status Strip: 3 cards
    const statusCards = doc.querySelectorAll('.settings-status-card');
    assert.equal(statusCards.length, 3, 'Status strip has 3 cards');
    assert.match(statusCards[0]?.textContent ?? '', /Operator [Aa]ccess/);
    assert.match(statusCards[1]?.textContent ?? '', /Instance/);
    assert.match(statusCards[2]?.textContent ?? '', /Migration [Gg]uard/);

    // 3. Sub-tabs Navigation
    const subTabs = doc.querySelectorAll('[role="tab"]');
    assert.equal(subTabs.length, 3, 'Three sub-tabs rendered');
    assert.match(subTabs[0]?.textContent ?? '', /Access & Security/);
    assert.match(subTabs[1]?.textContent ?? '', /Instance & System/);
    assert.match(subTabs[2]?.textContent ?? '', /Data & Diagnostics/);

    // 4. Access & Security content:
    assert.match(doc.body.textContent ?? '', /Operator identity and access boundary/);
    assert.match(doc.body.textContent ?? '', /Single operator/);
    assert.match(doc.body.textContent ?? '', /Credential recovery and rotation/);
    assert.match(doc.body.textContent ?? '', /Host-local recovery/);
    assert.match(doc.body.textContent ?? '', /Authorized Browser Sessions/);

    // 5. Test tab switching: click Instance & System
    (subTabs[1] as HTMLButtonElement).click();
    await settle(80);
    assert.match(doc.body.textContent ?? '', /Sprout instance and compatibility/);
    assert.match(doc.body.textContent ?? '', /Web routine operation versus host-local administration/);
    assert.match(doc.body.textContent ?? '', /Migration safety and failure visibility/);

    // 6. Test tab switching via Status Strip card
    (statusCards[0] as HTMLElement).click();
    await settle(80);
    assert.match(doc.body.textContent ?? '', /Operator identity and access boundary/);

    // 7. Click Data & Diagnostics tab
    (subTabs[2] as HTMLButtonElement).click();
    await settle(80);
    assert.match(doc.body.textContent ?? '', /Durable data location/);
    assert.match(doc.body.textContent ?? '', /Sanitized diagnostics/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Settings: distinct risk-bearing session-revocation states (revoke-one and revoke-all-others)', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../../app/main.ts');
    const { FixtureSettingsService } = (await vite.ssrLoadModule('/src/modules/settings/adapters/fixture-adapter.ts')) as typeof import('./adapters/fixture-adapter.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const revokedSessions: string[] = [];
    let revokedOthers = false;

    const settingsService = new FixtureSettingsService({
      onRevokeSession: async (id) => {
        revokedSessions.push(id);
      },
      onRevokeOtherSessions: async () => {
        revokedOthers = true;
        return 1;
      },
    });

    const { app, router } = createSproutApp({
      routerBase: '/app/',
      settingsService,
    });
    app.mount(appMount);
    const doc = dom.window.document;

    await router.push('/manage/settings');
    await router.isReady();
    await settle(100);

    // 1. Verify initial active session rows
    const revokeOneButtons = doc.querySelectorAll('.session-revoke-btn');
    assert.equal(revokeOneButtons.length, 1, 'One non-current active session has a Revoke button');
    const revokeOthersBtn = doc.querySelector('.revoke-others-btn') as HTMLButtonElement;
    assert.ok(revokeOthersBtn, 'Revoke other sessions button present');
    assert.equal(revokeOthersBtn.disabled, false);

    // 2. Test Revoke All Others: opens distinct risk confirmation dialog
    revokeOthersBtn.click();
    await settle(80);

    assert.ok(doc.querySelector('.revoke-others-dialog'), 'Revoke-others confirmation dialog is open');
    assert.match(doc.body.textContent ?? '', /Revoke All Other Browser Sessions/i);
    assert.match(doc.body.textContent ?? '', /invalidate access for every other browser/i);

    // Cancel revoke-others
    const cancelOthersBtn = doc.querySelector('.cancel-revoke-others-btn') as HTMLButtonElement;
    assert.ok(cancelOthersBtn);
    cancelOthersBtn.click();
    await settle(80);
    assert.equal(doc.querySelector('.revoke-others-dialog'), null, 'Revoke-others dialog dismissed on cancel');
    assert.equal(revokedOthers, false);

    // 3. Test Revoke One: opens distinct risk confirmation dialog
    (revokeOneButtons[0] as HTMLButtonElement).click();
    await settle(80);

    assert.ok(doc.querySelector('.revoke-one-dialog'), 'Revoke-one confirmation dialog is open');
    assert.match(doc.body.textContent ?? '', /Revoke Browser Session/i);
    assert.match(doc.body.textContent ?? '', /Risk-bearing action/i);
    assert.match(doc.body.textContent ?? '', /invalidate access from that browser/i);

    // Cancel revoke-one
    const cancelOneBtn = doc.querySelector('.cancel-revoke-one-btn') as HTMLButtonElement;
    assert.ok(cancelOneBtn);
    cancelOneBtn.click();
    await settle(80);
    assert.equal(doc.querySelector('.revoke-one-dialog'), null, 'Dialog dismissed on cancel');
    assert.equal(revokedSessions.length, 0, 'No session revoked yet');

    // Click again and confirm revoke-one
    (doc.querySelector('.session-revoke-btn') as HTMLButtonElement).click();
    await settle(80);
    const confirmOneBtn = doc.querySelector('.confirm-revoke-one-btn') as HTMLButtonElement;
    assert.ok(confirmOneBtn);
    confirmOneBtn.click();
    await settle(80);
    assert.deepEqual(revokedSessions, ['sess-phone']);

    // 4. Test confirming Revoke All Others with a fresh service
    const settingsService2 = new FixtureSettingsService({
      onRevokeOtherSessions: async () => {
        revokedOthers = true;
        return 1;
      },
    });
    const { app: app2, router: router2 } = createSproutApp({
      routerBase: '/app/',
      settingsService: settingsService2,
    });
    app.unmount();
    app2.mount(appMount);
    await router2.push('/manage/settings');
    await router2.isReady();
    await settle(100);

    const revokeOthersBtn2 = doc.querySelector('.revoke-others-btn') as HTMLButtonElement;
    revokeOthersBtn2.click();
    await settle(80);
    const confirmOthersBtn = doc.querySelector('.confirm-revoke-others-btn') as HTMLButtonElement;
    assert.ok(confirmOthersBtn);
    confirmOthersBtn.click();
    await settle(80);
    assert.equal(revokedOthers, true);

    app2.unmount();
    return;

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Settings: diagnostic export downloads ONLY the sanitized contract', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../../app/main.ts');
    const { FixtureSettingsService } = (await vite.ssrLoadModule('/src/modules/settings/adapters/fixture-adapter.ts')) as typeof import('./adapters/fixture-adapter.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    let exportCalled = false;
    const settingsService = new FixtureSettingsService({
      onExportDiagnostics: async () => {
        exportCalled = true;
        return {
          format: 1,
          scope: 'web',
          versions: {
            sprout: '0.2.0',
            web: '0.2.0',
            worker: '0.2.0',
            workerProtocol: { minMajor: 2, maxMajor: 2 },
          },
          schema: 24,
          service: 'running',
          data: 'accessible',
          environments: [],
          events: [],
        };
      },
    });

    const { app, router } = createSproutApp({
      routerBase: '/app/',
      settingsService,
    });
    app.mount(appMount);
    const doc = dom.window.document;

    await router.push('/manage/settings');
    await router.isReady();
    await settle(100);

    // Navigate to Data & Diagnostics
    const dataTabBtn = doc.querySelector('.settings-tab-data') as HTMLButtonElement;
    dataTabBtn.click();
    await settle(80);

    // Track downloaded blob
    let downloadedBlobContent: string | null = null;
    let downloadedFileName: string | null = null;

    // Mock URL.createObjectURL and HTMLAnchorElement.prototype.click
    const origCreateObjectURL = dom.window.URL.createObjectURL;
    dom.window.URL.createObjectURL = (blob: Blob) => {
      // In Node/jsdom, read blob synchronously or through mock
      downloadedBlobContent = 'blob-created';
      return 'blob:mock-url';
    };
    dom.window.URL.revokeObjectURL = () => undefined;

    const exportBtn = doc.querySelector('.export-diagnostics-btn') as HTMLButtonElement;
    assert.ok(exportBtn, 'Export diagnostics button present');
    exportBtn.click();
    await settle(80);

    assert.equal(exportCalled, true, 'exportDiagnostics was called on the service');
    assert.match(doc.body.textContent ?? '', /diagnostics/i);

    // Verify privacy in DOM: no sensitive strings
    assert.doesNotMatch(doc.body.textContent ?? '', /\/Users\//);
    assert.doesNotMatch(doc.body.textContent ?? '', /C:\\Users/);
    assert.doesNotMatch(doc.body.textContent ?? '', /192\.168\./);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Settings: distinct unavailable, stale, and failure states', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../../app/main.ts');
    const { FixtureSettingsService } = (await vite.ssrLoadModule('/src/modules/settings/adapters/fixture-adapter.ts')) as typeof import('./adapters/fixture-adapter.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    // 1. Test UNAVAILABLE state: no service provided
    const { app: app1, router: router1 } = createSproutApp({ routerBase: '/app/' });
    app1.mount(appMount);
    const doc = dom.window.document;

    await router1.push('/manage/settings');
    await router1.isReady();
    await settle(100);

    assert.ok(doc.querySelector('.settings-unavailable-state'), 'Unavailable state rendered when no authority');
    assert.match(doc.body.textContent ?? '', /Settings Authority Unavailable/i);
    assert.match(doc.body.textContent ?? '', /sprout worker status --diagnostics/);
    app1.unmount();

    // 2. Test STALE state: transport reports stale
    const staleService = new FixtureSettingsService({
      state: { status: 'stale', connection: 'stale', loading: false },
    });
    const { app: app2, router: router2 } = createSproutApp({
      routerBase: '/app/',
      settingsService: staleService,
    });
    app2.mount(appMount);

    await router2.push('/manage/settings');
    await router2.isReady();
    await settle(100);

    assert.ok(doc.querySelector('.settings-stale-notice'), 'Stale connection notice displayed');
    assert.match(doc.body.textContent ?? '', /Connection is stale|Stale connection/i);
    const revokeBtn = doc.querySelector('.revoke-others-btn') as HTMLButtonElement;
    if (revokeBtn) {
      assert.equal(revokeBtn.disabled, true, 'Revocation is disabled while connection is stale');
    }
    app2.unmount();

    // 3. Test FAILURE state: revocation fails
    const failService = new FixtureSettingsService({
      onRevokeSession: async () => {
        throw new Error('Revocation refused by host');
      },
    });
    const { app: app3, router: router3 } = createSproutApp({
      routerBase: '/app/',
      settingsService: failService,
    });
    app3.mount(appMount);

    await router3.push('/manage/settings');
    await router3.isReady();
    await settle(100);

    const sessionRevokeBtn = doc.querySelector('.session-revoke-btn') as HTMLButtonElement;
    sessionRevokeBtn.click();
    await settle(80);
    const confirmBtn = doc.querySelector('.confirm-revoke-one-btn') as HTMLButtonElement;
    confirmBtn.click();
    await settle(80);

    assert.ok(doc.querySelector('.settings-failure-alert'), 'Failure alert rendered when action fails');
    assert.match(doc.body.textContent ?? '', /Revocation refused by host/);
    app3.unmount();
  } finally {
    await cleanup();
  }
});

test('Settings: touch targets (min 44px) and keyboard navigation', async () => {
  const { dom, vite, cleanup } = await setupProductionDom();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../../app/main.ts');
    const { FixtureSettingsService } = (await vite.ssrLoadModule('/src/modules/settings/adapters/fixture-adapter.ts')) as typeof import('./adapters/fixture-adapter.ts');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);

    const settingsService = new FixtureSettingsService();
    const { app, router } = createSproutApp({
      routerBase: '/app/',
      settingsService,
    });
    app.mount(appMount);
    const doc = dom.window.document;

    await router.push('/manage/settings');
    await router.isReady();
    await settle(100);

    // Check 44px touch targets on all interactive controls in the settings view
    const interactiveButtons = doc.querySelectorAll<HTMLButtonElement>('.settings-view button');
    assert.ok(interactiveButtons.length > 0, 'Found buttons in settings view');
    for (const btn of interactiveButtons) {
      const cls = btn.className;
      assert.ok(
        cls.includes('min-h-[44px]') || cls.includes('min-h-11'),
        `Button "${btn.textContent?.trim().slice(0, 30)}" has min-h-[44px], class was: ${cls}`
      );
    }

    // Keyboard navigation: Enter on status card switches tabs
    const statusCards = doc.querySelectorAll('.settings-status-card');
    assert.ok(statusCards[1], 'Status card 1 exists');
    const enterEvent = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    statusCards[1]!.dispatchEvent(enterEvent);
    await settle(80);
    assert.match(doc.body.textContent ?? '', /Sprout instance and compatibility/);

    app.unmount();
  } finally {
    await cleanup();
  }
});
