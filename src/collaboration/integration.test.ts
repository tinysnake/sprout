/**
 * Production integration for the collaboration write path (#26, #96).
 *
 * The unit tests exercise each seam in isolation and the probe crosses a real
 * worker process. This file is the middle ground: the **real** `SqliteStore`
 * (the unified primary database, not a separate collaboration file), the **real**
 * `RunOrchestrator`, and the real coordinator, with only the engine scripted.
 * It is what shows the acceptance behaviours compose in the shape `main.ts`
 * actually wires.
 *
 * Acceptance behaviours covered here:
 * - Direct messages, exact `@id` mentions, and `@all` broadcasts are routed
 *   deterministically — no wake model is consulted on any branch — and start
 *   runs with contextual prompts in the input's conversation scope.
 * - An unaddressed input wakes nobody and records a durable suppressed
 *   observation instead of a guessed or failed-open wake.
 * - A completed run projects one Agent-authored reply; failed or interrupted
 *   runs project none.
 * - Private run events never enter conversation (final-text-only projection).
 * - Idempotent retry produces one durable input and at most one run admission.
 * - Project events are published with a required routing disposition; an
 *   `addressed` event wakes its responsible Agent through the same
 *   persistence-before-admission path, a non-addressed one persists without
 *   any wake.
 * - Working-group deterministic addresses resolve against the group's current
 *   participants: an Agent outside the group never receives a wake or run for
 *   group-only content, while a nonparticipant named explicitly keeps a
 *   durable failure beside the valid participant's wake.
 */

import { test } from 'node:test';

import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { AgentRegistry } from '../agent/registry.ts';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';

import { EnvironmentPool } from '../environment/pool.ts';

import { ScriptedEngineAdapter, type ScriptedTurn } from '../engine/scripted.ts';

import { ProjectRegistry } from '../project/registry.ts';

import type { Project } from '../project/model.ts';
import type { ConversationTaskPort } from '../conversation/service.ts';

import { RunOrchestrator } from '../run/orchestrator.ts';

import { SqliteStore } from '../store/db.ts';

import { CollaborationCoordinator } from './coordinator.ts';

import { buildCollaborationScopes, type CollaborationScopeHarness } from './scope-harness.ts';


const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [
    { name: 'agent-run', requiresLease: true },
    { name: 'read-only-investigation', requiresLease: false },
  ],
};

const instance: EnvironmentInstance = {
  id: 'mac-mini-1',
  definitionId: 'macos-workstation',
  workingDirectory: '/srv/work',
};

const project: Project = {
  id: 'project-sprout',
  goal: 'Ship Sprout',
  rules: [],
  availableEnvironmentInstanceIds: ['mac-mini-1'],
  memberships: [
    { agentId: 'scout', responsibilities: [], collaborationInstructions: '' },
    { agentId: 'forge', responsibilities: [], collaborationInstructions: '' },
    { agentId: 'scribe', responsibilities: [], collaborationInstructions: '' },
  ],
};


/**
 * A scripted completed turn. Extra events are emitted before the final message,
 * so a test can prove private run events never enter conversation.
 */
function scriptedTurn(text: string, extraEvents: ScriptedTurn['events'] = []): ScriptedTurn {
  return {
    events: [...extraEvents, { type: 'message', text, final: true }],
    result: { status: 'completed', text },
  };
}


interface Harness {
  readonly sqlite: SqliteStore;
  readonly coordinator: CollaborationCoordinator;
  readonly engine: ScriptedEngineAdapter;
  readonly scopes: CollaborationScopeHarness;
  readonly projects: ProjectRegistry;
  close(): void;
}


