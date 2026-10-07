import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import type { AgentRun } from '../run/model.ts';
import { ProjectRegistry } from '../project/registry.ts';
import type { TaskProposalService } from './proposal-service.ts';
import { TaskEnvironmentLifecycle, type TaskContextWorker } from './environment-lifecycle.ts';
import { InMemoryTaskStore } from './store.ts';
import { TaskService } from './service.ts';
import { TaskControlService } from './control-service.ts';
import { isEndedTaskStatus, TASK_STATUSES, type Task, type TaskActor } from './model.ts';
import { toTaskView } from '../web/views.ts';

const definition: EnvironmentDefinition = { id: 'local', platform: 'macos', capabilities: [{ name: 'agent-run', requiresLease: true }] };
const instance: EnvironmentInstance = { id: 'local-1', definitionId: 'local' };
const human: TaskActor = { memberId: 'operator', memberKind: 'human' };
const lead: TaskActor = { memberId: 'pi', memberKind: 'agent' };

function run(id: string, status: AgentRun['status']): AgentRun {
  return { id, agentId: 'pi', prompt: 'continue', environmentInstanceId: 'local-1', projectId: 'project', taskId: 'task-1', leaseId: 'lease-1', status, events: [], createdAt: 1,
    ...(status === 'failed' ? { failure: 'engine failed' } : {}),
    ...(status !== 'queued' && status !== 'running' ? { completedAt: 2 } : {}) };
}

async function scenario(options: { readonly worker?: TaskContextWorker; readonly forceRelease?: boolean; readonly taskLead?: TaskActor; readonly taskGroupSnapshots?: Task[]; readonly taskGroupEvents?: string[]; readonly taskId?: string } = {}) {
  const taskId = options.taskId ?? 'task-1';
  const store = new InMemoryTaskStore();
  let nextLease = 0;
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance], idFactory: () => `lease-${++nextLease}` });
  const agents = new AgentRegistry([{ id: 'pi', name: 'Pi', engine: 'scripted', capability: 'agent-run' }]);
  const projects = new ProjectRegistry([{ id: 'project', goal: 'Goal', rules: [], availableEnvironmentInstanceIds: ['local-1'], memberships: [{ agentId: 'pi', responsibilities: [], collaborationInstructions: '' }] }]);
  let lifecycle!: TaskEnvironmentLifecycle;
  let nextRun = 0;
  const submittedRuns: string[] = [];
  const task = (): Task => ({
    id: taskId, projectId: 'project', title: 'Task', goal: 'Goal', constraints: [], status: 'todo', assignedAgentId: 'pi',
    admission: { proposalId: 'proposal', proposalRevision: 1, contentVersion: 1, validationCriteria: ['tests pass'], lead: options.taskLead ?? lead, contextAgentId: 'pi', approvedBy: human, approvedAt: 1, approvalReason: 'approved' },
    createdAt: 1, updatedAt: 1,
  });
  lifecycle = new TaskEnvironmentLifecycle({
    store, pool, agents, projects,
    ...(options.worker !== undefined ? { worker: options.worker } : {}),
    ids: { task: () => 'task', message: () => 'message', projectEvent: () => 'event', lease: () => 'lease-1', run: () => `run-${++nextRun}` },
    runs: { submit: async request => { submittedRuns.push(request.runId); return { id: request.runId }; } },
    ...((options.taskGroupSnapshots !== undefined || options.taskGroupEvents !== undefined) ? { taskGroups: {
      sync: async (value: Task) => {
        options.taskGroupSnapshots?.push(structuredClone(value));
        options.taskGroupEvents?.push('group-sync');
      },
      withTaskGroupLock: async <T>(_taskId: string, action: () => Promise<T>) => {
        options.taskGroupEvents?.push('lock-enter');
        try { return await action(); }
        finally { options.taskGroupEvents?.push('lock-exit'); }
      },
    } } : {}),
    ...(options.forceRelease === false ? {} : { forceReleaseLease: (leaseId: string) => pool.releaseTaskLease(leaseId) !== undefined }),
  });
  const tasks = new TaskService({ store, lifecycle, runs: { submit: async () => ({ id: 'unused' }) } });
  const proposals = {
    humanAuthority: async () => human,
    authorizeActor: async (_projectId: string, actor: TaskActor) => {
      if (!['operator', 'pi', 'other-agent'].includes(actor.memberId)) throw new Error('not a member');
      return actor;
    },
  } as unknown as TaskProposalService;
  const controls = new TaskControlService({
    tasks, lifecycle, proposals,
    runs: { stop: async runId => { const stopped = run(runId, 'stopped'); await tasks.onRunSettled({ taskId, run: { ...stopped, taskId } }); return stopped; } },
    now: () => 50, id: () => 'claim-1',
  });
  await store.create(task());
  const begun = await lifecycle.begin(taskId);
  return { store, pool, lifecycle, tasks, controls, begun, taskId, submittedRuns };
}

test('admitted Task groups synchronize at start and freeze after terminal persistence', async () => {
  const taskGroupEvents: string[] = [];
  const taskGroupSnapshots: Task[] = [];
  const s = await scenario({ taskGroupSnapshots, taskGroupEvents });
  assert.equal(taskGroupSnapshots.length, 1);
  assert.equal(taskGroupSnapshots[0]?.status, 'in-progress');
  assert.deepEqual(taskGroupSnapshots[0]?.admission?.lead, lead);

  taskGroupEvents.length = 0;
  const saveTerminalWithLease = s.store.saveTerminalWithLease.bind(s.store);
  s.store.saveTerminalWithLease = async (task, leaseId) => {
    taskGroupEvents.push('terminal-save');
    await saveTerminalWithLease(task, leaseId);
  };
  const cancelled = await s.controls.discardForHuman('task-1', { reason: 'Task work is cancelled.' });
  assert.deepEqual(taskGroupEvents, ['lock-enter', 'terminal-save', 'group-sync', 'lock-exit']);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(taskGroupSnapshots.length, 2);
  assert.equal(taskGroupSnapshots[1]?.status, 'cancelled');
});

