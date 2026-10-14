import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineAdapter, EngineTurnResult } from '../engine/port.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { AgentRegistry } from '../agent/registry.ts';
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

function project(agentId: string): Project {
  return {
    id: 'project-sprout',
    goal: 'Ship Sprout',
    rules: ['Report what you observed'],
    availableEnvironmentInstanceIds: ['mac-mini-1'],
    memberships: [
      {
        agentId,
        responsibilities: ['Investigate'],
        collaborationInstructions: 'Keep it short',
      },
    ],
  };
}

function scriptedAdapter(result: EngineTurnResult): EngineAdapter {
  return {
    id: 'codex',
    capabilities: {
      streaming: 'incremental',
      supportsInterrupt: true,
      standingInstructions: 'out-of-band',
    },
    async startSession() {
      return {
        sessionId: 'engine-session',
        engineSessionKey: 'engine-session',
        run: () => ({ events: emptyEvents(), completion: Promise.resolve(result) }),
        async interrupt() {
          return false;
        },
        async close() {},
      };
    },
  };
}

async function* emptyEvents() {}

function buildFor(adapter: EngineAdapter, agentId: string) {
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    clock: { now: () => 1_000 },
  });
  const registry = new AgentRegistry([
    {
      id: agentId,
      name: 'Scout',
      engine: 'codex',
      capability: 'agent-run',
      workingDirectory: '/tmp',
      instructions: 'You are Scout.',
    },
  ]);
  const store = new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: new Map([['codex', adapter]]),
    agents: registry,
    projects: new ProjectRegistry([project(agentId)]),
    pool,
    store,
    leaseTtlMs: 60_000,
  });
  return { orchestrator, store };
}

test('a classified engine failure settles and persists a failed run', async () => {
  const message = 'codex turn failed: the engine rejected the turn start';
  const { orchestrator, store } = buildFor(scriptedAdapter({ status: 'failed', message }), 'agent-failed');

  const { id } = await orchestrator.submit({ agentId: 'agent-failed', prompt: 'do the work' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.equal(run.failure, message);
  assert.deepEqual(run.result, { status: 'failed', message });
  assert.equal(run.tokenUsage, undefined, 'a failed turn records no invented usage');
  assert.equal((await store.get(id))?.status, 'failed');
  assert.equal((await store.get(id))?.failure, message);
});

test('a successful empty turn remains a completed run', async () => {
  const { orchestrator, store } = buildFor(scriptedAdapter({ status: 'completed', text: '' }), 'agent-empty');

  const { id } = await orchestrator.submit({ agentId: 'agent-empty', prompt: 'say nothing' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal(run.failure, undefined);
  assert.deepEqual(run.result, { status: 'completed', text: '' });
  assert.equal((await store.get(id))?.status, 'completed');
});
