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

    // Navigate to Manage > Agents in desktop split mode
    stateManager.setPrimaryNav('manage', undefined, 'agents');
    stateManager.setViewportMode('desktop');
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

    // 3b. Test Mobile Touch and Keyboard Reorder Controls (F-66-07)
    const document = dom.window.document;
    const optionRows = document.querySelectorAll('.agent-option-row');
    assert.ok(optionRows.length >= 2, 'Rendered at least 2 option rows');

    const firstRowUpBtn = optionRows[0]!.querySelector('.move-opt-up-btn') as HTMLButtonElement;
    const firstRowDownBtn = optionRows[0]!.querySelector('.move-opt-down-btn') as HTMLButtonElement;
    assert.ok(firstRowUpBtn, 'First row has move up button');
    assert.ok(firstRowDownBtn, 'First row has move down button');
    assert.equal(firstRowUpBtn.disabled, true, 'Up button is disabled for Priority 1');
    assert.equal(firstRowDownBtn.disabled, false, 'Down button is enabled for Priority 1');

    // Tap move down button to reorder
    firstRowDownBtn.click();
    updatedAgent = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!;
    assert.equal(updatedAgent.workOptions[0]?.id, opt2Id, 'Option moved down via touch/click button');

    // Tap move up button on the second row to move it back
    const secondRowUpBtn = dom.window.document.querySelectorAll('.agent-option-row')[1]!.querySelector('.move-opt-up-btn') as HTMLButtonElement;
    assert.ok(secondRowUpBtn);
    secondRowUpBtn.click();
    updatedAgent = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!;
    assert.equal(updatedAgent.workOptions[0]?.id, opt1Id, 'Option moved back up via touch/click button');

    // Test Keyboard ArrowDown reordering on drag handle
    const handle = dom.window.document.querySelectorAll('.agent-option-row')[0]!.querySelector('.drag-handle-wrap') as HTMLElement;
    assert.ok(handle, 'Drag handle exists with keyboard accessibility');
    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    updatedAgent = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!;
    assert.equal(updatedAgent.workOptions[0]?.id, opt2Id, 'Option moved down via ArrowDown keyboard key');

    // Move back via keyboard ArrowUp
    const newHandle = dom.window.document.querySelectorAll('.agent-option-row')[1]!.querySelector('.drag-handle-wrap') as HTMLElement;
    newHandle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    updatedAgent = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!;
    assert.equal(updatedAgent.workOptions[0]?.id, opt1Id, 'Option moved up via ArrowUp keyboard key');

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
    const { checkEngineModelAvailability, stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    stateManager.setPrimaryNav('manage', undefined, 'agents');
    stateManager.selectAgent('programmer');

    // Test simulation evaluation on Ready Environment (both Pi and Codex ready)
    const macResult = stateManager.evaluateAdmissionFallback('programmer', 'env-ready');
    assert.ok(macResult);
    assert.equal(macResult.selectedOption?.engine, 'pi');
    assert.equal(macResult.evaluationSteps[0]?.status, 'selected');

    // Test simulation on Designer where Option 1 (Codex) is login-required on Container CI, triggering fallback to Option 2 (Pi)
    const containerResult = stateManager.evaluateAdmissionFallback('designer', 'env-degraded');
    assert.ok(containerResult);
    assert.equal(containerResult.evaluationSteps[0]?.status, 'skipped_unauthenticated');
    assert.equal(containerResult.evaluationSteps[1]?.status, 'selected');
    assert.equal(containerResult.selectedOption?.engine, 'pi');
    assert.match(containerResult.guaranteeNote, /Pre-Acceptance Fallback Guarantee/);

    // Test simulation on Sentinel (opencode with isConfigured: false must be skipped, F-66-01)
    const sentinelResult = stateManager.evaluateAdmissionFallback('sentinel', 'env-ready');
    assert.ok(sentinelResult);
    assert.equal(sentinelResult.selectedOption, null, 'Unconfigured Sentinel option cannot be admitted');
    assert.equal(sentinelResult.evaluationSteps[0]?.status, 'skipped_unconfigured');
    assert.match(sentinelResult.evaluationSteps[0]?.reason ?? '', /unconfigured/);

    // Test simulation with unavailable model (F-66-01)
    stateManager.addAgentWorkOption('sentinel', {
      engine: 'pi',
      workModel: 'non-existent-model-xyz',
      effort: 'medium',
      isConfigured: true,
    });
    const sentinelModelResult = stateManager.evaluateAdmissionFallback('sentinel', 'env-ready');
    assert.ok(sentinelModelResult);
    assert.equal(sentinelModelResult.selectedOption, null, 'Unavailable model cannot be admitted');
    assert.equal(sentinelModelResult.evaluationSteps[1]?.status, 'skipped_model_missing');
    assert.match(sentinelModelResult.evaluationSteps[1]?.reason ?? '', /not available/);

    // Model inventory is an exact token list: gpt-4 must not match gpt-4o.
    const mac = stateManager.getSnapshot().environments.find((env) => env.id === 'env-ready')!;
    assert.equal(checkEngineModelAvailability('codex', 'gpt-4', mac).isAvailable, false);
    assert.equal(checkEngineModelAvailability('codex', 'gpt-4o', mac).isAvailable, true);
    mac.engineDetails!.codex!.modelAvailability = 'unknown';
    const unknownInventoryResult = stateManager.evaluateAdmissionFallback('designer', 'env-ready')!;
    assert.equal(unknownInventoryResult.evaluationSteps[0]?.status, 'skipped_model_missing');
    assert.match(unknownInventoryResult.evaluationSteps[0]?.reason ?? '', /unknown or unavailable/i);
    assert.equal(unknownInventoryResult.selectedOption?.engine, 'pi', 'Fallback remains pre-acceptance only');

    // Test environment eligibility gating on offline/recovery host (env-recovery, F-66-02)
    const winResult = stateManager.evaluateAdmissionFallback('programmer', 'env-recovery');
    assert.ok(winResult);
    assert.equal(winResult.selectedOption, null, 'Offline/recovery environment cannot admit runs');
    assert.ok(winResult.envIneligibilityReason);
    assert.match(winResult.envIneligibilityReason, /offline/i);
    assert.equal(winResult.evaluationSteps[0]?.status, 'skipped_unsupported');
    assert.match(winResult.evaluationSteps[0]?.reason ?? '', /ineligible/i);

    // Test environment eligibility gating on protocol-incompatible host (env-incompatible, F-66-02)
    const miniResult = stateManager.evaluateAdmissionFallback('programmer', 'env-incompatible');
    assert.ok(miniResult);
    assert.equal(miniResult.selectedOption, null, 'Protocol-incompatible environment cannot admit runs');
    assert.ok(miniResult.envIneligibilityReason);
    assert.match(miniResult.envIneligibilityReason, /protocol incompatible/i);

    // Test environment eligibility gating on pending enrollment host (env-pending, F-66-02)
    const pendingResult = stateManager.evaluateAdmissionFallback('programmer', 'env-pending');
    assert.ok(pendingResult);
    assert.equal(pendingResult.selectedOption, null, 'Pending enrollment host cannot admit runs');
    assert.ok(pendingResult.envIneligibilityReason);
    assert.match(pendingResult.envIneligibilityReason, /not approved/i);
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

    // 1b. Safety Guard (F-66-03): Attempting to archive Designer (active run in progress in task-102) must fail
    const archiveDesignerRes = stateManager.archiveAgent('designer');
    assert.equal(archiveDesignerRes.success, false);
    assert.match(archiveDesignerRes.reason ?? '', /active run/i, 'Refused archive due to active run in task-102');

    // Verify active run guard operates independently of Task lead ownership (F-66-03)
    const task102 = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-102')!;
    task102.taskLeadId = 'unrelated-lead';
    const archiveDesignerRes2 = stateManager.archiveAgent('designer');
    assert.equal(archiveDesignerRes2.success, false, 'Still refuses archive because active run is running');
    assert.match(archiveDesignerRes2.reason ?? '', /active run/i);
    task102.taskLeadId = 'designer'; // Restore fixture

    // 2. End Researcher's historical membership, then archive the idle Agent.
    stateManager.setPrimaryNav('project', 'overview');
    const project = stateManager.getSnapshot().projects.find((p) => p.id === 'proj-minesweeper')!;
    const researcherMembership = project.memberships.find((m) => m.memberId === 'researcher')!;
    const historicalMembership = {
      joinedAt: researcherMembership.joinedAt,
      responsibilities: researcherMembership.responsibilities,
      collaborationInstructions: researcherMembership.collaborationInstructions,
    };
    const historicalMessageIds = stateManager
      .getSnapshot()
      .messages.filter((message) => message.authorId === 'researcher')
      .map((message) => message.id);
    assert.ok(historicalMessageIds.length > 0, 'Fixture retains Researcher message attribution');
    assert.equal(stateManager.endProjectMembership(project.id, 'researcher').success, true);
    assert.equal(researcherMembership.status, 'ended');

    const archiveResearcherRes = stateManager.archiveAgent('researcher');
    assert.equal(archiveResearcherRes.success, true);
    const researcher = stateManager.getSnapshot().agents.find((a) => a.id === 'researcher')!;
    assert.equal(researcher.status, 'archived');
    assert.equal(researcher.privateMemoryEntriesCount, 7, 'Private memory entries preserved');

    // 2b. F-66-04: the Project restore control and direct state mutation both reject an archived Agent.
    const restoreButton = dom.window.document.querySelector<HTMLButtonElement>(
      '.restore-member-btn[data-member="researcher"]'
    );
    assert.ok(restoreButton, 'Ended membership exposes the Project restore control');
    const restoreAlerts: string[] = [];
    dom.window.alert = (message?: string) => restoreAlerts.push(String(message));
    restoreButton.click();
    assert.match(restoreAlerts[0] ?? '', /archived.*restore the agent first/i, 'Project UI exposes the rejection');
    const restoreArchivedRes = stateManager.restoreProjectMembership(project.id, 'researcher');
    assert.equal(restoreArchivedRes.success, false, 'Archived Agent cannot reactivate an ended membership');
    assert.match(restoreArchivedRes.reason ?? '', /archived.*restore the agent first/i);
    assert.equal(
      researcherMembership.status,
      'ended',
      'Rejected restore leaves the historical membership ended'
    );
    assert.deepEqual(
      {
        joinedAt: researcherMembership.joinedAt,
        responsibilities: researcherMembership.responsibilities,
        collaborationInstructions: researcherMembership.collaborationInstructions,
      },
      historicalMembership,
      'Rejected restore preserves historical membership facts'
    );
    assert.deepEqual(
      stateManager
        .getSnapshot()
        .messages.filter((message) => message.authorId === 'researcher')
        .map((message) => message.id),
      historicalMessageIds,
      'Rejected restore preserves historical message attribution'
    );
    assert.match(stateManager.getSnapshot().scenarioLog[0] ?? '', /archived.*restore the agent first/i);

    // 3. Restore Researcher
    stateManager.restoreAgent('researcher');
    assert.equal(stateManager.getSnapshot().agents.find((a) => a.id === 'researcher')!.status, 'active');

    // 3b. Once the global Agent is restored, the normal membership restore path is available again.
    const restoreActiveRes = stateManager.restoreProjectMembership(project.id, 'researcher');
    assert.equal(restoreActiveRes.success, true, 'Restored Agent can reactivate its historical membership');
    assert.equal(researcherMembership.status, 'active');

    // 4. Verify Archived Agent Presentation (Legacy Coder)
    stateManager.setPrimaryNav('manage', undefined, 'agents');
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

    // In Mobile list view, master cards render with full width and list header is present
    stateManager.closeAgentDetail(false);
    assert.ok(document.querySelector('.agents-master-column'));
    assert.ok(document.querySelector('.agents-header-card'), 'List header card rendered in list view');

    // Tapping an agent opens single-column full panel with top back button (omitting list header/filters, F-66-05)
    stateManager.selectAgent('programmer', false);
    assert.ok(document.querySelector('.agents-mobile-detail-wrapper'));
    assert.equal(document.querySelector('.agents-header-card'), null, 'Mobile detail omits list header card');
    assert.equal(document.querySelector('.agent-filter-box-btn'), null, 'Mobile detail omits list filter row');
    const backBtn = document.querySelector('#btn-back-to-agents');
    assert.ok(backBtn, 'Mobile back button rendered');

    // Clicking back returns to list view and restores header card
    (backBtn as HTMLButtonElement).click();
    assert.equal(stateManager.getSnapshot().agentViewMode, 'list');
    assert.ok(document.querySelector('.agents-header-card'), 'List header card restored in list view');
    assert.equal(document.querySelector('.agents-mobile-detail-wrapper'), null);
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

test('Task admission: the shared gate refuses unhealthy hosts and the Begin page records its selected option', async () => {
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

    // F-66-02 state + page path: the offline/recovery fixture is not selectable
    // and direct approval cannot mutate it into an active Task/run.
    stateManager.setPrimaryNav('project', 'tasks');
    stateManager.selectTask('task-201');
    const offlineOption = dom.window.document.querySelector('option[value="env-recovery"]') as HTMLOptionElement;
    assert.ok(offlineOption);
    assert.equal(offlineOption.disabled, true);
    assert.match(offlineOption.textContent ?? '', /Unavailable:.*offline/i);
    const offlineBegin = stateManager.approveAndBeginProposal('task-201', 'env-recovery', 'programmer');
    assert.equal(offlineBegin.success, false);
    const offlineTask = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-201')!;
    assert.equal(offlineTask.lifecycle, 'proposed');
    assert.equal(offlineTask.agentRunLifecycle, 'none');
    assert.equal(offlineTask.runs.length, 0);
    const incompatibleBegin = stateManager.approveAndBeginProposal('task-201', 'env-incompatible', 'programmer');
    assert.equal(incompatibleBegin.success, false);
    assert.match(incompatibleBegin.reason ?? '', /protocol incompatible/i);

    // F-66-01 actual Begin page path: once a ready fixture is available, the
    // first evaluator-selected option—not a hard-coded engine/model—is stored.
    const readyEnvironment = stateManager.getSnapshot().environments.find((env) => env.id === 'env-ready')!;
    delete readyEnvironment.activeLeaseHolder;
    stateManager.selectTask('task-105-prop');
    const readyOption = dom.window.document.querySelector('option[value="env-ready"]') as HTMLOptionElement;
    assert.ok(readyOption);
    assert.equal(readyOption.disabled, false);
    assert.match(readyOption.textContent ?? '', /Ready via CODEX/);
    const beginButton = dom.window.document.querySelector('.approve-begin-btn') as HTMLButtonElement;
    beginButton.click();
    const admittedTask = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-105-prop')!;
    assert.equal(admittedTask.agentRunLifecycle, 'running');
    assert.equal(admittedTask.runs[0]?.engine, 'codex');
    assert.equal(admittedTask.runs[0]?.workModel, 'gpt-4o');
    assert.equal(admittedTask.runs[0]?.effort, 'medium');
  } finally {
    await cleanup();
  }
});

