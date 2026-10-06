import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  build,
  createRuntime,
  hostConfiguration,
  PROJECT_ID,
} from './runtime-test-harness.ts';
import { projectChannelScopeId, isWorkingGroup, taskGroupStatus, workingGroupStatus } from './conversation/model.ts';
import type { Task } from './task/model.ts';

function admittedTask(id: string, status: Task['status']): Task {
  return {
    id,
    projectId: PROJECT_ID,
    title: `Task ${id}`,
    goal: `Goal ${id}`,
    constraints: [`Constraint ${id}`],
    status,
    admission: {
      proposalId: `proposal-${id}`,
      proposalRevision: 1,
      contentVersion: 1,
      validationCriteria: [],
      lead: { memberId: 'scout', memberKind: 'agent' },
      contextAgentId: 'scout',
      approvedBy: { memberId: 'operator', memberKind: 'human' },
      approvedAt: 100,
    },
    environmentLifecycleState: status === 'done' ? 'ended' : 'idle',
    createdAt: 100,
    updatedAt: 100,
    ...(status === 'done' ? { completedAt: 200 } : {}),
  };
}

/**
 * Runtime composition evidence for conversation scopes and Working groups
 * (#95), plus Task groups (#210): the Project channel invariant rides the
 * Project authority's prepare/commit bridge; Task groups are created from
 * admitted Task facts, including restart recovery; Working group creation
 * performs no work; ended-membership cascades survive reconciliation.
 */

test('every composed Project gets its one Project channel with the Project itself', async () => {
  const { runtime, stores } = await build({ listen: false });
  try {
    // The host-configured Project was hydrated with its channel at startup.
    const configured = await stores.conversationScopes.get(projectChannelScopeId(PROJECT_ID));
    assert.equal(configured?.kind, 'project');

    // An authority Project records its channel during the same prepared flow
    // that persists the Project — before any scope read touches the service.
    const project = await runtime.projectService.create({
      id: 'project-conversation',
      displayName: 'Conversation host',
      agentMemberships: [{ agentId: 'scout' }],
    });
    const durable = await stores.conversationScopes.get(projectChannelScopeId(project.id));
    assert.equal(durable?.kind, 'project', 'the channel exists without a scope read');

    const listed = await runtime.conversationScopes.listScopes(project.id);
    assert.deepEqual(
      listed.filter((scope) => scope.kind === 'project').map((scope) => scope.id),
      [projectChannelScopeId(project.id)],
      'one Project, one channel',
    );
  } finally {
    await runtime.close();
  }
});

