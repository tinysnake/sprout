import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { CollaborationCoordinator } from '../collaboration/coordinator.ts';
import { InMemoryCollaborationStore } from '../collaboration/store.ts';
import { createRunApi, summarizeRunHistory, type RunView } from './api.ts';
import type { ApiRouter } from './router.ts';
import { OperatorSessionService } from '../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../auth/store.ts';
import { randomBytes } from 'node:crypto';

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

/** The project that gives Scout its environment access. */
const projects = new ProjectRegistry([
  {
    id: 'project-sprout',
    goal: 'Ship Sprout',
    rules: [],
    availableEnvironmentInstanceIds: ['mac-mini-1'],
    memberships: [
      { agentId: 'agent-scout', responsibilities: ['Investigate'], collaborationInstructions: '' },
    ],
  },
]);

function build(options: {
  settleAfterMs?: number;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
} = {}) {
  const adapter = new ScriptedEngineAdapter({
    turns: [
      {
        events: [
          { type: 'tool-call', name: 'shell', detail: 'echo hi' },
          { type: 'message', text: 'done', final: true },
        ],
        result: {
          status: 'completed',
          text: 'done',
          ...(options.tokenUsage !== undefined ? { tokenUsage: options.tokenUsage } : {}),
        },
        ...(options.settleAfterMs !== undefined ? { settleAfterMs: options.settleAfterMs } : {}),
      },
    ],
  });
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool,
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });
  const api = createRunApi({ orchestrator, agents: registry });
  return { api, orchestrator, pool };
}

async function withServer(
  fn: (base: string, context: ReturnType<typeof build>) => Promise<void>,
  options: {
    settleAfterMs?: number;
    tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  } = {},
): Promise<void> {
  const context = build(options);
  const { port } = await context.api.listen(0);
  try {
    await fn(`http://127.0.0.1:${port}`, context);
  } finally {
    await context.api.close();
  }
}

async function waitForTerminal(base: string, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${base}/api/runs/${id}`);
    const run = (await response.json()) as Record<string, unknown>;
    if (run.status !== 'running' && run.status !== 'queued') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not settle');
}

function privateInput(): string {
  return randomBytes(32).toString('base64url');
}

async function protectedApi() {
  const context = build();
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  const credential = privateInput();
  await auth.initializeOrRecover(credential);
  const api = createRunApi({
    orchestrator: context.orchestrator,
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    auth,
  });
  const { port } = await api.listen(0);
  return { api, auth, credential, base: `http://127.0.0.1:${port}` };
}

async function signIn(base: string, credential: string): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const response = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  assert.equal(response.status, 201);
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=\d+/);
  assert.match(setCookie, /Expires=/);
  assert.equal(setCookie.includes(credential), false);
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return { cookie: setCookie.split(';', 1)[0]!, csrf: csrfToken };
}

test('protected API requires a browser session and request-forgery proof for Human commands', async () => {
  const protectedRuntime = await protectedApi();
  try {
    assert.equal((await fetch(`${protectedRuntime.base}/api/runs`)).status, 401);
    assert.equal((await fetch(`${protectedRuntime.base}/api/runs`, { method: 'POST' })).status, 401);

    const browser = await signIn(protectedRuntime.base, protectedRuntime.credential);
    assert.equal((await fetch(`${protectedRuntime.base}/api/runs`, { headers: { cookie: browser.cookie } })).status, 200);
    assert.equal(
      (await fetch(`${protectedRuntime.base}/api/runs`, {
        method: 'POST', headers: { cookie: browser.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent-scout', prompt: 'bounded request' }),
      })).status,
      403,
    );
    const submitted = await fetch(`${protectedRuntime.base}/api/runs`, {
      method: 'POST',
      headers: { cookie: browser.cookie, 'x-sprout-csrf': browser.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'bounded request' }),
    });
    assert.equal(submitted.status, 202);
  } finally {
    await protectedRuntime.api.close();
  }
});

