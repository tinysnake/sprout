import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';



test('Paused correction and blocker resolution preserve the lease until explicit Human Resume', async () => {
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
    const claimTask = stateManager.getSnapshot().tasks.find((candidate) => candidate.id === 'task-101')!;
    const claimEnv = stateManager.getSnapshot().environments.find((candidate) => candidate.id === claimTask.selectedEnvironmentId)!;
    claimEnv.activeLeaseHolder = {
      holderKind: 'task',
      holderId: claimTask.id,
      projectId: claimTask.projectId,
      acquiredAt: 'Just now',
    };
    assert.equal(stateManager.pauseTask(claimTask.id).success, true);
    stateManager.selectTask(claimTask.id);
    assert.ok(dom.window.document.querySelector('.require-correction-btn'), 'Paused DOM keeps the correction control');
    const runsBeforeCorrection = claimTask.runs.length;
    (dom.window as unknown as { prompt: (message?: string, defaultValue?: string) => string }).prompt = () => 'Refine the mobile edge case.';
    (globalThis as unknown as { prompt: (message?: string, defaultValue?: string) => string }).prompt = () => 'Refine the mobile edge case.';
    (dom.window.document.querySelector('.require-correction-btn') as HTMLButtonElement).click();
    assert.equal(claimTask.lifecycle, 'paused');
    assert.equal(claimTask.pendingCompletionClaim, undefined);
    assert.equal(claimTask.leaseLifecycle, 'held');
    assert.equal(claimTask.activeRunId, undefined);
    assert.equal(claimTask.runs.length, runsBeforeCorrection, 'Paused correction does not start a run');
    assert.equal(claimEnv.activeLeaseHolder?.holderId, claimTask.id);
    assert.ok(dom.window.document.querySelector('.resume-task-btn'), 'Explicit Human Resume remains the next advancement control');
    (dom.window.document.querySelector('.resume-task-btn') as HTMLButtonElement).click();
    assert.equal(claimTask.lifecycle, 'active');
    assert.equal(claimTask.leaseLifecycle, 'held');
    assert.equal(claimTask.agentRunLifecycle, 'none');

    const blockedTask = stateManager.getSnapshot().tasks.find((candidate) => candidate.id === 'task-103')!;
    const blockedEnv = stateManager.getSnapshot().environments.find((candidate) => candidate.id === blockedTask.selectedEnvironmentId)!;
    blockedTask.lifecycle = 'paused';
    blockedTask.agentRunLifecycle = 'none';
    blockedTask.leaseLifecycle = 'held';
    blockedEnv.activeLeaseHolder = {
      holderKind: 'task',
      holderId: blockedTask.id,
      projectId: blockedTask.projectId,
      acquiredAt: 'Just now',
    };
    stateManager.selectTask(blockedTask.id);
    assert.ok(dom.window.document.querySelector('.resolve-blocker-btn'), 'Paused DOM exposes blocker resolution');
    (dom.window.document.querySelector('.resolve-blocker-btn') as HTMLButtonElement).click();
    assert.equal(blockedTask.lifecycle, 'paused', 'Resolving a paused blocker does not resume work');
    assert.equal(blockedTask.activeBlocker, undefined);
    assert.equal(blockedTask.leaseLifecycle, 'held');
    assert.equal(blockedTask.agentRunLifecycle, 'none');
    assert.equal(blockedEnv.activeLeaseHolder?.holderId, blockedTask.id);
    assert.ok(dom.window.document.querySelector('.resume-task-btn'));
    (dom.window.document.querySelector('.resume-task-btn') as HTMLButtonElement).click();
    assert.equal(blockedTask.lifecycle, 'active', 'Only explicit Human Resume leaves the paused hold');
    assert.equal(blockedTask.leaseLifecycle, 'held');
    assert.equal(blockedTask.agentRunLifecycle, 'none');
  } finally {
    await cleanup();
  }
});

