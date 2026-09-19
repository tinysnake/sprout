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

test('a Task is created in todo and advances through sequential runs', async () => {
  const scenario = build({
    turns: [completed('Step one done.'), completed('Step two done.')],
  });
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Durable Task entity',
    goal: 'Persist multi-run work.',
    constraints: ['No personal data'],
    assignedAgentId: 'agent-scout',
  });
  assert.equal(task.status, 'todo');

  const firstRun = await advanceAndSettle(scenario, task.id);
  assert.equal(firstRun.status, 'completed');
  assert.equal(firstRun.taskId, task.id);
  assert.equal((await scenario.service.get(task.id))?.status, 'in-progress');

  const secondRun = await advanceAndSettle(scenario, task.id);
  assert.equal(secondRun.status, 'completed');
  assert.equal(secondRun.environmentInstanceId, firstRun.environmentInstanceId);

  const withRuns = await scenario.service.getWithRuns(task.id);
  assert.equal(withRuns?.runs.length, 2);
  assert.deepEqual(
    withRuns?.runs.map((link) => link.sequence),
    [1, 2],
  );
  assert.equal(withRuns?.runs[0]?.summary?.summary, 'Step one done.');
  assert.equal(withRuns?.runs[1]?.summary?.summary, 'Step two done.');
});

test('a later run is presented the Task goal, constraints, and prior summaries', async () => {
  const scenario = build({
    turns: [completed('First run produced schema.'), completed('Second run done.')],
  });
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Durable Task entity',
    goal: 'Persist multi-run work.',
    constraints: ['No personal data', 'English comments only'],
    assignedAgentId: 'agent-scout',
  });

  await advanceAndSettle(scenario, task.id, { prompt: 'Write the schema.' });
  await advanceAndSettle(scenario, task.id, { prompt: 'Add store tests.' });

  const secondPrompt = scenario.adapter.sessions[1]?.prompts[0] ?? '';
  assert.match(secondPrompt, /## Task\nTitle: Durable Task entity/);
  assert.match(secondPrompt, /Goal: Persist multi-run work\./);
  assert.match(secondPrompt, /- No personal data\n- English comments only/);
  assert.match(secondPrompt, /## Prior work on this Task/);
  assert.match(secondPrompt, /- Run 1 \(agent-scout, completed\): First run produced schema\./);
  assert.match(secondPrompt, /## Request\nAdd store tests\./);
  // The raw event of the prior run never reaches the next run's input.
  assert.equal(secondPrompt.includes('"final":true'), false);
});

test('an explicit instance environment preference takes priority over project matching', async () => {
  const scenario = build();
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Container-only work',
    goal: 'Run in the container.',
    assignedAgentId: 'agent-scout',
    environmentPreference: { kind: 'instance', id: 'container-1' },
  });

  const run = await advanceAndSettle(scenario, task.id);
  // Without the preference, project order would have chosen mac-mini-1.
  assert.equal(run.environmentInstanceId, 'container-1');
});

test('a definition environment preference selects the first granted matching instance', async () => {
  const scenario = build();
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Container kind work',
    goal: 'Run in any container.',
    assignedAgentId: 'agent-scout',
    environmentPreference: { kind: 'definition', id: 'container-linux' },
  });

  const run = await advanceAndSettle(scenario, task.id);
  assert.equal(run.environmentInstanceId, 'container-1');
});

test('a Task run resolves and assembles its contract strictly inside the Task project', async () => {
  const multiProject = new ProjectRegistry([
    {
      id: 'project-a',
      goal: 'Do not use this project.',
      rules: ['A-only rule'],
      availableEnvironmentInstanceIds: ['mac-mini-1'],
      memberships: [
        { agentId: 'agent-scout', responsibilities: ['A work'], collaborationInstructions: 'A only' },
      ],
    },
    {
      id: 'project-b',
      goal: 'Use only project B.',
      rules: ['B-only rule'],
      availableEnvironmentInstanceIds: ['container-1'],
      memberships: [
        { agentId: 'agent-scout', responsibilities: ['B work'], collaborationInstructions: 'B only' },
      ],
    },
  ]);
  const scenario = build({ projects: multiProject });
  const task = await scenario.service.create({
    projectId: 'project-b',
    title: 'Scoped Task',
    goal: 'Stay inside project B.',
    assignedAgentId: 'agent-scout',
  });

  const run = await advanceAndSettle(scenario, task.id);
  assert.equal(run.projectId, 'project-b');
  assert.equal(run.environmentInstanceId, 'container-1');
  const contract = scenario.adapter.requests[0]?.instructions ?? '';
  assert.match(contract, /Project contract: project-b/);
  assert.match(contract, /Use only project B\./);
  assert.equal(contract.includes('Do not use this project.'), false);
});

test('a Task refuses an agent that is not a member of its project', async () => {
  const scenario = build({
    projects: new ProjectRegistry([
      {
        id: 'project-a',
        goal: 'Scout is here.',
        rules: [],
        availableEnvironmentInstanceIds: ['mac-mini-1'],
        memberships: [
          { agentId: 'agent-scout', responsibilities: [], collaborationInstructions: '' },
        ],
      },
      {
        id: 'project-b',
        goal: 'Scout is not here.',
        rules: [],
        availableEnvironmentInstanceIds: ['container-1'],
        memberships: [],
      },
    ]),
  });
  const task = await scenario.service.create({
    projectId: 'project-b',
    title: 'Membership check',
    goal: 'Refuse cross-project execution.',
    assignedAgentId: 'agent-scout',
  });

  await assert.rejects(scenario.service.begin(task.id), /not a member of project project-b/);
  assert.equal(scenario.adapter.requests.length, 0);
});