test('Task and Project admission: archived Agents cannot receive new membership or work', async () => {
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

    // F-66-04 direct Project creation must be atomic: no active membership is
    // persisted when an archived Agent is requested.
    const projectCount = stateManager.getSnapshot().projects.length;
    const createResult = stateManager.createProject('Archived Agent Rejection', '', [], ['legacy-coder']);
    assert.equal(createResult.success, false);
    assert.match(createResult.reason ?? '', /archived/i);
    assert.equal(stateManager.getSnapshot().projects.length, projectCount);
    const unknownCreateResult = stateManager.createProject('Unknown Agent Rejection', '', [], ['not-an-agent']);
    assert.equal(unknownCreateResult.success, false);
    assert.match(unknownCreateResult.reason ?? '', /unknown Agent/i);
    assert.equal(stateManager.getSnapshot().projects.length, projectCount);

    // F-66-04 page path filters archived historical members, while direct Task
    // admission refuses the same Agent before creating a run.
    stateManager.setPrimaryNav('project', 'tasks');
    stateManager.selectTask('task-105-prop');
    const leadSelect = dom.window.document.querySelector('.select-begin-lead') as HTMLSelectElement;
    assert.ok(leadSelect);
    assert.equal(Array.from(leadSelect.options).some((option) => option.value === 'legacy-coder'), false);
    const runCount = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-105-prop')!.runs.length;
    const beginResult = stateManager.approveAndBeginProposal('task-105-prop', 'env-ready', 'legacy-coder');
    assert.equal(beginResult.success, false);
    assert.match(beginResult.reason ?? '', /archived/i);
    const task = stateManager.getSnapshot().tasks.find((candidate) => candidate.id === 'task-105-prop')!;
    assert.equal(task.lifecycle, 'proposed');
    assert.equal(task.runs.length, runCount);
  } finally {
    await cleanup();
  }
});

test('Archived Agents: chat and Working Group admission reject new collaboration while history remains readable (F-66-09)', async () => {
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

    const projectId = 'proj-minesweeper';
    const reviewerHistory = stateManager
      .getSnapshot()
      .messages.filter((message) => message.projectId === projectId && message.authorId === 'reviewer')
      .map((message) => message.id);
    assert.ok(reviewerHistory.length > 0, 'Fixture provides archived-Agent message attribution to preserve');

    // The active path remains admitted before archive.
    const activeMessageCount = stateManager.getSnapshot().messages.length;
    const activeResult = stateManager.sendMessage(projectId, { kind: 'direct-message', recipientId: 'planner' }, 'Active path check');
    assert.equal(activeResult.success, true, 'Active Agent still receives direct messages');
    assert.equal(stateManager.getSnapshot().messages.length, activeMessageCount + 1);

    assert.equal(stateManager.archiveAgent('reviewer').success, true, 'Idle active member can be archived');
    const reviewerRunIds = stateManager
      .getSnapshot()
      .tasks.flatMap((task) => task.runs.filter((run) => run.agentId === 'reviewer').map((run) => run.id));
    assert.deepEqual(reviewerRunIds, ['run-204'], 'Archive preserves Reviewer run history');
    const messagesBeforeRejectedSend = stateManager.getSnapshot().messages.length;
    const directResult = stateManager.sendMessage(
      projectId,
      { kind: 'direct-message', recipientId: 'reviewer' },
      'This must not be persisted or wake a reply'
    );
    assert.equal(directResult.success, false);
    assert.match(directResult.reason ?? '', /archived.*restore/i);
    assert.equal(stateManager.getSnapshot().messages.length, messagesBeforeRejectedSend, 'Rejected DM creates no message or projected reply');

    const project = stateManager.getSnapshot().projects.find((candidate) => candidate.id === projectId)!;
    const workingGroupCount = project.workingGroups.length;
    const workingGroupResult = stateManager.createWorkingGroup(projectId, 'Archived reviewer exclusion', ['reviewer']);
    assert.equal(workingGroupResult.success, false);
    assert.match(workingGroupResult.reason ?? '', /Working Group.*archived/i);
    assert.equal(project.workingGroups.length, workingGroupCount, 'Rejected Working Group admission creates no membership or group');

    // The same retained source facts must remain visible from the archived
    // Agent detail, rather than relying on an empty per-Agent summary cache.
    stateManager.setPrimaryNav('manage', undefined, 'agents');
    stateManager.selectAgent('reviewer');
    assert.match(document.body.textContent ?? '', /2 Facts/, 'Archived Agent detail counts retained run and message facts');
    const attributionButton = document.querySelector('#btn-view-attribution') as HTMLButtonElement;
    assert.ok(attributionButton, 'Archived Agent keeps the attribution detail entry point');
    attributionButton.click();
    const attributionDialog = document.querySelector('#dialog-attribution-trace');
    assert.ok(attributionDialog);
    assert.match(attributionDialog.textContent ?? '', /run-204/);
    assert.match(attributionDialog.textContent ?? '', /msg-9/);
    assert.match(attributionDialog.textContent ?? '', /Verification passed with zero console errors/);
    assert.match(attributionDialog.textContent ?? '', /All unit test suites passing/);
    assert.doesNotMatch(attributionDialog.textContent ?? '', /No historical task runs or messages/);
    (attributionDialog.querySelector('.close-modal-btn') as HTMLButtonElement).click();

    stateManager.setPrimaryNav('project', 'chat');
    const createWorkingGroupButton = document.querySelector('#btn-create-wg') as HTMLButtonElement;
    assert.ok(createWorkingGroupButton, 'Working Group creation entry remains available for active collaborators');
    createWorkingGroupButton.click();
    const workingGroupModal = document.querySelector('.proto-modal-dialog');
    assert.ok(workingGroupModal);
    assert.equal(
      workingGroupModal.querySelector('.wg-agent-check[value="reviewer"]'),
      null,
      'Archived Agent is hidden from Working Group invitations'
    );
    assert.match(
      workingGroupModal.textContent ?? '',
      /Archived Agent history remains review-only/,
      'Working Group invitation explains why archived Agents are unavailable'
    );
    (workingGroupModal.querySelector('.close-modal-btn') as HTMLButtonElement).click();

    stateManager.openChatDetail('direct-message', 'reviewer');
    assert.match(document.body.textContent ?? '', /Agent @Reviewer is archived/);
    assert.match(document.body.textContent ?? '', /All unit test suites passing/, 'Archived Agent history remains readable');
    assert.equal((document.querySelector('#chat-main-input') as HTMLInputElement).disabled, true, 'Archived direct-message composer is disabled');
    assert.deepEqual(
      stateManager
        .getSnapshot()
        .messages.filter((message) => message.projectId === projectId && message.authorId === 'reviewer')
        .map((message) => message.id),
      reviewerHistory,
      'Archived Agent message attribution is retained'
    );
  } finally {
    await cleanup();
  }
});

