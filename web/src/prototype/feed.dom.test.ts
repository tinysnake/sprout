import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



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

test('Feed filters expose their current selection after rerender', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;
    const allUrgency = document.querySelector('.urgency-pill-btn[data-severity="all"]') as HTMLButtonElement;
    const actionUrgency = document.querySelector(
      '.urgency-pill-btn[data-severity="action_required"]'
    ) as HTMLButtonElement;
    assert.equal(allUrgency.getAttribute('aria-pressed'), 'true');
    assert.equal(actionUrgency.getAttribute('aria-pressed'), 'false');

    actionUrgency.click();

    assert.equal(
      document.querySelector('.urgency-pill-btn[data-severity="action_required"]')?.getAttribute('aria-pressed'),
      'true'
    );
    assert.equal(
      document.querySelector('.urgency-pill-btn[data-severity="all"]')?.getAttribute('aria-pressed'),
      'false'
    );

    const allActivity = document.querySelector('.activity-filter-pill-btn[data-act-filter="all"]') as HTMLButtonElement;
    const taskActivity = document.querySelector('.activity-filter-pill-btn[data-act-filter="tasks"]') as HTMLButtonElement;
    assert.equal(allActivity.getAttribute('aria-pressed'), 'true');
    assert.equal(taskActivity.getAttribute('aria-pressed'), 'false');

    taskActivity.click();

    assert.equal(
      document.querySelector('.activity-filter-pill-btn[data-act-filter="tasks"]')?.getAttribute('aria-pressed'),
      'true'
    );
    assert.equal(
      document.querySelector('.activity-filter-pill-btn[data-act-filter="all"]')?.getAttribute('aria-pressed'),
      'false'
    );
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
