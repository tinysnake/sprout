import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCollaborationStore } from './sqlite-store.ts';
import type { CollaborationStore } from './store.ts';
import type { Message } from './model.ts';
import { resolveTaskGroupAmbiguity, TASK_GROUP_MODEL_TIMEOUT_MS, TASK_GROUP_MODEL_MAX_BODY_CHARS, TASK_GROUP_MODEL_MAX_CANDIDATES } from './task-group-wake.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationCoordinator, type CollaborationCoordinatorOptions } from './coordinator.ts';
import { InMemoryCollaborationStore } from './store.ts';
import type { AgentRun } from '../run/model.ts';
import type { TaskGroupScope } from '../conversation/model.ts';
import { TASK_GROUP_IDLE_MS, TASK_GROUP_MAX_AGENT_CHAIN, TASK_GROUP_MAX_MODEL_CALLS, TASK_GROUP_MAX_LEAD_REWAKES, TASK_GROUP_ATTENTION_KIND, type TaskGroupWakeFacts } from './task-group-wake.ts';

function fixture(facts: TaskGroupWakeFacts = { lead: { id: 'lead', kind: 'agent' } }, selection: readonly string[] = [], store: CollaborationStore = new InMemoryCollaborationStore()) {
  let now = 0, calls = 0, writable = true, failAdmissions = false, currentFacts = facts;
  const submissions: string[] = [];
  const states = new Map<string, AgentRun>();
  const scope = { id: 'group', projectId: 'project', kind: 'task-group', taskId: 'task' } as TaskGroupScope;
  const options = {
    store, clock: { now: () => now },
    scopes: {
      getScope: async () => scope,
      scopeState: async () => ({ scopeId: 'group', writable }),
      withTaskGroupLock: async <T>(_id: string, action: () => Promise<T>) => action(),
      projectMembers: async () => ['lead', 'a', 'b'].map(memberId => ({ memberId, memberKind: 'agent' as const })),
    },
    taskGroupFacts: async () => currentFacts,
    taskGroupModel: { select: async () => { calls++; return selection; } },
    runs: {
      submit: async ({ agentId }: { agentId: string }) => {
        if (failAdmissions) throw new Error('admission unavailable');
        const id = `run-${submissions.length}`; submissions.push(agentId);
        states.set(id, { id, agentId, status: 'queued' } as AgentRun); return { id };
      },
      load: async (id: string) => states.get(id),
      waitFor: async () => new Promise<AgentRun>(() => {}),
    },
  };
  const coordinator = new CollaborationCoordinator(options as CollaborationCoordinatorOptions);
  const send = (body: string, extra: Record<string, unknown> = {}) => coordinator.deliver({ scopeId: 'group', author: { id: 'human', kind: 'human' }, body, deliveryKey: `d-${body}`, awaitReply: false, ...extra });
  return { coordinator, store, submissions, states, send, failAdmissions: () => { failAdmissions = true; }, setFacts: (value: TaskGroupWakeFacts) => { currentFacts = value; }, withModel: (taskGroupModel: CollaborationCoordinatorOptions['taskGroupModel']) => new CollaborationCoordinator({ ...options, taskGroupModel } as CollaborationCoordinatorOptions), freeze: () => { writable = false; }, restart: () => new CollaborationCoordinator(options as CollaborationCoordinatorOptions), calls: () => calls, at: (value: number) => { now = value; } };
}

test('mentions override kind and assignment without model cost', async () => {
  for (const [body, targets] of [['@b question', ['b']], ['@all question', ['lead', 'a', 'b']]] as const) {
    const f = fixture({ lead: { id: 'lead', kind: 'agent' }, assignedAgentIds: ['a'] });
    await f.send(body, { kind: 'question' });
    assert.deepEqual(f.submissions, targets); assert.equal(f.calls(), 0);
  }
});

test('question and escalation deterministically wake the lead', async () => {
  for (const kind of ['question', 'escalation']) {
    const f = fixture(); await f.send('help', { kind });
    assert.deepEqual(f.submissions, ['lead']); assert.equal(f.calls(), 0);
  }
});

