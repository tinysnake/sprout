import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProjectEvent } from './events.ts';
import type { Message } from './model.ts';
import { parseAgentMentions, parseMentions, planEventWake, planWake, type WakeMember } from './wake.ts';

/**
 * The deterministic wake contract (#96, ADR-0007).
 *
 * Every branch here is decided from the input, its scope, and the Project's
 * member facts. There is no model to consult: deterministic addressing never
 * reaches one, and an unaddressed input is durable and visible rather than
 * guessed at or failed open.
 */

const members: readonly WakeMember[] = [
  { memberId: 'operator', memberKind: 'human' },
  { memberId: 'scout', memberKind: 'agent' },
  { memberId: 'forge', memberKind: 'agent' },
  { memberId: 'scribe', memberKind: 'agent' },
];

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    projectId: 'project-sprout',
    scopeId: 'channel-project-sprout',
    channel: 'project',
    author: { id: 'human-lead', kind: 'human' },
    body: 'hello',
    recipients: [],
    deliveryKey: 'delivery-1',
    createdAt: 1,
    ...overrides,
  };
}

function projectChannel() {
  return { members, scope: { kind: 'project' as const } };
}

/**
 * A Working group of `human-lead` and `scout`. `forge` and `scribe` are current
 * Project Agents outside the group: they must never receive a wake for this
 * scope's content (ADR-0008, #96 F1).
 */
const workingGroup = {
  members,
  scope: {
    kind: 'working-group' as const,
    participants: ['human-lead', 'scout'],
  },
};

test('an exact @id mention wakes exactly the mentioned member', () => {
  const plan = planWake(message({ body: 'please review, @forge' }), projectChannel());
  assert.deepEqual(plan.decisions, [{ agentId: 'forge', reason: 'agent-mention' }]);
  assert.deepEqual(plan.observations, []);
});

test('a mention is matched as a whole token, so @forge does not match @forge-two', () => {
  const withTwo: readonly WakeMember[] = [
    ...members,
    { memberId: 'forge-two', memberKind: 'agent' },
  ];
  assert.deepEqual(parseAgentMentions('@forge-two take this', ['forge', 'forge-two']), ['forge-two']);
  assert.deepEqual(parseAgentMentions('@forge take this', ['forge', 'forge-two']), ['forge']);

  const plan = planWake(message({ body: '@forge-two take this' }), {
    members: withTwo,
    scope: { kind: 'project' },
  });
  assert.deepEqual(plan.decisions, [{ agentId: 'forge-two', reason: 'agent-mention' }]);
});

test('mention parsing preserves unknown addressed targets', () => {
  assert.deepEqual(parseMentions('@forge and @ghost, please review', ['forge']), {
    members: ['forge'],
    unknown: ['ghost'],
  });
});

test('an unknown @id is a failed addressed target; valid targets still wake', () => {
  const plan = planWake(message({ body: '@ghost and @forge please review' }), projectChannel());
  assert.deepEqual(plan.decisions, [{ agentId: 'forge', reason: 'agent-mention' }]);
  assert.deepEqual(plan.observations, [
    {
      agentId: 'ghost',
      status: 'failed',
      reason: 'agent-mention',
      detail: 'addressed target is not a member of project project-sprout',
    },
  ]);
});

test('a mention of a membership that ended is a durable failure, not a guess', () => {
  const plan = planWake(message({ body: '@scribe review this' }), {
    members: members.map((member) =>
      member.memberId === 'scribe' ? { ...member, endedAt: 5 } : member,
    ),
    scope: { kind: 'project' },
  });
  assert.deepEqual(plan.decisions, []);
  assert.equal(plan.observations[0]?.status, 'failed');
  assert.match(plan.observations[0]?.detail ?? '', /membership in project project-sprout has ended/);
});

test('a mention of a Human member is a known non-wakeable target, not a failure', () => {
  const plan = planWake(message({ body: '@operator please look' }), projectChannel());
  assert.deepEqual(plan.decisions, []);
  assert.deepEqual(plan.observations, []);
});

test('@all is a broadcast that wakes every current Agent except the author', () => {
  const plan = planWake(message({ body: 'standup @all' }), projectChannel());
  assert.deepEqual(
    plan.decisions.map((decision) => decision.agentId).sort(),
    ['forge', 'scout', 'scribe'],
  );
  assert.ok(plan.decisions.every((decision) => decision.reason === 'broadcast'));
  // The Human member is not a wake target even though it is a current member.
  assert.ok(!plan.decisions.some((decision) => decision.agentId === 'operator'));
});

