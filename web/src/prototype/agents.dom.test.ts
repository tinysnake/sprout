import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



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
