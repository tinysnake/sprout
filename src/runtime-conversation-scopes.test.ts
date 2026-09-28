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
import { projectChannelScopeId, isWorkingGroup, workingGroupStatus } from './conversation/model.ts';

/**
 * Runtime composition evidence for conversation scopes and Working groups
 * (#95): the Project channel invariant rides the Project authority's
 * prepare/commit bridge, Working group creation performs no work, and the
 * ended-membership cascade survives a restart reconciliation.
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
