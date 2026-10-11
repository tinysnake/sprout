import { definition, instance, projects } from './api-harness.ts';
import { OperatorSessionService } from '../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../auth/store.ts';
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

import { withServer, buildWithCollaboration, buildObservableCollaboration, privateInput } from './api-harness.ts';

async function messageHistory(count: number) {
  const context = buildWithCollaboration();
  const { port } = await context.api.listen(0);
  const scopeId = await context.scopes.channel('project-sprout');
  for (let index = 0; index < count; index += 1) {
    await context.collaboration.deliver({
      scopeId,
      author: { id: 'human-lead', kind: 'human' },
      body: `history message ${index}`,
      deliveryKey: `history-${index}`,
      awaitReply: false,
    });
  }
  return { context, base: `http://127.0.0.1:${port}`, scopeId };
}

async function eventHistory(count: number) {
  const context = buildObservableCollaboration();
  const { port } = await context.api.listen(0);
  for (let index = 0; index < count; index += 1) {
    await context.collaboration.publishEvent({
      projectId: 'project-sprout',
      kind: 'pagination-fixture',
      summary: `History event ${index}`,
      disposition: 'informational',
      deliveryKey: `event-history-${index}`,
    });
  }
  return { context, base: `http://127.0.0.1:${port}` };
}

test('GET /api/projects/:id/events returns a bounded newest window and hasOlder by default', async () => {
  const { context, base } = await eventHistory(55);
  try {
    const response = await fetch(`${base}/api/projects/project-sprout/events`);
    assert.equal(response.status, 200);
    const body = await response.json() as { events: { id: string }[]; hasOlder: boolean };
    const durable = [...await context.collaboration.listEvents('project-sprout')]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    assert.equal(body.events.length, 50);
    assert.deepEqual(body.events.map((event) => event.id), durable.slice(-50).map((event) => event.id));
    assert.equal(body.hasOlder, true);
  } finally {
    await context.api.close();
  }
});

test('GET /api/projects/:id/events honors limit and an exclusive backward cursor', async () => {
  const { context, base } = await eventHistory(8);
  try {
    const durable = [...await context.collaboration.listEvents('project-sprout')]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const newestResponse = await fetch(`${base}/api/projects/project-sprout/events?limit=3`);
    const newest = await newestResponse.json() as { events: { id: string }[]; hasOlder: boolean };
    assert.equal(newest.events.length, 3);
    assert.equal(newest.hasOlder, true);
    const olderResponse = await fetch(`${base}/api/projects/project-sprout/events?limit=3&before=${encodeURIComponent(newest.events[0]!.id)}`);
    const older = await olderResponse.json() as { events: { id: string }[]; hasOlder: boolean };
    assert.equal(olderResponse.status, 200);
    assert.deepEqual(older.events.map((event) => event.id), durable.slice(-6, -3).map((event) => event.id));
    assert.equal(older.hasOlder, true);
    assert.ok(older.events.every((event) => event.id !== newest.events[0]?.id));
  } finally {
    await context.api.close();
  }
});

