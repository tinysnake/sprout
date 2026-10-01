import { definition, instance, projects } from './api-harness.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { CollaborationCoordinator } from '../collaboration/coordinator.ts';
import { InMemoryCollaborationStore } from '../collaboration/store.ts';
import { buildCollaborationScopes } from '../collaboration/scope-harness.ts';
import { createRunApi } from './api.ts';

import { withServer, buildWithCollaboration, buildObservableCollaboration } from './api-harness.ts';

test('a message delivered over the API wakes its recipient and a reply is projected', async () => {
  const context = buildWithCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const scopeId = await context.scopes.openDirect('project-sprout', ['human-lead', 'agent-scout']);
  try {
    const delivered = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeId,
        authorId: 'human-lead',
        authorKind: 'human',
        body: 'Please investigate.',
        recipients: ['agent-scout'],
        deliveryKey: 'api-delivery-1',
      }),
    });
    assert.equal(delivered.status, 202);
    const result = (await delivered.json()) as {
      message: { id: string; scopeId: string };
      duplicate: boolean;
      admittedRunIds: string[];
      wakes: { agentId: string; reason: string; status: string }[];
    };
    assert.equal(result.duplicate, false);
    assert.equal(result.message.scopeId, scopeId, 'the Message belongs to its conversation scope');
    assert.equal(result.admittedRunIds.length, 1);
    assert.equal(result.wakes[0]?.agentId, 'agent-scout');
    assert.equal(result.wakes[0]?.reason, 'direct-recipient');
    assert.equal(result.wakes[0]?.status, 'admitted');

    const listed = (await (await fetch(`${base}/api/messages?scopeId=${scopeId}`)).json()) as {
      messages: { authorKind: string; body: string; scopeId: string; inReplyTo?: string }[];
    };
    assert.ok(listed.messages.every((message) => message.scopeId === scopeId), 'the stream filters by scope');
    const reply = listed.messages.find((message) => message.authorKind === 'agent');
    assert.ok(reply);
    assert.equal(reply.body, 'Scout: replied.');
    assert.equal(reply.inReplyTo, result.message.id, 'the reply answers the delivered input');

    // The projected reply carries only final text, never private run events.
    assert.ok(!listed.messages.some((message) => message.body.includes('TOOL_OUTPUT_MUST_NOT_LEAK')));
  } finally {
    await context.api.close();
  }
});

test('a duplicate message delivery over the API is idempotent', async () => {
  const context = buildWithCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const scopeId = await context.scopes.openDirect('project-sprout', ['human-lead', 'agent-scout']);
  const request = {
    scopeId,
    authorId: 'human-lead',
    authorKind: 'human',
    body: 'Once.',
    recipients: ['agent-scout'],
    deliveryKey: 'api-dup-1',
  };
  try {
    const first = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
    ).json()) as { duplicate: boolean; message: { id: string } };
    const secondResponse = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    assert.equal(secondResponse.status, 200);
    const second = (await secondResponse.json()) as { duplicate: boolean; message: { id: string } };
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.message.id, first.message.id);

    const listed = (await (await fetch(`${base}/api/messages`)).json()) as {
      messages: unknown[];
    };
    assert.equal(listed.messages.length, 2, 'one input and one reply');
  } finally {
    await context.api.close();
  }
});

test('the message API refuses missing, unknown, and mis-shaped scope requests', async () => {
  const context = buildWithCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const channelScope = await context.scopes.channel('project-sprout');
  try {
    const missingScope = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        authorId: 'human-lead',
        body: 'Please investigate.',
        deliveryKey: 'api-missing-scope-1',
      }),
    });
    assert.equal(missingScope.status, 400, 'scopeId, body, and deliveryKey are required');

    const unknownScope = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeId: 'channel-does-not-exist',
        authorId: 'human-lead',
        body: 'Please investigate.',
        deliveryKey: 'api-unknown-scope-1',
      }),
    });
    assert.equal(unknownScope.status, 404);

    const recipientsOnChannel = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeId: channelScope,
        authorId: 'human-lead',
        body: 'Please investigate.',
        recipients: ['agent-scout'],
        deliveryKey: 'api-channel-recipients-1',
      }),
    });
    assert.equal(recipientsOnChannel.status, 400, 'channel Messages address through their body only');

    const unknownAuthor = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeId: channelScope,
        authorId: 'ghost-author',
        body: 'Please investigate.',
        deliveryKey: 'api-unknown-author-1',
      }),
    });
    assert.equal(unknownAuthor.status, 403, 'an author outside the membership cannot post');
    const failure = (await unknownAuthor.json()) as { code: string; reason: string };
    assert.equal(failure.code, 'scope-read-only');
    assert.equal(failure.reason, 'not-a-member');
  } finally {
    await context.api.close();
  }
});

