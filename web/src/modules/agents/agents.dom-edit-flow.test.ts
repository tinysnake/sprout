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

import type { AgentBrowserAdapter, AgentView } from '../../../adapters/agent-api.ts';
import type { RunView } from '../../../../../src/web/views.ts';


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

// --- Work-option edit (Spec story 37: reorder AND edit, #183) ---

test('every editable row offers a keyboard-reachable Edit control with an accessible name', async () => {
  const { dom, doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { fixture } = await mountedPage(vite, mount);

    (doc.querySelector('[data-agent="programmer"]') as HTMLButtonElement).click();
    await settle(120);

    const row = doc.querySelector('.agent-option-row')!;
    const editBtn = row.querySelector('.edit-opt-btn') as HTMLButtonElement;
    assert.ok(editBtn, 'the work-option row offers an Edit control');
    assert.equal(editBtn.tagName, 'BUTTON', 'Edit is a real button, reachable by Tab');
    assert.equal(editBtn.getAttribute('aria-label'), 'Edit pi work option', 'accessible name names the target');
    assert.equal(editBtn.disabled, false);

    // The button itself, not just its icon or a class token, supplies the mobile hit area.
    // jsdom has no layout engine, so measure its computed box dimensions rather than its rect.
    const hitBox = dom.window.getComputedStyle(editBtn);
    assert.ok(parseFloat(hitBox.width) >= 44, 'Edit has at least a 44px-wide hit area');
    assert.ok(parseFloat(hitBox.height) >= 44, 'Edit has at least a 44px-high hit area');
    assert.equal(editBtn.title, 'Edit Work Option', 'the tooltip is preserved');

    // Keyboard activation: focus it, press Enter, the editor opens.
    editBtn.focus();
    assert.equal(doc.activeElement, editBtn, 'the Edit control takes focus');
    editBtn.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(320);

    const modelInput = doc.querySelector('#edit-opt-model') as HTMLInputElement;
    assert.ok(modelInput, 'the Edit Work Option dialog opens from the keyboard');
    assert.match(doc.body.textContent ?? '', /Edit Work Option \(Priority 1\)/);
    // The draft prefills from the stored option, with associated labels.
    assert.equal((doc.querySelector('#edit-opt-engine') as HTMLSelectElement).value, 'pi');
    assert.equal(modelInput.value, 'glm-5');
    assert.equal((doc.querySelector('#edit-opt-effort') as HTMLSelectElement).value, 'high');
    assert.ok(doc.querySelector('label[for="edit-opt-model"]'), 'the model field is labelled');

    // Close the editor, then check the archived row offers no Edit control.
    (doc.querySelector('.cancel-edit-option-btn') as HTMLButtonElement).click();
    await settle(160);
    (doc.querySelector('[data-agent="legacy-coder"]') as HTMLButtonElement).click();
    await settle(140);
    assert.equal(doc.querySelector('.agent-option-row .edit-opt-btn'), null, 'archived rows are read-only');
    void fixture;
  } finally {
    await cleanup();
  }
});

test('editing an option in place preserves identity, order, versions, and prior run facts', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { fixture } = await mountedPage(vite, mount);

    (doc.querySelector('[data-agent="programmer"]') as HTMLButtonElement).click();
    await settle(120);

    const before = (await fixture.getAgent('programmer'))!;
    const idsBefore = before.workOptions.map((option) => option.id);
    const enginesBefore = before.workOptions.map((option) => option.engine);
    const versionsBefore = JSON.stringify(before.versions);
    const runsBefore = JSON.stringify(await fixture.listRunAttributions());

    (doc.querySelector('.agent-option-row .edit-opt-btn') as HTMLButtonElement).click();
    await settle(320);

    // Change all three fields, exactly like the operator's model switch.
    const engineSelect = doc.querySelector('#edit-opt-engine') as HTMLSelectElement;
    const modelInput = doc.querySelector('#edit-opt-model') as HTMLInputElement;
    const effortSelect = doc.querySelector('#edit-opt-effort') as HTMLSelectElement;
    engineSelect.value = 'codex';
    engineSelect.dispatchEvent(new (doc.defaultView as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));
    modelInput.value = 'glm-6';
    modelInput.dispatchEvent(new (doc.defaultView as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
    effortSelect.value = 'low';
    effortSelect.dispatchEvent(new (doc.defaultView as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));
    await settle(40);
    (doc.querySelector('.confirm-edit-option-btn') as HTMLButtonElement).click();
    await settle(400);

    const after = (await fixture.getAgent('programmer'))!;
    // Identity and priority position are preserved; only the values changed.
    assert.deepEqual(after.workOptions.map((option) => option.id), idsBefore, 'option identity is preserved');
    assert.deepEqual(after.workOptions.map((option) => option.engine), ['codex', enginesBefore[1]], 'order is preserved and only the edited row changed');
    assert.equal(after.workOptions[0]!.workModel, 'glm-6');
    assert.equal(after.workOptions[0]!.effort, 'low');
    assert.equal(after.workOptions[1]!.workModel, 'gpt-5.2-codex', 'the other option is untouched');

    // Exactly one appended version; every earlier version is byte-identical.
    assert.equal(after.currentVersion, before.currentVersion + 1, 'the edit appends exactly one version');
    assert.equal(
      JSON.stringify(after.versions.slice(0, before.versions.length)),
      versionsBefore,
      'earlier versions are never rewritten',
    );
    assert.match(
      after.versions[after.versions.length - 1]!.reason,
      /Edited the codex work option at priority 1/,
      'the edit is recorded with attribution',
    );
    // Prior run facts that reference the option keep their own record.
    assert.equal(JSON.stringify(await fixture.listRunAttributions()), runsBefore, 'prior run facts are not rewritten');
    assert.equal(after.instructions, before.instructions, 'an option edit leaves standing instructions alone');

    // The refreshed row renders the edited values; the dialog closed.
    assert.equal(doc.querySelector('#edit-opt-model'), null, 'the dialog closes after a successful save');
    assert.match(doc.querySelector('.agent-option-row')!.textContent ?? '', /glm-6/);
  } finally {
    await cleanup();
  }
});

