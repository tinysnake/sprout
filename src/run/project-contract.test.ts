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
 * Contract delivery and cross-environment hand-off, through the orchestrator
 * (#21 acceptance).
 *
 * These exercise the core's half: what a run is handed (the assembled contract,
 * on every run) and when a hand-off is attached (an environment change, never a
 * same-environment continuation). The engine's half — how each CLI receives
 * instructions — is in `src/engine/instructions-channel.test.ts`.
 */

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};

/**
 * Two instances of the *same* definition, so a project can resolve either and the
 * only thing that varies between runs is the instance the run used.
 */
const instances: readonly EnvironmentInstance[] = [
  { id: 'mac-mini-1', definitionId: 'macos-workstation' },
  { id: 'mac-mini-2', definitionId: 'macos-workstation' },
];

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-sprout',
    goal: 'Ship a portable project context',
    rules: ['Report what you observed'],
    availableEnvironmentInstanceIds: ['mac-mini-1', 'mac-mini-2'],
    memberships: [
      {
        agentId: 'agent-scout',
        responsibilities: ['Investigate the repository'],
        collaborationInstructions: 'Keep results concise',
      },
    ],
    ...overrides,
  };
}

const events: readonly AgentRunEvent[] = [{ type: 'message', text: 'done', final: true }];

function build(options: {
  turns?: ConstructorParameters<typeof ScriptedEngineAdapter>[0]['turns'];
  projects?: readonly Project[];
  sessionKeys?: InMemorySessionKeyStore;
  store?: InMemoryRunStore;
  instances?: readonly EnvironmentInstance[];
}) {
  const agent: AgentDefinition = {
    id: 'agent-scout',
    name: 'Scout',
    engine: 'scripted',
    capability: 'agent-run',
    workingDirectory: '/srv/work',
    instructions: 'You are Scout.',
  };
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: options.instances ?? instances,
    clock: { now: () => 1_000 },
  });
  const adapter = new ScriptedEngineAdapter({
    turns: options.turns ?? [{ events, result: { status: 'completed', text: 'done' } }],
  });
  const store = options.store ?? new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: new AgentRegistry([agent]),
    projects: new ProjectRegistry(options.projects ?? [project()]),
    pool,
    store,
    ...(options.sessionKeys !== undefined ? { sessionKeys: options.sessionKeys } : {}),
    leaseTtlMs: 60_000,
    clock: { now: () => 5_000 },
  });
  return { orchestrator, adapter, store };
}

test('every run receives the assembled project contract as standing instructions', async () => {
  const { orchestrator, adapter } = build({});
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  await orchestrator.waitFor(id);

  const instructions = adapter.requests[0]?.instructions ?? '';
  assert.match(instructions, /# Project contract: project-sprout/);
  assert.match(instructions, /Goal: Ship a portable project context/);
  assert.match(instructions, /- Report what you observed/);
  assert.match(instructions, /- Investigate the repository/);
  assert.match(instructions, /Collaboration: Keep results concise/);
  assert.match(instructions, /You are Scout\./);
});

test('a run on a different environment instance than the previous run gets hand-off context', async () => {
  const store = new InMemoryRunStore();
  const { orchestrator, adapter } = build({ store });

  // Run one resolves the project's first available instance.
  const first = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'first task' });
  await orchestrator.waitFor(first.id);

  // The project's environment order changes, so run two resolves the other one.
  // This models a re-evaluation that moves the agent to a different instance.
  const moved = build({
    store,
    projects: [
      project({
        availableEnvironmentInstanceIds: ['mac-mini-2', 'mac-mini-1'],
      }),
    ],
  });
  void adapter;
  const second = await moved.orchestrator.submit({ agentId: 'agent-scout', prompt: 'continue' });
  const run = await moved.orchestrator.waitFor(second.id);

  assert.equal(run.environmentInstanceId, 'mac-mini-2');
  assert.ok(run.handOff, 'the environment change attached a hand-off');
  assert.equal(run.handOff.previousEnvironmentInstanceId, 'mac-mini-1');
  assert.match(run.handOff.text, /Completed in mac-mini-1: done/);
});