test('a delivery to a read-only scope is refused with its settled reason', async () => {
  const context = buildWithCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const group = await context.scopes.scopes.createWorkingGroup({
      projectId: 'project-sprout',
      displayName: 'Read-only test',
      creator: { memberId: 'operator', kind: 'human' },
    });
    await context.scopes.scopes.disbandWorkingGroup(group.id, { memberId: 'operator', kind: 'human' });

    const refused = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeId: group.id,
        authorId: 'operator',
        authorKind: 'human',
        body: 'still writable?',
        deliveryKey: 'api-read-only-1',
      }),
    });
    assert.equal(refused.status, 409, 'a disbanded Working group channel is read-only');
    const failure = (await refused.json()) as { code: string; reason: string };
    assert.equal(failure.code, 'scope-read-only');
    assert.equal(failure.reason, 'working-group-disbanded');
  } finally {
    await context.api.close();
  }
});

test('an unaddressed message and its wake observations are readable over the API', async () => {
  const adapter = new ScriptedEngineAdapter({ turns: [] });
  const registry = new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
  ]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
  });
  const scopes = buildCollaborationScopes({ projects });
  const collaboration = new CollaborationCoordinator({
    scopes: scopes.scopes,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
  });
  const api = createRunApi({ orchestrator, agents: registry, collaboration, conversationScopes: scopes.scopes });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const channelScope = await scopes.channel('project-sprout');
  try {
    const delivered = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scopeId: channelScope,
          authorId: 'human-lead',
          body: 'just an fyi',
          deliveryKey: 'api-suppress-1',
        }),
      })
    ).json()) as { message: { id: string }; admittedRunIds: string[] };
    assert.equal(delivered.admittedRunIds.length, 0);

    const observations = (await (
      await fetch(`${base}/api/messages/${delivered.message.id}/observations`)
    ).json()) as { observations: { status: string; reason: string; detail: string }[]; wakes: unknown[] };
    assert.equal(observations.wakes.length, 0);
    assert.equal(observations.observations.length, 1, 'nothing happened, and that is durably visible');
    assert.equal(observations.observations[0]?.status, 'suppressed');
    assert.equal(observations.observations[0]?.reason, 'unaddressed');
    assert.match(observations.observations[0]?.detail ?? '', /remains durable/);

    const missing = await fetch(`${base}/api/messages/does-not-exist/observations`);
    assert.equal(missing.status, 404);
  } finally {
    await api.close();
  }
});

