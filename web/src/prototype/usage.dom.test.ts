import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



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

test('Usage: time-range aggregate cards keep work and routing totals separate', async () => {
  const { dom, stateManager, cleanup } = await openUsageSurface();
  try {
    const document = dom.window.document;
    stateManager.setUsageFilter({ tab: 'time', timeRange: 'all' });

    const workCard = document.querySelector<HTMLElement>(
      '[data-usage-aggregate="true"][data-usage-range="today"][data-usage-kind="agent_run"]'
    );
    const routingCard = document.querySelector<HTMLElement>(
      '[data-usage-aggregate="true"][data-usage-range="today"][data-usage-kind="routing_attempt"]'
    );
    assert.ok(workCard);
    assert.ok(routingCard);

    const workMetrics = workCard.querySelector('.usage-aggregate-metrics')?.textContent ?? '';
    const routingMetrics = routingCard.querySelector('.usage-aggregate-metrics')?.textContent ?? '';
    assert.match(workMetrics, /119,300 tokens/);
    assert.match(workMetrics, /\$0\.2690 available estimate/);
    assert.doesNotMatch(workMetrics, /1,960 tokens/);
    assert.match(routingMetrics, /1,960 tokens/);
    assert.match(routingMetrics, /\$0\.0003 available estimate/);
    assert.doesNotMatch(routingMetrics, /119,300 tokens/);
  } finally {
    await cleanup();
  }
});

test('Usage: the visible summary keeps work and routing metrics separate', async () => {
  const { dom, stateManager, cleanup } = await openUsageSurface();
  try {
    const document = dom.window.document;
    stateManager.setUsageFilter({ tab: 'run', timeRange: 'all' });

    const workSummary = document.querySelector<HTMLElement>('[data-usage-summary-kind="agent_run"]');
    const routingSummary = document.querySelector<HTMLElement>('[data-usage-summary-kind="routing_attempt"]');
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
  } finally {
    await cleanup();
  }
});

test('Usage: ongoing activity is provisional and excluded from finalized aggregate links', async () => {
  const { dom, stateManager, cleanup } = await openUsageSurface();
  try {
    const document = dom.window.document;
    for (const tab of ['project', 'model', 'time'] as const) {
      stateManager.setUsageFilter({ tab, timeRange: 'all' });
      const finalCards = [...document.querySelectorAll<HTMLElement>('[data-usage-provisional="false"]')];
      const provisionalCards = [...document.querySelectorAll<HTMLElement>('[data-usage-provisional="true"]')];
      assert.ok(provisionalCards.length > 0, `${tab} renders provisional cards`);
      assert.ok(
        provisionalCards.some((card) => /Provisional observed so far/.test(card.textContent ?? '')),
        `${tab} labels provisional cards`
      );
      assert.ok(
        provisionalCards.some((card) => card.querySelector('[data-usage-activity="act-206"]')),
        `${tab} keeps ongoing activity in provisional evidence`
      );
      assert.ok(
        finalCards.every((card) => !card.querySelector('[data-usage-activity="act-206"]')),
        `${tab} excludes ongoing activity from finalized links`
      );
    }
  } finally {
    await cleanup();
  }
});

test('Usage: unavailable duration keeps a known subtotal but marks aggregate time incomplete', async () => {
  const { dom, stateManager, cleanup } = await openUsageSurface();
  const activities = stateManager.getSnapshot().usageActivities;
  let added = false;
  try {
    const source = activities.find((activity) => activity.id === 'act-207');
    assert.ok(source);
    activities.push({
      ...source,
      id: 'act-duration-unavailable',
      wallDurationMs: 154000,
      durationStatus: 'unavailable',
    });
    added = true;
    stateManager.setUsageFilter({ tab: 'project', timeRange: 'all' });

    const projectCard = document.querySelector<HTMLElement>('[data-usage-project="proj-docs-portal"]');
    const workCard = projectCard?.querySelector<HTMLElement>('[data-usage-kind="agent_run"][data-usage-provisional="false"]');
    assert.ok(workCard);
    const metrics = workCard.querySelector('.usage-aggregate-metrics')?.textContent ?? '';
    assert.match(metrics, /7m 09s/);
    assert.match(metrics, /incomplete/);
    assert.match(workCard.querySelector('.usage-aggregate-coverage')?.textContent ?? '', /1 unavailable/);
  } finally {
    if (added) activities.splice(activities.findIndex((activity) => activity.id === 'act-duration-unavailable'), 1);
    await cleanup();
  }
});

test('Usage: model grouping keeps source, provider, and version identity distinct', async () => {
  const { dom, stateManager, cleanup } = await openUsageSurface();
  const activities = stateManager.getSnapshot().usageActivities;
  let variantAdded = false;
  try {
    const source = activities.find((activity) => activity.id === 'act-204');
    assert.ok(source);
    activities.push({
      ...source,
      id: 'act-source-variant',
      modelIdentity: {
        source: 'Alternate model gateway',
        provider: 'OpenAI-compatible provider',
        version: 'gateway-v2',
      },
    });
    variantAdded = true;
    stateManager.setUsageFilter({ tab: 'model', timeRange: 'all' });

    const gptGroups = [...dom.window.document.querySelectorAll<HTMLElement>('[data-model-name="gpt-4o"]')];
    assert.equal(gptGroups.length, 2);
    assert.ok(gptGroups.some((group) => /Codex telemetry/.test(group.textContent ?? '')));
    assert.ok(gptGroups.some((group) => /Alternate model gateway/.test(group.textContent ?? '')));
    assert.ok(gptGroups.some((group) => /OpenAI-compatible provider/.test(group.textContent ?? '')));
    assert.ok(gptGroups.some((group) => /gateway-v2/.test(group.textContent ?? '')));
  } finally {
    if (variantAdded) activities.splice(activities.findIndex((activity) => activity.id === 'act-source-variant'), 1);
    await cleanup();
  }
});

test('Usage: Project, model, and time aggregate cards expose coverage and provenance evidence', async () => {
  const { dom, stateManager, cleanup } = await openUsageSurface();
  try {
    const document = dom.window.document;
    for (const tab of ['project', 'model', 'time'] as const) {
      stateManager.setUsageFilter({ tab, timeRange: 'all' });
      const cards = [...document.querySelectorAll<HTMLElement>('[data-usage-aggregate="true"]')];
      assert.ok(cards.length > 0, `${tab} has aggregate cards`);
      for (const card of cards) {
        const evidence = card.querySelector('.usage-aggregate-coverage');
        assert.ok(evidence, `${tab} aggregate has coverage evidence`);
        const text = evidence?.textContent ?? '';
        assert.match(text, /Token coverage/);
        assert.match(text, /API-equivalent valuation/);
        assert.match(text, /Attributable billed cost/);
        assert.match(text, /pending/);
        assert.match(text, /unavailable/);
        assert.match(text, /not zero/);
      }
    }

    assert.match(document.body.textContent ?? '', /Mixed-provenance API-equivalent estimate/);
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
