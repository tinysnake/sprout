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
    server: { middlewareMode: true, hmr: false },
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

test('Feed & Attention: renders three-tier hierarchy with clean production UI', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // 1. Verify Feed Header
    const feedHeader = document.querySelector('.feed-header');
    assert.ok(feedHeader, 'Feed header rendered');
    assert.match(feedHeader.textContent ?? '', /Operations Feed & Human Attention/);

    // 2. Verify Scope Filter Bar (Dropdown)
    const scopeSelect = document.querySelector('#feed-scope-select') as HTMLSelectElement;
    assert.ok(scopeSelect, 'Scope select dropdown rendered');

    // 3. Verify Tier 1: Human Attention Section
    const attentionSection = document.querySelector('.attention-section');
    assert.ok(attentionSection, 'Attention section rendered');
    assert.match(attentionSection.textContent ?? '', /Human Attention Required/);

    // 4. Verify Tier 2: Live In-Flight Work Snapshot
    const activeWorkSection = document.querySelector('.active-work-section');
    assert.ok(activeWorkSection, 'Active work section rendered');
    assert.match(activeWorkSection.textContent ?? '', /Live In-Flight Work/);

    // 5. Verify Tier 3: Recent Operational Activity Stream
    const activitySection = document.querySelector('.activity-section');
    assert.ok(activitySection, 'Activity section rendered');
    assert.match(activitySection.textContent ?? '', /Recent Operational Activity/);
  } finally {
    await cleanup();
  }
});

test('Feed & Attention: scope filtering cascades to Attention, Active Work, and Activity', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // Initial state: All Projects
    assert.equal(document.querySelectorAll('.attention-card').length, 6, 'All 6 attention items initially');
    assert.equal(document.querySelectorAll('.active-task-card').length, 1, '1 active task in all scope');

    // Select O7 Minesweeper in Scope Dropdown
    const scopeSelect = document.querySelector('#feed-scope-select') as HTMLSelectElement;
    assert.ok(scopeSelect);
    scopeSelect.value = 'proj-minesweeper';
    scopeSelect.dispatchEvent(new dom.window.Event('change'));

    // Verify Attention items filtered to O7 Minesweeper (including transcolated recovery task #104)
    const filteredCards = document.querySelectorAll('.attention-card');
    assert.equal(filteredCards.length, 3, '3 attention items belong to or affect O7 Minesweeper');

    // Verify Active Tasks still shows O7 Minesweeper active task
    assert.equal(document.querySelectorAll('.active-task-card').length, 1, 'O7 Minesweeper active task visible');

    // Verify Activity Stream only has O7 Minesweeper events
    const actRows = document.querySelectorAll('.activity-feed-row');
    assert.ok(actRows.length > 0);
    actRows.forEach((row) => {
      assert.match(row.textContent ?? '', /O7 Minesweeper/);
    });

    // Switch Scope to Infrastructure via Dropdown
    scopeSelect.value = 'infrastructure';
    scopeSelect.dispatchEvent(new dom.window.Event('change'));

    // Verify Attention items filtered to infrastructure
    const infraCards = document.querySelectorAll('.attention-card');
    assert.equal(infraCards.length, 3, '3 infrastructure attention items (Pending Environment, Container CI, Incompatible Environment)');
    assert.ok(Array.from(infraCards).some((c) => c.textContent?.includes('Pending Worker Enrollment: Pending Environment')));

    // Verify 0 active tasks under Infrastructure
    assert.equal(document.querySelectorAll('.active-task-card').length, 0, '0 active tasks under infrastructure');

    // Reset to All
    scopeSelect.value = 'all';
    scopeSelect.dispatchEvent(new dom.window.Event('change'));
    assert.equal(document.querySelectorAll('.attention-card').length, 6, 'Reset to all 6 attention items');
  } finally {
    await cleanup();
  }
});

