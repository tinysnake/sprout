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

test('Project Multi-View: renders project switcher, info button, and metadata modal', async () => {
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

    // Navigate to Project
    stateManager.setPrimaryNav('project', 'overview');

    const document = dom.window.document;

    // 1. Verify Project Selector Dropdown
    const projectSelector = document.querySelector('#project-selector') as HTMLSelectElement;
    assert.ok(projectSelector, 'Project dropdown selector rendered');
    assert.match(projectSelector.textContent ?? '', /Three.js Minesweeper Game/);

    // 2. Verify Project Info Button and Modal Popup
    const infoBtn = document.querySelector('#project-info-btn') as HTMLButtonElement;
    assert.ok(infoBtn, 'Project info button rendered');
    infoBtn.click();

    const infoModal = document.querySelector('.proto-modal-dialog');
    assert.ok(infoModal, 'Project info modal opened');
    assert.match(infoModal.textContent ?? '', /Project Information & Metadata/);
    assert.match(infoModal.textContent ?? '', /General collaboration template v1.0/);
    assert.match(infoModal.textContent ?? '', /Bound Workspaces/);
    assert.match(infoModal.textContent ?? '', /Active Project Members/);

    const closeBtn = infoModal.querySelector('.close-modal-btn') as HTMLButtonElement;
    closeBtn.click();
    assert.equal(document.querySelector('.proto-modal-backdrop'), null, 'Modal closed');
  } finally {
    await cleanup();
  }
});

test('Project Overview & Chat: renders contract, memberships, workspaces, and chat scope cards', async () => {
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

    // 1. Overview Tab
    stateManager.setPrimaryNav('project', 'overview');
    const document = dom.window.document;

    // Contract & Purpose Card
    assert.match(document.body.textContent ?? '', /Project Contract & Purpose/);
    assert.match(document.body.textContent ?? '', /Three.js 3D Minesweeper game/);

    // Wake Policy Switcher
    const policyBtn = document.querySelector('.toggle-policy-btn') as HTMLButtonElement;
    assert.ok(policyBtn, 'Wake policy button rendered');
    assert.match(policyBtn.textContent ?? '', /Switch to Explicit-only/);

    policyBtn.click();
    assert.equal(stateManager.getSnapshot().projects[0].wakePolicy, 'explicit-only');

    // Memberships List
    assert.match(document.body.textContent ?? '', /Project Memberships/);
    assert.match(document.body.textContent ?? '', /Operator \(Human\)/);
    assert.match(document.body.textContent ?? '', /Programmer/);

    // Bound Workspaces
    assert.match(document.body.textContent ?? '', /Bound Workspaces & Host Environments/);
    assert.match(document.body.textContent ?? '', /minesweeper-threejs/);

    // 2. Chat Tab with Scope Cards and Unread Badges
    stateManager.setPrimaryNav('project', 'chat');
    assert.ok(document.querySelector('.chat-scopes-grid'), 'Chat scopes grid rendered');

    const chatCards = document.querySelectorAll('.chat-scope-card');
    assert.ok(chatCards.length >= 3, 'Rendered #general, Working Group, and DM cards');

    assert.match(document.body.textContent ?? '', /#general/);
    assert.match(document.body.textContent ?? '', /Core Mechanics WG/);
    assert.match(document.body.textContent ?? '', /@Programmer/);

    // Check red unread badge dots
    const unreadDots = document.querySelectorAll('.unread-badge-dot');
    assert.ok(unreadDots.length > 0, 'Unread badge dots rendered');
  } finally {
    await cleanup();
  }
});