test('assignment and exact role rules bypass the model', async () => {
  for (const facts of [
    { lead: { id: 'lead', kind: 'agent' as const }, assignedAgentIds: ['a'] },
    { lead: { id: 'lead', kind: 'agent' as const }, roles: [{ agentId: 'a', keys: ['compile'] }] },
  ]) {
    const f = fixture(facts); await f.send('compile');
    assert.deepEqual(f.submissions, ['a']); assert.equal(f.calls(), 0);
  }
});

test('ambiguity is deferred and calls the model once across duplicate sweeps', async () => {
  const f = fixture(undefined, ['b']); await f.send('status');
  assert.equal(f.calls(), 0);
  await f.coordinator.sweepTaskGroups(); await f.coordinator.sweepTaskGroups();
  assert.deepEqual(f.submissions, ['b']); assert.equal(f.calls(), TASK_GROUP_MAX_MODEL_CALLS);
});

test('empty and invalid model answers fall back to the lead', async () => {
  for (const answer of [[], ['outside'], ['human']]) {
    const f = fixture(undefined, answer); await f.send('status'); await f.coordinator.sweepTaskGroups();
    assert.deepEqual(f.submissions, ['lead']); assert.equal(f.calls(), TASK_GROUP_MAX_MODEL_CALLS);
  }
});

test('unwakeable mentions retain failure and guarantee lead wake', async () => {
  const f = fixture(); const result = await f.send('@outside');
  assert.deepEqual(f.submissions, ['lead']); assert.equal(f.calls(), 0);
  assert.equal((await f.store.listObservations(result.message.id)).length, 1);
});

test('idle deadline re-wakes lead once before one Attention signal, including restart', async () => {
  const f = fixture(); await f.send('@a');
  f.at(TASK_GROUP_IDLE_MS - 1); await f.coordinator.sweepTaskGroups(); assert.deepEqual(f.submissions, ['a']);
  f.at(TASK_GROUP_IDLE_MS); await f.coordinator.sweepTaskGroups(); await f.coordinator.sweepTaskGroups();
  assert.deepEqual(f.submissions, ['a', ...Array(TASK_GROUP_MAX_LEAD_REWAKES).fill('lead')]);
  assert.equal((await f.store.listEvents()).filter(e => e.kind === TASK_GROUP_ATTENTION_KIND).length, 0);
  f.at(2 * TASK_GROUP_IDLE_MS); await f.restart().sweepTaskGroups(); await f.coordinator.sweepTaskGroups();
  assert.equal((await f.store.listEvents()).filter(e => e.kind === TASK_GROUP_ATTENTION_KIND).length, 1);
  assert.equal(f.submissions.length, 2);
});

test('working inputs settle their idle obligation without escalation', async () => {
  const f = fixture(); await f.send('@a');
  f.states.set('run-0', { id: 'run-0', status: 'running' } as AgentRun);
  f.at(TASK_GROUP_IDLE_MS * 3); await f.coordinator.sweepTaskGroups();
  assert.deepEqual(f.submissions, ['a']); assert.equal((await f.store.listEvents()).filter(e => e.kind === TASK_GROUP_ATTENTION_KIND).length, 0);
});

test('human lead is not forcibly delegated and unanswered input signals Attention only', async () => {
  const f = fixture({ lead: { id: 'human', kind: 'human' }, assignedAgentIds: ['a'] }); await f.send('status');
  f.at(TASK_GROUP_IDLE_MS); await f.coordinator.sweepTaskGroups(); await f.coordinator.sweepTaskGroups();
  assert.deepEqual(f.submissions, []); assert.equal(f.calls(), 0);
  assert.equal((await f.store.listEvents()).filter(e => e.kind === TASK_GROUP_ATTENTION_KIND).length, 1);
  const mentioned = fixture({ lead: { id: 'human', kind: 'human' }, assignedAgentIds: ['a'] });
  await mentioned.send('@b status');
  assert.deepEqual(mentioned.submissions, ['b']); assert.equal(mentioned.calls(), 0);
});

