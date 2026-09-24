import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



test('Agents: header Create and Guide buttons open correctly styled modal dialogs', async () => {
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

    stateManager.setPrimaryNav('manage', undefined, 'agents');
    const document = dom.window.document;

    // Search box is intentionally removed from the Agents header
    assert.equal(document.querySelector('.agent-search-input'), null, 'No agent search box rendered');

    // 1. Guide dialog opens with repo-standard modal primitives and is actually wired
    const guideBtn = document.querySelector('#btn-agent-guide') as HTMLButtonElement | null;
    assert.ok(guideBtn, 'Guide button rendered');
    guideBtn.click();

    const guideDialog = document.querySelector('#dialog-agent-guide') as HTMLElement | null;
    assert.ok(guideDialog, 'Guide dialog opened');
    // Uses the repo's real, styled modal primitive (not an unstyled custom class)
    assert.ok(guideDialog.classList.contains('proto-modal-backdrop'), 'Guide dialog uses proto-modal-backdrop');
    assert.ok(guideDialog.querySelector('.proto-modal-dialog'), 'Guide dialog has proto-modal-dialog');
    assert.ok(guideDialog.querySelector('.proto-modal-body'), 'Guide dialog has proto-modal-body');
    assert.match(guideDialog.textContent ?? '', /Agent Identity & Work Options Architecture/);
    // Cleanup
    (guideDialog.querySelector('.close-modal-btn') as HTMLButtonElement).click();
    assert.equal(document.querySelector('#dialog-agent-guide'), null, 'Guide dialog closes');

    // 2. Create Agent dialog opens with modal primitives and required fields
    const createBtn = document.querySelector('#btn-create-agent') as HTMLButtonElement | null;
    assert.ok(createBtn, 'Create button rendered');
    createBtn.click();

    const createDialog = document.querySelector('#dialog-create-agent') as HTMLElement | null;
    assert.ok(createDialog, 'Create Agent dialog opened');
    assert.ok(createDialog.classList.contains('proto-modal-backdrop'), 'Create dialog uses proto-modal-backdrop');
    assert.ok(createDialog.querySelector('.proto-modal-dialog'), 'Create dialog has proto-modal-dialog');
    assert.ok(createDialog.querySelector('#new-agent-name'), 'Create dialog exposes name field');
    assert.ok(createDialog.querySelector('#new-opt-engine'), 'Create dialog exposes primary work option engine');

    // Confirm creation actually adds the Agent
    (createDialog.querySelector('#new-agent-name') as HTMLInputElement).value = 'Auditor';
    (createDialog.querySelector('#new-agent-desc') as HTMLInputElement).value = 'Dependency audit';
    (createDialog.querySelector('#btn-confirm-create-agent') as HTMLButtonElement).click();
    assert.equal(document.querySelector('#dialog-create-agent'), null, 'Create dialog closes after confirm');
    assert.ok(
      stateManager.getSnapshot().agents.some((a) => a.displayName === 'Auditor'),
      'Created Agent is added to state'
    );
  } finally {
    await cleanup();
  }
});

test('Agents: Edit Agent dialog opens, is styled, and persists identity changes as a new version', async () => {
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

    stateManager.setPrimaryNav('manage', undefined, 'agents');
    stateManager.selectAgent('programmer');

    const document = dom.window.document;
    const versionBefore = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!.version ?? 1;

    const editBtn = document.querySelector('#btn-edit-agent') as HTMLButtonElement | null;
    assert.ok(editBtn, 'Edit Agent button rendered');
    editBtn.click();

    const editDialog = document.querySelector('#dialog-edit-agent') as HTMLElement | null;
    assert.ok(editDialog, 'Edit Agent dialog opened');
    assert.ok(editDialog.classList.contains('proto-modal-backdrop'), 'Edit dialog uses proto-modal-backdrop');
    assert.ok(editDialog.querySelector('.proto-modal-dialog'), 'Edit dialog has proto-modal-dialog');

    const nameInput = editDialog.querySelector('#edit-agent-name') as HTMLInputElement;
    assert.ok(nameInput, 'Edit dialog exposes display name field');
    assert.equal(nameInput.value, 'Programmer');

    nameInput.value = 'Programmer Prime';
    (editDialog.querySelector('#btn-confirm-save-agent') as HTMLButtonElement).click();

    assert.equal(document.querySelector('#dialog-edit-agent'), null, 'Edit dialog closes after save');
    const updated = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!;
    assert.equal(updated.displayName, 'Programmer Prime');
    assert.equal(updated.version, versionBefore + 1, 'Editing identity increments the config version');
  } finally {
    await cleanup();
  }
});