test('the author is never woken by its own message, even by @all', () => {
  const plan = planWake(
    message({ author: { id: 'scout', kind: 'agent' }, body: '@all' }),
    projectChannel(),
  );
  assert.ok(!plan.decisions.some((decision) => decision.agentId === 'scout'));
  assert.deepEqual(
    plan.decisions.map((decision) => decision.agentId).sort(),
    ['forge', 'scribe'],
  );
});

test('a target named by more than one addressing form wakes exactly once', () => {
  // `@all` and `@forge` in one body collapse into one (input, Agent) wake, and
  // the store's idempotency key would refuse a second one anyway.
  const plan = planWake(message({ body: '@all @forge @forge standup' }), projectChannel());
  const ids = plan.decisions.map((decision) => decision.agentId);
  assert.deepEqual([...ids].sort(), ['forge', 'scout', 'scribe']);
  assert.equal(new Set(ids).size, ids.length, 'deduplicated per input and Agent');
});

test('a direct message wakes exactly its declared recipients', () => {
  const plan = planWake(
    message({
      scopeId: 'dm-1',
      channel: 'direct',
      recipients: ['scout'],
      body: 'ping',
    }),
    { members, scope: { kind: 'direct', participants: ['human-lead', 'scout'] } },
  );
  assert.deepEqual(plan.decisions, [{ agentId: 'scout', reason: 'direct-recipient' }]);
});

test('a direct message without declared recipients defaults to the other participant', () => {
  const plan = planWake(
    message({ scopeId: 'dm-1', channel: 'direct', body: 'ping' }),
    { members, scope: { kind: 'direct', participants: ['human-lead', 'forge'] } },
  );
  assert.deepEqual(plan.decisions, [{ agentId: 'forge', reason: 'direct-recipient' }]);
});

test('a direct target outside the conversation pair is a durable failure', () => {
  const plan = planWake(
    message({ scopeId: 'dm-1', channel: 'direct', recipients: ['scribe'], body: 'ping' }),
    { members, scope: { kind: 'direct', participants: ['human-lead', 'scout'] } },
  );
  assert.deepEqual(plan.decisions, []);
  assert.equal(plan.observations[0]?.status, 'failed');
  assert.match(plan.observations[0]?.detail ?? '', /not a participant of this direct conversation/);
});

test('a direct message to a non-member is reported, not silently dropped', () => {
  const plan = planWake(
    message({ scopeId: 'dm-1', channel: 'direct', recipients: ['ghost'], body: 'ping' }),
    { members, scope: { kind: 'direct', participants: ['human-lead', 'ghost'] } },
  );
  assert.deepEqual(plan.decisions, []);
  assert.equal(plan.observations.length, 1);
  assert.equal(plan.observations[0]?.status, 'failed');
  assert.match(plan.observations[0]?.detail ?? '', /not a member/);
});

test('a Working group broadcast wakes only the group\'s current participant Agents', () => {
  // `forge` and `scribe` are current Project Agents; only `scout` (plus the
  // Human creator) participates in this group, so only `scout` may be woken by
  // group-only content.
  const plan = planWake(
    message({ scopeId: 'wg-1', channel: 'working-group', body: '@all standup' }),
    workingGroup,
  );
  assert.deepEqual(
    plan.decisions.map((decision) => decision.agentId).sort(),
    ['scout'],
    'an Agent outside the group never receives a wake for group-only content',
  );
  assert.ok(plan.decisions.every((decision) => decision.reason === 'broadcast'));
  assert.deepEqual(
    plan.observations,
    [],
    'a nonparticipant was never addressed, so its exclusion is not a failure',
  );
});

test('a Working group mention of a Project Agent outside the group is a durable failure while the participant still wakes', () => {
  const plan = planWake(
    message({ scopeId: 'wg-1', channel: 'working-group', body: '@forge and @scout please review' }),
    workingGroup,
  );
  assert.deepEqual(plan.decisions, [{ agentId: 'scout', reason: 'agent-mention' }]);
  assert.deepEqual(plan.observations, [
    {
      agentId: 'forge',
      status: 'failed',
      reason: 'agent-mention',
      detail: 'addressed target is not a participant of this working group',
    },
  ]);
});