test('Feed & Attention: 4 streamlined urgency pills filter with dynamic counters', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // Verify 4 urgency pills present
    const pills = document.querySelectorAll('.urgency-pill-btn');
    assert.equal(pills.length, 4, '4 urgency pills present');

    // Filter by Action Required
    const dangerPill = document.querySelector('.urgency-pill-btn[data-severity="action_required"]') as HTMLButtonElement;
    assert.ok(dangerPill);
    dangerPill.click();

    const redCards = document.querySelectorAll('.attention-card');
    assert.equal(redCards.length, 3, '3 action required cards (Task #104 recovery, Task #103 blocker, Incompatible Environment protocol mismatch)');

    // Filter by Pending Approval (Validation & Enrollment)
    const warningPill = document.querySelector('.urgency-pill-btn[data-severity="attention"]') as HTMLButtonElement;
    assert.ok(warningPill);
    warningPill.click();

    const yellowCards = document.querySelectorAll('.attention-card');
    assert.equal(yellowCards.length, 3, '3 pending approval cards (Task #101 claim, Pending Environment enrollment, Degraded Environment)');

    // Filter by Proposals & Notices (Info)
    const infoPill = document.querySelector('.urgency-pill-btn[data-severity="info"]') as HTMLButtonElement;
    assert.ok(infoPill);
    infoPill.click();

    // In default mixed state, info is 0; verify lightweight clear banner
    assert.equal(document.querySelectorAll('.attention-card').length, 0, '0 info items in default state');
    assert.ok(document.querySelector('.attention-empty-box'), 'Empty state box rendered');

    // Reset to All
    const allPill = document.querySelector('.urgency-pill-btn[data-severity="all"]') as HTMLButtonElement;
    allPill.click();
    assert.equal(document.querySelectorAll('.attention-card').length, 6, 'Restored all 6 items');
  } finally {
    await cleanup();
  }
});

test('Feed & Attention: deep-link navigation preserves scope and filter state on return', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // 1. Select O7 Minesweeper scope via Dropdown
    const scopeSelect = document.querySelector('#feed-scope-select') as HTMLSelectElement;
    assert.ok(scopeSelect);
    scopeSelect.value = 'proj-minesweeper';
    scopeSelect.dispatchEvent(new dom.window.Event('change'));

    // 2. Click Task #101 attention card
    const actionCard = document.querySelector('.attention-card[data-attention-id="att-1"]') as HTMLElement;
    assert.ok(actionCard);
    actionCard.click();

    // Verify navigated to Project Tasks view with return banner
    assert.ok(document.querySelector('.projects-view'), 'Navigated to Project view');
    const returnBanner = document.querySelector('.return-context-banner');
    assert.ok(returnBanner, 'Return context breadcrumb banner is visible');
    assert.match(returnBanner.textContent ?? '', /← Back to Feed/);

    // 3. Click "← Back to Feed"
    const returnBtn = document.querySelector('#btn-pop-return') as HTMLButtonElement;
    returnBtn.click();

    // Verify returned to Feed AND scope filter is preserved as proj-minesweeper
    assert.ok(document.querySelector('.feed-view'), 'Returned to Feed view');
    const scopeSelectAfter = document.querySelector('#feed-scope-select') as HTMLSelectElement;
    assert.equal(scopeSelectAfter.value, 'proj-minesweeper', 'Scope filter state was preserved on return');
  } finally {
    await cleanup();
  }
});

