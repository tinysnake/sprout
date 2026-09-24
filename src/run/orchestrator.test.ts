import { test } from 'node:test';

import assert from 'node:assert/strict';


import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';import { EnvironmentPool } from '../environment/pool.ts';

import { ScriptedEngineAdapter } from '../engine/scripted.ts';import type { AgentRunEvent } from '../engine/port.ts';

import { AgentRegistry, type AgentDefinition } from '../agent/registry.ts';

import { ProjectRegistry } from '../project/registry.ts';

import type { Project } from '../project/model.ts';

import { InMemoryRunStore } from './store.ts';

import { RunOrchestrator } from './orchestrator.ts';


const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [
    { name: 'agent-run', requiresLease: true },
    { name: 'read-only-investigation', requiresLease: false },
  ],
};

const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };


/** The project that grants Scout its environment access, shared by the tests. */
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-sprout',
    goal: 'Ship Sprout',
    rules: ['Report what you observed'],
    availableEnvironmentInstanceIds: ['mac-mini-1'],
    memberships: [
      {
        agentId: 'agent-scout',
        responsibilities: ['Investigate'],
        collaborationInstructions: 'Keep it short',
      },
    ],
    ...overrides,
  };
}


function build(options: {
  turns?: ConstructorParameters<typeof ScriptedEngineAdapter>[0]['turns'];
  failStart?: string;
  onInterrupt?: () => void;
  projects?: readonly Project[];
  agent?: AgentDefinition;
}) {
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    clock: { now: () => 1_000 },
  });
  const adapter = new ScriptedEngineAdapter({
    turns: options.turns ?? [],
    ...(options.failStart !== undefined ? { failStart: options.failStart } : {}),
    ...(options.onInterrupt !== undefined ? { onInterrupt: options.onInterrupt } : {}),
  });
  const registry = new AgentRegistry([
    options.agent ?? {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
      instructions: 'You are Scout.',
    },
  ]);
  const store = new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects: new ProjectRegistry(options.projects ?? [project()]),
    pool,
    store,
    leaseTtlMs: 60_000,
  });
  return { orchestrator, adapter, pool, store, registry };
}


const successEvents: readonly AgentRunEvent[] = [
  { type: 'notice', text: 'starting' },
  { type: 'tool-call', name: 'shell', detail: 'echo hi' },
  { type: 'tool-output', text: 'hi' },
  { type: 'message', text: 'done', final: true },
];


const completed = { status: 'completed', text: 'done' } as const;