test('Archived Agents: archive cancels an admitted direct-message reply without deleting history (F-66-09-RACE)', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager, getAgentAttributionHistory } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const projectId = 'proj-minesweeper';
    const reviewerHistory = stateManager
      .getSnapshot()
      .messages.filter((message) => message.projectId === projectId && message.authorId === 'reviewer')
      .map((message) => message.id);
    const messageCountBeforeAdmission = stateManager.getSnapshot().messages.length;

    const admitted = stateManager.sendMessage(
      projectId,
      { kind: 'direct-message', recipientId: 'reviewer' },
      'Archive before the projected reply'
    );
    assert.equal(admitted.success, true, 'Active Reviewer admits a direct message');
    assert.equal(stateManager.getSnapshot().messages.length, messageCountBeforeAdmission + 1);

    assert.equal(stateManager.archiveAgent('reviewer').success, true, 'Archive cancels the admitted reply');
    const messageCountAtArchive = stateManager.getSnapshot().messages.length;
    await new Promise((resolve) => setTimeout(resolve, 900));

    assert.equal(stateManager.getSnapshot().messages.length, messageCountAtArchive, 'No projected reply or other new message appears after archive');
    assert.deepEqual(
      stateManager
        .getSnapshot()
        .messages.filter((message) => message.projectId === projectId && message.authorId === 'reviewer')
        .map((message) => message.id),
      reviewerHistory,
      'Archive preserves the Reviewer message history while suppressing the pending reply'
    );
    const reviewer = stateManager.getSnapshot().agents.find((agent) => agent.id === 'reviewer')!;
    assert.deepEqual(
      getAgentAttributionHistory(stateManager.getSnapshot(), reviewer).map((record) => record.entityId).sort(),
      ['msg-9', 'run-204'],
      'Retained message and run attribution remains readable after archive'
    );

    stateManager.restoreAgent('reviewer');
    const messageCountBeforeRestoredReply = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(projectId, { kind: 'direct-message', recipientId: 'reviewer' }, 'Active reply remains available').success,
      true
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    const restoredReply = stateManager
      .getSnapshot()
      .messages.slice(messageCountBeforeRestoredReply)
      .find((message) => message.authorKind === 'agent' && message.authorId === 'reviewer');
    assert.ok(restoredReply, 'Restored active Agent still emits its admitted projected reply');
    assert.equal(restoredReply.isProjectedReply, true);
  } finally {
    await cleanup();
  }
});

test('Project mentions: archived exact targets fail durably without silent retargeting (F-66-10)', async () => {
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
    stateManager.setPrimaryNav('project', 'chat');
    stateManager.openChatDetail('project-channel');

    const projectId = 'proj-minesweeper';
    assert.equal(stateManager.archiveAgent('reviewer').success, true);
    const messageCountBefore = stateManager.getSnapshot().messages.length;

    const result = stateManager.sendMessage(
      projectId,
      { kind: 'project-channel' },
      '@reviewer please verify this exact route'
    );
    assert.equal(result.success, true, 'The Human-authored Message remains durable');

    const routedMessage = stateManager
      .getSnapshot()
      .messages.slice(messageCountBefore)
      .find((message) => message.content.includes('verify this exact route')) as
      | (ReturnType<typeof stateManager.getSnapshot>['messages'][number] & {
          deterministicRoutingOutcomes?: Array<{
            targetAgentId: string;
            status: 'admitted' | 'failed';
            reason?: string;
          }>;
        })
      | undefined;
    assert.ok(routedMessage, 'The original addressed Message is preserved');
    assert.equal(routedMessage.disposition, 'addressed');
    assert.deepEqual(
      routedMessage.deterministicRoutingOutcomes?.map((outcome) => ({
        targetAgentId: outcome.targetAgentId,
        status: outcome.status,
      })),
      [{ targetAgentId: 'reviewer', status: 'failed' }],
      'The exact archived target has one durable failed routing outcome'
    );
    assert.match(routedMessage.deterministicRoutingOutcomes?.[0]?.reason ?? '', /archived.*restore/i);
    const routingInfoButton = dom.window.document.querySelector<HTMLButtonElement>(
      `.chat-msg[data-msg-id="${routedMessage.id}"] .msg-info-trigger-btn`
    );
    assert.ok(routingInfoButton, 'Addressed Message exposes its routing evidence on desktop and mobile');
    routingInfoButton.click();
    const routingEvidence = dom.window.document.querySelector('.deterministic-routing-outcomes');
    assert.match(routingEvidence?.textContent ?? '', /Reviewer.*Failed closed/i);
    assert.match(routingEvidence?.textContent ?? '', /archived.*Restore the Agent/i);

    const messageCountAfterRouting = stateManager.getSnapshot().messages.length;
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(
      stateManager.getSnapshot().messages.length,
      messageCountAfterRouting,
      'No archived or silently substituted Agent emits a projected reply'
    );

    stateManager.restoreAgent('reviewer');
    const beforeValidMention = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(
        projectId,
        { kind: 'project-channel' },
        '@reviewer this route must remain exact'
      ).success,
      true
    );
    const admittedMessage = stateManager.getSnapshot().messages[beforeValidMention] as
      | (ReturnType<typeof stateManager.getSnapshot>['messages'][number] & {
          deterministicRoutingOutcomes?: Array<{ targetAgentId: string; status: string }>;
        })
      | undefined;
    assert.deepEqual(admittedMessage?.deterministicRoutingOutcomes, [
      {
        targetAgentId: 'reviewer',
        targetDisplayName: 'Reviewer',
        status: 'admitted',
        reason: 'Exact mention @reviewer deterministically admitted without wake-model judgement.',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const projectedReplies = stateManager
      .getSnapshot()
      .messages.slice(beforeValidMention + 1)
      .filter((message) => message.isProjectedReply);
    assert.deepEqual(
      projectedReplies.map((message) => message.authorId),
      ['reviewer'],
      'A valid exact mention wakes only its named Agent'
    );
  } finally {
    await cleanup();
  }
});

test('Working Groups: ended Project membership blocks restore and preserves retained history (F-66-11)', async () => {
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

    const projectId = 'proj-minesweeper';
    const project = stateManager.getSnapshot().projects.find((candidate) => candidate.id === projectId)!;
    const group = project.workingGroups.find((candidate) => candidate.id === 'wg-audio')!;
    const historicalMessageIds = stateManager
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.scope.kind === 'working-group-channel' &&
          message.scope.workingGroupId === group.id
      )
      .map((message) => message.id);
    assert.ok(historicalMessageIds.length > 0, 'Fixture provides retained Working Group history');
    assert.equal(group.status, 'disbanded');
    assert.ok(group.memberIds.includes('designer'));

    assert.equal(stateManager.endProjectMembership(projectId, 'designer').success, true);
    assert.ok(group.retainedMemberIds?.includes('designer'), 'Disbanded group retains its restore candidate history');
    assert.ok(
      group.membershipHistory?.some(
        (record) => record.memberId === 'designer' && record.endedAt === 'Just now'
      ),
      'Membership end is recorded without erasing Working Group participation'
    );
    const restoreResult = stateManager.restoreWorkingGroup(projectId, group.id);
    assert.equal(restoreResult.success, false, 'A retained ended member makes restore ineligible');
    assert.match(restoreResult.reason ?? '', /Designer.*active Project membership/i);
    assert.equal(group.status, 'disbanded', 'Rejected restore leaves history read-only');

    const sendResult = stateManager.sendMessage(
      projectId,
      { kind: 'working-group-channel', workingGroupId: group.id },
      'This must remain unavailable'
    );
    assert.equal(sendResult.success, false);
    assert.deepEqual(
      stateManager
        .getSnapshot()
        .messages.filter(
          (message) =>
            message.scope.kind === 'working-group-channel' &&
            message.scope.workingGroupId === group.id
        )
        .map((message) => message.id),
      historicalMessageIds,
      'Rejected restore and send do not delete or append Working Group history'
    );

    stateManager.setPrimaryNav('project', 'chat');
    stateManager.openChatDetail('working-group-channel', group.id);
    assert.match(
      dom.window.document.querySelector('.chat-readonly-banner')?.textContent ?? '',
      /Designer.*active Project membership/i,
      'The unavailable restore reason is visible in the read-only conversation'
    );
    const restoreButton = dom.window.document.querySelector<HTMLButtonElement>('.restore-wg-quick-btn');
    assert.ok(restoreButton);
    assert.equal(restoreButton.disabled, true, 'An ineligible Working Group cannot be restored from the UI');
  } finally {
    await cleanup();
  }
});

