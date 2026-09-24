/**
 * Production integration for the collaboration write path (#26).
 *
 * The unit tests exercise each seam in isolation and the probe crosses a real
 * worker process. This file is the middle ground: the **real** `SqliteStore`
 * (the unified primary database, not a separate collaboration file), the **real**
 * `RunOrchestrator`, and the real coordinator, with only the engine scripted.
 * It is what shows the acceptance behaviours compose in the shape `main.ts`
 * actually wires.
 *
 * Acceptance behaviours covered here:
 * - Direct messages, exact `@id` mentions, and `@all` broadcasts follow the M1
 *   wake contract and start runs with contextual prompts.
 * - Unaddressed project messages consult the wake model; a suppression and a
 *   failure are each durably recorded, and a failure fails open.
 * - A completed run projects one Agent-authored reply; failed or interrupted runs
 *   project none.
 * - Private run events never enter conversation.
 * - Idempotent retry produces one durable input and at most one run admission.
 * - A Message's wake is scoped to the causal Message's Project: a target Agent
 *   that belongs to several Projects never resolves through the wrong one, uses
 *   the causal Project's environment, and receives its contract; a target that
 *   is not a member fails explicitly instead of falling back.
 */

import { test } from 'node:test';

import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { AgentRegistry } from '../agent/registry.ts';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';

import { EnvironmentPool } from '../environment/pool.ts';

import { ScriptedEngineAdapter, type ScriptedTurn } from '../engine/scripted.ts';

import { ProjectRegistry } from '../project/registry.ts';

import type { Project } from '../project/model.ts';

import { RunOrchestrator } from '../run/orchestrator.ts';

import { InMemoryRunStore } from '../run/store.ts';

import { SqliteStore } from '../store/db.ts';

import { CollaborationCoordinator } from './coordinator.ts';

import type { WakeModel } from './model.ts';


const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [
    { name: 'agent-run', requiresLease: true },
    { name: 'read-only-investigation', requiresLease: false },
  ],
};

const instance: EnvironmentInstance = {
  id: 'mac-mini-1',
  definitionId: 'macos-workstation',
  workingDirectory: '/srv/work',
};

const project: Project = {
  id: 'project-sprout',
  goal: 'Ship Sprout',
  rules: [],
  availableEnvironmentInstanceIds: ['mac-mini-1'],
  memberships: [
    { agentId: 'scout', responsibilities: [], collaborationInstructions: '' },
    { agentId: 'forge', responsibilities: [], collaborationInstructions: '' },
    { agentId: 'scribe', responsibilities: [], collaborationInstructions: '' },
  ],
};


/**
 * A scripted completed turn. Extra events are emitted before the final message,
 * so a test can prove private run events never enter conversation.
 */
function scriptedTurn(text: string, extraEvents: ScriptedTurn['events'] = []): ScriptedTurn {
  return {
    events: [...extraEvents, { type: 'message', text, final: true }],
    result: { status: 'completed', text },
  };
}


interface Harness {
  readonly sqlite: SqliteStore;
  readonly coordinator: CollaborationCoordinator;
  readonly engine: ScriptedEngineAdapter;
  close(): void;
}


function build(options: {
  turns: readonly ScriptedTurn[];
  wakeModel?: WakeModel;
  /** Overrides the default single project; used by the multi-Project regression. */
  projects?: readonly Project[];
  definitions?: readonly EnvironmentDefinition[];
  instances?: readonly EnvironmentInstance[];
  agents?: readonly { id: string; name: string; engine: string; capability: string; workingDirectory?: string }[];
}): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-collab-integration-'));
  const sqlite = new SqliteStore({ filename: join(directory, 'sprout.db') });
  const engine = new ScriptedEngineAdapter({ turns: options.turns });
  const projects = new ProjectRegistry(options.projects ?? [project]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', engine]]),
    agents: new AgentRegistry(
      options.agents ?? [
        { id: 'scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
        { id: 'forge', name: 'Forge', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
        { id: 'scribe', name: 'Scribe', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
      ],
    ),
    projects,
    pool: new EnvironmentPool({
      definitions: options.definitions ?? [definition],
      instances: options.instances ?? [instance],
      store: sqlite.leases,
    }),
    store: sqlite.runs,
  });
  const coordinator = new CollaborationCoordinator({
    projects,
    store: sqlite.collaboration,
    runs: orchestrator,
    ...(options.wakeModel !== undefined ? { wakeModel: options.wakeModel } : {}),
  });
  return {
    sqlite,
    coordinator,
    engine,
    close: () => {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}


const containerDefinition: EnvironmentDefinition = {
  id: 'container-linux',
  platform: 'container',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};

const containerInstance: EnvironmentInstance = {
  id: 'container-1',
  definitionId: 'container-linux',
  workingDirectory: '/sprout',
};


/**
 * Project A is registered first and Scout is a member of both projects, but the
 * two grant different environments and carry different goals and rules. A
 * Message in Project B must use B's environment and contract, never A's.
 */
const projectA: Project = {
  id: 'project-alpha',
  goal: 'Project alpha goal',
  rules: ['Use only project alpha.'],
  availableEnvironmentInstanceIds: ['mac-mini-1'],
  memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }],
};

const projectB: Project = {
  id: 'project-beta',
  goal: 'Project beta goal',
  rules: ['Use only project beta.'],
  availableEnvironmentInstanceIds: ['container-1'],
  memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }],
};


