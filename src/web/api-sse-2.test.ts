import { definition, instance, projects } from './api-harness.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { createRunApi } from './api.ts';


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