function build(options: {
  turns: readonly ScriptedTurn[];
  /** Overrides the default single project; used by the multi-Project regression. */
  projects?: readonly Project[];
  definitions?: readonly EnvironmentDefinition[];
  instances?: readonly EnvironmentInstance[];
  agents?: readonly { id: string; name: string; engine: string; capability: string; workingDirectory?: string }[];
  tasks?: ConversationTaskPort;
}): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-collab-integration-'));
  const sqlite = new SqliteStore({ filename: join(directory, 'sprout.db') });
  const engine = new ScriptedEngineAdapter({ turns: options.turns });
  const projects = new ProjectRegistry(options.projects ?? [project]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', engine]]),
    agents: new AgentRegistry(
      options.agents ?? [
        { id: 'scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
        { id: 'forge', name: 'Forge', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
        { id: 'scribe', name: 'Scribe', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
      ],
    ),
    projects,
    pool: new EnvironmentPool({
      definitions: options.definitions ?? [definition],
      instances: options.instances ?? [instance],
      store: sqlite.leases,
    }),
    store: sqlite.runs,
  });
  const scopes = buildCollaborationScopes({ projects, ...(options.tasks !== undefined ? { tasks: options.tasks } : {}) });
  const coordinator = new CollaborationCoordinator({
    scopes: scopes.scopes,
    store: sqlite.collaboration,
    runs: orchestrator,
  });
  return {
    sqlite,
    coordinator,
    engine,
    scopes,
    projects,
    close: () => {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}


test('parallel Task groups keep Message and Wake records inside their own scope', async (t) => {
  const harness = build({ turns: [scriptedTurn('Scout task reply.'), scriptedTurn('Forge task reply.')] });
  t.after(harness.close);
  const makeGroup = (taskId: string) => harness.scopes.scopes.syncTaskGroup({
    taskId, projectId: 'project-sprout', title: `Task ${taskId}`,
    goal: `Goal ${taskId}`, constraints: [`Rule ${taskId}`],
    lead: { memberId: 'human-lead', kind: 'human' }, contentVersion: 1, status: 'in-progress',
  });
  const [first, second] = await Promise.all([makeGroup('parallel-a'), makeGroup('parallel-b')]);
  assert.ok(first && second);
  assert.notEqual(first.id, second.id);

  const firstDelivery = await harness.coordinator.deliver({
    scopeId: first.id, author: { id: 'human-lead', kind: 'human' },
    body: '@scout handle Task A', deliveryKey: 'task-group-a-message',
  });
  const secondDelivery = await harness.coordinator.deliver({
    scopeId: second.id, author: { id: 'human-lead', kind: 'human' },
    body: '@forge handle Task B', deliveryKey: 'task-group-b-message',
  });
  assert.equal(firstDelivery.message.channel, 'task-group');
  assert.equal(secondDelivery.message.channel, 'task-group');
  assert.deepEqual(firstDelivery.wakes.map((wake) => wake.agentId), ['scout']);
  assert.deepEqual(secondDelivery.wakes.map((wake) => wake.agentId), ['forge']);

  const messages = await harness.sqlite.collaboration.listMessages();
  const firstMessages = messages.filter((message) => message.scopeId === first.id);
  const secondMessages = messages.filter((message) => message.scopeId === second.id);
  assert.deepEqual(firstMessages.map((message) => message.scopeId), [first.id, first.id]);
  assert.deepEqual(secondMessages.map((message) => message.scopeId), [second.id, second.id]);
  assert.equal(messages.filter((message) => message.inReplyTo === firstDelivery.message.id).every((message) => message.scopeId === first.id), true);
  assert.equal(messages.filter((message) => message.inReplyTo === secondDelivery.message.id).every((message) => message.scopeId === second.id), true);
  assert.deepEqual((await harness.coordinator.listMessages({ scopeId: first.id })).map((message) => message.body), [
    '@scout handle Task A', 'Scout task reply.',
  ]);
  assert.deepEqual((await harness.coordinator.listMessages({ scopeId: second.id })).map((message) => message.body), [
    '@forge handle Task B', 'Forge task reply.',
  ]);
  assert.deepEqual(firstDelivery.wakes.map((wake) => wake.inputId), [firstDelivery.message.id]);
  assert.deepEqual(secondDelivery.wakes.map((wake) => wake.inputId), [secondDelivery.message.id]);
});
test('Task-group membership follows Project changes and routing admits only current members', async (t) => {
  const newcomer = { id: 'newcomer', name: 'Newcomer', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' };
  const harness = build({
    turns: [scriptedTurn('Newcomer task reply.')],
    agents: [
      { id: 'scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
      { id: 'forge', name: 'Forge', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
      { id: 'scribe', name: 'Scribe', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
      newcomer,
    ],
  });
  t.after(harness.close);
  const group = await harness.scopes.scopes.syncTaskGroup({
    taskId: 'membership-changes', projectId: project.id, title: 'Membership changes', goal: 'Use live authority.',
    constraints: [], lead: { memberId: 'human-lead', kind: 'human' }, contentVersion: 1, status: 'in-progress',
  });
  const before = harness.projects.get(project.id)!;
  harness.projects.add({
    ...before,
    memberships: [
      ...before.memberships.filter((membership) => membership.agentId !== 'forge'),
      { agentId: 'newcomer', responsibilities: [], collaborationInstructions: '' },
    ],
  });

  assert.deepEqual(await harness.scopes.scopes.scopeState(group.id, 'newcomer'), {
    scopeId: group.id, writable: true,
  });
  assert.deepEqual(await harness.scopes.scopes.scopeState(group.id, 'forge'), {
    scopeId: group.id, writable: false, reason: 'not-a-member',
  });
  const removedMember = await harness.coordinator.deliver({
    scopeId: group.id, author: { id: 'human-lead', kind: 'human' },
    body: '@forge take this Task', deliveryKey: 'task-group-removed-member',
  });
  assert.deepEqual(removedMember.admittedRunIds, []);
  assert.deepEqual(removedMember.wakes, []);
  const removedMemberObservations = await harness.sqlite.collaboration.listObservations(removedMember.message.id);
  assert.equal(removedMemberObservations.some((entry) => entry.agentId === 'forge' && entry.status === 'failed'), true);

  const newMember = await harness.coordinator.deliver({
    scopeId: group.id, author: { id: 'human-lead', kind: 'human' },
    body: '@newcomer take this Task', deliveryKey: 'task-group-new-member',
  });
  assert.deepEqual(newMember.wakes.map((wake) => wake.agentId), ['newcomer']);
  assert.equal(newMember.admittedRunIds.length, 1);
});

test('Task-group post admission serializes with terminal commit and rejects later posts', async (t) => {
  let taskStatus = 'in-progress';
  let releaseStoreWrite!: () => void;
  let notifyStoreWrite!: () => void;
  const storeWriteStarted = new Promise<void>((resolve) => { notifyStoreWrite = resolve; });
  const storeWriteGate = new Promise<void>((resolve) => { releaseStoreWrite = resolve; });
  const harness = build({
    turns: [],
    tasks: { async taskFacts(taskId) {
      return taskId === 'terminal-race' ? { projectId: project.id, status: taskStatus } : undefined;
    } },
  });
  t.after(harness.close);
  const groupInput = {
    taskId: 'terminal-race', projectId: project.id, title: 'Terminal race', goal: 'No late post.',
    constraints: [], lead: { memberId: 'human-lead', kind: 'human' as const }, contentVersion: 1,
  };
  const group = await harness.scopes.scopes.syncTaskGroup({ ...groupInput, status: 'in-progress' });

  const events: string[] = [];
  const persistMessage = harness.sqlite.collaboration.postMessage.bind(harness.sqlite.collaboration);
  harness.sqlite.collaboration.postMessage = async (input) => {
    notifyStoreWrite();
    await storeWriteGate;
    const stored = await persistMessage(input);
    events.push('message-persisted');
    return stored;
  };
  const posting = harness.coordinator.deliver({
    scopeId: group.id, author: { id: 'human-lead', kind: 'human' },
    body: 'This post races terminal commit.', deliveryKey: 'terminal-race-before-freeze', awaitReply: false,
  });
  await storeWriteStarted;
  let duringTransitionPostRejected: Promise<void> | undefined;
  const serializeTaskGroup = harness.scopes.scopes.withTaskGroupLock?.bind(harness.scopes.scopes)
    ?? (<T>(_taskId: string, action: () => Promise<T>) => action());
  const terminalTransition = serializeTaskGroup(groupInput.taskId, async () => {
    taskStatus = 'done';
    const duringTransitionPost = harness.coordinator.deliver({
      scopeId: group.id, author: { id: 'human-lead', kind: 'human' },
      body: 'This post starts during terminal transition.', deliveryKey: 'terminal-race-during-transition', awaitReply: false,
    });
    duringTransitionPostRejected = assert.rejects(duringTransitionPost, (error: unknown) => {
      assert.equal((error as { reason?: string }).reason, 'task-group-frozen');
      return true;
    });
    await harness.scopes.scopes.syncTaskGroup({ ...groupInput, status: 'done' });
    events.push('terminal-committed');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const transitionFinishedBeforePost = events.includes('terminal-committed');

  releaseStoreWrite();
  await posting;
  await terminalTransition;
  assert.equal(transitionFinishedBeforePost, false, 'terminal persistence waits for a post whose active-state read began first');
  assert.deepEqual(events, ['message-persisted', 'terminal-committed']);
  assert.equal(taskStatus, 'done');
  assert.ok(duringTransitionPostRejected);
  await duringTransitionPostRejected;
  const rejected = harness.coordinator.deliver({
    scopeId: group.id, author: { id: 'human-lead', kind: 'human' },
    body: 'This post is after terminal commit.', deliveryKey: 'terminal-race-after-freeze', awaitReply: false,
  });
  await assert.rejects(rejected, (error: unknown) => {
    assert.equal((error as { reason?: string }).reason, 'task-group-frozen');
    assert.match((error as Error).message, /Task is terminal.*history remains readable/i);
    return true;
  });
  const history = (await harness.sqlite.collaboration.listMessages()).filter((message) => message.scopeId === group.id);
  assert.deepEqual(history.map((message) => message.body), ['This post races terminal commit.']);
});


test('a direct message wakes its recipient with a contextual prompt and projects one reply', async (t) => {
  const harness = build({ turns: [scriptedTurn('Scout: on it.')] });
  t.after(harness.close);
  const scopeId = await harness.scopes.openDirect('project-sprout', ['human-lead', 'scout']);

  const delivered = await harness.coordinator.deliver({
    scopeId,
    author: { id: 'human-lead', kind: 'human' },
    body: 'Please check the wake rule.',
    recipients: ['scout'],
    deliveryKey: 'direct-1',
  });

  assert.equal(delivered.wakes.length, 1);
  assert.equal(delivered.wakes[0]?.reason, 'direct-recipient');
  assert.equal(delivered.admittedRunIds.length, 1);
  assert.equal(delivered.message.channel, 'direct');
  assert.equal(delivered.message.scopeId, scopeId);

  // The prompt names author, location, and the target agent.
  const prompt = harness.engine.sessions[0]?.prompts[0] ?? '';
  assert.match(prompt, /human human-lead wrote:/);
  assert.match(prompt, /Please check the wake rule\./);
  assert.match(prompt, /You are scout/);
  assert.match(prompt, /a direct message/);

  const replies = (await harness.sqlite.collaboration.listMessages()).filter(
    (message) => message.author.kind === 'agent',
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.author.id, 'scout');
  assert.equal(replies[0]?.inReplyTo, delivered.message.id);
  assert.equal(replies[0]?.scopeId, scopeId, 'the reply stays in the conversation scope');
  assert.equal(replies[0]?.body, 'Scout: on it.');
});


test('an exact @id mention wakes only the mentioned member, without any model', async (t) => {
  const harness = build({ turns: [scriptedTurn('Forge: acknowledged.')] });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    scopeId: await harness.scopes.channel('project-sprout'),
    author: { id: 'human-lead', kind: 'human' },
    body: '@forge can you take the review?',
    deliveryKey: 'mention-1',
  });

  assert.deepEqual(
    delivered.wakes.map((wake) => `${wake.agentId}:${wake.reason}`),
    ['forge:agent-mention'],
  );
  assert.equal(delivered.admittedRunIds.length, 1);

  const replies = (await harness.sqlite.collaboration.listMessages()).filter(
    (message) => message.author.kind === 'agent',
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.author.id, 'forge');
});


test('an unknown @id records a durable failure beside the valid deterministic route', async (t) => {
  const harness = build({ turns: [] });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    scopeId: await harness.scopes.channel('project-sprout'),
    author: { id: 'human-lead', kind: 'human' },
    body: '@ghost and @scout can you take this?',
    deliveryKey: 'unknown-mention-1',
  });

  assert.deepEqual(
    delivered.wakes.map((wake) => `${wake.agentId}:${wake.reason}`),
    ['scout:agent-mention'],
    'the valid target still routes; the invalid one never blocks it',
  );
  assert.deepEqual(harness.sqlite.collaboration.observations(delivered.message.id), [
    {
      agentId: 'ghost',
      status: 'failed',
      reason: 'agent-mention',
      detail: 'addressed target is not a member of project project-sprout',
    },
  ]);
});


test('an @all broadcast wakes every other current Agent', async (t) => {
  const harness = build({
    turns: [
      scriptedTurn('Scout: ready.'),
      scriptedTurn('Forge: ready.'),
      scriptedTurn('Scribe: ready.'),
    ],
  });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    scopeId: await harness.scopes.channel('project-sprout'),
    author: { id: 'human-lead', kind: 'human' },
    body: 'standup @all',
    deliveryKey: 'broadcast-1',
  });

  assert.equal(delivered.wakes.length, 3, 'every member except the author');
  assert.ok(delivered.wakes.every((wake) => wake.reason === 'broadcast'));
  assert.equal(delivered.admittedRunIds.length, 3);

  const replies = (await harness.sqlite.collaboration.listMessages()).filter(
    (message) => message.author.kind === 'agent',
  );
  assert.deepEqual(
    replies.map((reply) => reply.author.id).sort(),
    ['forge', 'scout', 'scribe'],
  );
  assert.ok(replies.every((reply) => reply.inReplyTo === delivered.message.id));
});


test('an unaddressed project message wakes nobody and records a durable suppression', async (t) => {
  const harness = build({ turns: [scriptedTurn('should not run')] });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    scopeId: await harness.scopes.channel('project-sprout'),
    author: { id: 'human-lead', kind: 'human' },
    body: 'just an fyi',
    deliveryKey: 'suppressed-1',
  });

  assert.equal(delivered.admittedRunIds.length, 0);
  assert.deepEqual(delivered.wakes, []);
  const observations = harness.sqlite.collaboration.observations(delivered.message.id);
  assert.equal(observations.length, 1, 'nothing happened, and that is durably visible');
  assert.equal(observations[0]?.status, 'suppressed');
  assert.equal(observations[0]?.reason, 'unaddressed');
  assert.match(observations[0]?.detail ?? '', /remains durable under the Project wake policy/);

  const replies = (await harness.sqlite.collaboration.listMessages()).filter(
    (message) => message.author.kind === 'agent',
  );
  assert.equal(replies.length, 0);
});


test('a Working group channel message routes and replies inside its own scope', async (t) => {
  const harness = build({ turns: [scriptedTurn('Scribe: noted.')] });
  t.after(harness.close);
  const groupId = (
    await harness.scopes.scopes.createWorkingGroup({
      projectId: 'project-sprout',
      displayName: 'Docs',
      creator: { memberId: 'human-lead', kind: 'human' },
      memberIds: ['scribe'],
    })
  ).id;

  const delivered = await harness.coordinator.deliver({
    scopeId: groupId,
    author: { id: 'human-lead', kind: 'human' },
    body: '@scribe please capture this',
    deliveryKey: 'wg-1',
  });

  assert.equal(delivered.message.channel, 'working-group');
  assert.deepEqual(
    delivered.wakes.map((wake) => `${wake.agentId}:${wake.reason}`),
    ['scribe:agent-mention'],
  );
  const reply = (await harness.sqlite.collaboration.listMessages()).find(
    (message) => message.author.kind === 'agent',
  );
  assert.equal(reply?.scopeId, groupId, 'the reply stays in the Working group channel');
  const prompt = harness.engine.sessions[0]?.prompts[0] ?? '';
  assert.match(prompt, /the Working group channel/);
});


test('a Working group broadcast and mention never wake Agents outside the group', async (t) => {
  // The #96 F1 regression: `forge` and `scribe` are current Project Agents but
  // not participants of this group, so group-only content must never produce a
  // wake or a run for them, while the participant still wakes and an explicit
  // nonparticipant mention keeps a durable failure beside it.
  const harness = build({
    turns: [scriptedTurn('Scout: noted.'), scriptedTurn('Scout: reviewed.')],
  });
  t.after(harness.close);
  const groupId = (
    await harness.scopes.scopes.createWorkingGroup({
      projectId: 'project-sprout',
      displayName: 'Docs',
      creator: { memberId: 'human-lead', kind: 'human' },
      memberIds: ['scout'],
    })
  ).id;

  const broadcast = await harness.coordinator.deliver({
    scopeId: groupId,
    author: { id: 'human-lead', kind: 'human' },
    body: 'standup @all',
    deliveryKey: 'wg-all-1',
  });
  assert.deepEqual(
    broadcast.wakes.map((wake) => `${wake.agentId}:${wake.reason}`),
    ['scout:broadcast'],
    'the broadcast resolves over the group\'s current participant Agents only',
  );
  assert.equal(broadcast.admittedRunIds.length, 1);
  assert.deepEqual(
    harness.engine.requests.map((request) => request.agentId),
    ['scout'],
    'no run is ever submitted for an Agent outside the group',
  );

  const mention = await harness.coordinator.deliver({
    scopeId: groupId,
    author: { id: 'human-lead', kind: 'human' },
    body: '@forge and @scout please review',
    deliveryKey: 'wg-mention-1',
  });
  assert.deepEqual(
    mention.wakes.map((wake) => wake.agentId),
    ['scout'],
    'the participant still wakes',
  );
  assert.equal(mention.admittedRunIds.length, 1);
  assert.deepEqual(harness.sqlite.collaboration.observations(mention.message.id), [
    {
      agentId: 'forge',
      status: 'failed',
      reason: 'agent-mention',
      detail: 'addressed target is not a participant of this working group',
    },
  ]);
  assert.deepEqual(
    harness.engine.requests.map((request) => request.agentId),
    ['scout', 'scout'],
    'the nonparticipant never receives a run',
  );
});

test('a mixed Working group broadcast and explicit nonparticipant mention persists the failed target beside one participant wake', async (t) => {
  const harness = build({ turns: [scriptedTurn('Scout: noted.')] });
  t.after(harness.close);
  const groupId = (
    await harness.scopes.scopes.createWorkingGroup({
      projectId: 'project-sprout',
      displayName: 'Docs',
      creator: { memberId: 'human-lead', kind: 'human' },
      memberIds: ['scout'],
    })
  ).id;

  const delivered = await harness.coordinator.deliver({
    scopeId: groupId,
    author: { id: 'human-lead', kind: 'human' },
    body: '@all and @forge; @scout please review',
    deliveryKey: 'wg-mixed-1',
  });
  assert.deepEqual(delivered.wakes.map((wake) => `${wake.agentId}:${wake.reason}`), ['scout:broadcast']);
  assert.equal(delivered.admittedRunIds.length, 1);
  assert.deepEqual(harness.sqlite.collaboration.observations(delivered.message.id), [{
    agentId: 'forge',
    status: 'failed',
    reason: 'agent-mention',
    detail: 'addressed target is not a participant of this working group',
  }]);
  assert.deepEqual(harness.engine.requests.map((request) => request.agentId), ['scout']);
});


test('an ended Working group participation drops out of the group\'s routing participants', async (t) => {
  const harness = build({ turns: [scriptedTurn('Scout: here.')] });
  t.after(harness.close);
  const groupId = (
    await harness.scopes.scopes.createWorkingGroup({
      projectId: 'project-sprout',
      displayName: 'Docs',
      creator: { memberId: 'human-lead', kind: 'human' },
      memberIds: ['scout', 'scribe'],
    })
  ).id;
  await harness.scopes.scopes.endWorkingGroupMember(
    groupId,
    { memberId: 'human-lead', kind: 'human' },
    'scribe',
    { reason: 'off rotation' },
  );

  const broadcast = await harness.coordinator.deliver({
    scopeId: groupId,
    author: { id: 'human-lead', kind: 'human' },
    body: 'standup @all',
    deliveryKey: 'wg-ended-all-1',
  });
  assert.deepEqual(
    broadcast.wakes.map((wake) => wake.agentId),
    ['scout'],
    'only the current participation is wakeable',
  );

  const mention = await harness.coordinator.deliver({
    scopeId: groupId,
    author: { id: 'human-lead', kind: 'human' },
    body: '@scribe status?',
    deliveryKey: 'wg-ended-mention-1',
  });
  assert.deepEqual(mention.wakes, []);
  const observations = harness.sqlite.collaboration.observations(mention.message.id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.agentId, 'scribe');
  assert.equal(observations[0]?.status, 'failed');
  assert.match(observations[0]?.detail ?? '', /not a participant of this working group/);
  assert.equal(harness.engine.requests.length, 1, 'the ended participation never receives a run');
});


test('a completed run with private events projects only its final text', async (t) => {
  const harness = build({
    turns: [
      scriptedTurn('Scout: the answer.', [
        { type: 'tool-call', name: 'shell', detail: 'grep -r wake src' },
        { type: 'tool-output', text: 'TOOL_OUTPUT_MUST_NOT_LEAK' },
        { type: 'notice', text: 'PRIVATE_REASONING_MUST_NOT_LEAK' },
      ]),
    ],
  });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    scopeId: await harness.scopes.openDirect('project-sprout', ['human-lead', 'scout']),
    author: { id: 'human-lead', kind: 'human' },
    body: 'what did you find?',
    recipients: ['scout'],
    deliveryKey: 'private-1',
  });

  const reply = (await harness.sqlite.collaboration.listMessages()).find(
    (message) => message.author.kind === 'agent',
  );
  assert.ok(reply);
  assert.equal(reply.body, 'Scout: the answer.');
  assert.doesNotMatch(reply.body, /TOOL_OUTPUT_MUST_NOT_LEAK/);
  assert.doesNotMatch(reply.body, /PRIVATE_REASONING_MUST_NOT_LEAK/);

  // The private events are still durable on the run record, just not in
  // conversation: the exclusion is a projection rule, not data loss.
  const run = await harness.sqlite.runs.get(delivered.admittedRunIds[0]!);
  assert.ok(run?.events.some((event) => event.type === 'tool-output'));
});


