/**
 * Task service and multi-run advancement evidence (ticket #28).
 *
 * These tests drive the real orchestrator and a scripted engine, so they exercise
 * the actual run seam: prompt assembly, run linkage, environment resolution, and
 * settlement reporting all happen through the same path production uses.
 */

import { test } from 'node:test';

import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';

import { EnvironmentPool } from '../environment/pool.ts';

import { ScriptedEngineAdapter, type ScriptedTurn } from '../engine/scripted.ts';

import { AgentRegistry } from '../agent/registry.ts';

import { ProjectRegistry } from '../project/registry.ts';

import { InMemoryRunStore } from '../run/store.ts';

import { RunOrchestrator } from '../run/orchestrator.ts';

import { SqliteStore } from '../store/db.ts';

import { InMemoryTaskStore } from './store.ts';

import { SqliteTaskStore } from './sqlite-store.ts';

import { TaskService } from './service.ts';

import { TaskEnvironmentLifecycle } from './environment-lifecycle.ts';

import type { TaskStore } from './store.ts';


const macDefinition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};

const containerDefinition: EnvironmentDefinition = {
  id: 'container-linux',
  platform: 'container',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};

const macInstance: EnvironmentInstance = {
  id: 'mac-mini-1',
  definitionId: 'macos-workstation',
  workingDirectory: '/tmp/sprout-mac',
};

const containerInstance: EnvironmentInstance = {
  id: 'container-1',
  definitionId: 'container-linux',
  workingDirectory: '/sprout',
};


const projects = new ProjectRegistry([
  {
    id: 'project-sprout',
    goal: 'Ship Sprout',
    rules: [],
    availableEnvironmentInstanceIds: ['mac-mini-1', 'container-1'],
    memberships: [
      { agentId: 'agent-scout', responsibilities: ['Investigate'], collaborationInstructions: '' },
    ],
  },
]);


function completed(text: string): ScriptedTurn {
  return {
    events: [{ type: 'message', text, final: true }],
    result: { status: 'completed', text },
  };
}


interface ScenarioOptions {
  readonly turns?: readonly ScriptedTurn[];
  readonly taskStore?: TaskStore;
  readonly runStore?: InMemoryRunStore;
  readonly projects?: ProjectRegistry;
}


function build(options: ScenarioOptions = {}) {
  const adapter = new ScriptedEngineAdapter({
    turns: options.turns ?? [completed('Did the first step.')],
  });
  const registry = new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run' },
  ]);
  const runStore = options.runStore ?? new InMemoryRunStore();
  const taskStore = options.taskStore ?? new InMemoryTaskStore();

  // The orchestrator and the Task service are mutually referential. In
  // production `main.ts` wires the same way: the orchestrator receives only the
  // two small run-seam contracts, never the Task service itself.
  let service: TaskService;
  const projectRegistry = options.projects ?? projects;
  const pool = new EnvironmentPool({
    definitions: [macDefinition, containerDefinition],
    instances: [macInstance, containerInstance],
  });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects: projectRegistry,
    pool,
    store: runStore,
    tasks: { prompt: (input) => service.prompt(input), link: (input) => service.link(input) },
    onTaskRunSettled: (input) => service.onRunSettled(input),
    leaseTtlMs: 60_000,
  });
  const lifecycle = new TaskEnvironmentLifecycle({
    store: taskStore, pool, agents: registry, projects: projectRegistry, runs: orchestrator,
  });
  service = new TaskService({ store: taskStore, runs: orchestrator, lifecycle });
  return { orchestrator, service, adapter, runStore, taskStore };
}


async function advanceAndSettle(
  scenario: ReturnType<typeof build>,
  taskId: string,
  options: { readonly prompt?: string } = {},
) {
  await scenario.service.begin(taskId);
  const { runId } = await scenario.service.advance(taskId, options);
  return scenario.orchestrator.waitFor(runId);
}


test('a direct Task run without a project scope is refused', async () => {
  const scenario = build();
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Scoped only',
    goal: 'Never resolve through another project.',
    assignedAgentId: 'agent-scout',
  });
  const { id } = await scenario.orchestrator.submit({
    agentId: 'agent-scout',
    prompt: 'go',
    taskId: task.id,
  });
  const run = await scenario.orchestrator.waitFor(id);
  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /requires lifecycle lease and environment bindings/);
  assert.equal(scenario.adapter.requests.length, 0);
});


test('updating a Task into a terminal status stamps completion and reopening clears it', async () => {
  const scenario = build();
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Lifecycle',
    goal: 'Move through states.',
    assignedAgentId: 'agent-scout',
  });
  const done = await scenario.service.update(task.id, { status: 'done' });
  assert.equal(done.status, 'done');
  assert.notEqual(done.completedAt, undefined);

  const reopened = await scenario.service.update(task.id, { status: 'todo' });
  assert.equal(reopened.status, 'todo');
  assert.equal(reopened.completedAt, undefined);
  assert.equal('completedAt' in reopened, false);
});


test('updating a Task can set and clear optional fields', async () => {
  const scenario = build();
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Optional fields',
    goal: 'Carry a preference.',
    assignedAgentId: 'agent-scout',
    environmentPreference: { kind: 'instance', id: 'container-1' },
  });
  const cleared = await scenario.service.update(task.id, {
    environmentPreference: null,
    assignedAgentId: null,
    blockerReason: 'waiting on a decision',
  });
  assert.equal('environmentPreference' in cleared, false);
  assert.equal('assignedAgentId' in cleared, false);
  assert.equal(cleared.blockerReason, 'waiting on a decision');
});


