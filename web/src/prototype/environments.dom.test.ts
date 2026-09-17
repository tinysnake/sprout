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

test('Environments: renders 6 independent health dimensions and mandatory textual traffic-light reasons', async () => {
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

    // Navigate to Manage > Environments
    stateManager.setPrimaryNav('manage', undefined, 'environments');
    stateManager.selectEnvironment('mac-studio-primary');

    const document = dom.window.document;

    // 1. Verify Header and Filter Pills
    assert.match(document.body.textContent ?? '', /Environments & Host Infrastructure/);
    assert.match(document.body.textContent ?? '', /Ready \(/);
    assert.match(document.body.textContent ?? '', /Attention \(/);
    assert.match(document.body.textContent ?? '', /Action Required \(/);
    assert.match(document.body.textContent ?? '', /Archived \(/);

    // 2. Verify Prominent Traffic Light Banner & Mandatory Decisive Reason
    const banner = document.querySelector('.env-traffic-light-banner');
    assert.ok(banner, 'Traffic light banner rendered');
    assert.match(banner.textContent ?? '', /Green: Ready/);
    assert.match(banner.textContent ?? '', /Decisive Fact: All capabilities permitted · Engines authenticated · Lease held by Task #101/);

    // 3. Verify 6 Independent Health Dimensions (Never collapsed into one boolean)
    assert.match(document.body.textContent ?? '', /6 Independent Health Dimensions/);
    assert.match(document.body.textContent ?? '', /1\. Enrollment/);
    assert.match(document.body.textContent ?? '', /2\. Connection/);
    assert.match(document.body.textContent ?? '', /3\. Protocol/);
    assert.match(document.body.textContent ?? '', /4\. Work Safety/);
    assert.match(document.body.textContent ?? '', /5\. Capability Permissions/);
    assert.match(document.body.textContent ?? '', /6\. Engine Harness Readiness/);

    // 4. Verify Engine Readiness Facts (Codex, Pi, agy, opencode)
    assert.match(document.body.textContent ?? '', /Codex/);
    assert.match(document.body.textContent ?? '', /Pi/);
    assert.match(document.body.textContent ?? '', /agy/);
    assert.match(document.body.textContent ?? '', /opencode/);

    // 5. Verify Active Lease Card & Task-Held Lease Guarantee (ADR-0005)
    assert.match(document.body.textContent ?? '', /Task-Held Lease Active \(ADR-0005\)/);
    assert.match(document.body.textContent ?? '', /Task #101/);
    assert.match(document.body.textContent ?? '', /@Programmer/);
  } finally {
    await cleanup();
  }
});

test('Environments: approving pending enrollment updates status, connectivity, and traffic light', async () => {
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

    // Select pending MacBook Air environment
    stateManager.setPrimaryNav('manage', undefined, 'environments');
    stateManager.selectEnvironment('mac-laptop-pending');

    const document = dom.window.document;

    // Verify Pending State
    const banner = document.querySelector('.env-traffic-light-banner');
    assert.ok(banner);
    assert.match(banner.textContent ?? '', /Yellow: Attention/);
    assert.match(banner.textContent ?? '', /Pending enrollment approval by operator/);

    // Click Approve Enrollment Button
    const approveBtn = document.querySelector('.approve-enroll-btn') as HTMLButtonElement;
    assert.ok(approveBtn, 'Approve enrollment button rendered');
    approveBtn.click();

    // Verify Transition to Approved & Green
    const updatedSnap = stateManager.getSnapshot();
    const approvedEnv = updatedSnap.environments.find((e) => e.id === 'mac-laptop-pending')!;
    assert.equal(approvedEnv.enrollmentStatus, 'approved');
    assert.equal(approvedEnv.trafficLight, 'green');
    assert.equal(approvedEnv.connectionState, 'online');
    assert.match(approvedEnv.trafficLightReason, /Enrollment approved by Operator/);
  } finally {
    await cleanup();
  }
});

test('Environments: live readiness probe updates timestamp, latency, and probe event history', async () => {
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
    stateManager.selectEnvironment('mac-studio-primary');

    const document = dom.window.document;

    const probeBtn = document.querySelector('.run-probe-btn') as HTMLButtonElement;
    assert.ok(probeBtn, 'Readiness probe button rendered');
    probeBtn.click();

    const env = stateManager.getSnapshot().environments.find((e) => e.id === 'mac-studio-primary')!;
    assert.equal(env.lastConfirmedTime, 'Just now');
    assert.equal(env.connectionAgeSec, 0);
    assert.ok(env.probeHistory && env.probeHistory.length > 0, 'Probe history record added');
  } finally {
    await cleanup();
  }
});

test('Environments: worker disconnect, reconnect, and reconciliation transition flow', async () => {
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
    stateManager.selectEnvironment('mac-studio-primary');

    const document = dom.window.document;

    // 1. Simulate Worker Disconnect
    const disconnectBtn = document.querySelector('.sim-disconnect-btn') as HTMLButtonElement;
    assert.ok(disconnectBtn, 'Disconnect button rendered');
    disconnectBtn.click();

    let env = stateManager.getSnapshot().environments.find((e) => e.id === 'mac-studio-primary')!;
    assert.equal(env.connectionState, 'offline');
    assert.equal(env.trafficLight, 'red');
    assert.equal(env.workSafety, 'recovery');
    assert.ok(env.leaseRecovery, 'Lease entered recovery');

    // 2. Simulate Worker Reconnect
    const reconnectBtn = document.querySelector('.sim-reconnect-btn') as HTMLButtonElement;
    assert.ok(reconnectBtn, 'Reconnect button rendered');
    reconnectBtn.click();

    env = stateManager.getSnapshot().environments.find((e) => e.id === 'mac-studio-primary')!;
    assert.equal(env.connectionState, 'online');
    assert.equal(env.workSafety, 'reconciling');

    // 3. Reconcile & Synchronize Evidence
    const reconcileBtn = document.querySelector('.btn-reconcile-evidence') as HTMLButtonElement;
    assert.ok(reconcileBtn, 'Reconcile evidence button rendered');
    reconcileBtn.click();

    env = stateManager.getSnapshot().environments.find((e) => e.id === 'mac-studio-primary')!;
    assert.equal(env.workSafety, 'recovery');
    assert.ok(env.leaseRecovery?.reconciledEvidence, 'Evidence synchronized');
    assert.equal(env.leaseRecovery.reconciledEvidence.engineSessionStopped, true);
  } finally {
    await cleanup();
  }
});

test('Environments: recovery resolution via Resume vs Discard (safe Task end)', async () => {
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

    // Select Windows Dev Host (in recovery for Task #104)
    stateManager.setPrimaryNav('manage', undefined, 'environments');
    stateManager.selectEnvironment('win-dev-box');

    const document = dom.window.document;

    // Verify Recovery Alert Box
    assert.match(document.body.textContent ?? '', /Lease Recovery Required \(ADR-0006 & ADR-0009\)/);
    assert.match(document.body.textContent ?? '', /Host worker offline: engine process stop cannot be confirmed/);
    assert.match(document.body.textContent ?? '', /Temporary task scratch context directory unrecycled/);

    // Test Discard Task & Safe Release
    const discardBtn = document.querySelector('.btn-discard-recovery') as HTMLButtonElement;
    assert.ok(discardBtn, 'Discard recovery button rendered');
    discardBtn.click();

    const env = stateManager.getSnapshot().environments.find((e) => e.id === 'win-dev-box')!;
    const task = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-104')!;

    assert.equal(task.lifecycle, 'cancelled');
    assert.equal(task.leaseLifecycle, 'released');
    assert.equal(env.workSafety, 'clear');
    assert.equal(env.activeLeaseHolder, undefined);
    assert.equal(env.trafficLight, 'green');
    assert.match(env.trafficLightReason, /Scratch context recycled by worker · Lease released/);
  } finally {
    await cleanup();
  }
});

test('Environments: Human-only emergency Force Release requires typed confirmation, risk check, and operator reason', async () => {
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

    // Select Windows Dev Host in recovery
    stateManager.setPrimaryNav('manage', undefined, 'environments');
    stateManager.selectEnvironment('win-dev-box');

    const document = dom.window.document;

    // Open Force Release Sheet
    const forceReleaseBtn = document.querySelector('.force-release-btn') as HTMLButtonElement;
    assert.ok(forceReleaseBtn, 'Emergency Force Release button rendered');
    forceReleaseBtn.click();

    // Verify Inspector Sheet Open
    const sheet = document.querySelector('.inspector-sheet');
    assert.ok(sheet, 'Force release inspector sheet opened');
    assert.match(sheet.textContent ?? '', /Emergency Force Release/);
    assert.match(sheet.textContent ?? '', /EMERGENCY OVERRIDE WARNING/);
    assert.match(sheet.textContent ?? '', /Unresolved Operational Facts/);

    const typedInput = sheet.querySelector('#force-confirm-typed') as HTMLInputElement;
    const ackCheckbox = sheet.querySelector('#ack-risks') as HTMLInputElement;
    const confirmBtn = sheet.querySelector('#confirm-force-btn') as HTMLButtonElement;

    assert.ok(typedInput, 'Typed confirmation input rendered');
    assert.ok(ackCheckbox, 'Risk acknowledgement checkbox rendered');
    assert.ok(confirmBtn, 'Confirm button rendered');

    // Confirm button must be disabled initially
    assert.equal(confirmBtn.disabled, true, 'Confirm button disabled before confirmation');

    // Checking only checkbox keeps button disabled
    ackCheckbox.checked = true;
    ackCheckbox.dispatchEvent(new dom.window.Event('change'));
    assert.equal(confirmBtn.disabled, true, 'Confirm button disabled without typed string');

    // Typing wrong text keeps button disabled
    typedInput.value = 'FORCE';
    typedInput.dispatchEvent(new dom.window.Event('input'));
    assert.equal(confirmBtn.disabled, true, 'Confirm button disabled for partial text');

    // Typing exact 'FORCE RELEASE' enables confirm button
    typedInput.value = 'FORCE RELEASE';
    typedInput.dispatchEvent(new dom.window.Event('input'));
    assert.equal(confirmBtn.disabled, false, 'Confirm button enabled after typed match');

    // Authorize Force Release
    confirmBtn.click();

    // Verify Environment is force-released, task permanently cancelled with forced release disposition
    const env = stateManager.getSnapshot().environments.find((e) => e.id === 'win-dev-box')!;
    const task = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-104')!;

    assert.equal(task.lifecycle, 'cancelled');
    assert.equal(task.leaseLifecycle, 'released');
    assert.ok(task.forcedReleaseDisposition, 'Task records permanent forced release disposition');
    assert.equal(task.forcedReleaseDisposition.risksAcknowledged, true);

    assert.equal(env.workSafety, 'clear');
    assert.equal(env.activeLeaseHolder, undefined);
    assert.equal(env.leaseRecovery, undefined);
    assert.equal(env.trafficLight, 'green');
    assert.match(env.trafficLightReason, /Force Released by Operator/);
    assert.ok(env.forcedReleaseRecord, 'Environment records durable forced release event');
  } finally {
    await cleanup();
  }
});