test('startup reconciliation creates missing admitted Task groups and freezes terminal ones', async () => {
  const { runtime, stores } = await build({ listen: false });
  try {
    const activeTask = admittedTask('restart-active', 'in-progress');
    const revisedTask: Task = {
      ...admittedTask('restart-revised', 'in-progress'),
      title: 'Revised title',
      goal: 'Revised goal',
      constraints: ['Revised constraint'],
      controlHistory: [{
        action: 'content-revised',
        actor: { memberId: 'operator', memberKind: 'human' },
        at: 150,
        reason: 'Clarified acceptance context',
        contentVersion: 2,
        previous: {
          title: 'Task restart-revised', goal: 'Goal restart-revised', constraints: ['Constraint restart-revised'],
          validationCriteria: [], lead: { memberId: 'scout', memberKind: 'agent' },
        },
        content: {
          title: 'Revised title', goal: 'Revised goal', constraints: ['Revised constraint'],
          validationCriteria: [], lead: { memberId: 'scout', memberKind: 'agent' },
        },
      }],
    };
    const terminalTask = admittedTask('restart-done', 'done');
    const stoppedTask = admittedTask('restart-stopped', 'stopped');
    const cancelledTask = admittedTask('restart-cancelled', 'cancelled');
    const failedTask = admittedTask('restart-failed', 'failed');
    await stores.tasks.create(activeTask);
    await stores.tasks.create(revisedTask);
    await stores.tasks.create(terminalTask);
    await stores.tasks.create(stoppedTask);
    await stores.tasks.create(cancelledTask);
    await stores.tasks.create(failedTask);

    await runtime.reconcile();

    const groups = (await stores.conversationScopes.listForProject(PROJECT_ID))
      .filter((scope) => scope.kind === 'task-group');
    const activeGroup = groups.find((group) => group.taskId === activeTask.id);
    const revisedGroup = groups.find((group) => group.taskId === revisedTask.id);
    const terminalGroup = groups.find((group) => group.taskId === terminalTask.id);
    const stoppedGroup = groups.find((group) => group.taskId === stoppedTask.id);
    const cancelledGroup = groups.find((group) => group.taskId === cancelledTask.id);
    const failedGroup = groups.find((group) => group.taskId === failedTask.id);
    assert.ok(activeGroup, 'the admitted Task gets a scope even if the original admission write was interrupted');
    assert.equal(activeGroup.content.currentVersion, 1);
    assert.equal(activeGroup.content.versions[0]?.taskTitle, activeTask.title);
    assert.equal(activeGroup.content.versions[0]?.goal, activeTask.goal);
    assert.deepEqual(activeGroup.content.versions[0]?.rules, activeTask.constraints);
    assert.equal(taskGroupStatus(activeGroup), 'active');
    assert.ok(revisedGroup, 'reconciliation uses the current content revision, not the original admission version');
    assert.equal(revisedGroup.content.versions[0]?.taskContentVersion, 2);
    assert.equal(revisedGroup.content.versions[0]?.taskTitle, revisedTask.title);
    assert.equal(revisedGroup.content.versions[0]?.goal, revisedTask.goal);
    assert.deepEqual(revisedGroup.content.versions[0]?.rules, revisedTask.constraints);
    assert.equal(revisedGroup.content.versions[0]?.actorMemberId, 'operator');
    assert.ok(terminalGroup, 'a terminal Task still gets its durable conversation history scope');
    assert.equal(taskGroupStatus(terminalGroup), 'frozen');
    assert.equal(terminalGroup.terminalTaskStatus, 'done');
    assert.ok(stoppedGroup);
    assert.equal(stoppedGroup.terminalTaskStatus, 'stopped');
    assert.equal(taskGroupStatus(stoppedGroup), 'frozen');
    assert.ok(cancelledGroup);
    assert.equal(cancelledGroup.terminalTaskStatus, 'cancelled');
    assert.equal(taskGroupStatus(cancelledGroup), 'frozen');
    assert.ok(failedGroup);
    assert.equal(failedGroup.terminalTaskStatus, 'failed');
    assert.equal(taskGroupStatus(failedGroup), 'frozen');

    const firstPass = JSON.stringify(groups);
    await runtime.reconcile();
    const secondPass = (await stores.conversationScopes.listForProject(PROJECT_ID))
      .filter((scope) => scope.kind === 'task-group');
    assert.equal(JSON.stringify(secondPass), firstPass, 'repeat reconciliation appends no duplicate snapshots or freeze facts');
  } finally {
    await runtime.close();
  }
});

test('Working group creation wakes no Agent and creates no run, message, Task, or lease', async () => {
  const { runtime, stores } = await build({ listen: false });
  try {
    const runsBefore = (await runtime.orchestrator.list()).length;
    const group = await runtime.conversationScopes.createWorkingGroup({
      projectId: PROJECT_ID,
      displayName: 'Quiet group',
      creator: { memberId: 'operator', kind: 'human' },
      memberIds: ['scout'],
      goal: 'Touch nothing.',
    });
    assert.equal(workingGroupStatus(group), 'active');

    // The creation's only durable effect is the one scope record: no Message,
    // no wake request, no run, no Task, no lease (ADR-0008).
    assert.equal((await runtime.orchestrator.list()).length, runsBefore, 'no run was admitted');
    assert.deepEqual(await runtime.collaboration.listMessages(), [], 'no Message was sent');
    assert.deepEqual(await runtime.collaboration.listWakeRequests(), [], 'no wake was created');
    assert.deepEqual(await stores.tasks.list({}), [], 'no Task was created');
    assert.deepEqual(runtime.pool.leases(), [], 'no lease was acquired');
    assert.equal(
      (await stores.conversationScopes.listForProject(PROJECT_ID)).filter(isWorkingGroup).length,
      1,
      'exactly one durable Working group record exists',
    );
  } finally {
    await runtime.close();
  }
});