test('a submitted run acquires its lease, streams progress, and completes', async () => {
  const { orchestrator, pool } = build({
    turns: [{ events: successEvents, result: completed }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.deepEqual(
    run.events.map((event) => event.type),
    ['notice', 'tool-call', 'tool-output', 'message'],
  );
  assert.equal(run.result?.status, 'completed');
  assert.equal(run.result?.status === 'completed' && run.result.text, 'done');

  const lease = pool.leases()[0];
  assert.equal(lease?.holderId, 'agent-scout');
  assert.equal(lease?.state, 'released', 'lease is released on completion');
  assert.equal(pool.activeLease('mac-mini-1'), undefined);
});


test('a completed engine turn records its token usage on the durable run', async () => {
  const tokenUsage = { promptTokens: 120, completionTokens: 30, totalTokens: 150 };
  const { orchestrator, store } = build({
    turns: [{ events: successEvents, result: { ...completed, tokenUsage } }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  const settled = await orchestrator.waitFor(id);

  assert.deepEqual(settled.tokenUsage, tokenUsage);
  assert.deepEqual((await store.get(id))?.tokenUsage, tokenUsage);
});


test('submission returns before the run settles, and progress is observable meanwhile', async () => {
  const { orchestrator } = build({
    turns: [{ events: successEvents, result: completed, settleAfterMs: 40 }],
  });

  const observed: string[] = [];
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  orchestrator.subscribe((run) => {
    if (run.id === id) observed.push(run.status);
  });

  const before = orchestrator.get(id);
  assert.ok(before, 'the run is inspectable immediately after submission');
  assert.notEqual(before.status, 'completed', 'submission does not block until completion');

  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.ok(
    observed.includes('running'),
    `expected an observable running state, saw ${JSON.stringify(observed)}`,
  );
  assert.ok(
    observed.filter((status) => status === 'running').length >= 1 &&
      observed.at(-1) === 'completed',
    `expected progress before the terminal state, saw ${JSON.stringify(observed)}`,
  );
  const firstProgressAt = run.events.findIndex((event) => event.type === 'tool-call');
  assert.ok(firstProgressAt < run.events.length - 1, 'tool progress precedes the final message');
});


test('a conflicting run is refused instead of sharing the environment', async () => {
  const { orchestrator, adapter } = build({
    turns: [{ events: successEvents, result: completed, settleAfterMs: 200 }],
  });

  const first = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'first' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'second' });
  const refused = await orchestrator.waitFor(second.id);

  assert.equal(refused.status, 'failed');
  assert.equal(refused.result?.status, 'failed');
  assert.match(
    refused.result?.status === 'failed' ? refused.result.message : '',
    /lease|environment/i,
  );
  assert.equal(adapter.requests.length, 1, 'the engine never started for the refused run');

  await orchestrator.waitFor(first.id);
});


test('the user can stop a running run and the lease is released', async () => {
  let interrupted = false;
  const { orchestrator, pool } = build({
    onInterrupt: () => {
      interrupted = true;
    },
    turns: [
      {
        events: [{ type: 'notice', text: 'working' }],
        result: completed,
        settleAfterMs: 5_000,
      },
    ],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'long job' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const stopped = await orchestrator.stop(id);

  assert.equal(interrupted, true, 'the adapter received an interrupt');
  assert.equal(stopped.status, 'interrupted');
  assert.equal(stopped.result?.status, 'interrupted');
  assert.equal(pool.activeLease('mac-mini-1'), undefined);
  assert.equal((await orchestrator.waitFor(id)).status, 'interrupted');
});


test('an engine failure becomes an explicit failed state and releases the lease', async () => {
  const { orchestrator, pool } = build({
    turns: [{ events: successEvents, result: { status: 'failed', message: 'engine exploded' } }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'boom' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.equal(run.result?.status === 'failed' && run.result.message, 'engine exploded');
  assert.equal(pool.activeLease('mac-mini-1'), undefined);
});


test('a failure to start the engine becomes an explicit failed state', async () => {
  const { orchestrator, pool } = build({ failStart: 'codex binary missing' });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'boom' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.result?.status === 'failed' ? run.result.message : '', /codex binary missing/);
  assert.equal(pool.activeLease('mac-mini-1'), undefined);
});


test('a missing working directory becomes a persisted failed state and releases the lease', async () => {
  const { orchestrator, pool, store, adapter } = build({
    turns: [],
    agent: {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
    },
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'where am I?' });
  const run = await orchestrator.waitFor(id);
  const persisted = await store.get(id);

  assert.equal(run.status, 'failed');
  assert.match(run.result?.status === 'failed' ? run.result.message : '', /no working directory/i);
  assert.equal(persisted?.status, 'failed', 'the failed terminal state is persisted');
  assert.equal(persisted?.result?.status, 'failed');
  assert.equal(pool.activeLease('mac-mini-1'), undefined, 'the acquired lease is released');
  assert.equal(adapter.requests.length, 0, 'the engine never starts without a directory');
});


test('the agent identity and its environment are Sprout-owned', async () => {
  const { orchestrator, adapter } = build({
    turns: [{ events: successEvents, result: completed }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  await orchestrator.waitFor(id);

  assert.equal(adapter.requests[0]?.agentId, 'agent-scout');
  assert.equal(adapter.requests[0]?.workingDirectory, '/tmp');
  // Standing instructions are no longer the agent's own string passed through:
  // they are the assembled project contract (O5), which includes the agent's
  // configuration as well as the project's goal, rules, and responsibilities.
  const instructions = adapter.requests[0]?.instructions ?? '';
  assert.match(instructions, /Project contract: project-sprout/);
  assert.match(instructions, /Goal: Ship Sprout/);
  assert.match(instructions, /Report what you observed/);
  assert.match(instructions, /Investigate/);
  assert.match(instructions, /You are Scout\./);
});


test('a finished run is persisted so it survives a restart', async () => {
  const { orchestrator, store } = build({
    turns: [{ events: successEvents, result: completed }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  await orchestrator.waitFor(id);

  const restored = new RunOrchestrator({
    engines: new Map(),
    agents: new AgentRegistry([]),
    pool: new EnvironmentPool({ definitions: [], instances: [] }),
    store,
  });
  const recovered = await restored.load(id);

  assert.equal(recovered?.status, 'completed');
  assert.equal(recovered?.result?.status === 'completed' && recovered.result.text, 'done');
  assert.equal(recovered?.events.length, successEvents.length);
});


test('an unknown agent is refused', async () => {
  const { orchestrator } = build({ turns: [] });
  const { id } = await orchestrator.submit({ agentId: 'nobody', prompt: 'hello' });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.status, 'failed');
  assert.match(run.result?.status === 'failed' ? run.result.message : '', /unknown agent/i);
});


test('a run whose agent has no engine adapter is refused', async () => {
  const orchestrator = new RunOrchestrator({
    engines: new Map(),
    agents: new AgentRegistry([
      {
        id: 'agent-scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/tmp',
      },
    ]),
    projects: new ProjectRegistry([project()]),
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hello' });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.status, 'failed');
  assert.match(run.result?.status === 'failed' ? run.result.message : '', /no engine/i);
});


test('run ids stay unique across a restart so a new run cannot overwrite a stored one', async () => {
  // Regression: a per-process counter produced `run-1` twice, so a restarted
  // process overwrote an already-persisted `run-1` and destroyed its evidence.
  const store = new InMemoryRunStore();
  const { createIdFactory } = await import('../ids.ts');

  const first = new RunOrchestrator({
    engines: new Map(),
    agents: new AgentRegistry([]),
    pool: new EnvironmentPool({ definitions: [], instances: [] }),
    store,
    ids: createIdFactory(),
  });
  const second = new RunOrchestrator({
    engines: new Map(),
    agents: new AgentRegistry([]),
    pool: new EnvironmentPool({ definitions: [], instances: [] }),
    store,
    ids: createIdFactory(),
  });

  const a = await first.submit({ agentId: 'nobody', prompt: 'first' });
  const b = await second.submit({ agentId: 'nobody', prompt: 'second' });

  assert.notEqual(a.id, b.id, 'a restarted process must not reuse a persisted run id');
  assert.equal((await store.list()).length, 2);
});