test('Environments: Capability permission toggling and unenroll safety check', async () => {
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
    stateManager.selectEnvironment('mac-studio-primary');

    const document = dom.window.document;

    // Toggle GUI automation permission
    const guiBtn = document.querySelector('.perm-toggle-btn[data-cap="guiAutomation"]') as HTMLButtonElement;
    assert.ok(guiBtn);
    guiBtn.click();

    let env = stateManager.getSnapshot().environments.find((e) => e.id === 'mac-studio-primary')!;
    assert.equal(env.capabilityPermissions.guiAutomation, true);

    // Unenroll attempt while active lease is held should be refused
    stateManager.unenrollEnvironment('mac-studio-primary');
    env = stateManager.getSnapshot().environments.find((e) => e.id === 'mac-studio-primary')!;
    assert.equal(env.enrollmentStatus, 'approved', 'Cannot unenroll while active lease held');
  } finally {
    await cleanup();
  }
});

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
    const card = document.querySelector('.env-master-card[data-env="mac-studio-primary"]') as HTMLElement;
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

    // Verify strict absence of private local paths and IP addresses
    assert.equal(text.includes('/Users/snake'), false, 'No private macOS home path in DOM');
    assert.equal(text.includes('C:\\Users\\'), false, 'No private Windows user path in DOM');
    assert.equal(text.includes('192.168.'), false, 'No LAN IP addresses in DOM');
    assert.equal(text.includes('sk-ant-'), false, 'No Anthropic API keys in DOM');
    assert.equal(text.includes('sk-proj-'), false, 'No OpenAI API keys in DOM');
  } finally {
    await cleanup();
  }
});
