import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



test('Task proposals: state boundary rejects forged authority and unavailable lead responsibility', async () => {
  const { vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const projectId = 'proj-minesweeper';
    const initialTaskCount = stateManager.getSnapshot().tasks.length;
    const propose = (leadId: string, proposerKind: 'human' | 'agent', proposerId?: string) =>
      stateManager.createTaskProposal(
        projectId,
        `Boundary proposal ${leadId} ${proposerId ?? 'operator'}`,
        'Prove proposal authority without admitting resources.',
        [],
        [],
        leadId,
        proposerKind,
        proposerId
      );

    const forgedHuman = propose('programmer', 'human', 'forged-human');
    assert.equal(forgedHuman.success, false);
    assert.match(forgedHuman.reason ?? '', /current Operator identity/i);

    const missingAgentIdentity = propose('programmer', 'agent');
    assert.equal(missingAgentIdentity.success, false);
    assert.match(missingAgentIdentity.reason ?? '', /explicit proposer identity/i);

    const archivedProposer = propose('programmer', 'agent', 'legacy-coder');
    assert.equal(archivedProposer.success, false);
    assert.match(archivedProposer.reason ?? '', /active global Agent.*active Project membership/i);

    const endedProposer = propose('programmer', 'agent', 'researcher');
    assert.equal(endedProposer.success, false);
    assert.match(endedProposer.reason ?? '', /active global Agent.*active Project membership/i);

    for (const invalidLead of ['not-an-agent', 'researcher', 'legacy-coder']) {
      const result = propose(invalidLead, 'human');
      assert.equal(result.success, false, `${invalidLead} cannot be persisted as valid Task responsibility`);
      assert.match(result.reason ?? '', /non-admissible.*active global Agent.*active Project membership/i);
    }
    assert.equal(stateManager.getSnapshot().tasks.length, initialTaskCount, 'Rejected authority facts do not create Tasks');

    const validProposal = propose('programmer', 'agent', 'planner');
    assert.equal(validProposal.success, true);
    const created = stateManager
      .getSnapshot()
      .tasks.find((task) => task.currentVersion.title.includes('Boundary proposal programmer planner'))!;
    assert.ok(created);
    assert.equal(created.proposerId, 'planner');
    assert.equal(created.currentVersion.createdBy, 'Planner (Agent)');
    assert.equal(created.lifecycle, 'proposed');
    assert.equal(created.leaseLifecycle, 'none');
    assert.equal(created.agentRunLifecycle, 'none');
    assert.equal(created.runs.length, 0, 'Proposal creation never admits resources or starts a run');

    const versionBeforeInvalidLead = created.currentVersion.version;
    const invalidRevision = stateManager.updateTaskContentVersion(
      created.id,
      'Forged replacement lead',
      created.currentVersion.goal,
      created.currentVersion.constraints,
      created.currentVersion.validationCriteria,
      'legacy-coder'
    );
    assert.equal(invalidRevision.success, false);
    assert.match(invalidRevision.reason ?? '', /active global Agent.*active Project membership/i);
    assert.equal(created.currentVersion.version, versionBeforeInvalidLead);
    assert.equal(created.taskLeadId, 'programmer', 'Rejected revision cannot overwrite valid responsibility');

    assert.equal(stateManager.endProjectMembership(projectId, 'programmer').success, true);
    assert.equal(created.lifecycle, 'proposed', 'Unavailable proposal lead does not imply that Task begin occurred');
    assert.ok(created.activeBlocker);
    assert.match(created.activeBlocker?.reason ?? '', /lead Programmer membership ended/i);
    assert.equal(created.leaseLifecycle, 'none');
    assert.equal(created.runs.length, 0);
    stateManager.resolveBlocker(created.id);
    assert.equal(created.lifecycle, 'proposed', 'Generic blocker resolution cannot bypass approve-and-begin');
    assert.ok(created.activeBlocker, 'Lead blocker remains until Human selects an eligible replacement');
    const replacementRevision = stateManager.updateTaskContentVersion(
      created.id,
      created.currentVersion.title,
      created.currentVersion.goal,
      created.currentVersion.constraints,
      created.currentVersion.validationCriteria,
      'designer'
    );
    assert.equal(replacementRevision.success, true);
    assert.equal(created.lifecycle, 'proposed');
    assert.equal(created.taskLeadId, 'designer');
    assert.equal(created.activeBlocker, undefined, 'Human replacement clears only the lead blocker');
    assert.equal(created.leaseLifecycle, 'none');
  } finally {
    await cleanup();
  }
});