test('an ended Project membership cascades to Working group participation and survives a restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-conversation-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'sprout.db');

  // First process: create the Project and a Working group containing scout,
  // end the Project membership, and exit without ever reading the group —
  // the cascade has not been materialized yet.
  const first = await createRuntime({
    configuration: hostConfiguration({ databasePath }),
    projectRoot: '/synthetic/project-root',
  });
  const project = await first.projectService.create({
    id: 'project-cascade',
    displayName: 'Cascade host',
    agentMemberships: [{ agentId: 'scout' }],
  });
  const group = await first.conversationScopes.createWorkingGroup({
    projectId: project.id,
    displayName: 'Reviewer loop',
    creator: { memberId: 'operator', kind: 'human' },
    memberIds: ['scout'],
  });
  await first.projectService.endMembership(project.id, 'scout', { reason: 'rotated off' });
  await first.close();

  // Reopen exactly as a restart would, then reconcile: syncAll materializes
  // the participation end from the durable Project membership end facts.
  const second = await createRuntime({
    configuration: hostConfiguration({ databasePath }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    await second.reconcile();
    const reopened = await second.conversationScopes.getWorkingGroup(group.id);
    assert.ok(reopened && isWorkingGroup(reopened));
    const scout = reopened.memberships.find((entry) => entry.memberId === 'scout');
    assert.ok(scout?.endedAt, 'the participation end is durable after restart');
    assert.equal(scout?.endedBy, 'project-membership');
    assert.equal(scout?.endedReason, 'rotated off', 'the Project membership end reason carries over');
    assert.equal(
      reopened.memberships.some((entry) => entry.memberId === 'operator' && entry.endedAt === undefined),
      true,
      'history and the remaining membership are intact',
    );

    // The Project channel invariant holds across the restart as well.
    const channels = (await second.conversationScopes.listScopes(project.id)).filter(
      (scope) => scope.kind === 'project',
    );
    assert.equal(channels.length, 1);
  } finally {
    await second.close();
  }
});

test('restart reconciliation leaves no orphan Project-channel row from an interrupted creation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-conversation-orphan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'sprout.db');

  // First process: the bridge records the Project channel during the
  // authority's prepare phase and the process dies before the Project save —
  // neither commit nor rollback runs, so the durable channel row outlives its
  // Project (the crash window of #95 F2). A Working group in the configured
  // Project stays behind as the history reconciliation must never delete.
  const first = await createRuntime({
    configuration: hostConfiguration({ databasePath }),
    projectRoot: '/synthetic/project-root',
  });
  await first.conversationScopes.prepareProjectChannel({ id: 'project-interrupted' });
  const group = await first.conversationScopes.createWorkingGroup({
    projectId: PROJECT_ID,
    displayName: 'Survivor loop',
    creator: { memberId: 'operator', kind: 'human' },
    memberIds: ['scout'],
  });
  await first.close();

  // Restart: reconcile removes exactly the abandoned preparation before
  // anything is served, while the configured Project's channel and the
  // Working group record survive untouched (ADR-0008: no lifecycle fact is
  // ever deleted).
  const second = await createRuntime({
    configuration: hostConfiguration({ databasePath }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    await second.reconcile();
    assert.equal(
      await second.conversationScopes.getScope(projectChannelScopeId('project-interrupted')),
      undefined,
      'the orphaned channel row from the interrupted preparation is gone',
    );
    assert.equal(
      (await second.conversationScopes.getScope(projectChannelScopeId(PROJECT_ID)))?.kind,
      'project',
      'a channel whose Project exists is kept',
    );
    const kept = await second.conversationScopes.getWorkingGroup(group.id);
    assert.ok(kept && isWorkingGroup(kept), 'Working group history is never removed');
    assert.equal(kept.memberships.length, 2);
  } finally {
    await second.close();
  }
});