test('Collaboration admission: wake selection and archived-Project callbacks fail closed', async () => {
  const { vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const projectId = 'proj-minesweeper';
    assert.equal(stateManager.endProjectMembership(projectId, 'designer').success, true);
    const messageCountBeforeWake = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(projectId, { kind: 'project-channel' }, 'Unaddressed routing must recheck membership').success,
      true,
      'The input Message remains durable when selected-Agent admission fails'
    );
    const failedBatch = stateManager.getSnapshot().routingBatches[0]!;
    assert.equal(failedBatch.status, 'failed-closed');
    assert.equal(failedBatch.closedAt, 'Just now', 'Immediate terminal batch does not retain a future close deadline');
    assert.equal(failedBatch.decisions[0]?.status, 'failed');
    const failedWakeRequest = failedBatch.resultingWakeRequests?.[0]!;
    assert.equal(failedWakeRequest.admissionStatus, 'failed', 'Legacy admission failure fact remains compatible');
    assert.equal(failedWakeRequest.terminalStatus, 'failed-closed');
    assert.deepEqual(failedWakeRequest.terminalResponsibility, { kind: 'agent', id: 'designer' });
    assert.match(failedWakeRequest.terminalReason ?? '', /active Project membership/i);
    assert.match(failedWakeRequest.failureReason ?? '', /active Project membership/i);
    assert.ok(failedWakeRequest.terminalTimestamp, 'Immediate admission failure is terminalized at construction');
    assert.match(failedBatch.failureReason ?? '', /active Project membership/i);
    assert.equal(stateManager.getSnapshot().messages.length, messageCountBeforeWake + 1);

    const secondaryProjectId = 'proj-unity-sims';
    const beforeDirect = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(
        secondaryProjectId,
        { kind: 'direct-message', recipientId: 'reviewer' },
        'Archive the Project before this admitted reply settles'
      ).success,
      true
    );
    const pendingDirectMessage = stateManager.getSnapshot().messages.at(-1)!;
    stateManager.archiveProject(secondaryProjectId);
    assert.equal(
      stateManager.getSnapshot().projects.find((project) => project.id === secondaryProjectId)?.status,
      'archived'
    );
    assert.equal(pendingDirectMessage.deterministicRoutingOutcomes?.[0]?.status, 'cancelled');
    assert.deepEqual(pendingDirectMessage.deterministicRoutingOutcomes?.[0]?.terminalResponsibility, {
      kind: 'project',
      id: secondaryProjectId,
    });
    assert.match(pendingDirectMessage.deterministicRoutingOutcomes?.[0]?.reason ?? '', /Project.*archived.*will not replay/i);
    const messageCountAtArchive = stateManager.getSnapshot().messages.length;
    assert.equal(messageCountAtArchive, beforeDirect + 1);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(
      stateManager.getSnapshot().messages.length,
      messageCountAtArchive,
      'A Project archive cancels and independently suppresses pending projected replies'
    );
  } finally {
    await cleanup();
  }
});

test('Archived Projects: direct state entry points cannot add Agent membership or proposals', async () => {
  const { vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const projectId = 'proj-docs-portal';
    const project = stateManager.getSnapshot().projects.find((candidate) => candidate.id === projectId)!;
    assert.equal(project.status, 'archived');
    const membershipCount = project.memberships.length;
    const taskCount = stateManager.getSnapshot().tasks.length;
    const designerMembership = project.memberships.find((membership) => membership.memberId === 'designer')!;
    designerMembership.status = 'ended';

    const membershipResult = stateManager.addProjectMembership(projectId, 'programmer');
    assert.equal(membershipResult.success, false);
    assert.match(membershipResult.reason ?? '', /archived Project/i);
    assert.equal(project.memberships.length, membershipCount);

    const restoreMembershipResult = stateManager.restoreProjectMembership(projectId, 'designer');
    assert.equal(restoreMembershipResult.success, false);
    assert.match(restoreMembershipResult.reason ?? '', /archived Project/i);
    assert.equal(designerMembership.status, 'ended', 'Archived Project preserves the ended membership');

    const proposalResult = stateManager.createTaskProposal(
      projectId,
      'Must not be created',
      'Archived Projects cannot accept proposals',
      [],
      [],
      'designer'
    );
    assert.equal(proposalResult.success, false);
    assert.match(proposalResult.reason ?? '', /archived Project/i);
    assert.equal(stateManager.getSnapshot().tasks.length, taskCount);

    stateManager.restoreProject(projectId);
    assert.equal(stateManager.restoreProjectMembership(projectId, 'designer').success, true);
    assert.equal(designerMembership.status, 'active', 'Membership restore becomes available after Project restore');
  } finally {
    await cleanup();
  }
});

test('Task proposals: state boundary rejects forged authority and unavailable lead responsibility', async () => {
  const { vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const projectId = 'proj-minesweeper';
    const initialTaskCount = stateManager.getSnapshot().tasks.length;
    const propose = (leadId: string, proposerKind: 'human' | 'agent', proposerId?: string) =>
      stateManager.createTaskProposal(
        projectId,
        `Boundary proposal ${leadId} ${proposerId ?? 'operator'}`,
        'Prove proposal authority without admitting resources.',
        [],
        [],
        leadId,
        proposerKind,
        proposerId
      );

    const forgedHuman = propose('programmer', 'human', 'forged-human');
    assert.equal(forgedHuman.success, false);
    assert.match(forgedHuman.reason ?? '', /current Operator identity/i);

    const missingAgentIdentity = propose('programmer', 'agent');
    assert.equal(missingAgentIdentity.success, false);
    assert.match(missingAgentIdentity.reason ?? '', /explicit proposer identity/i);

    const archivedProposer = propose('programmer', 'agent', 'legacy-coder');
    assert.equal(archivedProposer.success, false);
    assert.match(archivedProposer.reason ?? '', /active global Agent.*active Project membership/i);

    const endedProposer = propose('programmer', 'agent', 'researcher');
    assert.equal(endedProposer.success, false);
    assert.match(endedProposer.reason ?? '', /active global Agent.*active Project membership/i);

    for (const invalidLead of ['not-an-agent', 'researcher', 'legacy-coder']) {
      const result = propose(invalidLead, 'human');
      assert.equal(result.success, false, `${invalidLead} cannot be persisted as valid Task responsibility`);
      assert.match(result.reason ?? '', /non-admissible.*active global Agent.*active Project membership/i);
    }
    assert.equal(stateManager.getSnapshot().tasks.length, initialTaskCount, 'Rejected authority facts do not create Tasks');

    const validProposal = propose('programmer', 'agent', 'planner');
    assert.equal(validProposal.success, true);
    const created = stateManager
      .getSnapshot()
      .tasks.find((task) => task.currentVersion.title.includes('Boundary proposal programmer planner'))!;
    assert.ok(created);
    assert.equal(created.proposerId, 'planner');
    assert.equal(created.currentVersion.createdBy, 'Planner (Agent)');
    assert.equal(created.lifecycle, 'proposed');
    assert.equal(created.leaseLifecycle, 'none');
    assert.equal(created.agentRunLifecycle, 'none');
    assert.equal(created.runs.length, 0, 'Proposal creation never admits resources or starts a run');

    const versionBeforeInvalidLead = created.currentVersion.version;
    const invalidRevision = stateManager.updateTaskContentVersion(
      created.id,
      'Forged replacement lead',
      created.currentVersion.goal,
      created.currentVersion.constraints,
      created.currentVersion.validationCriteria,
      'legacy-coder'
    );
    assert.equal(invalidRevision.success, false);
    assert.match(invalidRevision.reason ?? '', /active global Agent.*active Project membership/i);
    assert.equal(created.currentVersion.version, versionBeforeInvalidLead);
    assert.equal(created.taskLeadId, 'programmer', 'Rejected revision cannot overwrite valid responsibility');

    assert.equal(stateManager.endProjectMembership(projectId, 'programmer').success, true);
    assert.equal(created.lifecycle, 'proposed', 'Unavailable proposal lead does not imply that Task begin occurred');
    assert.ok(created.activeBlocker);
    assert.match(created.activeBlocker?.reason ?? '', /lead Programmer membership ended/i);
    assert.equal(created.leaseLifecycle, 'none');
    assert.equal(created.runs.length, 0);
    stateManager.resolveBlocker(created.id);
    assert.equal(created.lifecycle, 'proposed', 'Generic blocker resolution cannot bypass approve-and-begin');
    assert.ok(created.activeBlocker, 'Lead blocker remains until Human selects an eligible replacement');
    const replacementRevision = stateManager.updateTaskContentVersion(
      created.id,
      created.currentVersion.title,
      created.currentVersion.goal,
      created.currentVersion.constraints,
      created.currentVersion.validationCriteria,
      'designer'
    );
    assert.equal(replacementRevision.success, true);
    assert.equal(created.lifecycle, 'proposed');
    assert.equal(created.taskLeadId, 'designer');
    assert.equal(created.activeBlocker, undefined, 'Human replacement clears only the lead blocker');
    assert.equal(created.leaseLifecycle, 'none');
  } finally {
    await cleanup();
  }
});