test('terminal Tasks reject blocker mutations with a product-owned terminal-state reason', async () => {
  const blocker = {
    reason: 'Approval is pending', requiredAction: 'Record approval',
    responsible: { kind: 'external-condition' as const, condition: 'Approval arrives' }, nextAdvancer: lead,
  };
  const cleared = await scenario();
  const blocked = await cleared.controls.raiseBlocker('task-1', lead, blocker);
  await cleared.store.save({ ...blocked, status: 'cancelled', environmentLifecycleState: 'discarded' });
  await assert.rejects(cleared.controls.clearBlockerForHuman('task-1', { reason: 'The blocker is historical' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, 'terminal-task');
    assert.equal(error.message, 'This Task is cancelled; its blocker is historical.');
    return true;
  });

  const raised = await scenario();
  await raised.store.save({ ...(await raised.tasks.get('task-1'))!, status: 'cancelled', environmentLifecycleState: 'discarded' });
  await assert.rejects(raised.controls.raiseBlocker('task-1', lead, blocker), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, 'terminal-task');
    assert.equal(error.message, 'This Task is cancelled; terminal Tasks cannot record blockers.');
    return true;
  });
});

test('terminal completion retains prior pause state, so the browser must gate Resume by terminal status', async () => {
  const taskGroupSnapshots: Task[] = [];
  const s = await scenario({ taskGroupSnapshots });
  await s.controls.pauseForHuman('task-1', { reason: 'Hold future Task runs during final review' });
  await s.controls.submitCompletionClaim('task-1', lead, {
    outcomeSummary: 'The approved work is complete', validationEvidence: ['Completion criteria passed'],
    durableChanges: [], limitations: [], recommendedDisposition: 'complete',
  });
  const completed = await s.controls.validateForHuman('task-1', {
    claimId: 'claim-1', decision: 'accept', reason: 'The evidence satisfies the acceptance criteria',
  });
  assert.equal(completed.status, 'done');
  assert.equal(completed.environmentLifecycleState, 'ended');
  assert.equal(completed.pauseState, 'paused');
  assert.equal(taskGroupSnapshots.at(-1)?.status, 'done');
});

test('Human may submit a marked substitute claim for an Agent-led Task while other Agents remain rejected', async () => {
  const s = await scenario();
  const claimInput = {
    outcomeSummary: 'The approved work is complete', validationEvidence: ['Completion criteria passed'],
    durableChanges: ['The deliverable is present'], limitations: [], recommendedDisposition: 'complete' as const,
  };

  await assert.rejects(
    s.controls.submitCompletionClaim('task-1', { memberId: 'other-agent', memberKind: 'agent' }, claimInput),
    /Task lead authority is required/,
  );
  const pending = await s.controls.submitCompletionClaimForHuman('task-1', claimInput);
  const claim = pending.completionClaims?.[0];
  assert.equal(pending.environmentLifecycleState, 'awaiting-validation');
  assert.deepEqual(claim?.actor, human);
  assert.deepEqual(claim?.substitutedFor, lead);
  assert.equal(pending.pendingCompletionClaimId, 'claim-1');
  assert.deepEqual(pending.controlHistory?.at(-1), {
    action: 'completion-claimed', actor: human, at: 50, claimId: 'claim-1', substitutedFor: lead,
  });

  const completed = await s.controls.validateForHuman('task-1', {
    claimId: 'claim-1', decision: 'accept', reason: 'The evidence satisfies the acceptance criteria',
  });
  assert.equal(completed.status, 'done');
  assert.equal(completed.endDisposition, 'completed');
  assert.equal(completed.environmentLifecycleState, 'ended');
});

test('lower lifecycle and service seams reject Agent escalation into Human Task controls', async () => {
  const s = await scenario();
  for (const attempt of [
    () => s.lifecycle.reviseContent('task-1', lead, { expectedContentVersion: 1, content: { title: 'Stolen task', goal: 'Stolen goal', constraints: [], validationCriteria: ['none'], lead }, reason: 'steal content authority' }),
    () => s.lifecycle.requestPause('task-1', lead, 'spoof pause'),
    () => s.lifecycle.cancelPauseRetryForHuman('task-1', lead, 'spoof cancellation'),
    () => s.lifecycle.resumePause('task-1', lead, 'spoof resume'),
    () => s.lifecycle.clearBlocker('task-1', lead, 'spoof correction'),
    () => s.lifecycle.validateCompletionClaim('task-1', lead, { claimId: 'claim-1', decision: 'accept', reason: 'self approve' }),
    () => s.lifecycle.discardForHuman('task-1', lead, 'spoof discard'),
    () => s.lifecycle.recoverForHuman('task-1', 'discard', lead, 'spoof recovery'),
    () => s.lifecycle.recordInterruptRequest('task-1', lead, 'spoof interrupt'),
    () => s.lifecycle.forceRelease('task-1', { actor: 'pi', reason: 'steal release', unresolvedFacts: ['not checked'], at: 50 }),
    () => s.tasks.end('task-1'),
    () => s.tasks.advanceWithAttribution('task-1', { agentId: 'pi', actor: { memberId: 'other-agent', memberKind: 'agent' }, reason: 'steal advance', contentVersion: 1 }),
  ]) await assert.rejects(attempt, /authority|Human|accepted|authorized/i);
  assert.equal((await s.tasks.get('task-1'))?.environmentLifecycleState, 'idle');
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
  await s.lifecycle.workerChannelLost('task-1');
  await assert.rejects(s.tasks.recover('task-1', 'discard'), /authority|Human/i);
  assert.equal((await s.tasks.get('task-1'))?.environmentLifecycleState, 'recovery');
});