test('an addressed Project event persists before admission and projects a non-routing reply', async (t) => {
  const harness = build({ turns: [scriptedTurn('Scout: unblocking.')] });
  t.after(harness.close);

  const published = await harness.coordinator.publishEvent({
    projectId: 'project-sprout',
    kind: 'task-blocker',
    summary: 'Task T1 is blocked on review',
    disposition: 'addressed',
    responsibleAgentIds: ['scout'],
    deliveryKey: 'event-1',
  });

  // Persistence-before-admission: the wake was durable before the run existed.
  assert.equal(published.wakes.length, 1);
  assert.equal(published.wakes[0]?.inputId, published.event.id);
  assert.equal(published.wakes[0]?.reason, 'event-addressed');
  assert.equal(published.wakes[0]?.status, 'admitted');
  assert.equal(published.admittedRunIds.length, 1);

  const replies = (await harness.sqlite.collaboration.listMessages()).filter(
    (message) => message.author.kind === 'agent',
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.body, 'Scout: unblocking.');
  assert.equal(replies[0]?.channel, 'project');
  assert.equal(replies[0]?.scopeId, 'channel-project-sprout');
  assert.equal(replies[0]?.inReplyTo, undefined, 'the projection is keyed to the event, not a Message');

  const prompt = harness.engine.sessions[0]?.prompts[0] ?? '';
  assert.match(prompt, /Project event "task-blocker"/);
});