test('a Working group mention of a Human participant is a known non-wakeable target', () => {
  const plan = planWake(
    message({ scopeId: 'wg-1', channel: 'working-group', body: '@operator please look' }),
    { members, scope: { kind: 'working-group', participants: ['operator', 'scout'] } },
  );
  assert.deepEqual(plan.decisions, []);
  assert.deepEqual(plan.observations, []);
});

test('a Working group without participant facts fails closed instead of widening to the Project', () => {
  const scope = { kind: 'working-group' as const };
  const broadcast = planWake(
    message({ scopeId: 'wg-1', channel: 'working-group', body: '@all standup' }),
    { members, scope },
  );
  assert.deepEqual(broadcast.decisions, [], 'no participant facts means no broadcast recipient');

  const mentioned = planWake(
    message({ scopeId: 'wg-1', channel: 'working-group', body: '@scout hi' }),
    { members, scope },
  );
  assert.deepEqual(mentioned.decisions, []);
  assert.equal(mentioned.observations[0]?.status, 'failed');
});

test('an unaddressed input wakes nobody and records a durable suppression', () => {
  for (const scope of [
    { kind: 'project' as const },
    { kind: 'working-group' as const, participants: ['human-lead', 'scout'] },
  ]) {
    const plan = planWake(message({ body: 'fyi, no question here' }), { members, scope });
    assert.deepEqual(plan.decisions, [], 'no member is woken by guesswork');
    assert.equal(plan.observations.length, 1);
    assert.equal(plan.observations[0]?.status, 'suppressed');
    assert.equal(plan.observations[0]?.reason, 'unaddressed');
    assert.match(plan.observations[0]?.detail ?? '', /remains durable/);
  }
});

test('a direct message with no wakeable participant wakes nobody without failure', () => {
  const plan = planWake(
    message({ scopeId: 'dm-2', channel: 'direct', body: 'ping' }),
    { members, scope: { kind: 'direct', participants: ['operator', 'human-lead'] } },
  );
  assert.deepEqual(plan.decisions, []);
  assert.deepEqual(plan.observations, [], 'a Human participant is not an invalid target');
});

// --- Project events (ADR-0007 dispositions) ---

function event(overrides: Partial<ProjectEvent> = {}): ProjectEvent {
  return {
    id: 'evt-1',
    projectId: 'project-sprout',
    kind: 'task-blocker',
    summary: 'Task blocked on review',
    producer: { id: 'sprout', kind: 'system' },
    disposition: 'addressed',
    responsibleAgentIds: ['forge'],
    deliveryKey: 'event-delivery-1',
    createdAt: 1,
    ...overrides,
  };
}

test('an addressed Project event routes to its responsible Agent deterministically', () => {
  const plan = planEventWake(event(), { members });
  assert.deepEqual(plan.decisions, [{ agentId: 'forge', reason: 'event-addressed' }]);
  assert.deepEqual(plan.observations, []);
});

test('an addressed event deduplicates targets and excludes its producer', () => {
  const plan = planEventWake(
    event({ responsibleAgentIds: ['forge', 'forge', 'scout'], producer: { id: 'scout', kind: 'agent' } }),
    { members },
  );
  assert.deepEqual(
    plan.decisions.map((decision) => decision.agentId).sort(),
    ['forge'],
    'the producer is never woken by its own event and duplicates collapse',
  );
});

test('an addressed event with an invalid target keeps the failure beside the valid wake', () => {
  const plan = planEventWake(event({ responsibleAgentIds: ['ghost', 'scout'] }), { members });
  assert.deepEqual(plan.decisions, [{ agentId: 'scout', reason: 'event-addressed' }]);
  assert.equal(plan.observations[0]?.status, 'failed');
  assert.match(plan.observations[0]?.detail ?? '', /not a member of project project-sprout/);
});

for (const disposition of ['wake-eligible', 'informational', 'human-action-required', 'non-routing'] as const) {
  test(`a ${disposition} event never routes by itself`, () => {
    const plan = planEventWake(event({ disposition, responsibleAgentIds: [] }), { members });
    assert.deepEqual(plan.decisions, []);
    assert.deepEqual(plan.observations, []);
  });
}
