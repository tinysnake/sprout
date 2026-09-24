import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



test('prototype shell mounts, renders 3-destination hierarchy, and supports theme/density toggles', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount, 'App mount container exists');
    initPrototype(appMount);

    const document = dom.window.document;
    const getProtoApp = () => document.querySelector('#prototype-app');
    assert.ok(getProtoApp(), '#prototype-app rendered');
    assert.equal(getProtoApp()?.getAttribute('data-theme'), 'dark', 'default theme is dark');
    assert.equal(getProtoApp()?.getAttribute('data-density'), 'comfortable', 'default density is comfortable');

    // 1. Check Top Header & Operator Pill
    const brand = document.querySelector('.proto-brand');
    assert.match(brand?.textContent ?? '', /Sprout Mobile Operator/);
    const operatorPill = document.querySelector('.operator-pill');
    assert.match(operatorPill?.textContent ?? '', /Lead Technical Operator/);

    // 2. Test Theme Toggle
    (document.querySelector('#top-theme-btn') as HTMLButtonElement).click();
    assert.equal(getProtoApp()?.getAttribute('data-theme'), 'light', 'toggled to light theme');

    (document.querySelector('#top-theme-btn') as HTMLButtonElement).click();
    assert.equal(getProtoApp()?.getAttribute('data-theme'), 'dark', 'toggled back to dark theme');

    // 3. Test Density Toggle
    (document.querySelector('#top-density-btn') as HTMLButtonElement).click();
    assert.equal(getProtoApp()?.getAttribute('data-density'), 'compact', 'toggled to compact density');

    (document.querySelector('#top-density-btn') as HTMLButtonElement).click();
    assert.equal(getProtoApp()?.getAttribute('data-density'), 'comfortable', 'toggled back to comfortable density');

    // 4. Test Viewport Switcher
    const getStage = () => document.querySelector('.viewport-stage');
    assert.ok(getStage()?.classList.contains('mode-mobile'), 'default viewport is mobile phone');

    (document.querySelector('.segmented-btn[data-mode="desktop"]') as HTMLButtonElement).click();
    assert.ok(getStage()?.classList.contains('mode-desktop'), 'switched to desktop viewport');

    (document.querySelector('.segmented-btn[data-mode="fluid"]') as HTMLButtonElement).click();
    assert.ok(getStage()?.classList.contains('mode-fluid'), 'switched to fluid viewport');

    (document.querySelector('.segmented-btn[data-mode="mobile"]') as HTMLButtonElement).click();
    assert.ok(getStage()?.classList.contains('mode-mobile'), 'switched back to mobile viewport');
  } finally {
    await cleanup();
  }
});

test('prototype navigates across Feed, Project, Manage, and Primitives with deep-link return support', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // 1. Initial State: Feed with Attention Section
    assert.ok(document.querySelector('.feed-view'), 'Default view is Feed');
    assert.ok(document.querySelector('.attention-section'), 'Prominent attention section is rendered');
    const attentionCards = document.querySelectorAll('.attention-card');
    assert.ok(attentionCards.length > 0, 'Attention cards are rendered');

    // 2. Click an attention card to test deep linking with return context
    const firstAttentionCard = document.querySelector('.attention-card') as HTMLElement;
    assert.ok(firstAttentionCard, 'Attention card exists');
    firstAttentionCard.click();

    // Now should have return banner
    const returnBanner = document.querySelector('.return-context-banner');
    assert.ok(returnBanner, 'Return context banner rendered');
    assert.match(returnBanner.textContent ?? '', /Back to Feed/);

    // Click Return banner to pop back to Feed
    const returnBtn = document.querySelector('#btn-pop-return') as HTMLButtonElement;
    assert.ok(returnBtn, 'Return button exists');
    returnBtn.click();

    assert.ok(document.querySelector('.feed-view'), 'Returned back to Feed');
    assert.equal(document.querySelector('.return-context-banner'), null, 'Return banner cleared');

    // 3. Navigate to Project via Bottom Nav
    const projectNavBtn = document.querySelector('.bottom-nav-item[data-nav="project"]') as HTMLButtonElement;
    assert.ok(projectNavBtn, 'Project bottom nav button exists');
    projectNavBtn.click();

    assert.ok(document.querySelector('.projects-view'), 'Project view rendered');
    assert.ok(document.querySelector('.project-dropdown-select'), 'Project selector rendered');

    // Toggle Project Sub-tabs: Overview -> Tasks -> Chat
    (document.querySelector('.sub-nav-tab[data-project-tab="tasks"]') as HTMLButtonElement).click();
    assert.ok(document.querySelector('.task-select-btn'), 'Tasks view rendered');

    (document.querySelector('.sub-nav-tab[data-project-tab="chat"]') as HTMLButtonElement).click();
    assert.ok(document.querySelector('.chat-messages-body'), 'Chat timeline rendered');

    // Return to main destinations via dynamic mobile bottom nav back button
    const backBtn = document.querySelector('.bottom-nav-item[data-action="back-to-root"]') as HTMLButtonElement;
    assert.ok(backBtn, 'Back to main navigation button exists');
    backBtn.click();

    // 4. Navigate to Manage via Bottom Nav
    const manageNavBtn = document.querySelector('.bottom-nav-item[data-nav="manage"]') as HTMLButtonElement;
    assert.ok(manageNavBtn, 'Manage bottom nav button exists');
    manageNavBtn.click();

    assert.ok(document.querySelector('.manage-view'), 'Manage view rendered');

    // Switch between Manage tabs: Environments -> Agents -> Usage -> Settings
    (document.querySelector('.sub-nav-tab[data-manage-tab="agents"]') as HTMLButtonElement).click();
    assert.match(document.querySelector('.manage-content-area')?.textContent ?? '', /Agents & Work Option Preferences/);

    (document.querySelector('.sub-nav-tab[data-manage-tab="usage"]') as HTMLButtonElement).click();
    assert.match(document.querySelector('.manage-content-area')?.textContent ?? '', /Usage & Costs/);

    (document.querySelector('.sub-nav-tab[data-manage-tab="settings"]') as HTMLButtonElement).click();
    assert.match(document.querySelector('.manage-content-area')?.textContent ?? '', /General & Operator Settings/);

    // 5. Navigate to Primitives Baseline View
    const primBtn = document.querySelector('#top-primitives-btn') as HTMLButtonElement;
    assert.ok(primBtn, 'Style baseline button exists');
    primBtn.click();

    assert.ok(document.querySelector('.primitives-view'), 'Primitives view rendered');
    assert.ok(document.querySelector('#tokens'), 'Design tokens section rendered');
    assert.ok(document.querySelector('#buttons'), 'Buttons section rendered');
    assert.ok(document.querySelector('#forms'), 'Forms section rendered');
    assert.ok(document.querySelector('#states'), 'States section rendered');
    assert.ok(document.querySelector('#a11y'), 'A11y floors section rendered');
  } finally {
    await cleanup();
  }
});

