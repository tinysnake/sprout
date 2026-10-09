import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../agent/registry.ts';
import { EnvironmentPool, InMemoryLeaseStore } from '../environment/pool.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { InMemoryTaskStore } from './store.ts';
import { InMemoryTaskProposalStore } from './proposal-store.ts';
import { TaskProposalService } from './proposal-service.ts';
import { TaskAdmissionError, TaskAdmissionService } from './admission-service.ts';
import { TaskService } from './service.ts';
import type { Task } from './model.ts';
import { TaskAdvanceConflictError, TaskEnvironmentLeaseRefusal, TaskEnvironmentLifecycle, type TaskContextWorker } from './environment-lifecycle.ts';
import type { TaskContextMaterialization } from '../worker/protocol.ts';
import type { TaskStore } from './store.ts';
import type { TaskProposalStore } from './proposal-store.ts';
import type { LeaseStore, EnvironmentLease } from '../environment/pool.ts';
import { SqliteStore } from '../store/db.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionStrategy, type ExecutionStrategy } from '../execution-mode.ts';

const content = {
  title: 'Snapshot task',
  goal: 'Deliver the approved result.',
  constraints: ['Keep the workspace intact.'],
  validationCriteria: ['The result is verified.'],
};

function fixture(options: {
  readonly contextFailure?: boolean;
  readonly submitFailure?: boolean;
  readonly compatible?: (agentId: string, environmentId: string) => boolean;
  readonly agents?: readonly string[];
  readonly taskStore?: TaskStore;
  readonly proposalStore?: TaskProposalStore;
  readonly leaseStore?: LeaseStore;
  readonly executionStrategy?: ExecutionStrategy;
} = {}) {
  const memberIds = options.agents ?? ['scout', 'scribe'];
  const taskStore = options.taskStore ?? new InMemoryTaskStore();
  const proposalStore = options.proposalStore ?? new InMemoryTaskProposalStore();
  const projects = new ProjectRegistry([{
    id: 'project', goal: 'Project goal', rules: [], availableEnvironmentInstanceIds: ['env-a', 'env-b'],
    memberships: memberIds.map(agentId => ({ agentId, responsibilities: [], collaborationInstructions: '' })),
  }]);
  const agents = new AgentRegistry(memberIds.map(id => ({ id, name: id, engine: 'scripted', capability: 'agent-run' })));
  const pool = new EnvironmentPool({
    definitions: [{ id: 'definition', platform: 'container', capabilities: [{ name: 'agent-run', requiresLease: true }] }],
    instances: [{ id: 'env-a', definitionId: 'definition' }, { id: 'env-b', definitionId: 'definition' }],
    store: options.leaseStore ?? new InMemoryLeaseStore(),
    idFactory: () => `lease-${Math.random()}`,
  });
  const materializations: TaskContextMaterialization[] = [];
  const taskGroupSnapshots: Task[] = [];
  const worker: TaskContextWorker = {
    async prepare(input) {
      materializations.push(structuredClone(input));
      if (options.contextFailure) throw new Error('context preparation failed');
      return { bootstrapInstructions: 'Use the approved Task context.' };
    },
    async recycle() {},
  };
  const submissions: { runId?: string; agentId: string; taskId?: string; environmentInstanceId?: string }[] = [];
  const prompts: string[] = [];
  const runner = {
    async submit(request: { runId?: string; agentId: string; taskId?: string; environmentInstanceId?: string; prompt: string; projectId: string }) {
      submissions.push({ agentId: request.agentId, ...(request.runId !== undefined ? { runId: request.runId } : {}), ...(request.taskId !== undefined ? { taskId: request.taskId } : {}), ...(request.environmentInstanceId !== undefined ? { environmentInstanceId: request.environmentInstanceId } : {}) });
      prompts.push(request.prompt);
      if (options.submitFailure) throw new Error('run submission failed');
      return { id: request.runId ?? `unlinked-${submissions.length}` };
    },
    async evaluateOptionAdmission(agentId: string, environmentInstanceId: string) {
      return { ok: options.compatible?.(agentId, environmentInstanceId) ?? true };
    },
  };
  const executionStrategy = options.executionStrategy ?? createExecutionStrategy('environment-hosted');
  const lifecycle = new TaskEnvironmentLifecycle({
    store: taskStore, pool, agents, projects, runs: runner, worker, executionStrategy,
    ids: { task: () => 'unused-task', lease: () => 'unused-lease', run: (() => { let n = 0; return () => `run-${++n};` })(), message: () => 'unused-message', projectEvent: () => 'unused-event' },
    clock: { now: () => 100 },
    taskGroups: {
    sync: async (task) => { taskGroupSnapshots.push(structuredClone(task)); },
    withTaskGroupLock: (_taskId, action) => action(),
  },
  });
  const tasks = new TaskService({ store: taskStore, runs: runner, lifecycle });
  const facts = {
    projectId: 'project', status: 'active' as const, contentVersion: 1, goal: 'Project goal', rules: [],
    members: [
      { memberId: 'operator', memberKind: 'human' as const },
      ...memberIds.map(memberId => ({ memberId, memberKind: 'agent' as const })),
    ],
  };
  let proposalSequence = 0;
  const proposals = new TaskProposalService({
    store: proposalStore,
    projects: { projectFacts: async id => id === 'project' ? facts : undefined },
    agents: { agentIsActive: async id => memberIds.includes(id) },
    now: () => 90,
    id: () => `proposal-${++proposalSequence}`,
  });
  const admissions = new TaskAdmissionService({
    proposals, proposalStore, tasks, lifecycle, projects,
    agentAuthority: { agentIsActive: async id => memberIds.includes(id) },
    ...(options.executionStrategy !== undefined ? { executionStrategy } : {}),
    ids: { task: () => 'task-1', lease: () => 'unused-lease', run: () => 'unused-run', message: () => 'unused-message', projectEvent: () => 'unused-event' },
    now: () => 100,
  });
  return { taskStore, proposalStore, pool, worker, materializations, taskGroupSnapshots, submissions, prompts, tasks, proposals, admissions };
}

