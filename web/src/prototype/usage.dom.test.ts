import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

async function setupPrototypeDom() {
  const html = await readFile(new URL('../../prototype/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://sprout-prototype.test/prototype/',
    pretendToBeVisual: true,
  });

  const global = globalThis as Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  };
  const originals = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const vite = await createServer({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  });

  return {
    dom,
    vite,
    cleanup: async () => {
      await vite.close();
      for (const [key, original] of originals) {
        if (original === undefined) delete global[key];
        else Object.defineProperty(globalThis, key, original);
      }
      dom.window.close();
    },
  };
}

async function openUsageSurface() {
  const context = await setupPrototypeDom();
  const { initPrototype } = (await context.vite.ssrLoadModule('/src/prototype/prototype.ts')) as typeof import('./prototype.js');
  const { stateManager } = (await context.vite.ssrLoadModule('/src/prototype/state.ts')) as typeof import('./state.js');
  const appMount = context.dom.window.document.getElementById('app');
  assert.ok(appMount);
  initPrototype(appMount);
  stateManager.setPrimaryNav('manage', undefined, 'usage');
  return { ...context, stateManager };
}

test('Usage: presents six views, truthful coverage, and separate work and wake activity', async () => {
  const { dom, cleanup } = await openUsageSurface();
  try {
    const document = dom.window.document;
    const text = document.body.textContent ?? '';
    assert.match(text, /Usage & Costs/);
    assert.equal(document.querySelectorAll('[data-usage-tab]').length, 6);
    assert.match(text, /Agent run/);
    assert.match(text, /Routing attempt/);
    assert.match(text, /Attributable billed cost/);
    assert.match(text, /Unavailable for/);
    assert.match(text, /partial/);
    assert.match(text, /pending/);
    assert.match(text, /No valuation provenance/);
    assert.doesNotMatch(text, /Billed invoice cost:\s*\$0/);
  } finally {
    await cleanup();
  }
});

test('Usage: the primary Agent run view excludes Project-owned Routing attempts while Project drill-down retains them', async () => {
  const { dom, stateManager, cleanup } = await openUsageSurface();
  try {
    const document = dom.window.document;
    stateManager.setUsageFilter({ tab: 'run', timeRange: 'all' });
    const agentRunCount = stateManager.getSnapshot().usageActivities.filter((activity) => activity.kind === 'agent_run').length;
    const primaryActivityIds = [...document.querySelectorAll<HTMLElement>('.usage-tab-surface [data-usage-activity]')]
      .map((element) => element.dataset.usageActivity);

    assert.equal(primaryActivityIds.length, agentRunCount);
    assert.ok(primaryActivityIds.every((id) => id !== 'act-wake-002' && id !== 'act-wake-003'));
    assert.match(document.querySelector('.usage-list-heading')?.textContent ?? '', /work-model Agent run only/);

    const projectTab = document.querySelector('[data-usage-tab="project"]') as HTMLButtonElement;
    assert.ok(projectTab);
    projectTab.click();
    assert.match(document.querySelector('.usage-tab-surface')?.textContent ?? '', /Routing-model attempts/);
    const routingActivity = document.querySelector('[data-usage-activity="act-wake-002"]') as HTMLButtonElement;
    assert.ok(routingActivity);
    routingActivity.click();
    assert.match(document.querySelector('.usage-detail-panel')?.textContent ?? '', /Routing attempt/);
  } finally {
    await cleanup();
  }
});

test('Usage: all aggregate views preserve kind boundaries and drill down to activity evidence', async () => {
  const { dom, stateManager, cleanup } = await openUsageSurface();
  try {
    const document = dom.window.document;
    const tabs = ['task', 'project', 'agent', 'model', 'time'] as const;
    for (const tab of tabs) {
      const button = document.querySelector(`[data-usage-tab="${tab}"]`) as HTMLButtonElement;
      assert.ok(button, `tab ${tab} exists`);
      button.click();
      assert.equal(stateManager.getSnapshot().usageFilter.tab, tab);
      assert.ok(document.querySelector('.usage-tab-surface'));
    }

    stateManager.setUsageFilter({ tab: 'run', timeRange: 'all' });
    const activityRow = document.querySelector('[data-usage-activity="act-204"]') as HTMLButtonElement;
    assert.ok(activityRow);
    activityRow.click();

    const detailText = document.body.textContent ?? '';
    assert.match(detailText, /Activity detail/);
    assert.match(detailText, /Token dimensions/);
    assert.match(detailText, /Cached reads/);
    assert.match(detailText, /Reasoning output/);
    assert.match(detailText, /provider estimated/);
    assert.match(detailText, /Observation history and corrections/);
    assert.match(detailText, /Supersedes/);
    assert.match(detailText, /Attributable billed cost/);
    assert.match(detailText, /Unavailable/);
  } finally {
    await cleanup();
  }
});

test('Usage: filters show a real empty state, clear safely, and work on the phone layout', async () => {
  const { dom, stateManager, cleanup } = await openUsageSurface();
  try {
    const document = dom.window.document;
    stateManager.setViewportMode('mobile');
    assert.ok(document.querySelector('.usage-view-tabs'));
    assert.equal(document.querySelectorAll('[data-usage-tab]').length, 6);

    const project = document.querySelector('[data-usage-filter="projectId"]') as HTMLSelectElement;
    const model = document.querySelector('[data-usage-filter="model"]') as HTMLSelectElement;
    assert.ok(project);
    assert.ok(model);
    project.value = 'proj-docs-portal';
    project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const modelAfterProject = document.querySelector('[data-usage-filter="model"]') as HTMLSelectElement;
    modelAfterProject.value = 'claude-3-5-sonnet';
    modelAfterProject.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const agentAfterModel = document.querySelector('[data-usage-filter="agentId"]') as HTMLSelectElement;
    agentAfterModel.value = 'programmer';
    agentAfterModel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.match(document.body.textContent ?? '', /No usage activities match these filters/);

    const clear = document.querySelector('.usage-clear-filters') as HTMLButtonElement;
    assert.ok(clear);
    clear.click();
    assert.doesNotMatch(document.body.textContent ?? '', /No usage activities match these filters/);
    assert.equal(stateManager.getSnapshot().usageFilter.timeRange, 'all');
  } finally {
    await cleanup();
  }
});

test('Usage: retained artifact and fixture additions contain no sensitive host facts', async () => {
  const artifact = await readFile(new URL('../../../docs/prototype-usage-costs.md', import.meta.url), 'utf8');
  const source = await readFile(new URL('./views/usage-view.ts', import.meta.url), 'utf8');
  for (const value of [artifact, source]) {
    assert.doesNotMatch(value, /\/(?:Users|home)\//);
    assert.doesNotMatch(value, /C:\\Users\\/);
    assert.doesNotMatch(value, /(?:api[_-]?key|secret|private[_-]?key)\s*[:=]\s*[A-Za-z0-9]/i);
  }
});
