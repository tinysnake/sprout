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

test('Agents: renders Agent identity, standing instructions, ordered work options, and status reasons', async () => {
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

    // 2. Verify Decisive Status Reason Banner
    const banner = document.querySelector('.env-traffic-light-banner');
    assert.ok(banner, 'Traffic light banner rendered');
    assert.match(banner.textContent ?? '', /Ready/);
    assert.match(banner.textContent ?? '', /Decisive Fact: Ready: Priority 1 option \(PI · claude-3-5-sonnet · high\) is ready/);

    // 3. Verify 2x2 Core Facts Grid
    assert.match(document.body.textContent ?? '', /Agent Identity & Portability Metadata/);
    assert.match(document.body.textContent ?? '', /Stable Identity/);
    assert.match(document.body.textContent ?? '', /programmer/);
    assert.match(document.body.textContent ?? '', /Status & Version/);
    assert.match(document.body.textContent ?? '', /ACTIVE · v3/);
    assert.match(document.body.textContent ?? '', /Private Memory/);
    assert.match(document.body.textContent ?? '', /26 memory entries/);

    // 4. Verify Standing Instructions
    assert.match(document.body.textContent ?? '', /Standing Instructions/);
    assert.match(document.body.textContent ?? '', /Write pure functions where possible; ensure build and verification scripts pass/);

    // 5. Verify Ordered Work Options
    assert.match(document.body.textContent ?? '', /Ordered Execution Preferences/);
    assert.match(document.body.textContent ?? '', /Priority 1 \(Primary\)/);
    assert.match(document.body.textContent ?? '', /PI/);
    assert.match(document.body.textContent ?? '', /claude-3-5-sonnet/);
    assert.match(document.body.textContent ?? '', /Priority 2 \(Fallback\)/);
    assert.match(document.body.textContent ?? '', /CODEX/);
    assert.match(document.body.textContent ?? '', /gpt-4o/);

    // 6. Verify Pre-Acceptance Fallback & No-Silent-Replay Guarantee Notice
    assert.match(document.body.textContent ?? '', /Pre-Acceptance Fallback & No-Silent-Replay Guarantee \(ADR-0008\)/);
    assert.match(document.body.textContent ?? /never silently replays work through lower-priority options/, /never silently replays work/);
  } finally {
    await cleanup();
  }
});

test('Agents: managing work options (add, reorder, delete, and minimum 1 option guard)', async () => {
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

    // 2. Reorder Options (Move Down Priority 1)
    const opt1Id = updatedAgent.workOptions[0]!.id;
    const opt2Id = updatedAgent.workOptions[1]!.id;

    stateManager.moveAgentWorkOption('programmer', opt1Id, 'down');
    updatedAgent = stateManager.getSnapshot().agents.find((a) => a.id === 'programmer')!;
    assert.equal(updatedAgent.workOptions[0]?.id, opt2Id);
    assert.equal(updatedAgent.workOptions[1]?.id, opt1Id);
    assert.equal(updatedAgent.version, initialVersion + 2);

    // 3. Move Up
    stateManager.moveAgentWorkOption('programmer', opt1Id, 'up');
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

test('Agents: project memberships and collaboration instructions separation', async () => {
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

    // Verify Project Memberships section
    assert.match(document.body.textContent ?? '', /Project Memberships & Responsibilities/);
    assert.match(document.body.textContent ?? '', /Three\.js Minesweeper Game/);
    assert.match(document.body.textContent ?? '', /Unity Room Lighting Prototype/);
    assert.match(document.body.textContent ?? '', /Responsibility:/);
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
    assert.match(document.body.textContent ?? '', /Archived Agent · Preserved attribution, private memory/);
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
