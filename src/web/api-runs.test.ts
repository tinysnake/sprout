import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { createRunApi, summarizeRunHistory, type RunView } from './api.ts';
import { OperatorSessionService } from '../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../auth/store.ts';

import { withServer, waitForTerminal, privateInput, signIn, buildWithCollaboration } from './api-harness.ts';

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
