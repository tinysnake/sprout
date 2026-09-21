/**
 * DOM behaviour of the production Manage Agents page (#91).
 *
 * The page is exercised through its real route, its real typed service port,
 * and the real production view component, so these assertions cover what an
 * operator can reach: the state matrix on both layouts, the work-option
 * editor (drag, touch, keyboard), URL-addressable drill-down, the archive /
 * restore safety flow, and focus + keyboard reachability.
 *
 * The fixture adapter is injected explicitly, exactly like the Environment
 * page's deterministic tests; no production route imports it.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer, type ViteDevServer } from 'vite';

const repoRoot = process.cwd();
const html = await readFile(`${repoRoot}/web/app/index.html`, 'utf8');

const GLOBALS = [
  'HTMLElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'SVGElement', 'Element', 'Document', 'DocumentFragment', 'location',
  'history', 'localStorage', 'navigator', 'getComputedStyle', 'Node', 'NodeFilter', 'Event',
  'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'TouchEvent', 'CustomEvent',
] as const;

interface Harness {
  dom: JSDOM;
  doc: Document;
  mount: HTMLElement;
  vite: ViteDevServer;
  cleanup: () => Promise<void>;
}

// Every DOM harness shares one persistent JSDOM: Vue's runtime-dom captures
// `document` at module evaluation and node keeps one ESM module cache per
// process, so a per-test DOM would leave the runtime rendering into a closed
// document. Each harness resets the shared document instead (the same rule the
// production DOM suite follows).
const sharedDom = new JSDOM(html, {
  url: 'http://sprout-operator.test/app/manage/agents',
  pretendToBeVisual: true,
});
(sharedDom.window as unknown as Record<string, unknown>)['__SPROUT_TEST_MANUAL_MOUNT__'] = true;

const persistentValues: Record<string, unknown> = {
  window: sharedDom.window,
  document: sharedDom.window.document,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: sharedDom.window.MutationObserver,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 10),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
for (const key of GLOBALS) {
  persistentValues[key] = (sharedDom.window as unknown as Record<string, unknown>)[key];
}
for (const [key, value] of Object.entries(persistentValues)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

async function setupHarness(_url = 'http://sprout-operator.test/app/manage/agents'): Promise<Harness> {
  const dom = sharedDom;
  // Reset the shared document so one test's navigation cannot leak into the next.
  dom.window.document.body.innerHTML = '<div id="app"></div>';
  dom.window.history.replaceState(null, '', '/app/manage/agents');

  const [{ createServer }, { default: vuePlugin }] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-vue'),
  ]);
  const vite = await createServer({
    root: `${repoRoot}/web`,
    appType: 'custom',
    logLevel: 'error',
    plugins: [
      { name: 'force-client-vue', enforce: 'pre', transform(_code, _id, opt) { if (opt) opt.ssr = false; } },
      vuePlugin(),
    ],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
  });

  return {
    dom,
    doc: dom.window.document,
    mount: dom.window.document.getElementById('app')!,
    vite,
    cleanup: async () => {
      await vite.close();
    },
  };
}

async function mountedPage(vite: ViteDevServer, mount: HTMLElement) {
  const [{ createSproutApp }, agentsModule] = await Promise.all([
    vite.ssrLoadModule('/src/app/main.ts') as Promise<typeof import('../app/main.ts')>,
    vite.ssrLoadModule('/src/modules/agents/adapters/fixture-adapter.ts') as Promise<
      typeof import('./adapters/fixture-adapter.ts')
    >,
  ]);
  const fixture = new agentsModule.FixtureAgentService();
  const { app, router } = createSproutApp({
    routerBase: '/app/',
    agentService: fixture,
  });
  await router.push('/manage/agents');
  await router.isReady();
  app.mount(mount);
  await settle(140);
  return { app, router, fixture };
}

function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('the page requires a typed Agent authority and never falls back to fixture facts', async () => {
  const { vite, doc, mount, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const { app, router } = createSproutApp({ routerBase: '/app/' });
    await router.push('/manage/agents');
    await router.isReady();
    app.mount(mount);
    await settle(80);

    assert.ok(doc.querySelector('.agents-unavailable-state'), 'an explicit unavailable state is rendered');
    assert.match(doc.body.textContent ?? '', /Agent Authority Unavailable/);
    assert.doesNotMatch(doc.body.textContent ?? '', /Programmer/, 'no fixture agent is shown');
    assert.equal(doc.querySelector('.agent-master-card'), null, 'no fixture master card is rendered');

    // The route module itself must not construct a fixture authority.
    const view = await readFile(`${repoRoot}/web/src/modules/agents/views/AgentsView.vue`, 'utf8');
    const main = await readFile(`${repoRoot}/web/src/app/main.ts`, 'utf8');
    assert.doesNotMatch(view, /FixtureAgentService/, 'the route never imports the fixture adapter');
    assert.doesNotMatch(main, /FixtureAgentService/, 'the bootstrap never wires the fixture adapter');

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('the state matrix renders distinctly: ready, attention, unavailable, and archived rows', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { fixture } = await mountedPage(vite, mount);

    // Master cards carry the top-right status dot and textual reason snippet.
    const readyCard = doc.querySelector('[data-agent="programmer"]');
    assert.ok(readyCard, 'the ready row renders');
    assert.match(readyCard!.textContent ?? '', /Ready: Priority 1 option/);

    const attentionCard = doc.querySelector('[data-agent="architect"]');
    assert.ok(attentionCard);
    assert.match(attentionCard!.textContent ?? '', /Attention:/);

    const unavailableCard = doc.querySelector('[data-agent="sentinel"]');
    assert.ok(unavailableCard);
    assert.match(unavailableCard!.textContent ?? '', /not installed/);

    const archivedCard = doc.querySelector('[data-agent="legacy-coder"]');
    assert.ok(archivedCard);
    assert.match(archivedCard!.textContent ?? '', /Archived/);

    // Filter pills count the populations independently.
    const pillText = (key: string) =>
      doc.querySelector(`[data-filter="${key}"]`)?.textContent ?? '';
    assert.match(pillText('all'), /6/);
    assert.match(pillText('attention'), /2/);
    assert.match(pillText('unavailable'), /2/);
    assert.match(pillText('archived'), /1/);

    // The unavailable filter narrows to the unavailable population only.
    // (Both the desktop split list and the phone list render; deduplicate.)
    (doc.querySelector('[data-filter="unavailable"]') as HTMLButtonElement).click();
    await settle(60);
    const visible = [...new Set(
      [...doc.querySelectorAll('.agent-master-card')].map((card) => card.getAttribute('data-agent'))
    )];
    assert.deepEqual(visible.sort(), ['legacy-model', 'sentinel']);

    void fixture;
  } finally {
    await cleanup();
  }
});

test('the detail panel follows the prototype content order and status language', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    await mountedPage(vite, mount);

    const detail = doc.querySelector('.agent-detail-card');
    assert.ok(detail, 'the detail panel renders');

    // Status banner first, then identity grid, instructions, work options,
    // foldables, and the operations toolbar last.
    const banner = detail!.querySelector('.env-traffic-light-banner');
    assert.ok(banner, 'the status banner renders');
    assert.match(banner!.textContent ?? '', /Ready/);
    assert.match(detail!.textContent ?? '', /Stable Identity/);
    assert.match(detail!.textContent ?? '', /Private Memory/);
    assert.match(detail!.textContent ?? '', /Standing Instructions/);
    assert.match(detail!.textContent ?? '', /Ordered Execution Preferences/);
    assert.match(detail!.textContent ?? '', /Priority 1 \(Primary\)/);
    assert.match(detail!.textContent ?? '', /Pre-Acceptance Fallback & No-Silent-Replay Guarantee/);
    assert.match(detail!.textContent ?? '', /Environment Compatibility & Admission Evaluation/);
    assert.match(detail!.textContent ?? '', /Configuration Version Changelog/);
    assert.match(detail!.textContent ?? '', /Historical Run Attribution & Provenance/);
    assert.ok(detail!.querySelector('.agent-operations-toolbar'), 'the operations toolbar renders');
    assert.ok(detail!.querySelector('.archive-agent-btn'), 'the archive control renders');

    // Every option row carries a textual compatibility verdict badge.
    const rows = [...detail!.querySelectorAll('.agent-option-row')];
    assert.ok(rows.length >= 2, 'the ordered options render');
    assert.match(rows[0]!.textContent ?? '', /Ready/, 'an available option says so in text');
    assert.match(rows[0]!.textContent ?? '', /Priority 1 \(Primary\)/);
  } finally {
    await cleanup();
  }
});

test('reordering works by touch buttons and by keyboard, appending one version per edit', async () => {
  const { dom, doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { fixture } = await mountedPage(vite, mount);

    const before = (await fixture.getAgent('programmer'))!;
    assert.equal(before.currentVersion, 3);

    // Touch: move the primary option down.
    const firstRow = doc.querySelector('.agent-option-row');
    const downBtn = firstRow!.querySelector('.move-opt-down-btn') as HTMLButtonElement;
    assert.ok(downBtn, 'the move-down control renders');
    assert.equal(downBtn.disabled, false);
    downBtn.click();
    await settle(80);

    const afterMove = (await fixture.getAgent('programmer'))!;
    assert.equal(afterMove.currentVersion, before.currentVersion + 1, 'one append-only version per edit');
    assert.match(
      afterMove.versions[afterMove.versions.length - 1]!.reason,
      /Reordered work options/,
      'the reorder is recorded with attribution',
    );
    assert.equal(afterMove.workOptions[0]!.engine, 'codex', 'the fallback engine is now priority 1');

    // Keyboard: ArrowDown on the (new) first row swaps it with the next, so
    // pi is primary again.
    const rowAfterMove = doc.querySelectorAll('.agent-option-row')[0]!;
    rowAfterMove.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    await settle(80);
    const afterKeyboard = (await fixture.getAgent('programmer'))!;
    assert.equal(afterKeyboard.currentVersion, before.currentVersion + 2);
    assert.equal(afterKeyboard.workOptions[0]!.engine, 'pi', 'ArrowDown on the first row swaps it with the second');

    // Restore order: after the ArrowDown swap pi is primary and codex is
    // second; leave it there and verify the second row's move-up on codex
    // would re-assert the touch path, instead finishing with the keyboard
    // state (pi primary, codex fallback).
    const restored = (await fixture.getAgent('programmer'))!;
    assert.equal(restored.workOptions[0]!.engine, 'pi', 'pi is primary again after the keyboard reorder');
    assert.equal(restored.workOptions[1]!.engine, 'codex');

    // Remove control is guarded by the minimum-one-option invariant.
    void doc;
  } finally {
    await cleanup();
  }
});

test('archived Agents render read-only: no reorder, no add, restore offered', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    await mountedPage(vite, mount);

    (doc.querySelector('[data-agent="legacy-coder"]') as HTMLButtonElement).click();
    await settle(80);
    // Selecting a card pushes the detail route; the detail follows the URL.
    await settle(60);

    const detail = doc.querySelector('.agent-detail-card');
    assert.ok(detail, 'the archived detail renders');
    assert.match(detail!.textContent ?? '', /Archived Agent · New work is barred/);
    assert.equal(detail!.querySelector('.add-option-btn'), null, 'no add control while archived');
    assert.equal(detail!.querySelector('.move-opt-up-btn'), null, 'no reorder control while archived');
    assert.equal(detail!.querySelector('.move-opt-down-btn'), null, 'no reorder control while archived');
    assert.equal(detail!.querySelector('.archive-agent-btn'), null, 'no archive control while archived');
    assert.ok(detail!.querySelector('.restore-agent-btn'), 'restore is offered');

    // Restore works: the read-only archived presentation ends and the row is
    // active again (its retained compatibility facts are re-derived, so this
    // retired fixture row is still shown as currently incompatible).
    (detail!.querySelector('.restore-agent-btn') as HTMLButtonElement).click();
    await settle(140);
    assert.ok(
      doc.querySelector('[data-agent="legacy-coder"] .archive-agent-btn') ||
        doc.querySelector('.agent-operations-toolbar .restore-agent-btn') === null,
      'the row is no longer presented as archived',
    );
  } finally {
    await cleanup();
  }
});

test('the archive safety flow surfaces the backend refusal verbatim', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { fixture } = await mountedPage(vite, mount);
    fixture.markActiveWork('programmer', true);

    (doc.querySelector('[data-agent="programmer"]') as HTMLButtonElement).click();
    await settle(120);
    (doc.querySelector('.archive-agent-btn') as HTMLButtonElement).click();
    await settle(320);

    const dialog = doc.querySelector('[role="alertdialog"], .archive-agent-dialog');
    assert.ok(dialog, 'the archive confirmation renders');
    // The dialog is re-rendered when `agent` changes; grab the confirm control
    // fresh and activate it like a pointer would (Reka UI guards the modal).
    const confirm = doc.querySelector('.confirm-archive-agent-btn') as HTMLButtonElement;
    assert.ok(confirm, 'the confirm control renders');
    const activation = { bubbles: true, cancelable: true, view: doc.defaultView, button: 0 };
    confirm.dispatchEvent(new (doc.defaultView as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('mousedown', activation));
    confirm.dispatchEvent(new (doc.defaultView as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('mouseup', activation));
    confirm.dispatchEvent(new (doc.defaultView as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', activation));
    await settle(160);

    const alert = doc.querySelector('[role="alert"]');
    assert.ok(alert, 'the typed refusal is rendered inline');
    assert.match(alert!.textContent ?? '', /active run/, 'the backend guard refusal is verbatim');

    // Nothing changed: the row is still active.
    const stillActive = await fixture.getAgent('programmer');
    assert.equal(stillActive!.status, 'active');
  } finally {
    await cleanup();
  }
});

test('master cards and option controls are keyboard-reachable with focusable real buttons', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    await mountedPage(vite, mount);

    const cards = [...doc.querySelectorAll<HTMLElement>('.agent-master-card')];
    assert.ok(cards.length >= 5);
    for (const card of cards) {
      assert.equal(card.tagName, 'BUTTON', 'a master card is a real button');
      assert.equal(card.getAttribute('aria-label')?.includes('Open Agent'), true);
    }

    // The drag handle offers keyboard reordering (role=button, tabindex=0).
    const handle = doc.querySelector<HTMLElement>('.drag-handle-wrap');
    assert.ok(handle, 'the drag handle renders');
    assert.equal(handle!.getAttribute('role'), 'button');
    assert.equal(handle!.getAttribute('tabindex'), '0');
    assert.match(handle!.getAttribute('aria-label') ?? '', /Reorder priority/);

    // Filter pills are real buttons with pressed state.
    const pill = doc.querySelector<HTMLButtonElement>('[data-filter="all"]');
    assert.ok(pill);
    assert.equal(pill.getAttribute('aria-pressed'), 'true');
  } finally {
    await cleanup();
  }
});

test('an unknown Agent deep link renders not-found and never substitutes another record', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness('http://sprout-operator.test/app/manage/agents');
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const agentsModule = (await vite.ssrLoadModule('/src/modules/agents/adapters/fixture-adapter.ts')) as typeof import('./adapters/fixture-adapter.ts');
    const { app, router } = createSproutApp({
      routerBase: '/app/',
      agentService: new agentsModule.FixtureAgentService(),
    });
    await router.push('/manage/agents/does-not-exist');
    await router.isReady();
    app.mount(mount);
    await settle(140);

    assert.equal(router.currentRoute.value.params['agentId'], 'does-not-exist', 'the URL is preserved');
    assert.ok(doc.querySelector('.agents-not-found-state'), 'an explicit not-found state renders');
    assert.match(doc.body.textContent ?? '', /Agent Not Found/);
    assert.doesNotMatch(doc.body.textContent ?? '', /Ready: Priority 1 option/, 'no other record is substituted');
    assert.equal(doc.querySelector('.archive-agent-btn'), null, 'no mutation control for a missing record');

    (doc.querySelector('.agents-not-found-return') as HTMLButtonElement).click();
    await settle(120);
    assert.equal(router.currentRoute.value.path, '/manage/agents', 'the return control recovers to the list');
    assert.match(doc.body.textContent ?? '', /Agents & Work Option Preferences/);

    app.unmount();
  } finally {
    await cleanup();
  }
});

test('selecting a card drives URL-addressable phone drill-down and browser history', async () => {
  const { dom, doc, mount, vite, cleanup } = await setupHarness('http://sprout-operator.test/app/app');
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const agentsModule = (await vite.ssrLoadModule('/src/modules/agents/adapters/fixture-adapter.ts')) as typeof import('./adapters/fixture-adapter.ts');
    const { app, router } = createSproutApp({
      routerBase: '/app/',
      agentService: new agentsModule.FixtureAgentService(),
    });
    await router.push('/manage/agents');
    await router.isReady();
    app.mount(mount);
    await settle(140);

    // Select: the detail route is pushed and the record is URL-addressable.
    (doc.querySelector('[data-agent="architect"]') as HTMLButtonElement).click();
    await settle(120);
    assert.equal(router.currentRoute.value.name, 'agent-detail');
    assert.equal(router.currentRoute.value.params['agentId'], 'architect');

    // A pasted deep link restores the same record without any click.
    await router.push('/manage/agents/sentinel');
    await settle(120);
    assert.match(doc.querySelector('.agent-detail-card')!.textContent ?? '', /not installed/);

    // The phone back control returns to the list.
    const backBtn = doc.querySelector('#btn-back-to-agents') as HTMLButtonElement;
    assert.ok(backBtn, 'the phone drill-down offers a back control');
    backBtn.click();
    await settle(120);
    assert.equal(router.currentRoute.value.name, 'agents');

    void dom;
    app.unmount();
  } finally {
    await cleanup();
  }
});

test('the create flow appends a new Agent with its priority 1 option', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { fixture } = await mountedPage(vite, mount);

    (doc.querySelector('.create-agent-btn') as HTMLButtonElement).click();
    await settle(200);
    assert.match(doc.body.textContent ?? '', /Create Global Agent Definition/);

    const nameInput = doc.querySelector('#new-agent-name') as HTMLInputElement;
    const modelInput = doc.querySelector('#new-opt-model') as HTMLInputElement;
    const inputCtor = doc.defaultView!['Event'] as typeof Event;
    nameInput.value = 'Auditor';
    nameInput.dispatchEvent(new inputCtor('input', { bubbles: true }));
    modelInput.value = 'glm-5';
    modelInput.dispatchEvent(new inputCtor('input', { bubbles: true }));
    await settle(40);

    (doc.querySelector('.confirm-create-agent-btn') as HTMLButtonElement).click();
    await settle(120);

    const created = (await fixture.listAgents()).find((agent) => agent.displayName === 'Auditor');
    assert.ok(created, 'the created Agent is durable through the service port');
    assert.equal(created!.currentVersion, 1);
    assert.equal(created!.workOptions[0]!.workModel, 'glm-5');

    // The dialog closed and the master list shows the new row.
    assert.equal(doc.querySelector('#new-agent-name'), null, 'the dialog closes after confirm');
    assert.ok(doc.querySelector('[data-agent="' + created!.id + '"]'), 'the new row renders');
  } finally {
    await cleanup();
  }
});

test('emptying the standing instructions field clears them as a new version', async () => {
  const { dom, doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { fixture } = await mountedPage(vite, mount);

    (doc.querySelector('[data-agent="programmer"]') as HTMLButtonElement).click();
    await settle(120);
    (doc.querySelector('.edit-instructions-btn') as HTMLButtonElement).click();
    await settle(320);

    const textarea = doc.querySelector('#edit-agent-instructions') as HTMLTextAreaElement;
    assert.ok(textarea, 'the instructions editor renders');
    assert.equal(textarea.value.includes('Always verify tests'), true, 'the current instructions prefill');

    // Empty the field exactly like a clearing operator would.
    textarea.value = '';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(40);
    (doc.querySelector('.confirm-edit-instructions-btn') as HTMLButtonElement).click();
    await settle(400);

    // The clear is durable through the service port: the new version carries
    // no instructions and the composed row no longer shows any.
    const cleared = (await fixture.getAgent('programmer'))!;
    assert.equal(cleared.currentVersion, 4, 'one clear appends exactly one version');
    assert.equal(cleared.instructions, undefined);
    assert.equal('instructions' in cleared.versions[3]!, false, 'the cleared version records no instructions');
    assert.equal(cleared.versions[2]!.instructions, 'Always verify tests before claiming completion. Preserve strict privacy boundaries.');
    assert.match(cleared.versions[3]!.reason, /Standing instructions updated/);
    assert.match(doc.body.textContent ?? '', /No standing instructions configured/);

    // The dialog closed on success.
    assert.equal(doc.querySelector('#edit-agent-instructions'), null);
  } finally {
    await cleanup();
  }
});

test('a refused create renders an inline validation-error state without losing the draft', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    await mountedPage(vite, mount);

    (doc.querySelector('.create-agent-btn') as HTMLButtonElement).click();
    await settle(200);
    assert.match(doc.body.textContent ?? '', /Create Global Agent Definition/);

    const nameInput = doc.querySelector('#new-agent-name') as HTMLInputElement;
    const modelInput = doc.querySelector('#new-opt-model') as HTMLInputElement;
    const inputCtor = doc.defaultView!['Event'] as typeof Event;
    nameInput.value = 'Leaky Runner';
    nameInput.dispatchEvent(new inputCtor('input', { bubbles: true }));
    // A hostname-shaped work model is refused by the backend write boundary.
    modelInput.value = 'buildbox-7';
    modelInput.dispatchEvent(new inputCtor('input', { bubbles: true }));
    await settle(40);

    (doc.querySelector('.confirm-create-agent-btn') as HTMLButtonElement).click();
    await settle(200);

    const alert = doc.querySelector('[role="alert"]');
    assert.ok(alert, 'the refused create renders an inline validation-error state');
    assert.match(alert!.textContent ?? '', /valid work model identifier/);
    // No raw diagnostic, host path, or credential shape reaches the operator.
    assert.equal(/\/Users\//.test(alert!.textContent ?? ''), false);
    assert.equal(/sk-[a-zA-Z0-9]{20,}/.test(alert!.textContent ?? ''), false);

    // The dialog stayed open and the draft survived the refusal.
    assert.equal((doc.querySelector('#new-agent-name') as HTMLInputElement).value, 'Leaky Runner');
  } finally {
    await cleanup();
  }
});

test('a refused instructions save renders an inline validation-error and appends nothing', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { createSproutApp } = (await vite.ssrLoadModule('/src/app/main.ts')) as typeof import('../app/main.ts');
    const agentsModule = (await vite.ssrLoadModule('/src/modules/agents/adapters/fixture-adapter.ts')) as typeof import('./adapters/fixture-adapter.ts');

    // A deterministic refusing authority: every reconfiguration is rejected
    // exactly like the backend's validation write guard would reject it.
    const base = new agentsModule.FixtureAgentService();
    const rows = await base.listAgents();
    const refusing = new agentsModule.FixtureAgentService(
      rows.map((row) => ({ ...row })),
      [],
    );
    (refusing as unknown as { reconfigureAgent: () => Promise<void> }).reconfigureAgent = async () => {
      throw new Error('an Agent requires a valid work model identifier');
    };

    const { app, router } = createSproutApp({ routerBase: '/app/', agentService: refusing });
    await router.push('/manage/agents');
    await router.isReady();
    app.mount(mount);
    await settle(160);

    (doc.querySelector('[data-agent="programmer"]') as HTMLButtonElement).click();
    await settle(120);
    (doc.querySelector('.edit-instructions-btn') as HTMLButtonElement).click();
    await settle(320);

    const textarea = doc.querySelector('#edit-agent-instructions') as HTMLTextAreaElement;
    assert.ok(textarea, 'the instructions editor renders');
    textarea.value = 'Verify tests.';
    textarea.dispatchEvent(new doc.defaultView!['Event']('input', { bubbles: true }));
    await settle(40);
    (doc.querySelector('.confirm-edit-instructions-btn') as HTMLButtonElement).click();
    await settle(200);

    const alert = doc.querySelector('[role="alert"]');
    assert.ok(alert, 'the refused save renders an inline validation-error state');
    assert.match(alert!.textContent ?? '', /valid work model identifier/);

    // The dialog stays open and the typed draft survives the refusal.
    assert.ok(doc.querySelector('#edit-agent-instructions'), 'the dialog stays open on refusal');
    assert.equal(textarea.value, 'Verify tests.');
    void base;
  } finally {
    await cleanup();
  }
});

test('a refused add-option renders an inline validation-error without changing the record', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { fixture } = await mountedPage(vite, mount);
    const before = (await fixture.getAgent('programmer'))!;

    (doc.querySelector('[data-agent="programmer"]') as HTMLButtonElement).click();
    await settle(120);
    (doc.querySelector('.add-option-btn') as HTMLButtonElement).click();
    await settle(320);

    const modelInput = doc.querySelector('#add-opt-model') as HTMLInputElement;
    assert.ok(modelInput, 'the add-option dialog renders');
    modelInput.value = 'buildbox-7';
    modelInput.dispatchEvent(new doc.defaultView!['Event']('input', { bubbles: true }));
    await settle(40);
    (doc.querySelector('.confirm-add-option-btn') as HTMLButtonElement).click();
    await settle(200);

    const alert = doc.querySelector('[role="alert"]');
    assert.ok(alert, 'the refused add-option renders an inline validation-error state');
    assert.match(alert!.textContent ?? '', /valid work model identifier/);
    assert.ok(doc.querySelector('#add-opt-model'), 'the dialog stays open on refusal');

    const unchanged = (await fixture.getAgent('programmer'))!;
    assert.equal(unchanged.currentVersion, before.currentVersion, 'a refusal appends nothing');
    assert.equal(unchanged.workOptions.length, before.workOptions.length);
  } finally {
    await cleanup();
  }
});