test('Feed presets are isolated snapshots and cannot contradict authoritative recovery state', async () => {
  const { vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const beforeTasks = structuredClone(stateManager.getSnapshot().tasks);
    const beforeEnvironments = structuredClone(stateManager.getSnapshot().environments);
    const recoveryTask = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-104');
    const recoveryEnvironment = stateManager.getSnapshot().environments.find((env) => env.id === 'env-recovery');
    assert.equal(recoveryTask?.lifecycle, 'recovery');
    assert.equal(recoveryEnvironment?.workSafety, 'recovery');
    assert.ok(recoveryEnvironment?.activeLeaseHolder, 'fixture starts with a held recovery lease');
    assert.ok(recoveryEnvironment?.leaseRecovery, 'fixture starts with recovery evidence');

    // The old implementation changed the Task to completed/released and the
    // Environment to green/online here, but left its holder and recovery
    // evidence behind. A Feed scenario is now explicitly non-mutating.
    stateManager.applyFeedPreset('empty');

    assert.deepEqual(stateManager.getSnapshot().tasks, beforeTasks, 'Task lifecycle facts remain source-owned');
    assert.deepEqual(
      stateManager.getSnapshot().environments,
      beforeEnvironments,
      'Environment lease, recovery, holder, and reason facts remain source-owned'
    );
    const scenario = stateManager.getSnapshot().feedScenarioSnapshot;
    assert.ok(scenario, 'Feed stores an isolated scenario snapshot');
    assert.equal(scenario.preset, 'empty');
    assert.equal(scenario.attentionItems.length, 0);
    assert.deepEqual(scenario.activeTaskIds, []);
  } finally {
    await cleanup();
  }
});

test('Feed, Environment, and shared shell drill-downs support keyboard activation', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const press = (element: HTMLElement, key: 'Enter' | ' ') => {
      element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    };

    stateManager.setViewportMode('desktop');
    const manageNav = dom.window.document.querySelector(
      '.desktop-sidebar .sidebar-nav-item[data-nav="manage"]'
    ) as HTMLButtonElement;
    assert.ok(manageNav);
    assert.equal(manageNav.tagName, 'BUTTON');
    assert.equal(manageNav.tabIndex, 0);
    press(manageNav, 'Enter');
    assert.equal(stateManager.getSnapshot().primaryNav, 'manage');

    stateManager.setPrimaryNav('feed');
    const attentionCard = dom.window.document.querySelector('.attention-card') as HTMLElement;
    assert.ok(attentionCard);
    assert.equal(attentionCard.tagName, 'BUTTON');
    assert.equal(attentionCard.tabIndex, 0);
    press(attentionCard, ' ');
    assert.equal(stateManager.getSnapshot().primaryNav, 'project');

    stateManager.setViewportMode('mobile');
    stateManager.setPrimaryNav('manage', undefined, 'environments');
    stateManager.closeEnvironmentDetail(false);
    const environmentCard = dom.window.document.querySelector(
      '.env-master-card[data-env="env-ready"]'
    ) as HTMLElement;
    assert.ok(environmentCard);
    assert.equal(environmentCard.tagName, 'BUTTON');
    assert.equal(environmentCard.tabIndex, 0);
    press(environmentCard, 'Enter');
    assert.equal(stateManager.getSnapshot().environmentViewMode, 'detail');
    assert.ok(dom.window.document.querySelector('.env-detail-card'));
  } finally {
    await cleanup();
  }
});

test('Feed & Attention: exercises 7-state realistic matrix via top harness control', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // Verify top dropdowns are cleanly removed from DOM per owner review
    assert.equal(document.querySelector('#top-state-matrix-select'), null, 'top-state-matrix-select removed');
    assert.equal(document.querySelector('#top-layout-select'), null, 'top-layout-select removed');
    assert.equal(document.querySelector('#scenario-jumper'), null, 'scenario-jumper removed');

    const selectStatePreset = (preset: string) => {
      stateManager.setPrimaryNav('feed');
      stateManager.setFeedStatePreset(preset as any);
    };

    // 1. Empty State
    selectStatePreset('empty');
    assert.equal(document.querySelectorAll('.attention-card').length, 0, '0 attention items in empty state');
    assert.ok(document.querySelector('.attention-empty-box'), 'Empty state box rendered');

    // 2. Healthy State
    selectStatePreset('healthy');
    assert.equal(document.querySelectorAll('.attention-card').length, 0, '0 blockers in healthy state');
    assert.ok(document.querySelectorAll('.active-task-card').length >= 1, 'Active tasks rendered');

    // 3. Stale State
    selectStatePreset('stale');
    assert.ok(document.querySelectorAll('.attention-card').length >= 2, 'Stale telemetry items rendered');

    // 4. Pending State
    selectStatePreset('pending');
    assert.ok(document.querySelectorAll('.attention-card').length >= 2, 'Pending proposed tasks rendered');

    // 5. Degraded State
    selectStatePreset('degraded');
    assert.ok(document.querySelectorAll('.attention-card').length >= 2, 'Degraded host items rendered');

    // 6. Intervention State
    selectStatePreset('intervention');
    assert.equal(document.querySelectorAll('.attention-card').length, 2, '2 intervention items rendered');

    // 7. Mixed Default State
    selectStatePreset('mixed');
    assert.equal(document.querySelectorAll('.attention-card').length, 6, 'Mixed state restored with 6 items');
  } finally {
    await cleanup();
  }
});