test('Project restore: compatibility outcomes are durable and later Task begin still fails closed', async () => {
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

    const projectId = 'proj-docs-portal';
    const project = stateManager.getSnapshot().projects.find((candidate) => candidate.id === projectId)!;
    const env = stateManager.getSnapshot().environments.find((candidate) => candidate.id === 'env-ready')!;
    assert.equal(project.status, 'archived');

    env.enrollmentStatus = 'archived';
    env.connectionState = 'offline';
    const projectCount = stateManager.getSnapshot().projects.length;
    const createWithArchivedEnvironment = stateManager.createProject(
      'Unavailable Environment Assignment',
      '',
      [],
      [],
      [env.id]
    );
    assert.equal(createWithArchivedEnvironment.success, false);
    assert.match(createWithArchivedEnvironment.reason ?? '', /approved enrollment.*Project assignment/i);
    assert.equal(stateManager.getSnapshot().projects.length, projectCount);
    const archivedBindingCount = project.boundEnvironmentWorkspaces.length;
    const bindToArchivedProject = stateManager.bindEnvironmentToProject(
      projectId,
      'env-incompatible',
      'workspace-root',
      'must-not-bind'
    );
    assert.equal(bindToArchivedProject.success, false);
    assert.match(bindToArchivedProject.reason ?? '', /archived Project/i);
    assert.equal(project.boundEnvironmentWorkspaces.length, archivedBindingCount);

    stateManager.restoreProject(projectId);
    assert.equal(project.status, 'active', 'A Project can be restored for read/write management without implying work readiness');
    assert.equal(project.compatibilityHistory?.[0]?.status, 'unavailable');
    assert.match(project.compatibilityHistory?.[0]?.summary ?? '', /no bound Environment.*Task begin remains unavailable/i);
    assert.match(project.compatibilityHistory?.[0]?.environments[0]?.reason ?? '', /not approved|archived/i);
    stateManager.selectProject(projectId);
    stateManager.setPrimaryNav('project', 'overview');
    assert.match(
      dom.window.document.querySelector('.project-restore-compatibility')?.textContent ?? '',
      /unavailable[\s\S]*Task begin remains unavailable/i,
      'Latest restore compatibility fact is visible without implying Project work readiness'
    );

    stateManager.archiveProject(projectId);
    env.enrollmentStatus = 'approved';
    env.connectionState = 'online';
    env.protocolCompatibility = 'compatible';
    env.workSafety = 'clear';
    stateManager.restoreProject(projectId);
    assert.equal(project.compatibilityHistory?.[0]?.status, 'ready');
    assert.equal(project.compatibilityHistory?.[1]?.status, 'unavailable', 'Prior restore evidence remains reviewable');

    env.protocolCompatibility = 'incompatible';
    env.protocolMismatchDetail = 'Worker protocol became incompatible after restore.';
    const proposalResult = stateManager.createTaskProposal(
      projectId,
      'Restore admission probe',
      'Later Begin must re-evaluate current Environment facts.',
      [],
      [],
      'designer'
    );
    assert.equal(proposalResult.success, true);
    const proposal = stateManager
      .getSnapshot()
      .tasks.find((task) => task.currentVersion.title === 'Restore admission probe')!;
    const beginResult = stateManager.approveAndBeginProposal(proposal.id, env.id, 'designer');
    assert.equal(beginResult.success, false);
    assert.match(beginResult.reason ?? '', /protocol incompatible/i);
    assert.equal(proposal.lifecycle, 'proposed');
    assert.equal(proposal.leaseLifecycle, 'none');
    assert.equal(proposal.runs.length, 0);
  } finally {
    await cleanup();
  }
});

test('Task lead authority: generic unblock, resume, and recovery cannot restore an invalid lead', async () => {
  const { vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const projectId = 'proj-minesweeper';
    const blockedTask = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-103')!;
    const recoveryTask = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-104')!;
    assert.equal(stateManager.endProjectMembership(projectId, 'programmer').success, true);
    assert.equal(blockedTask.lifecycle, 'blocked');
    assert.match(blockedTask.activeBlocker?.id ?? '', /^blocker-lead-/);

    stateManager.resolveBlocker(blockedTask.id);
    assert.equal(blockedTask.lifecycle, 'blocked', 'Generic unblock cannot reactivate an invalid Task lead');
    assert.match(blockedTask.activeBlocker?.id ?? '', /^blocker-lead-/);
    assert.equal(blockedTask.leaseLifecycle, 'held', 'Blocked Task retains, but does not recreate, its existing lease');

    blockedTask.lifecycle = 'paused';
    stateManager.resumeTask(blockedTask.id);
    assert.equal(blockedTask.lifecycle, 'blocked', 'Generic resume returns an invalid-lead Task to blocked');
    assert.match(blockedTask.activeBlocker?.requiredNextAction ?? '', /assign.*active Project Agent.*replacement/i);

    blockedTask.lifecycle = 'recovery';
    blockedTask.leaseLifecycle = 'recovering';
    const blockedEnvironment = stateManager
      .getSnapshot()
      .environments.find((environment) => environment.id === blockedTask.selectedEnvironmentId)!;
    blockedEnvironment.workSafety = 'recovery';
    blockedEnvironment.activeLeaseHolder = {
      holderKind: 'task',
      holderId: blockedTask.id,
      projectId: blockedTask.projectId,
      acquiredAt: 'Just now',
    };
    blockedEnvironment.leaseRecovery = {
      cause: 'Synthetic recovery state for invalid-lead reconciliation.',
      unresolvedFacts: ['Synthetic recovery evidence'],
    };
    stateManager.resumeOrdinaryRecovery(blockedTask.id);
    assert.equal(blockedTask.lifecycle, 'blocked', 'Recovery reconciliation cannot reactivate an invalid lead');
    assert.equal(blockedTask.leaseLifecycle, 'held', 'Reconciled lease remains reserved by the blocked Task');
    assert.match(blockedTask.activeBlocker?.id ?? '', /^blocker-lead-/);

    const recoveryReplacement = stateManager.updateTaskContentVersion(
      recoveryTask.id,
      recoveryTask.currentVersion.title,
      recoveryTask.currentVersion.goal,
      recoveryTask.currentVersion.constraints,
      recoveryTask.currentVersion.validationCriteria,
      'designer'
    );
    assert.equal(recoveryReplacement.success, true);
    assert.equal(recoveryTask.lifecycle, 'recovery', 'Lead replacement does not bypass the Human recovery boundary');
    assert.equal(recoveryTask.leaseLifecycle, 'recovering');
    assert.equal(recoveryTask.activeBlocker, undefined);
    stateManager.resumeOrdinaryRecovery(recoveryTask.id);
    assert.equal(recoveryTask.lifecycle, 'active');
    assert.equal(recoveryTask.leaseLifecycle, 'held');

    const replacement = stateManager.updateTaskContentVersion(
      blockedTask.id,
      blockedTask.currentVersion.title,
      blockedTask.currentVersion.goal,
      blockedTask.currentVersion.constraints,
      blockedTask.currentVersion.validationCriteria,
      'designer'
    );
    assert.equal(replacement.success, true);
    assert.equal(blockedTask.taskLeadId, 'designer');
    assert.equal(blockedTask.activeBlocker, undefined);
    assert.equal(blockedTask.lifecycle, 'active', 'Human content revision with an eligible replacement restores advancement');
    assert.equal(blockedTask.leaseLifecycle, 'held');
  } finally {
    await cleanup();
  }
});

test('Task lifecycle authority: proposed, running, validation, blocked, and safe end paths fail closed', async () => {
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

    // A proposal has no lease and cannot be turned into a paused/cancelled
    // begun Task by a direct lifecycle call.
    stateManager.setPrimaryNav('project', 'tasks');
    stateManager.selectTask('task-105-prop');
    const proposed = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-105-prop')!;
    assert.equal(proposed.lifecycle, 'proposed');
    assert.equal(proposed.leaseLifecycle, 'none');
    assert.equal(dom.window.document.querySelector('.pause-task-btn'), null, 'Proposed DOM has no pause control');
    assert.equal(stateManager.pauseTask(proposed.id).success, false);
    assert.equal(stateManager.discardTask(proposed.id).success, false);
    assert.equal(proposed.lifecycle, 'proposed');
    assert.equal(proposed.leaseLifecycle, 'none');

    // Discarding an active-running Task first settles/stops the run, then
    // performs the safe Task end without releasing another Task's projection.
    const running = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-102')!;
    const runningEnv = stateManager.getSnapshot().environments.find((env) => env.id === running.selectedEnvironmentId)!;
    stateManager.selectTask(running.id);
    assert.ok(dom.window.document.querySelector('.pause-task-btn'), 'Active-running DOM exposes the pause boundary');
    assert.equal(stateManager.pauseTask(running.id).success, true);
    assert.equal(running.lifecycle, 'Task pause requested');
    const activeRun = running.runs.find((run) => run.id === 'run-205')!;
    assert.equal(stateManager.discardTask(running.id).success, true);
    assert.equal(activeRun.lifecycle, 'stopped', 'Safe discard settles the active run before cancellation');
    assert.equal(running.activeRunId, undefined);
    assert.equal(running.lifecycle, 'cancelled');
    assert.equal(running.leaseLifecycle, 'released');
    assert.equal(runningEnv.activeLeaseHolder?.holderId, 'task-101', 'Discard does not release another Task\'s held Environment projection');
    assert.equal(runningEnv.leaseRecovery, undefined);
    assert.equal(runningEnv.workSafety, 'clear');

    // A valid completion validation clears the historical activeRunId pointer
    // before releasing the Task lease.
    const awaiting = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-101')!;
    const awaitingEnv = stateManager.getSnapshot().environments.find((env) => env.id === awaiting.selectedEnvironmentId)!;
    awaitingEnv.activeLeaseHolder = {
      holderKind: 'task',
      holderId: awaiting.id,
      projectId: awaiting.projectId,
      acquiredAt: 'Just now',
    };
    stateManager.selectTask(awaiting.id);
    const acceptButton = dom.window.document.querySelector('.accept-claim-btn') as HTMLButtonElement;
    assert.ok(acceptButton, 'Awaiting-validation DOM exposes Human validation');
    acceptButton.click();
    assert.equal(awaiting.lifecycle, 'completed');
    assert.equal(awaiting.leaseLifecycle, 'released');
    assert.equal(awaiting.activeRunId, undefined, 'Terminal Task has no historical active pointer');
    assert.equal(awaitingEnv.activeLeaseHolder, undefined);
    assert.equal(awaitingEnv.leaseRecovery, undefined);

    // Ending the current lead membership blocks the Task. A stale claim cannot
    // bypass replacement-lead authority or release its existing lease.
    const blocked = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-103')!;
    const blockedEnv = stateManager.getSnapshot().environments.find((env) => env.id === blocked.selectedEnvironmentId)!;
    blocked.pendingCompletionClaim = {
      id: 'claim-stale-blocked',
      submittedAt: 'Just now',
      submittedByLeadId: blocked.taskLeadId,
      contentVersion: blocked.currentVersion.version,
      outcomeSummary: 'Stale claim used only to probe state authority.',
      validationEvidence: 'No validation is admitted for this probe.',
      durableChanges: [],
      knownLimitations: 'None',
      recommendedDisposition: 'completed',
    };
    blockedEnv.activeLeaseHolder = {
      holderKind: 'task',
      holderId: blocked.id,
      projectId: blocked.projectId,
      acquiredAt: 'Just now',
    };
    assert.equal(stateManager.endProjectMembership('proj-minesweeper', 'programmer').success, true);
    assert.equal(blocked.lifecycle, 'blocked');
    stateManager.selectTask(blocked.id);
    assert.equal(dom.window.document.querySelector('.accept-claim-btn'), null, 'Blocked DOM has no validation accept control');
    assert.equal(stateManager.validateTaskCompletion(blocked.id, 'accept').success, false);
    assert.equal(blocked.lifecycle, 'blocked');
    assert.equal(blocked.leaseLifecycle, 'held');
    assert.ok(blocked.activeBlocker, 'Blocked Task retains a replacement-lead blocker');
    assert.equal(blockedEnv.activeLeaseHolder?.holderId, blocked.id, 'Blocked Task lease remains held');
  } finally {
    await cleanup();
  }
});

