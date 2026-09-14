import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { createRunApi } from './api.ts';

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

function build(options: { settleAfterMs?: number } = {}) {
  const adapter = new ScriptedEngineAdapter({
    turns: [
      {
        events: [
          { type: 'tool-call', name: 'shell', detail: 'echo hi' },
          { type: 'message', text: 'done', final: true },
        ],
        result: { status: 'completed', text: 'done' },
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
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });
  const api = createRunApi({ orchestrator, agents: registry });
  return { api, orchestrator };
}

async function withServer(
  fn: (base: string, context: ReturnType<typeof build>) => Promise<void>,
  options: { settleAfterMs?: number } = {},
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