test('Project restore: compatibility outcomes are durable and later Task begin still fails closed', async () => {
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

    const projectId = 'proj-docs-portal';
    const project = stateManager.getSnapshot().projects.find((candidate) => candidate.id === projectId)!;
    const env = stateManager.getSnapshot().environments.find((candidate) => candidate.id === 'env-ready')!;
    assert.equal(project.status, 'archived');

    env.enrollmentStatus = 'archived';
    env.connectionState = 'offline';
    const projectCount = stateManager.getSnapshot().projects.length;
    const createWithArchivedEnvironment = stateManager.createProject(
      'Unavailable Environment Assignment',
      '',
      [],
      [],
      [env.id]
    );
    assert.equal(createWithArchivedEnvironment.success, false);
    assert.match(createWithArchivedEnvironment.reason ?? '', /approved enrollment.*Project assignment/i);
    assert.equal(stateManager.getSnapshot().projects.length, projectCount);
    const archivedBindingCount = project.boundEnvironmentWorkspaces.length;
    const bindToArchivedProject = stateManager.bindEnvironmentToProject(
      projectId,
      'env-incompatible',
      'workspace-root',
      'must-not-bind'
    );
    assert.equal(bindToArchivedProject.success, false);
    assert.match(bindToArchivedProject.reason ?? '', /archived Project/i);
    assert.equal(project.boundEnvironmentWorkspaces.length, archivedBindingCount);

    stateManager.restoreProject(projectId);
    assert.equal(project.status, 'active', 'A Project can be restored for read/write management without implying work readiness');
    assert.equal(project.compatibilityHistory?.[0]?.status, 'unavailable');
    assert.match(project.compatibilityHistory?.[0]?.summary ?? '', /no bound Environment.*Task begin remains unavailable/i);
    assert.match(project.compatibilityHistory?.[0]?.environments[0]?.reason ?? '', /not approved|archived/i);
    stateManager.selectProject(projectId);
    stateManager.setPrimaryNav('project', 'overview');
    assert.match(
      dom.window.document.querySelector('.project-restore-compatibility')?.textContent ?? '',
      /unavailable[\s\S]*Task begin remains unavailable/i,
      'Latest restore compatibility fact is visible without implying Project work readiness'
    );

    stateManager.archiveProject(projectId);
    env.enrollmentStatus = 'approved';
    env.connectionState = 'online';
    env.protocolCompatibility = 'compatible';
    env.workSafety = 'clear';
    stateManager.restoreProject(projectId);
    assert.equal(project.compatibilityHistory?.[0]?.status, 'ready');
    assert.equal(project.compatibilityHistory?.[1]?.status, 'unavailable', 'Prior restore evidence remains reviewable');

    env.protocolCompatibility = 'incompatible';
    env.protocolMismatchDetail = 'Worker protocol became incompatible after restore.';
    const proposalResult = stateManager.createTaskProposal(
      projectId,
      'Restore admission probe',
      'Later Begin must re-evaluate current Environment facts.',
      [],
      [],
      'designer'
    );
    assert.equal(proposalResult.success, true);
    const proposal = stateManager
      .getSnapshot()
      .tasks.find((task) => task.currentVersion.title === 'Restore admission probe')!;
    const beginResult = stateManager.approveAndBeginProposal(proposal.id, env.id, 'designer');
    assert.equal(beginResult.success, false);
    assert.match(beginResult.reason ?? '', /protocol incompatible/i);
    assert.equal(proposal.lifecycle, 'proposed');
    assert.equal(proposal.leaseLifecycle, 'none');
    assert.equal(proposal.runs.length, 0);
  } finally {
    await cleanup();
  }
});