async function propose(context: ReturnType<typeof fixture>) {
  return context.proposals.propose('project', { memberId: 'operator', memberKind: 'human' }, content);
}

const beginInput = (lead: { memberId: string; memberKind: 'human' | 'agent' }, environmentInstanceId = 'env-a') => ({
  expectedRevision: 1,
  environmentInstanceId,
  lead,
  reason: 'Approved for the Project milestone.',
});

test('Host-run Task begin reports unavailable before consuming a proposal, preparing context, or acquiring a lease', async () => {
  const context = fixture({ executionStrategy: createExecutionStrategy('host-run') });
  const proposal = await propose(context);
  await assert.rejects(
    context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, beginInput({ memberId: 'operator', memberKind: 'human' })),
    error => error instanceof TaskAdmissionError && error.code === 'execution-mode-unavailable',
  );
  assert.equal((await context.proposals.get(proposal.id)).status, 'proposed');
  assert.deepEqual(context.pool.leases(), []);
  assert.deepEqual(context.materializations, []);
  assert.deepEqual(context.submissions, []);
});

test('a Human lead begins one frozen proposal snapshot without waking an Agent', async () => {
  const context = fixture();
  const proposal = await propose(context);
  const result = await context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, beginInput({ memberId: 'operator', memberKind: 'human' }));
  assert.equal(result.task.environmentLifecycleState, 'idle');
  assert.equal(result.task.environmentInstanceId, 'env-a');
  assert.deepEqual(result.task.admission?.lead, { memberId: 'operator', memberKind: 'human' });
  assert.equal(result.task.admission?.proposalId, proposal.id);
  assert.equal(result.task.admission?.proposalRevision, 1);
  assert.equal(result.task.admission?.contentVersion, 1);
  assert.deepEqual(result.task.admission?.validationCriteria, content.validationCriteria);
  assert.equal(context.taskGroupSnapshots.length, 1);
  assert.equal(context.taskGroupSnapshots[0]?.status, 'in-progress');
  assert.equal(context.taskGroupSnapshots[0]?.id, result.task.id);
  assert.deepEqual(context.taskGroupSnapshots[0]?.admission?.lead, { memberId: 'operator', memberKind: 'human' });
  assert.equal(context.taskGroupSnapshots[0]?.goal, content.goal);
  assert.deepEqual(context.taskGroupSnapshots[0]?.constraints, content.constraints);
  assert.deepEqual(context.submissions, []);
  assert.equal(context.materializations[0]?.taskContentVersion, 1);
  assert.deepEqual(context.materializations[0]?.taskValidationCriteria, content.validationCriteria);
  await assert.rejects(context.tasks.update(result.task.id, { goal: 'Unapproved content change.' }), /content is bound to proposal version 1/);
  assert.equal((await context.tasks.get(result.task.id))?.goal, content.goal);
  assert.equal((await context.proposals.get(proposal.id)).status, 'begun');
  assert.equal(context.pool.activeLease('env-a')?.taskId, result.task.id);
});