test('protected API lists and revokes sessions without exposing bearer values', async () => {
  const protectedRuntime = await protectedApi();
  try {
    const first = await signIn(protectedRuntime.base, protectedRuntime.credential);
    const second = await signIn(protectedRuntime.base, protectedRuntime.credential);
    const list = await fetch(`${protectedRuntime.base}/api/auth/sessions`, { headers: { cookie: first.cookie } });
    assert.equal(list.status, 200);
    const sessions = (await list.json()) as { sessions: { id: string; current: boolean }[] };
    assert.equal(sessions.sessions.length, 2);
    assert.equal(JSON.stringify(sessions).includes('sprout_session'), false);

    const revoked = await fetch(`${protectedRuntime.base}/api/auth/sessions/revoke-others`, {
      method: 'POST', headers: { cookie: first.cookie, 'x-sprout-csrf': first.csrf },
    });
    assert.equal(revoked.status, 200);
    assert.equal(((await revoked.json()) as { revoked: number }).revoked, 1);
    assert.equal((await fetch(`${protectedRuntime.base}/api/runs`, { headers: { cookie: second.cookie } })).status, 401);
  } finally {
    await protectedRuntime.api.close();
  }
});

test('an additive domain router composes without changing preserved M1 routes', async () => {
  const context = build();
  const futureRouter: ApiRouter = {
    name: 'future-domain',
    async handle(request) {
      if (request.method !== 'GET' || request.pathname !== '/api/future') return false;
      const payload = JSON.stringify({ source: 'future-domain' });
      request.response.writeHead(200, { 'content-type': 'application/json' });
      request.response.end(payload);
      return true;
    },
  };
  const api = createRunApi({ orchestrator: context.orchestrator, agents: new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
  ]), routers: [futureRouter] });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/future`)).json(), { source: 'future-domain' });
    assert.equal((await fetch(`${base}/api/runs`)).status, 200, 'the M1 route remains composed after the new domain route');
  } finally {
    await api.close();
  }
});

test('a user can submit a request from the Web client and inspect the result', async () => {
  await withServer(async (base) => {
    const submit = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'say hi' }),
    });
    assert.equal(submit.status, 202);
    const { id } = (await submit.json()) as { id: string };
    assert.ok(id);

    const run = await waitForTerminal(base, id);
    assert.equal(run.status, 'completed');
    assert.deepEqual(run.result, { status: 'completed', text: 'done' });
    assert.deepEqual(
      (run.events as { type: string }[]).map((event) => event.type),
      ['tool-call', 'message'],
    );
  });
});

test('run detail and history expose token usage and timestamps', async () => {
  const expected = { promptTokens: 120, completionTokens: 30, totalTokens: 150 };
  await withServer(async (base) => {
    const submitted = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'say hi' }),
    });
    const { id } = (await submitted.json()) as { id: string };
    const detail = await waitForTerminal(base, id) as {
      tokenUsage?: unknown;
      createdAt?: unknown;
      completedAt?: unknown;
    };
    const history = (await (await fetch(`${base}/api/runs`)).json()) as {
      runs: Array<{ id: string; tokenUsage?: unknown; createdAt?: unknown; completedAt?: unknown }>;
      totals?: {
        durationMs: number;
        tokenUsage: unknown;
        completedRunCount: number;
        runsWithTokenUsage: number;
      };
    };

    assert.deepEqual(detail.tokenUsage, expected);
    assert.equal(typeof detail.createdAt, 'number');
    assert.equal(typeof detail.completedAt, 'number');
    const historyRun = history.runs.find((run) => run.id === id);
    assert.deepEqual(historyRun?.tokenUsage, expected);
    assert.equal(typeof historyRun?.createdAt, 'number');
    assert.equal(typeof historyRun?.completedAt, 'number');
    assert.deepEqual(history.totals?.tokenUsage, expected);
    assert.ok((history.totals?.durationMs ?? -1) >= 0, 'history includes cumulative terminal duration');
    assert.equal(history.totals?.completedRunCount, 1);
    assert.equal(history.totals?.runsWithTokenUsage, 1);
  }, { tokenUsage: expected });
});

test('run history totals accumulate terminal duration and provider usage without hiding unavailable usage', () => {
  const runs: RunView[] = [
    {
      id: 'run-a', agentId: 'agent-scout', prompt: 'first', status: 'completed', events: [],
      createdAt: 1_000, completedAt: 2_500,
      tokenUsage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 }, handOffAttached: false,
    },
    {
      id: 'run-b', agentId: 'agent-scout', prompt: 'second', status: 'completed', events: [],
      createdAt: 4_000, completedAt: 6_500, handOffAttached: false,
    },
  ];

  assert.deepEqual(summarizeRunHistory(runs), {
    durationMs: 4_000,
    tokenUsage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    completedRunCount: 2,
    runsWithTokenUsage: 1,
  });
});

test('a submission without an agent or prompt is rejected', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'no agent' }),
    });
    assert.equal(response.status, 400);
  });
});

test('the user can stop a run through the API', async () => {
  await withServer(
    async (base) => {
      const submit = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent-scout', prompt: 'long job' }),
      });
      const { id } = (await submit.json()) as { id: string };
      await new Promise((resolve) => setTimeout(resolve, 20));

      const stop = await fetch(`${base}/api/runs/${id}/stop`, { method: 'POST' });
      assert.equal(stop.status, 200);
      const stopped = (await stop.json()) as Record<string, unknown>;
      assert.equal(stopped.status, 'interrupted');
    },
    { settleAfterMs: 5_000 },
  );
});

test('a recovered run lease can be explicitly released through its run control', async () => {
  await withServer(async (base, context) => {
    const submit = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'long job' }),
    });
    const { id } = (await submit.json()) as { id: string };

    let leaseId: string | undefined;
    for (let attempt = 0; attempt < 100 && leaseId === undefined; attempt += 1) {
      leaseId = context.orchestrator.get(id)?.leaseId;
      if (leaseId === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(leaseId, 'the running run acquired its lease');
    context.pool.markRecovering(leaseId);

    const released = await fetch(`${base}/api/runs/${id}/release-lease`, { method: 'POST' });
    assert.equal(released.status, 200);
    assert.equal(((await released.json()) as { released: boolean }).released, true);
    assert.equal(context.pool.getLease(leaseId)?.state, 'released');

    await fetch(`${base}/api/runs/${id}/stop`, { method: 'POST' });
  }, { settleAfterMs: 5_000 });
});

test('the client view exposes progress but no engine internals', async () => {
  await withServer(async (base) => {
    const submit = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'say hi' }),
    });
    const { id } = (await submit.json()) as { id: string };
    const run = await waitForTerminal(base, id);

    assert.equal('leaseId' in run, false, 'lease identity is not part of the client contract');
    assert.equal('environmentInstanceId' in run, false);
    assert.ok(Array.isArray(run.events));
  });
});

test('an unknown run is a 404 rather than an empty success', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/runs/nope`);
    assert.equal(response.status, 404);
  });
});

