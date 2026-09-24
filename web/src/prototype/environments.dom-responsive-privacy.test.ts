import assert from 'node:assert/strict';

import { test } from 'node:test';


import { setupPrototypeDom } from './dom-harness.ts';


test('Environments: Phone and desktop responsive parity & drill-down navigation', async () => {
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

    // 1. Mobile Viewport Drill-Down
    stateManager.setViewportMode('mobile');
    stateManager.setPrimaryNav('manage', undefined, 'environments');
    stateManager.closeEnvironmentDetail(false);

    const document = dom.window.document;

    // Master list rendered
    const card = document.querySelector('.env-master-card[data-env="env-ready"]') as HTMLElement;
    assert.ok(card, 'Master card rendered in mobile list');
    card.click();

    // In detail view, back button is rendered
    const backBtn = document.querySelector('#btn-back-to-envs') as HTMLButtonElement;
    assert.ok(backBtn, 'Mobile back button rendered in detail view');
    backBtn.click();

    assert.equal(stateManager.getSnapshot().environmentViewMode, 'list');

    // 2. Desktop Viewport Split Layout
    stateManager.setViewportMode('desktop');
    const splitLayout = document.querySelector('.envs-split-layout');
    assert.ok(splitLayout, 'Desktop 2-column split layout rendered');
    assert.ok(document.querySelector('.envs-master-column'), 'Left master column rendered');
    assert.ok(document.querySelector('.envs-detail-column'), 'Right detail column rendered');
  } finally {
    await cleanup();
  }
});


test('Environments: Strict privacy boundary ensures no private host paths or credentials appear', async () => {
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

    stateManager.setPrimaryNav('manage', undefined, 'environments');

    const text = dom.window.document.body.textContent ?? '';
    const snapshot = stateManager.getSnapshot();

    // Verify strict absence of concrete local paths, network addresses, or credentials.
    assert.doesNotMatch(text, /(?:^|[^A-Za-z])(?:~\/|\/(?:Users|home|var)\/|[A-Za-z]:\\)/, 'No local filesystem path in DOM');
    assert.doesNotMatch(text, /(?:10\.|127\.0\.0\.1|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d)\.)/, 'No private network address in DOM');
    assert.doesNotMatch(text, /(?:api[_-]?key|secret|private[_-]?key|password|token)\s*[:=]\s*\S+/i, 'No credential-shaped value in DOM');
    assert.equal(snapshot.operator.overlayAddress, undefined, 'Fixture does not retain a concrete transport address');
    assert.ok(snapshot.environments.every((environment) => environment.workerIdentityKey === 'identity-withheld'), 'Fixture withholds worker identity values');
    assert.ok(snapshot.environments.every((environment) => environment.workspaceRoots.every((root) => root === 'workspace-root')), 'Fixture uses a neutral workspace root');
    assert.doesNotMatch(JSON.stringify(snapshot), /(?:100\.64\.|192\.168\.|\/Users\/|C:\\Users\\|sprout-wk-|api[_-]?key\s*[:=])/i, 'Fixture state has no concrete host-boundary values');
  } finally {
    await cleanup();
  }
});