test('Task lead authority: generic unblock, resume, and recovery cannot restore an invalid lead', async () => {
  const { vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const projectId = 'proj-minesweeper';
    const blockedTask = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-103')!;
    const recoveryTask = stateManager.getSnapshot().tasks.find((task) => task.id === 'task-104')!;
    assert.equal(stateManager.endProjectMembership(projectId, 'programmer').success, true);
    assert.equal(blockedTask.lifecycle, 'blocked');
    assert.match(blockedTask.activeBlocker?.id ?? '', /^blocker-lead-/);

    stateManager.resolveBlocker(blockedTask.id);
    assert.equal(blockedTask.lifecycle, 'blocked', 'Generic unblock cannot reactivate an invalid Task lead');
    assert.match(blockedTask.activeBlocker?.id ?? '', /^blocker-lead-/);
    assert.equal(blockedTask.leaseLifecycle, 'held', 'Blocked Task retains, but does not recreate, its existing lease');

    blockedTask.lifecycle = 'paused';
    stateManager.resumeTask(blockedTask.id);
    assert.equal(blockedTask.lifecycle, 'blocked', 'Generic resume returns an invalid-lead Task to blocked');
    assert.match(blockedTask.activeBlocker?.requiredNextAction ?? '', /assign.*active Project Agent.*replacement/i);

    blockedTask.lifecycle = 'recovery';
    blockedTask.leaseLifecycle = 'recovering';
    const blockedEnvironment = stateManager
      .getSnapshot()
      .environments.find((environment) => environment.id === blockedTask.selectedEnvironmentId)!;
    blockedEnvironment.workSafety = 'recovery';
    blockedEnvironment.activeLeaseHolder = {
      holderKind: 'task',
      holderId: blockedTask.id,
      projectId: blockedTask.projectId,
      acquiredAt: 'Just now',
    };
    blockedEnvironment.leaseRecovery = {
      cause: 'Synthetic recovery state for invalid-lead reconciliation.',
      unresolvedFacts: ['Synthetic recovery evidence'],
    };
    stateManager.resumeOrdinaryRecovery(blockedTask.id);
    assert.equal(blockedTask.lifecycle, 'blocked', 'Recovery reconciliation cannot reactivate an invalid lead');
    assert.equal(blockedTask.leaseLifecycle, 'held', 'Reconciled lease remains reserved by the blocked Task');
    assert.match(blockedTask.activeBlocker?.id ?? '', /^blocker-lead-/);

    const recoveryReplacement = stateManager.updateTaskContentVersion(
      recoveryTask.id,
      recoveryTask.currentVersion.title,
      recoveryTask.currentVersion.goal,
      recoveryTask.currentVersion.constraints,
      recoveryTask.currentVersion.validationCriteria,
      'designer'
    );
    assert.equal(recoveryReplacement.success, true);
    assert.equal(recoveryTask.lifecycle, 'recovery', 'Lead replacement does not bypass the Human recovery boundary');
    assert.equal(recoveryTask.leaseLifecycle, 'recovering');
    assert.equal(recoveryTask.activeBlocker, undefined);
    stateManager.resumeOrdinaryRecovery(recoveryTask.id);
    assert.equal(recoveryTask.lifecycle, 'active');
    assert.equal(recoveryTask.leaseLifecycle, 'held');

    const replacement = stateManager.updateTaskContentVersion(
      blockedTask.id,
      blockedTask.currentVersion.title,
      blockedTask.currentVersion.goal,
      blockedTask.currentVersion.constraints,
      blockedTask.currentVersion.validationCriteria,
      'designer'
    );
    assert.equal(replacement.success, true);
    assert.equal(blockedTask.taskLeadId, 'designer');
    assert.equal(blockedTask.activeBlocker, undefined);
    assert.equal(blockedTask.lifecycle, 'active', 'Human content revision with an eligible replacement restores advancement');
    assert.equal(blockedTask.leaseLifecycle, 'held');
  } finally {
    await cleanup();
  }
});