test('a message endpoint is absent when no collaboration plane is configured', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/messages`);
    assert.equal(response.status, 404);
  });
});

/**
 * Collaboration observability (#27, #96).
 *
 * These assert the client-facing shapes the Web composer and stream depend on:
 * the project member list, the message stream with author identity and reply
 * causality, wake request detail including the linked run, the durable
 * suppression/failure observations that must not stay silent, and the Project
 * event routes that carry each event's declared routing disposition.
 */
test('the project list exposes the members a composer may address', async () => {
  const context = buildObservableCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const listed = (await (await fetch(`${base}/api/projects`)).json()) as {
      projects: { id: string; goal: string; memberIds: string[] }[];
    };
    assert.equal(listed.projects.length, 1);
    assert.equal(listed.projects[0]?.id, 'project-sprout');
    assert.deepEqual(listed.projects[0]?.memberIds, ['agent-scout', 'agent-ranger']);
  } finally {
    await context.api.close();
  }
});

test('the message stream carries author identity, reply causality, and wake detail', async () => {
  const context = buildObservableCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const scopeId = await context.scopes.openDirect('project-sprout', ['operator', 'agent-scout']);
  try {
    const delivered = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scopeId,
          authorId: 'operator',
          authorKind: 'human',
          body: 'Please investigate.',
          recipients: ['agent-scout'],
          deliveryKey: 'web-observe-1',
        }),
      })
    ).json()) as {
      message: { id: string; authorKind: string; createdAt: number };
      wakes: { agentId: string; reason: string; status: string; runId?: string }[];
    };
    assert.equal(delivered.message.authorKind, 'human');
    assert.ok(delivered.message.createdAt > 0, 'the message carries a timestamp');
    assert.equal(delivered.wakes[0]?.agentId, 'agent-scout');
    assert.equal(delivered.wakes[0]?.reason, 'direct-recipient');
    assert.equal(delivered.wakes[0]?.status, 'admitted');
    assert.ok(delivered.wakes[0]?.runId, 'an admitted wake links to its run');

    // The admitted run is observable and controllable through the existing run
    // controls, not a second, collaboration-only run surface.
    const runId = delivered.wakes[0]!.runId!;
    const run = (await (await fetch(`${base}/api/runs/${runId}`)).json()) as { status: string };
    assert.equal(run.status, 'completed');
    const stop = await fetch(`${base}/api/runs/${runId}/stop`, { method: 'POST' });
    assert.equal(stop.status, 200);

    const listed = (await (await fetch(`${base}/api/messages`)).json()) as {
      messages: { id: string; authorKind: string; inReplyTo?: string; createdAt: number }[];
    };
    const reply = listed.messages.find((message) => message.authorKind === 'agent');
    assert.ok(reply);
    assert.equal(reply.inReplyTo, delivered.message.id, 'the reply points back at its input');
    assert.ok(reply.createdAt >= delivered.message.createdAt);

    // The wake's run link is readable per message too, so the client can show it
    // without holding the delivery response.
    const observations = (await (
      await fetch(`${base}/api/messages/${delivered.message.id}/observations`)
    ).json()) as { wakes: { runId?: string; reason: string; status: string }[] };
    assert.equal(observations.wakes[0]?.runId, runId);
    assert.equal(observations.wakes[0]?.reason, 'direct-recipient');
    assert.equal(observations.wakes[0]?.status, 'admitted');
  } finally {
    await context.api.close();
  }
});

test('a broadcast addresses every other member with an observable reason', async () => {
  const context = buildObservableCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const channelScope = await context.scopes.channel('project-sprout');
  try {
    const delivered = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scopeId: channelScope,
          authorId: 'operator',
          body: '@all please take a look.',
          deliveryKey: 'web-broadcast-1',
        }),
      })
    ).json()) as { wakes: { agentId: string; reason: string; status: string }[] };
    assert.deepEqual(
      delivered.wakes.map((wake) => [wake.agentId, wake.reason, wake.status]).sort(),
      [
        ['agent-ranger', 'broadcast', 'admitted'],
        ['agent-scout', 'broadcast', 'admitted'],
      ],
    );
  } finally {
    await context.api.close();
  }
});

test('Project events expose their declared disposition and routing evidence', async () => {
  const context = buildObservableCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const addressed = await context.collaboration.publishEvent({
      projectId: 'project-sprout',
      kind: 'task-blocker',
      summary: 'Task T1 is blocked',
      disposition: 'addressed',
      responsibleAgentIds: ['agent-scout'],
      deliveryKey: 'api-event-1',
    });
    const informational = await context.collaboration.publishEvent({
      projectId: 'project-sprout',
      kind: 'run-completed',
      summary: 'A run completed',
      disposition: 'informational',
      deliveryKey: 'api-event-2',
    });
    assert.equal(addressed.admittedRunIds.length, 1, 'an addressed event routes without a model');
    assert.deepEqual(informational.wakes, [], 'an informational event routes nothing');

    const listed = (await (
      await fetch(`${base}/api/projects/project-sprout/events`)
    ).json()) as {
      events: { id: string; kind: string; disposition: string; responsibleAgentIds: string[] }[];
    };
    assert.equal(listed.events.length, 2);
    const addressedView = listed.events.find((event) => event.id === addressed.event.id);
    assert.equal(addressedView?.disposition, 'addressed');
    assert.deepEqual(addressedView?.responsibleAgentIds, ['agent-scout']);
    assert.equal(
      listed.events.find((event) => event.id === informational.event.id)?.disposition,
      'informational',
    );

    const evidence = (await (
      await fetch(`${base}/api/project-events/${addressed.event.id}/observations`)
    ).json()) as {
      event: { disposition: string };
      observations: unknown[];
      wakes: { agentId: string; reason: string; status: string }[];
    };
    assert.equal(evidence.event.disposition, 'addressed');
    assert.deepEqual(evidence.observations, []);
    assert.deepEqual(
      evidence.wakes.map((wake) => [wake.agentId, wake.reason, wake.status]),
      [['agent-scout', 'event-addressed', 'admitted']],
    );

    const missing = await fetch(`${base}/api/project-events/evt-none/observations`);
    assert.equal(missing.status, 404);
  } finally {
    await context.api.close();
  }
});

test('a run admitted by a collaboration wake is stoppable through the run controls', async () => {
  const context = buildObservableCollaboration({ settleAfterMs: 5_000 });
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const scopeId = await context.scopes.openDirect('project-sprout', ['operator', 'agent-scout']);
  try {
    // Delivery waits for the admitted run to settle before projecting a reply, so
    // the POST is left in flight: the run must be observable and stoppable through
    // the ordinary run controls while it is still running.
    const delivery = fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeId,
        authorId: 'operator',
        body: 'A long job, please.',
        recipients: ['agent-scout'],
        deliveryKey: 'web-stop-1',
      }),
    });

    let runId: string | undefined;
    for (let attempt = 0; attempt < 500 && runId === undefined; attempt += 1) {
      const listed = (await (await fetch(`${base}/api/runs`)).json()) as {
        runs: { id: string; status: string }[];
      };
      runId = listed.runs.find((run) => run.status === 'running')?.id;
      if (runId === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(runId, 'the wake-triggered run is listed while it runs');

    const stop = await fetch(`${base}/api/runs/${runId}/stop`, { method: 'POST' });
    assert.equal(stop.status, 200);
    assert.equal(((await stop.json()) as { status: string }).status, 'stopped');

    // The delivery completes once the stopped run settles without a reply.
    const response = await delivery;
    assert.equal(response.status, 202);
    const result = (await response.json()) as { admittedRunIds: string[] };
    assert.deepEqual(result.admittedRunIds, [runId]);

    const messages = (await (await fetch(`${base}/api/messages`)).json()) as {
      messages: { authorKind: string }[];
    };
    assert.ok(
      !messages.messages.some((message) => message.authorKind === 'agent'),
      'an interrupted run projects no reply',
    );
  } finally {
    await context.api.close();
  }
});

test('a failed direct run surfaces as one sanitized informational Project event over the API', async () => {
  const context = buildWithCollaboration({ failing: true, failureMessage: 'unknown agent: unrelated engine output' });
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const scopeId = await context.scopes.openDirect('project-sprout', ['human-lead', 'agent-scout']);
  try {
    const delivered = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeId,
        authorId: 'human-lead',
        authorKind: 'human',
        body: 'Please investigate the outage.',
        recipients: ['agent-scout'],
        deliveryKey: 'api-failed-run-1',
      }),
    });
    assert.equal(delivered.status, 202);
    const result = (await delivered.json()) as { admittedRunIds: string[] };
    assert.equal(result.admittedRunIds.length, 1);

    // Live failure publication is asynchronous by design; the read-only events
    // route is the operator's surface, so the assertion polls exactly that.
    let events: {
      id: string;
      kind: string;
      summary: string;
      detail?: string;
      disposition: string;
      producerId: string;
      producerKind: string;
      responsibleAgentIds: string[];
    }[] = [];
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      events = ((await (await fetch(`${base}/api/projects/project-sprout/events`)).json()) as {
        events: typeof events;
      }).events;
      if (events.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(events.length, 1, 'exactly one failure event for one terminal transition');
    const event = events[0]!;
    assert.equal(event.kind, 'agent-run-failure');
    assert.equal(event.disposition, 'informational', 'labelled non-routing: no wake, no fan-out');
    assert.equal(event.producerKind, 'system');
    assert.equal(event.producerId, 'sprout');
    assert.deepEqual(event.responsibleAgentIds, []);
    assert.equal(event.summary, 'Agent run failed (execution) for agent-scout');
    assert.match(event.detail ?? '', new RegExp(`run ${result.admittedRunIds[0]}`), 'the evidence chain links the run');

    // Privacy projection: never the run prompt, raw events, or tool output.
    const serialized = JSON.stringify(event);
    assert.doesNotMatch(serialized, /Please investigate the outage\./);
    assert.doesNotMatch(serialized, /FAILED_RUN_TOOL_OUTPUT_MUST_NOT_LEAK/);
    assert.doesNotMatch(serialized, /unrelated engine output/);

    // Routing exclusion: an informational event owns no WakeRequest at all.
    const evidence = (await (
      await fetch(`${base}/api/project-events/${event.id}/observations`)
    ).json()) as { wakes: unknown[] };
    assert.deepEqual(evidence.wakes, []);
  } finally {
    await context.api.close();
  }
});
