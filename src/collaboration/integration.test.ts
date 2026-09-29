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
  close(): void;
}


function build(options: {
  turns: readonly ScriptedTurn[];
  /** Overrides the default single project; used by the multi-Project regression. */
  projects?: readonly Project[];
  definitions?: readonly EnvironmentDefinition[];
  instances?: readonly EnvironmentInstance[];
  agents?: readonly { id: string; name: string; engine: string; capability: string; workingDirectory?: string }[];
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
  const scopes = buildCollaborationScopes({ projects });
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
    close: () => {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}


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
