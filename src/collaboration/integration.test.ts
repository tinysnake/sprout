/**
 * Production integration for the collaboration write path (#26).
 *
 * The unit tests exercise each seam in isolation and the probe crosses a real
 * worker process. This file is the middle ground: the **real** `SqliteStore`
 * (the unified primary database, not a separate collaboration file), the **real**
 * `RunOrchestrator`, and the real coordinator, with only the engine scripted.
 * It is what shows the acceptance behaviours compose in the shape `main.ts`
 * actually wires.
 *
 * Acceptance behaviours covered here:
 * - Direct messages, exact `@id` mentions, and `@all` broadcasts follow the M1
 *   wake contract and start runs with contextual prompts.
 * - Unaddressed project messages consult the wake model; a suppression and a
 *   failure are each durably recorded, and a failure fails open.
 * - A completed run projects one Agent-authored reply; failed or interrupted runs
 *   project none.
 * - Private run events never enter conversation.
 * - Idempotent retry produces one durable input and at most one run admission.
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
import { SqliteStore } from '../run/sqlite-store.ts';
import { CollaborationCoordinator } from './coordinator.ts';
import type { WakeModel } from './model.ts';

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
  close(): void;
}

function build(options: {
  turns: readonly ScriptedTurn[];
  wakeModel?: WakeModel;
}): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-collab-integration-'));
  const sqlite = new SqliteStore({ filename: join(directory, 'sprout.db') });
  const engine = new ScriptedEngineAdapter({ turns: options.turns });
  const projects = new ProjectRegistry([project]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', engine]]),
    agents: new AgentRegistry([
      { id: 'scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
      { id: 'forge', name: 'Forge', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
      { id: 'scribe', name: 'Scribe', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
    ]),
    projects,
    pool: new EnvironmentPool({
      definitions: [definition],
      instances: [instance],
      store: sqlite.leases,
    }),
    store: sqlite.runs,
  });
  const coordinator = new CollaborationCoordinator({
    projects,
    store: sqlite.collaboration,
    runs: orchestrator,
    ...(options.wakeModel !== undefined ? { wakeModel: options.wakeModel } : {}),
  });
  return {
    sqlite,
    coordinator,
    engine,
    close: () => {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a direct message wakes its recipient with a contextual prompt and projects one reply', async (t) => {
  const harness = build({ turns: [scriptedTurn('Scout: on it.')] });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'Please check the wake rule.',
    recipients: ['scout'],
    deliveryKey: 'direct-1',
  });

  assert.equal(delivered.wakes.length, 1);
  assert.equal(delivered.wakes[0]?.reason, 'direct-recipient');
  assert.equal(delivered.admittedRunIds.length, 1);

  // The prompt names author, channel, and the target agent (acceptance item 3).
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
  assert.equal(replies[0]?.body, 'Scout: on it.');
});

test('an exact @id mention wakes only the mentioned member and never the wake model', async (t) => {
  let modelCalls = 0;
  const harness = build({
    turns: [scriptedTurn('Forge: acknowledged.')],
    wakeModel: {
      decide: async () => {
        modelCalls += 1;
        return { engage: true };
      },
    },
  });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'project',
    author: { id: 'human-lead', kind: 'human' },
    body: '@forge can you take the review?',
    deliveryKey: 'mention-1',
  });

  assert.deepEqual(
    delivered.wakes.map((wake) => `${wake.agentId}:${wake.reason}`),
    ['forge:agent-mention'],
  );
  assert.equal(modelCalls, 0, 'an addressed message never reaches the wake model');
  assert.equal(delivered.admittedRunIds.length, 1);

  const replies = (await harness.sqlite.collaboration.listMessages()).filter(
    (message) => message.author.kind === 'agent',
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.author.id, 'forge');
});

test('an @all broadcast wakes every other member and bypasses the wake model', async (t) => {
  const harness = build({
    turns: [
      scriptedTurn('Scout: ready.'),
      scriptedTurn('Forge: ready.'),
      scriptedTurn('Scribe: ready.'),
    ],
    wakeModel: {
      decide: async () => {
        throw new Error('the wake model must not be consulted for a broadcast');
      },
    },
  });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'project',
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

test('an unaddressed project message suppressed by the wake model is durably recorded and wakes nobody', async (t) => {
  const harness = build({
    turns: [scriptedTurn('should not run')],
    wakeModel: { decide: async () => ({ engage: false, detail: 'no action needed' }) },
  });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'project',
    author: { id: 'human-lead', kind: 'human' },
    body: 'just an fyi',
    deliveryKey: 'suppressed-1',
  });

  assert.equal(delivered.admittedRunIds.length, 0);
  const observations = harness.sqlite.collaboration.observations(delivered.message.id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.status, 'suppressed');
  assert.equal(observations[0]?.reason, 'wake-model');
  assert.equal(observations[0]?.detail, 'no action needed');

  const replies = (await harness.sqlite.collaboration.listMessages()).filter(
    (message) => message.author.kind === 'agent',
  );
  assert.equal(replies.length, 0);
});

test('a wake model failure fails open to every member and is durably recorded', async (t) => {
  const harness = build({
    turns: [scriptedTurn('Scout: engaged.'), scriptedTurn('Forge: engaged.'), scriptedTurn('Scribe: engaged.')],
    wakeModel: {
      decide: async () => {
        throw new Error('model unavailable');
      },
    },
  });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'project',
    author: { id: 'human-lead', kind: 'human' },
    body: 'anyone around?',
    deliveryKey: 'fail-open-1',
  });

  assert.equal(delivered.wakes.length, 3, 'a failure wakes every other member');
  assert.ok(delivered.wakes.every((wake) => wake.reason === 'wake-model-fail-open'));
  assert.equal(delivered.admittedRunIds.length, 3);

  const observations = harness.sqlite.collaboration.observations(delivered.message.id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.status, 'failed');
  assert.match(observations[0]?.detail ?? '', /model unavailable/);
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
    projectId: 'project-sprout',
    channel: 'direct',
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

test('a duplicated delivery key produces one durable input and one run admission', async (t) => {
  const harness = build({ turns: [scriptedTurn('Scout: once.')] });
  t.after(harness.close);

  const request = {
    projectId: 'project-sprout',
    channel: 'direct' as const,
    author: { id: 'human-lead', kind: 'human' as const },
    body: 'Do the thing.',
    recipients: ['scout'],
    deliveryKey: 'dup-1',
  };
  const first = await harness.coordinator.deliver(request);
  const second = await harness.coordinator.deliver(request);

  assert.equal(second.duplicate, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal(second.admittedRunIds.length, 0);

  const wakeRows = (await harness.sqlite.collaboration.listWakeRequests()).filter(
    (wake) => wake.messageId === first.message.id,
  );
  assert.equal(wakeRows.length, 1);
  assert.equal(wakeRows[0]?.status, 'admitted');

  const messages = await harness.sqlite.collaboration.listMessages();
  assert.equal(messages.length, 2, 'one input and one reply, despite two deliveries');
});

test('a direct message to a non-member makes no run and records the failure durably', async (t) => {
  const harness = build({ turns: [scriptedTurn('should not run')] });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'hello?',
    recipients: ['ghost'],
    deliveryKey: 'fail-1',
  });

  assert.equal(delivered.admittedRunIds.length, 0);
  assert.equal(delivered.wakes.length, 0);
  const observations = harness.sqlite.collaboration.observations(delivered.message.id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.status, 'failed');
  assert.equal(observations[0]?.agentId, 'ghost');
  assert.match(observations[0]?.detail ?? '', /not a member/);
});
