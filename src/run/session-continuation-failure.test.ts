import { test } from 'node:test';

import assert from 'node:assert/strict';


import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';

import { EnvironmentPool } from '../environment/pool.ts';

import { ScriptedEngineAdapter } from '../engine/scripted.ts';

import type { AgentRunEvent } from '../engine/port.ts';

import { AgentRegistry, type AgentDefinition } from '../agent/registry.ts';

import { ProjectRegistry } from '../project/registry.ts';

import type { Project } from '../project/model.ts';

import { InMemoryRunStore } from './store.ts';

import { InMemorySessionKeyStore } from './session-key-store.ts';

import { RunOrchestrator } from './orchestrator.ts';


/**
 * Cross-run continuation through the durable session-key store.
 *
 * These exercise the core's half of the contract: which key a run is handed and
 * which key it persists. The engine's half (how a real CLI resumes, and how it
 * behaves on a stale key) is documented in #19 and modelled by the scripted
 * fake's `knownSessionKeys`/`staleResumeKey` options.
 */

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};

const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };


/**
 * The project that grants Scout its environment access (O5, #18).
 *
 * An agent names no environment instance: a run's instance comes from the
 * project it is a member of, so the instance dimension of the session-key
 * identity is a membership fact rather than an agent fact. The primary project
 * grants `mac-mini-1`; a test that needs another instance changes the pool set
 * here instead of the agent.
 */
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-sprout',
    goal: 'Continue a conversation across runs',
    rules: ['Stay inside the working directory'],
    availableEnvironmentInstanceIds: ['mac-mini-1'],
    memberships: [
      {
        agentId: 'agent-scout',
        responsibilities: ['Run the task'],
        collaborationInstructions: 'Report what you observed',
      },
    ],
    ...overrides,
  };
}


const events: readonly AgentRunEvent[] = [{ type: 'message', text: 'done', final: true }];

const completed = { status: 'completed', text: 'done' } as const;


function build(options: {
  agent?: Partial<AgentDefinition>;
  turns?: ConstructorParameters<typeof ScriptedEngineAdapter>[0]['turns'];
  knownSessionKeys?: readonly string[];
  staleResumeKey?: 'fresh' | 'fail' | 'fail-turn';
  failStart?: string;
  sessionKeys?: InMemorySessionKeyStore;
  store?: InMemoryRunStore;
  projects?: readonly Project[];
  instances?: readonly EnvironmentInstance[];
}) {
  const agent: AgentDefinition = {
    id: 'agent-scout',
    name: 'Scout',
    engine: 'scripted',
    capability: 'agent-run',
    // No environment instance on the agent (#18): the project decides which
    // pool instance a run resolves to. This value is only the fallback working
    // directory for an instance that declares none, which is exactly the
    // dimension the directory test varies.
    workingDirectory: '/srv/work',
    ...options.agent,
  };
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: options.instances ?? [
      instance,
      { id: 'mac-mini-2', definitionId: 'macos-workstation' },
      { id: 'other-def', definitionId: 'some-other-definition' },
    ],
    clock: { now: () => 1_000 },
  });
  const adapter = new ScriptedEngineAdapter({
    turns: options.turns ?? [{ events, result: completed }],
    ...(options.failStart !== undefined ? { failStart: options.failStart } : {}),
    ...(options.knownSessionKeys !== undefined
      ? { knownSessionKeys: options.knownSessionKeys }
      : {}),
    ...(options.staleResumeKey !== undefined ? { staleResumeKey: options.staleResumeKey } : {}),
  });
  const sessionKeys = options.sessionKeys ?? new InMemorySessionKeyStore();
  const store = options.store ?? new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: new AgentRegistry([agent]),
    projects: new ProjectRegistry(options.projects ?? [project()]),
    pool,
    store,
    sessionKeys,
    leaseTtlMs: 60_000,
    clock: { now: () => 5_000 },
  });
  return { orchestrator, adapter, sessionKeys, store, agent };
}


test('an empty-turn failure with a stored key is not retried and keeps the key', async () => {
  // SK-001: a valid resume whose first turn fails before emitting any event is
  // *not* a refusal. The engine never said the key was bad, so the key must not
  // be deleted and the run must not be silently retried fresh.
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'a-valid-key',
    updatedAt: 1_000,
  });
  const { orchestrator, adapter } = build({
    sessionKeys,
    // Any supplied key is accepted (healthy resume), but the turn fails with no
    // events and no refusal classification.
    turns: [
      {
        events: [],
        result: { status: 'failed', message: 'provider authentication failed' },
      },
    ],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /provider authentication failed/);
  assert.equal(adapter.requests.length, 1, 'an empty non-refusal turn is not retried fresh');
  assert.equal(adapter.requests[0]?.resumeSessionKey, 'a-valid-key');
  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
  });
  assert.equal(stored?.key, 'a-valid-key', 'the key survives an empty non-refusal failure');
});


test('a run without a stored key is not retried when the engine fails', async () => {
  // Nothing was refused, so a failure is a real failure and retrying would
  // double the work.
  const sessionKeys = new InMemorySessionKeyStore();
  const { orchestrator, adapter } = build({
    sessionKeys,
    turns: [{ events: [], result: { status: 'failed', message: 'engine exploded' } }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.equal(adapter.requests.length, 1, 'a fresh failure is reported, not retried');
});


test('a soft-fallback engine is not retried, because it never fails', async () => {
  // Pi and agy warn and start fresh themselves (#19), so the core hands them the
  // key once and takes whatever session the engine reports.
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'stale-key',
    updatedAt: 1_000,
  });
  const { orchestrator, adapter } = build({
    sessionKeys,
    knownSessionKeys: ['some-other-key'],
    staleResumeKey: 'fresh',
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal(adapter.requests.length, 1, 'no retry was needed');
  assert.equal(adapter.requests[0]?.resumeSessionKey, 'stale-key');
  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
  });
  assert.equal(stored?.key, 'scripted-key-1', 'the fresh key replaces the stale one');
});


test('a key is not persisted for a run that never completed', async () => {
  const sessionKeys = new InMemorySessionKeyStore();
  const adapter = new ScriptedEngineAdapter({
    turns: [{ events, result: { status: 'failed', message: 'engine exploded' } }],
  });
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: new AgentRegistry([
      {
        id: 'agent-scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/srv/work',
      },
    ]),
    projects: new ProjectRegistry([project()]),
    pool,
    store: new InMemoryRunStore(),
    sessionKeys,
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'boom' });
  await orchestrator.waitFor(id);

  assert.equal((await sessionKeys.list()).length, 0);
});


test('runs without a session-key store keep their old fresh-session behaviour', async () => {
  const adapter = new ScriptedEngineAdapter({
    turns: [{ events, result: completed }],
  });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: new AgentRegistry([
      {
        id: 'agent-scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/srv/work',
      },
    ]),
    projects: new ProjectRegistry([project()]),
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
  });

  const first = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'one' });
  await orchestrator.waitFor(first.id);
  const second = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'two' });
  await orchestrator.waitFor(second.id);

  assert.equal(adapter.requests[0]?.resumeSessionKey, undefined);
  assert.equal(adapter.requests[1]?.resumeSessionKey, undefined);
});
