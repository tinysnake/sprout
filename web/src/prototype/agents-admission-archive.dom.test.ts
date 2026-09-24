import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



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