test('Task advancement preserves file references and redacts a hostname in the actual composed prompt', async () => {
  const context = fixture();
  const proposal = await propose(context);
  const begun = await context.admissions.beginProposal(
    proposal.id, { memberId: 'operator', memberKind: 'human' }, beginInput({ memberId: 'operator', memberKind: 'human' }),
  );
  const rawPrompt = 'Read report.final.pdf and worker.node1.tailnet.example; Also Read worker.example.md; Read README.md; Read notes/today.txt.';
  await context.admissions.advance(begun.task.id, { memberId: 'operator', memberKind: 'human' }, {
    targetAgentId: 'scout', reason: 'Continue the approved Task.', prompt: rawPrompt,
  });
  const prompt = context.prompts[0] ?? '';

  assert.ok(prompt.includes('report.final.pdf'), 'the unsupported-extension filename reaches the actual composed prompt unchanged');
  assert.ok(prompt.includes('Read report.final.pdf'), 'the explicit file instruction survives prompt composition');
  assert.ok(prompt.includes('README.md'));
  assert.ok(prompt.includes('notes/today.txt'));
  assert.ok(prompt.includes('Read worker.example.md'), 'explicit context preserves an ambiguous host-shaped filename');
  assert.ok(!prompt.includes('worker.node1.tailnet.example'), `hostname leaked in prompt: ${prompt}`);
  assert.ok(prompt.includes('<redacted-host>'));
});

test('approve-and-begin accepts an omitted reason and records no substitute', async () => {
  for (const lead of [
    { memberId: 'operator', memberKind: 'human' as const },
    { memberId: 'scout', memberKind: 'agent' as const },
  ]) {
    const context = fixture();
    const proposal = await propose(context);
    const input = { expectedRevision: 1, environmentInstanceId: 'env-a', lead };
    const first = await context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, input);
    assert.equal(first.task.admission?.approvalReason, undefined);
    const consumed = await context.proposals.get(proposal.id);
    const begun = consumed.lifecycle.find(event => event.action === 'begun');
    assert.ok(begun);
    assert.equal('reason' in begun, false, 'proposal history does not invent an approval reason');
    if (lead.memberKind === 'agent') {
      const run = (await context.tasks.getWithRuns(first.task.id))?.runs[0];
      assert.ok(run);
      assert.equal('reason' in run, false, 'Agent-led initial run has no fabricated approval reason');
    }
    const retry = await context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, input);
    assert.equal(retry.duplicate, true, 'reason-free retries identify the already begun Task');
    assert.equal(retry.task.id, first.task.id);
  }
});