test('the hand-off reaches the engine as the run input, on the moved run only', async () => {
  const store = new InMemoryRunStore();
  const first = build({ store });
  const runOne = await first.orchestrator.submit({ agentId: 'agent-scout', prompt: 'first task' });
  await first.orchestrator.waitFor(runOne.id);

  const moved = build({
    store,
    projects: [project({ availableEnvironmentInstanceIds: ['mac-mini-2', 'mac-mini-1'] })],
  });
  const runTwo = await moved.orchestrator.submit({ agentId: 'agent-scout', prompt: 'continue' });
  const settled = await moved.orchestrator.waitFor(runTwo.id);

  assert.ok(settled.handOff);
  // The core recorded the hand-off, and the prompt the engine received carries it.
  assert.match(settled.handOff.text, /Completed in mac-mini-1: done/);
  const prompt = moved.adapter.sessions[0]?.prompts[0] ?? '';
  assert.match(prompt, /## Hand-off context/);
  assert.match(prompt, /Completed in mac-mini-1: done/);
  assert.match(prompt, /## Task\ncontinue/);
  // The first run's prompt had no hand-off section at all.
  const firstPrompt = first.adapter.sessions[0]?.prompts[0] ?? '';
  assert.doesNotMatch(firstPrompt, /## Hand-off context/);
  assert.equal(firstPrompt, 'first task');
});

test('a same-environment continuation does not duplicate context into the prompt', async () => {
  const sessionKeys = new InMemorySessionKeyStore();
  const store = new InMemoryRunStore();
  const { orchestrator, adapter } = build({ store, sessionKeys });

  const first = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'first task' });
  await orchestrator.waitFor(first.id);
  const second = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'second task' });
  const run = await orchestrator.waitFor(second.id);

  // Same instance, and the session key continued, so no hand-off is attached.
  assert.equal(run.environmentInstanceId, 'mac-mini-1');
  assert.equal(run.handOff, undefined, 'a continued session needs no hand-off');
  assert.equal(adapter.requests.length, 2);
  // The second run was resumed, not started fresh.
  assert.ok(adapter.requests[1]?.resumeSessionKey, 'the second run continued the session');
  // And its prompt is the user's alone: no duplicated context section.
  assert.equal(adapter.sessions[1]?.prompts[0], 'second task');
});

test('a first run in a project never attaches a hand-off', async () => {
  const { orchestrator, adapter } = build({});
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'first ever' });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.handOff, undefined);
  assert.equal(adapter.requests[0]?.resumeSessionKey, undefined);
});

test('a moved run records the environment it used and its hand-off durably', async () => {
  const store = new InMemoryRunStore();
  const first = build({ store });
  const runOne = await first.orchestrator.submit({ agentId: 'agent-scout', prompt: 'first task' });
  await first.orchestrator.waitFor(runOne.id);

  const moved = build({
    store,
    projects: [project({ availableEnvironmentInstanceIds: ['mac-mini-2', 'mac-mini-1'] })],
  });
  const runTwo = await moved.orchestrator.submit({ agentId: 'agent-scout', prompt: 'continue' });
  await moved.orchestrator.waitFor(runTwo.id);

  // Persisted, not just in memory: a fresh read of the store sees both facts.
  const persisted = await store.get(runTwo.id);
  assert.equal(persisted?.environmentInstanceId, 'mac-mini-2');
  assert.equal(persisted?.handOff?.previousEnvironmentInstanceId, 'mac-mini-1');
});

test('the hand-off contains no verbatim events or transcripts from prior runs', async () => {
  const store = new InMemoryRunStore();
  // A prior run whose events carry another agent's raw output and reasoning.
  await store.save({
    id: 'run-prior',
    agentId: 'agent-scout',
    prompt: 'earlier work',
    environmentInstanceId: 'mac-mini-1',
    projectId: 'project-sprout',
    status: 'completed',
    events: [
      { type: 'tool-output', text: 'SECRET_TOOL_OUTPUT_DO_NOT_LEAK' },
      { type: 'message', text: 'SECRET_REASONING_DO_NOT_LEAK', final: true },
    ],
    result: { status: 'completed', text: 'finished the earlier task' },
    createdAt: 1_000,
  });

  const { orchestrator } = build({
    store,
    projects: [project({ availableEnvironmentInstanceIds: ['mac-mini-2'] })],
  });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'continue' });
  const run = await orchestrator.waitFor(id);

  assert.ok(run.handOff);
  assert.match(run.handOff.text, /finished the earlier task/);
  assert.doesNotMatch(run.handOff.text, /SECRET_TOOL_OUTPUT_DO_NOT_LEAK/);
  assert.doesNotMatch(run.handOff.text, /SECRET_REASONING_DO_NOT_LEAK/);
});

test('a moved run does not receive the previous environment session key', async () => {
  // ADR-0004: a session key is scoped to one instance, so the moved run must
  // start fresh — which is exactly why the hand-off exists.
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'key-from-mac-mini-1',
    updatedAt: 1_000,
  });

  const { orchestrator, adapter } = build({
    sessionKeys,
    projects: [project({ availableEnvironmentInstanceIds: ['mac-mini-2'] })],
  });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'continue' });
  await orchestrator.waitFor(id);

  assert.equal(adapter.requests[0]?.resumeSessionKey, undefined);
});
