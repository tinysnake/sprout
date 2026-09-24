import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



async function openSettings() {
  const setup = await setupPrototypeDom();
  const { initPrototype } = (await setup.vite.ssrLoadModule('/src/prototype/prototype.ts')) as typeof import('./prototype.js');
  const { stateManager } = (await setup.vite.ssrLoadModule('/src/prototype/state.ts')) as typeof import('./state.js');
  const appMount = setup.dom.window.document.getElementById('app');
  assert.ok(appMount);
  initPrototype(appMount);
  stateManager.setPrimaryNav('manage', undefined, 'settings');
  return { ...setup, stateManager, document: setup.dom.window.document };
}

test('Settings renders the bounded access, compatibility, data, diagnostic, and boundary model', async () => {
  const { document, cleanup } = await openSettings();
  try {
    assert.ok(document.querySelector('.settings-view'));
    assert.match(document.body.textContent ?? '', /General & Operator Settings/);
    assert.match(document.body.textContent ?? '', /Operator identity and access boundary/);
    assert.match(document.body.textContent ?? '', /Browser sessions/);
    assert.match(document.body.textContent ?? '', /Credential recovery and rotation/);
    assert.match(document.body.textContent ?? '', /Sprout instance and compatibility/);
    assert.match(document.body.textContent ?? '', /Migration safety and failure visibility/);
    assert.match(document.body.textContent ?? '', /Durable data location/);
    assert.match(document.body.textContent ?? '', /Sanitized diagnostics/);
    assert.match(document.body.textContent ?? '', /Web routine operation versus host-local administration/);
    assert.match(document.body.textContent ?? '', /Environment recovery and Force Release remain in Manage \/ Environments/);
    assert.equal(document.querySelectorAll('[data-settings-state]').length >= 6, true);
    assert.match(document.body.textContent ?? '', /Loading/);
    assert.match(document.body.textContent ?? '', /Human-approved three-category structure/);
    assert.match(document.body.textContent ?? '', /docs\/prototype-settings-operator\.md/);
    assert.doesNotMatch(document.body.textContent ?? '', /\/Users\//);
    assert.doesNotMatch(document.body.textContent ?? '', /C:\\Users/);
  } finally {
    await cleanup();
  }
});

test('Settings treats the Human-approved three-category structure as authoritative evidence', async () => {
  const { document, stateManager, cleanup } = await openSettings();
  try {
    const settings = stateManager.getSnapshot().settings;
    const artifact = await readFile(new URL('../../../docs/prototype-settings-operator.md', import.meta.url), 'utf8');
    const reviewText = document.querySelector('[data-settings-section="review"]')?.textContent ?? '';

    assert.equal(settings.review.status, 'approved');
    assert.deepEqual(settings.review.approvedDecisions, [
      'The Manage > Settings surface uses Access & Security, Instance & System, and Data & Diagnostics as its three operator categories.',
      'Review evidence and state coverage remain available below the categories without becoming a fourth settings category.',
      'The Settings surface keeps Environment recovery and Force Release in Manage > Environments.',
    ]);
    for (const category of ['Access & Security', 'Instance & System', 'Data & Diagnostics']) {
      assert.match(reviewText, new RegExp(category.replaceAll('&', '\\&')));
      assert.match(artifact, new RegExp(category.replaceAll('&', '\\&')));
    }
    for (const value of [reviewText, artifact]) {
      assert.doesNotMatch(value, /Pending owner review|unresolved owner preferences|Unresolved preferences|does not claim owner acceptance/i);
    }
  } finally {
    await cleanup();
  }
});

test('Settings revokes browser sessions and makes credential rotation risk-gated', async () => {
  const { document, stateManager, cleanup } = await openSettings();
  try {
    assert.equal(stateManager.getSnapshot().operator.sessionCount, 2);
    (document.querySelector('#btn-revoke-other-sessions') as HTMLButtonElement).click();
    assert.equal(stateManager.getSnapshot().operator.sessionCount, 1);
    assert.equal(stateManager.getSnapshot().settings.browserSessions.filter((session) => session.state === 'revoked').length, 1);
    assert.equal(document.querySelectorAll('.session-revoke-btn').length, 0);

    (document.querySelector('#btn-show-credential-risk') as HTMLButtonElement).click();
    const riskPanel = document.querySelector('#credential-risk-panel') as HTMLElement;
    assert.equal(riskPanel.hidden, false);
    const rotateButton = document.querySelector('#btn-rotate-credential') as HTMLButtonElement;
    assert.equal(rotateButton.disabled, true);
    (document.querySelector('#credential-risk-checkbox') as HTMLInputElement).click();
    const confirmInput = document.querySelector('#credential-risk-confirm') as HTMLInputElement;
    confirmInput.value = 'ROTATE CREDENTIAL';
    confirmInput.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    assert.equal(rotateButton.disabled, false);
    rotateButton.click();
    assert.equal(stateManager.getSnapshot().settings.credentials.state, 'rotation-complete');
    assert.equal(stateManager.getSnapshot().settings.browserSessions.filter((session) => session.state === 'revoked').length, 1);
    assert.match(document.body.textContent ?? '', /Rotated just now/);
    assert.match(document.body.textContent ?? '', /Revoked by credential rotation/);
  } finally {
    await cleanup();
  }
});

test('Settings keeps sanitized export and durable-data actions observable without backend behavior', async () => {
  const { document, stateManager, cleanup } = await openSettings();
  try {
    (document.querySelector('#btn-export-diagnostics') as HTMLButtonElement).click();
    assert.equal(stateManager.getSnapshot().settings.diagnostics.state, 'exported');
    assert.match(document.body.textContent ?? '', /Prepared just now/);
    (document.querySelector('#btn-copy-data-location') as HTMLButtonElement).click();
    assert.equal(stateManager.getSnapshot().settings.durableData.copyState, 'copied');
    assert.match(document.body.textContent ?? '', /Location copied/);

    const settings = stateManager.getSnapshot().settings;
    assert.ok(settings.diagnostics.excludedFacts.some((fact) => fact.includes('Credentials')));
    assert.ok(settings.diagnostics.excludedFacts.some((fact) => fact.includes('Message content')));
    assert.match(settings.diagnostics.hostFallback, /host-local diagnostic command/);
    assert.match(settings.durableData.backupBoundary, /not a Web backup or restore workflow/);
  } finally {
    await cleanup();
  }
});

test('Settings keeps phone and desktop surfaces equivalent with approved review evidence', async () => {
  const { document, stateManager, cleanup } = await openSettings();
  try {
    const sectionsBefore = document.querySelectorAll('[data-settings-section]').length;
    stateManager.setViewportMode('desktop');
    assert.equal(document.querySelector('.viewport-stage')?.classList.contains('mode-desktop'), true);
    assert.equal(document.querySelectorAll('[data-settings-section]').length, sectionsBefore);
    stateManager.setViewportMode('mobile');
    assert.equal(document.querySelector('.viewport-stage')?.classList.contains('mode-mobile'), true);
    assert.match(document.body.textContent ?? '', /Approved owner review/);
    assert.match(document.body.textContent ?? '', /downstream non-goals remain explicit/i);
    assert.doesNotMatch(document.body.textContent ?? '', /Pending owner review|Unresolved preferences|final fourth-tab label|does not claim owner acceptance/i);
  } finally {
    await cleanup();
  }
});

test('Settings switches between the three categories (Access, System, Data)', async () => {
  const { document, stateManager, cleanup } = await openSettings();
  try {
    const accessTabBtn = document.querySelector('.settings-sub-tab[data-settings-tab="access"]') as HTMLButtonElement;
    const systemTabBtn = document.querySelector('.settings-sub-tab[data-settings-tab="system"]') as HTMLButtonElement;
    const dataTabBtn = document.querySelector('.settings-sub-tab[data-settings-tab="data"]') as HTMLButtonElement;
    assert.ok(accessTabBtn && systemTabBtn && dataTabBtn);

    // Initial state is 'access'
    assert.equal(stateManager.getSnapshot().settingsCategoryTab, 'access');
    assert.equal(document.querySelector('.settings-tab-panel[data-settings-tab-panel="access"]')?.classList.contains('is-active'), true);
    assert.equal(document.querySelector('.settings-tab-panel[data-settings-tab-panel="system"]')?.classList.contains('is-active'), false);

    // Click System tab
    systemTabBtn.click();
    assert.equal(stateManager.getSnapshot().settingsCategoryTab, 'system');
    assert.equal(document.querySelector('.settings-tab-panel[data-settings-tab-panel="system"]')?.classList.contains('is-active'), true);
    assert.equal(document.querySelector('.settings-tab-panel[data-settings-tab-panel="access"]')?.classList.contains('is-active'), false);

    // Click Data tab
    dataTabBtn.click();
    assert.equal(stateManager.getSnapshot().settingsCategoryTab, 'data');
    assert.equal(document.querySelector('.settings-tab-panel[data-settings-tab-panel="data"]')?.classList.contains('is-active'), true);
    assert.equal(document.querySelector('.settings-tab-panel[data-settings-tab-panel="system"]')?.classList.contains('is-active'), false);

    // Click Status strip shortcut for Access
    const statusAccess = document.querySelector('[data-status-tab="access"]') as HTMLElement;
    assert.ok(statusAccess);
    statusAccess.click();
    assert.equal(stateManager.getSnapshot().settingsCategoryTab, 'access');
    assert.equal(document.querySelector('.settings-tab-panel[data-settings-tab-panel="access"]')?.classList.contains('is-active'), true);
  } finally {
    await cleanup();
  }
});