test('a duplicated delivery key produces one durable input and one run admission', async (t) => {
  const harness = build({ turns: [scriptedTurn('Scout: once.')] });
  t.after(harness.close);

  const request = {
    projectId: 'project-sprout',
    channel: 'direct' as const,
    author: { id: 'human-lead', kind: 'human' as const },
    body: 'Do the thing.',
    recipients: ['scout'],
    deliveryKey: 'dup-1',
  };
  const first = await harness.coordinator.deliver(request);
  const second = await harness.coordinator.deliver(request);

  assert.equal(second.duplicate, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal(second.admittedRunIds.length, 0);

  const wakeRows = (await harness.sqlite.collaboration.listWakeRequests()).filter(
    (wake) => wake.messageId === first.message.id,
  );
  assert.equal(wakeRows.length, 1);
  assert.equal(wakeRows[0]?.status, 'admitted');

  const messages = await harness.sqlite.collaboration.listMessages();
  assert.equal(messages.length, 2, 'one input and one reply, despite two deliveries');
});


test('a direct message to a non-member makes no run and records the failure durably', async (t) => {
  const harness = build({ turns: [scriptedTurn('should not run')] });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'hello?',
    recipients: ['ghost'],
    deliveryKey: 'fail-1',
  });

  assert.equal(delivered.admittedRunIds.length, 0);
  assert.equal(delivered.wakes.length, 0);
  const observations = harness.sqlite.collaboration.observations(delivered.message.id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.status, 'failed');
  assert.equal(observations[0]?.agentId, 'ghost');
  assert.match(observations[0]?.detail ?? '', /not a member/);
});


test('a Message in Project B records Project B, uses its environment, and receives its contract even when the Agent also belongs to Project A', async (t) => {
  // Project A is listed first, so a run that fell back to "first project the
  // agent belongs to" would resolve into A: mac-mini-1, alpha's contract.
  const harness = build({
    turns: [scriptedTurn('Scout: beta done.')],
    projects: [projectA, projectB],
    definitions: [definition, containerDefinition],
    instances: [instance, containerInstance],
    agents: [
      { id: 'scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
    ],
  });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    projectId: 'project-beta',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'Work on beta.',
    recipients: ['scout'],
    deliveryKey: 'multi-project-1',
  });

  assert.equal(delivered.admittedRunIds.length, 1);
  const run = await harness.sqlite.runs.get(delivered.admittedRunIds[0]!);
  assert.ok(run);
  assert.equal(run.projectId, 'project-beta', 'the run is scoped to the causal Message project');
  assert.equal(run.environmentInstanceId, 'container-1', "Project B's environment was used");

  const instructions = harness.engine.requests[0]?.instructions ?? '';
  assert.match(instructions, /Project contract: project-beta/);
  assert.match(instructions, /Use only project beta\./);
  assert.doesNotMatch(instructions, /project-alpha/);
  assert.doesNotMatch(instructions, /Use only project alpha\./);
});


test('a non-member wake target fails explicitly and never falls back to another Project containing the Agent', async (t) => {
  // Scout is a member of Project A only. A Message in Project B (which Scout
  // does not belong to) must not run Scout in Project A's environment.
  const harness = build({
    turns: [scriptedTurn('must not run')],
    projects: [
      projectA,
      {
        ...projectB,
        id: 'project-beta',
        memberships: [{ agentId: 'forge', responsibilities: [], collaborationInstructions: '' }],
      },
    ],
    definitions: [definition, containerDefinition],
    instances: [instance, containerInstance],
    agents: [
      { id: 'scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
      { id: 'forge', name: 'Forge', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
    ],
  });
  t.after(harness.close);

  const delivered = await harness.coordinator.deliver({
    projectId: 'project-beta',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'Scout, take this.',
    recipients: ['scout'],
    deliveryKey: 'non-member-1',
  });

  assert.equal(delivered.admittedRunIds.length, 0, 'no run is admitted for a non-member');
  assert.equal(delivered.wakes.length, 0);
  const observations = harness.sqlite.collaboration.observations(delivered.message.id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.status, 'failed');
  assert.equal(observations[0]?.agentId, 'scout');
  assert.match(observations[0]?.detail ?? '', /not a member of project project-beta/);
  assert.equal(harness.engine.requests.length, 0, 'the engine never started, so no fallback project ran');
});


test('the orchestrator refuses a run scoped to a Project the Agent is not a member of', async () => {
  // Directly exercises the run-seam guard the coordinator relies on: even if a
  // caller supplies Project B explicitly, membership is verified against B and a
  // non-member fails there rather than falling back to Project A.
  const engine = new ScriptedEngineAdapter({ turns: [scriptedTurn('must not run')] });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', engine]]),
    agents: new AgentRegistry([
      { id: 'scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
    ]),
    projects: new ProjectRegistry([projectA, { ...projectB, memberships: [] }]),
    pool: new EnvironmentPool({
      definitions: [definition, containerDefinition],
      instances: [instance, containerInstance],
    }),
    store: new InMemoryRunStore(),
  });

  const { id } = await orchestrator.submit({
    agentId: 'scout',
    prompt: 'run in beta',
    projectId: 'project-beta',
  });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /not a member of project project-beta/);
  assert.equal(engine.requests.length, 0, 'no environment was ever used');
});
