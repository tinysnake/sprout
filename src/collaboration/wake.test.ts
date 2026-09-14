import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';
import type { Message, WakeModel } from './model.ts';
import { parseAgentMentions, parseMentions, planWake } from './wake.ts';

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

function registry(): ProjectRegistry {
  return new ProjectRegistry([project]);
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    projectId: 'project-sprout',
    channel: 'project',
    author: { id: 'human-lead', kind: 'human' },
    body: 'hello',
    recipients: [],
    deliveryKey: 'delivery-1',
    createdAt: 1,
    ...overrides,
  };
}

function fakeWakeModel(engage: boolean, detail?: string): WakeModel {
  return {
    decide: async () => (detail !== undefined ? { engage, detail } : { engage }),
  };
}

test('an exact @id mention wakes exactly the mentioned member and never the model', async () => {
  let calls = 0;
  const model: WakeModel = {
    decide: async () => {
      calls += 1;
      return { engage: true };
    },
  };
  const plan = await planWake(message({ body: 'please review, @forge' }), {
    projects: registry(),
    wakeModel: model,
  });

  assert.deepEqual(plan.decisions, [{ agentId: 'forge', reason: 'agent-mention' }]);
  assert.equal(calls, 0, 'an addressed message never reaches the wake model');
});

test('a mention is matched as a whole token, so @forge does not match @forge-two', async () => {
  const withTwo = new ProjectRegistry([
    {
      ...project,
      memberships: [
        ...project.memberships,
        { agentId: 'forge-two', responsibilities: [], collaborationInstructions: '' },
      ],
    },
  ]);
  assert.deepEqual(parseAgentMentions('@forge-two take this', ['forge', 'forge-two']), ['forge-two']);
  assert.deepEqual(parseAgentMentions('@forge take this', ['forge', 'forge-two']), ['forge']);

  const plan = await planWake(message({ body: '@forge-two take this' }), { projects: withTwo });
  assert.deepEqual(plan.decisions, [{ agentId: 'forge-two', reason: 'agent-mention' }]);
});

test('mention parsing preserves unknown addressed targets', () => {
  assert.deepEqual(parseMentions('@forge and @ghost, please review', ['forge']), {
    members: ['forge'],
    unknown: ['ghost'],
  });
});

test('an unknown @id is a failed addressed target and never reaches the model', async () => {
  let calls = 0;
  const plan = await planWake(message({ body: '@ghost please review' }), {
    projects: registry(),
    wakeModel: {
      decide: async () => {
        calls += 1;
        return { engage: true };
      },
    },
  });

  assert.deepEqual(plan.decisions, []);
  assert.deepEqual(plan.observations, [
    {
      agentId: 'ghost',
      status: 'failed',
      reason: 'agent-mention',
      detail: 'addressed agent is not a member of project project-sprout',
    },
  ]);
  assert.equal(calls, 0, 'an addressed unknown target never reaches the wake model');
});

test('@all is a broadcast that wakes every other member and bypasses the model', async () => {
  let calls = 0;
  const plan = await planWake(message({ body: 'standup @all' }), {
    projects: registry(),
    wakeModel: {
      decide: async () => {
        calls += 1;
        return { engage: true };
      },
    },
  });

  assert.deepEqual(
    plan.decisions.map((decision) => decision.agentId).sort(),
    ['forge', 'scout', 'scribe'],
  );
  assert.ok(plan.decisions.every((decision) => decision.reason === 'broadcast'));
  assert.equal(calls, 0);
});

test('a direct message wakes exactly its declared recipients', async () => {
  const plan = await planWake(
    message({ channel: 'direct', recipients: ['scout'], body: 'ping' }),
    { projects: registry() },
  );
  assert.deepEqual(plan.decisions, [{ agentId: 'scout', reason: 'direct-recipient' }]);
});

test('a direct message to a non-member is reported, not silently dropped', async () => {
  const plan = await planWake(
    message({ channel: 'direct', recipients: ['ghost'], body: 'ping' }),
    { projects: registry() },
  );
  assert.deepEqual(plan.decisions, []);
  assert.equal(plan.observations.length, 1);
  assert.equal(plan.observations[0]?.status, 'failed');
  assert.match(plan.observations[0]?.detail ?? '', /not a member/);
});

test('the author is never woken by its own message', async () => {
  const plan = await planWake(
    message({ author: { id: 'scout', kind: 'agent' }, body: '@all' }),
    { projects: registry() },
  );
  assert.ok(!plan.decisions.some((decision) => decision.agentId === 'scout'));
});

test('an unaddressed project message wakes every member when the model engages', async () => {
  const plan = await planWake(message({ body: 'anyone free?' }), {
    projects: registry(),
    wakeModel: fakeWakeModel(true),
  });
  assert.deepEqual(
    plan.decisions.map((decision) => decision.agentId).sort(),
    ['forge', 'scout', 'scribe'],
  );
  assert.ok(plan.decisions.every((decision) => decision.reason === 'wake-model'));
});

test('an unaddressed message the model suppresses is recorded, never silent', async () => {
  const plan = await planWake(message({ body: 'fyi' }), {
    projects: registry(),
    wakeModel: fakeWakeModel(false, 'no action needed'),
  });
  assert.deepEqual(plan.decisions, []);
  assert.equal(plan.observations.length, 1);
  assert.equal(plan.observations[0]?.status, 'suppressed');
  assert.match(plan.observations[0]?.detail ?? '', /no action needed/);
});

test('a wake model that throws fails open to one extra wake per member', async () => {
  const plan = await planWake(message({ body: 'anyone?' }), {
    projects: registry(),
    wakeModel: {
      decide: async () => {
        throw new Error('model unavailable');
      },
    },
  });
  assert.deepEqual(
    plan.decisions.map((decision) => decision.agentId).sort(),
    ['forge', 'scout', 'scribe'],
  );
  assert.ok(plan.decisions.every((decision) => decision.reason === 'wake-model-fail-open'));
  assert.equal(plan.observations[0]?.status, 'failed');
});

for (const [name, result] of [
  ['undefined', undefined],
  ['null', null],
  ['a non-object', 'engage'],
  ['a non-boolean engage value', { engage: 'yes' }],
  ['a missing engage value', {}],
] as const) {
  test(`a wake model returning ${name} fails open with a durable failure plan`, async () => {
    const plan = await planWake(message({ body: 'anyone?' }), {
      projects: registry(),
      wakeModel: { decide: async () => result } as unknown as WakeModel,
    });

    assert.deepEqual(
      plan.decisions.map((decision) => decision.agentId).sort(),
      ['forge', 'scout', 'scribe'],
    );
    assert.ok(plan.decisions.every((decision) => decision.reason === 'wake-model-fail-open'));
    assert.equal(plan.observations[0]?.status, 'failed');
    assert.match(plan.observations[0]?.detail ?? '', /invalid-verdict/);
  });
}

test('with no wake model configured, an unaddressed message fails open', async () => {
  const plan = await planWake(message({ body: 'anyone?' }), { projects: registry() });
  assert.equal(plan.decisions.length, 3);
  assert.ok(plan.decisions.every((decision) => decision.reason === 'wake-model-fail-open'));
});

test('an unknown project yields an explicit failure, not an empty plan', async () => {
  const plan = await planWake(message({ projectId: 'nope' }), { projects: registry() });
  assert.deepEqual(plan.decisions, []);
  assert.equal(plan.observations[0]?.status, 'failed');
  assert.match(plan.observations[0]?.detail ?? '', /unknown project/);
});
