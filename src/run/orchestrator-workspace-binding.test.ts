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


test('a registered Project workspace is passed to the Worker as its relative repository location', async () => {
  const { orchestrator, adapter } = build({
    turns: [{ events: successEvents, result: completed }],
    projects: [project({ workspaces: [{ environmentInstanceId: 'mac-mini-1', path: 'minesweeper' }] })],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'inspect the scaffold' });
  await orchestrator.waitFor(id);

  assert.equal(adapter.requests[0]?.projectWorkspaceId, 'project-sprout');
  assert.equal(adapter.requests[0]?.projectWorkspacePath, 'minesweeper');
  // The continuation slot names the workspace location, so a later change to a
  // different workspace starts a new native session slot (ADR-0004/ADR-0008).
  assert.equal(
    adapter.requests[0]?.workingDirectory,
    'project-workspace:project-sprout:minesweeper',
  );
});


test('a run records the environment instance it used, observably through the store', async () => {
  const { orchestrator, store } = build({
    turns: [{ events: successEvents, result: completed }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'say hi' });
  await orchestrator.waitFor(id);

  const stored = await store.get(id);
  assert.equal(stored?.environmentInstanceId, 'mac-mini-1');
  assert.equal(stored?.projectId, 'project-sprout');
  assert.equal(
    store.writes.every((write) => write.environmentInstanceId === 'mac-mini-1'),
    true,
    'every persisted state names the instance actually used',
  );
});


test('two agents whose project-resolved environments conflict are prevented from concurrent use', async () => {
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    clock: { now: () => 1_000 },
  });
  const adapter = new ScriptedEngineAdapter({
    turns: [{ events: successEvents, result: completed, settleAfterMs: 200 }],
  });
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
    {
      id: 'agent-cartographer',
      name: 'Cartographer',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);
  // Both agents are members of the same project, so both resolve to the same
  // single available instance and their leases must conflict.
  const projects = new ProjectRegistry([
    project({
      memberships: [
        {
          agentId: 'agent-scout',
          responsibilities: ['Investigate'],
          collaborationInstructions: 'Keep it short',
        },
        {
          agentId: 'agent-cartographer',
          responsibilities: ['Map'],
          collaborationInstructions: 'Keep it short',
        },
      ],
    }),
  ]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool,
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });

  const first = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'first' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await orchestrator.submit({ agentId: 'agent-cartographer', prompt: 'second' });
  const refused = await orchestrator.waitFor(second.id);

  assert.equal(refused.status, 'failed');
  assert.match(refused.failure ?? '', /mac-mini-1/);
  assert.match(refused.failure ?? '', /leased|recovery/i);
  assert.equal(adapter.requests.length, 1, 'the engine never started for the refused run');

  await orchestrator.waitFor(first.id);
});


test('an agent that belongs to no project is refused rather than guessed at', async () => {
  const { orchestrator } = build({ turns: [], projects: [] });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hello' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /no project/i);
});


