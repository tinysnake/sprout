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
import type { AgentRun } from '../run/model.ts';
import { ConversationScopeError } from '../conversation/model.ts';
import {
  CollaborationCoordinator,
  MessageDeliveryError,
  renderWakePrompt,
  type RunAdmitter,
} from './coordinator.ts';
import { ProjectEventError } from './events.ts';
import { InMemoryCollaborationStore } from './store.ts';
import { buildCollaborationScopes, type CollaborationScopeHarness } from './scope-harness.ts';

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

function build(options: {
  turns: readonly ScriptedTurn[];
  /** Fixture Project lifecycle, projected into scope admission state. */
  statusOf?: (projectId: string) => 'active' | 'archived';
}) {
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
  const scopes = buildCollaborationScopes({
    projects,
    ...(options.statusOf !== undefined ? { statusOf: options.statusOf } : {}),
  });
  const coordinator = new CollaborationCoordinator({
    scopes: scopes.scopes,
    store,
    runs: orchestrator,
  });
  return { coordinator, store, engine, orchestrator, scopes };
}

function completedTurn(text: string): ScriptedTurn {
  return { events: [{ type: 'message', text, final: true }], result: { status: 'completed', text } };
}

/** The fixture's Project-scoped direct conversation (Human author, Scout). */
function directScope(scopes: CollaborationScopeHarness): Promise<string> {
  return scopes.openDirect('project-sprout', ['human-lead', 'scout']);
}

