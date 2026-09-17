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

test('Agents: renders Agent identity, standing instructions, ordered work options, and concise status banner', async () => {
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

    // Navigate to Manage > Agents
    stateManager.setPrimaryNav('manage', undefined, 'agents');
    stateManager.selectAgent('programmer');

    const document = dom.window.document;

    // 1. Verify Header and Filter Pills
    assert.match(document.body.textContent ?? '', /Agents & Work Option Preferences/);
    assert.match(document.body.textContent ?? '', /All \(/);
    assert.match(document.body.textContent ?? '', /Active \(/);
    assert.match(document.body.textContent ?? '', /Attention \(/);
    assert.match(document.body.textContent ?? '', /Unavailable \(/);
    assert.match(document.body.textContent ?? '', /Archived \(/);

    // 2. Verify Concise Status Reason Banner (without verbose fact paragraph)
    const banner = document.querySelector('.env-traffic-light-banner');
    assert.ok(banner, 'Traffic light banner rendered');
    assert.match(banner.textContent ?? '', /Ready/);
    assert.doesNotMatch(banner.textContent ?? '', /Decisive Fact:/, 'Verbose fact paragraph removed');

    // 3. Verify Non-redundant Identity Facts
    assert.match(document.body.textContent ?? '', /Stable Identity/);
    assert.match(document.body.textContent ?? '', /programmer/);
    assert.match(document.body.textContent ?? '', /Private Memory/);
    assert.match(document.body.textContent ?? '', /26 memory entries/);

    // 4. Verify Standing Instructions
    assert.match(document.body.textContent ?? '', /Standing Instructions/);
    assert.match(document.body.textContent ?? '', /Write pure functions where possible; ensure build and verification scripts pass/);

    // 5. Verify Ordered Work Options with Drag Handles
    assert.match(document.body.textContent ?? '', /Ordered Execution Preferences/);
    assert.match(document.body.textContent ?? '', /Priority 1 \(Primary\)/);
    assert.match(document.body.textContent ?? '', /PI/);
    assert.match(document.body.textContent ?? '', /claude-3-5-sonnet/);
    assert.match(document.body.textContent ?? '', /Priority 2 \(Fallback\)/);
    assert.match(document.body.textContent ?? '', /CODEX/);
    assert.match(document.body.textContent ?? '', /gpt-4o/);

    // Verify draggable option rows
    const draggableRows = document.querySelectorAll('.agent-option-row[draggable="true"]');
    assert.ok(draggableRows.length >= 2, 'Work options are draggable for reordering');

    // 6. Verify Pre-Acceptance Fallback & No-Silent-Replay Guarantee Notice
    assert.match(document.body.textContent ?? '', /Pre-Acceptance Fallback & No-Silent-Replay Guarantee \(ADR-0008\)/);
    assert.match(document.body.textContent ?? /never silently replays work through lower-priority options/, /never silently replays work/);

    // 7. Verify Foldable Boxes are Present and Collapsed by Default
    const envCompatFoldable = document.querySelector('#foldable-env-compat');
    assert.ok(envCompatFoldable, 'Environment compatibility foldable card rendered');
    assert.equal(envCompatFoldable.classList.contains('open'), false, 'Collapsed by default');

    const membershipsFoldable = document.querySelector('#foldable-project-memberships');
    assert.ok(membershipsFoldable, 'Project memberships foldable card rendered');
    assert.equal(membershipsFoldable.classList.contains('open'), false, 'Collapsed by default');

    const changelogFoldable = document.querySelector('#foldable-version-changelog');
    assert.ok(changelogFoldable, 'Changelog foldable card rendered');
    assert.equal(changelogFoldable.classList.contains('open'), false, 'Collapsed by default');

    const attributionFoldable = document.querySelector('#foldable-attribution-trace');
    assert.ok(attributionFoldable, 'Attribution trace foldable card rendered');
    assert.equal(attributionFoldable.classList.contains('open'), false, 'Collapsed by default');
  } finally {
    await cleanup();
  }
});

test('Agents: managing work options (add, drag-and-drop reorder, delete, and minimum 1 option guard)', async () => {
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

    const initialOptionsCount = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')?.workOptions.length ?? 0;
    const initialVersion = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')?.version ?? 1;

    // 1. Add Work Option
    stateManager.addAgentWorkOption('programmer', {
      engine: 'agy',
      workModel: 'gemini-1.5-pro',
      effort: 'medium',
    });

    let updatedAgent = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!;
    assert.equal(updatedAgent.workOptions.length, initialOptionsCount + 1);
    assert.equal(updatedAgent.version, initialVersion + 1);
    assert.equal(updatedAgent.workOptions[updatedAgent.workOptions.length - 1]?.engine, 'agy');

    // 2. Drag & Drop Reorder Options (Move index 0 to index 1)
    const opt1Id = updatedAgent.workOptions[0]!.id;
    const opt2Id = updatedAgent.workOptions[1]!.id;

    stateManager.reorderAgentWorkOptions('programmer', 0, 1);
    updatedAgent = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!;
    assert.equal(updatedAgent.workOptions[0]?.id, opt2Id);
    assert.equal(updatedAgent.workOptions[1]?.id, opt1Id);
    assert.equal(updatedAgent.version, initialVersion + 2);

    // 3. Move back (index 1 to index 0)
    stateManager.reorderAgentWorkOptions('programmer', 1, 0);
    updatedAgent = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!;
    assert.equal(updatedAgent.workOptions[0]?.id, opt1Id);

    // 4. Remove Option
    const addedOptId = updatedAgent.workOptions[updatedAgent.workOptions.length - 1]!.id;
    stateManager.removeAgentWorkOption('programmer', addedOptId);
    updatedAgent = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!;
    assert.equal(updatedAgent.workOptions.length, initialOptionsCount);

    // 5. Test Minimum 1 Option Guard on Sentinel (which has 1 option)
    stateManager.selectAgent('sentinel');
    const sentinel = stateManager.getSnapshot().agents.find((a) => a.id === 'sentinel')!;
    assert.equal(sentinel.workOptions.length, 1);
    const removeRes = stateManager.removeAgentWorkOption('sentinel', sentinel.workOptions[0]!.id);
    assert.equal(removeRes, false, 'Refused removal of the last work option');
    assert.equal(sentinel.workOptions.length, 1);
  } finally {
    await cleanup();
  }
});

test('Agents: foldable boxes expand on click to reveal environment, membership, changelog, and attribution details', async () => {
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

    // 1. Expand Environment Compatibility Foldable Card
    const envFoldable = document.querySelector('#foldable-env-compat') as HTMLElement;
    assert.ok(envFoldable);
    assert.equal(envFoldable.classList.contains('open'), false);

    const envHeader = envFoldable.querySelector('.foldable-header') as HTMLElement;
    envHeader.click();
    assert.equal(envFoldable.classList.contains('open'), true, 'Environment compatibility card expanded');

    // 2. Expand Project Memberships Foldable Card
    const memFoldable = document.querySelector('#foldable-project-memberships') as HTMLElement;
    assert.ok(memFoldable);
    const memHeader = memFoldable.querySelector('.foldable-header') as HTMLElement;
    memHeader.click();
    assert.equal(memFoldable.classList.contains('open'), true, 'Project memberships card expanded');
    assert.match(memFoldable.textContent ?? '', /Three\.js Minesweeper Game/);

    // 3. Expand Version Changelog Foldable Card
    const changelogFoldable = document.querySelector('#foldable-version-changelog') as HTMLElement;
    assert.ok(changelogFoldable);
    const changelogHeader = changelogFoldable.querySelector('.foldable-header') as HTMLElement;
    changelogHeader.click();
    assert.equal(changelogFoldable.classList.contains('open'), true, 'Changelog card expanded');
    assert.match(changelogFoldable.textContent ?? '', /v3/);

    // 4. Expand Attribution Trace Foldable Card
    const attrFoldable = document.querySelector('#foldable-attribution-trace') as HTMLElement;
    assert.ok(attrFoldable);
    const attrHeader = attrFoldable.querySelector('.foldable-header') as HTMLElement;
    attrHeader.click();
    assert.equal(attrFoldable.classList.contains('open'), true, 'Attribution trace card expanded');
  } finally {
    await cleanup();
  }
});

test('Agents: pre-acceptance fallback simulation evaluates environments step-by-step', async () => {
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

    // Test simulation evaluation on Mac Studio (both Pi and Codex ready)
    const macResult = stateManager.evaluateAdmissionFallback('programmer', 'mac-studio-primary');
    assert.ok(macResult);
    assert.equal(macResult.selectedOption?.engine, 'pi');
    assert.equal(macResult.evaluationSteps[0]?.status, 'selected');

    // Test simulation on Designer where Option 1 (Codex) is login-required on Container CI, triggering fallback to Option 2 (Pi)
    const containerResult = stateManager.evaluateAdmissionFallback('designer', 'linux-container-ci');
    assert.ok(containerResult);
    assert.equal(containerResult.evaluationSteps[0]?.status, 'skipped_unauthenticated');
    assert.equal(containerResult.evaluationSteps[1]?.status, 'selected');
    assert.equal(containerResult.selectedOption?.engine, 'pi');
    assert.match(containerResult.guaranteeNote, /Pre-Acceptance Fallback Guarantee/);

    // Test simulation on Sentinel (opencode missing/login-required)
    const sentinelResult = stateManager.evaluateAdmissionFallback('sentinel', 'mac-studio-primary');
    assert.ok(sentinelResult);
    assert.equal(sentinelResult.selectedOption?.engine, 'opencode');
  } finally {
    await cleanup();
  }
});

test('Agents: non-destructive archive safety guard and historical attribution preservation', async () => {
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

    // 1. Safety Guard: Attempting to archive Programmer (active Task Lead for task-101) must fail
    const archiveProgrammerRes = stateManager.archiveAgent('programmer');
    assert.equal(archiveProgrammerRes.success, false);
    assert.match(archiveProgrammerRes.reason ?? '', /Cannot archive Agent "Programmer": Agent is currently Task lead/);

    const programmer = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!;
    assert.equal(programmer.status, 'active', 'Programmer remains active due to active task lead guard');

    // 2. Archive an unassigned/idle Agent (Researcher)
    const archiveResearcherRes = stateManager.archiveAgent('researcher');
    assert.equal(archiveResearcherRes.success, true);
    const researcher = stateManager.getSnapshot().agents.find((a) => a.id === 'researcher')!;
    assert.equal(researcher.status, 'archived');
    assert.equal(researcher.privateMemoryEntriesCount, 7, 'Private memory entries preserved');

    // 3. Restore Researcher
    stateManager.restoreAgent('researcher');
    assert.equal(stateManager.getSnapshot().agents.find((a) => a.id === 'researcher')!.status, 'active');

    // 4. Verify Archived Agent Presentation (Legacy Coder)
    stateManager.selectAgent('legacy-coder');
    const document = dom.window.document;
    assert.match(document.body.textContent ?? '', /Archived/);
    assert.match(document.body.textContent ?? '', /Restore Agent/);
  } finally {
    await cleanup();
  }
});