test('progress is pushed to the client before the run settles', async () => {
  await withServer(
    async (base) => {
      const response = await fetch(`${base}/api/events`);
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      const reader = response.body?.getReader();
      assert.ok(reader);
      const decoder = new TextDecoder();

      const submit = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent-scout', prompt: 'say hi' }),
      });
      const { id } = (await submit.json()) as { id: string };

      let received = '';
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !received.includes('"status":"completed"')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value);
      }
      await reader.cancel();

      assert.match(received, /event: run/);
      assert.ok(received.includes(id));
      const events = received
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
      const statuses = events.filter((event) => event.id === id).map((event) => event.status);
      assert.ok(
        statuses.includes('running'),
        `expected an observable running state before completion, saw ${JSON.stringify(statuses)}`,
      );
      assert.equal(statuses.at(-1), 'completed');
      assert.ok(statuses.indexOf('running') < statuses.length - 1);
    },
    { settleAfterMs: 60 },
  );
});

test('SSE Last-Event-ID replays only later run snapshots', async () => {
  await withServer(async (base) => {
    const first = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'first stream run' }),
    });
    const { id: firstId } = await first.json() as { id: string };
    await waitForTerminal(base, firstId);

    const initial = await fetch(`${base}/api/events`);
    const initialReader = initial.body?.getReader();
    assert.ok(initialReader);
    let initialText = '';
    while (!initialText.includes('"status":"completed"')) {
      const chunk = await initialReader.read();
      if (chunk.done) break;
      initialText += new TextDecoder().decode(chunk.value);
    }
    const cursor = [...initialText.matchAll(/^id: ([^\n]+)$/gm)].at(-1)?.[1];
    assert.ok(cursor, 'the initial durable snapshot has an SSE cursor');
    await initialReader.cancel();

    const resumed = await fetch(`${base}/api/events`, { headers: { 'last-event-id': cursor } });
    const reader = resumed.body?.getReader();
    assert.ok(reader);
    const second = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'second stream run' }),
    });
    const { id: secondId } = await second.json() as { id: string };

    let received = '';
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !received.includes(secondId)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    assert.match(received, new RegExp(secondId));
    assert.equal(received.includes(firstId), false, 'a durable snapshot before the cursor is not replayed');
  });
});

