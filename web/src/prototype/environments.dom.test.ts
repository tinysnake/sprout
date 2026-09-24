import assert from 'node:assert/strict';

import { test } from 'node:test';


import { setupPrototypeDom } from './dom-harness.ts';




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
    stateManager.selectEnvironment('env-ready');

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


test('Environments: health filters and selected master cards expose accessible current state and context', async () => {
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
    stateManager.setViewportMode('desktop');
    stateManager.setPrimaryNav('manage', undefined, 'environments');

    const document = dom.window.document;
    const allFilter = document.querySelector('.env-filter-box-btn[data-filter="all"]') as HTMLButtonElement;
    const readyFilter = document.querySelector('.env-filter-box-btn[data-filter="ready"]') as HTMLButtonElement;
    assert.equal(allFilter.getAttribute('aria-pressed'), 'true');
    assert.equal(readyFilter.getAttribute('aria-pressed'), 'false');

    readyFilter.click();

    assert.equal(document.querySelector('.env-filter-box-btn[data-filter="ready"]')?.getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('.env-filter-box-btn[data-filter="all"]')?.getAttribute('aria-pressed'), 'false');

    stateManager.setEnvironmentFilter('all');
    stateManager.selectEnvironment('env-recovery');
    const card = document.querySelector('.env-master-card[data-env="env-recovery"]') as HTMLButtonElement;
    assert.ok(card);
    assert.equal(card.getAttribute('aria-current'), 'page');

    const describedBy = (card.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const accessibleContext = `${card.getAttribute('aria-label') ?? ''} ${describedBy}`;
    assert.match(accessibleContext, /action required/i);
    assert.match(accessibleContext, /red/i);
    assert.match(accessibleContext, /worker offline for 14 minutes/i);
    assert.match(accessibleContext, /connection offline/i);
    assert.match(accessibleContext, /protocol v2\.1 compatible/i);
    assert.match(accessibleContext, /lease recovery/i);
    assert.match(accessibleContext, /holder task #104/i);
    assert.equal(card.querySelector('.quick-probe-btn'), null, 'Probe remains a separate sibling action');
    assert.ok(
      card.parentElement?.querySelector('.quick-probe-btn'),
      'Separate Probe action remains available'
    );
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

    // Select the pending environment fixture
    stateManager.setPrimaryNav('manage', undefined, 'environments');
    stateManager.selectEnvironment('env-pending');

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
    const approvedEnv = updatedSnap.environments.find((e) => e.id === 'env-pending')!;
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
    stateManager.selectEnvironment('env-ready');

    const document = dom.window.document;

    const probeBtn = document.querySelector('.run-probe-btn') as HTMLButtonElement;
    assert.ok(probeBtn, 'Readiness probe button rendered');
    probeBtn.click();

    const env = stateManager.getSnapshot().environments.find((e) => e.id === 'env-ready')!;
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
    stateManager.selectEnvironment('env-ready');

    const document = dom.window.document;

    // 1. Simulate Worker Disconnect
    const disconnectBtn = document.querySelector('.sim-disconnect-btn') as HTMLButtonElement;
    assert.ok(disconnectBtn, 'Disconnect button rendered');
    disconnectBtn.click();

    let env = stateManager.getSnapshot().environments.find((e) => e.id === 'env-ready')!;
    assert.equal(env.connectionState, 'offline');
    assert.equal(env.trafficLight, 'red');
    assert.equal(env.workSafety, 'recovery');
    assert.ok(env.leaseRecovery, 'Lease entered recovery');

    // 2. Simulate Worker Reconnect
    const reconnectBtn = document.querySelector('.sim-reconnect-btn') as HTMLButtonElement;
    assert.ok(reconnectBtn, 'Reconnect button rendered');
    reconnectBtn.click();

    env = stateManager.getSnapshot().environments.find((e) => e.id === 'env-ready')!;
    assert.equal(env.connectionState, 'online');
    assert.equal(env.workSafety, 'reconciling');

    // 3. Reconcile & Synchronize Evidence
    const reconcileBtn = document.querySelector('.btn-reconcile-evidence') as HTMLButtonElement;
    assert.ok(reconcileBtn, 'Reconcile evidence button rendered');
    reconcileBtn.click();

    env = stateManager.getSnapshot().environments.find((e) => e.id === 'env-ready')!;
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

    // Select Recovery Environment (in recovery for Task #104)
    stateManager.setPrimaryNav('manage', undefined, 'environments');
    stateManager.selectEnvironment('env-recovery');

    const document = dom.window.document;

    // Verify Recovery Alert Box
    assert.match(document.body.textContent ?? '', /Lease Recovery Required \(ADR-0006 & ADR-0009\)/);
    assert.match(document.body.textContent ?? '', /Host worker offline: engine process stop cannot be confirmed/);
    assert.match(document.body.textContent ?? '', /Temporary task scratch context directory unrecycled/);

    // Test Discard Task & Safe Release
    const discardBtn = document.querySelector('.btn-discard-recovery') as HTMLButtonElement;
    assert.ok(discardBtn, 'Discard recovery button rendered');
    discardBtn.click();

    const env = stateManager.getSnapshot().environments.find((e) => e.id === 'env-recovery')!;
    const task = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-104')!;

    assert.equal(task.lifecycle, 'cancelled');
    assert.equal(task.leaseLifecycle, 'released');
    assert.equal(task.activeRunId, undefined, 'Safe recovery discard clears the active-run pointer');
    assert.equal(env.workSafety, 'clear');
    assert.equal(env.activeLeaseHolder, undefined);
    assert.equal(env.leaseRecovery, undefined, 'Safe recovery discard clears recovery evidence with the lease');
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

    // Select Recovery Environment in recovery
    stateManager.setPrimaryNav('manage', undefined, 'environments');
    stateManager.selectEnvironment('env-recovery');

    const document = dom.window.document;

    // Force Release is not a generic cancellation escape hatch. A clean,
    // active-running Task with no matching Environment recovery must remain
    // untouched.
    const cleanTask = stateManager.getSnapshot().tasks.find((candidate) => candidate.id === 'task-102')!;
    const rejected = stateManager.emergencyForceRelease(
      'env-ready',
      cleanTask.id,
      'Mismatched recovery probe',
      true
    );
    assert.equal(rejected.success, false);
    assert.equal(cleanTask.lifecycle, 'active');
    assert.equal(cleanTask.agentRunLifecycle, 'running');
    assert.equal(cleanTask.runs.find((run) => run.id === 'run-205')?.lifecycle, 'running');

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

    // Probe the emergency boundary's stop-before-release ordering with the
    // recovery fixture's run made active again.
    const recoveryTask = stateManager.getSnapshot().tasks.find((candidate) => candidate.id === 'task-104')!;
    const recoveryRun = recoveryTask.runs.find((run) => run.id === 'run-206')!;
    recoveryTask.agentRunLifecycle = 'running';
    recoveryTask.activeRunId = recoveryRun.id;
    recoveryRun.lifecycle = 'running';

    // Authorize Force Release
    confirmBtn.click();

    // Verify Environment is force-released, task permanently cancelled with forced release disposition
    const env = stateManager.getSnapshot().environments.find((e) => e.id === 'env-recovery')!;
    const task = stateManager.getSnapshot().tasks.find((t) => t.id === 'task-104')!;

    assert.equal(task.lifecycle, 'cancelled');
    assert.equal(task.leaseLifecycle, 'released');
    assert.equal(task.activeRunId, undefined);
    assert.equal(task.runs.find((run) => run.id === 'run-206')?.lifecycle, 'stopped', 'Force Release settles an active run first');
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
    stateManager.selectEnvironment('env-ready');

    const document = dom.window.document;

    // Toggle GUI automation permission
    const guiBtn = document.querySelector('.perm-toggle-btn[data-cap="guiAutomation"]') as HTMLButtonElement;
    assert.ok(guiBtn);
    guiBtn.click();

    let env = stateManager.getSnapshot().environments.find((e) => e.id === 'env-ready')!;
    assert.equal(env.capabilityPermissions.guiAutomation, true);

    // Unenroll attempt while active lease is held should be refused
    stateManager.unenrollEnvironment('env-ready');
    env = stateManager.getSnapshot().environments.find((e) => e.id === 'env-ready')!;
    assert.equal(env.enrollmentStatus, 'approved', 'Cannot unenroll while active lease held');
  } finally {
    await cleanup();
  }
});