test('interaction primitives verify state language, traffic-light reasons, danger dialog, and review drawer', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const document = dom.window.document;

    // Open Primitives view
    (document.querySelector('#top-primitives-btn') as HTMLButtonElement).click();

    // 1. Verify Health Indicators have mandatory textual reasons
    const healthRows = document.querySelectorAll('.health-indicator-row');
    assert.equal(healthRows.length, 3, 'Healthy, Degraded, and Offline rows rendered');
    assert.match(healthRows[0]!.textContent ?? '', /HEALTHY \(GREEN\)/);
    assert.match(healthRows[0]!.textContent ?? '', /All 4 engine readiness probes confirmed/);
    assert.match(healthRows[1]!.textContent ?? '', /DEGRADED \(YELLOW\)/);
    assert.match(healthRows[1]!.textContent ?? '', /1\/4 engine offline/);
    assert.match(healthRows[2]!.textContent ?? '', /OFFLINE \(RED\)/);
    assert.match(healthRows[2]!.textContent ?? '', /Heartbeat timed out 8m ago/);

    // 2. Verify Lifecycle Pills
    const lifecyclePills = document.querySelectorAll('.lifecycle-pill');
    assert.ok(lifecyclePills.length >= 7, 'All lifecycle states represented');

    // 3. Verify Provenance Tags
    const provTags = document.querySelectorAll('.provenance-tag');
    assert.ok(provTags.length >= 4, 'Operator, agent, worker, and time tags rendered');

    // 4. Test Danger Confirmation Dialog (Force Release scenario)
    const dangerTrigger = document.querySelector('#trigger-danger-confirm') as HTMLButtonElement;
    assert.ok(dangerTrigger, 'Danger confirm trigger exists');
    dangerTrigger.click();

    const dangerDialog = document.querySelector('.danger-confirm-dialog');
    assert.ok(dangerDialog, 'Danger confirmation dialog rendered');

    const confirmBtn = dangerDialog.querySelector('#dialog-confirm-btn') as HTMLButtonElement;
    assert.ok(confirmBtn.disabled, 'Confirm button is initially disabled');

    const confirmInput = dangerDialog.querySelector('#danger-confirm-input') as HTMLInputElement;
    assert.ok(confirmInput, 'Typed confirmation input exists');

    confirmInput.value = 'wrong text';
    confirmInput.dispatchEvent(new dom.window.Event('input'));
    assert.ok(confirmBtn.disabled, 'Confirm button remains disabled for wrong text');

    confirmInput.value = 'FORCE RELEASE';
    confirmInput.dispatchEvent(new dom.window.Event('input'));
    assert.equal(confirmBtn.disabled, false, 'Confirm button activates when typed correctly');

    const cancelBtn = dangerDialog.querySelector('#dialog-cancel-btn') as HTMLButtonElement;
    cancelBtn.click();
    assert.equal(document.querySelector('.danger-confirm-dialog'), null, 'Danger dialog dismissed on cancel');

    // 5. Test Owner Review Drawer
    const reviewBtn = document.querySelector('#open-review-btn') as HTMLButtonElement;
    assert.ok(reviewBtn, 'Owner review button exists');
    reviewBtn.click();

    const reviewDrawer = document.querySelector('.review-drawer');
    assert.ok(reviewDrawer, 'Review drawer opened');
    assert.match(reviewDrawer.textContent ?? '', /Ticket #61 Acceptance Criteria Verification/);
    assert.match(reviewDrawer.textContent ?? '', /Accepted Baseline Decisions/);
    assert.match(reviewDrawer.textContent ?? '', /Rejected Patterns/);
    assert.match(reviewDrawer.textContent ?? '', /Settled Clarifications/);
    assert.match(reviewDrawer.textContent ?? '', /Reuse & Revision Rules for Later Module Tickets/);

    const closeReviewBtn = reviewDrawer.querySelector('.close-review-btn') as HTMLButtonElement;
    closeReviewBtn.click();
    assert.equal(document.querySelector('.review-drawer'), null, 'Review drawer closed');
  } finally {
    await cleanup();
  }
});
