import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isFeedDeepLink, projectFeed, type FeedSources } from './feed.ts';
import type { ProjectEvent } from '../collaboration/events.ts';
import type { AgentRun } from '../run/model.ts';

interface TaskGroupSource {
  readonly scopeId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly leadKind?: 'human' | 'agent';
  readonly createdAt: number;
}

interface TaskGroupMessageSource {
  readonly id: string;
  readonly projectId: string;
  readonly scopeId: string;
  readonly kind: 'handoff' | 'assignment' | 'question' | 'escalation' | 'status';
  readonly authorKind: 'human' | 'agent';
  readonly inReplyTo?: string;
  readonly createdAt: number;
}

interface GroupEventInput extends Partial<ProjectEvent> {
  readonly originMessageId?: string;
}

function groupEvent(overrides: GroupEventInput & Pick<ProjectEvent, 'id' | 'projectId' | 'kind' | 'disposition'>): ProjectEvent {
  return {
    summary: `Recorded ${overrides.kind}`,
    producer: { id: 'sprout', kind: 'system' },
    responsibleAgentIds: [],
    deliveryKey: `delivery:${overrides.id}`,
    createdAt: 10,
    ...overrides,
  } as ProjectEvent;
}

function sources(input: {
  readonly groups?: readonly TaskGroupSource[];
  readonly messages?: readonly TaskGroupMessageSource[];
  readonly events?: readonly ProjectEvent[];
  readonly escalations?: readonly { eventId: string; messageId: string; scopeId: string; projectId: string; at: number }[];
  readonly runs?: readonly AgentRun[];
}): FeedSources {
  return {
    projects: async () => [{ id: 'project-1', displayName: 'Project One' }],
    tasks: async () => [],
    proposals: async () => [],
    events: async () => input.events ?? [],
    enrollments: async () => [],
    recoveries: async () => [],
    runs: async () => input.runs ?? [],
    routingBatches: async () => [],
    wakeFailures: async () => [],
    attentionResolutions: async () => [],
    taskGroups: async () => input.groups ?? [],
    taskGroupMessages: async () => input.messages ?? [],
    taskGroupEscalations: async () => input.escalations ?? [],
  } as unknown as FeedSources;
}

const group: TaskGroupSource = {
  scopeId: 'tg-task-1', projectId: 'project-1', taskId: 'task-1',
  taskTitle: 'Implement bounded retries', createdAt: 5,
};

function taskMessage(id: string, kind: TaskGroupMessageSource['kind'], createdAt: number): TaskGroupMessageSource {
  return {
    id, kind, authorKind: 'agent', createdAt, projectId: group.projectId, scopeId: group.scopeId,
  };
}

test('task-group creation, handoff, assignment, and escalation each produce one focused Feed event', async () => {
  const escalation = groupEvent({
    id: 'event-escalation', projectId: group.projectId, kind: 'task-group-unanswered',
    disposition: 'human-action-required', deliveryKey: 'task-group:message-escalated:attention',
    originScopeIds: [group.scopeId], createdAt: 40,
  });
  const retry = groupEvent({
    ...escalation, id: 'event-escalation-retry', createdAt: 41,
  });
  const snapshot = await projectFeed(sources({
    groups: [group],
    messages: [
      taskMessage('message-handoff', 'handoff', 20),
      taskMessage('message-assignment', 'assignment', 30),
      taskMessage('message-escalated', 'status', 35),
      taskMessage('message-handoff', 'handoff', 20),
    ],
    events: [escalation, retry],
    escalations: [{ eventId: escalation.id, messageId: 'message-escalated', scopeId: group.scopeId, projectId: group.projectId, at: 40 }],
  }));

  const groupActivity = snapshot.activity.filter((item) => item.kind.startsWith('task-group-'));
  assert.deepEqual(groupActivity.map((item) => item.kind), [
    'task-group-escalation', 'task-group-assignment', 'task-group-handoff', 'task-group-created',
  ]);
  assert.equal(groupActivity.length, 4, 'duplicate message and escalation deliveries collapse by stable identity');
  assert.deepEqual(groupActivity.map((item) => item.id), [
    'event:event-escalation',
    'task-group-message:message-assignment',
    'task-group-message:message-handoff',
    `task-group-created:${group.scopeId}`,
  ]);
  assert.match(groupActivity[0]!.summary, /Implement bounded retries/);
  assert.deepEqual(
    [groupActivity[0]!.target?.surface, groupActivity[0]!.target?.scopeId, groupActivity[0]!.target?.messageId],
    ['project-chat', group.scopeId, 'message-escalated'],
  );
  for (const item of groupActivity) assert.ok(isFeedDeepLink(item.target), `${item.id} has a valid Chat destination`);
  assert.deepEqual(snapshot.attention.map((item) => item.category), ['task-group-escalation']);
  assert.equal(snapshot.attention[0]?.target.messageId, 'message-escalated');
});