test('failure before lease acquisition leaves the proposal open and creates no Task', async () => {
  const context = fixture({ compatible: (_agent, environment) => environment === 'env-a' });
  const proposal = await propose(context);
  await assert.rejects(
    context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, beginInput({ memberId: 'operator', memberKind: 'human' }, 'env-b')),
    (error: unknown) => error instanceof TaskAdmissionError && error.code === 'no-compatible-agent',
  );
  assert.equal((await context.proposals.get(proposal.id)).status, 'proposed');
  assert.deepEqual(await context.taskStore.list(), []);
  assert.deepEqual(context.pool.leases(), []);
  assert.deepEqual(context.materializations, []);

  const conflicted = fixture();
  const waiting = await propose(conflicted);
  const held = conflicted.pool.acquireLease({ instanceId: 'env-a', capability: 'agent-run', holderId: 'other-work', ttlMs: 1000 });
  assert.equal(held.ok, true);
  await assert.rejects(
    conflicted.admissions.beginProposal(waiting.id, { memberId: 'operator', memberKind: 'human' }, beginInput({ memberId: 'operator', memberKind: 'human' })),
    (error: unknown) => error instanceof TaskAdmissionError && error.code === 'environment-unavailable',
  );
  assert.equal((await conflicted.proposals.get(waiting.id)).status, 'proposed');
  assert.deepEqual(await conflicted.taskStore.list(), []);
  assert.equal(conflicted.pool.activeLease('env-a')?.holderId, 'other-work');
  assert.deepEqual(conflicted.materializations, []);
});

test('Host-run Task admission pins Host-run placement and holds one Task lease across runs', async () => {
  const context = fixture({ executionStrategy: createExecutionStrategy('host-run', true) });
  const proposal = await propose(context);
  const result = await context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, beginInput({ memberId: 'operator', memberKind: 'human' }));
  assert.equal(result.task.executionPlacement?.mode, 'host-run');
  assert.equal(result.task.environmentInstanceId, 'env-a');
  assert.equal(context.pool.leases().length, 1);
  assert.equal(context.pool.getLease(result.task.environmentLeaseId!)?.holderKind, 'task');
  assert.equal(context.submissions.length, 0, 'a Human Task lead does not start a run on approval');
  const advanced = await context.admissions.advance(result.task.id, { memberId: 'operator', memberKind: 'human' }, {
    targetAgentId: 'scout', reason: 'Start the authorized Host-run work.',
  });
  assert.equal(advanced.runId, 'run-1;');
  assert.equal(context.submissions.length, 1);
  assert.equal(context.pool.leases().length, 1, 'nested admission reuses the Task lease');
  assert.equal(context.pool.getLease(result.task.environmentLeaseId!)?.holderKind, 'task');
});

test('begin reports a typed conflict when a Task-held lease is recovering', async () => {
  const context = fixture();
  const proposal = await propose(context);
  const held = context.pool.acquireLease({
    instanceId: 'env-a', capability: 'agent-run', holderId: 'recovering-task', taskId: 'recovering-task', ttlMs: 1000,
  });
  assert.ok(held.ok);
  assert.equal(context.pool.markRecovering(held.lease.id)?.state, 'recovering');

  await assert.rejects(
    context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, beginInput({ memberId: 'operator', memberKind: 'human' })),
    (error: unknown) => error instanceof TaskAdmissionError && error.code === 'environment-recovering',
  );
  assert.equal((await context.proposals.get(proposal.id)).status, 'proposed');
  assert.deepEqual(await context.taskStore.list(), []);
  assert.deepEqual(context.materializations, []);
});

