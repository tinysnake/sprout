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

test('Chat Scopes: renders Project Channel, Working Groups, and Direct Messages with previews and unread badges', async () => {
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
    const document = dom.window.document;

    // 1. Verify Scope Sections in Left Pane
    assert.match(document.body.textContent ?? '', /Project Channels/);
    assert.match(document.body.textContent ?? '', /Working Groups/);
    assert.match(document.body.textContent ?? '', /Direct Messages/);

    // 2. Verify Specific Scope Cards
    assert.match(document.body.textContent ?? '', /#general/);
    assert.match(document.body.textContent ?? '', /Core Mechanics WG/);
    assert.match(document.body.textContent ?? '', /WebAudio Effects WG/);
    assert.match(document.body.textContent ?? '', /@Programmer/);
    assert.match(document.body.textContent ?? '', /@Designer/);
    assert.match(document.body.textContent ?? '', /@Planner/);
    assert.match(document.body.textContent ?? '', /@Reviewer/);
    assert.match(document.body.textContent ?? '', /@Researcher/);

    // 3. Verify Last Message Previews and Unread Dots
    const previews = document.querySelectorAll('.chat-card-preview');
    assert.ok(previews.length >= 4, 'Renders last message subtitle previews');

    const unreadDots = document.querySelectorAll('.unread-badge-dot');
    assert.ok(unreadDots.length > 0, 'Renders unread red counter badges');
  } finally {
    await cleanup();
  }
});

test('Chat Navigation: switches between #general, Working Group, and DM scopes on desktop and mobile', async () => {
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
    const document = dom.window.document;

    // 1. Switch to Working Group
    stateManager.openChatDetail('working-group-channel', 'wg-mechanics');
    assert.equal(stateManager.getSnapshot().selectedScopeKind, 'working-group-channel');
    assert.equal(stateManager.getSnapshot().selectedWorkingGroupId, 'wg-mechanics');
    assert.match(document.querySelector('.card-title')?.textContent ?? '', /Core Mechanics WG/);
    assert.match(document.body.textContent ?? '', /Cascade recursion tested on 30x16 expert grid/);

    // 2. Switch to Direct Message with @Designer
    stateManager.openChatDetail('direct-message', 'designer');
    assert.equal(stateManager.getSnapshot().selectedScopeKind, 'direct-message');
    assert.equal(stateManager.getSnapshot().selectedDirectMessagePeerId, 'designer');
    assert.match(document.querySelector('.card-title')?.textContent ?? '', /@Designer/);

    // 3. Mobile Back to Chats
    stateManager.setViewportMode('mobile');
    const backBtn = document.querySelector('#btn-header-back-to-chats') as HTMLButtonElement;
    assert.ok(backBtn, 'Back button rendered in mobile header');
    backBtn.click();
    assert.equal(stateManager.getSnapshot().chatViewMode, 'list', 'Returned to chat list mode');
  } finally {
    await cleanup();
  }
});

test('Chat Composition: quick mention insertion, live addressing feedback, and sending message', async () => {
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
    const document = dom.window.document;

    const input = document.querySelector('#chat-main-input') as HTMLInputElement;
    const sendBtn = document.querySelector('#btn-send-chat-msg') as HTMLButtonElement;
    assert.ok(input);
    assert.ok(sendBtn);

    // 1. Enter message with mention
    input.value = '@all';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    assert.equal(input.value.trim(), '@all');

    // 2. Verify Live Addressing Feedback for deterministic mention
    const addressingPill = document.querySelector('#composer-addressing-pill');
    assert.match(addressingPill?.textContent ?? '', /Mention detected|Deterministic/);

    // 3. Send Message
    input.value = '@all Please check the coordinate raycasting test.';
    sendBtn.click();

    const snapshot = stateManager.getSnapshot();
    const sent = snapshot.messages.find((m) => m.content.includes('coordinate raycasting test'));
    assert.ok(sent, 'Message added to state');
    assert.equal(sent.disposition, 'addressed', 'Mention routes deterministically as addressed');
  } finally {
    await cleanup();
  }
});

test('Working Group Lifecycle: atomic creation, non-destructive disbanding, and restoration', async () => {
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
    const document = dom.window.document;

    // 1. Open Create WG Modal
    const createWgBtn = document.querySelector('#btn-create-wg') as HTMLButtonElement;
    assert.ok(createWgBtn);
    createWgBtn.click();

    let modal = document.querySelector('.proto-modal-dialog');
    assert.ok(modal);
    assert.match(modal.textContent ?? '', /Create Working Group/);

    const nameInput = modal.querySelector('#wg-name-input') as HTMLInputElement;
    nameInput.value = 'Shaders & Visual FX WG';
    const submitBtn = modal.querySelector('#btn-submit-create-wg') as HTMLButtonElement;
    submitBtn.click();

    // Verify WG added
    const proj = stateManager.getSnapshot().projects.find((p) => p.id === 'proj-minesweeper');
    const createdWg = proj?.workingGroups.find((w) => w.displayName === 'Shaders & Visual FX WG');
    assert.ok(createdWg, 'Working group created');
    assert.equal(createdWg.status, 'active');

    // 2. Test Disbanding Working Group (non-destructive)
    stateManager.disbandWorkingGroup('proj-minesweeper', createdWg.id);
    assert.equal(createdWg.status, 'disbanded');

    // Select the disbanded WG and check read-only banner
    stateManager.openChatDetail('working-group-channel', createdWg.id);
    assert.match(document.body.textContent ?? '', /This Working Group has been disbanded/);
    const inputEl = document.querySelector('#chat-main-input') as HTMLInputElement;
    assert.equal(inputEl.disabled, true, 'Composer disabled in disbanded WG');

    // 3. Test Restoring Working Group
    stateManager.restoreWorkingGroup('proj-minesweeper', createdWg.id);
    assert.equal(createdWg.status, 'active');
  } finally {
    await cleanup();
  }
});

