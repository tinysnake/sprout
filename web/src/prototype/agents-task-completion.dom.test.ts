import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



test('Task lifecycle authority: proposed, running, validation, blocked, and safe end paths fail closed', async () => {
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

    // A proposal has no lease and cannot be turned into a paused/cancelled
    // begun Task by a direct lifecycle call.
    stateManager.setPrimaryNav('project', 'tasks');
    stateManager.selectTask('task-105-prop');
    const proposed = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-105-prop')!;
    assert.equal(proposed.lifecycle, 'proposed');
    assert.equal(proposed.leaseLifecycle, 'none');
    assert.equal(dom.window.document.querySelector('.pause-task-btn'), null, 'Proposed DOM has no pause control');
    assert.equal(stateManager.pauseTask(proposed.id).success, false);
    assert.equal(stateManager.discardTask(proposed.id).success, false);
    assert.equal(proposed.lifecycle, 'proposed');
    assert.equal(proposed.leaseLifecycle, 'none');

    // Discarding an active-running Task first settles/stops the run, then
    // performs the safe Task end without releasing another Task's projection.
    const running = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-102')!;
    const runningEnv = stateManager.getSnapshot().environments.find((env) => env.id === running.selectedEnvironmentId)!;
    stateManager.selectTask(running.id);
    assert.ok(dom.window.document.querySelector('.pause-task-btn'), 'Active-running DOM exposes the pause boundary');
    assert.equal(stateManager.pauseTask(running.id).success, true);
    assert.equal(running.lifecycle, 'Task pause requested');
    const activeRun = running.runs.find((run) => run.id === 'run-205')!;
    assert.equal(stateManager.discardTask(running.id).success, true);
    assert.equal(activeRun.lifecycle, 'stopped', 'Safe discard settles the active run before cancellation');
    assert.equal(running.activeRunId, undefined);
    assert.equal(running.lifecycle, 'cancelled');
    assert.equal(running.leaseLifecycle, 'released');
    assert.equal(runningEnv.activeLeaseHolder?.holderId, 'task-101', 'Discard does not release another Task\'s held Environment projection');
    assert.equal(runningEnv.leaseRecovery, undefined);
    assert.equal(runningEnv.workSafety, 'clear');

    // A valid completion validation clears the historical activeRunId pointer
    // before releasing the Task lease.
    const awaiting = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-101')!;
    const awaitingEnv = stateManager.getSnapshot().environments.find((env) => env.id === awaiting.selectedEnvironmentId)!;
    awaitingEnv.activeLeaseHolder = {
      holderKind: 'task',
      holderId: awaiting.id,
      projectId: awaiting.projectId,
      acquiredAt: 'Just now',
    };
    stateManager.selectTask(awaiting.id);
    const acceptButton = dom.window.document.querySelector('.accept-claim-btn') as HTMLButtonElement;
    assert.ok(acceptButton, 'Awaiting-validation DOM exposes Human validation');
    acceptButton.click();
    assert.equal(awaiting.lifecycle, 'completed');
    assert.equal(awaiting.leaseLifecycle, 'released');
    assert.equal(awaiting.activeRunId, undefined, 'Terminal Task has no historical active pointer');
    assert.equal(awaitingEnv.activeLeaseHolder, undefined);
    assert.equal(awaitingEnv.leaseRecovery, undefined);

    // Ending the current lead membership blocks the Task. A stale claim cannot
    // bypass replacement-lead authority or release its existing lease.
    const blocked = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-103')!;
    const blockedEnv = stateManager.getSnapshot().environments.find((env) => env.id === blocked.selectedEnvironmentId)!;
    blocked.pendingCompletionClaim = {
      id: 'claim-stale-blocked',
      submittedAt: 'Just now',
      submittedByLeadId: blocked.taskLeadId,
      contentVersion: blocked.currentVersion.version,
      outcomeSummary: 'Stale claim used only to probe state authority.',
      validationEvidence: 'No validation is admitted for this probe.',
      durableChanges: [],
      knownLimitations: 'None',
      recommendedDisposition: 'completed',
    };
    blockedEnv.activeLeaseHolder = {
      holderKind: 'task',
      holderId: blocked.id,
      projectId: blocked.projectId,
      acquiredAt: 'Just now',
    };
    assert.equal(stateManager.endProjectMembership('proj-minesweeper', 'programmer').success, true);
    assert.equal(blocked.lifecycle, 'blocked');
    stateManager.selectTask(blocked.id);
    assert.equal(dom.window.document.querySelector('.accept-claim-btn'), null, 'Blocked DOM has no validation accept control');
    assert.equal(stateManager.validateTaskCompletion(blocked.id, 'accept').success, false);
    assert.equal(blocked.lifecycle, 'blocked');
    assert.equal(blocked.leaseLifecycle, 'held');
    assert.ok(blocked.activeBlocker, 'Blocked Task retains a replacement-lead blocker');
    assert.equal(blockedEnv.activeLeaseHolder?.holderId, blocked.id, 'Blocked Task lease remains held');
  } finally {
    await cleanup();
  }
});