test('a non-addressed Project event persists without any wake or run', async (t) => {
  const harness = build({ turns: [scriptedTurn('must not run')] });
  t.after(harness.close);

  for (const disposition of ['wake-eligible', 'informational', 'human-action-required', 'non-routing'] as const) {
    const published = await harness.coordinator.publishEvent({
      projectId: 'project-sprout',
      kind: 'run-completed',
      summary: 'Run finished',
      disposition,
      deliveryKey: `event-${disposition}`,
    });
    assert.deepEqual(published.wakes, []);
    assert.deepEqual(published.admittedRunIds, []);
    assert.equal(published.event.disposition, disposition);
  }

  assert.equal((await harness.sqlite.collaboration.listWakeRequests()).length, 0);
  assert.equal((await harness.sqlite.collaboration.listEvents('project-sprout')).length, 4);
  assert.equal(harness.engine.requests.length, 0, 'the engine was never consulted');
});

/** Bounded poll: live failure publication is asynchronous by design (#180). */
async function awaitFailureEvent(
  coordinator: Harness['coordinator'],
  projectId = 'project-sprout',
) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const events = (await coordinator.listEvents(projectId)).filter(
      (event) => event.kind === 'agent-run-failure',
    );
    if (events.length > 0) return events;
    if (Date.now() > deadline) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a failed Project-scoped run surfaces as one informational system failure event', async (t) => {
  const harness = build({
    turns: [
      {
        events: [{ type: 'tool-output', text: 'RUN_EVENT_MUST_NOT_LEAK' }],
        result: { status: 'failed', message: 'no available environment: engine turn failed' },
      },
    ],
  });
  t.after(harness.close);
  const scopeId = await harness.scopes.openDirect('project-sprout', ['human-lead', 'scout']);

  const delivered = await harness.coordinator.deliver({
    scopeId,
    author: { id: 'human-lead', kind: 'human' },
    body: 'Direct request that fails.',
    recipients: ['scout'],
    deliveryKey: 'direct-failed-1',
  });
  assert.equal(delivered.admittedRunIds.length, 1);
  const runId = delivered.admittedRunIds[0]!;

  const [event, ...rest] = await awaitFailureEvent(harness.coordinator);
  assert.ok(event, 'the terminal failure reached the Project event stream');
  assert.deepEqual(rest, [], 'exactly one event per terminal transition');
  assert.equal(event.kind, 'agent-run-failure');
  assert.equal(event.disposition, 'informational', 'labelled non-routing: no wake, no fan-out');
  assert.deepEqual(event.producer, { id: 'sprout', kind: 'system' });
  assert.equal(event.deliveryKey, `run-failure:${runId}`);
  assert.equal(event.projectId, 'project-sprout');
  assert.equal(event.summary, 'Agent run failed (execution) for scout');
  assert.equal((await harness.sqlite.runs.get(runId))?.failureClass, 'execution');
  assert.match(event.detail ?? '', new RegExp(`run ${runId}`));

  // Privacy: the prompt and the raw run events are structurally excluded.
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /Direct request that fails\./);
  assert.doesNotMatch(serialized, /RUN_EVENT_MUST_NOT_LEAK/);
  assert.doesNotMatch(serialized, /engine turn failed/);
  assert.doesNotMatch(serialized, /wrote:/, 'the wake prompt never enters the event');

  // No reply and no fan-out for the failure event itself.
  const agentMessages = (await harness.sqlite.collaboration.listMessages()).filter(
    (message) => message.author.kind === 'agent',
  );
  assert.deepEqual(agentMessages, [], 'a failed run projects no reply');
  assert.deepEqual(
    (await harness.coordinator.listWakeRequests()).filter((wake) => wake.inputId === event.id),
    [],
    'the informational event woke nobody',
  );

  // Idempotency across restart reconciliation: the scan sees the same run and
  // the same delivery key, so it reports no new work and stores no duplicate.
  const reconciled = await harness.coordinator.reconcile();
  assert.deepEqual(reconciled.failureEventRunIds, []);
  const after = (await harness.coordinator.listEvents('project-sprout')).filter(
    (candidate) => candidate.kind === 'agent-run-failure',
  );
  assert.equal(after.length, 1);
});