test('runs persisted by a previous process are listed after a restart', async () => {
  // Regression: a restarted process listed no runs, even though `GET /api/runs/:id`
  // could still read them, so the client showed an empty history.
  const store = new InMemoryRunStore();
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);
  const adapter = new ScriptedEngineAdapter({
    turns: [
      { events: [{ type: 'message', text: 'done', final: true }], result: { status: 'completed', text: 'done' } },
    ],
  });

  const first = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store,
  });
  const firstApi = createRunApi({ orchestrator: first, agents: registry });
  const { port: firstPort } = await firstApi.listen(0);
  const submit = await fetch(`http://127.0.0.1:${firstPort}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'agent-scout', prompt: 'say hi' }),
  });
  const { id } = (await submit.json()) as { id: string };
  await first.waitFor(id);
  await firstApi.close();

  // A fresh process: same durable store, empty in-memory state.
  const second = new RunOrchestrator({
    engines: new Map(),
    agents: registry,
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store,
  });
  const secondApi = createRunApi({ orchestrator: second, agents: registry });
  const { port: secondPort } = await secondApi.listen(0);
  const listed = (await (await fetch(`http://127.0.0.1:${secondPort}/api/runs`)).json()) as {
    runs: { id: string; status: string }[];
  };
  await secondApi.close();

  assert.equal(listed.runs.length, 1);
  assert.equal(listed.runs[0]?.id, id);
  assert.equal(listed.runs[0]?.status, 'completed');
});

test('the API lists leases and allows releasing a lease', async () => {
  const definition: EnvironmentDefinition = {
    id: 'macos-workstation',
    platform: 'macos',
    capabilities: [{ name: 'agent-run', requiresLease: true }],
  };
  const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });
  const acquired = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    holderId: 'agent-scout',
    ttlMs: 60_000,
  });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;

  pool.markRecovering(acquired.lease.id);

  const orchestrator = new RunOrchestrator({
    engines: new Map(),
    agents: new AgentRegistry([]),
    pool,
    store: new InMemoryRunStore(),
  });

  const api = createRunApi({ orchestrator, agents: new AgentRegistry([]) });
  const { port } = await api.listen(0);

  // GET /api/leases
  const listResponse = await fetch(`http://127.0.0.1:${port}/api/leases`);
  assert.equal(listResponse.status, 200);
  const { leases } = (await listResponse.json()) as { leases: { id: string; state: string }[] };
  assert.equal(leases.length, 1);
  assert.equal(leases[0]?.id, acquired.lease.id);
  assert.equal(leases[0]?.state, 'recovering');

  // POST /api/leases/:id/release
  const releaseResponse = await fetch(`http://127.0.0.1:${port}/api/leases/${acquired.lease.id}/release`, {
    method: 'POST',
  });
  assert.equal(releaseResponse.status, 200);
  const released = (await releaseResponse.json()) as { id: string; state: string };
  assert.equal(released.state, 'released');

  assert.equal(pool.activeLease('mac-mini-1'), undefined);
  await api.close();
});

/**
 * Collaboration routes (#26).
 *
 * These use the real coordinator over an in-memory store and the real
 * orchestrator over the scripted engine: exactly the wiring `main.ts` uses, with
 * only the engine faked. They prove the project channel is reachable from the
 * core's existing HTTP seam, and that the routes hold no wake logic of their own.
 */