test('legacy begin also exposes typed Task lease reservation refusals', async () => {
  const context = fixture();
  const task = await context.tasks.create({ projectId: 'project', title: 'Legacy Task', goal: 'Begin safely.', assignedAgentId: 'scout' });
  const held = context.pool.acquireLease({
    instanceId: 'env-a', capability: 'agent-run', holderId: 'recovering-task', taskId: 'recovering-task', ttlMs: 1000,
  });
  assert.ok(held.ok);
  assert.equal(context.pool.markRecovering(held.lease.id)?.state, 'recovering');

  await assert.rejects(
    context.tasks.begin(task.id),
    (error: unknown) => error instanceof TaskEnvironmentLeaseRefusal && error.state === 'recovering',
  );
});

test('failure after acquisition preserves approval, the original Environment binding, and recovery', async () => {
  const context = fixture({ contextFailure: true });
  const proposal = await propose(context);
  await assert.rejects(context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, beginInput({ memberId: 'operator', memberKind: 'human' })));
  const consumed = await context.proposals.get(proposal.id);
  assert.equal(consumed.status, 'begun');
  const taskId = consumed.lifecycle.find(event => event.action === 'begun')?.taskId;
  assert.ok(taskId);
  const task = await context.tasks.get(taskId);
  assert.equal(task?.environmentInstanceId, 'env-a');
  assert.equal(task?.environmentLifecycleState, 'recovery');
  assert.equal(task?.admission?.contentVersion, 1);
  assert.equal(context.pool.getLease(task!.environmentLeaseId!)?.state, 'recovering');
  assert.equal(context.pool.activeLease('env-b'), undefined);
});

test('an Agent lead receives one attributed initial run and the active-run fence rejects overlap', async () => {
  const context = fixture();
  const proposal = await propose(context);
  const result = await context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, beginInput({ memberId: 'scout', memberKind: 'agent' }));
  assert.equal(context.submissions.length, 1);
  assert.equal(context.submissions[0]?.agentId, 'scout');
  assert.equal(result.initialRunId, 'run-1;');
  assert.equal(result.task.environmentLifecycleState, 'running');
  const links = (await context.tasks.getWithRuns(result.task.id))!.runs;
  assert.equal(links.length, 1);
  assert.deepEqual(links[0]?.actor, { memberId: 'operator', memberKind: 'human' });
  assert.equal(links[0]?.reason, 'Approved for the Project milestone.');
  assert.equal(links[0]?.agentId, 'scout');
  assert.equal(links[0]?.contentVersion, 1);
  await assert.rejects(context.admissions.advance(result.task.id, { memberId: 'scout', memberKind: 'agent' }, {
    targetAgentId: 'scribe', reason: 'Continue with review.',
  }), /already has an active run/);
  await context.tasks.onRunSettled({ taskId: result.task.id, run: {
    id: result.initialRunId!, agentId: 'scout', prompt: 'Initial Task run', environmentInstanceId: 'env-a',
    projectId: 'project', taskId: result.task.id, status: 'completed', events: [],
    result: { status: 'completed', text: 'First step done.' }, createdAt: 100,
  } });
  const next = await context.admissions.advance(result.task.id, { memberId: 'scout', memberKind: 'agent' }, {
    targetAgentId: 'scribe', reason: 'Review the completed implementation.',
  });
  assert.equal(context.submissions.length, 2);
  assert.equal(next.audit.agentId, 'scribe');
  assert.deepEqual(next.audit.actor, { memberId: 'scout', memberKind: 'agent' });
  assert.equal(next.audit.reason, 'Review the completed implementation.');
  assert.equal(next.audit.contentVersion, 1);
});

