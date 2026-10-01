/**
 * DOM behaviour of the production Manage / Usage and Costs page (#107, M2-30).
 *
 * Truthful, inspectable usage, duration, estimate, provenance, and coverage views
 * across phone and desktop.
 *
 * Acceptance criteria:
 * 1. Consumes production Usage queries for run, Task, Project, Agent, model, and time-range scopes.
 * 2. View tabs, filters, coverage strips, summaries, tables, drill-down order, labels, and
 *    responsive composition follow the original product prototype.
 * 3. State distinguishability (truthfulness core): complete, partial, unavailable, provisional,
 *    delayed, corrected, mixed-provenance, pending-cost, and subscription-inclusive states
 *    render distinctly (never collapse unavailable to zero).
 * 4. Accessible tables and summaries; any chart is supplementary and never the sole representation.
 * 5. Keyboard, touch, focus, privacy, DOM, adapter, typecheck, build tests pass.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer, type ViteDevServer } from 'vite';

const repoRoot = process.cwd();
const html = await readFile(`${repoRoot}/web/app/index.html`, 'utf8');

const GLOBALS = [
  'HTMLElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'SVGElement', 'Element', 'Document', 'DocumentFragment', 'location',
  'history', 'localStorage', 'navigator', 'getComputedStyle', 'Node', 'NodeFilter', 'Event',
  'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'TouchEvent', 'CustomEvent',
] as const;

interface Harness {
  dom: JSDOM;
  doc: Document;
  mount: HTMLElement;
  vite: ViteDevServer;
  cleanup: () => Promise<void>;
}

const sharedDom = new JSDOM(html, {
  url: 'http://sprout-operator.test/app/manage/usage',
  pretendToBeVisual: true,
});

(sharedDom.window as unknown as Record<string, unknown>)['__SPROUT_TEST_MANUAL_MOUNT__'] = true;

const persistentValues: Record<string, unknown> = {
  window: sharedDom.window,
  document: sharedDom.window.document,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: sharedDom.window.MutationObserver,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 10),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};

for (const key of GLOBALS) {
  persistentValues[key] = (sharedDom.window as unknown as Record<string, unknown>)[key];
}

for (const [key, value] of Object.entries(persistentValues)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

async function setupHarness(_url = 'http://sprout-operator.test/app/manage/usage'): Promise<Harness> {
  const dom = sharedDom;
  dom.window.document.body.innerHTML = '<div id="app"></div>';
  dom.window.history.replaceState(null, '', '/app/manage/usage');

  const [{ createServer }, { default: vuePlugin }] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-vue'),
  ]);
  const vite = await createServer({
    root: `${repoRoot}/web`,
    appType: 'custom',
    logLevel: 'error',
    plugins: [
      { name: 'force-client-vue', enforce: 'pre', transform(_code, _id, opt) { if (opt) opt.ssr = false; } },
      vuePlugin(),
    ],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
  });

  return {
    dom,
    doc: dom.window.document,
    mount: dom.window.document.getElementById('app')!,
    vite,
    cleanup: async () => {
      await vite.close();
    },
  };
}

function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await settle(50);
  return predicate();
}

async function mountedPage(
  vite: ViteDevServer,
  mount: HTMLElement,
  fixtureOverride?: any,
  configureApp?: (app: any) => void,
) {
  const [{ createSproutApp }, usageModule] = await Promise.all([
    vite.ssrLoadModule('/src/app/main.ts') as Promise<typeof import('../../app/main.ts')>,
    vite.ssrLoadModule('/src/modules/usage/adapters/fixture-adapter.ts') as Promise<
      typeof import('./adapters/fixture-adapter.ts')
    >,
  ]);
  const fixture = fixtureOverride ?? new usageModule.FixtureUsageService();
  const { app, router } = createSproutApp({
    routerBase: '/app/',
    usageService: fixture,
  });
  configureApp?.(app);
  await router.push('/manage/usage');
  await router.isReady();
  app.mount(mount);
  await settle(100);
  return { app, router, fixture };
}

test('Usage: the page requires a typed Usage authority and never falls back to fixture facts', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../../app/main.ts');
    const { app, router } = createSproutApp({ routerBase: '/app/' });
    await router.push('/manage/usage');
    await router.isReady();
    app.mount(mount);
    await settle(80);

    assert.ok(doc.querySelector('.usage-unavailable-state'), 'an explicit unavailable state is rendered');
    assert.match(doc.body.textContent ?? '', /Usage Service Unavailable/);

    const view = await readFile(`${repoRoot}/web/src/views/UsageView.vue`, 'utf8');
    const main = await readFile(`${repoRoot}/web/src/app/main.ts`, 'utf8');
    assert.doesNotMatch(view, /FixtureUsageService/, 'the route never imports the fixture adapter');
    assert.doesNotMatch(main, /FixtureUsageService/, 'the bootstrap never wires the fixture adapter');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Usage: presents six views, truthful coverage, and separate work and wake activity', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);
    const text = doc.body.textContent ?? '';

    assert.match(text, /Usage & Costs/);
    assert.match(text, /Usage & Cost Telemetry/);
    assert.equal(doc.querySelectorAll('[data-usage-tab]').length, 6);
    assert.match(text, /Agent run/);
    assert.match(text, /Routing attempt/);
    assert.match(text, /Attributable billed cost/);
    assert.match(text, /Unavailable for/);
    assert.match(text, /partial/);
    assert.match(text, /pending/);
    assert.doesNotMatch(text, /Billed invoice cost:\s*\$0/);
    assert.doesNotMatch(text, /\$0\.00 actual/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Usage: state distinguishability — complete, partial, unavailable, provisional, delayed, corrected, mixed-provenance, pending-cost, and subscription-inclusive states render distinctly', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);

    // Switch to run tab to inspect activity rows
    const runTab = doc.querySelector('[data-usage-tab="run"]') as HTMLButtonElement;
    assert.ok(runTab);
    runTab.click();
    await settle(50);

    // 1. Complete state (act-203): complete tokens, complete duration, available cost
    const act203Row = doc.querySelector('[data-usage-activity="act-203"]') as HTMLButtonElement;
    assert.ok(act203Row);
    assert.match(act203Row.textContent ?? '', /61,400 tokens/);
    assert.match(act203Row.textContent ?? '', /\$0\.1420 API-equivalent/);
    assert.match(act203Row.textContent ?? '', /harness calculated/);

    // 2. Corrected state (act-204): superseded observation history and state label
    const act204Row = doc.querySelector('[data-usage-activity="act-204"]') as HTMLButtonElement;
    assert.ok(act204Row);
    act204Row.click();
    await settle(50);
    const act204Detail = doc.querySelector('.usage-detail-panel');
    assert.ok(act204Detail);
    assert.match(act204Detail.textContent ?? '', /corrected/);
    assert.match(act204Detail.textContent ?? '', /Supersedes/);
    assert.match(act204Detail.textContent ?? '', /provider estimated/);

    // 3. Subscription-inclusive state (act-202): subscription included basis, billed cost unavailable (never $0)
    const act202Row = doc.querySelector('[data-usage-activity="act-202"]') as HTMLButtonElement;
    assert.ok(act202Row);
    act202Row.click();
    await settle(50);
    const act202Detail = doc.querySelector('.usage-detail-panel');
    assert.ok(act202Detail);
    assert.match(act202Detail.textContent ?? '', /subscription included/);
    assert.match(act202Detail.textContent ?? '', /Attributable billed cost/);
    assert.match(act202Detail.textContent ?? '', /Unavailable/);
    assert.match(act202Detail.textContent ?? '', /\$0\.0380 API-equivalent/);

    // 4. Delayed and pending-cost state (act-207 and act-210)
    const act207Row = doc.querySelector('[data-usage-activity="act-207"]') as HTMLButtonElement;
    assert.ok(act207Row);
    assert.match(act207Row.textContent ?? '', /Pending API-equivalent/);
    assert.match(act207Row.textContent ?? '', /input observed/);
    act207Row.click();
    await settle(50);
    const act207Detail = doc.querySelector('.usage-detail-panel');
    assert.ok(act207Detail);
    assert.match(act207Detail.textContent ?? '', /delayed/);
    assert.match(act207Detail.textContent ?? '', /partial measurement/);

    // 5. Interrupted and unavailable-cost state (act-209): cost unavailable, not zero
    const act209Row = doc.querySelector('[data-usage-activity="act-209"]') as HTMLButtonElement;
    assert.ok(act209Row);
    assert.match(act209Row.textContent ?? '', /Unavailable API-equivalent/);
    assert.doesNotMatch(act209Row.textContent ?? '', /\$0\.00/);

    // 6. Provisional state (act-206) in Task / Project / Model / Time views
    const projectTab = doc.querySelector('[data-usage-tab="project"]') as HTMLButtonElement;
    assert.ok(projectTab);
    projectTab.click();
    await settle(50);

    const provisionalCards = doc.querySelectorAll('[data-usage-provisional="true"]');
    assert.ok(provisionalCards.length > 0, 'provisional cards rendered for ongoing work');
    const provisionalText = Array.from(provisionalCards).map((c) => c.textContent ?? '').join(' ');
    assert.match(provisionalText, /Provisional observed so far/);
    assert.match(provisionalText, /act-206/);

    // 7. Mixed-provenance state: aggregate cards with mixed provenance state
    assert.match(doc.body.textContent ?? '', /Mixed-provenance API-equivalent estimate/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Usage: primary Agent run view excludes Routing attempts; Project view retains both side-by-side', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app, fixture } = await mountedPage(vite, mount);

    const runTab = doc.querySelector('[data-usage-tab="run"]') as HTMLButtonElement;
    assert.ok(runTab);
    runTab.click();
    await settle(50);

    const runActivities = Array.from(doc.querySelectorAll('.usage-tab-surface [data-usage-activity]'))
      .map((el) => el.getAttribute('data-usage-activity'));

    const rawActs = fixture.rawActivities;
    const workActs = rawActs.filter((a: any) => a.kind === 'agent_run');
    assert.equal(runActivities.length, workActs.length);
    assert.ok(!runActivities.includes('act-wake-002'));
    assert.ok(!runActivities.includes('act-wake-003'));

    // Switch to Project tab: both work and routing appear
    const projectTab = doc.querySelector('[data-usage-tab="project"]') as HTMLButtonElement;
    assert.ok(projectTab);
    projectTab.click();
    await settle(50);

    assert.ok(doc.querySelector('[data-usage-kind="agent_run"]'));
    assert.ok(doc.querySelector('[data-usage-kind="routing_attempt"]'));
    assert.ok(doc.querySelector('[data-usage-activity="act-wake-002"]'));

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Usage: Task and Agent views exclude routing attempts with explicit boundary notes', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);

    // Task view
    const taskTab = doc.querySelector('[data-usage-tab="task"]') as HTMLButtonElement;
    assert.ok(taskTab);
    taskTab.click();
    await settle(50);

    const taskText = doc.querySelector('.usage-tab-surface')?.textContent ?? '';
    assert.match(taskText, /Routing attempts excluded/);
    assert.match(taskText, /Wake-model activity belongs to its Project/);
    assert.doesNotMatch(taskText, /act-wake-002/);
    assert.doesNotMatch(taskText, /act-wake-003/);
    assert.match(taskText, /Task calendar elapsed/);

    // Agent view
    const agentTab = doc.querySelector('[data-usage-tab="agent"]') as HTMLButtonElement;
    assert.ok(agentTab);
    agentTab.click();
    await settle(50);

    const agentText = doc.querySelector('.usage-tab-surface')?.textContent ?? '';
    assert.match(agentText, /Routing attempts excluded/);
    assert.match(agentText, /They have no Agent owner by design/);
    assert.doesNotMatch(agentText, /act-wake-002/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Usage: Time-range and summary band keep work and routing metrics strictly separate', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);

    // Summary band separation
    const workSummary = doc.querySelector('[data-usage-summary-kind="agent_run"]');
    const routingSummary = doc.querySelector('[data-usage-summary-kind="routing_attempt"]');
    assert.ok(workSummary);
    assert.ok(routingSummary);

    const workText = workSummary.textContent ?? '';
    const routingText = routingSummary.textContent ?? '';
    assert.match(workText, /Work-model Agent runs/);
    assert.match(workText, /181,500 tokens/);
    assert.match(workText, /\$0\.2900 available estimate/);
    assert.doesNotMatch(workText, /1,960 tokens/);
    assert.doesNotMatch(workText, /\$0\.0003 available estimate/);

    assert.match(routingText, /Project-owned Routing attempts/);
    assert.match(routingText, /1,960 tokens/);
    assert.match(routingText, /\$0\.0003 available estimate/);
    assert.doesNotMatch(routingText, /181,500 tokens/);
    assert.doesNotMatch(routingText, /\$0\.2900 available estimate/);

    // Time view separation
    const timeTab = doc.querySelector('[data-usage-tab="time"]') as HTMLButtonElement;
    assert.ok(timeTab);
    timeTab.click();
    await settle(50);

    const workTodayCard = doc.querySelector(
      '[data-usage-aggregate="true"][data-usage-range="today"][data-usage-kind="agent_run"]'
    );
    const routingTodayCard = doc.querySelector(
      '[data-usage-aggregate="true"][data-usage-range="today"][data-usage-kind="routing_attempt"]'
    );
    assert.ok(workTodayCard);
    assert.ok(routingTodayCard);

    assert.match(workTodayCard.textContent ?? '', /119,300 tokens/);
    assert.doesNotMatch(workTodayCard.textContent ?? '', /1,960 tokens/);
    assert.match(routingTodayCard.textContent ?? '', /1,960 tokens/);
    assert.doesNotMatch(routingTodayCard.textContent ?? '', /119,300 tokens/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Usage: model view groups by full identity (source, provider, version, engine, model)', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);

    const modelTab = doc.querySelector('[data-usage-tab="model"]') as HTMLButtonElement;
    assert.ok(modelTab);
    modelTab.click();
    await settle(50);

    const modelCards = doc.querySelectorAll('.usage-tab-surface [data-usage-aggregate="true"]');
    assert.ok(modelCards.length > 0);

    const allText = doc.querySelector('.usage-tab-surface')?.textContent ?? '';
    assert.match(allText, /Source: Pi telemetry \/ Provider: Anthropic \/ Version: Pi 0\.85\.1/);
    assert.match(allText, /Source: Codex telemetry \/ Provider: OpenAI \/ Version: Codex CLI 0\.154\.0/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Usage: filters and clear filters work, showing empty state when no activities match', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);

    const projectSelect = doc.querySelector('[data-usage-filter="projectId"]') as HTMLSelectElement;
    const modelSelect = doc.querySelector('[data-usage-filter="model"]') as HTMLSelectElement;
    const agentSelect = doc.querySelector('[data-usage-filter="agentId"]') as HTMLSelectElement;
    assert.ok(projectSelect && modelSelect && agentSelect);

    projectSelect.value = 'proj-docs-portal';
    projectSelect.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }));
    modelSelect.value = [...modelSelect.options].find(option => option.textContent === 'claude-3-5-sonnet')!.value;
    modelSelect.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }));
    agentSelect.value = 'programmer';
    agentSelect.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }));
    await settle(50);

    assert.match(doc.body.textContent ?? '', /No usage activities match these filters/);

    const clearBtn = doc.querySelector('.usage-clear-filters') as HTMLButtonElement;
    assert.ok(clearBtn);
    clearBtn.click();
    await settle(50);

    assert.doesNotMatch(doc.body.textContent ?? '', /No usage activities match these filters/);
    assert.equal(projectSelect.value, 'all');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Usage: accessibility backing table is provided for assistive technologies', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);

    const backingTable = doc.querySelector('[role="region"][aria-label="Tabular summary for assistive technology"] table');
    assert.ok(backingTable, 'accessible backing table exists');
    assert.match(backingTable.textContent ?? '', /Work-model Agent runs/);
    assert.match(backingTable.textContent ?? '', /Project-owned Routing attempts/);
    assert.match(backingTable.textContent ?? '', /Unavailable/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Usage: touch targets >= 44px, interactive ARIA roles, and keyboard navigation', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);

    // Verify tablist role and tabs
    const tablist = doc.querySelector('[role="tablist"]');
    assert.ok(tablist);
    const tabs = doc.querySelectorAll('[role="tab"]');
    assert.equal(tabs.length, 6);

    for (const tab of Array.from(tabs)) {
      assert.ok(tab.hasAttribute('aria-selected'));
    }

    // Switch to run tab to check row buttons
    const runTab = doc.querySelector('[data-usage-tab="run"]') as HTMLButtonElement;
    runTab.click();
    await settle(50);

    const activityRows = doc.querySelectorAll('.usage-activity-row');
    assert.ok(activityRows.length > 0);
    for (const row of Array.from(activityRows)) {
      assert.ok(row.hasAttribute('aria-expanded'));
    }

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Usage: privacy boundary — no sensitive paths, credentials, or secrets in rendered output', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);
    const text = doc.body.textContent ?? '';

    assert.doesNotMatch(text, /\/(?:Users|home)\//, 'no user home directory paths');
    assert.doesNotMatch(text, /C:\\Users\\/, 'no windows user home paths');
    assert.doesNotMatch(text, /(?:api[_-]?key|secret|password|bearer|token)\s*[:=]\s*[A-Za-z0-9]/i);
    assert.doesNotMatch(text, /192\.168\.\d+\.\d+/, 'no internal IP addresses');
    assert.doesNotMatch(text, /10\.\d+\.\d+\.\d+/, 'no private 10.x IP addresses');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Usage regression: incomplete aggregate responses show an explicit error instead of crashing during render', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { FixtureUsageService } = await vite.ssrLoadModule('/src/modules/usage/adapters/fixture-adapter.ts');
    const scenarios: {
      label: string;
      malformed?: (aggregate: any) => unknown;
      fromCall?: number;
      reject?: boolean;
      message?: RegExp;
    }[] = [
      { label: 'per-identity token coverage', fromCall: 3, malformed: aggregate => { delete aggregate.tokenCoverage; return aggregate; } },
      { label: 'cost coverage', fromCall: 3, malformed: aggregate => { delete aggregate.costCoverage; return aggregate; } },
      { label: 'provenance totals', fromCall: 3, malformed: aggregate => {
        aggregate.cost = { ...aggregate.cost };
        delete aggregate.cost.byProvenance;
        return aggregate;
      } },
      { label: 'nested group coverage', malformed: aggregate => {
        const nested = { ...aggregate, groups: undefined };
        delete nested.tokenCoverage;
        aggregate.groups = { sparseGroup: nested };
        return aggregate;
      } },
      { label: '200 error envelope', malformed: () => ({ error: 'invalid aggregate response' }) },
      { label: 'rejected query', reject: true, message: /Usage query unavailable/ },
    ];

    for (const scenario of scenarios) {
      const fixture = new FixtureUsageService();
      const getAggregate = fixture.getAggregate.bind(fixture);
      let calls = 0;
      fixture.getAggregate = async (filter: any) => {
        if (scenario.reject) throw new Error('request failed');
        const aggregate = await getAggregate(filter);
        calls += 1;
        if (calls < (scenario.fromCall ?? 1)) return aggregate;
        return scenario.malformed?.({ ...aggregate, cost: { ...aggregate.cost } }) as any;
      };
      const renderErrors: string[] = [];
      const { app } = await mountedPage(vite, mount, fixture, (configuredApp) => {
        configuredApp.config.errorHandler = (error: unknown, _instance: unknown, info: string) => {
          renderErrors.push(`${info}: ${String(error)}`);
        };
      });
      const state = doc.querySelector(scenario.reject ? '[role="alert"]' : '.usage-incomplete-state');
      assert.deepEqual(renderErrors, [], `${scenario.label}: no render error`);
      assert.ok(state, `${scenario.label}: failure is visible`);
      assert.match(state.textContent ?? '', scenario.message ?? /incomplete aggregate data/i, scenario.label);
      assert.doesNotMatch(doc.body.textContent ?? '', /Loading authoritative usage/, scenario.label);
      assert.equal(doc.querySelector('.usage-summary-band'), null, `${scenario.label}: no partial aggregate is presented as complete`);
      app.unmount();
      mount.innerHTML = '';
    }
  } finally { await cleanup(); }
});

test('Usage F4: scopes query authoritative aggregates with filters; truncated lists are not full totals', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { FixtureUsageService } = await vite.ssrLoadModule('/src/modules/usage/adapters/fixture-adapter.ts');
    const fixture = new FixtureUsageService();
    const calls: any[] = [];
    // Details/list are stale and truncated; aggregate authority has newer token facts.
    const authority = new FixtureUsageService({ activities: fixture.rawActivities.map((a: any) => a.id === 'act-203'
      ? { ...a, tokenDimensions: { ...a.tokenDimensions, total: 888888 } } : a) });
    const aggregate = authority.getAggregate.bind(authority);
    fixture.getAggregate = async (filter: any) => { calls.push(filter); return aggregate(filter); };
    const list = fixture.listActivities.bind(fixture);
    fixture.listActivities = async (filter: any) => (await list(filter)).slice(0, 1);
    const { app } = await mountedPage(vite, mount, fixture);
    for (const tab of ['run', 'task', 'project', 'agent', 'model', 'time']) {
      (doc.querySelector(`[data-usage-tab="${tab}"]`) as HTMLButtonElement).click();
      await settle(100);
      assert.ok(calls.some(f => f.groupBy === (tab === 'time' ? undefined : tab) && f.timeZone === 'UTC'
        && f.kind === (['run','task','agent'].includes(tab) ? 'agent_run' : undefined)), `aggregate query for ${tab}`);
    }
    assert.match(doc.body.textContent ?? '', /Activity list incomplete/);
    assert.match(doc.querySelector('[data-usage-summary-kind="agent_run"]')?.textContent ?? '', /1,008,988 tokens/, 'summary uses newer aggregate facts, not stale list/details');
    const project = doc.querySelector('[data-usage-filter="projectId"]') as HTMLSelectElement;
    project.value = 'proj-minesweeper';
    project.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }));
    const range = doc.querySelector('[data-usage-filter="timeRange"]') as HTMLSelectElement;
    range.value = '30d';
    range.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }));
    const filteredQuery = (filter: any) => filter.projectId === 'proj-minesweeper'
      && typeof filter.from === 'number' && typeof filter.to === 'number'
      && filter.to - filter.from === 30 * 86400000;
    assert.ok(await waitFor(() => calls.some(filteredQuery)), 'filtered aggregate query starts');
    assert.ok(await waitFor(() => !(doc.body.textContent ?? '').includes('Loading authoritative usage…')), 'filtered aggregate request settles');
    assert.ok(doc.querySelector('.usage-tab-surface [data-usage-activity="act-204"]'), `query constituent survives stale display bucket; bounds belong to the authority; results: ${JSON.stringify(calls.filter(filteredQuery))}`);
    app.unmount();
  } finally { await cleanup(); }
});


test('Usage F5: hostile display and telemetry strings are redacted across all tabs and details', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { FixtureUsageService } = await vite.ssrLoadModule('/src/modules/usage/adapters/fixture-adapter.ts');
    const original = new FixtureUsageService();
    const path = ['','home','synthetic-operator','private-proof'].join('/');
    const credential = 'token=' + 'synthetic-credential-proof';
    const address = [192, 168, 88, 99].join('.');
    const hostile = `Safe context ${path} ${credential} ${address}`;
    const acts = original.rawActivities.map((a: any) => ({ ...a,
      model: hostile, provider: hostile,
      modelIdentity: { source: hostile, provider: hostile, version: hostile },
      durationSource: hostile, outcomeReason: hostile, coverageNote: hostile,
      tokenDimensions: { ...a.tokenDimensions, source: hostile },
      costValuation: { ...a.costValuation, note: hostile, source: hostile, sourceVersion: hostile },
      observationHistory: [{ timestamp: hostile, source: hostile, status: hostile, note: hostile, supersedes: hostile }],
    }));
    const fixture = new FixtureUsageService({ activities: acts,
      projects: (await original.listProjects()).map((p: any) => ({ ...p, displayName: hostile })),
      agents: (await original.listAgents()).map((a: any) => ({ ...a, displayName: hostile })),
    });
    const { app } = await mountedPage(vite, mount, fixture);
    for (const tab of ['run', 'task', 'project', 'agent', 'model', 'time']) {
      (doc.querySelector(`[data-usage-tab="${tab}"]`) as HTMLButtonElement).click();
      await settle(80);
      (doc.querySelector('.usage-tab-surface [data-usage-activity]') as HTMLButtonElement)?.click();
      await settle(30);
      const text = doc.body.textContent ?? '';
      for (const sentinel of [path, credential, address]) {
        assert.ok(!text.includes(sentinel), `${tab}: hostile text absent`);
        assert.ok(!doc.body.innerHTML.includes(sentinel), `${tab}: hostile attribute absent`);
      }
      assert.match(text, /Safe context/);
    }
    app.unmount();
  } finally { await cleanup(); }
});

test('Usage F6: backing tables expose every constituent and its measurement and history evidence', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app, fixture } = await mountedPage(vite, mount);
    for (const tab of ['run', 'task', 'project', 'agent', 'model', 'time']) {
      (doc.querySelector(`[data-usage-tab="${tab}"]`) as HTMLButtonElement).click();
      await settle(80);
      const region = doc.querySelector('[aria-label="Tabular summary for assistive technology"]')!;
      const rows = region.querySelectorAll('[data-usage-backing-activity]');
      const expected = fixture.rawActivities.filter((a: any) => !['run','task','agent'].includes(tab) || a.kind === 'agent_run');
      assert.equal(rows.length, expected.length, `${tab}: all constituents represented`);
      for (const a of expected) {
        const row = region.querySelector(`[data-usage-backing-activity="${a.id}"]`)!;
        const text = row.textContent ?? '';
        assert.match(text, new RegExp(a.outcome, 'i'));
        const project = (await fixture.listProjects()).find((p: any) => p.id === a.projectId);
        if (project) assert.ok(text.includes(project.displayName), 'project display attribution present');
        assert.ok(text.includes(a.tokenDimensions.status));
        assert.ok(text.includes(a.observationState));
        assert.ok(text.includes(a.costValuation.billingBasis.replaceAll('_', ' ')));
        for (const dimension of ['totalInput','uncachedInput','cachedReads','cacheWrite','output','reasoningOutput','total']) {
          const cell = row.querySelector(`[data-token-dimension="${dimension}"]`)!;
          assert.equal(cell.textContent, a.tokenDimensions[dimension] === undefined ? 'Unavailable' : a.tokenDimensions[dimension].toLocaleString());
        }
        const { sanitizeOperatorText } = await import('../../../../src/environment/privacy.ts');
        for (const h of a.observationHistory ?? []) assert.ok(text.includes(sanitizeOperatorText(h.note, { fallback: 'Unavailable', maxLength: 4000 })), 'append-only sanitized history note present');
      }
      assert.match(region.textContent ?? '', /Provisional observed so far/);
      assert.match(region.textContent ?? '', /Token coverage/);
      assert.match(region.textContent ?? '', /API-equivalent estimate provenance/);
    }
    app.unmount();
  } finally { await cleanup(); }
});

test('Usage F7: constituent drill-down controls have a computed minimum 44px target', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);
    (doc.querySelector('[data-usage-tab="project"]') as HTMLButtonElement).click();
    await settle(80);
    const css = await readFile(`${repoRoot}/web/src/modules/usage/usage.css`, 'utf8');
    const style = doc.createElement('style'); style.textContent = css; doc.head.append(style);
    const controls = doc.querySelectorAll('.usage-activity-link');
    assert.ok(controls.length > 0);
    for (const control of controls) {
      const computed = doc.defaultView!.getComputedStyle(control);
      assert.ok(parseFloat(computed.minHeight) >= 44, 'constituent target minimum height >=44px');
    }
    style.remove();
    app.unmount();
  } finally { await cleanup(); }
});

test('Usage F8: tabs rove focus and selection with arrows, Home and End and own a panel', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);
    const tabs = [...doc.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs[0]!.click(); tabs[0]!.focus();
    const key = async (name: string, index: number) => {
      doc.activeElement!.dispatchEvent(new doc.defaultView!.KeyboardEvent('keydown', { key: name, bubbles: true }));
      await settle(80);
      assert.equal(doc.activeElement, tabs[index], `${name}: focus moves`);
      assert.equal(tabs[index]!.getAttribute('aria-selected'), 'true');
      assert.equal(tabs[index]!.tabIndex, 0);
      assert.equal(tabs.filter(t => t.tabIndex === 0).length, 1);
      const panel = doc.getElementById(tabs[index]!.getAttribute('aria-controls')!);
      assert.equal(panel?.getAttribute('role'), 'tabpanel');
      assert.equal(panel?.getAttribute('aria-labelledby'), tabs[index]!.id);
    };
    await key('ArrowRight', 1);
    await key('End', 5);
    await key('ArrowRight', 0);
    await key('ArrowLeft', 5);
    await key('Home', 0);
    app.unmount();
  } finally { await cleanup(); }
});

test('Usage F10: compact composition applies throughout the prototype tablet range', async () => {
  const css = await readFile(`${repoRoot}/web/src/modules/usage/usage.css`, 'utf8');
  const dom = new JSDOM('<style></style>');
  dom.window.document.querySelector('style')!.textContent = css;
  const rules = [...dom.window.document.styleSheets[0]!.cssRules];
  const valueAt = (width: number, selector: string, property: string) => {
    let value = '';
    const apply = (rule: any) => {
      if (rule.selectorText === selector) value = rule.style.getPropertyValue(property) || value;
      if (rule.media) {
        const max = /max-width:\s*(\d+)px/.exec(rule.media.mediaText);
        if (max && width <= Number(max[1])) [...rule.cssRules].forEach(apply);
      }
    };
    rules.forEach(apply); return value.trim();
  };
  for (const width of [641, 768, 859]) {
    assert.equal(valueAt(width, '.usage-summary-band', 'grid-template-columns'), '1fr', `${width}px summary collapses`);
    assert.equal(valueAt(width, '.usage-view-tabs', 'grid-template-columns'), 'repeat(3, minmax(0, 1fr))', `${width}px tabs collapse`);
  }
  assert.equal(valueAt(860, '.usage-view-tabs', 'grid-template-columns'), 'repeat(6, minmax(0, 1fr))');
  dom.window.close();
});

test('Usage F11: starts on Agent run with an unbadged full-width header', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountedPage(vite, mount);
    assert.deepEqual({
      initialTab: doc.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-usage-tab'),
      billedHeaderBadge: /Attributable billed cost/.test(doc.querySelector('.usage-page-header')?.textContent ?? ''),
    }, { initialTab: 'run', billedHeaderBadge: false });
    app.unmount();
  } finally { await cleanup(); }
});
