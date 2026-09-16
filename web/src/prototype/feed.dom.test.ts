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

test('Feed & Attention: renders three-tier structure and supports category filtering', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // 1. Verify Feed Landing Surface is default destination
    const feedHeader = document.querySelector('.feed-header');
    assert.ok(feedHeader, 'Feed header rendered');
    assert.match(feedHeader.textContent ?? '', /Operations Feed & Human Attention/);

    // 2. Verify Prominent Human Attention section exists
    const attentionSection = document.querySelector('.attention-section');
    assert.ok(attentionSection, 'Attention section rendered');
    assert.match(attentionSection.textContent ?? '', /Human Attention Required/);

    // 3. Verify Active In-Flight Work snapshot exists
    const activeWorkSection = document.querySelector('.active-work-section');
    assert.ok(activeWorkSection, 'Active work section rendered');
    assert.match(activeWorkSection.textContent ?? '', /Live In-Flight Work/);

    // 4. Verify Recent Operational Activity stream exists
    const activitySection = document.querySelector('.activity-section');
    assert.ok(activitySection, 'Activity section rendered');
    assert.match(activitySection.textContent ?? '', /Recent Operational Activity/);

    // 5. Test Attention Category Filtering
    const allChips = document.querySelectorAll('.chip-btn[data-att-filter]');
    assert.ok(allChips.length >= 6, 'Category filter chips present');

    const initialCards = document.querySelectorAll('.attention-card');
    assert.equal(initialCards.length, 4, 'Default state has 4 attention items');

    // Click 'Validation' filter chip
    const valChip = document.querySelector('.chip-btn[data-att-filter="task_validation"]') as HTMLButtonElement;
    assert.ok(valChip);
    valChip.click();

    const valCards = document.querySelectorAll('.attention-card');
    assert.equal(valCards.length, 1, 'Only 1 validation claim card visible');
    assert.match(valCards[0]?.textContent ?? '', /Task #101 Awaiting Human Validation/);

    // Click 'Blockers' filter chip
    const blockChip = document.querySelector('.chip-btn[data-att-filter="task_blocker"]') as HTMLButtonElement;
    assert.ok(blockChip);
    blockChip.click();

    const blockCards = document.querySelectorAll('.attention-card');
    assert.equal(blockCards.length, 1, 'Only 1 blocker card visible');
    assert.match(blockCards[0]?.textContent ?? '', /Task #103 Blocked on Asset Permission/);

    // Reset to 'All'
    const allChip = document.querySelector('.chip-btn[data-att-filter="all"]') as HTMLButtonElement;
    allChip.click();
    assert.equal(document.querySelectorAll('.attention-card').length, 4, 'Reset to all 4 attention items');
  } finally {
    await cleanup();
  }
});

test('Feed & Attention: deep-links into Task and Environment views with return breadcrumb', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // 1. Click "Review Claim in Tasks →" button on Task #101 attention card
    const actionBtn = document.querySelector('.attention-action-btn[data-attention-id="att-1"]') as HTMLButtonElement;
    assert.ok(actionBtn, 'Validation action button found');
    actionBtn.click();

    // Verify navigation landed on Project > Tasks with Task #101 selected
    assert.ok(document.querySelector('.projects-view'), 'Navigated to Project view');
    const returnBanner = document.querySelector('.return-context-banner');
    assert.ok(returnBanner, 'Return context breadcrumb banner is visible');
    assert.match(returnBanner.textContent ?? '', /← Back to Feed/);

    // 2. Click "← Back to Feed" to return to Feed
    const returnBtn = document.querySelector('#btn-pop-return') as HTMLButtonElement;
    assert.ok(returnBtn);
    returnBtn.click();

    // Verify back on Feed
    assert.ok(document.querySelector('.feed-view'), 'Returned to Feed view');
    assert.equal(document.querySelector('.return-context-banner'), null, 'Return banner dismissed');

    // 3. Click "Review Enrollment in Envs →" on MacBook Air attention card
    const envActionBtn = document.querySelector('.attention-action-btn[data-attention-id="att-4"]') as HTMLButtonElement;
    assert.ok(envActionBtn, 'Environment action button found');
    envActionBtn.click();

    // Verify navigated to Manage > Environments
    assert.ok(document.querySelector('.manage-view'), 'Navigated to Manage Environments view');
    assert.ok(document.querySelector('.return-context-banner'), 'Return banner present in Envs');

    // Return to Feed again
    (document.querySelector('#btn-pop-return') as HTMLButtonElement).click();
    assert.ok(document.querySelector('.feed-view'), 'Returned to Feed');
  } finally {
    await cleanup();
  }
});