test('Task completion claims retain recorded content and submitter facts across allowed edits', async () => {
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

    stateManager.setPrimaryNav('project', 'tasks');
    const task = stateManager.getSnapshot().tasks.find((candidate) => candidate.id === 'task-101')!;
    const env = stateManager.getSnapshot().environments.find((candidate) => candidate.id === task.selectedEnvironmentId)!;
    env.activeLeaseHolder = {
      holderKind: 'task',
      holderId: task.id,
      projectId: task.projectId,
      acquiredAt: 'Just now',
    };
    const claim = task.pendingCompletionClaim!;
    assert.equal(claim.contentVersion, 1);
    assert.equal(claim.submittedByLeadId, 'programmer');

    // Both edits are Human-authorized while validation is pending. The second
    // edit replaces the current lead, but must not rewrite what the claim judged.
    assert.equal(
      stateManager.updateTaskContentVersion(
        task.id,
        'Revised board grid',
        'Keep the original board behaviour while clarifying mobile input.',
        task.currentVersion.constraints,
        task.currentVersion.validationCriteria,
        'programmer'
      ).success,
      true
    );
    assert.equal(
      stateManager.updateTaskContentVersion(
        task.id,
        'Reassigned board grid',
        'The replacement lead owns the next deliberate advance.',
        task.currentVersion.constraints,
        task.currentVersion.validationCriteria,
        'designer'
      ).success,
      true
    );
    assert.equal(task.currentVersion.version, 3);
    assert.equal(task.taskLeadId, 'designer');
    assert.equal(task.pendingCompletionClaim, claim, 'The recorded claim remains pending after content/lead edits');

    // A forged version or submitter fact still fails closed; a historical
    // version is accepted only when the claim submitter matches that version's
    // recorded lead. Current lead eligibility is checked independently.
    claim.contentVersion = 99;
    assert.equal(stateManager.validateTaskCompletion(task.id, 'accept').success, false);
    assert.equal(task.lifecycle, 'awaiting validation');
    claim.contentVersion = 1;
    claim.submittedByLeadId = 'designer';
    assert.equal(stateManager.validateTaskCompletion(task.id, 'accept').success, false);
    assert.equal(task.lifecycle, 'awaiting validation');
    claim.submittedByLeadId = 'programmer';

    stateManager.selectTask(task.id);
    assert.match(dom.window.document.body.textContent ?? '', /Evaluated against Task Content Version v1/);
    const acceptButton = dom.window.document.querySelector('.accept-claim-btn') as HTMLButtonElement;
    assert.ok(acceptButton, 'DOM retains validation for a claim against a historical version');
    acceptButton.click();

    assert.equal(task.lifecycle, 'completed');
    assert.equal(task.leaseLifecycle, 'released');
    assert.equal(env.activeLeaseHolder, undefined, 'Exact Task lease ownership is released only after valid validation');
  } finally {
    await cleanup();
  }
});

test('Paused completion claims support accept and correction without resuming admission', async () => {
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

    stateManager.setPrimaryNav('project', 'tasks');
    const task = stateManager.getSnapshot().tasks.find((candidate) => candidate.id === 'task-101')!;
    const env = stateManager.getSnapshot().environments.find((candidate) => candidate.id === task.selectedEnvironmentId)!;
    env.activeLeaseHolder = {
      holderKind: 'task',
      holderId: task.id,
      projectId: task.projectId,
      acquiredAt: 'Just now',
    };
    assert.equal(stateManager.pauseTask(task.id).success, true, 'Human may pause a settled pending claim without releasing its lease');
    stateManager.selectTask(task.id);
    assert.ok(dom.window.document.querySelector('.accept-claim-btn'), 'Paused DOM keeps the Human accept control');
    assert.match(dom.window.document.body.textContent ?? '', /Lease Held · Paused/);

    const claimRunsBeforeAccept = task.runs.length;
    (dom.window.document.querySelector('.accept-claim-btn') as HTMLButtonElement).click();
    assert.equal(task.lifecycle, 'completed', 'Paused accept may safely end without a prior Resume');
    assert.equal(task.leaseLifecycle, 'released');
    assert.equal(task.runs.length, claimRunsBeforeAccept, 'Accept does not start another run');
    assert.equal(env.activeLeaseHolder, undefined);
  } finally {
    await cleanup();
  }
});