test('Pause blocks admission, Interrupt settles the active run as stopped, and the Task lease remains held', async () => {
  const s = await scenario();
  await s.lifecycle.advanceRun('task-1', 'pi', 'continue', { actor: lead, reason: 'bounded step', contentVersion: 1 });
  const pause = await s.controls.pauseForHuman('task-1', { reason: 'wait for inspection' });
  assert.equal(pause.pauseState, 'requested');
  const paused = await s.controls.interruptForHuman('task-1', { reason: 'settle now' });
  assert.equal(paused.pauseState, 'paused');
  assert.equal(paused.environmentLifecycleState, 'idle');
  assert.equal((await s.tasks.getWithRuns('task-1'))?.runs[0]?.summary?.status, 'stopped');
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
  await assert.rejects(s.lifecycle.advanceRun('task-1', 'pi', 'not admitted', { actor: lead, reason: 'next', contentVersion: 1 }), /paused/i);
  await s.controls.resumeForHuman('task-1', { reason: 'resume deliberately' });
  assert.equal((await s.tasks.get('task-1'))?.pauseState, undefined);
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
});

test('natural settlement racing Human Pause preserves the admission hold and current content', async () => {
  const s = await scenario();
  const advanced = await s.lifecycle.advanceRun('task-1', 'pi', 'work', { actor: lead, reason: 'step', contentVersion: 1 });
  await Promise.all([
    s.controls.pauseForHuman('task-1', { reason: 'hold the next step' }),
    s.tasks.onRunSettled({ taskId: 'task-1', run: run(advanced.runId, 'completed') }),
  ]);
  assert.equal((await s.tasks.get('task-1'))?.pauseState, 'paused');
  await assert.rejects(s.lifecycle.advanceRun('task-1', 'pi', 'no replay', { actor: lead, reason: 'next', contentVersion: 1 }), /paused/);
});

test('a failed nested run blocks unfinished Task work instead of making the Task terminal', async () => {
  const s = await scenario();
  const advance = await s.lifecycle.advanceRun('task-1', 'pi', 'work', { actor: lead, reason: 'step', contentVersion: 1 });
  await s.tasks.onRunSettled({ taskId: 'task-1', run: run(advance.runId, 'failed') });
  const blocked = await s.tasks.get('task-1');
  assert.equal(blocked?.status, 'blocked');
  assert.equal(blocked?.environmentLifecycleState, 'blocked');
  assert.equal(blocked?.completedAt, undefined);
  assert.equal(blocked?.blocker?.responsible.kind, 'human');
  assert.match(blocked?.blocker?.requiredAction ?? '', /inspect/i);
  assert.deepEqual(blocked?.blocker?.nextAdvancer, lead);
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
});

test('unexpected settlement racing Pause retains the Human hold through recovery', async () => {
  const s = await scenario();
  const advanced = await s.lifecycle.advanceRun('task-1', 'pi', 'work', { actor: lead, reason: 'step', contentVersion: 1 });
  const get = s.store.get.bind(s.store);
  let releaseRead!: () => void;
  let readCaptured!: () => void;
  const delayed = new Promise<void>(resolve => { releaseRead = resolve; });
  const captured = new Promise<void>(resolve => { readCaptured = resolve; });
  s.store.get = async id => {
    const snapshot = await get(id);
    s.store.get = get;
    readCaptured();
    await delayed;
    return snapshot;
  };
  const interrupted = s.lifecycle.settleRun('task-1', run(advanced.runId, 'interrupted'));
  await captured;
  await s.controls.pauseForHuman('task-1', { reason: 'hold admission' });
  releaseRead();
  await interrupted;
  assert.equal((await s.tasks.get('task-1'))?.pauseState, 'requested');
  const recovered = await s.controls.recoverForHuman('task-1', { action: 'resume', reason: 'inspect retained work' });
  assert.equal(recovered.pauseState, 'paused');
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
});

test('failure diagnostics remain bounded summaries rather than leaking into Task blockers', async () => {
  const s = await scenario();
  const advanced = await s.lifecycle.advanceRun('task-1', 'pi', 'work', { actor: lead, reason: 'step', contentVersion: 1 });
  const diagnostic = 'untrusted diagnostic '.repeat(1000);
  await s.tasks.onRunSettled({ taskId: 'task-1', run: { ...run(advanced.runId, 'failed'), failure: diagnostic } });
  const current = (await s.tasks.getWithRuns('task-1'))!;
  assert.ok(current.runs[0]!.summary!.summary.length <= 4000);
  assert.doesNotMatch(current.task.blockerReason ?? '', /untrusted diagnostic/);
});

test('unexpected interruption during a pause request recovers into paused state without replay', async () => {
  const s = await scenario();
  const advance = await s.lifecycle.advanceRun('task-1', 'pi', 'continue', { actor: lead, reason: 'bounded step', contentVersion: 1 });
  await s.controls.pauseForHuman('task-1', { reason: 'pause after settlement' });
  await s.lifecycle.workerChannelLost('task-1');
  const recovered = await s.controls.recoverForHuman('task-1', { action: 'resume', reason: 'Worker inspected' });
  assert.equal(recovered.environmentLifecycleState, 'blocked');
  assert.equal(recovered.pauseState, 'paused');
  assert.equal(recovered.activeRunId, undefined);
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
  await assert.rejects(s.lifecycle.advanceRun('task-1', 'pi', 'must remain paused', { actor: lead, reason: 'next', contentVersion: 1 }), /paused/i);
  assert.equal((await s.tasks.getWithRuns('task-1'))?.runs[0]?.runId, advance.runId, 'recovery never creates a replacement run');
});

test('an authenticated Human Task lead can stop its own subordinate run, while another lead cannot borrow the browser stop', async () => {
  const own = await scenario({ taskLead: human });
  const advance = await own.lifecycle.advanceRun('task-1', 'pi', 'Human lead delegated work', {
    actor: human, reason: 'delegate a bounded run', contentVersion: 1,
  });
  const stopped = await own.controls.stopSubordinateForHumanLead('task-1', { runId: advance.runId, reason: 'stop the delegated run' });
  assert.equal(stopped.environmentLifecycleState, 'idle');
  assert.equal((await own.tasks.getWithRuns('task-1'))?.runs[0]?.summary?.status, 'stopped');
  assert.equal(own.pool.getLease(own.begun.environmentLeaseId!)?.state, 'active');

  const other = await scenario();
  const humanAdvance = await other.lifecycle.advanceRun('task-1', 'pi', 'Human initiated work', {
    actor: human, reason: 'operator step', contentVersion: 1,
  });
  await assert.rejects(other.controls.stopSubordinateForHumanLead('task-1', { runId: humanAdvance.runId, reason: 'borrow Agent lead authority' }), /current Task lead/);
  await assert.rejects(other.controls.stopSubordinateForLead('task-1', lead, { runId: humanAdvance.runId, reason: 'stop a run I did not initiate' }), /only a run they initiated/);
  assert.equal((await other.tasks.get('task-1'))?.activeRunId, humanAdvance.runId);
});