test('escalation, Human-lead waiting, and Human-directed questions each produce one notify-only Attention item', async () => {
  const humanGroup = { ...group, scopeId: 'tg-task-human', taskId: 'task-human', leadKind: 'human' as const };
  const escalation = groupEvent({
    id: 'event-escalation', projectId: group.projectId, kind: 'task-group-unanswered',
    disposition: 'human-action-required', deliveryKey: 'task-group:message-escalation:attention',
    originScopeIds: [group.scopeId], createdAt: 50,
  });
  const waiting = groupEvent({
    id: 'event-waiting', projectId: humanGroup.projectId, kind: 'task-group-unanswered',
    disposition: 'human-action-required', deliveryKey: 'task-group:message-waiting:attention',
    originScopeIds: [humanGroup.scopeId], createdAt: 40,
  });
  const retries = [escalation, waiting].map((signal, index) => groupEvent({
    ...signal, id: `retry-${index}`, createdAt: signal.createdAt + 1,
  }));
  const snapshot = await projectFeed(sources({
    groups: [group, humanGroup],
    messages: [
      taskMessage('message-escalation', 'status', 49),
      { ...taskMessage('message-waiting', 'status', 39), projectId: humanGroup.projectId, scopeId: humanGroup.scopeId },
      { ...taskMessage('message-question', 'question', 29), projectId: humanGroup.projectId, scopeId: humanGroup.scopeId },
      { ...taskMessage('cross-scope-reply', 'status', 30), inReplyTo: 'message-question' },
      { ...taskMessage('answered-question', 'question', 27), projectId: humanGroup.projectId, scopeId: humanGroup.scopeId },
      { ...taskMessage('human-answer', 'status', 31), projectId: humanGroup.projectId, scopeId: humanGroup.scopeId, authorKind: 'human', inReplyTo: 'answered-question' },
    ],
    events: [escalation, waiting, ...retries],
    escalations: [
      { eventId: escalation.id, messageId: 'message-escalation', scopeId: group.scopeId, projectId: group.projectId, at: 50 },
      { eventId: waiting.id, messageId: 'message-waiting', scopeId: humanGroup.scopeId, projectId: humanGroup.projectId, at: 40 },
    ],
  }));

  assert.deepEqual(snapshot.attention.map((item) => item.category), [
    'task-group-escalation', 'task-group-human-waiting', 'task-group-human-question',
  ]);
  assert.equal(snapshot.attention.length, 3, 'one item remains for each stable incident or unanswered question');
  assert.deepEqual(snapshot.attention.map((item) => item.target.messageId), [
    'message-escalation', 'message-waiting', 'message-question',
  ]);
  assert.ok(snapshot.attention.every((item) => item.target.surface === 'project-chat' && isFeedDeepLink(item.target)));
});

test('a run-lifecycle failure remains one existing #180 Feed event', async () => {
  const run = {
    id: 'run-failed', agentId: 'agent-1', projectId: group.projectId,
    status: 'failed', prompt: 'private prompt', environmentInstanceId: 'env-1', events: [], createdAt: 25, completedAt: 30,
  } as const;
  const event = groupEvent({
    id: 'event-run-failure', projectId: group.projectId, kind: 'agent-run-failure',
    disposition: 'informational', deliveryKey: 'run-failure:run-failed', createdAt: 30,
  });
  const snapshot = await projectFeed(sources({ events: [event], runs: [run] }));
  assert.deepEqual(snapshot.activity.map((item) => item.id), ['event:event-run-failure']);
  assert.equal(snapshot.activity.filter((item) => item.kind === 'agent-run').length, 0);
  assert.ok(!JSON.stringify(snapshot).includes('private prompt'));
});