test('Task completion claims retain recorded content and submitter facts across allowed edits', async () => {
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

    stateManager.setPrimaryNav('project', 'tasks');
    const task = stateManager.getSnapshot().tasks.find((candidate) => candidate.id === 'task-101')!;
    const env = stateManager.getSnapshot().environments.find((candidate) => candidate.id === task.selectedEnvironmentId)!;
    env.activeLeaseHolder = {
      holderKind: 'task',
      holderId: task.id,
      projectId: task.projectId,
      acquiredAt: 'Just now',
    };
    const claim = task.pendingCompletionClaim!;
    assert.equal(claim.contentVersion, 1);
    assert.equal(claim.submittedByLeadId, 'programmer');

    // Both edits are Human-authorized while validation is pending. The second
    // edit replaces the current lead, but must not rewrite what the claim judged.
    assert.equal(
      stateManager.updateTaskContentVersion(
        task.id,
        'Revised board grid',
        'Keep the original board behaviour while clarifying mobile input.',
        task.currentVersion.constraints,
        task.currentVersion.validationCriteria,
        'programmer'
      ).success,
      true
    );
    assert.equal(
      stateManager.updateTaskContentVersion(
        task.id,
        'Reassigned board grid',
        'The replacement lead owns the next deliberate advance.',
        task.currentVersion.constraints,
        task.currentVersion.validationCriteria,
        'designer'
      ).success,
      true
    );
    assert.equal(task.currentVersion.version, 3);
    assert.equal(task.taskLeadId, 'designer');
    assert.equal(task.pendingCompletionClaim, claim, 'The recorded claim remains pending after content/lead edits');

    // A forged version or submitter fact still fails closed; a historical
    // version is accepted only when the claim submitter matches that version's
    // recorded lead. Current lead eligibility is checked independently.
    claim.contentVersion = 99;
    assert.equal(stateManager.validateTaskCompletion(task.id, 'accept').success, false);
    assert.equal(task.lifecycle, 'awaiting validation');
    claim.contentVersion = 1;
    claim.submittedByLeadId = 'designer';
    assert.equal(stateManager.validateTaskCompletion(task.id, 'accept').success, false);
    assert.equal(task.lifecycle, 'awaiting validation');
    claim.submittedByLeadId = 'programmer';

    stateManager.selectTask(task.id);
    assert.match(dom.window.document.body.textContent ?? '', /Evaluated against Task Content Version v1/);
    const acceptButton = dom.window.document.querySelector('.accept-claim-btn') as HTMLButtonElement;
    assert.ok(acceptButton, 'DOM retains validation for a claim against a historical version');
    acceptButton.click();

    assert.equal(task.lifecycle, 'completed');
    assert.equal(task.leaseLifecycle, 'released');
    assert.equal(env.activeLeaseHolder, undefined, 'Exact Task lease ownership is released only after valid validation');
  } finally {
    await cleanup();
  }
});

test('Paused completion claims support accept and correction without resuming admission', async () => {
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

    stateManager.setPrimaryNav('project', 'tasks');
    const task = stateManager.getSnapshot().tasks.find((candidate) => candidate.id === 'task-101')!;
    const env = stateManager.getSnapshot().environments.find((candidate) => candidate.id === task.selectedEnvironmentId)!;
    env.activeLeaseHolder = {
      holderKind: 'task',
      holderId: task.id,
      projectId: task.projectId,
      acquiredAt: 'Just now',
    };
    assert.equal(stateManager.pauseTask(task.id).success, true, 'Human may pause a settled pending claim without releasing its lease');
    stateManager.selectTask(task.id);
    assert.ok(dom.window.document.querySelector('.accept-claim-btn'), 'Paused DOM keeps the Human accept control');
    assert.match(dom.window.document.body.textContent ?? '', /Lease Held · Paused/);

    const claimRunsBeforeAccept = task.runs.length;
    (dom.window.document.querySelector('.accept-claim-btn') as HTMLButtonElement).click();
    assert.equal(task.lifecycle, 'completed', 'Paused accept may safely end without a prior Resume');
    assert.equal(task.leaseLifecycle, 'released');
    assert.equal(task.runs.length, claimRunsBeforeAccept, 'Accept does not start another run');
    assert.equal(env.activeLeaseHolder, undefined);
  } finally {
    await cleanup();
  }
});

test('Paused correction and blocker resolution preserve the lease until explicit Human Resume', async () => {
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

    stateManager.setPrimaryNav('project', 'tasks');
    const claimTask = stateManager.getSnapshot().tasks.find((candidate) => candidate.id === 'task-101')!;
    const claimEnv = stateManager.getSnapshot().environments.find((candidate) => candidate.id === claimTask.selectedEnvironmentId)!;
    claimEnv.activeLeaseHolder = {
      holderKind: 'task',
      holderId: claimTask.id,
      projectId: claimTask.projectId,
      acquiredAt: 'Just now',
    };
    assert.equal(stateManager.pauseTask(claimTask.id).success, true);
    stateManager.selectTask(claimTask.id);
    assert.ok(dom.window.document.querySelector('.require-correction-btn'), 'Paused DOM keeps the correction control');
    const runsBeforeCorrection = claimTask.runs.length;
    (dom.window as unknown as { prompt: (message?: string, defaultValue?: string) => string }).prompt = () => 'Refine the mobile edge case.';
    (globalThis as unknown as { prompt: (message?: string, defaultValue?: string) => string }).prompt = () => 'Refine the mobile edge case.';
    (dom.window.document.querySelector('.require-correction-btn') as HTMLButtonElement).click();
    assert.equal(claimTask.lifecycle, 'paused');
    assert.equal(claimTask.pendingCompletionClaim, undefined);
    assert.equal(claimTask.leaseLifecycle, 'held');
    assert.equal(claimTask.activeRunId, undefined);
    assert.equal(claimTask.runs.length, runsBeforeCorrection, 'Paused correction does not start a run');
    assert.equal(claimEnv.activeLeaseHolder?.holderId, claimTask.id);
    assert.ok(dom.window.document.querySelector('.resume-task-btn'), 'Explicit Human Resume remains the next advancement control');
    (dom.window.document.querySelector('.resume-task-btn') as HTMLButtonElement).click();
    assert.equal(claimTask.lifecycle, 'active');
    assert.equal(claimTask.leaseLifecycle, 'held');
    assert.equal(claimTask.agentRunLifecycle, 'none');

    const blockedTask = stateManager.getSnapshot().tasks.find((candidate) => candidate.id === 'task-103')!;
    const blockedEnv = stateManager.getSnapshot().environments.find((candidate) => candidate.id === blockedTask.selectedEnvironmentId)!;
    blockedTask.lifecycle = 'paused';
    blockedTask.agentRunLifecycle = 'none';
    blockedTask.leaseLifecycle = 'held';
    blockedEnv.activeLeaseHolder = {
      holderKind: 'task',
      holderId: blockedTask.id,
      projectId: blockedTask.projectId,
      acquiredAt: 'Just now',
    };
    stateManager.selectTask(blockedTask.id);
    assert.ok(dom.window.document.querySelector('.resolve-blocker-btn'), 'Paused DOM exposes blocker resolution');
    (dom.window.document.querySelector('.resolve-blocker-btn') as HTMLButtonElement).click();
    assert.equal(blockedTask.lifecycle, 'paused', 'Resolving a paused blocker does not resume work');
    assert.equal(blockedTask.activeBlocker, undefined);
    assert.equal(blockedTask.leaseLifecycle, 'held');
    assert.equal(blockedTask.agentRunLifecycle, 'none');
    assert.equal(blockedEnv.activeLeaseHolder?.holderId, blockedTask.id);
    assert.ok(dom.window.document.querySelector('.resume-task-btn'));
    (dom.window.document.querySelector('.resume-task-btn') as HTMLButtonElement).click();
    assert.equal(blockedTask.lifecycle, 'active', 'Only explicit Human Resume leaves the paused hold');
    assert.equal(blockedTask.leaseLifecycle, 'held');
    assert.equal(blockedTask.agentRunLifecycle, 'none');
  } finally {
    await cleanup();
  }
});