test('sender exclusion and bounded A to B to A chains end in Attention', async () => {
  const f = fixture({ lead: { id: 'a', kind: 'agent' } });
  let previous: string | undefined;
  for (let hop = 0; hop <= TASK_GROUP_MAX_AGENT_CHAIN; hop++) {
    const sender = hop % 2 ? 'b' : 'a', target = hop % 2 ? 'a' : 'b';
    const sent = await f.send(`@${target} hop-${hop}`, { author: { id: sender, kind: 'agent' }, inReplyTo: previous });
    previous = sent.message.id;
  }
  await f.coordinator.sweepTaskGroups();
  assert.deepEqual(f.submissions, ['b', 'a']);
  assert.equal((await f.store.listEvents()).filter(e => e.kind === TASK_GROUP_ATTENTION_KIND).length, 1);
  const self = fixture({ lead: { id: 'a', kind: 'agent' } });
  await self.send('@a', { author: { id: 'a', kind: 'agent' } });
  self.at(TASK_GROUP_IDLE_MS); await self.coordinator.sweepTaskGroups();
  assert.deepEqual(self.submissions, []);
  assert.equal((await self.store.listEvents()).filter(e => e.kind === TASK_GROUP_ATTENTION_KIND).length, 1);
  const projected = fixture();
  const root = await projected.send('@b root', { author: { id: 'a', kind: 'agent' } });
  const automatic: Message = { ...root.message, id: 'automatic', author: { id: 'b', kind: 'agent' }, deliveryKey: 'reply:automatic', inReplyTo: root.message.id };
  await projected.store.postMessage({ message: automatic, plan: { inputId: automatic.id, decisions: [], observations: [] }, now: 0 });
  await projected.send('@a explicit', { author: { id: 'b', kind: 'agent' }, inReplyTo: automatic.id });
  assert.deepEqual(projected.submissions, ['b', 'a'], 'automatic replies do not spend explicit-chain budget');
});


test('model timeout aborts once and failure or absence falls back without fan-out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const message: Message = { id: 'm', projectId: 'p', scopeId: 's', channel: 'task-group', author: { id: 'human', kind: 'human' }, body: 'status', recipients: [], deliveryKey: 'm', createdAt: 0 };
  const members = ['lead', 'b'].map(memberId => ({ memberId, memberKind: 'agent' as const }));
  const facts: TaskGroupWakeFacts = { lead: { id: 'lead', kind: 'agent' } };
  let calls = 0;
  let signal: AbortSignal | undefined;
  const pending = resolveTaskGroupAmbiguity(message, members, facts, { select: async input => {
    calls++; signal = input.signal; return new Promise<readonly string[]>(() => {});
  } });
  t.mock.timers.tick(TASK_GROUP_MODEL_TIMEOUT_MS);
  assert.deepEqual((await pending).decisions.map(d => d.agentId), ['lead']);
  assert.equal(signal?.aborted, true); assert.equal(calls, TASK_GROUP_MAX_MODEL_CALLS);
  for (const model of [undefined, { select: async () => { throw new Error('provider unavailable'); } }]) {
    assert.deepEqual((await resolveTaskGroupAmbiguity(message, members, facts, model)).decisions.map(d => d.agentId), ['lead']);
  }
});

test('model input is redacted and bounded for both content and candidate count', async () => {
  const message: Message = { id: 'm', projectId: 'p', scopeId: 's', channel: 'task-group', author: { id: 'human', kind: 'human' }, body: `/home/example/private ${'x'.repeat(5_000)}`, recipients: [], deliveryKey: 'm', createdAt: 0 };
  const members = ['lead', ...Array.from({ length: 70 }, (_, index) => `agent-${index}`)].map(memberId => ({ memberId, memberKind: 'agent' as const }));
  const facts: TaskGroupWakeFacts = { lead: { id: 'lead', kind: 'agent' } };
  let input: Parameters<NonNullable<CollaborationCoordinatorOptions['taskGroupModel']>['select']>[0] | undefined;
  const plan = await resolveTaskGroupAmbiguity(message, members, facts, { select: async value => { input = value; return ['agent-0']; } });
  assert.equal(input?.message.body.length, TASK_GROUP_MODEL_MAX_BODY_CHARS);
  assert.equal(input?.message.body.includes('/home/example/private'), false);
  assert.equal(input?.message.kind, 'status');
  assert.equal(input?.candidates.length, TASK_GROUP_MODEL_MAX_CANDIDATES);
  assert.equal(plan.decisions[0]?.agentId, 'agent-0');
});

