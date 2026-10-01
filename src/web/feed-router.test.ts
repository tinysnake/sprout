/**
 * Feed API evidence (#103): the read-only HTTP contract.
 *
 * `GET /api/feed` serves the derived snapshot behind the operator session and
 * applies read filters; no method or path on this route set can dismiss or
 * snooze Attention, and attention changes only when its source changes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { build, privateInput, signIn } from './api-harness.ts';
import { createRunApi } from './api.ts';
import { createFeedRouter } from './feed-router.ts';
import { createFeedProjection, type FeedSources } from './feed.ts';
import { OperatorSessionService } from '../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../auth/store.ts';
import { AgentRegistry } from '../agent/registry.ts';
import type { Task } from '../task/model.ts';
import type { EnvironmentEnrollment } from '../environment/enrollment.ts';

const PROJECT_ID = 'proj-api-feed';

function blockerTask(): Task {
  return {
    id: 'task-api',
    projectId: PROJECT_ID,
    title: 'Blocked work',
    goal: 'Prove the API',
    constraints: [],
    status: 'blocked',
    environmentInstanceId: 'env-api',
    environmentLeaseId: 'lease-api',
    environmentLifecycleState: 'blocked',
    blocker: {
      reason: 'Waiting on host permission.',
      requiredAction: 'Grant permission.',
      responsible: { kind: 'external-condition', condition: 'permission' },
      nextAdvancer: { memberId: 'human-1', memberKind: 'human' },
      createdBy: { memberId: 'agent-scout', memberKind: 'agent' },
      createdAt: 200,
    },
    createdAt: 1,
    updatedAt: 200,
  };
}

function pendingEnrollment(): EnvironmentEnrollment {
  return {
    id: 'enr-api',
    environmentInstanceId: 'env-api-2',
    displayName: 'API Host',
    status: 'pending',
    everApproved: false,
    worker: { identityDigest: 'digest-api', platform: 'linux', capabilityRequests: [], engineFacts: [] },
    invalidatedIdentityDigests: [],
    requiresFreshIdentity: false,
    claim: undefined,
    capabilityPermissions: {},
    createdAt: 1,
    updatedAt: 150,
    revision: 1,
    decisions: [],
  };
}

interface MutableWorld {
  tasks: Task[];
  enrollments: EnvironmentEnrollment[];
  promptMarker: string;
}

function sources(world: MutableWorld): FeedSources {
  return {
    projects: async () => [{ id: PROJECT_ID, displayName: 'API Feed' }],
    tasks: async () => world.tasks,
    proposals: async () => [],
    events: async () => [],
    enrollments: async () => world.enrollments,
    recoveries: async () => [],
    runs: async () => [{
      id: 'run-api',
      agentId: 'agent-scout',
      prompt: world.promptMarker,
      environmentInstanceId: 'env-api',
      projectId: PROJECT_ID,
      status: 'running' as const,
      events: [{ type: 'tool-output' as const, text: `${world.promptMarker}-tool` }],
      createdAt: 300,
    }],
    routingBatches: async () => [],
  };
}

async function startApi(
  world: MutableWorld,
  options: { readonly auth: true; readonly credential: string } | { readonly auth: false },
) {
  const context = build();
  const registry = new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
  ]);
  const feed = createFeedProjection(sources(world));
  const auth = options.auth ? new OperatorSessionService({ store: new InMemoryOperatorSessionStore() }) : undefined;
  if (options.auth && auth !== undefined) await auth.initializeOrRecover(options.credential);
  const api = createRunApi({
    orchestrator: context.orchestrator,
    agents: registry,
    ...(auth !== undefined ? { auth } : {}),
    routers: [createFeedRouter({ feed })],
  });
  const { port } = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

interface FeedBody {
  attention: { id: string; severity: string; category: string; reason: string; lifecycle: string; target: { path: string } }[];
  inFlight: { id: string }[];
  activity: unknown[];
  scopes: { id: string; attentionCount: number }[];
}

test('GET /api/feed requires the operator session and serves the derived snapshot', async () => {
  const world: MutableWorld = { tasks: [blockerTask()], enrollments: [pendingEnrollment()], promptMarker: 'PROMPT_API_SECRET' };
  const credential = privateInput();
  const { api, base } = await startApi(world, { auth: true, credential });
  try {
    assert.equal((await fetch(`${base}/api/feed`)).status, 401, 'the transport refuses anonymous reads');

    const session = await signIn(base, credential);
    const response = await fetch(`${base}/api/feed`, { headers: { cookie: session.cookie } });
    assert.equal(response.status, 200);
    const body = await response.json() as FeedBody;
    assert.deepEqual(body.attention.map((item) => item.id), ['blocker:task-api', 'enrollment:enr-api']);
    assert.equal(body.attention[0]?.severity, 'action_required');
    assert.match(body.attention[0]?.reason ?? '', /Waiting on host permission/);
    assert.match(body.attention[0]?.lifecycle ?? '', /Task blocked/);
    assert.equal(body.attention[0]?.target.path, '/project/tasks/task-api');
    assert.deepEqual(body.inFlight.map((item) => item.id), ['run:run-api']);
    assert.deepEqual(body.scopes.map((option) => option.id), ['all', PROJECT_ID, 'infra']);
    assert.ok(!JSON.stringify(body).includes('PROMPT_API_SECRET'), 'the wire never carries run internals');

    const filteredResponse = await fetch(
      `${base}/api/feed?scope=${encodeURIComponent(PROJECT_ID)}&urgency=action_required`,
      { headers: { cookie: session.cookie } },
    );
    const filtered = await filteredResponse.json() as FeedBody;
    assert.deepEqual(filtered.attention.map((item) => item.id), ['blocker:task-api'], 'scope and urgency filter server-side');
    assert.equal(filtered.inFlight.length, 1, 'urgency never hides in-flight work');

    const infra = await (await fetch(`${base}/api/feed?scope=infra`, { headers: { cookie: session.cookie } })).json() as FeedBody;
    assert.deepEqual(infra.attention.map((item) => item.id), ['enrollment:enr-api']);

    assert.equal((await fetch(`${base}/api/feed?scope=ghost`, { headers: { cookie: session.cookie } })).status, 400, 'unknown scope refuses');
    assert.equal((await fetch(`${base}/api/feed?urgency=urgent`, { headers: { cookie: session.cookie } })).status, 400, 'unknown urgency refuses');
  } finally {
    await api.close();
  }
});

test('the Feed route set exposes no dismiss or snooze command', async () => {
  const world: MutableWorld = { tasks: [blockerTask()], enrollments: [pendingEnrollment()], promptMarker: 'x' };
  const credential = privateInput();
  const { api, base } = await startApi(world, { auth: true, credential });
  try {
    const session = await signIn(base, credential);
    const headers: Record<string, string> = {
      cookie: session.cookie,
      'x-sprout-csrf': session.csrf,
      'content-type': 'application/json',
    };
    for (const path of [
      '/api/feed/attention/blocker%3Atask-api/dismiss',
      '/api/feed/attention/blocker%3Atask-api/snooze',
      '/api/feed/snooze',
      '/api/feed/acknowledge',
    ]) {
      for (const method of ['POST', 'DELETE'] as const) {
        const response = await fetch(`${base}${path}`, { method, headers, body: '{}' });
        assert.equal(response.status, 404, `${method} ${path} must not exist`);
      }
    }
    assert.equal((await fetch(`${base}/api/feed`, { method: 'POST', headers, body: '{}' })).status, 404);
    assert.equal((await fetch(`${base}/api/feed`, { method: 'DELETE', headers })).status, 404);

    // The attention item is still there: no command could have removed it.
    const body = await (await fetch(`${base}/api/feed`, { headers: { cookie: session.cookie } })).json() as FeedBody;
    assert.ok(body.attention.some((item) => item.id === 'blocker:task-api'));
  } finally {
    await api.close();
  }
});

test('attention over the API changes only when its authoritative source changes', async () => {
  const world: MutableWorld = { tasks: [blockerTask()], enrollments: [pendingEnrollment()], promptMarker: 'x' };
  const credential = privateInput();
  const { api, base } = await startApi(world, { auth: true, credential });
  try {
    const session = await signIn(base, credential);
    const read = async (): Promise<string[]> => {
      const body = await (await fetch(`${base}/api/feed`, { headers: { cookie: session.cookie } })).json() as FeedBody;
      return body.attention.map((item) => item.id);
    };
    const first = await read();
    assert.deepEqual(first, ['blocker:task-api', 'enrollment:enr-api']);
    assert.deepEqual(await read(), first, 'repeated reads are stateless and identical');

    // The authoritative source clears: the blocker is gone from the Task.
    world.tasks = world.tasks.map((task) => {
      const { blocker: _blocker, ...rest } = task;
      return { ...rest, status: 'todo' as const, environmentLifecycleState: 'idle' as const, updatedAt: 900 };
    });
    assert.deepEqual(await read(), ['enrollment:enr-api'], 'only the source change removed the item');
  } finally {
    await api.close();
  }
});

test('an unauthenticated composition refuses the Feed snapshot at the router', async () => {
  const world: MutableWorld = { tasks: [blockerTask()], enrollments: [], promptMarker: 'x' };
  const { api, base } = await startApi(world, { auth: false });
  try {
    const response = await fetch(`${base}/api/feed`);
    assert.equal(response.status, 401, 'the router itself refuses without an operator session id');
  } finally {
    await api.close();
  }
});