test('Feed presets keep neutral current references and activate every target', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const presets = ['mixed', 'empty', 'healthy', 'stale', 'pending', 'degraded', 'intervention'] as const;
    const hostBoundaryPatterns = [
      /mac-studio-primary/i,
      /win-dev-box/i,
      /mac-laptop-pending/i,
      /macbook air/i,
      /sprout-wk-/i,
      /windows host/i,
      /windows worker/i,
      /(?:100\.64\.|192\.168\.|127\.0\.0\.1)/i,
      /(?:\/Users\/|C:\\Users\\)/i,
      /(?:api[_-]?key|private[_-]?key|password)\s*[:=]/i,
    ];
    const authoritativeTasks = structuredClone(stateManager.getSnapshot().tasks);
    const authoritativeEnvironments = structuredClone(stateManager.getSnapshot().environments);
    const authoritativeAttention = structuredClone(stateManager.getSnapshot().attentionItems);
    const authoritativeActivity = structuredClone(stateManager.getSnapshot().activityFeedItems);

    const restoreFeed = (preset: typeof presets[number]) => {
      stateManager.clearReturnContext();
      stateManager.closeInspector();
      stateManager.closeTaskDetail(false);
      stateManager.closeEnvironmentDetail(false);
      stateManager.setPrimaryNav('feed');
      stateManager.setFeedStatePreset(preset);
    };

    for (const preset of presets) {
      restoreFeed(preset);
      const snapshot = stateManager.getSnapshot();
      const scenario = snapshot.feedScenarioSnapshot;
      assert.ok(scenario, `${preset} creates an isolated Feed snapshot`);
      assert.equal(scenario.preset, preset);

      // The preset projection is the Feed's public boundary. Check both its
      // serialized facts and the text actually rendered for an operator.
      const projection = JSON.stringify(scenario);
      const renderedFeed = dom.window.document.querySelector('.feed-view')?.textContent ?? '';
      for (const pattern of hostBoundaryPatterns) {
        assert.doesNotMatch(projection, pattern, `${preset} projection has no legacy host identity (${pattern})`);
        assert.doesNotMatch(renderedFeed, pattern, `${preset} DOM has no legacy host identity (${pattern})`);
      }

      assert.deepEqual(snapshot.tasks, authoritativeTasks, `${preset} does not mutate Task authority`);
      assert.deepEqual(snapshot.environments, authoritativeEnvironments, `${preset} does not mutate Environment authority`);
      assert.deepEqual(snapshot.attentionItems, authoritativeAttention, `${preset} does not replace source attention`);
      assert.deepEqual(snapshot.activityFeedItems, authoritativeActivity, `${preset} does not replace source activity`);

      for (const taskId of scenario.activeTaskIds) {
        assert.ok(snapshot.tasks.some((task) => task.id === taskId), `${preset} active Task ${taskId} exists`);
      }
      for (const environmentId of scenario.degradedEnvironmentIds) {
        assert.ok(
          snapshot.environments.some((environment) => environment.id === environmentId),
          `${preset} degraded Environment ${environmentId} exists`
        );
      }

      for (const item of scenario.attentionItems) {
        if (item.referenceType === 'task') {
          const task = snapshot.tasks.find((candidate) => candidate.id === item.referenceId);
          assert.ok(task, `${preset} attention ${item.id} references an existing Task`);
          assert.equal(item.actionTargetView, 'tasks');
          assert.equal(item.targetNav, 'project');
          assert.equal(item.targetProjectTab, 'tasks');
          if (item.projectId) assert.equal(item.projectId, task?.projectId, `${item.id} keeps Task project context`);
        } else if (item.referenceType === 'environment') {
          assert.ok(
            snapshot.environments.some((candidate) => candidate.id === item.referenceId),
            `${preset} attention ${item.id} references an existing Environment`
          );
          assert.equal(item.actionTargetView, 'environments');
          assert.equal(item.targetNav, 'manage');
          assert.equal(item.targetManageTab, 'environments');
        } else if (item.referenceType === 'routing_batch') {
          const batch = snapshot.routingBatches.find((candidate) => candidate.id === item.referenceId);
          assert.ok(batch, `${preset} attention ${item.id} references an existing routing batch`);
          assert.equal(item.actionTargetView, 'chat');
          assert.equal(item.targetNav, 'project');
          assert.equal(item.targetProjectTab, 'chat');
          if (item.projectId) assert.equal(item.projectId, batch?.projectId, `${item.id} keeps routing project context`);
        }

        restoreFeed(preset);
        const card = dom.window.document.querySelector(`[data-attention-id="${item.id}"]`) as HTMLButtonElement | null;
        assert.ok(card, `${preset} renders attention target ${item.id}`);
        card.click();
        const linked = stateManager.getSnapshot();
        if (item.referenceType === 'task') {
          assert.equal(linked.primaryNav, 'project', `${item.id} opens Project`);
          assert.equal(linked.projectTab, 'tasks', `${item.id} opens Tasks`);
          assert.equal(linked.taskViewMode, 'detail', `${item.id} opens Task detail`);
          assert.equal(linked.selectedTaskId, item.referenceId, `${item.id} selects its Task`);
        } else if (item.referenceType === 'environment') {
          assert.equal(linked.primaryNav, 'manage', `${item.id} opens Manage`);
          assert.equal(linked.manageTab, 'environments', `${item.id} opens Environments`);
          assert.equal(linked.environmentViewMode, 'detail', `${item.id} opens Environment detail`);
          assert.equal(linked.selectedEnvironmentId, item.referenceId, `${item.id} selects its Environment`);
        } else if (item.referenceType === 'routing_batch') {
          assert.equal(linked.primaryNav, 'project', `${item.id} opens Project Chat`);
          assert.equal(linked.projectTab, 'chat', `${item.id} opens Chat`);
          assert.equal(linked.chatViewMode, 'detail', `${item.id} opens Chat detail`);
          assert.equal(linked.inspectorSheet.isOpen, true, `${item.id} opens routing inspector`);
          assert.equal(linked.inspectorSheet.kind, 'routing', `${item.id} opens routing inspector kind`);
          assert.equal(linked.inspectorSheet.entityId, item.referenceId, `${item.id} preserves batch id`);
          assert.ok(dom.window.document.querySelector('.inspector-overlay'), `${item.id} renders routing inspector`);
          assert.match(
            dom.window.document.querySelector('.inspector-sheet')?.textContent ?? '',
            new RegExp(`Batch ID:.*${item.referenceId}`),
            `${item.id} renders its batch detail`
          );
        }
      }

      for (const activity of scenario.activityFeedItems) {
        if (!activity.targetEntityId) continue;
        if (activity.targetManageTab === 'environments') {
          assert.ok(
            snapshot.environments.some((environment) => environment.id === activity.targetEntityId),
            `${preset} activity ${activity.id} references an existing Environment`
          );
        } else if (activity.targetProjectTab === 'tasks') {
          assert.ok(
            snapshot.tasks.some((task) => task.id === activity.targetEntityId),
            `${preset} activity ${activity.id} references an existing Task`
          );
        } else if (activity.kind === 'routing_batch' && activity.targetProjectTab === 'chat') {
          assert.ok(
            snapshot.routingBatches.some((batch) => batch.id === activity.targetEntityId),
            `${preset} activity ${activity.id} references an existing routing batch`
          );
        } else {
          assert.fail(`${preset} activity ${activity.id} has an unsupported target entity`);
        }

        restoreFeed(preset);
        const row = dom.window.document.querySelector(`[data-act-id="${activity.id}"]`) as HTMLButtonElement | null;
        assert.ok(row, `${preset} renders activity target ${activity.id}`);
        row.click();
        const linked = stateManager.getSnapshot();
        if (activity.targetManageTab === 'environments') {
          assert.equal(linked.primaryNav, 'manage', `${activity.id} opens Manage`);
          assert.equal(linked.manageTab, 'environments', `${activity.id} opens Environments`);
          assert.equal(linked.environmentViewMode, 'detail', `${activity.id} opens Environment detail`);
          assert.equal(linked.selectedEnvironmentId, activity.targetEntityId);
        } else {
          if (activity.kind === 'routing_batch' && activity.targetProjectTab === 'chat') {
            assert.equal(linked.primaryNav, 'project', `${activity.id} opens Project Chat`);
            assert.equal(linked.projectTab, 'chat', `${activity.id} opens Chat`);
            assert.equal(linked.chatViewMode, 'detail', `${activity.id} opens Chat detail`);
            assert.equal(linked.inspectorSheet.isOpen, true, `${activity.id} opens routing inspector`);
            assert.equal(linked.inspectorSheet.kind, 'routing', `${activity.id} opens routing inspector kind`);
            assert.equal(linked.inspectorSheet.entityId, activity.targetEntityId, `${activity.id} preserves batch id`);
            assert.ok(dom.window.document.querySelector('.inspector-overlay'), `${activity.id} renders routing inspector`);
            assert.match(
              dom.window.document.querySelector('.inspector-sheet')?.textContent ?? '',
              new RegExp(`Batch ID:.*${activity.targetEntityId}`),
              `${activity.id} renders its batch detail`
            );
          } else {
            assert.equal(linked.primaryNav, 'project', `${activity.id} opens Project`);
            assert.equal(linked.projectTab, 'tasks', `${activity.id} opens Tasks`);
            assert.equal(linked.taskViewMode, 'detail', `${activity.id} opens Task detail`);
            assert.equal(linked.selectedTaskId, activity.targetEntityId);
          }
        }
      }
    }
  } finally {
    await cleanup();
  }
});