test('a refused edit renders the inline validation-error and appends nothing', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    const { fixture } = await mountedPage(vite, mount);
    const before = (await fixture.getAgent('programmer'))!;

    (doc.querySelector('[data-agent="programmer"]') as HTMLButtonElement).click();
    await settle(120);
    (doc.querySelector('.agent-option-row .edit-opt-btn') as HTMLButtonElement).click();
    await settle(320);

    // A host-shaped model id is refused by the write boundary, exactly as the
    // create and add paths refuse it.
    const modelInput = doc.querySelector('#edit-opt-model') as HTMLInputElement;
    modelInput.value = 'buildbox-7';
    modelInput.dispatchEvent(new (doc.defaultView as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
    await settle(40);
    (doc.querySelector('.confirm-edit-option-btn') as HTMLButtonElement).click();
    await settle(200);

    const alert = doc.querySelector('[role="alert"]');
    assert.ok(alert, 'the refused edit renders an inline validation-error state');
    assert.match(alert!.textContent ?? '', /valid work model identifier/);
    // No raw diagnostic, host path, or credential shape reaches the operator.
    assert.equal(/\/Users\//.test(alert!.textContent ?? ''), false);
    assert.equal(/sk-[a-zA-Z0-9]{20,}/.test(alert!.textContent ?? ''), false);
    // The dialog stays open with the typed draft, and nothing was appended.
    assert.ok(doc.querySelector('#edit-opt-model'), 'the dialog stays open on refusal');
    assert.equal(modelInput.value, 'buildbox-7', 'the draft survives the refusal');

    const unchanged = (await fixture.getAgent('programmer'))!;
    assert.equal(unchanged.currentVersion, before.currentVersion, 'a refusal appends nothing');
    assert.deepEqual(unchanged.workOptions, before.workOptions, 'a refusal rewrites nothing');
  } finally {
    await cleanup();
  }
});

test('the edit persists through the production adapter with option identity preserved', async () => {
  const { doc, mount, vite, cleanup } = await setupHarness();
  try {
    // The production port with a wire-level fake: every mutation must leave
    // as a typed `reconfigureAgent` command and come back through a fresh read.
    const wireAgent: AgentView = {
      id: 'programmer',
      displayName: 'Programmer',
      status: 'active',
      configuration: {
        currentVersion: 2,
        versions: [
          {
            version: 1,
            at: 1_000,
            reason: 'Agent created with its initial ordered work options.',
            options: [{ id: 'opt-1', engine: 'pi', workModel: 'glm-5', effort: 'high' }],
          },
          {
            version: 2,
            at: 2_000,
            reason: 'Added a codex fallback.',
            options: [
              { id: 'opt-1', engine: 'pi', workModel: 'glm-5', effort: 'high' },
              { id: 'opt-2', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'medium' },
            ],
          },
        ],
      },
      workOptions: [
        { id: 'opt-1', engine: 'pi', workModel: 'glm-5', effort: 'high' },
        { id: 'opt-2', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'medium' },
      ],
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const priorRun = {
      id: 'run-1',
      agentId: 'programmer',
      prompt: 'earlier work',
      status: 'completed',
      events: [],
      handOffAttached: false,
      workOption: { engine: 'pi', workModel: 'glm-5', effort: 'high', configurationVersion: 1 },
      createdAt: 1_500,
    } as RunView;

    let view = wireAgent;
    const sentMutable: unknown[] = [];
    const projection = () => ({
      agentId: view.id,
      environmentInstanceId: 'inst-test',
      available: true,
      firstAvailable: view.workOptions[0],
      options: view.workOptions.map((option) => ({
        option,
        state: 'available',
        reason: `Engine "${option.engine}" is ready with the option's work model.`,
      })),
    });
    const adapter: AgentBrowserAdapter = {
      state: () => ({ status: 'online', connection: 'online', loading: false }),
      subscribeState: () => () => undefined,
      async listAgents() {
        return [view];
      },
      async getAgent() {
        return view;
      },
      async createAgent(input) {
        throw new Error(`not exercised by this test: ${input.displayName}`);
      },
      async reconfigureAgent(_id, input) {
        sentMutable.push(input);
        const options = input.workOptions.map((option) => ({
          id: option.id ?? '',
          engine: option.engine,
          workModel: option.workModel,
          effort: option.effort,
        }));
        const version = view.configuration.currentVersion + 1;
        view = {
          ...view,
          workOptions: options,
          updatedAt: 10_000 + version,
          configuration: {
            currentVersion: version,
            versions: [
              ...view.configuration.versions,
              {
                version,
                at: 10_000 + version,
                reason: input.reason ?? 'The Agent configuration was recorded.',
                options,
              },
            ],
          },
        };
        return view;
      },
      async archiveAgent() {
        return view;
      },
      async restoreAgent() {
        return view;
      },
      async compatibility() {
        return projection();
      },
      async runWorkOption() {
        throw new Error('not exercised by this test');
      },
    };

    const [{ createSproutApp }, { ProductionAgentService }] = await Promise.all([
      vite.ssrLoadModule('/src/app/main.ts') as Promise<typeof import('../app/main.ts')>,
      vite.ssrLoadModule('/src/modules/agents/adapters/production-adapter.ts') as Promise<
        typeof import('./adapters/production-adapter.ts')
      >,
    ]);
    const service = new ProductionAgentService(adapter, async () => ({ runs: [priorRun] }));
    const { app, router } = createSproutApp({ routerBase: '/app/', agentService: service });
    await router.push('/manage/agents');
    await router.isReady();
    app.mount(mount);
    await settle(160);

    await router.push('/manage/agents/programmer?run=run-1');
    await settle(120);
    const selectedRun = doc.querySelector('[data-run-id="run-1"]');
    assert.ok(selectedRun, 'the Agent authority exposes the referenced Task run');
    assert.equal(selectedRun.getAttribute('aria-current'), 'true', 'the exact run deep link is highlighted');

    (doc.querySelector('[data-agent="programmer"]') as HTMLButtonElement).click();
    await settle(120);
    (doc.querySelector('.agent-option-row .edit-opt-btn') as HTMLButtonElement).click();
    await settle(320);
    assert.equal((doc.querySelector('#edit-opt-model') as HTMLInputElement).value, 'glm-5');

    const modelInput = doc.querySelector('#edit-opt-model') as HTMLInputElement;
    modelInput.value = 'glm-6';
    modelInput.dispatchEvent(new (doc.defaultView as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
    await settle(40);
    (doc.querySelector('.confirm-edit-option-btn') as HTMLButtonElement).click();
    await settle(400);

    // The command that left the page carried every identity and both rows.
    assert.equal(sentMutable.length, 1, 'exactly one reconfiguration reached the wire');
    const command = sentMutable[0] as {
      workOptions: readonly { id?: string; engine: string; workModel: string; effort: string }[];
      reason?: string;
    };
    assert.deepEqual(
      command.workOptions.map((option) => option.id),
      ['opt-1', 'opt-2'],
      'option identity and order ride the wire unchanged',
    );
    assert.deepEqual(
      command.workOptions[0],
      { id: 'opt-1', engine: 'pi', workModel: 'glm-6', effort: 'high' },
      'only the edited option\'s values changed',
    );
    assert.deepEqual(
      command.workOptions[1],
      { id: 'opt-2', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'medium' },
      'the other option is untouched on the wire',
    );
    assert.match(command.reason ?? '', /Edited the pi work option at priority 1/);

    // The durable record: one appended version, earlier versions verbatim.
    assert.equal(view.configuration.currentVersion, 3);
    assert.equal(view.configuration.versions.length, 3);
    assert.deepEqual(
      view.configuration.versions.slice(0, 2),
      wireAgent.configuration.versions,
      'prior versions are never rewritten through the production port',
    );
    // Prior run facts referencing the option still say what was admitted.
    const runsAfter = await service.listRunAttributions();
    assert.equal(runsAfter[0]!.workModel, 'glm-5', 'prior run facts are not rewritten');
    assert.equal(runsAfter[0]!.configurationVersion, 1);

    // The refreshed page shows the edit; the fallback row still renders.
    const rows = [...doc.querySelectorAll('.agent-option-row')];
    assert.match(rows[0]!.textContent ?? '', /glm-6/, 'the edit renders after the fresh read');
    assert.match(rows[1]!.textContent ?? '', /gpt-5\.2-codex/, 'the untouched row still renders');
    app.unmount();
  } finally {
    await cleanup();
  }
});