test('Feed & Attention: exercises full 7-state realistic matrix', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // Helper to click state preset pill
    const selectPreset = (preset: string) => {
      const pill = document.querySelector(`.feed-pill-btn[data-preset="${preset}"]`) as HTMLButtonElement;
      assert.ok(pill, `Preset pill for ${preset} exists`);
      pill.click();
    };

    // 1. Empty State (All Clear)
    selectPreset('empty');
    assert.equal(document.querySelectorAll('.attention-card').length, 0, '0 attention items in empty state');
    const emptyBox = document.querySelector('.attention-empty-box');
    assert.ok(emptyBox, 'Empty state box rendered');
    assert.match(emptyBox.textContent ?? '', /All Attention Items Cleared/);

    // 2. Healthy Active State
    selectPreset('healthy');
    assert.equal(document.querySelectorAll('.attention-card').length, 0, '0 blockers in healthy state');
    const activeCards = document.querySelectorAll('.active-task-card');
    assert.ok(activeCards.length >= 1, 'Active tasks rendered in healthy state');

    // 3. Stale Telemetry State
    selectPreset('stale');
    const staleCards = document.querySelectorAll('.attention-card');
    assert.ok(staleCards.length >= 2, 'Stale telemetry attention items rendered');
    assert.match(document.querySelector('.attention-items-list')?.textContent ?? '', /Stale Heartbeat on mac-studio-primary/);

    // 4. Pending Approvals State
    selectPreset('pending');
    const pendingCards = document.querySelectorAll('.attention-card');
    assert.ok(pendingCards.length >= 2, 'Pending proposed tasks rendered');
    assert.match(document.querySelector('.attention-items-list')?.textContent ?? '', /Proposed Task #105/);

    // 5. Degraded Host State
    selectPreset('degraded');
    const degradedCards = document.querySelectorAll('.attention-card');
    assert.ok(degradedCards.length >= 2, 'Degraded host attention items rendered');
    assert.match(document.querySelector('.attention-items-list')?.textContent ?? '', /Windows Worker Offline/);

    // 6. Intervention State
    selectPreset('intervention');
    const intCards = document.querySelectorAll('.attention-card');
    assert.equal(intCards.length, 2, '2 intervention items rendered (blocker + validation)');
    assert.match(document.querySelector('.attention-items-list')?.textContent ?? '', /Task #103 Blocked on Spatial Audio Asset/);

    // 7. Mixed Default State
    selectPreset('mixed');
    assert.equal(document.querySelectorAll('.attention-card').length, 4, 'Mixed state restored with 4 items');
  } finally {
    await cleanup();
  }
});

test('Feed & Attention: switches layout variants (Unified, Split Board, Project Grouped)', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // Helper to click variant button
    const selectVariant = (variant: string) => {
      const btn = document.querySelector(`.segmented-btn[data-variant="${variant}"]`) as HTMLButtonElement;
      assert.ok(btn, `Variant button for ${variant} exists`);
      btn.click();
    };

    // 1. Default: Variant A (Unified Stream)
    assert.ok(document.querySelector('.feed-layout-unified'), 'Unified layout rendered by default');

    // 2. Switch to Variant B: Split Board
    selectVariant('split-board');
    assert.ok(document.querySelector('.feed-layout-split-board'), 'Split board layout rendered');
    assert.ok(document.querySelector('.split-board-columns'), 'Split board 2-column container present');

    // Test mobile tab switch in Split Board
    const tabAct = document.querySelector('#split-tab-act') as HTMLButtonElement;
    assert.ok(tabAct, 'Mobile activity tab switcher button exists');
    tabAct.click();
    const rightCol = document.querySelector('.split-col-right');
    assert.ok(rightCol?.classList.contains('mobile-visible'), 'Activity column became mobile visible');

    // 3. Switch to Variant C: Project Grouped
    selectVariant('project-grouped');
    assert.ok(document.querySelector('.feed-layout-project-grouped'), 'Project grouped layout rendered');
    const projectCards = document.querySelectorAll('.feed-project-card');
    assert.ok(projectCards.length >= 2, 'Rendered project cards and infrastructure card');

    // Switch back to Variant A
    selectVariant('unified');
    assert.ok(document.querySelector('.feed-layout-unified'), 'Returned to Unified layout');
  } finally {
    await cleanup();
  }
});

test('Feed & Attention: Owner review drawer displays Ticket #62 decisions and verification criteria', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // Open review drawer
    const reviewBtn = document.querySelector('#open-review-btn') as HTMLButtonElement;
    assert.ok(reviewBtn);
    reviewBtn.click();

    const drawer = document.querySelector('.review-drawer');
    assert.ok(drawer, 'Review drawer is open');
    assert.match(drawer.textContent ?? '', /Product Owner Review: Feed & Attention Experience/);
    assert.match(drawer.textContent ?? '', /Ticket #62 Acceptance Criteria Verification/);
    assert.match(drawer.textContent ?? '', /Accepted Feed Decisions/);
    assert.match(drawer.textContent ?? '', /Rejected Patterns/);

    // Close review drawer
    const closeBtn = document.querySelector('.close-review-btn') as HTMLButtonElement;
    assert.ok(closeBtn);
    closeBtn.click();
    assert.equal(document.querySelector('.review-drawer'), null, 'Review drawer closed');
  } finally {
    await cleanup();
  }
});
