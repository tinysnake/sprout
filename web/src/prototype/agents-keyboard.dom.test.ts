import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



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
