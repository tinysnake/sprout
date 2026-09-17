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

    // Test simulation on Sentinel (opencode with isConfigured: false must be skipped, F-66-01)
    const sentinelResult = stateManager.evaluateAdmissionFallback('sentinel', 'mac-studio-primary');
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
    const sentinelModelResult = stateManager.evaluateAdmissionFallback('sentinel', 'mac-studio-primary');
    assert.ok(sentinelModelResult);
    assert.equal(sentinelModelResult.selectedOption, null, 'Unavailable model cannot be admitted');
    assert.equal(sentinelModelResult.evaluationSteps[1]?.status, 'skipped_model_missing');
    assert.match(sentinelModelResult.evaluationSteps[1]?.reason ?? '', /not available/);

    // Model inventory is an exact token list: gpt-4 must not match gpt-4o.
    const mac = stateManager.getSnapshot().environments.find((env) => env.id === 'mac-studio-primary')!;
    assert.equal(checkEngineModelAvailability('codex', 'gpt-4', mac).isAvailable, false);
    assert.equal(checkEngineModelAvailability('codex', 'gpt-4o', mac).isAvailable, true);
    mac.engineDetails!.codex!.modelAvailability = 'unknown';
    const unknownInventoryResult = stateManager.evaluateAdmissionFallback('designer', 'mac-studio-primary')!;
    assert.equal(unknownInventoryResult.evaluationSteps[0]?.status, 'skipped_model_missing');
    assert.match(unknownInventoryResult.evaluationSteps[0]?.reason ?? '', /unknown or unavailable/i);
    assert.equal(unknownInventoryResult.selectedOption?.engine, 'pi', 'Fallback remains pre-acceptance only');

    // Test environment eligibility gating on offline/recovery host (win-dev-box, F-66-02)
    const winResult = stateManager.evaluateAdmissionFallback('programmer', 'win-dev-box');
    assert.ok(winResult);
    assert.equal(winResult.selectedOption, null, 'Offline/recovery environment cannot admit runs');
    assert.ok(winResult.envIneligibilityReason);
    assert.match(winResult.envIneligibilityReason, /offline/i);
    assert.equal(winResult.evaluationSteps[0]?.status, 'skipped_unsupported');
    assert.match(winResult.evaluationSteps[0]?.reason ?? '', /ineligible/i);

    // Test environment eligibility gating on protocol-incompatible host (mac-mini-mismatch, F-66-02)
    const miniResult = stateManager.evaluateAdmissionFallback('programmer', 'mac-mini-mismatch');
    assert.ok(miniResult);
    assert.equal(miniResult.selectedOption, null, 'Protocol-incompatible environment cannot admit runs');
    assert.ok(miniResult.envIneligibilityReason);
    assert.match(miniResult.envIneligibilityReason, /protocol incompatible/i);

    // Test environment eligibility gating on pending enrollment host (mac-laptop-pending, F-66-02)
    const pendingResult = stateManager.evaluateAdmissionFallback('programmer', 'mac-laptop-pending');
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

    // Offline / recovery host (win-dev-box) must NOT show "Admitted via"; must show Ineligible / Offline
    assert.doesNotMatch(text, /Admitted via.*Windows Dev Host/);
    assert.match(text, /Ineligible · Offline/);

    // Protocol incompatible host (mac-mini-mismatch) must NOT show "Admitted via"; must show Ineligible
    assert.doesNotMatch(text, /Admitted via.*Mac mini/);
    assert.match(text, /Ineligible · Protocol Incompatible/);

    // Pending enrollment host (mac-laptop-pending) must show Ineligible · Enrollment
    assert.match(text, /Ineligible · Enrollment: pending/);

    // Healthy online host (Mac Studio Primary) admits Programmer via PI
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
    const offlineOption = dom.window.document.querySelector('option[value="win-dev-box"]') as HTMLOptionElement;
    assert.ok(offlineOption);
    assert.equal(offlineOption.disabled, true);
    assert.match(offlineOption.textContent ?? '', /Unavailable:.*offline/i);
    const offlineBegin = stateManager.approveAndBeginProposal('task-201', 'win-dev-box', 'programmer');
    assert.equal(offlineBegin.success, false);
    const offlineTask = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-201')!;
    assert.equal(offlineTask.lifecycle, 'proposed');
    assert.equal(offlineTask.agentRunLifecycle, 'none');
    assert.equal(offlineTask.runs.length, 0);
    const incompatibleBegin = stateManager.approveAndBeginProposal('task-201', 'mac-mini-mismatch', 'programmer');
    assert.equal(incompatibleBegin.success, false);
    assert.match(incompatibleBegin.reason ?? '', /protocol incompatible/i);

    // F-66-01 actual Begin page path: once a ready fixture is available, the
    // first evaluator-selected option—not a hard-coded engine/model—is stored.
    const readyEnvironment = stateManager.getSnapshot().environments.find((env) => env.id === 'mac-studio-primary')!;
    delete readyEnvironment.activeLeaseHolder;
    stateManager.selectTask('task-105-prop');
    const readyOption = dom.window.document.querySelector('option[value="mac-studio-primary"]') as HTMLOptionElement;
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

    // F-66-04 page path filters archived historical members, while direct Task
    // admission refuses the same Agent before creating a run.
    stateManager.setPrimaryNav('project', 'tasks');
    stateManager.selectTask('task-105-prop');
    const leadSelect = dom.window.document.querySelector('.select-begin-lead') as HTMLSelectElement;
    assert.ok(leadSelect);
    assert.equal(Array.from(leadSelect.options).some((option) => option.value === 'legacy-coder'), false);
    const runCount = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-105-prop')!.runs.length;
    const beginResult = stateManager.approveAndBeginProposal('task-105-prop', 'mac-studio-primary', 'legacy-coder');
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