test('Routing cancellation: Agent and Project archive write durable terminal outcomes without replies', async () => {
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

    const agentProjectId = 'proj-minesweeper';
    const routingBatches = stateManager.getSnapshot().routingBatches;
    routingBatches.unshift({
      id: 'batch-pre-existing-agent-evaluating',
      projectId: agentProjectId,
      openedAt: '20s ago',
      closedAt: 'Just now',
      inputMessageIds: ['msg-pre-existing-agent'],
      status: 'evaluating',
      attemptsCount: 1,
      wakeModel: 'gpt-4o-mini',
      frozenContextSummary: {
        tokenCount: 600,
        projectRulesIncluded: true,
        recentMessagesCount: 1,
        tasksSummariesCount: 1,
        truncated: false,
      },
      decisions: [
        {
          messageId: 'msg-pre-existing-agent',
          targetAgentId: 'reviewer',
          status: 'selected',
          rationale: 'Persisted Reviewer selection awaiting settlement.',
        },
      ],
      resultingWakeRequestIds: ['wake-pre-existing-agent'],
      resultingWakeRequests: [
        {
          wakeRequestId: 'wake-pre-existing-agent',
          targetAgentId: 'reviewer',
          admissionStatus: 'pending',
        },
      ],
    });
    const agentMessageCount = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(agentProjectId, { kind: 'project-channel' }, '@reviewer terminal cancellation evidence').success,
      true
    );
    const addressedMessage = stateManager.getSnapshot().messages.at(-1)!;
    assert.equal(addressedMessage.deterministicRoutingOutcomes?.[0]?.status, 'admitted');
    assert.equal(stateManager.archiveAgent('reviewer').success, true);
    assert.equal(addressedMessage.deterministicRoutingOutcomes?.[0]?.status, 'cancelled');
    assert.deepEqual(addressedMessage.deterministicRoutingOutcomes?.[0]?.terminalResponsibility, {
      kind: 'agent',
      id: 'reviewer',
    });
    const preExistingAgentBatch = routingBatches.find(
      (candidate) => candidate.id === 'batch-pre-existing-agent-evaluating'
    )!;
    assert.equal(preExistingAgentBatch.status, 'failed-closed');
    assert.deepEqual(preExistingAgentBatch.terminalResponsibility, { kind: 'agent', id: 'reviewer' });
    assert.equal(preExistingAgentBatch.resultingWakeRequests?.[0]?.admissionStatus, 'failed');
    assert.deepEqual(preExistingAgentBatch.resultingWakeRequests?.[0]?.terminalResponsibility, {
      kind: 'agent',
      id: 'reviewer',
    });
    assert.equal(preExistingAgentBatch.resultingWakeRequests?.[0]?.terminalStatus, 'failed-closed');
    assert.match(preExistingAgentBatch.resultingWakeRequests?.[0]?.terminalReason ?? '', /Agent.*archived/i);
    assert.ok(preExistingAgentBatch.resultingWakeRequests?.[0]?.terminalTimestamp);
    assert.match(addressedMessage.deterministicRoutingOutcomes?.[0]?.reason ?? '', /Agent.*archived.*no reply.*will not replay/i);
    stateManager.selectProject(agentProjectId);
    stateManager.setPrimaryNav('project', 'chat');
    stateManager.openChatDetail('project-channel');
    const routingEvidenceButton = dom.window.document.querySelector<HTMLButtonElement>(
      `.msg-info-trigger-btn[data-msg-id="${addressedMessage.id}"]`
    );
    assert.ok(routingEvidenceButton);
    routingEvidenceButton.click();
    const terminalEvidence = dom.window.document.querySelector('.projected-reply-popup')?.textContent ?? '';
    assert.match(terminalEvidence, /Cancelled/);
    assert.match(terminalEvidence, /Responsible agent.*reviewer/i);
    assert.doesNotMatch(terminalEvidence, /@Reviewer\s*·\s*Admitted/i);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(stateManager.getSnapshot().messages.length, agentMessageCount + 1, 'Cancelled Agent work emits no reply');

    const projectId = 'proj-docs-portal';
    stateManager.restoreProject(projectId);
    stateManager.setProjectWakePolicy(projectId, 'wake-model-assisted');
    routingBatches.unshift(
      {
        id: 'batch-pre-existing-open',
        projectId,
        openedAt: '10s ago',
        closedAt: 'In 20s',
        inputMessageIds: ['msg-pre-existing-open'],
        status: 'open',
        attemptsCount: 0,
        wakeModel: 'gpt-4o-mini',
        frozenContextSummary: {
          tokenCount: 500,
          projectRulesIncluded: true,
          recentMessagesCount: 1,
          tasksSummariesCount: 0,
          truncated: false,
        },
        decisions: [],
        resultingWakeRequestIds: [],
        resultingWakeRequests: [],
      },
      {
        id: 'batch-pre-existing-evaluating',
        projectId,
        openedAt: '40s ago',
        closedAt: '10s ago',
        inputMessageIds: ['msg-pre-existing-evaluating'],
        status: 'evaluating',
        attemptsCount: 1,
        wakeModel: 'gpt-4o-mini',
        frozenContextSummary: {
          tokenCount: 700,
          projectRulesIncluded: true,
          recentMessagesCount: 2,
          tasksSummariesCount: 0,
          truncated: false,
        },
        decisions: [
          {
            messageId: 'msg-pre-existing-evaluating',
            targetAgentId: 'designer',
            status: 'selected',
            rationale: 'Persisted selection awaiting terminal admission evidence.',
          },
        ],
        resultingWakeRequestIds: ['wake-pre-pending', 'wake-pre-waiting', 'wake-pre-admitted'],
        resultingWakeRequests: [
          { wakeRequestId: 'wake-pre-pending', targetAgentId: 'designer', admissionStatus: 'pending' },
          { wakeRequestId: 'wake-pre-waiting', targetAgentId: 'designer', admissionStatus: 'waiting_capacity' },
          { wakeRequestId: 'wake-pre-admitted', targetAgentId: 'designer', admissionStatus: 'admitted' },
        ],
      },
      {
        id: 'batch-pre-existing-settled-stale-wakes',
        projectId,
        openedAt: '2m ago',
        closedAt: '90s ago',
        inputMessageIds: ['msg-pre-existing-settled'],
        status: 'settled',
        attemptsCount: 1,
        wakeModel: 'gpt-4o-mini',
        frozenContextSummary: {
          tokenCount: 640,
          projectRulesIncluded: true,
          recentMessagesCount: 2,
          tasksSummariesCount: 0,
          truncated: false,
        },
        decisions: [
          {
            messageId: 'msg-pre-existing-settled',
            targetAgentId: 'designer',
            status: 'selected',
            rationale: 'Persisted settled parent with incomplete per-request evidence.',
          },
        ],
        resultingWakeRequestIds: ['wake-settled-pending', 'wake-settled-admitted', 'wake-settled-partial-terminal'],
        resultingWakeRequests: [
          { wakeRequestId: 'wake-settled-pending', targetAgentId: 'designer', admissionStatus: 'pending' },
          { wakeRequestId: 'wake-settled-admitted', targetAgentId: 'designer', admissionStatus: 'admitted' },
          {
            wakeRequestId: 'wake-settled-partial-terminal',
            targetAgentId: 'designer',
            admissionStatus: 'failed',
            terminalStatus: 'failed-closed',
            failureReason: 'Cancelled because Project "Docs Portal" was archived before routing settlement.',
          },
        ],
      }
    );
    const beforeWake = stateManager.getSnapshot().messages.length;
    assert.equal(
      stateManager.sendMessage(projectId, { kind: 'project-channel' }, 'Evaluate this, then archive the Project').success,
      true
    );
    const batch = stateManager.getSnapshot().routingBatches[0]!;
    assert.equal(batch.status, 'evaluating');
    stateManager.archiveProject(projectId);
    assert.equal(batch.status, 'failed-closed');
    assert.deepEqual(batch.terminalResponsibility, { kind: 'project', id: projectId });
    assert.equal(batch.decisions[0]?.status, 'failed');
    assert.equal(batch.resultingWakeRequests?.[0]?.admissionStatus, 'failed');
    assert.deepEqual(batch.resultingWakeRequests?.[0]?.terminalResponsibility, {
      kind: 'project',
      id: projectId,
    });
    assert.match(batch.failureReason ?? '', /Project.*archived.*no reply.*will not replay/i);
    assert.match(batch.resultingWakeRequests?.[0]?.failureReason ?? '', /Project.*archived/i);
    const preExistingOpen = routingBatches.find((candidate) => candidate.id === 'batch-pre-existing-open')!;
    assert.equal(preExistingOpen.status, 'failed-closed', 'Persisted open batch is terminalized without a timer callback');
    assert.deepEqual(preExistingOpen.terminalResponsibility, { kind: 'project', id: projectId });
    assert.match(preExistingOpen.failureReason ?? '', /Project.*archived.*no reply.*will not replay/i);
    const preExistingEvaluating = routingBatches.find(
      (candidate) => candidate.id === 'batch-pre-existing-evaluating'
    )!;
    assert.equal(preExistingEvaluating.status, 'failed-closed');
    assert.equal(preExistingEvaluating.decisions[0]?.status, 'failed');
    for (const wakeRequest of preExistingEvaluating.resultingWakeRequests ?? []) {
      assert.equal(wakeRequest.admissionStatus, 'failed');
      assert.equal(wakeRequest.terminalStatus, 'failed-closed');
      assert.deepEqual(wakeRequest.terminalResponsibility, { kind: 'project', id: projectId });
      assert.match(wakeRequest.terminalReason ?? '', /Project.*archived/i);
      assert.match(wakeRequest.failureReason ?? '', /Project.*archived/i);
      assert.ok(wakeRequest.terminalTimestamp);
    }
    const preExistingSettled = routingBatches.find(
      (candidate) => candidate.id === 'batch-pre-existing-settled-stale-wakes'
    )!;
    assert.equal(preExistingSettled.status, 'settled', 'Settled parent history remains unchanged');
    for (const wakeRequest of preExistingSettled.resultingWakeRequests ?? []) {
      assert.equal(wakeRequest.terminalStatus, 'failed-closed');
      assert.deepEqual(wakeRequest.terminalResponsibility, { kind: 'project', id: projectId });
      assert.match(wakeRequest.terminalReason ?? '', /Project.*archived/i);
      assert.match(wakeRequest.failureReason ?? '', /Project.*archived/i);
      assert.ok(wakeRequest.terminalTimestamp);
    }
    stateManager.openInspector('routing', preExistingSettled.id);
    const settledSheetEvidence = dom.window.document.querySelector('.inspector-sheet')?.textContent ?? '';
    assert.match(settledSheetEvidence, /batch-pre-existing-settled-stale-wakes/);
    const settledSheetStatuses = Array.from(dom.window.document.querySelectorAll('.inspector-sheet .status-pill')).map(
      (element) => element.textContent?.trim()
    );
    assert.equal(
      settledSheetStatuses.some((status) => ['admitted', 'evaluating', 'pending', 'waiting_capacity'].includes(status ?? '')),
      false,
      'Settled-parent archive evidence exposes terminal WakeRequest statuses only'
    );

    stateManager.openInspector('routing', preExistingEvaluating.id);
    const sheetEvidence = dom.window.document.querySelector('.inspector-sheet')?.textContent ?? '';
    assert.match(sheetEvidence, /batch-pre-existing-evaluating/);
    const sheetStatuses = Array.from(dom.window.document.querySelectorAll('.inspector-sheet .status-pill')).map(
      (element) => element.textContent?.trim()
    );
    assert.equal(
      sheetStatuses.some((status) => ['admitted', 'evaluating', 'pending', 'waiting_capacity'].includes(status ?? '')),
      false,
      'Archived Project inspector exposes terminal statuses only'
    );
    assert.match(sheetEvidence, /Responsible project.*proj-docs-portal/i);

    const { renderRoutingInspectorModal } = (await vite.ssrLoadModule(
      '/src/prototype/views/chat-view.ts'
    )) as typeof import('./views/chat-view.js');
    renderRoutingInspectorModal(appMount, stateManager.getSnapshot(), preExistingEvaluating.id);
    const chatInspectorEvidence = dom.window.document.querySelector('.proto-modal-dialog')?.textContent ?? '';
    assert.match(chatInspectorEvidence, /batch-pre-existing-evaluating/);
    const chatInspectorStatuses = Array.from(
      dom.window.document.querySelectorAll('.proto-modal-dialog .status-pill')
    ).map((element) => element.textContent?.trim());
    assert.equal(
      chatInspectorStatuses.some((status) => ['admitted', 'evaluating', 'pending', 'waiting_capacity'].includes(status ?? '')),
      false,
      'Chat routing history exposes terminal statuses only for the archived Project'
    );
    assert.match(chatInspectorEvidence, /Responsible project.*proj-docs-portal/i);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(stateManager.getSnapshot().messages.length, beforeWake + 1, 'Cancelled wake batch emits no reply');
    assert.equal(batch.status, 'failed-closed', 'Terminal batch cannot silently replay after its timer window');
    const { renderRoutingInspectorModal: renderSettledRoutingInspectorModal } = (await vite.ssrLoadModule(
      '/src/prototype/views/chat-view.ts'
    )) as typeof import('./views/chat-view.js');
    renderSettledRoutingInspectorModal(appMount, stateManager.getSnapshot(), preExistingSettled.id);
    const settledChatEvidence = Array.from(dom.window.document.querySelectorAll('.proto-modal-dialog'))
      .at(-1)?.textContent ?? '';
    assert.match(settledChatEvidence, /batch-pre-existing-settled-stale-wakes/);
    const settledChatStatuses = Array.from(
      Array.from(dom.window.document.querySelectorAll('.proto-modal-dialog')).at(-1)?.querySelectorAll('.status-pill') ?? []
    ).map((element) => element.textContent?.trim());
    assert.equal(
      settledChatStatuses.some((status) => ['admitted', 'evaluating', 'pending', 'waiting_capacity'].includes(status ?? '')),
      false,
      'Settled-parent chat evidence exposes terminal WakeRequest statuses only'
    );
  } finally {
    await cleanup();
  }
});