test('Task leads can stop only a subordinate run they initiated without releasing the outer lease', async () => {
  const s = await scenario();
  const advance = await s.lifecycle.advanceRun('task-1', 'pi', 'subordinate work', { actor: lead, reason: 'delegate', contentVersion: 1 });
  const stopped = await s.controls.stopSubordinateForLead('task-1', lead, { runId: advance.runId, reason: 'halt this branch' });
  assert.equal(stopped.environmentLifecycleState, 'idle');
  assert.equal(stopped.pauseState, undefined);
  assert.equal((await s.tasks.getWithRuns('task-1'))?.runs[0]?.summary?.status, 'stopped');
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');

  const other = await scenario();
  const humanAdvance = await other.lifecycle.advanceRun('task-1', 'pi', 'Human initiated', { actor: human, reason: 'operator step', contentVersion: 1 });
  await assert.rejects(other.controls.stopSubordinateForLead('task-1', lead, { runId: humanAdvance.runId, reason: 'steal authority' }), /only a run they initiated/);
  await assert.rejects(other.lifecycle.recordSubordinateStopRequest('task-1', lead, humanAdvance.runId, 'bypass the service'), /initiated|authority/);
  assert.equal((await other.tasks.get('task-1'))?.activeRunId, humanAdvance.runId);
});

test('Task leads can raise routable blockers, but another Agent cannot use that authority', async () => {
  const s = await scenario();
  const blocker = {
    reason: 'Need review', requiredAction: 'Approve the schema change',
    responsible: { kind: 'human', memberId: 'operator' }, nextAdvancer: lead,
  };
  await assert.rejects(s.controls.raiseBlocker('task-1', { memberId: 'other-agent', memberKind: 'agent' }, blocker), /current Task lead/);
  const blocked = await s.controls.raiseBlocker('task-1', lead, blocker);
  assert.deepEqual(blocked.blocker, {
    ...blocker, createdBy: lead, createdAt: 50,
  });
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
  await assert.rejects(s.lifecycle.advanceRun('task-1', 'pi', 'blocked', { actor: lead, reason: 'advance', contentVersion: 1 }), /blocker/);
});

test('Human content revisions preserve active-run and claim versions, then bind the next run to the new version', async () => {
  const s = await scenario();
  const first = await s.lifecycle.advanceRun('task-1', 'pi', 'version one', { actor: lead, reason: 'step', contentVersion: 1 });
  const content = { title: 'Revised task', goal: 'Revised goal', constraints: ['keep work'], validationCriteria: ['new check'], lead };
  const revised = await s.controls.reviseForHuman('task-1', { expectedContentVersion: 1, content, reason: 'clarify acceptance' });
  assert.equal(revised.activeRunId, first.runId);
  assert.equal(revised.admission?.contentVersion, 2);
  assert.equal((await s.tasks.getWithRuns('task-1'))?.runs[0]?.contentVersion, 1);
  await assert.rejects(s.controls.reviseForHuman('task-1', { expectedContentVersion: 1, content, reason: 'stale overwrite' }), /stale/i);
  await s.tasks.onRunSettled({ taskId: 'task-1', run: run(first.runId, 'completed') });
  const claimed = await s.controls.submitCompletionClaim('task-1', lead, {
    outcomeSummary: 'Delivered the prior approved scope', validationEvidence: ['prior check passed'], durableChanges: [], limitations: ['new check pending'], recommendedDisposition: 'continue',
  });
  assert.equal(claimed.completionClaims?.[0]?.contentVersion, 1);
  await s.controls.validateForHuman('task-1', { claimId: 'claim-1', decision: 'correct', reason: 'use revised criteria' });
  const next = await s.tasks.advanceWithAttribution('task-1', { agentId: 'pi', actor: lead, reason: 'new version', contentVersion: 2 });
  assert.equal(next.task.admission?.contentVersion, 2);
  assert.equal((await s.tasks.getWithRuns('task-1'))?.runs[1]?.contentVersion, 2);
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
});

test('Human correction retains the same lease and returns the Task to deliberate advancement', async () => {
  const s = await scenario();
  await s.controls.submitCompletionClaim('task-1', lead, {
    outcomeSummary: 'Ready for review', validationEvidence: ['initial check passed'], durableChanges: [], limitations: ['one issue remains'], recommendedDisposition: 'continue',
  });
  const corrected = await s.controls.validateForHuman('task-1', { claimId: 'claim-1', decision: 'correct', reason: 'address the remaining limitation' });
  assert.equal(corrected.environmentLifecycleState, 'idle');
  assert.equal(corrected.pendingCompletionClaimId, undefined);
  assert.equal(corrected.completionClaims?.length, 1, 'the submitted claim remains in history');
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
  const next = await s.lifecycle.advanceRun('task-1', 'pi', 'continue after correction', { actor: lead, reason: 'correction', contentVersion: 1 });
  assert.equal(next.task.environmentLifecycleState, 'running');
});

test('idle validation recovery preserves the pending claim and Human validation gap', async () => {
  const s = await scenario();
  await s.controls.submitCompletionClaim('task-1', lead, {
    outcomeSummary: 'Delivered', validationEvidence: ['acceptance check passed'], durableChanges: [], limitations: [], recommendedDisposition: 'complete',
  });
  await s.lifecycle.workerChannelLost('task-1');
  const recovered = await s.controls.recoverForHuman('task-1', { action: 'resume', reason: 'context inspected' });
  assert.equal(recovered.environmentLifecycleState, 'awaiting-validation');
  assert.equal(recovered.pendingCompletionClaimId, 'claim-1');
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
  const completed = await s.controls.validateForHuman('task-1', { claimId: 'claim-1', decision: 'accept', reason: 'verified' });
  assert.equal(completed.status, 'done');
});