test('model timeout is shortened to the earliest pending idle deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.send('@a');
  f.at(TASK_GROUP_IDLE_MS - 10_000); const { message } = await f.send('ambiguous');
  let signal: AbortSignal | undefined;
  let started!: () => void;
  const modelStarted = new Promise<void>(resolve => { started = resolve; });
  const routing = f.withModel({ select: async input => { signal = input.signal; started(); return new Promise<readonly string[]>(() => {}); } });
  const pending = routing.sweepTaskGroups();
  await modelStarted;
  t.mock.timers.tick(10_000);
  await pending;
  assert.equal(signal?.aborted, true);
  const routedWakes = (await f.store.listWakeRequests()).filter(wake => wake.inputId === `task-group:${message.id}:routed`);
  assert.deepEqual(routedWakes.map(wake => wake.agentId), ['lead']);
  assert.ok(TASK_GROUP_MODEL_TIMEOUT_MS > 10_000);
});

test('deadline timers and repeated sweeps produce exactly one re-wake and one signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.send('@a');
  t.mock.timers.tick(0); await f.coordinator.sweepTaskGroups();
  f.at(TASK_GROUP_IDLE_MS); t.mock.timers.tick(TASK_GROUP_IDLE_MS); await f.coordinator.sweepTaskGroups();
  assert.deepEqual(f.submissions, ['a', 'lead']);
  f.at(2 * TASK_GROUP_IDLE_MS); t.mock.timers.tick(TASK_GROUP_IDLE_MS); await f.coordinator.sweepTaskGroups();
  await f.coordinator.sweepTaskGroups();
  assert.equal((await f.coordinator.listTaskGroupEscalations()).length, 1);
  assert.equal(f.submissions.length, 1 + TASK_GROUP_MAX_LEAD_REWAKES);
});

test('crashed model claim recovers by lead fallback with zero additional inference', async () => {
  const f = fixture(undefined, ['b']); const { message } = await f.send('ambiguous');
  const key = `task-group:${message.id}:model-claimed`;
  await f.store.publishEvent({ event: {
    id: key, projectId: message.projectId, kind: 'task-group-model-claimed', summary: 'Claimed',
    producer: { kind: 'system', id: 'sprout' }, disposition: 'non-routing', responsibleAgentIds: [], deliveryKey: key, createdAt: 0,
  }, plan: { inputId: key, decisions: [], observations: [] }, now: 0 });
  await f.restart().sweepTaskGroups(); await f.coordinator.sweepTaskGroups();
  assert.equal(f.calls(), 0); assert.deepEqual(f.submissions, ['lead']);
});

test('concurrent coordinators share a durable model claim and never exceed the call bound', async () => {
  const f = fixture(undefined, ['b']); await f.send('ambiguous');
  await Promise.all([f.coordinator.sweepTaskGroups(), f.restart().sweepTaskGroups()]);
  assert.equal(f.calls(), TASK_GROUP_MAX_MODEL_CALLS);
  assert.ok(f.submissions.length >= 1);
});

