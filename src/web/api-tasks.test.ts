/**
 * HTTP evidence for the durable Task routes (ticket #28).
 *
 * These drive the real server and the real Task service over a scripted engine,
 * so the routes are verified end to end: create, list, inspect with run links,
 * advance, and patch. The Message routes are deliberately not involved, which is
 * itself the separation check — a Task is reached only through `/api/tasks`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter, type ScriptedTurn } from '../engine/scripted.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { InMemoryTaskStore } from '../task/store.ts';
import { TaskService } from '../task/service.ts';
import { createRunApi, type RunApi } from './api.ts';

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = {
  id: 'mac-mini-1',
  definitionId: 'macos-workstation',
  workingDirectory: '/tmp/sprout-api-tasks',
};

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

function completed(text: string): ScriptedTurn {
  return {
    events: [{ type: 'message', text, final: true }],
    result: { status: 'completed', text },
  };
}

function build() {
  const adapter = new ScriptedEngineAdapter({
    turns: [completed('First step done.'), completed('Second step done.')],
  });
  const registry = new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run' },
  ]);
  const taskStore = new InMemoryTaskStore();
  let service: TaskService;
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
    tasks: { prompt: (input) => service.prompt(input), link: (input) => service.link(input) },
    onTaskRunSettled: (input) => service.onRunSettled(input),
    leaseTtlMs: 60_000,
  });
  service = new TaskService({ store: taskStore, runs: orchestrator });
  const api: RunApi = createRunApi({ orchestrator, agents: registry, projects, tasks: service });
  return { api, service };
}

async function withServer(fn: (base: string, context: ReturnType<typeof build>) => Promise<void>): Promise<void> {
  const context = build();
  const { port } = await context.api.listen(0);
  try {
    await fn(`http://127.0.0.1:${port}`, context);
  } finally {
    await context.api.close();
  }
}

async function createTask(base: string, overrides: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-sprout',
      title: 'Durable Task entity',
      goal: 'Persist multi-run work.',
      constraints: ['No personal data'],
      assignedAgentId: 'agent-scout',
      ...overrides,
    }),
  });
  return response;
}

async function waitForRun(base: string, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = (await (await fetch(`${base}/api/runs/${id}`)).json()) as Record<string, unknown>;
    if (run.status !== 'running' && run.status !== 'queued') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not settle');
}

test('a Task can be created and listed through the API', async () => {
  await withServer(async (base) => {
    const created = await createTask(base);
    assert.equal(created.status, 201);
    const { task } = (await created.json()) as { task: Record<string, unknown> };
    assert.equal(task.status, 'todo');
    assert.equal(task.title, 'Durable Task entity');
    assert.deepEqual(task.constraints, ['No personal data']);

    const list = await fetch(`${base}/api/tasks`);
    assert.equal(list.status, 200);
    const body = (await list.json()) as { tasks: Record<string, unknown>[] };
    assert.equal(body.tasks.length, 1);
  });
});

test('a Task can be created with an environment preference', async () => {
  await withServer(async (base) => {
    const created = await createTask(base, {
      environmentPreference: { kind: 'definition', id: 'macos-workstation' },
    });
    const { task } = (await created.json()) as { task: Record<string, unknown> };
    assert.deepEqual(task.environmentPreference, { kind: 'definition', id: 'macos-workstation' });
  });
});

test('a malformed Task creation is rejected with a reason', async () => {
  await withServer(async (base) => {
    assert.equal((await createTask(base, { title: '' })).status, 400);
    assert.equal((await createTask(base, { status: 'bogus' })).status, 400);
    assert.equal((await createTask(base, { constraints: [1, 2] })).status, 400);
    assert.equal(
      (await createTask(base, { environmentPreference: { kind: 'region', id: 'x' } })).status,
      400,
    );
  });
});

test('advancing a Task starts a run and records it in the run links', async () => {
  await withServer(async (base) => {
    const { task } = (await (await createTask(base)).json()) as { task: { id: string } };
    const advance = await fetch(`${base}/api/tasks/${task.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Do the first step.' }),
    });
    assert.equal(advance.status, 202);
    const advanced = (await advance.json()) as { task: Record<string, unknown>; runId: string };
    assert.equal(advanced.task.status, 'in-progress');
    assert.ok(advanced.runId);

    const run = await waitForRun(base, advanced.runId);
    assert.equal(run.status, 'completed');

    const detail = await fetch(`${base}/api/tasks/${task.id}`);
    assert.equal(detail.status, 200);
    const withRuns = (await detail.json()) as {
      task: Record<string, unknown>;
      runs: { runId: string; sequence: number; summary?: { summary: string } }[];
    };
    assert.equal(withRuns.task.status, 'in-progress');
    assert.equal(withRuns.runs.length, 1);
    assert.equal(withRuns.runs[0]?.runId, advanced.runId);
    assert.equal(withRuns.runs[0]?.sequence, 1);
    assert.equal(withRuns.runs[0]?.summary?.summary, 'First step done.');
  });
});

test('a Task can be advanced more than once', async () => {
  await withServer(async (base) => {
    const { task } = (await (await createTask(base)).json()) as { task: { id: string } };
    const first = (await (
      await fetch(`${base}/api/tasks/${task.id}/runs`, { method: 'POST' })
    ).json()) as { runId: string };
    await waitForRun(base, first.runId);
    const second = (await (
      await fetch(`${base}/api/tasks/${task.id}/runs`, { method: 'POST' })
    ).json()) as { runId: string };
    await waitForRun(base, second.runId);

    const withRuns = (await (await fetch(`${base}/api/tasks/${task.id}`)).json()) as {
      runs: { sequence: number }[];
    };
    assert.deepEqual(
      withRuns.runs.map((link) => link.sequence),
      [1, 2],
    );
  });
});

test('Tasks are filterable by project and status', async () => {
  await withServer(async (base) => {
    await createTask(base);
    await createTask(base, { projectId: 'project-other', title: 'Other' });

    const byProject = (await (await fetch(`${base}/api/tasks?projectId=project-other`)).json()) as {
      tasks: Record<string, unknown>[];
    };
    assert.equal(byProject.tasks.length, 1);
    assert.equal(byProject.tasks[0]?.projectId, 'project-other');

    const byStatus = (await (await fetch(`${base}/api/tasks?status=todo`)).json()) as {
      tasks: Record<string, unknown>[];
    };
    assert.equal(byStatus.tasks.length, 2);
    assert.equal((await fetch(`${base}/api/tasks?status=nonsense`)).status, 400);
  });
});

test('a Task can be patched into blocked with a reason and back to todo', async () => {
  await withServer(async (base) => {
    const { task } = (await (await createTask(base)).json()) as { task: { id: string } };
    const blocked = await fetch(`${base}/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'blocked', blockerReason: 'waiting on a decision' }),
    });
    assert.equal(blocked.status, 200);
    const blockedBody = (await blocked.json()) as { task: Record<string, unknown> };
    assert.equal(blockedBody.task.status, 'blocked');
    assert.equal(blockedBody.task.blockerReason, 'waiting on a decision');

    const reopened = await fetch(`${base}/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'todo', blockerReason: null }),
    });
    const reopenedBody = (await reopened.json()) as { task: Record<string, unknown> };
    assert.equal(reopenedBody.task.status, 'todo');
    assert.equal('blockerReason' in reopenedBody.task, false);
  });
});

test('an unknown Task is a 404 rather than an empty success', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/tasks/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/tasks/nope/runs`, { method: 'POST' })).status, 404);
    assert.equal(
      (await fetch(`${base}/api/tasks/nope`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      })).status,
      404,
    );
  });
});

test('the Task routes hold no Message state and vice versa', async () => {
  await withServer(async (base) => {
    const { task } = (await (await createTask(base)).json()) as { task: { id: string } };
    // The Task routes never serve a Message shape, and the run link names only
    // run ids — the two durable lifecycles share no record.
    const detail = (await (await fetch(`${base}/api/tasks/${task.id}`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal('messages' in detail, false);
    assert.equal('wakes' in detail, false);
  });
});