test('accepted completion recovery preserves its intent even when recovery is submitted as discard', async () => {
  let recycles = 0;
  const worker: TaskContextWorker = {
    prepare: async () => ({ bootstrapInstructions: '' }),
    recycle: async () => { recycles += 1; if (recycles === 1) throw new Error('cleanup unavailable'); },
  };
  const s = await scenario({ worker });
  await s.controls.submitCompletionClaim('task-1', lead, {
    outcomeSummary: 'The Task is complete', validationEvidence: ['acceptance suite passed'], durableChanges: [], limitations: [], recommendedDisposition: 'complete',
  });
  await assert.rejects(s.controls.validateForHuman('task-1', { claimId: 'claim-1', decision: 'accept', reason: 'verified' }), /cleanup unavailable/);
  const recovering = await s.tasks.get('task-1');
  assert.equal(recovering?.environmentLifecycleState, 'recovery');
  assert.equal(recovering?.recoveryState, 'ending');
  assert.equal(recovering?.endDisposition, 'completed');
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'recovering');

  const completed = await s.controls.recoverForHuman('task-1', { action: 'discard', reason: 'retry cleanup' });
  assert.equal(completed.status, 'done');
  assert.equal(completed.environmentLifecycleState, 'ended');
  assert.equal(completed.endDisposition, 'completed');
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'released');
  assert.equal(recycles, 2);
});

test('cancelled Task end recovery retries through the Human recovery Discard command', async () => {
  let recycles = 0;
  const worker: TaskContextWorker = {
    prepare: async () => ({ bootstrapInstructions: '' }),
    recycle: async () => { recycles += 1; if (recycles === 1) throw new Error('cleanup unavailable'); },
  };
  const s = await scenario({ worker });
  await assert.rejects(s.controls.discardForHuman('task-1', { reason: 'discard unfinished Task' }), /cleanup unavailable/);
  const recovering = await s.tasks.get('task-1');
  assert.equal(recovering?.environmentLifecycleState, 'recovery');
  assert.equal(recovering?.recoveryState, 'ending');
  assert.equal(recovering?.endDisposition, 'cancelled');
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'recovering');

  const discarded = await s.controls.recoverForHuman('task-1', { action: 'discard', reason: 'retry cancellation cleanup' });
  assert.equal(discarded.status, 'cancelled');
  assert.equal(discarded.environmentLifecycleState, 'discarded');
  assert.equal(discarded.endDisposition, 'cancelled');
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'released');
  assert.equal(recycles, 2);
});

test('Force Release without a lease-release capability preserves unfinished recovery instead of recording a terminal outcome', async () => {
  const s = await scenario({ forceRelease: false });
  await s.lifecycle.workerChannelLost('task-1');
  await assert.rejects(s.lifecycle.forceRelease('task-1', { actor: 'operator', reason: 'attempt unavailable release', unresolvedFacts: ['cleanup unproved'], at: 50 }), /release.*unavailable|capability/i);
  assert.equal((await s.tasks.get('task-1'))?.environmentLifecycleState, 'recovery');
  assert.equal((await s.tasks.get('task-1'))?.completedAt, undefined);
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'recovering');
});

test('Force Release stops the Task and freezes its group without claiming normal context cleanup', async () => {
  const taskGroupEvents: string[] = [];
  const taskGroupSnapshots: Task[] = [];
  const s = await scenario({ taskGroupEvents, taskGroupSnapshots });
  await s.lifecycle.workerChannelLost('task-1');
  taskGroupEvents.length = 0;
  const saveTerminalWithLease = s.store.saveTerminalWithLease.bind(s.store);
  s.store.saveTerminalWithLease = async (task, leaseId) => {
    taskGroupEvents.push('terminal-save');
    await saveTerminalWithLease(task, leaseId);
  };
  const leaseId = s.begun.environmentLeaseId!;
  const affected = await s.lifecycle.forceRelease('task-1', {
    actor: 'operator', reason: 'unrecoverable Worker proof', unresolvedFacts: ['context recycle not proved'], at: 50,
  });
  const forced = await s.tasks.get('task-1');
  assert.deepEqual(affected, []);
  assert.deepEqual(taskGroupEvents, ['lock-enter', 'terminal-save', 'group-sync', 'lock-exit']);
  assert.equal(forced?.status, 'stopped');
  assert.equal(forced?.environmentLifecycleState, 'discarded');
  assert.equal(forced?.endDisposition, undefined);
  assert.equal(forced?.blockerReason, 'Task stopped by the Human operator using Force Release; unresolved facts recorded.');
  assert.equal(taskGroupSnapshots.at(-1)?.status, 'stopped');
  assert.equal(toTaskView(forced!).taskContextState, 'cleanup-unproved-force-release');
  assert.deepEqual(forced?.forcedRelease?.unresolvedFacts, ['context recycle not proved']);
  assert.equal(s.pool.getLease(leaseId)?.state, 'released');
});

