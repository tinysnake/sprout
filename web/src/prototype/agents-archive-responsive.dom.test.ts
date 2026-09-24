import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



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