test('only a Human or the current Task lead can advance to a currently compatible Project Agent', async () => {
  const context = fixture({ compatible: (agent, environment) => agent === 'scout' && environment === 'env-a' });
  const proposal = await propose(context);
  const result = await context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, beginInput({ memberId: 'operator', memberKind: 'human' }));
  await assert.rejects(context.admissions.advance(result.task.id, { memberId: 'scribe', memberKind: 'agent' }, {
    targetAgentId: 'scout', reason: 'Unauthorized advance.',
  }), (error: unknown) => error instanceof TaskAdmissionError && error.code === 'advance-forbidden');
  await assert.rejects(context.admissions.advance(result.task.id, { memberId: 'operator', memberKind: 'human' }, {
    targetAgentId: 'scribe', reason: 'Target unavailable.',
  }), (error: unknown) => error instanceof TaskAdmissionError && error.code === 'target-ineligible');
  const advanced = await context.admissions.advance(result.task.id, { memberId: 'operator', memberKind: 'human' }, {
    targetAgentId: 'scout', reason: 'Implement the verified next step.',
  });
  assert.equal(advanced.audit.reason, 'Implement the verified next step.');
  assert.equal(advanced.audit.contentVersion, 1);
  assert.equal(advanced.audit.agentId, 'scout');
  assert.deepEqual(advanced.audit.actor, { memberId: 'operator', memberKind: 'human' });
});