test('Task Operating Loop: proposal begin acquires lease and starts first lead run under Human authority', async () => {
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

    // Select proposed task
    stateManager.setPrimaryNav('project', 'tasks');
    stateManager.selectTask('task-105-prop');

    const document = dom.window.document;

    // Verify Proposal Authority Card
    const propTitle = document.querySelector('.stage-title');
    assert.ok(propTitle);
    assert.match(propTitle.textContent ?? '', /Task Proposal/);
    assert.match(document.body.textContent ?? '', /Holds NO Lease/);

    // Verify 3-part sentence for proposed task
    const lifecycleSentence = document.querySelector('.lifecycle-sentence-row');
    assert.match(lifecycleSentence?.textContent ?? '', /Task proposed · Executes NO run · Holds NO lease/);

    // Trigger Approve & Begin
    const approveBtn = document.querySelector('.approve-begin-btn') as HTMLButtonElement;
    assert.ok(approveBtn, 'Approve & Begin button present');
    approveBtn.click();

    // Verify Task transitioned to active, lease held, first lead run initiated
    const updatedTask = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-105-prop');
    assert.equal(updatedTask?.lifecycle, 'active');
    assert.equal(updatedTask?.leaseLifecycle, 'held');
    assert.equal(updatedTask?.agentRunLifecycle, 'running');
  } finally {
    await cleanup();
  }
});

test('Task Operating Loop: two-stage pause (admission hold) and intentional run interrupt (agent stop)', async () => {
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

    // Select active running task #102
    stateManager.setPrimaryNav('project', 'tasks');
    stateManager.selectTask('task-102');

    const document = dom.window.document;

    // 1. Stage 1: Request Pause (admission hold)
    const pauseBtn = document.querySelector('.pause-task-btn') as HTMLButtonElement;
    assert.ok(pauseBtn, 'Pause button rendered');
    pauseBtn.click();

    let task102 = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-102');
    assert.equal(task102?.lifecycle, 'Task pause requested');
    assert.equal(task102?.agentRunLifecycle, 'running', 'Active run is allowed to settle naturally');
    assert.equal(task102?.leaseLifecycle, 'held', 'Lease remains held');

    // 2. Stage 2: Intentional Interrupt (run stop)
    const interruptBtn = document.querySelector('.interrupt-run-btn') as HTMLButtonElement;
    assert.ok(interruptBtn, 'Interrupt button rendered');
    interruptBtn.click();

    task102 = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-102');
    assert.equal(task102?.lifecycle, 'paused');
    assert.equal(task102?.agentRunLifecycle, 'stopped', 'Run intentionally settled as stopped');
    assert.equal(task102?.leaseLifecycle, 'held', 'Lease remains held during pause');

    // 3. Resume Advancement
    const resumeBtn = document.querySelector('.resume-task-btn') as HTMLButtonElement;
    assert.ok(resumeBtn, 'Resume button rendered');
    resumeBtn.click();

    task102 = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-102');
    assert.equal(task102?.lifecycle, 'active');
  } finally {
    await cleanup();
  }
});

test('Task Operating Loop: routable blocker resolution and completion claim validation', async () => {
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

    // 1. Verify Routable Blocker on Task #103
    stateManager.setPrimaryNav('project', 'tasks');
    stateManager.selectTask('task-103');

    assert.match(document.body.textContent ?? '', /Routable Task Blocker/);
    assert.match(document.body.textContent ?? '', /Audio asset directory requires operator uncompress permission/);

    const resolveBtn = document.querySelector('.resolve-blocker-btn') as HTMLButtonElement;
    assert.ok(resolveBtn);
    resolveBtn.click();

    const task103 = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-103');
    assert.equal(task103?.lifecycle, 'active');
    assert.equal(task103?.activeBlocker, undefined);

    // 2. Verify Completion Claim Validation on Task #101
    stateManager.selectTask('task-101');
    assert.match(document.body.textContent ?? '', /Task Completion Claim Submitted for Human Validation/);
    assert.match(document.body.textContent ?? '', /scripts\/verify-o7-minesweeper-browser.ts/);

    const acceptBtn = document.querySelector('.accept-claim-btn') as HTMLButtonElement;
    assert.ok(acceptBtn);
    acceptBtn.click();

    const task101 = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-101');
    assert.equal(task101?.lifecycle, 'completed');
    assert.equal(task101?.leaseLifecycle, 'released', 'Safe Task End released the lease');
  } finally {
    await cleanup();
  }
});