test('Routing cancellation: Agent and Project archive write durable terminal outcomes without replies', async () => {
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

    const agentProjectId = 'proj-minesweeper';
    const routingBatches = stateManager.getSnapshot().routingBatches;
    routingBatches.unshift({
      id: 'batch-pre-existing-agent-evaluating',
      projectId: agentProjectId,
      openedAt: '20s ago',
      closedAt: 'Just now',
      inputMessageIds: ['msg-pre-existing-agent'],
      status: 'evaluating',
      attemptsCount: 1,
      wakeModel: 'gpt-4o-mini',
      frozenContextSummary: {
        tokenCount: 600,
        projectRulesIncluded: true,
        recentMessagesCount: 1,
        tasksSummariesCount: 1,
        truncated: false,
      },
      decisions: [
        {
          messageId: 'msg-pre-existing-agent',
          targetAgentId: 'reviewer',
          status: 'selected',
          rationale: 'Persisted Reviewer selection awaiting settlement.',
        },
      ],
      resultingWakeRequestIds: ['wake-pre-existing-agent'],
      resultingWakeRequests: [
        {
          wakeRequestId: 'wake-pre-existing-agent',
          targetAgentId: 'reviewer',
          admissionStatus: 'pending',
        },
      ],
    });
    const agentMessageCount = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(agentProjectId, { kind: 'project-channel' }, '@reviewer terminal cancellation evidence').success,
      true
    );
    const addressedMessage = stateManager.getSnapshot().messages.at(-1)!;
    assert.equal(addressedMessage.deterministicRoutingOutcomes?.[0]?.status, 'admitted');
    assert.equal(stateManager.archiveAgent('reviewer').success, true);
    assert.equal(addressedMessage.deterministicRoutingOutcomes?.[0]?.status, 'cancelled');
    assert.deepEqual(addressedMessage.deterministicRoutingOutcomes?.[0]?.terminalResponsibility, {
      kind: 'agent',
      id: 'reviewer',
    });
    const preExistingAgentBatch = routingBatches.find(
      (candidate) => candidate.id === 'batch-pre-existing-agent-evaluating'
    )!;
    assert.equal(preExistingAgentBatch.status, 'failed-closed');
    assert.deepEqual(preExistingAgentBatch.terminalResponsibility, { kind: 'agent', id: 'reviewer' });
    assert.equal(preExistingAgentBatch.resultingWakeRequests?.[0]?.admissionStatus, 'failed');
    assert.deepEqual(preExistingAgentBatch.resultingWakeRequests?.[0]?.terminalResponsibility, {
      kind: 'agent',
      id: 'reviewer',
    });
    assert.equal(preExistingAgentBatch.resultingWakeRequests?.[0]?.terminalStatus, 'failed-closed');
    assert.match(preExistingAgentBatch.resultingWakeRequests?.[0]?.terminalReason ?? '', /Agent.*archived/i);
    assert.ok(preExistingAgentBatch.resultingWakeRequests?.[0]?.terminalTimestamp);
    assert.match(addressedMessage.deterministicRoutingOutcomes?.[0]?.reason ?? '', /Agent.*archived.*no reply.*will not replay/i);
    stateManager.selectProject(agentProjectId);
    stateManager.setPrimaryNav('project', 'chat');
    stateManager.openChatDetail('project-channel');
    const routingEvidenceButton = dom.window.document.querySelector<HTMLButtonElement>(
      `.msg-info-trigger-btn[data-msg-id="${addressedMessage.id}"]`
    );
    assert.ok(routingEvidenceButton);
    routingEvidenceButton.click();
    const terminalEvidence = dom.window.document.querySelector('.projected-reply-popup')?.textContent ?? '';
    assert.match(terminalEvidence, /Cancelled/);
    assert.match(terminalEvidence, /Responsible agent.*reviewer/i);
    assert.doesNotMatch(terminalEvidence, /@Reviewer\s*·\s*Admitted/i);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(stateManager.getSnapshot().messages.length, agentMessageCount + 1, 'Cancelled Agent work emits no reply');

    const projectId = 'proj-docs-portal';
    stateManager.restoreProject(projectId);
    stateManager.setProjectWakePolicy(projectId, 'wake-model-assisted');
    routingBatches.unshift(
      {
        id: 'batch-pre-existing-open',
        projectId,
        openedAt: '10s ago',
        closedAt: 'In 20s',
        inputMessageIds: ['msg-pre-existing-open'],
        status: 'open',
        attemptsCount: 0,
        wakeModel: 'gpt-4o-mini',
        frozenContextSummary: {
          tokenCount: 500,
          projectRulesIncluded: true,
          recentMessagesCount: 1,
          tasksSummariesCount: 0,
          truncated: false,
        },
        decisions: [],
        resultingWakeRequestIds: [],
        resultingWakeRequests: [],
      },
      {
        id: 'batch-pre-existing-evaluating',
        projectId,
        openedAt: '40s ago',
        closedAt: '10s ago',
        inputMessageIds: ['msg-pre-existing-evaluating'],
        status: 'evaluating',
        attemptsCount: 1,
        wakeModel: 'gpt-4o-mini',
        frozenContextSummary: {
          tokenCount: 700,
          projectRulesIncluded: true,
          recentMessagesCount: 2,
          tasksSummariesCount: 0,
          truncated: false,
        },
        decisions: [
          {
            messageId: 'msg-pre-existing-evaluating',
            targetAgentId: 'designer',
            status: 'selected',
            rationale: 'Persisted selection awaiting terminal admission evidence.',
          },
        ],
        resultingWakeRequestIds: ['wake-pre-pending', 'wake-pre-waiting', 'wake-pre-admitted'],
        resultingWakeRequests: [
          { wakeRequestId: 'wake-pre-pending', targetAgentId: 'designer', admissionStatus: 'pending' },
          { wakeRequestId: 'wake-pre-waiting', targetAgentId: 'designer', admissionStatus: 'waiting_capacity' },
          { wakeRequestId: 'wake-pre-admitted', targetAgentId: 'designer', admissionStatus: 'admitted' },
        ],
      },
      {
        id: 'batch-pre-existing-settled-stale-wakes',
        projectId,
        openedAt: '2m ago',
        closedAt: '90s ago',
        inputMessageIds: ['msg-pre-existing-settled'],
        status: 'settled',
        attemptsCount: 1,
        wakeModel: 'gpt-4o-mini',
        frozenContextSummary: {
          tokenCount: 640,
          projectRulesIncluded: true,
          recentMessagesCount: 2,
          tasksSummariesCount: 0,
          truncated: false,
        },
        decisions: [
          {
            messageId: 'msg-pre-existing-settled',
            targetAgentId: 'designer',
            status: 'selected',
            rationale: 'Persisted settled parent with incomplete per-request evidence.',
          },
        ],
        resultingWakeRequestIds: ['wake-settled-pending', 'wake-settled-admitted', 'wake-settled-partial-terminal'],
        resultingWakeRequests: [
          { wakeRequestId: 'wake-settled-pending', targetAgentId: 'designer', admissionStatus: 'pending' },
          { wakeRequestId: 'wake-settled-admitted', targetAgentId: 'designer', admissionStatus: 'admitted' },
          {
            wakeRequestId: 'wake-settled-partial-terminal',
            targetAgentId: 'designer',
            admissionStatus: 'failed',
            terminalStatus: 'failed-closed',
            failureReason: 'Cancelled because Project "Docs Portal" was archived before routing settlement.',
          },
        ],
      }
    );
    const beforeWake = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(projectId, { kind: 'project-channel' }, 'Evaluate this, then archive the Project').success,
      true
    );
    const batch = stateManager.getSnapshot().routingBatches[0]!;
    assert.equal(batch.status, 'evaluating');
    stateManager.archiveProject(projectId);
    assert.equal(batch.status, 'failed-closed');
    assert.deepEqual(batch.terminalResponsibility, { kind: 'project', id: projectId });
    assert.equal(batch.decisions[0]?.status, 'failed');
    assert.equal(batch.resultingWakeRequests?.[0]?.admissionStatus, 'failed');
    assert.deepEqual(batch.resultingWakeRequests?.[0]?.terminalResponsibility, {
      kind: 'project',
      id: projectId,
    });
    assert.match(batch.failureReason ?? '', /Project.*archived.*no reply.*will not replay/i);
    assert.match(batch.resultingWakeRequests?.[0]?.failureReason ?? '', /Project.*archived/i);
    const preExistingOpen = routingBatches.find((candidate) => candidate.id === 'batch-pre-existing-open')!;
    assert.equal(preExistingOpen.status, 'failed-closed', 'Persisted open batch is terminalized without a timer callback');
    assert.deepEqual(preExistingOpen.terminalResponsibility, { kind: 'project', id: projectId });
    assert.match(preExistingOpen.failureReason ?? '', /Project.*archived.*no reply.*will not replay/i);
    const preExistingEvaluating = routingBatches.find(
      (candidate) => candidate.id === 'batch-pre-existing-evaluating'
    )!;
    assert.equal(preExistingEvaluating.status, 'failed-closed');
    assert.equal(preExistingEvaluating.decisions[0]?.status, 'failed');
    for (const wakeRequest of preExistingEvaluating.resultingWakeRequests ?? []) {
      assert.equal(wakeRequest.admissionStatus, 'failed');
      assert.equal(wakeRequest.terminalStatus, 'failed-closed');
      assert.deepEqual(wakeRequest.terminalResponsibility, { kind: 'project', id: projectId });
      assert.match(wakeRequest.terminalReason ?? '', /Project.*archived/i);
      assert.match(wakeRequest.failureReason ?? '', /Project.*archived/i);
      assert.ok(wakeRequest.terminalTimestamp);
    }
    const preExistingSettled = routingBatches.find(
      (candidate) => candidate.id === 'batch-pre-existing-settled-stale-wakes'
    )!;
    assert.equal(preExistingSettled.status, 'settled', 'Settled parent history remains unchanged');
    for (const wakeRequest of preExistingSettled.resultingWakeRequests ?? []) {
      assert.equal(wakeRequest.terminalStatus, 'failed-closed');
      assert.deepEqual(wakeRequest.terminalResponsibility, { kind: 'project', id: projectId });
      assert.match(wakeRequest.terminalReason ?? '', /Project.*archived/i);
      assert.match(wakeRequest.failureReason ?? '', /Project.*archived/i);
      assert.ok(wakeRequest.terminalTimestamp);
    }
    stateManager.openInspector('routing', preExistingSettled.id);
    const settledSheetEvidence = dom.window.document.querySelector('.inspector-sheet')?.textContent ?? '';
    assert.match(settledSheetEvidence, /batch-pre-existing-settled-stale-wakes/);
    const settledSheetStatuses = Array.from(dom.window.document.querySelectorAll('.inspector-sheet .status-pill')).map(
      (element) => element.textContent?.trim()
    );
    assert.equal(
      settledSheetStatuses.some((status) => ['admitted', 'evaluating', 'pending', 'waiting_capacity'].includes(status ?? '')),
      false,
      'Settled-parent archive evidence exposes terminal WakeRequest statuses only'
    );

    stateManager.openInspector('routing', preExistingEvaluating.id);
    const sheetEvidence = dom.window.document.querySelector('.inspector-sheet')?.textContent ?? '';
    assert.match(sheetEvidence, /batch-pre-existing-evaluating/);
    const sheetStatuses = Array.from(dom.window.document.querySelectorAll('.inspector-sheet .status-pill')).map(
      (element) => element.textContent?.trim()
    );
    assert.equal(
      sheetStatuses.some((status) => ['admitted', 'evaluating', 'pending', 'waiting_capacity'].includes(status ?? '')),
      false,
      'Archived Project inspector exposes terminal statuses only'
    );
    assert.match(sheetEvidence, /Responsible project.*proj-docs-portal/i);

    const { renderRoutingInspectorModal } = (await vite.ssrLoadModule(
      '/src/prototype/views/chat-view.ts'
    )) as typeof import('./views/chat-view.js');
    renderRoutingInspectorModal(appMount, stateManager.getSnapshot(), preExistingEvaluating.id);
    const chatInspectorEvidence = dom.window.document.querySelector('.proto-modal-dialog')?.textContent ?? '';
    assert.match(chatInspectorEvidence, /batch-pre-existing-evaluating/);
    const chatInspectorStatuses = Array.from(
      dom.window.document.querySelectorAll('.proto-modal-dialog .status-pill')
    ).map((element) => element.textContent?.trim());
    assert.equal(
      chatInspectorStatuses.some((status) => ['admitted', 'evaluating', 'pending', 'waiting_capacity'].includes(status ?? '')),
      false,
      'Chat routing history exposes terminal statuses only for the archived Project'
    );
    assert.match(chatInspectorEvidence, /Responsible project.*proj-docs-portal/i);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(stateManager.getSnapshot().messages.length, beforeWake + 1, 'Cancelled wake batch emits no reply');
    assert.equal(batch.status, 'failed-closed', 'Terminal batch cannot silently replay after its timer window');
    const { renderRoutingInspectorModal: renderSettledRoutingInspectorModal } = (await vite.ssrLoadModule(
      '/src/prototype/views/chat-view.ts'
    )) as typeof import('./views/chat-view.js');
    renderSettledRoutingInspectorModal(appMount, stateManager.getSnapshot(), preExistingSettled.id);
    const settledChatEvidence = Array.from(dom.window.document.querySelectorAll('.proto-modal-dialog'))
      .at(-1)?.textContent ?? '';
    assert.match(settledChatEvidence, /batch-pre-existing-settled-stale-wakes/);
    const settledChatStatuses = Array.from(
      Array.from(dom.window.document.querySelectorAll('.proto-modal-dialog')).at(-1)?.querySelectorAll('.status-pill') ?? []
    ).map((element) => element.textContent?.trim());
    assert.equal(
      settledChatStatuses.some((status) => ['admitted', 'evaluating', 'pending', 'waiting_capacity'].includes(status ?? '')),
      false,
      'Settled-parent chat evidence exposes terminal WakeRequest statuses only'
    );
  } finally {
    await cleanup();
  }
});