test('Agents: phone and desktop responsive parity & drill-down navigation', async () => {
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
    stateManager.setViewportMode('mobile');

    const document = dom.window.document;

    // In Mobile list view, master cards render with full width
    stateManager.closeAgentDetail(false);
    assert.ok(document.querySelector('.agents-master-column'));

    // Tapping an agent opens single-column full panel with top back button
    stateManager.selectAgent('programmer', false);
    assert.ok(document.querySelector('.agents-mobile-detail-wrapper'));
    const backBtn = document.querySelector('#btn-back-to-agents');
    assert.ok(backBtn, 'Mobile back button rendered');

    // Clicking back returns to list view
    (backBtn as HTMLButtonElement).click();
    assert.equal(stateManager.getSnapshot().agentViewMode, 'list');
  } finally {
    await cleanup();
  }
});

test('Agents: strict privacy boundary ensures no private host paths or credentials appear', async () => {
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

    const bodyText = dom.window.document.body.textContent ?? '';

    // Verify absolute user home paths never appear
    assert.doesNotMatch(bodyText, /\/Users\//);
    assert.doesNotMatch(bodyText, /C:\\Users\\/);
    assert.doesNotMatch(bodyText, /sk-[a-zA-Z0-9]{20,}/); // OpenAI / Anthropic API keys
    assert.doesNotMatch(bodyText, /Bearer /);
  } finally {
    await cleanup();
  }
});

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