test('Task Operating Loop: ordinary recovery protects lease and supports resume or safe discard', async () => {
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

    // Select Task #104 in recovery
    stateManager.setPrimaryNav('project', 'tasks');
    stateManager.selectTask('task-104');

    const document = dom.window.document;

    assert.match(document.body.textContent ?? '', /Task & Environment Lease in Recovery/);
    assert.match(document.body.textContent ?? '', /Lease Protection Guarantee/);

    // Test Ordinary Resume
    const resumeRecoveryBtn = document.querySelector('.ordinary-resume-btn') as HTMLButtonElement;
    assert.ok(resumeRecoveryBtn);
    resumeRecoveryBtn.click();

    const task104 = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-104');
    assert.equal(task104?.lifecycle, 'active');
    assert.equal(task104?.leaseLifecycle, 'held');
  } finally {
    await cleanup();
  }
});

test('Project Archiving: safely disabled when active task runs exist, enabled when clean', async () => {
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

    stateManager.setPrimaryNav('project', 'overview');
    const document = dom.window.document;

    // Verify archive warning banner when Task #102 is active
    assert.match(document.body.textContent ?? '', /Archive Safely Blocked/);

    // Settle all active tasks
    for (const t of stateManager.getSnapshot().tasks) {
      if (t.projectId === 'proj-minesweeper') {
        t.lifecycle = 'completed';
        t.agentRunLifecycle = 'completed';
        t.leaseLifecycle = 'released';
      }
    }
    stateManager.selectProject('proj-minesweeper');

    // Now archiving succeeds
    stateManager.archiveProject('proj-minesweeper');
    assert.equal(stateManager.getSnapshot().projects[0].status, 'archived');
  } finally {
    await cleanup();
  }
});

test('Task Operating Loop: filter dropdown, grid view, page drill-down, and back navigation', async () => {
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

    // Navigate to Tasks (List Mode)
    stateManager.setPrimaryNav('project', 'tasks');
    stateManager.closeTaskDetail(false);

    const document = dom.window.document;

    // 1. Verify Single Filter Dropdown
    const filterSelect = document.querySelector('#task-filter-select') as HTMLSelectElement;
    assert.ok(filterSelect, 'Task filter dropdown rendered');
    assert.match(filterSelect.textContent ?? '', /All Tasks/);
    assert.match(filterSelect.textContent ?? '', /Active \/ Running/);

    // 2. Verify Responsive Tasks Grid
    const tasksGrid = document.querySelector('.tasks-grid');
    assert.ok(tasksGrid, 'Tasks responsive grid view rendered');

    const cards = document.querySelectorAll('.task-grid-card');
    assert.ok(cards.length >= 5, 'Grid contains task cards');

    // 3. Test Filter Dropdown Change
    filterSelect.value = 'active';
    filterSelect.dispatchEvent(new dom.window.Event('change'));

    const filteredCards = document.querySelectorAll('.task-grid-card');
    assert.equal(filteredCards.length, 1, 'Filtered to active task only');
    assert.match(filteredCards[0].textContent ?? '', /#102/);

    // 4. Test Page Drill-down by clicking card
    (filteredCards[0] as HTMLElement).click();

    // Verify we switched to Task Detail Page
    const backBtn = document.querySelector('.back-to-tasks-btn') as HTMLButtonElement;
    assert.ok(backBtn, 'Back to Tasks button rendered in App-Header');

    // Verify Detail Page has lifecycle sentence & operating controls
    assert.match(document.body.textContent ?? '', /Task active · Agent running · Lease held/);

    // 5. Test Back Button navigation back to List Page
    backBtn.click();
    assert.ok(document.querySelector('.tasks-grid'), 'Returned to Tasks Grid view');
  } finally {
    await cleanup();
  }
});
