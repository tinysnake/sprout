import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



test('Project mentions: archived exact targets fail durably without silent retargeting (F-66-10)', async () => {
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
    stateManager.setPrimaryNav('project', 'chat');
    stateManager.openChatDetail('project-channel');

    const projectId = 'proj-minesweeper';
    assert.equal(stateManager.archiveAgent('reviewer').success, true);
    const messageCountBefore = stateManager.getSnapshot().messages.length;

    const result = stateManager.sendMessage(
      projectId,
      { kind: 'project-channel' },
      '@reviewer please verify this exact route'
    );
    assert.equal(result.success, true, 'The Human-authored Message remains durable');

    const routedMessage = stateManager
      .getSnapshot()
      .messages.slice(messageCountBefore)
      .find((message) => message.content.includes('verify this exact route')) as
      | (ReturnType<typeof stateManager.getSnapshot>['messages'][number] & {
          deterministicRoutingOutcomes?: Array<{
            targetAgentId: string;
            status: 'admitted' | 'failed';
            reason?: string;
          }>;
        })
      | undefined;
    assert.ok(routedMessage, 'The original addressed Message is preserved');
    assert.equal(routedMessage.disposition, 'addressed');
    assert.deepEqual(
      routedMessage.deterministicRoutingOutcomes?.map((outcome) => ({
        targetAgentId: outcome.targetAgentId,
        status: outcome.status,
      })),
      [{ targetAgentId: 'reviewer', status: 'failed' }],
      'The exact archived target has one durable failed routing outcome'
    );
    assert.match(routedMessage.deterministicRoutingOutcomes?.[0]?.reason ?? '', /archived.*restore/i);
    const routingInfoButton = dom.window.document.querySelector<HTMLButtonElement>(
      `.chat-msg[data-msg-id="${routedMessage.id}"] .msg-info-trigger-btn`
    );
    assert.ok(routingInfoButton, 'Addressed Message exposes its routing evidence on desktop and mobile');
    routingInfoButton.click();
    const routingEvidence = dom.window.document.querySelector('.deterministic-routing-outcomes');
    assert.match(routingEvidence?.textContent ?? '', /Reviewer.*Failed closed/i);
    assert.match(routingEvidence?.textContent ?? '', /archived.*Restore the Agent/i);

    const messageCountAfterRouting = stateManager.getSnapshot().messages.length;
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(
      stateManager.getSnapshot().messages.length,
      messageCountAfterRouting,
      'No archived or silently substituted Agent emits a projected reply'
    );

    stateManager.restoreAgent('reviewer');
    const beforeValidMention = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(
        projectId,
        { kind: 'project-channel' },
        '@reviewer this route must remain exact'
      ).success,
      true
    );
    const admittedMessage = stateManager.getSnapshot().messages[beforeValidMention] as
      | (ReturnType<typeof stateManager.getSnapshot>['messages'][number] & {
          deterministicRoutingOutcomes?: Array<{ targetAgentId: string; status: string }>;
        })
      | undefined;
    assert.deepEqual(admittedMessage?.deterministicRoutingOutcomes, [
      {
        targetAgentId: 'reviewer',
        targetDisplayName: 'Reviewer',
        status: 'admitted',
        reason: 'Exact mention @reviewer deterministically admitted without wake-model judgement.',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const projectedReplies = stateManager
      .getSnapshot()
      .messages.slice(beforeValidMention + 1)
      .filter((message) => message.isProjectedReply);
    assert.deepEqual(
      projectedReplies.map((message) => message.authorId),
      ['reviewer'],
      'A valid exact mention wakes only its named Agent'
    );
  } finally {
    await cleanup();
  }
});

test('Working Groups: ended Project membership blocks restore and preserves retained history (F-66-11)', async () => {
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

    const projectId = 'proj-minesweeper';
    const project = stateManager.getSnapshot().projects.find((candidate) => candidate.id === projectId)!;
    const group = project.workingGroups.find((candidate) => candidate.id === 'wg-audio')!;
    const historicalMessageIds = stateManager
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.scope.kind === 'working-group-channel' &&
          message.scope.workingGroupId === group.id
      )
      .map((message) => message.id);
    assert.ok(historicalMessageIds.length > 0, 'Fixture provides retained Working Group history');
    assert.equal(group.status, 'disbanded');
    assert.ok(group.memberIds.includes('designer'));

    assert.equal(stateManager.endProjectMembership(projectId, 'designer').success, true);
    assert.ok(group.retainedMemberIds?.includes('designer'), 'Disbanded group retains its restore candidate history');
    assert.ok(
      group.membershipHistory?.some(
        (record) => record.memberId === 'designer' && record.endedAt === 'Just now'
      ),
      'Membership end is recorded without erasing Working Group participation'
    );
    const restoreResult = stateManager.restoreWorkingGroup(projectId, group.id);
    assert.equal(restoreResult.success, false, 'A retained ended member makes restore ineligible');
    assert.match(restoreResult.reason ?? '', /Designer.*active Project membership/i);
    assert.equal(group.status, 'disbanded', 'Rejected restore leaves history read-only');

    const sendResult = stateManager.sendMessage(
      projectId,
      { kind: 'working-group-channel', workingGroupId: group.id },
      'This must remain unavailable'
    );
    assert.equal(sendResult.success, false);
    assert.deepEqual(
      stateManager
        .getSnapshot()
        .messages.filter(
          (message) =>
            message.scope.kind === 'working-group-channel' &&
            message.scope.workingGroupId === group.id
        )
        .map((message) => message.id),
      historicalMessageIds,
      'Rejected restore and send do not delete or append Working Group history'
    );

    stateManager.setPrimaryNav('project', 'chat');
    stateManager.openChatDetail('working-group-channel', group.id);
    assert.match(
      dom.window.document.querySelector('.chat-readonly-banner')?.textContent ?? '',
      /Designer.*active Project membership/i,
      'The unavailable restore reason is visible in the read-only conversation'
    );
    const restoreButton = dom.window.document.querySelector<HTMLButtonElement>('.restore-wg-quick-btn');
    assert.ok(restoreButton);
    assert.equal(restoreButton.disabled, true, 'An ineligible Working Group cannot be restored from the UI');
  } finally {
    await cleanup();
  }
});