test('Agents: browser Back and Forward navigation restores agent list and detail views (F-66-06)', async () => {
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

    stateManager.setPrimaryNav('manage', undefined, 'agents');

    // 1. Open agent detail (pushes 'agent-detail' state)
    stateManager.openAgentDetail('programmer');
    assert.equal(stateManager.getSnapshot().agentViewMode, 'detail');
    assert.equal(stateManager.getSnapshot().selectedAgentId, 'programmer');

    // 2. Dispatch recorded 'agent-list' popstate event (simulating Browser Back)
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: { page: 'agent-list' } }));
    assert.equal(stateManager.getSnapshot().agentViewMode, 'list', 'Restored to agent list mode via popstate');

    // 3. Dispatch 'agent-detail' popstate event (simulating Browser Forward)
    dom.window.dispatchEvent(
      new dom.window.PopStateEvent('popstate', { state: { page: 'agent-detail', agentId: 'planner' } })
    );
    assert.equal(stateManager.getSnapshot().agentViewMode, 'detail');
    assert.equal(stateManager.getSnapshot().selectedAgentId, 'planner', 'Restored to agent detail for planner via popstate');

    // 4. Dispatch empty popstate fallback while in detail mode
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: null }));
    assert.equal(stateManager.getSnapshot().agentViewMode, 'list', 'Fallback restored to agent list mode');
  } finally {
    await cleanup();
  }
});

test('Agents: unconfigured option or missing model sets Agent to Unavailable and blocks admission (F-66-01)', async () => {
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

    stateManager.setPrimaryNav('manage', undefined, 'agents');
    stateManager.setViewportMode('desktop');

    // 1. Sentinel has only option with isConfigured: false
    // Must be classified as Unavailable (traffic light red)
    const sentinel = stateManager.getSnapshot().agents.find((a) => a.id === 'sentinel')!;
    assert.equal(sentinel.workOptions[0]?.isConfigured, false);

    stateManager.selectAgent('sentinel');
    const document = dom.window.document;

    const banner = document.querySelector('.env-traffic-light-banner');
    assert.ok(banner, 'Traffic light banner rendered');
    assert.match(banner.textContent ?? '', /Action Required/i);
    assert.match(banner.getAttribute('title') ?? '', /unconfigured, unauthenticated, or missing/i);

    // Option row displays "Unconfigured" badge
    const optionBadge = document.querySelector('.agent-option-row .badge-yellow');
    assert.ok(optionBadge);
    assert.equal(optionBadge.textContent?.trim(), 'Unconfigured');

    // Filter pill count for Unavailable includes Sentinel
    const unavailablePill = document.querySelector('.filter-pill[data-filter="unavailable"]') as HTMLElement;
    assert.ok(unavailablePill);
    assert.match(unavailablePill.textContent ?? '', /1/, 'Unavailable filter count is at least 1');

    // Clicking Unavailable filter displays Sentinel in master column
    unavailablePill.click();
    assert.equal(stateManager.getSnapshot().agentFilter, 'unavailable');
    const masterColumn = document.querySelector('.agents-master-column');
    assert.match(masterColumn?.textContent ?? '', /Sentinel/);
  } finally {
    await cleanup();
  }
});

test('Agents: Environment Compatibility UI displays clear ineligibility reasons for offline and incompatible hosts (F-66-02)', async () => {
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

    stateManager.setPrimaryNav('manage', undefined, 'agents');
    stateManager.selectAgent('programmer');

    const document = dom.window.document;

    // Expand Environment Compatibility section
    const envFoldable = document.querySelector('#foldable-env-compat') as HTMLElement;
    (envFoldable.querySelector('.foldable-header') as HTMLElement).click();

    const text = envFoldable.textContent ?? '';

    // Offline / recovery host (env-recovery) must NOT show "Admitted via"; must show Ineligible / Offline
    assert.doesNotMatch(text, /Admitted via.*Recovery Environment/);
    assert.match(text, /Ineligible · Offline/);

    // Protocol incompatible host (env-incompatible) must NOT show "Admitted via"; must show Ineligible
    assert.doesNotMatch(text, /Admitted via.*Incompatible Environment/);
    assert.match(text, /Ineligible · Protocol Incompatible/);

    // Pending enrollment host (env-pending) must show Ineligible · Enrollment
    assert.match(text, /Ineligible · Enrollment: pending/);

    // Healthy online host (Ready Environment) admits Programmer via PI
    assert.match(text, /Admitted via PI/);
  } finally {
    await cleanup();
  }
});