test('Tasks and collaboration Messages are stored and listed independently', async () => {
  const scenario = build();
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'A Task is not a Message',
    goal: 'Keep the two lifecycles apart.',
    assignedAgentId: 'agent-scout',
  });
  // A Task never appears as a Message, and a Task run is not a Message run.
  assert.equal((await scenario.service.list()).length, 1);
  const run = await advanceAndSettle(scenario, task.id);
  assert.equal(run.taskId, task.id);
  assert.equal('messageId' in run, false);
});


test('Tasks, their status, and their run summaries survive a process restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-service-restart-'));
  const path = join(directory, 'sprout.db');
  try {
    const store = new SqliteStore({ filename: path });
    const taskStore = new SqliteTaskStore({ db: store.db, leases: store.leases });
    const first = build({ taskStore });
    const task = await first.service.create({
      projectId: 'project-sprout',
      title: 'Durable across restart',
      goal: 'Survive a restart.',
      constraints: ['Stay durable'],
      assignedAgentId: 'agent-scout',
    });
    await advanceAndSettle(first, task.id);
    store.close();

    // A fresh store over the same file, as a restarted Sprout process would use.
    const reopened = new SqliteStore({ filename: path });
    const restored = await reopened.tasks.get(task.id);
    assert.equal(restored?.status, 'in-progress');
    assert.deepEqual(restored?.constraints, ['Stay durable']);
    const links = await reopened.tasks.listRuns(task.id);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.summary?.summary, 'Did the first step.');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('an orphaned Task run is reconciled to blocked after a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-orphan-'));
  const path = join(directory, 'sprout.db');
  try {
    // First process: create a Task run but leave it recorded mid-flight.
    const first = new SqliteStore({ filename: path });
    const taskStore = new SqliteTaskStore({ db: first.db, leases: first.leases });
    await taskStore.create({
      id: 'task-1',
      projectId: 'project-sprout',
      title: 'Interrupted',
      goal: 'Be interrupted.',
      constraints: [],
      status: 'in-progress',
      createdAt: 1,
      updatedAt: 1,
    });
    await taskStore.linkRun({ taskId: 'task-1', runId: 'run-1', agentId: 'agent-scout', now: 2 });
    await first.runs.save({
      id: 'run-1',
      agentId: 'agent-scout',
      prompt: 'go',
      environmentInstanceId: 'mac-mini-1',
      taskId: 'task-1',
      status: 'running',
      events: [],
      createdAt: 2,
    });
    first.close();

    // Second process: reconcile the orphaned run, which must block the Task.
    const second = new SqliteStore({ filename: path });
    const service = new TaskService({ store: second.tasks, runs: { submit: async () => ({ id: 'noop' }) } });
    const orchestrator = new RunOrchestrator({
      engines: new Map(),
      agents: new AgentRegistry([]),
      projects,
      pool: new EnvironmentPool({
        definitions: [macDefinition, containerDefinition],
        instances: [macInstance, containerInstance],
      }),
      store: second.runs,
      tasks: { prompt: (input) => service.prompt(input), link: (input) => service.link(input) },
      onTaskRunSettled: (input) => service.onRunSettled(input),
    });
    const recovered = await orchestrator.reconcileOrphanedRuns();
    assert.equal(recovered.length, 1);
    const task = await second.tasks.get('task-1');
    assert.equal(task?.status, 'blocked');
    assert.match(task?.blockerReason ?? '', /interrupted by a Sprout restart/);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('a terminal Task run missing its summary is reconciled after a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-terminal-reconcile-'));
  const path = join(directory, 'sprout.db');
  try {
    const first = new SqliteStore({ filename: path });
    await first.tasks.create({
      id: 'task-1',
      projectId: 'project-sprout',
      title: 'Persist terminal result',
      goal: 'Keep this result for the next run.',
      constraints: [],
      status: 'in-progress',
      createdAt: 1,
      updatedAt: 1,
    });
    await first.tasks.linkRun({ taskId: 'task-1', runId: 'run-1', agentId: 'agent-scout', now: 2 });
    // Simulate a process death after #finish persisted the terminal run but
    // before TaskService.onRunSettled could record its summary.
    await first.runs.save({
      id: 'run-1',
      agentId: 'agent-scout',
      prompt: 'go',
      environmentInstanceId: 'mac-mini-1',
      taskId: 'task-1',
      status: 'completed',
      events: [],
      result: { status: 'completed', text: 'The durable result.' },
      createdAt: 2,
      completedAt: 3,
    });
    first.close();

    const second = new SqliteStore({ filename: path });
    let now = 100;
    const service = new TaskService({
      store: second.tasks,
      runs: { submit: async () => ({ id: 'noop' }) },
      clock: { now: () => now },
    });
    const orchestrator = new RunOrchestrator({
      engines: new Map(),
      agents: new AgentRegistry([]),
      projects,
      pool: new EnvironmentPool({
        definitions: [macDefinition, containerDefinition],
        instances: [macInstance, containerInstance],
      }),
      store: second.runs,
      tasks: { prompt: (input) => service.prompt(input), link: (input) => service.link(input) },
      onTaskRunSettled: (input) => service.onRunSettled(input),
    });
    assert.equal((await orchestrator.reconcileOrphanedRuns()).length, 0);
    // A second reconciliation is harmless and does not duplicate the link.
    now = 200;
    await orchestrator.reconcileOrphanedRuns();
    const links = await second.tasks.listRuns('task-1');
    assert.equal(links.length, 1);
    assert.equal(links[0]?.summary?.summary, 'The durable result.');
    assert.equal(links[0]?.summary?.recordedAt, 100);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