test('Dynamic wake settlement records the complete WakeRequest to run to projected-reply chain', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');
    const { renderRoutingInspectorModal } = (await vite.ssrLoadModule(
      '/src/prototype/views/chat-view.ts'
    )) as typeof import('./views/chat-view.js');
    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    const projectId = 'proj-docs-portal';
    stateManager.restoreProject(projectId);
    stateManager.setProjectWakePolicy(projectId, 'wake-model-assisted');
    const beforeMessages = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(projectId, { kind: 'project-channel' }, 'Please review this unaddressed design note.').success,
      true
    );

    const batch = stateManager.getSnapshot().routingBatches[0]!;
    const wakeRequest = batch.resultingWakeRequests?.[0]!;
    assert.equal(wakeRequest.admissionStatus, 'admitted');
    assert.equal(wakeRequest.terminalStatus, undefined);
    await new Promise((resolve) => setTimeout(resolve, 1300));

    const reply = stateManager.getSnapshot().messages.at(-1)!;
    assert.equal(batch.status, 'settled');
    assert.equal(wakeRequest.terminalStatus, 'settled');
    assert.equal(wakeRequest.terminalResponsibility?.kind, 'agent');
    assert.equal(wakeRequest.terminalResponsibility?.id, wakeRequest.targetAgentId);
    assert.equal(wakeRequest.terminalReason, 'Agent run settled and its projected reply was persisted.');
    assert.ok(wakeRequest.terminalTimestamp);
    assert.ok(wakeRequest.linkedRunId);
    assert.equal(wakeRequest.projectedReplyId, reply.id);
    assert.equal(reply.projectedReplyMeta?.wakeRequestId, wakeRequest.wakeRequestId);
    assert.equal(reply.projectedReplyMeta?.runId, wakeRequest.linkedRunId);
    assert.equal(reply.routingCausalChainId, batch.id);
    assert.equal(stateManager.getSnapshot().messages.length, beforeMessages + 2);
    renderRoutingInspectorModal(appMount, stateManager.getSnapshot(), batch.id);
    const inspectorEvidence = dom.window.document.querySelector('.proto-modal-dialog')?.textContent ?? '';
    assert.match(inspectorEvidence, /settled/);
    assert.match(inspectorEvidence, new RegExp(wakeRequest.linkedRunId!));
    assert.match(inspectorEvidence, new RegExp(wakeRequest.projectedReplyId!));
    assert.doesNotMatch(inspectorEvidence, /WakeRequest:.*admitted/);
  } finally {
    await cleanup();
  }
});

test('Archived Project management mutations fail closed in state and DOM, then work after restore', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');
    const { renderWorkingGroupDetailsModal } = (await vite.ssrLoadModule(
      '/src/prototype/views/chat-view.ts'
    )) as typeof import('./views/chat-view.js');
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');
    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const projectId = 'proj-docs-portal';
    const project = stateManager.getSnapshot().projects.find((candidate) => candidate.id === projectId)!;
    stateManager.restoreProject(projectId);
    const createdGroup = stateManager.createWorkingGroup(projectId, 'Archive guard WG', ['designer']);
    assert.equal(createdGroup.success, true);
    const workingGroup = project.workingGroups.at(-1)!;
    stateManager.archiveProject(projectId);
    assert.equal(project.status, 'archived');

    const membership = project.memberships.find((candidate) => candidate.memberId === 'designer')!;
    const originalResponsibilities = membership.responsibilities;
    const originalInstructions = membership.collaborationInstructions;
    const originalGoal = project.goal;
    const originalRules = [...project.rules];
    const originalPolicy = project.wakePolicy;

    const editResult = stateManager.editProjectMembership(projectId, 'designer', 'forged responsibility', 'forged instructions');
    const endResult = stateManager.endProjectMembership(projectId, 'designer');
    const contractResult = stateManager.updateProjectContract(projectId, 'forged goal', ['forged rule']);
    const policyResult = stateManager.setProjectWakePolicy(projectId, 'wake-model-assisted');
    const disbandResult = stateManager.disbandWorkingGroup(projectId, workingGroup.id);
    for (const result of [editResult, endResult, contractResult, policyResult, disbandResult]) {
      assert.equal(result.success, false);
      assert.match(result.reason ?? '', /archived Project.*Restore the Project first/i);
    }
    assert.equal(membership.status, 'active');
    assert.equal(membership.responsibilities, originalResponsibilities);
    assert.equal(membership.collaborationInstructions, originalInstructions);
    assert.equal(project.goal, originalGoal);
    assert.deepEqual(project.rules, originalRules);
    assert.equal(project.wakePolicy, originalPolicy);
    assert.equal(workingGroup.status, 'active');

    stateManager.selectProject(projectId);
    stateManager.setPrimaryNav('project', 'overview');
    assert.equal((dom.window.document.querySelector('.edit-contract-btn') as HTMLButtonElement).disabled, true);
    assert.equal((dom.window.document.querySelector('.toggle-policy-btn') as HTMLButtonElement).disabled, true);
    assert.equal((dom.window.document.querySelector('.add-member-btn') as HTMLButtonElement).disabled, true);
    assert.equal((dom.window.document.querySelector('.bind-env-btn') as HTMLButtonElement).disabled, true);

    stateManager.setPrimaryNav('project', 'chat');
    stateManager.openChatDetail('working-group-channel', workingGroup.id);
    renderWorkingGroupDetailsModal(dom.window.document.getElementById('app')!, stateManager.getSnapshot(), project, workingGroup);
    assert.equal((dom.window.document.querySelector('.btn-disband-wg') as HTMLButtonElement).disabled, true);

    stateManager.restoreProject(projectId);
    assert.equal(stateManager.editProjectMembership(projectId, 'designer', 'restored responsibility').success, true);
    assert.equal(stateManager.setProjectWakePolicy(projectId, 'wake-model-assisted').success, true);
    assert.equal(stateManager.disbandWorkingGroup(projectId, workingGroup.id).success, true);
  } finally {
    await cleanup();
  }
});

test('Keyboard parity: Agent cards, chat scopes, and foldable details activate with Enter and Space', async () => {
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
    let card = dom.window.document.querySelector<HTMLElement>('.agent-master-card[data-agent-id="sentinel"]')!;
    assert.equal(card.getAttribute('tabindex'), '0');
    assert.equal(card.getAttribute('role'), 'button');
    card.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(stateManager.getSnapshot().selectedAgentId, 'sentinel');

    card = dom.window.document.querySelector<HTMLElement>('.agent-master-card[data-agent-id="programmer"]')!;
    card.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.equal(stateManager.getSnapshot().selectedAgentId, 'programmer');

    const foldable = dom.window.document.querySelector<HTMLElement>('#foldable-env-compat')!;
    const foldableHeader = foldable.querySelector<HTMLElement>('.foldable-header')!;
    foldableHeader.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(foldable.classList.contains('open'), true);
    assert.equal(foldableHeader.getAttribute('aria-expanded'), 'true');
    foldableHeader.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.equal(foldable.classList.contains('open'), false);
    assert.equal(foldableHeader.getAttribute('aria-expanded'), 'false');

    stateManager.setPrimaryNav('project', 'chat');
    let scopeCard = dom.window.document.querySelector<HTMLElement>('.chat-scope-card[data-kind="working-group-channel"]')!;
    assert.equal(scopeCard.getAttribute('tabindex'), '0');
    scopeCard.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(stateManager.getSnapshot().selectedScopeKind, 'working-group-channel');

    scopeCard = dom.window.document.querySelector<HTMLElement>('.chat-scope-card[data-kind="direct-message"][data-id="programmer"]')!;
    scopeCard.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.equal(stateManager.getSnapshot().selectedScopeKind, 'direct-message');
    assert.equal(stateManager.getSnapshot().selectedDirectMessagePeerId, 'programmer');

    stateManager.setPrimaryNav('project', 'tasks');
    stateManager.openTaskDetail('task-101');
    const lifecycleToggle = dom.window.document.querySelector<HTMLElement>('#lifecycle-fold-toggle')!;
    assert.equal(lifecycleToggle.getAttribute('tabindex'), '0');
    lifecycleToggle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(lifecycleToggle.getAttribute('aria-expanded'), 'true');
    lifecycleToggle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.equal(lifecycleToggle.getAttribute('aria-expanded'), 'false');
  } finally {
    await cleanup();
  }
});