test('an agent whose project offers no usable environment is refused explicitly', async () => {
  const { orchestrator } = build({
    turns: [],
    projects: [project({ availableEnvironmentInstanceIds: ['some-other-machine'] })],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hello' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /no available environment/i);
});


test('a run records the durable workspace binding it was admitted under and uses it for the Worker start', async () => {
  const store = new InMemoryRunStore();
  let adapter: ScriptedEngineAdapter | undefined;
  const bindingReads: string[] = [];
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    clock: { now: () => 1_000 },
  });
  const projects = new ProjectRegistry([
    // A stale projection: the access record moved on, the registry has not.
    project({ workspaces: [{ environmentInstanceId: 'mac-mini-1', path: 'repos/stale-projection' }] }),
  ]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([
      ['scripted', (adapter = new ScriptedEngineAdapter({
        turns: [{ events: successEvents, result: completed }],
      }))],
    ]),
    agents: new AgentRegistry([
      {
        id: 'agent-scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/tmp',
      },
    ]),
    projects,
    pool,
    store,
    workspaceBinding: async (projectId, instanceId) => {
      bindingReads.push(`${projectId}@${instanceId}`);
      return {
        bindingId: 'binding-9',
        workspaceId: 'e'.repeat(24),
        kind: 'relative',
        path: 'repos/current-binding',
      };
    },
    leaseTtlMs: 60_000,
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'inspect' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.deepEqual(run.workspaceBinding, {
    bindingId: 'binding-9',
    workspaceId: 'e'.repeat(24),
    kind: 'relative',
    path: 'repos/current-binding',
  });
  assert.deepEqual(bindingReads, ['project-sprout@mac-mini-1'], 'the binding is read once at admission');
  // The Worker start carries the durable opaque identity and location, not the
  // registry projection's stale path.
  assert.equal(adapter!.requests[0]?.projectWorkspaceId, 'e'.repeat(24));
  assert.equal(adapter!.requests[0]?.projectWorkspaceKind, 'relative');
  assert.equal(adapter!.requests[0]?.projectWorkspacePath, 'repos/current-binding');
  assert.equal(adapter!.requests[0]?.workingDirectory, 'project-workspace:' + 'e'.repeat(24) + ':repos/current-binding');

  const stored = await store.get(id);
  assert.deepEqual(stored?.workspaceBinding, run.workspaceBinding, 'the binding is durable');
});


test('a run with no durable binding falls back to the projection, with its location validated', async () => {
  // No workspaceBinding port: the pre-#93 graph. The projection's relative
  // location still crosses the boundary only after the relative-path validator.
  const { orchestrator, adapter } = build({
    turns: [{ events: successEvents, result: completed }],
    projects: [project({ workspaces: [{ environmentInstanceId: 'mac-mini-1', path: 'repos/legacy' }] })],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'inspect' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal('workspaceBinding' in run, false, 'no binding is invented');
  assert.equal(adapter.requests[0]?.projectWorkspaceId, 'project-sprout');
  assert.equal(adapter.requests[0]?.projectWorkspacePath, 'repos/legacy');

  // A corrupt projection carrying an absolute path must not cross the boundary:
  // the unsafe location is dropped, and the run keeps the portable default slot.
  const corrupt = build({
    turns: [{ events: successEvents, result: completed }],
    projects: [project({ workspaces: [{ environmentInstanceId: 'mac-mini-1', path: '/etc/passwd' }] })],
  });
  const corruptSubmit = await corrupt.orchestrator.submit({ agentId: 'agent-scout', prompt: 'inspect' });
  const settled = await corrupt.orchestrator.waitFor(corruptSubmit.id);
  assert.equal(settled.status, 'completed');
  const request = corrupt.adapter.requests.at(-1);
  assert.equal(request?.projectWorkspacePath, undefined, 'the absolute path is refused, not forwarded');
  assert.equal(request?.projectWorkspaceId, 'project-sprout');
  assert.equal(
    corrupt.store.writes.some((write) => JSON.stringify(write).includes('/etc/passwd')),
    false,
    'the absolute path is never persisted',
  );
});


test('a corrupt durable binding location is dropped before run history and the Worker boundary', async () => {
  const { adapter, store } = build({
    turns: [{ events: successEvents, result: completed }],
  });
  // Reach into the private-facing port as a legacy/corrupt durable record
  // would: the orchestrator itself must still sanitize before persistence.
  const guarded = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: new AgentRegistry([{
      id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp',
    }]),
    projects: new ProjectRegistry([project()]),
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store,
    workspaceBinding: async () => ({
      bindingId: 'corrupt-binding', workspaceId: 'f'.repeat(24), kind: 'relative', path: '../private',
    }),
  });

  const { id } = await guarded.submit({ agentId: 'agent-scout', prompt: 'inspect' });
  const run = await guarded.waitFor(id);
  assert.equal(run.status, 'completed');
  assert.equal(run.workspaceBinding, undefined, 'unsafe binding is not persisted as historical run evidence');
  assert.equal(adapter.requests.at(-1)?.projectWorkspacePath, undefined, 'unsafe location never reaches the Worker');
  assert.equal(JSON.stringify(await store.get(id)).includes('../private'), false);
});
