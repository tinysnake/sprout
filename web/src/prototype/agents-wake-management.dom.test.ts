import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



test('Dynamic wake settlement records the complete WakeRequest to run to projected-reply chain', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');
    const { renderRoutingInspectorModal } = (await vite.ssrLoadModule(
      '/src/prototype/views/chat-view.ts'
    )) as typeof import('./views/chat-view.js');
    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    const projectId = 'proj-docs-portal';
    stateManager.restoreProject(projectId);
    stateManager.setProjectWakePolicy(projectId, 'wake-model-assisted');
    const beforeMessages = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(projectId, { kind: 'project-channel' }, 'Please review this unaddressed design note.').success,
      true
    );

    const batch = stateManager.getSnapshot().routingBatches[0]!;
    const wakeRequest = batch.resultingWakeRequests?.[0]!;
    assert.equal(wakeRequest.admissionStatus, 'admitted');
    assert.equal(wakeRequest.terminalStatus, undefined);
    await new Promise((resolve) => setTimeout(resolve, 1300));

    const reply = stateManager.getSnapshot().messages.at(-1)!;
    assert.equal(batch.status, 'settled');
    assert.equal(wakeRequest.terminalStatus, 'settled');
    assert.equal(wakeRequest.terminalResponsibility?.kind, 'agent');
    assert.equal(wakeRequest.terminalResponsibility?.id, wakeRequest.targetAgentId);
    assert.equal(wakeRequest.terminalReason, 'Agent run settled and its projected reply was persisted.');
    assert.ok(wakeRequest.terminalTimestamp);
    assert.ok(wakeRequest.linkedRunId);
    assert.equal(wakeRequest.projectedReplyId, reply.id);
    assert.equal(reply.projectedReplyMeta?.wakeRequestId, wakeRequest.wakeRequestId);
    assert.equal(reply.projectedReplyMeta?.runId, wakeRequest.linkedRunId);
    assert.equal(reply.routingCausalChainId, batch.id);
    assert.equal(stateManager.getSnapshot().messages.length, beforeMessages + 2);
    renderRoutingInspectorModal(appMount, stateManager.getSnapshot(), batch.id);
    const inspectorEvidence = dom.window.document.querySelector('.proto-modal-dialog')?.textContent ?? '';
    assert.match(inspectorEvidence, /settled/);
    assert.match(inspectorEvidence, new RegExp(wakeRequest.linkedRunId!));
    assert.match(inspectorEvidence, new RegExp(wakeRequest.projectedReplyId!));
    assert.doesNotMatch(inspectorEvidence, /WakeRequest:.*admitted/);
  } finally {
    await cleanup();
  }
});

test('Archived Project management mutations fail closed in state and DOM, then work after restore', async () => {
  const { dom, vite, cleanup } = await setupPrototypeDom();
  try {
    const { initPrototype } = (await vite.ssrLoadModule(
      '/src/prototype/prototype.ts'
    )) as typeof import('./prototype.js');
    const { renderWorkingGroupDetailsModal } = (await vite.ssrLoadModule(
      '/src/prototype/views/chat-view.ts'
    )) as typeof import('./views/chat-view.js');
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');
    const appMount = dom.window.document.getElementById('app');
    assert.ok(appMount);
    initPrototype(appMount);

    const projectId = 'proj-docs-portal';
    const project = stateManager.getSnapshot().projects.find((candidate) => candidate.id === projectId)!;
    stateManager.restoreProject(projectId);
    const createdGroup = stateManager.createWorkingGroup(projectId, 'Archive guard WG', ['designer']);
    assert.equal(createdGroup.success, true);
    const workingGroup = project.workingGroups.at(-1)!;
    stateManager.archiveProject(projectId);
    assert.equal(project.status, 'archived');

    const membership = project.memberships.find((candidate) => candidate.memberId === 'designer')!;
    const originalResponsibilities = membership.responsibilities;
    const originalInstructions = membership.collaborationInstructions;
    const originalGoal = project.goal;
    const originalRules = [...project.rules];
    const originalPolicy = project.wakePolicy;

    const editResult = stateManager.editProjectMembership(projectId, 'designer', 'forged responsibility', 'forged instructions');
    const endResult = stateManager.endProjectMembership(projectId, 'designer');
    const contractResult = stateManager.updateProjectContract(projectId, 'forged goal', ['forged rule']);
    const policyResult = stateManager.setProjectWakePolicy(projectId, 'wake-model-assisted');
    const disbandResult = stateManager.disbandWorkingGroup(projectId, workingGroup.id);
    for (const result of [editResult, endResult, contractResult, policyResult, disbandResult]) {
      assert.equal(result.success, false);
      assert.match(result.reason ?? '', /archived Project.*Restore the Project first/i);
    }
    assert.equal(membership.status, 'active');
    assert.equal(membership.responsibilities, originalResponsibilities);
    assert.equal(membership.collaborationInstructions, originalInstructions);
    assert.equal(project.goal, originalGoal);
    assert.deepEqual(project.rules, originalRules);
    assert.equal(project.wakePolicy, originalPolicy);
    assert.equal(workingGroup.status, 'active');

    stateManager.selectProject(projectId);
    stateManager.setPrimaryNav('project', 'overview');
    assert.equal((dom.window.document.querySelector('.edit-contract-btn') as HTMLButtonElement).disabled, true);
    assert.equal((dom.window.document.querySelector('.toggle-policy-btn') as HTMLButtonElement).disabled, true);
    assert.equal((dom.window.document.querySelector('.add-member-btn') as HTMLButtonElement).disabled, true);
    assert.equal((dom.window.document.querySelector('.bind-env-btn') as HTMLButtonElement).disabled, true);

    stateManager.setPrimaryNav('project', 'chat');
    stateManager.openChatDetail('working-group-channel', workingGroup.id);
    renderWorkingGroupDetailsModal(dom.window.document.getElementById('app')!, stateManager.getSnapshot(), project, workingGroup);
    assert.equal((dom.window.document.querySelector('.btn-disband-wg') as HTMLButtonElement).disabled, true);

    stateManager.restoreProject(projectId);
    assert.equal(stateManager.editProjectMembership(projectId, 'designer', 'restored responsibility').success, true);
    assert.equal(stateManager.setProjectWakePolicy(projectId, 'wake-model-assisted').success, true);
    assert.equal(stateManager.disbandWorkingGroup(projectId, workingGroup.id).success, true);
  } finally {
    await cleanup();
  }
});