test('GET /api/projects/:id/events returns an empty page before the oldest event', async () => {
  const { context, base } = await eventHistory(4);
  try {
    const oldest = [...await context.collaboration.listEvents('project-sprout')]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0]!;
    const response = await fetch(`${base}/api/projects/project-sprout/events?limit=3&before=${encodeURIComponent(oldest.id)}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { events: unknown[]; hasOlder: boolean };
    assert.deepEqual(body.events, []);
    assert.equal(body.hasOlder, false);
  } finally {
    await context.api.close();
  }
});

test('GET /api/projects/:id/events returns 404 for unknown and cross-project cursors', async () => {
  const { context, base } = await eventHistory(1);
  try {
    const unknown = await fetch(`${base}/api/projects/project-sprout/events?before=missing-event-cursor`);
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json() as { error: string }).error, /missing-event-cursor/);
    const [cursor] = await context.collaboration.listEvents('project-sprout');
    const other = await fetch(`${base}/api/projects/other-project/events?before=${encodeURIComponent(cursor!.id)}`);
    assert.equal(other.status, 404, 'a cursor must belong to the requested project');
  } finally { await context.api.close(); }
});

test('GET /api/projects/:id/events caps the requested page size', async () => {
  const { context, base } = await eventHistory(105);
  try {
    const capped = await fetch(`${base}/api/projects/project-sprout/events?limit=1000`);
    assert.equal(capped.status, 200);
    const body = await capped.json() as { events: unknown[]; hasOlder: boolean };
    assert.equal(body.events.length, 100);
    assert.equal(body.hasOlder, true);
  } finally { await context.api.close(); }
});

test('GET /api/projects/:id/events validates paging parameters', async () => {
  const { context, base } = await eventHistory(1);
  try {
    for (const query of ['limit=0', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=9007199254740992', 'originScopeId=', 'before=']) {
      const response = await fetch(`${base}/api/projects/project-sprout/events?${query}`);
      assert.equal(response.status, 400, query);
    }
  } finally { await context.api.close(); }
});

test('GET /api/messages returns a bounded newest window with the legacy response shape', async () => {
  const { context, base, scopeId } = await messageHistory(55);
  try {
    const response = await fetch(`${base}/api/messages?scopeId=${encodeURIComponent(scopeId)}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { messages: { id: string }[] };
    const durable = [...await context.collaboration.listMessages({ scopeId })]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    assert.equal(body.messages.length, 50, 'the documented default window is bounded');
    assert.deepEqual(body.messages.map((message) => message.id), durable.slice(-50).map((message) => message.id));
    assert.deepEqual(Object.keys(body), ['messages'], 'existing callers keep the response shape');
  } finally {
    await context.api.close();
  }
});

test('GET /api/messages honors limit=5 for a 45-message conversation', async () => {
  const { context, base, scopeId } = await messageHistory(45);
  try {
    const response = await fetch(`${base}/api/messages?scopeId=${encodeURIComponent(scopeId)}&limit=5`);
    assert.equal(response.status, 200);
    const body = await response.json() as { messages: { id: string }[] };
    const durable = [...await context.collaboration.listMessages({ scopeId })]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    assert.equal(durable.length, 45);
    assert.deepEqual(body.messages.map((message) => message.id), durable.slice(-5).map((message) => message.id));
  } finally {
    await context.api.close();
  }
});

test('GET /api/messages before cursor returns the preceding page with an exclusive boundary', async () => {
  const { context, base, scopeId } = await messageHistory(8);
  try {
    const durable = [...await context.collaboration.listMessages({ scopeId })]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const response = await fetch(`${base}/api/messages?scopeId=${encodeURIComponent(scopeId)}&limit=3`);
    const newest = (await response.json()) as { messages: { id: string }[] };
    const olderResponse = await fetch(`${base}/api/messages?scopeId=${encodeURIComponent(scopeId)}&limit=3&before=${encodeURIComponent(newest.messages[0]!.id)}`);
    const older = (await olderResponse.json()) as { messages: { id: string }[] };
    assert.equal(olderResponse.status, 200);
    assert.deepEqual(older.messages.map((message) => message.id), durable.slice(-6, -3).map((message) => message.id));
    assert.ok(older.messages.every((message) => message.id !== newest.messages[0]?.id), 'the cursor row is exclusive');
  } finally {
    await context.api.close();
  }
});