test('Feed routing targets preserve their batch id and open the authoritative inspector', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    stateManager.setPrimaryNav('feed');
    stateManager.setFeedStatePreset('degraded');
    const attentionTarget = dom.window.document.querySelector(
      '[data-attention-id="att-deg-3"]'
    ) as HTMLButtonElement | null;
    assert.ok(attentionTarget);
    attentionTarget.click();

    let snapshot = stateManager.getSnapshot();
    assert.equal(snapshot.inspectorSheet.entityId, 'batch-004');
    assert.equal(snapshot.inspectorSheet.isOpen, true);
    assert.equal(snapshot.inspectorSheet.kind, 'routing');
    assert.match(dom.window.document.querySelector('.inspector-sheet')?.textContent ?? '', /Batch ID:.*batch-004/);

    stateManager.closeInspector();
    stateManager.clearReturnContext();
    stateManager.setPrimaryNav('feed');
    stateManager.setFeedStatePreset('mixed');
    const activityTarget = dom.window.document.querySelector('[data-act-id="act-6"]') as HTMLButtonElement | null;
    assert.ok(activityTarget);
    activityTarget.click();

    snapshot = stateManager.getSnapshot();
    assert.equal(snapshot.inspectorSheet.entityId, 'batch-002');
    assert.equal(snapshot.inspectorSheet.isOpen, true);
    assert.equal(snapshot.inspectorSheet.kind, 'routing');
    assert.match(dom.window.document.querySelector('.inspector-sheet')?.textContent ?? '', /Batch ID:.*batch-002/);
  } finally {
    await cleanup();
  }
});
