import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



test('Feed routing targets preserve their batch id and open the authoritative inspector', async () => {
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

    stateManager.setPrimaryNav('feed');
    stateManager.setFeedStatePreset('degraded');
    const attentionTarget = dom.window.document.querySelector(
      '[data-attention-id="att-deg-3"]'
    ) as HTMLButtonElement | null;
    assert.ok(attentionTarget);
    attentionTarget.click();

    let snapshot = stateManager.getSnapshot();
    assert.equal(snapshot.inspectorSheet.entityId, 'batch-004');
    assert.equal(snapshot.inspectorSheet.isOpen, true);
    assert.equal(snapshot.inspectorSheet.kind, 'routing');
    assert.match(dom.window.document.querySelector('.inspector-sheet')?.textContent ?? '', /Batch ID:.*batch-004/);

    stateManager.closeInspector();
    stateManager.clearReturnContext();
    stateManager.setPrimaryNav('feed');
    stateManager.setFeedStatePreset('mixed');
    const activityTarget = dom.window.document.querySelector('[data-act-id="act-6"]') as HTMLButtonElement | null;
    assert.ok(activityTarget);
    activityTarget.click();

    snapshot = stateManager.getSnapshot();
    assert.equal(snapshot.inspectorSheet.entityId, 'batch-002');
    assert.equal(snapshot.inspectorSheet.isOpen, true);
    assert.equal(snapshot.inspectorSheet.kind, 'routing');
    assert.match(dom.window.document.querySelector('.inspector-sheet')?.textContent ?? '', /Batch ID:.*batch-002/);
  } finally {
    await cleanup();
  }
});
