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

    // 2. Verify Scope Filter Bar
    const scopeChips = document.querySelectorAll('.scope-chip-btn');
    assert.ok(scopeChips.length >= 3, 'Scope chips rendered for all, projects, and infrastructure');

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
    assert.equal(document.querySelectorAll('.attention-card').length, 4, 'All 4 attention items initially');
    assert.equal(document.querySelectorAll('.active-task-card').length, 1, '1 active task in all scope');

    // Click O7 Minesweeper Scope Chip
    const minesweeperChip = document.querySelector('.scope-chip-btn[data-scope="proj-minesweeper"]') as HTMLButtonElement;
    assert.ok(minesweeperChip, 'O7 Minesweeper scope chip found');
    minesweeperChip.click();

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

    // Switch Scope to Infrastructure via Chip
    const infraChip = document.querySelector('.scope-chip-btn[data-scope="infrastructure"]') as HTMLButtonElement;
    assert.ok(infraChip, 'Infrastructure scope chip found');
    infraChip.click();

    // Verify Attention items filtered to infrastructure
    const infraCards = document.querySelectorAll('.attention-card');
    assert.equal(infraCards.length, 1, '1 generic infrastructure attention item (MacBook Air enrollment)');
    assert.match(infraCards[0]?.textContent ?? '', /Pending Worker Enrollment: MacBook Air/);

    // Verify 0 active tasks under Infrastructure
    assert.equal(document.querySelectorAll('.active-task-card').length, 0, '0 active tasks under infrastructure');

    // Reset to All
    const allChip = document.querySelector('.scope-chip-btn[data-scope="all"]') as HTMLButtonElement;
    allChip.click();
    assert.equal(document.querySelectorAll('.attention-card').length, 4, 'Reset to all 4 attention items');
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
    assert.equal(redCards.length, 2, '2 action required cards (Task #104 recovery & Task #103 blocker)');

    // Filter by Pending Approval (Validation & Enrollment)
    const warningPill = document.querySelector('.urgency-pill-btn[data-severity="attention"]') as HTMLButtonElement;
    assert.ok(warningPill);
    warningPill.click();

    const yellowCards = document.querySelectorAll('.attention-card');
    assert.equal(yellowCards.length, 2, '2 pending approval cards (Task #101 claim & MacAir enrollment)');

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
    assert.equal(document.querySelectorAll('.attention-card').length, 4, 'Restored all 4 items');
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

    // 1. Select O7 Minesweeper scope
    const minesweeperChip = document.querySelector('.scope-chip-btn[data-scope="proj-minesweeper"]') as HTMLButtonElement;
    minesweeperChip.click();

    // 2. Click "Review Claim in Tasks →" button on Task #101 card
    const actionBtn = document.querySelector('.attention-action-btn[data-attention-id="att-1"]') as HTMLButtonElement;
    assert.ok(actionBtn);
    actionBtn.click();

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
    const activeChip = document.querySelector('.scope-chip-btn.active') as HTMLButtonElement;
    assert.equal(activeChip.getAttribute('data-scope'), 'proj-minesweeper', 'Scope filter state was preserved on return');
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

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    const selectStatePreset = (preset: string) => {
      const stateSelect = document.querySelector('#top-state-matrix-select') as HTMLSelectElement;
      assert.ok(stateSelect);
      stateSelect.value = preset;
      stateSelect.dispatchEvent(new dom.window.Event('change'));
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
    assert.equal(document.querySelectorAll('.attention-card').length, 4, 'Mixed state restored with 4 items');
  } finally {
    await cleanup();
  }
});