test('Human Resume restores a Force Released Task with a fresh lease and context, preserving its history without starting a run', async () => {
  const taskGroupEvents: string[] = [];
  const taskGroupSnapshots: Task[] = [];
  const preparedTaskIds: string[] = [];
  const preparedEnvironmentIds: string[] = [];
  const worker: TaskContextWorker = {
    prepare: async input => {
      preparedTaskIds.push(input.taskId);
      preparedEnvironmentIds.push(input.environmentInstanceId);
      return { bootstrapInstructions: '' };
    },
    recycle: async () => undefined,
  };
  const s = await scenario({ taskId: 'task-stopped-resume', worker, taskGroupSnapshots, taskGroupEvents });
  await s.lifecycle.workerChannelLost(s.taskId);
  await s.lifecycle.forceRelease(s.taskId, {
    actor: 'operator', reason: 'Release an unresolved Environment lease', unresolvedFacts: ['engine stop not proved'], at: 40,
  });
  const stopped = (await s.tasks.get(s.taskId))!;
  const oldLeaseId = stopped.environmentLeaseId!;
  const historyBefore = stopped.controlHistory;
  const forcedRelease = stopped.forcedRelease;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.blockerReason, 'Task stopped by the Human operator using Force Release; unresolved facts recorded.');
  assert.equal(s.pool.getLease(oldLeaseId)?.state, 'released');

  const resumed = await s.controls.resumeForHuman(s.taskId, { reason: 'Continue the preserved work.' });

  assert.equal(resumed.status, 'in-progress');
  assert.equal(resumed.environmentLifecycleState, 'idle');
  assert.equal(resumed.environmentInstanceId, stopped.environmentInstanceId);
  assert.notEqual(resumed.environmentLeaseId, oldLeaseId);
  assert.equal(s.pool.getLease(resumed.environmentLeaseId!)?.state, 'active');
  assert.equal(s.pool.getLease(oldLeaseId)?.state, 'released');
  assert.equal(resumed.completedAt, undefined);
  assert.equal(resumed.endDisposition, undefined);
  assert.equal(resumed.blockerReason, undefined, 'the Force Release blocker copy is cleared');
  assert.deepEqual(resumed.forcedRelease, forcedRelease, 'permanent Force Release facts remain unchanged');
  assert.deepEqual(resumed.controlHistory?.slice(0, historyBefore?.length ?? 0), historyBefore ?? []);
  const event = resumed.controlHistory?.at(-1);
  assert.equal(event?.action, 'resumed');
  assert.equal(event?.action === 'resumed' ? event.fromStatus : undefined, 'stopped');
  assert.equal(event?.reason, 'Continue the preserved work.');
  assert.equal(resumed.controlHistory?.some(item => item.action === 'reopened'), false);
  assert.deepEqual(preparedTaskIds, [s.taskId, s.taskId], 'the stopped Task receives fresh context');
  assert.deepEqual(preparedEnvironmentIds, ['local-1', 'local-1'], 'the existing Environment binding is reused');
  assert.equal(s.submittedRuns.length, 0, 'Resume never starts a run automatically');
});

test('completion claims accept only the fact-form schema and reject empty or hostile payloads', async () => {
  const s = await scenario();
  const empty = { outcomeSummary: '', validationEvidence: [], durableChanges: [], limitations: [], recommendedDisposition: 'complete' };
  await assert.rejects(s.controls.submitCompletionClaim('task-1', lead, empty), /outcomeSummary|non-empty/);
  const hostile = {
    outcomeSummary: 'Delivered the change', validationEvidence: ['npm test passed'], durableChanges: [], limitations: [],
    recommendedDisposition: 'complete', privateReasoning: 'hidden chain of thought',
  };
  await assert.rejects(s.controls.submitCompletionClaim('task-1', lead, hostile), /only factual/);
  const inherited = Object.assign(Object.create({ privateReasoning: 'inherited content' }) as object, {
    outcomeSummary: 'Delivered', validationEvidence: ['checked'], durableChanges: [], limitations: [], recommendedDisposition: 'complete',
  });
  await assert.rejects(s.controls.submitCompletionClaim('task-1', lead, inherited), /only factual/);
  const claim = await s.controls.submitCompletionClaim('task-1', lead, {
    outcomeSummary: 'Implemented pause and recovery controls', validationEvidence: ['Focused lifecycle contract passed'],
    durableChanges: ['Task control service added'], limitations: ['Human review remains required'], recommendedDisposition: 'complete',
  });
  assert.equal(claim.environmentLifecycleState, 'awaiting-validation');
  assert.equal(claim.pendingCompletionClaimId, 'claim-1');
  assert.deepEqual(claim.completionClaims?.[0]?.validationEvidence, ['Focused lifecycle contract passed']);
  await assert.rejects(s.lifecycle.advanceRun('task-1', 'pi', 'cannot bypass validation', { actor: lead, reason: 'skip', contentVersion: 1 }), /awaiting-validation|validation/i);
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
});

for (const status of TASK_STATUSES.filter(isEndedTaskStatus)) {
  test(`Human reopen follows the same lifecycle for terminal Task status ${status}`, async () => {
    const taskGroupSnapshots: Task[] = [];
    const s = await scenario({ taskGroupSnapshots });
    const ended = await s.controls.discardForHuman(s.taskId, { reason: 'End before the reopen contract test.' });
    const { endDisposition: _oldDisposition, ...withoutDisposition } = ended;
    const priorClaims = [{
      id: 'claim-before-reopen', contentVersion: 1, actor: human, at: 30,
      outcomeSummary: 'Previously reviewed Task work.', validationEvidence: ['Review was recorded.'],
      durableChanges: ['Existing Project files.'], limitations: [], recommendedDisposition: 'continue' as const,
    }];
    const terminal: Task = {
      ...withoutDisposition,
      status,
      environmentLifecycleState: 'discarded',
      completedAt: 41,
      completionClaims: priorClaims,
      ...(status === 'done' ? { endDisposition: 'completed' as const } : {}),
      ...(status === 'cancelled' ? { endDisposition: 'cancelled' as const } : {}),
    };
    await s.store.save(terminal);
    const oldLeaseId = terminal.environmentLeaseId!;
    const historyBefore = terminal.controlHistory;

    const reopened = await s.controls.reopenForHuman(s.taskId, { reason: `Continue the Task after ${status}.` });

    assert.equal(reopened.status, 'in-progress');
    assert.equal(reopened.environmentLifecycleState, 'idle');
    assert.equal(reopened.environmentInstanceId, terminal.environmentInstanceId);
    assert.notEqual(reopened.environmentLeaseId, oldLeaseId, 'reopen acquires a new lease identity');
    assert.equal(s.pool.getLease(oldLeaseId)?.state, 'released');
    assert.equal(s.pool.getLease(reopened.environmentLeaseId!)?.state, 'active');
    assert.equal(reopened.activeRunId, undefined);
    assert.equal(reopened.completedAt, undefined);
    assert.equal(reopened.endDisposition, undefined);
    assert.deepEqual(reopened.controlHistory?.slice(0, historyBefore?.length), historyBefore);
    assert.deepEqual(reopened.completionClaims, priorClaims, 'completion claims remain inspectable after reopen');
    const reopenEvent = reopened.controlHistory?.at(-1);
    assert.ok(reopenEvent?.action === 'reopened');
    assert.deepEqual(reopenEvent.actor, human);
    assert.equal(reopenEvent.reason, `Continue the Task after ${status}.`);
    assert.equal(reopenEvent.fromStatus, status);
    assert.equal(reopenEvent.previousCompletedAt, 41);
    assert.equal(reopenEvent.previousEndDisposition, terminal.endDisposition);
    assert.equal(Number.isSafeInteger(reopenEvent.at), true);
    assert.equal(taskGroupSnapshots.at(-1)?.status, 'in-progress');
    assert.equal(s.submittedRuns.length, 0, 'reopen does not start a run automatically');

    const advance = await s.tasks.advanceWithAttribution(s.taskId, {
      agentId: 'pi', actor: human, reason: 'Deliberately continue reopened work', contentVersion: 1,
    });
    assert.equal(advance.task.activeRunId, advance.runId);
    assert.equal(s.submittedRuns.length, 1, 'the reopened Task admits a new run');
  });
}