test('SQLite reopen preserves kind, causal chain, idle stage and a resolvable Attention signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-group-wake-'));
  const filename = join(directory, 'collaboration.sqlite');
  let db = new DatabaseSync(filename);
  try {
    const f = fixture(undefined, [], new SqliteCollaborationStore({ db }));
    const first = await f.send('help', { kind: 'question' });
    const next = await f.send('@b', { inReplyTo: first.message.id });
    f.at(TASK_GROUP_IDLE_MS); await f.coordinator.sweepTaskGroups();
    db.close(); db = new DatabaseSync(filename);
    const recovered = fixture(undefined, [], new SqliteCollaborationStore({ db }));
    recovered.at(2 * TASK_GROUP_IDLE_MS); await recovered.coordinator.sweepTaskGroups();
    assert.equal((await recovered.store.getMessage(first.message.id))?.kind, 'question');
    assert.equal((await recovered.store.getMessage(next.message.id))?.inReplyTo, first.message.id);
    assert.deepEqual(recovered.submissions, []);
    const signals = await recovered.coordinator.listTaskGroupEscalations();
    assert.equal(signals.length, 2);
    assert.deepEqual(signals.map(s => s.scopeId), ['group', 'group']);
    const signal = signals[0]!;
    await recovered.store.resolveAttention({ projectId: 'project', kind: 'event', sourceId: signal.eventId, actor: { kind: 'human', id: 'human' }, now: 2 * TASK_GROUP_IDLE_MS });
    assert.equal((await recovered.store.listAttentionResolutions()).length, 1);
    assert.equal((await recovered.coordinator.listEvents('project')).filter(e => e.kind === TASK_GROUP_ATTENTION_KIND).every(e => e.originScopeIds?.includes('group')), true);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('answered Messages and terminal groups stop idle orchestration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const answered = fixture();
  const { message } = await answered.send('@a');
  const reply: Message = { ...message, id: 'reply', author: { id: 'a', kind: 'agent' }, body: 'Done', deliveryKey: 'reply:fixture', inReplyTo: message.id };
  await answered.store.postMessage({ message: reply, plan: { inputId: reply.id, decisions: [], observations: [] }, now: 0 });
  answered.at(TASK_GROUP_IDLE_MS * 3); await answered.coordinator.sweepTaskGroups();
  assert.deepEqual(answered.submissions, ['a']);
  assert.equal((await answered.coordinator.listTaskGroupEscalations()).length, 0);
  const terminal = fixture(); await terminal.send('ambiguous'); terminal.freeze();
  terminal.at(TASK_GROUP_IDLE_MS * 3); await terminal.coordinator.sweepTaskGroups();
  assert.equal(terminal.calls(), 0); assert.deepEqual(terminal.submissions, []);
  assert.equal((await terminal.coordinator.listTaskGroupEscalations()).length, 0);
});

test('a Task frozen during inference cannot admit late model recipients', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.send('ambiguous');
  let start!: () => void;
  let finish!: (ids: readonly string[]) => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const routing = f.withModel({ select: () => { start(); return new Promise(resolve => { finish = resolve; }); } });
  const pending = routing.sweepTaskGroups();
  await started; f.freeze(); finish(['b']); await pending;
  assert.deepEqual(f.submissions, []);
});

test('a model result is discarded when the Task becomes Human-led during inference', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.send('ambiguous');
  let start!: () => void;
  let finish!: (ids: readonly string[]) => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const routing = f.withModel({ select: () => { start(); return new Promise(resolve => { finish = resolve; }); } });
  const pending = routing.sweepTaskGroups();
  await started;
  f.setFacts({ lead: { id: 'human', kind: 'human' }, assignedAgentIds: ['a'] });
  f.at(TASK_GROUP_IDLE_MS);
  finish(['b']); await pending;
  assert.deepEqual(f.submissions, []);
  assert.equal((await routing.listTaskGroupEscalations()).length, 1);
  assert.deepEqual(f.submissions, []);
});

test('persistent admission failure cannot starve the bounded escalation path', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.failAdmissions(); await assert.rejects(f.send('@a'));
  f.at(TASK_GROUP_IDLE_MS); await f.coordinator.sweepTaskGroups();
  assert.equal((await f.coordinator.listTaskGroupEscalations()).length, 0);
  assert.equal((await f.store.listEvents()).filter(e => e.kind === 'task-group-rewake').length, TASK_GROUP_MAX_LEAD_REWAKES);
  f.at(2 * TASK_GROUP_IDLE_MS); await f.coordinator.sweepTaskGroups(); await f.coordinator.sweepTaskGroups();
  assert.equal((await f.coordinator.listTaskGroupEscalations()).length, 1);
  assert.deepEqual(f.submissions, []);
});

test('elapsed idle budget falls back without paying for queued inference', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(undefined, ['b']); await f.send('ambiguous');
  f.at(TASK_GROUP_IDLE_MS); await f.coordinator.sweepTaskGroups();
  assert.equal(f.calls(), 0);
  assert.equal(f.submissions[0], 'lead');
  assert.equal(f.submissions.length, 1 + TASK_GROUP_MAX_LEAD_REWAKES);
});