function buildWithCollaboration(options: { body?: string } = {}, auth?: OperatorSessionService) {
  const adapter = new ScriptedEngineAdapter({
    turns: [
      {
        events: [
          { type: 'tool-output', text: 'TOOL_OUTPUT_MUST_NOT_LEAK' },
          { type: 'message', text: options.body ?? 'Scout: replied.', final: true },
        ],
        result: { status: 'completed', text: options.body ?? 'Scout: replied.' },
      },
    ],
  });
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);
  const store = new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store,
    leaseTtlMs: 60_000,
  });
  const collaboration = new CollaborationCoordinator({
    projects,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
  });
  const api = createRunApi({
    orchestrator,
    agents: registry,
    collaboration,
    projects,
    ...(auth !== undefined ? { auth } : {}),
  });
  return { api, orchestrator, collaboration };
}

test('an Agent or Worker request cannot manufacture Human message authority', async () => {
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  const credential = privateInput();
  await auth.initializeOrRecover(credential);
  const context = buildWithCollaboration({}, auth);
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const browser = await signIn(base, credential);
    const request = (authorKind: string) => fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { cookie: browser.cookie, 'x-sprout-csrf': browser.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-sprout', channel: 'direct', authorId: 'forged', authorKind,
        body: 'request', recipients: ['agent-scout'], deliveryKey: `forged-${authorKind}`,
      }),
    });
    assert.equal((await request('agent')).status, 403);
    assert.equal((await request('worker')).status, 403);

    const accepted = await request('human');
    assert.equal(accepted.status, 202);
    assert.equal(((await accepted.json()) as { message: { authorId: string; authorKind: string } }).message.authorId, 'operator');
  } finally {
    await context.api.close();
  }
});

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
function buildObservableCollaboration(options: { settleAfterMs?: number } = {}) {
  const adapter = new ScriptedEngineAdapter({
    turns: [
      {
        events: [{ type: 'message', text: 'Scout: replied.', final: true }],
        result: { status: 'completed', text: 'Scout: replied.' },
        ...(options.settleAfterMs !== undefined ? { settleAfterMs: options.settleAfterMs } : {}),
      },
    ],
  });
  const registry = new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    { id: 'agent-ranger', name: 'Ranger', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
  ]);
  const twoMemberProjects = new ProjectRegistry([
    {
      id: 'project-sprout',
      goal: 'Ship Sprout',
      rules: [],
      availableEnvironmentInstanceIds: ['mac-mini-1'],
      memberships: [
        { agentId: 'agent-scout', responsibilities: ['Investigate'], collaborationInstructions: '' },
        { agentId: 'agent-ranger', responsibilities: ['Review'], collaborationInstructions: '' },
      ],
    },
  ]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects: twoMemberProjects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });
  const collaboration = new CollaborationCoordinator({
    projects: twoMemberProjects,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
  });
  const api = createRunApi({ orchestrator, agents: registry, collaboration, projects: twoMemberProjects });
  return { api, orchestrator };
}

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

test('an unknown mention failure is visible through the observations route', async () => {
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
          body: '@ghost are you there?',
          deliveryKey: 'web-unknown-mention-1',
        }),
      })
    ).json()) as { message: { id: string }; wakes: unknown[]; admittedRunIds: string[] };
    assert.equal(delivered.wakes.length, 0, 'an unknown target wakes nobody');
    assert.equal(delivered.admittedRunIds.length, 0);

    const observations = (await (
      await fetch(`${base}/api/messages/${delivered.message.id}/observations`)
    ).json()) as { observations: { status: string; reason: string; agentId: string; detail: string }[] };
    const failure = observations.observations.find((observation) => observation.status === 'failed');
    assert.ok(failure, 'the unknown target is reported, not silently dropped');
    assert.equal(failure.reason, 'agent-mention');
    assert.equal(failure.agentId, 'ghost');
    assert.match(failure.detail, /not a member/);
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

test('the project list is absent when no project registry is configured', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/projects`);
    assert.equal(response.status, 404);
  });
});