test('a completed run projects exactly one reply attributed to the run\'s agent', async () => {
  const { coordinator, store, scopes } = build({ turns: [completedTurn('Done.')] });
  const delivered = await coordinator.deliver({
    scopeId: await directScope(scopes),
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
  assert.equal(reply.scopeId, delivered.message.scopeId, 'the reply stays in the input scope');
});

test('a non-blocking delivery admits its wake immediately and projects after settlement', async () => {
  let settle: ((run: AgentRun) => void) | undefined;
  const finished = new Promise<AgentRun>((resolve) => {
    settle = resolve;
  });
  const store = new InMemoryCollaborationStore();
  const projects = new ProjectRegistry([project]);
  const scopes = buildCollaborationScopes({ projects });
  const coordinator = new CollaborationCoordinator({
    scopes: scopes.scopes,
    store,
    runs: {
      submit: async () => ({ id: 'run-later' }),
      waitFor: async () => finished,
    },
  });

  const delivered = await coordinator.deliver({
    scopeId: await directScope(scopes),
    author: { id: 'human-lead', kind: 'human' },
    body: 'take your time',
    recipients: ['scout'],
    deliveryKey: 'd1-non-blocking',
    awaitReply: false,
  });
  assert.deepEqual(delivered.admittedRunIds, ['run-later']);
  assert.equal((await store.listMessages()).length, 1, 'the reply is correctly still pending');

  settle?.({
    id: 'run-later', agentId: 'scout', prompt: '', environmentInstanceId: 'mac-mini-1',
    status: 'completed', events: [], createdAt: 0,
    result: { status: 'completed', text: 'finished later' },
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await store.listMessages()).length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const reply = (await store.listMessages()).find((message) => message.author.kind === 'agent');
  assert.equal(reply?.body, 'finished later');
});

test('a failed run produces no reply: an answer never produced is not fabricated', async () => {
  const { coordinator, store, scopes } = build({
    turns: [{ events: [], result: { status: 'failed', message: 'provider down' } }],
  });
  const delivered = await coordinator.deliver({
    scopeId: await directScope(scopes),
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
  const { coordinator, store, scopes } = build({
    turns: [{ events: [], result: { status: 'interrupted' } }],
  });
  await coordinator.deliver({
    scopeId: await directScope(scopes),
    author: { id: 'human-lead', kind: 'human' },
    body: 'status?',
    recipients: ['scout'],
    deliveryKey: 'd3',
  });
  const messages = await store.listMessages();
  assert.equal(messages.filter((message) => message.author.kind === 'agent').length, 0);
});

test('the run prompt names the author, channel, and the agent being woken', async () => {
  const { coordinator, engine, scopes } = build({ turns: [completedTurn('ok')] });
  await coordinator.deliver({
    scopeId: await scopes.channel('project-sprout'),
    author: { id: 'human-lead', kind: 'human' },
    body: '@scout please review the wake rule',
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
  const scopes = buildCollaborationScopes({ projects });
  const coordinator = new CollaborationCoordinator({
    scopes: scopes.scopes,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
    onObservation: ({ observation }) => seen.push(`${observation.status}:${observation.detail}`),
  });

  await coordinator.deliver({
    scopeId: await scopes.channel('project-sprout'),
    author: { id: 'human-lead', kind: 'human' },
    body: 'fyi',
    deliveryKey: 'd5',
  });

  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /^suppressed:no deterministic address/);
});

test('delivery refuses an unknown scope before anything is persisted', async () => {
  const { coordinator, store } = build({ turns: [completedTurn('must not run')] });
  await assert.rejects(
    coordinator.deliver({
      scopeId: 'channel-does-not-exist',
      author: { id: 'human-lead', kind: 'human' },
      body: 'hello?',
      deliveryKey: 'unknown-scope-1',
    }),
    (error: unknown) => error instanceof ConversationScopeError && error.code === 'unknown-scope',
  );
  assert.equal((await store.listMessages()).length, 0);
  assert.equal((await store.listWakeRequests()).length, 0);
});

test('delivery refuses a read-only scope with a typed reason and persists nothing', async () => {
  const { coordinator, store, scopes } = build({
    turns: [completedTurn('must not run')],
    statusOf: () => 'archived',
  });
  const scopeId = await scopes.channel('project-sprout');
  await assert.rejects(
    coordinator.deliver({
      scopeId,
      author: { id: 'human-lead', kind: 'human' },
      body: 'hello?',
      deliveryKey: 'archived-1',
    }),
    (error: unknown) =>
      error instanceof MessageDeliveryError &&
      error.code === 'scope-read-only' &&
      error.reason === 'project-archived',
  );
  assert.equal((await store.listMessages()).length, 0);
});

test('delivery refuses an author who is not part of the scope', async () => {
  const { coordinator, store, scopes } = build({ turns: [completedTurn('must not run')] });
  const scopeId = await directScope(scopes);
  await assert.rejects(
    coordinator.deliver({
      scopeId,
      author: { id: 'operator', kind: 'human' },
      body: 'not a participant',
      deliveryKey: 'not-participant-1',
    }),
    (error: unknown) =>
      error instanceof MessageDeliveryError && error.reason === 'not-a-participant',
  );
  assert.equal((await store.listMessages()).length, 0);
});

test('renderWakePrompt presents the message verbatim without summarising it', () => {
  const prompt = renderWakePrompt(
    {
      id: 'msg-1',
      projectId: 'project-sprout',
      scopeId: 'dm-1',
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
  assert.match(prompt, /a direct message/);
});

test('every admitted wake submits the causal Message project as the run scope', async () => {
  // A minimal admitter records the submission request, so the contract between
  // the coordinator and the run seam is asserted directly: the run is scoped to
  // the Message's Project, never left to the agent's first project.
  const submissions: { agentId: string; prompt: string; projectId: string }[] = [];
  const store = new InMemoryCollaborationStore();
  const projects = new ProjectRegistry([project]);
  const scopes = buildCollaborationScopes({ projects });
  const admitter: RunAdmitter = {
    submit: async (request) => {
      submissions.push({ ...request });
      return { id: `run-${submissions.length}` };
    },
    waitFor: async (runId) => ({
      id: runId,
      agentId: 'scout',
      prompt: '',
      environmentInstanceId: '',
      status: 'failed',
      events: [],
      createdAt: 0,
    }),
  };
  const coordinator = new CollaborationCoordinator({
    scopes: scopes.scopes,
    store,
    runs: admitter,
  });

  await coordinator.deliver({
    scopeId: await directScope(scopes),
    author: { id: 'human-lead', kind: 'human' },
    body: 'go',
    recipients: ['scout'],
    deliveryKey: 'scope-1',
  });

  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]?.agentId, 'scout');
  assert.equal(submissions[0]?.projectId, 'project-sprout', 'the run is scoped to the Message project');
});

test('admission is idempotent even if a wake is admitted twice directly', async () => {
  const { coordinator, store, scopes } = build({ turns: [completedTurn('ok')] });
  const delivered = await coordinator.deliver({
    scopeId: await directScope(scopes),
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

// --- Project events (#96, ADR-0007) ---

test('publishing a Project event requires a routing disposition', async () => {
  const { coordinator, store } = build({ turns: [completedTurn('must not run')] });
  await assert.rejects(
    coordinator.publishEvent({
      projectId: 'project-sprout',
      kind: 'task-blocker',
      summary: 'Blocked on review',
      disposition: undefined as never,
      deliveryKey: 'ev-1',
    }),
    (error: unknown) => error instanceof ProjectEventError && error.code === 'disposition-required',
  );
  await assert.rejects(
    coordinator.publishEvent({
      projectId: 'project-sprout',
      kind: 'task-blocker',
      summary: 'Blocked on review',
      disposition: 'urgent' as never,
      deliveryKey: 'ev-2',
    }),
    (error: unknown) => error instanceof ProjectEventError && error.code === 'invalid-disposition',
  );
  assert.equal((await store.listEvents()).length, 0, 'nothing is stored without a disposition');
});

test('an addressed event requires a responsible Agent at publication', async () => {
  const { coordinator, store } = build({ turns: [completedTurn('must not run')] });
  await assert.rejects(
    coordinator.publishEvent({
      projectId: 'project-sprout',
      kind: 'task-blocker',
      summary: 'Blocked on review',
      disposition: 'addressed',
      responsibleAgentIds: [],
      deliveryKey: 'ev-3',
    }),
    (error: unknown) =>
      error instanceof ProjectEventError && error.code === 'addressed-requires-target',
  );
  assert.equal((await store.listEvents()).length, 0);
});

test('an addressed event persists before admission, wakes its target, and projects a reply', async () => {
  const { coordinator, store } = build({ turns: [completedTurn('On it.')] });
  const published = await coordinator.publishEvent({
    projectId: 'project-sprout',
    kind: 'task-blocker',
    summary: 'Task T1 is blocked on review',
    disposition: 'addressed',
    responsibleAgentIds: ['scout'],
    deliveryKey: 'ev-4',
  });

  assert.equal(published.duplicate, false);
  assert.equal(published.wakes.length, 1);
  assert.equal(published.wakes[0]?.reason, 'event-addressed');
  assert.equal(published.wakes[0]?.status, 'admitted');
  assert.equal(published.event.disposition, 'addressed');

  const messages = await store.listMessages();
  const reply = messages.find((message) => message.author.kind === 'agent');
  assert.ok(reply, 'the event-triggered run projects its final text');
  assert.equal(reply.body, 'On it.');
  assert.equal(reply.inReplyTo, undefined, 'an event reply answers no Message');
  assert.equal(reply.channel, 'project', 'the reply lands on the Project channel');
  assert.equal(reply.scopeId, 'channel-project-sprout');
  assert.equal(reply.projectId, 'project-sprout');
});

test('the event prompt names the event kind, producer, and summary verbatim', async () => {
  const { coordinator, engine } = build({ turns: [completedTurn('ok')] });
  await coordinator.publishEvent({
    projectId: 'project-sprout',
    kind: 'task-blocker',
    summary: 'Task T1 is blocked on review',
    detail: 'Waiting for the Human to reassign the reviewer.',
    disposition: 'addressed',
    responsibleAgentIds: ['scout'],
    deliveryKey: 'ev-5',
  });
  const prompt = engine.sessions[0]?.prompts[0] ?? '';
  assert.match(prompt, /Project event "task-blocker" in project project-sprout/);
  assert.match(prompt, /system sprout recorded:/);
  assert.match(prompt, /Task T1 is blocked on review/);
  assert.match(prompt, /Waiting for the Human to reassign the reviewer\./);
});

test('a non-addressed event persists durably without waking anyone', async () => {
  for (const disposition of ['wake-eligible', 'informational', 'human-action-required', 'non-routing'] as const) {
    const { coordinator, store, engine } = build({ turns: [completedTurn('must not run')] });
    const published = await coordinator.publishEvent({
      projectId: 'project-sprout',
      kind: 'run-completed',
      summary: 'A run completed',
      disposition,
      deliveryKey: `ev-${disposition}`,
    });
    assert.equal(published.event.disposition, disposition);
    assert.deepEqual(published.wakes, []);
    assert.deepEqual(published.admittedRunIds, []);
    assert.equal((await store.listWakeRequests()).length, 0);
    assert.equal(engine.requests.length, 0, 'no engine was consulted');
    assert.equal((await store.listEvents()).length, 1, 'the fact itself is durable');
  }
});

test('a repeated event delivery key is idempotent', async () => {
  const { coordinator, store } = build({ turns: [completedTurn('On it.')] });
  const request = {
    projectId: 'project-sprout',
    kind: 'task-blocker',
    summary: 'Blocked',
    disposition: 'addressed' as const,
    responsibleAgentIds: ['scout'],
    deliveryKey: 'ev-dup',
  };
  const first = await coordinator.publishEvent(request);
  const second = await coordinator.publishEvent(request);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.event.id, first.event.id);
  assert.equal(second.admittedRunIds.length, 0, 'the retry admits no second run');
  assert.equal((await store.listEvents()).length, 1);
  assert.equal((await store.listWakeRequests()).length, 1);
});

test('event publication redacts sensitive text from summary and detail', async () => {
  const { coordinator, store } = build({ turns: [completedTurn('must not run')] });
  const published = await coordinator.publishEvent({
    projectId: 'project-sprout',
    kind: 'task-blocked',
    summary: 'Blocked on http://buildbox-7.internal:41000/runs/run-x',
    detail: 'Inspect http://buildbox-7.internal:41000/runs/run-x for the raw stderr',
    disposition: 'informational',
    deliveryKey: 'ev-redaction',
  });
  assert.equal(published.event.summary.includes('http://'), false, 'the summary carries no raw URL');
  assert.ok(published.event.summary.includes('<redacted-url>'), 'the summary keeps a decisive marker');
  assert.equal((published.event.detail ?? '').includes('buildbox-7'), false, 'the detail carries no host identity');
  const [stored] = await store.listEvents();
  assert.equal(stored?.summary, published.event.summary, 'the stored fact is already redacted');
});