test('simultaneous Task-lead advances admit one run and persist one audit record', async () => {
  const context = fixture();
  const proposal = await propose(context);
  const task = await context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, beginInput({ memberId: 'operator', memberKind: 'human' }));
  assert.equal(task.task.environmentLifecycleState, 'idle');
  const actor = { memberId: 'operator', memberKind: 'human' as const };
  const results = await Promise.allSettled([
    context.admissions.advance(task.task.id, actor, { targetAgentId: 'scout', reason: 'First concurrent advance.' }),
    context.admissions.advance(task.task.id, actor, { targetAgentId: 'scribe', reason: 'Second concurrent advance.' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected?.status, 'rejected');
  if (rejected?.status === 'rejected') {
    assert.ok(rejected.reason instanceof TaskAdvanceConflictError);
    assert.equal(rejected.reason.code, 'advance-conflict');
  }
  assert.equal(context.submissions.length, 1);
  assert.equal((await context.tasks.getWithRuns(task.task.id))!.runs.length, 1);
});

test('a failed initial-run outcome survives SQLite restart and a begin retry without resubmitting', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-admission-failure-'));
  const filename = join(directory, 'sprout.db');
  const store = new SqliteStore({ filename });
  try {
    const context = fixture({ taskStore: store.tasks, proposalStore: store.taskProposals, leaseStore: store.leases, submitFailure: true });
    const proposal = await propose(context);
    const actor = { memberId: 'operator', memberKind: 'human' as const };
    const input = beginInput({ memberId: 'scout', memberKind: 'agent' });
    const first = await context.admissions.beginProposal(proposal.id, actor, input);
    assert.equal(first.initialRunFailed, true);
    assert.equal(first.initialRunId, undefined);
    assert.equal(context.submissions.length, 1);
    store.close();

    const reopened = new SqliteStore({ filename });
    try {
      const retryContext = fixture({ taskStore: reopened.tasks, proposalStore: reopened.taskProposals, leaseStore: reopened.leases });
      const persisted = await reopened.tasks.get(first.task.id);
      assert.equal(persisted?.admission?.initialRunFailed, true);
      assert.equal(reopened.leases.get(persisted!.environmentLeaseId!)?.state, 'recovering');
      const retry = await retryContext.admissions.beginProposal(proposal.id, actor, input);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.task.id, first.task.id);
      assert.equal(retry.initialRunFailed, true);
      assert.equal(retry.initialRunId, undefined);
      assert.equal(retryContext.submissions.length, 0);
    } finally { reopened.close(); }
  } finally {
    try { store.close(); } catch { /* closed before reopening */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a retried begin returns the already-bound Task without another lease or initial run', async () => {
  const context = fixture();
  const proposal = await propose(context);
  const actor = { memberId: 'operator', memberKind: 'human' as const };
  const input = beginInput({ memberId: 'scout', memberKind: 'agent' });
  const first = await context.admissions.beginProposal(proposal.id, actor, input);
  const retry = await context.admissions.beginProposal(proposal.id, actor, input);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.task.id, first.task.id);
  assert.equal(retry.initialRunId, first.initialRunId);
  assert.equal(retry.initialRunFailed, undefined);
  assert.equal(context.submissions.length, 1);
  assert.equal(context.pool.leases().filter(lease => lease.state === 'active').length, 1);
});

test('SQLite restart preserves the consumed proposal snapshot and rolls back a partial cross-domain begin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-admission-'));
  const filename = join(directory, 'sprout.db');
  const store = new SqliteStore({ filename });
  try {
    const context = fixture({ taskStore: store.tasks, proposalStore: store.taskProposals, leaseStore: store.leases });
    const proposal = await propose(context);
    const result = await context.admissions.beginProposal(proposal.id, { memberId: 'operator', memberKind: 'human' }, {
      expectedRevision: 1, environmentInstanceId: 'env-a', lead: { memberId: 'scout', memberKind: 'agent' },
    });
    const rollbackProposal = await context.proposals.propose('project', { memberId: 'operator', memberKind: 'human' }, content);
    const rollbackTask = {
      id: 'rollback-task', projectId: 'project', title: content.title, goal: content.goal,
      constraints: content.constraints, status: 'in-progress' as const, environmentInstanceId: 'env-b',
      environmentLeaseId: 'rollback-lease', environmentLifecycleState: 'beginning' as const,
      createdAt: 101, updatedAt: 101,
    };
    const rollbackLease: EnvironmentLease = {
      id: 'rollback-lease', instanceId: 'env-b', capability: 'agent-run', holderId: rollbackTask.id,
      holderKind: 'task', taskId: rollbackTask.id, acquiredAt: 101, expiresAt: 1000, state: 'active',
    };
    await assert.rejects(store.tasks.createBeginningWithLease(rollbackTask, rollbackLease, () => {
      store.taskProposals.consumeForBegin(rollbackProposal.id, 1, {
        actor: { memberId: 'operator', memberKind: 'human' }, at: 101, reason: 'Rollback probe', taskId: rollbackTask.id,
      });
      throw new Error('abort enclosing begin transaction');
    }), /abort enclosing begin transaction/);
    assert.equal((await context.proposals.get(rollbackProposal.id)).status, 'proposed');
    assert.equal(await store.tasks.get(rollbackTask.id), undefined);
    assert.equal(store.leases.get(rollbackLease.id), undefined);
    store.close();

    const reopened = new SqliteStore({ filename });
    try {
      assert.equal((await reopened.taskProposals.get(proposal.id))?.status, 'begun');
      const storedProposal = await reopened.taskProposals.get(proposal.id);
      const begun = storedProposal?.lifecycle.find(event => event.action === 'begun');
      assert.ok(begun);
      assert.equal('reason' in begun, false, 'SQLite proposal history preserves the absent approval reason');
      const task = await reopened.tasks.get(result.task.id);
      assert.equal(task?.admission?.proposalRevision, 1);
      assert.equal(task?.admission?.contentVersion, 1);
      assert.equal(task?.admission?.approvalReason, undefined);
      assert.deepEqual(task?.admission?.validationCriteria, content.validationCriteria);
      assert.equal(reopened.leases.get(task!.environmentLeaseId!)?.state, 'active');
      const links = (await reopened.tasks.getWithRuns(result.task.id))!.runs;
      assert.equal(links.length, 1);
      assert.equal(links[0]?.contentVersion, 1);
      assert.equal('reason' in links[0]!, false, 'SQLite run history stores no substitute reason');
      assert.deepEqual(links[0]?.actor, { memberId: 'operator', memberKind: 'human' });
    } finally { reopened.close(); }
  } finally {
    try { store.close(); } catch { /* closed before reopening */ }
    rmSync(directory, { recursive: true, force: true });
  }
});