test('Ended Agent Membership in DM: existing messages readable, composer disabled with explanation', async () => {
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
    stateManager.openChatDetail('direct-message', 'researcher');
    const document = dom.window.document;

    // 1. Verify Scope Title & Ended status
    assert.match(document.body.textContent ?? '', /@Researcher/);
    assert.match(document.body.textContent ?? '', /Ended/);

    // 2. Verify Historical Messages are preserved and visible
    assert.match(document.body.textContent ?? '', /Baseline WebGL benchmarks completed/);

    // 3. Verify Read-Only Notice and Disabled Composer
    assert.match(document.body.textContent ?? '', /Agent membership for @Researcher has ended in this project/);
    const input = document.querySelector('#chat-main-input') as HTMLInputElement;
    assert.equal(input.disabled, true, 'Composer disabled for ended agent membership');
  } finally {
    await cleanup();
  }
});

test('Durable Projected Replies: loop-prevention badge, provenance metadata, and non-routing boundary', async () => {
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
    const document = dom.window.document;

    // Verify Projected Reply elements
    const projectedBadge = document.querySelector('.badge-purple');
    assert.ok(projectedBadge, 'Projected reply badge rendered');
    assert.match(projectedBadge.textContent ?? '', /Projected Reply · Non-Routing/);

    // Verify Provenance Meta Card
    const metaCard = document.querySelector('.projected-reply-meta-card');
    assert.ok(metaCard, 'Projected reply provenance meta rendered');
    assert.match(metaCard.textContent ?? '', /run-202|run-201/);
    assert.match(metaCard.textContent ?? '', /wake-02|wake-01/);
    assert.match(metaCard.textContent ?? '', /Non-routing boundary/);
  } finally {
    await cleanup();
  }
});

test('Active 30s Collection Window: banner rendering and countdown inspection', async () => {
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
    const document = dom.window.document;

    // Verify Active Collection Window Banner
    const banner = document.querySelector('.chat-batch-window-banner');
    assert.ok(banner, 'Active 30s collection window banner rendered');
    assert.match(banner.textContent ?? '', /Active 30s Collection Window/);
    assert.match(banner.textContent ?? '', /unaddressed input queued/);

    const inspectBtn = banner.querySelector('.inspect-open-batch-btn') as HTMLButtonElement;
    assert.ok(inspectBtn);
    inspectBtn.click();

    const modal = document.querySelector('.proto-modal-dialog');
    assert.ok(modal, 'Inspector opened from open window banner');
    assert.match(modal.textContent ?? '', /Causal Wake Routing Inspector/);
  } finally {
    await cleanup();
  }
});

test('Causal Wake Routing Inspector: settles, suppresses, fails-closed, verifies context manifest & privacy exclusions', async () => {
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
    const document = dom.window.document;

    // 1. Open Inspector directly via message's causal routing batch tag
    const batchTag = document.querySelector('.msg-routing-tag') as HTMLElement;
    assert.ok(batchTag, 'Message causal routing tag exists');
    batchTag.click();

    let modal = document.querySelector('.proto-modal-dialog');
    assert.ok(modal);
    assert.match(modal.textContent ?? '', /Causal Wake Routing Inspector/);

    // Verify Bounded Context Manifest & Strict Privacy Exclusions
    assert.match(modal.textContent ?? '', /Frozen Context Bounds & Privacy Guarantee/);
    assert.match(modal.textContent ?? '', /Direct Messages & DMs: Strictly Excluded/i);
    assert.match(modal.textContent ?? '', /Agent Private Memory & Scratchpads: Strictly Excluded/i);
    assert.match(modal.textContent ?? '', /Engine Sessions & Raw Tool Transcripts: Strictly Excluded/i);
    assert.match(modal.textContent ?? '', /Network Credentials & Host Paths: Strictly Excluded/i);
    assert.match(modal.textContent ?? '', /Transient Environment Capacity: Strictly Excluded/i);

    // Verify Concise Rationale & Label
    assert.match(modal.textContent ?? '', /Model Judgement, Not Fact/);
    assert.match(modal.textContent ?? '', /Resulting WakeRequests & Run Admission/);

    // 2. Switch Batch to Suppressed Batch (batch-003)
    const select = modal.querySelector('#inspector-batch-select') as HTMLSelectElement;
    assert.ok(select);
    select.value = 'batch-003';
    select.dispatchEvent(new dom.window.Event('change'));

    modal = document.querySelector('.proto-modal-dialog');
    assert.match(modal?.textContent ?? '', /suppressed/);
    assert.match(modal?.textContent ?? '', /Casual conversational remark/);

    // 3. Switch Batch to Failed-Closed Batch (batch-004)
    const select2 = modal?.querySelector('#inspector-batch-select') as HTMLSelectElement;
    select2.value = 'batch-004';
    select2.dispatchEvent(new dom.window.Event('change'));

    modal = document.querySelector('.proto-modal-dialog');
    assert.match(modal?.textContent ?? '', /failed-closed/);
    assert.match(modal?.textContent ?? /Fail-Closed Outcome/i, /Fail-Closed/);
    assert.match(modal?.textContent ?? '', /Attempt #1/);
    assert.match(modal?.textContent ?? '', /Attempt #2/);

    // 4. Verify No Manual Route-Now or Retry Buttons Invariant
    assert.equal(modal?.querySelector('.route-now-btn'), null, 'No manual route now button');
    assert.equal(modal?.querySelector('.retry-routing-btn'), null, 'No manual retry routing button');
  } finally {
    await cleanup();
  }
});