test('the stopped incident fixture resumes directly while retaining recovery, run, and Force Release history', async () => {
  const taskId = 'task-muwtqk0e-aff3220b';
  const taskGroupSnapshots: Task[] = [];
  const taskGroupEvents: string[] = [];
  const preparedTaskIds: string[] = [];
  const preparedEnvironmentIds: string[] = [];
  let recycled = 0;
  const worker: TaskContextWorker = {
    prepare: async input => { preparedTaskIds.push(input.taskId); preparedEnvironmentIds.push(input.environmentInstanceId); return { bootstrapInstructions: '' }; },
    recycle: async () => { recycled += 1; },
  };
  const s = await scenario({ taskId, worker, taskGroupSnapshots, taskGroupEvents });
  await s.store.linkRun({ taskId, runId: 'incident-run', agentId: 'pi', now: 10 });
  await s.store.recordRunSummary({ taskId, runId: 'incident-run', agentId: 'pi', status: 'stopped', summary: 'Prior run settlement', recordedAt: 20 });
  await s.lifecycle.workerChannelLost(taskId);
  await s.controls.recoverForHuman(taskId, { action: 'resume', reason: 'Inspect the retained recovery facts.' });
  await s.lifecycle.workerChannelLost(taskId);
  const stoppedIds = await s.lifecycle.forceRelease(taskId, {
    actor: 'operator', reason: 'Unresolved engine stop during recovery',
    unresolvedFacts: ['engineSessionStopped=false', 'recovery proof was unresolved'], at: 60,
  });
  const stopped = (await s.tasks.get(taskId))!;
  const historyBefore = stopped.controlHistory;
  const releaseFacts = stopped.forcedRelease;
  const oldLeaseId = stopped.environmentLeaseId!;
  assert.deepEqual(stoppedIds, ['incident-run']);
  assert.ok(historyBefore?.some((event) => event.action === 'recovery-requested'));
  assert.deepEqual(releaseFacts?.unresolvedFacts, ['engineSessionStopped=false', 'recovery proof was unresolved']);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.environmentLifecycleState, 'discarded');
  assert.equal(recycled, 0, 'Force Release does not claim Task context recycling');

  taskGroupEvents.length = 0;
  const saveBeginningWithLease = s.store.saveBeginningWithLease.bind(s.store);
  s.store.saveBeginningWithLease = async (task, lease) => {
    taskGroupEvents.push('beginning-save');
    await saveBeginningWithLease(task, lease);
  };
  const resumed = await s.controls.resumeForHuman(taskId, { reason: 'Recovery evidence is understood; resume the unfinished intent.' });

  assert.deepEqual(taskGroupEvents, ['lock-enter', 'beginning-save', 'group-sync', 'lock-exit']);
  assert.equal(resumed.status, 'in-progress');
  assert.equal(resumed.environmentLifecycleState, 'idle');
  assert.equal(resumed.environmentInstanceId, stopped.environmentInstanceId);
  assert.notEqual(resumed.environmentLeaseId, oldLeaseId);
  assert.equal(s.pool.getLease(oldLeaseId)?.state, 'released');
  assert.equal(s.pool.getLease(resumed.environmentLeaseId!)?.state, 'active');
  assert.deepEqual(resumed.controlHistory?.slice(0, historyBefore?.length ?? 0), historyBefore ?? []);
  assert.deepEqual(resumed.forcedRelease, releaseFacts);
  assert.equal(resumed.controlHistory?.at(-1)?.action, 'resumed');
  assert.deepEqual((await s.tasks.getWithRuns(taskId))?.runs.map((link) => link.runId), ['incident-run']);
  assert.deepEqual(preparedTaskIds, [taskId, taskId], 'Resume prepares fresh Task context for the same Task');
  assert.deepEqual(preparedEnvironmentIds, ['local-1', 'local-1'], 'both contexts use the same original Environment instance');
  assert.equal(recycled, 0, 'Resume leaves the Project workspace and prior Task history intact');
  assert.equal(s.submittedRuns.length, 0, 'Resume waits for a later deliberate advance');

  const advance = await s.tasks.advanceWithAttribution(taskId, {
    agentId: 'pi', actor: human, reason: 'Continue the incident Task after review.', contentVersion: 1,
  });
  assert.equal(advance.task.activeRunId, advance.runId);
  assert.deepEqual((await s.tasks.getWithRuns(taskId))?.runs.map((link) => link.runId), ['incident-run', advance.runId]);
});