test('an unmatched environment preference falls back to project matching', async () => {
  const scenario = build();
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Fallback work',
    goal: 'Run where the project allows.',
    assignedAgentId: 'agent-scout',
    environmentPreference: { kind: 'instance', id: 'decommissioned-host' },
  });

  const run = await advanceAndSettle(scenario, task.id);
  assert.equal(run.environmentInstanceId, 'mac-mini-1', 'project order is the fallback');
});

test('a preference cannot reach an instance the project does not grant', async () => {
  // The agent is only a member of a project that grants mac-mini-1.
  const restricted = new ProjectRegistry([
    {
      id: 'project-restricted',
      goal: 'Only the mac.',
      rules: [],
      availableEnvironmentInstanceIds: ['mac-mini-1'],
      memberships: [
        { agentId: 'agent-scout', responsibilities: [], collaborationInstructions: '' },
      ],
    },
  ]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [completed('ran')] })]]),
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run' },
    ]),
    projects: restricted,
    pool: new EnvironmentPool({
      definitions: [macDefinition, containerDefinition],
      instances: [macInstance, containerInstance],
    }),
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });
  const { id } = await orchestrator.submit({
    agentId: 'agent-scout',
    prompt: 'go',
    environmentPreference: { kind: 'instance', id: 'container-1' },
  });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.environmentInstanceId, 'mac-mini-1');
});

test('a failed run blocks the Task and records the failure as its summary', async () => {
  const scenario = build({
    turns: [{ events: [], result: { status: 'failed', message: 'engine exploded' } }],
  });
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Will fail',
    goal: 'Fail visibly.',
    assignedAgentId: 'agent-scout',
  });

  const run = await advanceAndSettle(scenario, task.id);
  assert.equal(run.status, 'failed');
  const blocked = await scenario.service.get(task.id);
  assert.equal(blocked?.status, 'blocked');
  assert.match(blocked?.blockerReason ?? '', /run .* failed: engine exploded/);
  const withRuns = await scenario.service.getWithRuns(task.id);
  assert.equal(withRuns?.runs[0]?.summary?.status, 'failed');
  assert.equal(withRuns?.runs[0]?.summary?.summary, 'engine exploded');
});

test('a blocked Task can be advanced again, moving back to in-progress', async () => {
  const scenario = build({
    turns: [
      { events: [], result: { status: 'failed', message: 'transient' } },
      completed('Recovered.'),
    ],
  });
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Retryable',
    goal: 'Recover from a failure.',
    assignedAgentId: 'agent-scout',
  });
  await advanceAndSettle(scenario, task.id);
  assert.equal((await scenario.service.get(task.id))?.status, 'blocked');

  const run = await advanceAndSettle(scenario, task.id);
  assert.equal(run.status, 'completed');
  assert.equal((await scenario.service.get(task.id))?.status, 'in-progress');
});

test('concurrent Task advances reject the second request while the first run is active', async () => {
  const scenario = build({
    turns: [{ ...completed('Eventually done.'), settleAfterMs: 100 }],
  });
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'One run at a time',
    goal: 'Avoid concurrent environment leases.',
    assignedAgentId: 'agent-scout',
  });
  await scenario.service.begin(task.id);

  const [first, second] = await Promise.allSettled([
    scenario.service.advance(task.id),
    scenario.service.advance(task.id),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.match(second.status === 'rejected' ? String(second.reason) : '', /already has an active run/);
  if (first.status === 'fulfilled') await scenario.orchestrator.waitFor(first.value.runId);
  assert.equal(scenario.adapter.requests.length, 1);
  assert.equal((await scenario.service.getWithRuns(task.id))?.runs.length, 1);
});

test('advancing a terminal Task is refused', async () => {
  const scenario = build();
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Finished',
    goal: 'Be cancelled.',
    assignedAgentId: 'agent-scout',
  });
  await scenario.service.update(task.id, { status: 'cancelled' });
  await assert.rejects(scenario.service.advance(task.id), /cancelled and cannot be advanced/);
});

test('a Task with no assigned agent is refused until one is named', async () => {
  const scenario = build();
  const task = await scenario.service.create({
    projectId: 'project-sprout',
    title: 'Unassigned',
    goal: 'Have no owner yet.',
  });
  await assert.rejects(scenario.service.begin(task.id), /no assigned agent/);
  await scenario.service.begin(task.id, { agentId: 'agent-scout' });
  const { runId } = await scenario.service.advance(task.id, { agentId: 'agent-scout' });
  assert.equal((await scenario.orchestrator.waitFor(runId)).status, 'completed');
  assert.equal((await scenario.service.get(task.id))?.assignedAgentId, 'agent-scout');
});

test('a run submitted with an unknown Task id fails explicitly, not silently', async () => {
  const scenario = build();
  const { id } = await scenario.orchestrator.submit({
    agentId: 'agent-scout',
    prompt: 'go',
    taskId: 'task-nobody',
  });
  const run = await scenario.orchestrator.waitFor(id);
  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /unknown task: task-nobody/);
});

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
