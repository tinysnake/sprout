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
import type { Task, TaskActor } from './model.ts';

const definition: EnvironmentDefinition = { id: 'local', platform: 'macos', capabilities: [{ name: 'agent-run', requiresLease: true }] };
const instance: EnvironmentInstance = { id: 'local-1', definitionId: 'local' };
const human: TaskActor = { memberId: 'operator', memberKind: 'human' };
const lead: TaskActor = { memberId: 'pi', memberKind: 'agent' };

function run(id: string, status: AgentRun['status']): AgentRun {
  return { id, agentId: 'pi', prompt: 'continue', environmentInstanceId: 'local-1', projectId: 'project', taskId: 'task-1', leaseId: 'lease-1', status, events: [], createdAt: 1,
    ...(status === 'failed' ? { failure: 'engine failed' } : {}),
    ...(status !== 'queued' && status !== 'running' ? { completedAt: 2 } : {}) };
}

async function scenario(options: { readonly worker?: TaskContextWorker } = {}) {
  const store = new InMemoryTaskStore();
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance], idFactory: () => 'lease-1' });
  const agents = new AgentRegistry([{ id: 'pi', name: 'Pi', engine: 'scripted', capability: 'agent-run' }]);
  const projects = new ProjectRegistry([{ id: 'project', goal: 'Goal', rules: [], availableEnvironmentInstanceIds: ['local-1'], memberships: [{ agentId: 'pi', responsibilities: [], collaborationInstructions: '' }] }]);
  let lifecycle!: TaskEnvironmentLifecycle;
  const task = (): Task => ({
    id: 'task-1', projectId: 'project', title: 'Task', goal: 'Goal', constraints: [], status: 'todo', assignedAgentId: 'pi',
    admission: { proposalId: 'proposal', proposalRevision: 1, contentVersion: 1, validationCriteria: ['tests pass'], lead, contextAgentId: 'pi', approvedBy: human, approvedAt: 1, approvalReason: 'approved' },
    createdAt: 1, updatedAt: 1,
  });
  lifecycle = new TaskEnvironmentLifecycle({
    store, pool, agents, projects,
    ...(options.worker !== undefined ? { worker: options.worker } : {}),
    ids: { task: () => 'task', message: () => 'message', projectEvent: () => 'event', lease: () => 'lease-1', run: () => 'run-1' },
    runs: { submit: async request => ({ id: request.runId }) },
    forceReleaseLease: leaseId => pool.releaseTaskLease(leaseId) !== undefined,
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
    runs: { stop: async runId => { const stopped = run(runId, 'stopped'); await tasks.onRunSettled({ taskId: 'task-1', run: stopped }); return stopped; } },
    now: () => 50, id: () => 'claim-1',
  });
  await store.create(task());
  const begun = await lifecycle.begin('task-1');
  return { store, pool, lifecycle, tasks, controls, begun };
}

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

test('a failed nested run blocks unfinished Task work instead of making the Task terminal', async () => {
  const s = await scenario();
  const advance = await s.lifecycle.advanceRun('task-1', 'pi', 'work', { actor: lead, reason: 'step', contentVersion: 1 });
  await s.tasks.onRunSettled({ taskId: 'task-1', run: run(advance.runId, 'failed') });
  const blocked = await s.tasks.get('task-1');
  assert.equal(blocked?.status, 'blocked');
  assert.equal(blocked?.environmentLifecycleState, 'blocked');
  assert.equal(blocked?.completedAt, undefined);
  assert.equal(s.pool.getLease(s.begun.environmentLeaseId!)?.state, 'active');
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

test('Force Release records cancellation disposition without claiming normal context cleanup', async () => {
  const s = await scenario();
  await s.lifecycle.workerChannelLost('task-1');
  const leaseId = s.begun.environmentLeaseId!;
  const affected = await s.lifecycle.forceRelease('task-1', {
    actor: 'operator', reason: 'unrecoverable Worker proof', unresolvedFacts: ['context recycle not proved'], at: 50,
  });
  const forced = await s.tasks.get('task-1');
  assert.deepEqual(affected, []);
  assert.equal(forced?.status, 'cancelled');
  assert.equal(forced?.environmentLifecycleState, 'discarded');
  assert.equal(forced?.endDisposition, 'cancelled');
  assert.equal(s.pool.getLease(leaseId)?.state, 'released');
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