test('a fresh-context failure after reopen enters and recovers through the beginning recovery lifecycle', async () => {
  let preparations = 0;
  const worker: TaskContextWorker = {
    prepare: async () => {
      preparations += 1;
      if (preparations === 2) throw new Error('fresh Task context could not be prepared');
      return { bootstrapInstructions: '' };
    },
    recycle: async () => undefined,
  };
  const s = await scenario({ worker });
  const ended = await s.controls.discardForHuman(s.taskId, { reason: 'End before probing context preparation failure.' });
  const oldLeaseId = ended.environmentLeaseId!;

  await assert.rejects(
    s.controls.reopenForHuman(s.taskId, { reason: 'Reopen and prepare fresh Task context.' }),
    /fresh Task context could not be prepared/,
  );

  const protectedTask = (await s.tasks.get(s.taskId))!;
  const recoveringLeaseId = protectedTask.environmentLeaseId!;
  assert.equal(preparations, 2);
  assert.equal(protectedTask.status, 'in-progress', 'the durable reopen transition remains visible');
  assert.equal(protectedTask.environmentLifecycleState, 'recovery');
  assert.equal(protectedTask.recoveryState, 'beginning');
  assert.equal(protectedTask.controlHistory?.at(-1)?.action, 'reopened');
  assert.notEqual(recoveringLeaseId, oldLeaseId);
  assert.equal(s.pool.getLease(oldLeaseId)?.state, 'released');
  assert.equal(s.pool.getLease(recoveringLeaseId)?.state, 'recovering');
  assert.equal(s.submittedRuns.length, 0, 'preparation failure does not start a run');

  const resumed = await s.controls.recoverForHuman(s.taskId, { action: 'resume', reason: 'Retry beginning preparation.' });
  assert.equal(preparations, 3);
  assert.equal(resumed.status, 'in-progress');
  assert.equal(resumed.environmentLifecycleState, 'idle');
  assert.equal(resumed.recoveryState, undefined);
  assert.equal(s.pool.getLease(recoveringLeaseId)?.state, 'active');
  assert.equal(resumed.controlHistory?.filter((event) => event.action === 'reopened').length, 1);
  assert.equal(resumed.controlHistory?.at(-1)?.action, 'recovery-requested');
  assert.equal(s.submittedRuns.length, 0);
});

test('reopening refuses an original Environment held by another Task without changing terminal history', async () => {
  const s = await scenario();
  const ended = await s.controls.discardForHuman(s.taskId, { reason: 'End before testing Environment contention.' });
  const oldLeaseId = ended.environmentLeaseId!;
  const competing = s.pool.reserveTaskLease({
    instanceId: ended.environmentInstanceId!, capability: 'agent-run', holderId: 'other-task', taskId: 'other-task', ttlMs: 60_000,
  });
  assert.ok(competing.ok);
  s.pool.adoptLease(competing.lease);

  await assert.rejects(s.controls.reopenForHuman(s.taskId, { reason: 'Try to reopen while the Environment is held.' }),
    /environment local-1 is unavailable/);

  const unchanged = (await s.tasks.get(s.taskId))!;
  assert.equal(unchanged.status, 'cancelled');
  assert.equal(unchanged.environmentLifecycleState, 'discarded');
  assert.equal(unchanged.environmentLeaseId, oldLeaseId);
  assert.equal(unchanged.controlHistory?.some((event) => event.action === 'reopened'), false);
  assert.equal(s.pool.getLease(oldLeaseId)?.state, 'released');
  assert.equal(s.pool.getLease(competing.lease.id)?.state, 'active');
});

test('reopen refuses nonterminal, recovering, unbound, and ineligible Tasks without adding history', async () => {
  const refusals: readonly {
    readonly name: string;
    readonly update: (task: Task) => Task;
    readonly reason: RegExp;
  }[] = [
    {
      name: 'nonterminal Task',
      update: task => ({ ...task, status: 'in-progress', environmentLifecycleState: 'idle' }),
      reason: /active intent/,
    },
    {
      name: 'unresolved recovery',
      update: task => ({ ...task, environmentLifecycleState: 'recovery', recoveryState: 'idle' }),
      reason: /active or unresolved Environment work/,
    },
    {
      name: 'missing original Environment binding',
      update: task => {
        const { environmentInstanceId: _environmentInstanceId, ...unbound } = task;
        return unbound;
      },
      reason: /no safely reusable Environment binding/,
    },
    {
      name: 'ineligible context Agent',
      update: task => ({ ...task, admission: { ...task.admission!, contextAgentId: 'missing-agent' } }),
      reason: /cannot prepare its original Environment/,
    },
  ];

  for (const refusal of refusals) {
    const s = await scenario();
    const ended = await s.controls.discardForHuman(s.taskId, { reason: `End before testing ${refusal.name}.` });
    const invalid = refusal.update(ended);
    await s.store.save(invalid);

    await assert.rejects(
      s.controls.reopenForHuman(s.taskId, { reason: `Try to reopen with ${refusal.name}.` }),
      refusal.reason,
    );

    const unchanged = (await s.tasks.get(s.taskId))!;
    assert.equal(unchanged.status, invalid.status, refusal.name);
    assert.equal(unchanged.environmentLifecycleState, invalid.environmentLifecycleState, refusal.name);
    assert.deepEqual(unchanged.controlHistory, invalid.controlHistory, refusal.name);
    assert.equal(unchanged.controlHistory?.some(event => event.action === 'reopened'), false, refusal.name);
  }
});

test('reopen cycles append separate control-history events', async () => {
  const s = await scenario();
  await s.controls.discardForHuman(s.taskId, { reason: 'First end.' });
  await s.controls.reopenForHuman(s.taskId, { reason: 'First reopen.' });
  await s.controls.discardForHuman(s.taskId, { reason: 'Second end.' });
  const second = await s.controls.reopenForHuman(s.taskId, { reason: 'Second reopen.' });
  const reopenEvents = second.controlHistory?.filter((event) => event.action === 'reopened') ?? [];
  assert.deepEqual(reopenEvents.map((event) => event.reason), ['First reopen.', 'Second reopen.']);
  assert.equal(reopenEvents.length, 2, 'each reopen cycle appends a separate event');
});
