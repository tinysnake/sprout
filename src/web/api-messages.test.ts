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
import { createRunApi } from './api.ts';

import { withServer, buildWithCollaboration, buildObservableCollaboration } from './api-harness.ts';

test('a message delivered over the API wakes its recipient and a reply is projected', async () => {
  const context = buildWithCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const delivered = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-sprout',
        channel: 'direct',
        authorId: 'human-lead',
        authorKind: 'human',
        body: 'Please investigate.',
        recipients: ['agent-scout'],
        deliveryKey: 'api-delivery-1',
      }),
    });
    assert.equal(delivered.status, 202);
    const result = (await delivered.json()) as {
      message: { id: string };
      duplicate: boolean;
      admittedRunIds: string[];
      wakes: { agentId: string; reason: string; status: string }[];
    };
    assert.equal(result.duplicate, false);
    assert.equal(result.admittedRunIds.length, 1);
    assert.equal(result.wakes[0]?.agentId, 'agent-scout');
    assert.equal(result.wakes[0]?.reason, 'direct-recipient');
    assert.equal(result.wakes[0]?.status, 'admitted');

    const listed = (await (await fetch(`${base}/api/messages`)).json()) as {
      messages: { authorKind: string; body: string; inReplyTo?: string }[];
    };
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
  const request = {
    projectId: 'project-sprout',
    channel: 'direct',
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

test('the message API rejects invalid channel and recipient shapes', async () => {
  const context = buildWithCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const invalidChannel = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-sprout',
        channel: 'unknown',
        authorId: 'human-lead',
        body: 'Please investigate.',
        deliveryKey: 'api-invalid-channel-1',
      }),
    });
    assert.equal(invalidChannel.status, 400);

    const missingDirectRecipient = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-sprout',
        channel: 'direct',
        authorId: 'human-lead',
        body: 'Please investigate.',
        deliveryKey: 'api-missing-recipient-1',
      }),
    });
    assert.equal(missingDirectRecipient.status, 400);

    const projectRecipient = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-sprout',
        channel: 'project',
        authorId: 'human-lead',
        body: 'Please investigate.',
        recipients: ['agent-scout'],
        deliveryKey: 'api-project-recipient-1',
      }),
    });
    assert.equal(projectRecipient.status, 400);
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
  const collaboration = new CollaborationCoordinator({
    projects,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
    wakeModel: { decide: async () => ({ engage: false, detail: 'nothing to do' }) },
  });
  const api = createRunApi({ orchestrator, agents: registry, collaboration });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const delivered = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-sprout',
          channel: 'project',
          authorId: 'human-lead',
          body: 'just an fyi',
          deliveryKey: 'api-suppress-1',
        }),
      })
    ).json()) as { message: { id: string }; admittedRunIds: string[] };
    assert.equal(delivered.admittedRunIds.length, 0);

    const observations = (await (
      await fetch(`${base}/api/messages/${delivered.message.id}/observations`)
    ).json()) as { observations: { status: string; detail: string }[]; wakes: unknown[] };
    assert.equal(observations.wakes.length, 0);
    assert.equal(observations.observations.length, 1);
    assert.equal(observations.observations[0]?.status, 'suppressed');
    assert.equal(observations.observations[0]?.detail, 'nothing to do');

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
 * Collaboration observability (#27).
 *
 * These assert the client-facing shapes the Web composer and stream depend on:
 * the project member list, the message stream with author identity and reply
 * causality, wake request detail including the linked run, and the durable
 * suppression/failure observations that must not stay silent.
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
  try {
    const delivered = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-sprout',
          channel: 'direct',
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
  try {
    const delivered = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-sprout',
          channel: 'project',
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

test('a wake-model suppression is visible through the observations route', async () => {
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
  const collaboration = new CollaborationCoordinator({
    projects,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
    wakeModel: { decide: async () => ({ engage: false, detail: 'nothing to do' }) },
  });
  const api = createRunApi({ orchestrator, agents: registry, collaboration, projects });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const delivered = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-sprout',
          channel: 'project',
          authorId: 'operator',
          body: 'just an fyi',
          deliveryKey: 'web-suppression-1',
        }),
      })
    ).json()) as { message: { id: string } };
    const observations = (await (
      await fetch(`${base}/api/messages/${delivered.message.id}/observations`)
    ).json()) as { observations: { status: string; reason: string; detail: string }[] };
    const suppression = observations.observations.find(
      (observation) => observation.status === 'suppressed',
    );
    assert.ok(suppression, 'the suppression is surfaced to the operator');
    assert.equal(suppression.reason, 'wake-model');
    assert.equal(suppression.detail, 'nothing to do');
  } finally {
    await api.close();
  }
});

test('a run admitted by a collaboration wake is stoppable through the run controls', async () => {
  const context = buildObservableCollaboration({ settleAfterMs: 5_000 });
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    // Delivery waits for the admitted run to settle before projecting a reply, so
    // the POST is left in flight: the run must be observable and stoppable through
    // the ordinary run controls while it is still running.
    const delivery = fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-sprout',
        channel: 'direct',
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
    assert.equal(((await stop.json()) as { status: string }).status, 'interrupted');

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