test('the no-available-environment admission failure still reaches its Project timeline', async (t) => {
  // The flagship preview failure: admission refuses before any environment
  // resolves, so the run must still carry its Project scope from submission
  // for the event to be attributable (#180).
  const harness = build({
    turns: [scriptedTurn('must not run')],
    projects: [{ ...project, availableEnvironmentInstanceIds: [] }],
  });
  t.after(harness.close);
  const scopeId = await harness.scopes.openDirect('project-sprout', ['human-lead', 'scout']);

  const delivered = await harness.coordinator.deliver({
    scopeId,
    author: { id: 'human-lead', kind: 'human' },
    body: 'Reconnect then investigate.',
    recipients: ['scout'],
    deliveryKey: 'direct-no-env-1',
  });
  assert.equal(delivered.admittedRunIds.length, 1);
  const runId = delivered.admittedRunIds[0]!;
  const agentMessages = (await harness.sqlite.collaboration.listMessages()).filter(
    (message) => message.author.kind === 'agent',
  );
  assert.deepEqual(agentMessages, [], 'the reply-less direct message stays reply-less');

  const [event] = await awaitFailureEvent(harness.coordinator);
  assert.ok(event, 'the admission failure is operator-visible');
  assert.match(event.summary, /Agent run failed \(environment\) for scout/);
  assert.equal((await harness.sqlite.runs.get(runId))?.failureClass, 'environment');
  assert.doesNotMatch(event.summary, /no available environment for capability: agent-run/);
  assert.equal(event.deliveryKey, `run-failure:${runId}`);
  assert.equal((await harness.coordinator.listEvents('project-sprout')).length, 1);
  assert.equal(harness.engine.requests.length, 0, 'the engine was never consulted');
});
