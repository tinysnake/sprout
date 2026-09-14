import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter, type ScriptedTurn } from '../engine/scripted.ts';
import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { CollaborationCoordinator, renderWakePrompt } from './coordinator.ts';
import { InMemoryCollaborationStore } from './store.ts';
import type { WakeModel } from './model.ts';

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };
const project: Project = {
  id: 'project-sprout',
  goal: 'Ship Sprout',
  rules: [],
  availableEnvironmentInstanceIds: ['mac-mini-1'],
  memberships: [
    { agentId: 'scout', responsibilities: [], collaborationInstructions: '' },
  ],
};

function build(options: { turns: readonly ScriptedTurn[]; wakeModel?: WakeModel }) {
  const engine = new ScriptedEngineAdapter({ turns: options.turns });
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });
  const projects = new ProjectRegistry([project]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', engine]]),
    agents: new AgentRegistry([
      {
        id: 'scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/tmp',
      },
    ]),
    projects,
    pool,
    store: new InMemoryRunStore(),
  });
  const store = new InMemoryCollaborationStore();
  const coordinator = new CollaborationCoordinator({
    projects,
    store,
    runs: orchestrator,
    ...(options.wakeModel !== undefined ? { wakeModel: options.wakeModel } : {}),
  });
  return { coordinator, store, engine, orchestrator };
}

function completedTurn(text: string): ScriptedTurn {
  return { events: [{ type: 'message', text, final: true }], result: { status: 'completed', text } };
}

test('a completed run projects exactly one reply attributed to the run\'s agent', async () => {
  const { coordinator, store } = build({ turns: [completedTurn('Done.')] });
  const delivered = await coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'status?',
    recipients: ['scout'],
    deliveryKey: 'd1',
  });

  const messages = await store.listMessages();
  const reply = messages.find((message) => message.author.kind === 'agent');
  assert.ok(reply);
  assert.equal(reply.author.id, 'scout');
  assert.equal(reply.body, 'Done.');
  assert.equal(reply.inReplyTo, delivered.message.id);
});

test('a failed run produces no reply: an answer never produced is not fabricated', async () => {
  const { coordinator, store } = build({
    turns: [{ events: [], result: { status: 'failed', message: 'provider down' } }],
  });
  const delivered = await coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'status?',
    recipients: ['scout'],
    deliveryKey: 'd2',
  });

  assert.equal(delivered.admittedRunIds.length, 1, 'the run was admitted');
  const messages = await store.listMessages();
  assert.equal(messages.filter((message) => message.author.kind === 'agent').length, 0);
});

test('an interrupted run produces no reply', async () => {
  const { coordinator, store } = build({
    turns: [{ events: [], result: { status: 'interrupted' } }],
  });
  await coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'status?',
    recipients: ['scout'],
    deliveryKey: 'd3',
  });
  const messages = await store.listMessages();
  assert.equal(messages.filter((message) => message.author.kind === 'agent').length, 0);
});

test('the run prompt names the author, channel, and the agent being woken', async () => {
  const { coordinator, engine } = build({ turns: [completedTurn('ok')] });
  await coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'project',
    author: { id: 'human-lead', kind: 'human' },
    body: 'please review the wake rule',
    deliveryKey: 'd4',
  });

  const prompt = engine.sessions[0]?.prompts[0] ?? '';
  assert.match(prompt, /human human-lead wrote:/);
  assert.match(prompt, /please review the wake rule/);
  assert.match(prompt, /the project channel/);
  assert.match(prompt, /You are scout/);
});

test('the wake plan\'s non-wake observations are surfaced to the observer', async () => {
  const seen: string[] = [];
  const engine = new ScriptedEngineAdapter({ turns: [completedTurn('ok')] });
  const projects = new ProjectRegistry([project]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', engine]]),
    agents: new AgentRegistry([
      { id: 'scout', name: 'Scout', engine: 'scripted', capability: 'agent-run' },
    ]),
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
  });
  const coordinator = new CollaborationCoordinator({
    projects,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
    wakeModel: { decide: async () => ({ engage: false, detail: 'nothing to do' }) },
    onObservation: ({ observation }) => seen.push(`${observation.status}:${observation.detail}`),
  });

  await coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'project',
    author: { id: 'human-lead', kind: 'human' },
    body: 'fyi',
    deliveryKey: 'd5',
  });

  assert.deepEqual(seen, ['suppressed:nothing to do']);
});

test('renderWakePrompt presents the message verbatim without summarising it', () => {
  const prompt = renderWakePrompt(
    {
      id: 'msg-1',
      projectId: 'project-sprout',
      channel: 'direct',
      author: { id: 'human-lead', kind: 'human' },
      body: 'exact words: 42',
      recipients: ['scout'],
      deliveryKey: 'd6',
      createdAt: 1,
    },
    'scout',
  );
  assert.match(prompt, /exact words: 42/);
});

test('admission is idempotent even if a wake is admitted twice directly', async () => {
  const { coordinator, store } = build({ turns: [completedTurn('ok')] });
  const delivered = await coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'go',
    recipients: ['scout'],
    deliveryKey: 'd7',
  });
  const key = delivered.wakes[0]!.idempotencyKey;

  const first = await store.admitWake({ idempotencyKey: key, runId: 'run-a', now: 1 });
  const second = await store.admitWake({ idempotencyKey: key, runId: 'run-b', now: 2 });
  assert.equal(first.admitted, false, 'already admitted by delivery');
  assert.equal(second.admitted, false);
  assert.equal(second.wake.runId, delivered.admittedRunIds[0], 'the first run keeps the wake');
});