test('GET /api/messages returns an empty page before the oldest message', async () => {
  const { context, base, scopeId } = await messageHistory(4);
  try {
    const durable = await context.collaboration.listMessages({ scopeId });
    const oldest = [...durable].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0]!;
    const response = await fetch(`${base}/api/messages?scopeId=${encodeURIComponent(scopeId)}&limit=3&before=${encodeURIComponent(oldest.id)}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { messages: unknown[] }).messages, []);
  } finally {
    await context.api.close();
  }
});

test('GET /api/messages reports an unknown backward cursor as a truthful 404', async () => {
  const { context, base, scopeId } = await messageHistory(2);
  try {
    const response = await fetch(`${base}/api/messages?scopeId=${encodeURIComponent(scopeId)}&before=missing-message-cursor`);
    assert.equal(response.status, 404);
    assert.match((await response.json() as { error: string }).error, /missing-message-cursor/);
  } finally {
    await context.api.close();
  }
});

test('GET /api/messages caps a requested limit at the documented maximum', async () => {
  const { context, base, scopeId } = await messageHistory(105);
  try {
    const response = await fetch(`${base}/api/messages?scopeId=${encodeURIComponent(scopeId)}&limit=1000`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { messages: unknown[] }).messages.length, 100);
  } finally {
    await context.api.close();
  }
});

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

test('Task-group API stamps trusted identity and scope, ignores forged envelope fields, and accepts a free-form body', async () => {
  const credential = privateInput();
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  await auth.initializeOrRecover(credential);
  const context = buildWithCollaboration({}, auth);
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const task = {
    taskId: 'task-api-envelope',
    projectId: 'project-sprout',
    title: 'Task API envelope',
    goal: 'Probe channel stamping',
    constraints: [],
    lead: { memberId: 'operator', kind: 'human' as const },
    contentVersion: 1,
  };
  try {
    const group = await context.scopes.scopes.syncTaskGroup({ ...task, status: 'in-progress' });
    const signIn = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(signIn.status, 201);
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = await signIn.json() as { readonly csrfToken: string };
    const response = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { cookie, 'x-sprout-csrf': csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeId: group.id,
        body: '',
        deliveryKey: 'http-task-group-envelope',
        kind: 'question',
        authorId: 'agent-scout',
        authorKind: 'human',
        projectId: 'forged-project',
        taskId: 'forged-task',
        runId: 'forged-run',
        groupId: 'forged-group',
        sender: { id: 'agent-scout', kind: 'agent' },
        to: ['agent-scout'],
        envelope: { kind: 'assignment', sender: { id: 'agent-scout', kind: 'agent' }, taskId: 'forged-task', runId: 'forged-run', workItemId: 'forged-task', groupId: 'forged-group', to: ['agent-scout'] },
      }),
    });
    assert.equal(response.status, 202);
    const delivered = await response.json() as {
      readonly message: {
        readonly authorId: string;
        readonly authorKind: string;
        readonly body: string;
        readonly envelope: Record<string, unknown>;
      };
    };
    assert.equal(delivered.message.body, '');
    assert.equal(delivered.message.authorId, 'operator');
    assert.equal(delivered.message.authorKind, 'human');
    assert.deepEqual(delivered.message.envelope, {
      kind: 'question',
      sender: { id: 'operator', kind: 'human' },
      taskId: task.taskId,
      workItemId: task.taskId,
      groupId: group.id,
      to: [],
    });
    const priorHistory = await context.collaboration.listMessages({ scopeId: group.id });
    await context.scopes.scopes.syncTaskGroup({ ...task, status: 'done' });
    const frozen = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { cookie, 'x-sprout-csrf': csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ scopeId: group.id, body: 'late post', deliveryKey: 'http-task-group-frozen' }),
    });
    assert.equal(frozen.status, 409);
    assert.equal((await frozen.json() as { readonly reason: string }).reason, 'task-group-frozen');
    assert.deepEqual(await context.collaboration.listMessages({ scopeId: group.id }), priorHistory);
  } finally {
    await context.api.close();
  }
});

test('Human-to-Agent direct messages remain available with Human authorship', async () => {
  const credential = privateInput();
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  await auth.initializeOrRecover(credential);
  const context = buildWithCollaboration({}, auth);
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const scopeId = await context.scopes.openDirect('project-sprout', ['operator', 'agent-scout']);
  try {
    const signIn = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(signIn.status, 201);
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = await signIn.json() as { readonly csrfToken: string };
    const response = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { cookie, 'x-sprout-csrf': csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeId,
        authorId: 'agent-scout',
        authorKind: 'human',
        projectId: 'forged-project',
        taskId: 'forged-task',
        runId: 'forged-run',
        groupId: 'forged-group',
        sender: { id: 'agent-scout', kind: 'agent' },
        envelope: { kind: 'assignment', sender: { id: 'agent-scout', kind: 'agent' }, taskId: 'forged-task', runId: 'forged-run', workItemId: 'forged-task', groupId: 'forged-group', to: ['operator'] },
        body: 'Please review this Task update.',
        recipients: ['agent-scout'],
        deliveryKey: 'human-agent-dm-boundary-1',
      }),
    });
    assert.equal(response.status, 202);
    const delivered = await response.json() as {
      message: { readonly id: string; readonly scopeId: string; readonly channel: string; readonly authorId: string; readonly authorKind: string; readonly envelope?: unknown };
      readonly admittedRunIds: readonly string[];
    };
    assert.equal(delivered.message.scopeId, scopeId);
    assert.equal(delivered.message.channel, 'direct');
    assert.equal(delivered.message.authorId, 'operator');
    assert.equal(delivered.message.authorKind, 'human');
    assert.equal(delivered.message.envelope, undefined);
    assert.equal(delivered.admittedRunIds.length, 1);
    const history = await context.collaboration.listMessages({ scopeId });
    assert.ok(
      history.some(message => message.author.kind === 'agent' && message.inReplyTo === delivered.message.id),
      'the Human direct-message reply remains projected into the same Human↔Agent conversation',
    );
  } finally {
    await context.api.close();
  }
});

test('the authenticated browser refuses Agent-authored direct messages', async () => {
  const credential = privateInput();
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  await auth.initializeOrRecover(credential);
  const context = buildWithCollaboration({}, auth);
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const scopeId = await context.scopes.openDirect('project-sprout', ['operator', 'agent-scout']);
  try {
    const signIn = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(signIn.status, 201);
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = await signIn.json() as { readonly csrfToken: string };
    const refusals = await Promise.all(['agent', 'worker'].map(async (authorKind) => {
      const response = await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { cookie, 'x-sprout-csrf': csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ scopeId, authorId: 'agent-scout', authorKind, body: 'forged', deliveryKey: `browser-${authorKind}-forbidden` }),
      });
      return { status: response.status, body: await response.json() };
    }));
    assert.deepEqual(refusals, [
      { status: 403, body: { error: 'browser commands are Human-only', code: 'agent-direct-message-forbidden' } },
      { status: 403, body: { error: 'browser commands are Human-only', code: 'agent-direct-message-forbidden' } },
    ]);
    assert.deepEqual(await context.collaboration.listMessages({ scopeId }), []);
  } finally {
    await context.api.close();
  }
});

test('POST /api/messages rejects agent and worker authors on direct scopes before idempotent delivery', async () => {
  const context = buildWithCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const scopeId = await context.scopes.openDirect('project-sprout', ['human-lead', 'agent-scout']);
  const post = (authorId: string, authorKind: string | undefined, deliveryKey: string) => fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scopeId,
      authorId,
      ...(authorKind !== undefined ? { authorKind } : {}),
      body: 'Agent collaboration belongs in the Task group.',
      deliveryKey,
      awaitReply: false,
    }),
  });
  try {
    const human = await post('human-lead', 'human', 'direct-human-seed');
    assert.equal(human.status, 202);

    const attempts = [
      ['agent-scout', 'agent', 'direct-human-seed'],
      ['agent-scout', 'worker', 'direct-worker-attempt'],
      ['human-lead', 'agent', 'direct-mixed-agent-kind'],
      ['agent-scout', 'agent', 'direct-agent-repeat'],
      ['agent-scout', 'agent', 'direct-agent-repeat'],
    ] as const;
    const refusals = await Promise.all(attempts.map(async ([authorId, authorKind, deliveryKey]) => {
      const response = await post(authorId, authorKind, deliveryKey);
      return { authorKind, status: response.status, body: await response.json() };
    }));
    assert.deepEqual(refusals.map(({ status }) => status), [403, 403, 403, 403, 403]);
    for (const refusal of refusals) {
      assert.deepEqual(refusal.body, {
        error: 'Agent-authored direct messages are unsupported; use Task-group posts for Agent collaboration',
        code: 'agent-direct-message-forbidden',
      });
    }
    const emptyKind = await post('human-lead', '', 'direct-empty-kind');
    const omittedKind = await post('human-lead', undefined, 'direct-omitted-kind');
    assert.deepEqual([emptyKind.status, omittedKind.status], [202, 202]);
    const history = await context.collaboration.listMessages({ scopeId });
    const acceptedHumanKeys = ['direct-empty-kind', 'direct-human-seed', 'direct-omitted-kind'];
    const acceptedHumanMessages = history.filter((message) => acceptedHumanKeys.includes(message.deliveryKey));
    assert.deepEqual(acceptedHumanMessages.map((message) => message.deliveryKey).sort(), acceptedHumanKeys);
    assert.ok(acceptedHumanMessages.every((message) => message.author.kind === 'human'));
    assert.ok(!history.some((message) => message.deliveryKey === 'direct-agent-repeat' || message.deliveryKey === 'direct-worker-attempt' || message.deliveryKey === 'direct-mixed-agent-kind'));
  } finally {
    await context.api.close();
  }
});

test('an in-flight Agent direct post is refused after a Human wins the same delivery key', async () => {
  const context = buildWithCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const scopeId = await context.scopes.openDirect('project-sprout', ['human-lead', 'agent-scout']);
  const scopes = context.scopes.scopes;
  const getScope = scopes.getScope.bind(scopes);
  let scopeReads = 0;
  let releaseCoordinatorRead!: () => void;
  let coordinatorReadStarted!: () => void;
  const coordinatorReadBlocked = new Promise<void>((resolve) => { releaseCoordinatorRead = resolve; });
  const coordinatorRead = new Promise<void>((resolve) => { coordinatorReadStarted = resolve; });
  scopes.getScope = async (candidateScopeId) => {
    const scope = await getScope(candidateScopeId);
    scopeReads += 1;
    if (scopeReads === 2) {
      coordinatorReadStarted();
      await coordinatorReadBlocked;
    }
    return scope;
  };
  const post = (authorId: string, authorKind: 'agent' | 'human') => fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scopeId,
      authorId,
      authorKind,
      body: 'Same key race.',
      deliveryKey: 'direct-race-key',
      awaitReply: false,
    }),
  });
  let inFlightAgentPost: Promise<Response> | undefined;
  try {
    inFlightAgentPost = post('agent-scout', 'agent');
    await coordinatorRead;
    const human = await post('human-lead', 'human');
    releaseCoordinatorRead();
    const agent = await inFlightAgentPost;
    assert.equal(human.status, 202);
    assert.equal(agent.status, 403);
    assert.deepEqual(await agent.json(), {
      error: 'Agent-authored direct messages are unsupported; use Task-group posts for Agent collaboration',
      code: 'agent-direct-message-forbidden',
    });
    const history = await context.collaboration.listMessages({ scopeId });
    // The authorized Human post may already have its non-routing projected
    // reply. Assert delivery-key ownership independently of that async reply.
    const delivered = history.filter(message => message.deliveryKey === 'direct-race-key');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.author.id, 'human-lead');
    assert.equal(delivered[0]?.author.kind, 'human');
  } finally {
    releaseCoordinatorRead();
    await inFlightAgentPost?.catch(() => undefined);
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

test('the message API stores Task-group lifecycle kinds on the Message', async () => {
  const context = buildWithCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const scope = await context.scopes.scopes.syncTaskGroup({
    taskId: 'api-task-group', projectId: 'project-sprout', title: 'API Task group',
    goal: 'Store message intent.', constraints: [], lead: { memberId: 'human-lead', kind: 'human' },
    contentVersion: 1, status: 'in-progress',
  });
  try {
    for (const [index, kind] of (['handoff', 'assignment'] as const).entries()) {
      const response = await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scopeId: scope.id, authorId: 'human-lead', authorKind: 'human',
          body: `Task-group ${kind}.`, deliveryKey: `api-task-group-${index}`, kind, awaitReply: false,
        }),
      });
      assert.equal(response.status, 202);
      const posted = await response.json() as { message: { id: string; kind: string } };
      assert.equal(posted.message.kind, kind);
      assert.equal((await context.collaboration.listMessages()).find((message) => message.id === posted.message.id)?.kind, kind);
    }
    const invalid = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeId: scope.id, authorId: 'human-lead', authorKind: 'human',
        body: 'Unknown kind.', deliveryKey: 'api-task-group-invalid-kind', kind: 'narrative', awaitReply: false,
      }),
    });
    assert.equal(invalid.status, 400);
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
  const unrelatedScopeId = 'direct-unrelated-origin';
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

    const originPageResponse = await fetch(`${base}/api/projects/project-sprout/events?limit=1&originScopeId=${encodeURIComponent(scopeId)}`);
    const originPage = await originPageResponse.json() as { events: { id: string; originScopeIds?: string[] }[]; hasOlder: boolean };
    assert.equal(originPageResponse.status, 200);
    assert.deepEqual(originPage.events.map((item) => item.id), [event.id]);
    assert.ok(originPage.events[0]?.originScopeIds?.includes(scopeId));
    assert.equal(originPage.hasOlder, false);
    const unrelatedPageResponse = await fetch(`${base}/api/projects/project-sprout/events?originScopeId=${encodeURIComponent(unrelatedScopeId)}`);
    const unrelatedPage = await unrelatedPageResponse.json() as { events: unknown[]; hasOlder: boolean };
    assert.deepEqual(unrelatedPage.events, [], 'origin filtering happens before paging');
    assert.equal(unrelatedPage.hasOlder, false);

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

test('posting to a terminal Task group returns a truthful 409 and keeps history readable', async () => {
  const context = buildWithCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const input = {
    taskId: 'task-terminal-api', projectId: 'project-sprout', title: 'Terminal API scope',
    goal: 'Preserve the conversation.', constraints: ['Keep history.'],
    lead: { memberId: 'human-lead', kind: 'human' as const }, contentVersion: 1,
  };
  const scope = await context.scopes.scopes.syncTaskGroup({ ...input, status: 'in-progress' });
  try {
    await context.collaboration.deliver({
      scopeId: scope.id, author: { id: 'human-lead', kind: 'human' },
      body: 'This decision stays available.', deliveryKey: 'task-history-before-freeze', awaitReply: false,
    });
    await context.scopes.scopes.syncTaskGroup({ ...input, status: 'done' });

    const rejected = await fetch(`${base}/api/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeId: scope.id, authorId: 'human-lead', authorKind: 'human',
        body: 'This late post must be rejected.', deliveryKey: 'task-post-after-freeze',
      }),
    });
    assert.equal(rejected.status, 409);
    const failure = await rejected.json() as { error: string; code: string; reason: string };
    assert.equal(failure.code, 'scope-read-only');
    assert.equal(failure.reason, 'task-group-frozen');
    assert.match(failure.error, /frozen.*posting is rejected.*history remains readable/i);

    const history = await fetch(`${base}/api/messages?scopeId=${encodeURIComponent(scope.id)}`);
    assert.equal(history.status, 200);
    const body = await history.json() as { messages: { body: string; channel: string }[] };
    assert.deepEqual(body.messages.map((message) => [message.channel, message.body]), [
      ['task-group', 'This decision stays available.'],
    ]);
  } finally {
    await context.api.close();
  }
});