test('Collaboration admission: wake selection and archived-Project callbacks fail closed', async () => {
  const { vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const projectId = 'proj-minesweeper';
    assert.equal(stateManager.endProjectMembership(projectId, 'designer').success, true);
    const messageCountBeforeWake = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(projectId, { kind: 'project-channel' }, 'Unaddressed routing must recheck membership').success,
      true,
      'The input Message remains durable when selected-Agent admission fails'
    );
    const failedBatch = stateManager.getSnapshot().routingBatches[0]!;
    assert.equal(failedBatch.status, 'failed-closed');
    assert.equal(failedBatch.closedAt, 'Just now', 'Immediate terminal batch does not retain a future close deadline');
    assert.equal(failedBatch.decisions[0]?.status, 'failed');
    const failedWakeRequest = failedBatch.resultingWakeRequests?.[0]!;
    assert.equal(failedWakeRequest.admissionStatus, 'failed', 'Legacy admission failure fact remains compatible');
    assert.equal(failedWakeRequest.terminalStatus, 'failed-closed');
    assert.deepEqual(failedWakeRequest.terminalResponsibility, { kind: 'agent', id: 'designer' });
    assert.match(failedWakeRequest.terminalReason ?? '', /active Project membership/i);
    assert.match(failedWakeRequest.failureReason ?? '', /active Project membership/i);
    assert.ok(failedWakeRequest.terminalTimestamp, 'Immediate admission failure is terminalized at construction');
    assert.match(failedBatch.failureReason ?? '', /active Project membership/i);
    assert.equal(stateManager.getSnapshot().messages.length, messageCountBeforeWake + 1);

    const secondaryProjectId = 'proj-unity-sims';
    const beforeDirect = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(
        secondaryProjectId,
        { kind: 'direct-message', recipientId: 'reviewer' },
        'Archive the Project before this admitted reply settles'
      ).success,
      true
    );
    const pendingDirectMessage = stateManager.getSnapshot().messages.at(-1)!;
    stateManager.archiveProject(secondaryProjectId);
    assert.equal(
      stateManager.getSnapshot().projects.find((project) => project.id === secondaryProjectId)?.status,
      'archived'
    );
    assert.equal(pendingDirectMessage.deterministicRoutingOutcomes?.[0]?.status, 'cancelled');
    assert.deepEqual(pendingDirectMessage.deterministicRoutingOutcomes?.[0]?.terminalResponsibility, {
      kind: 'project',
      id: secondaryProjectId,
    });
    assert.match(pendingDirectMessage.deterministicRoutingOutcomes?.[0]?.reason ?? '', /Project.*archived.*will not replay/i);
    const messageCountAtArchive = stateManager.getSnapshot().messages.length;
    assert.equal(messageCountAtArchive, beforeDirect + 1);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(
      stateManager.getSnapshot().messages.length,
      messageCountAtArchive,
      'A Project archive cancels and independently suppresses pending projected replies'
    );
  } finally {
    await cleanup();
  }
});

test('Archived Projects: direct state entry points cannot add Agent membership or proposals', async () => {
  const { vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule(
      '/src/prototype/state.ts'
    )) as typeof import('./state.js');

    const projectId = 'proj-docs-portal';
    const project = stateManager.getSnapshot().projects.find((candidate) => candidate.id === projectId)!;
    assert.equal(project.status, 'archived');
    const membershipCount = project.memberships.length;
    const taskCount = stateManager.getSnapshot().tasks.length;
    const designerMembership = project.memberships.find((membership) => membership.memberId === 'designer')!;
    designerMembership.status = 'ended';

    const membershipResult = stateManager.addProjectMembership(projectId, 'programmer');
    assert.equal(membershipResult.success, false);
    assert.match(membershipResult.reason ?? '', /archived Project/i);
    assert.equal(project.memberships.length, membershipCount);

    const restoreMembershipResult = stateManager.restoreProjectMembership(projectId, 'designer');
    assert.equal(restoreMembershipResult.success, false);
    assert.match(restoreMembershipResult.reason ?? '', /archived Project/i);
    assert.equal(designerMembership.status, 'ended', 'Archived Project preserves the ended membership');

    const proposalResult = stateManager.createTaskProposal(
      projectId,
      'Must not be created',
      'Archived Projects cannot accept proposals',
      [],
      [],
      'designer'
    );
    assert.equal(proposalResult.success, false);
    assert.match(proposalResult.reason ?? '', /archived Project/i);
    assert.equal(stateManager.getSnapshot().tasks.length, taskCount);

    stateManager.restoreProject(projectId);
    assert.equal(stateManager.restoreProjectMembership(projectId, 'designer').success, true);
    assert.equal(designerMembership.status, 'active', 'Membership restore becomes available after Project restore');
  } finally {
    await cleanup();
  }
});
