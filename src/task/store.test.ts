/**
 * Store-level evidence for durable Tasks (ticket #28).
 *
 * The SQLite tests use a real file and reopen it, so a passing test is a
 * statement about durability across a process restart rather than about one
 * process's memory. The in-memory tests hold the same identities so the contract,
 * not one backend, is what is being checked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Task } from './model.ts';
import { InMemoryTaskStore, type TaskStore } from './store.ts';
import { SqliteTaskStore } from './sqlite-store.ts';
function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-sprout',
    title: 'Ship the Task entity',
    goal: 'Persist durable multi-run work in SQLite.',
    constraints: ['No personal data in commits', 'English comments only'],
    status: 'todo',
    assignedAgentId: 'agent-scout',
    environmentPreference: { kind: 'definition', id: 'container-linux' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

for (const [label, makeStore] of [
  ['in-memory', () => new InMemoryTaskStore()],
  ['sqlite', () => new SqliteTaskStore({ filename: ':memory:' })],
] as const) {
  test(`[${label}] a Task round-trips with every field`, async () => {
    const store = makeStore();
    await store.create(sampleTask());
    assert.deepEqual(await store.get('task-1'), sampleTask());
    (store as { close?: () => void }).close?.();
  });

  test(`[${label}] a Task with no optional fields invents none`, async () => {
    const store = makeStore();
    const minimal: Task = {
      id: 'task-2',
      projectId: 'project-sprout',
      title: 'Minimal',
      goal: 'Do the smallest thing.',
      constraints: [],
      status: 'todo',
      createdAt: 10,
      updatedAt: 10,
    };
    await store.create(minimal);
    const restored = await store.get('task-2');
    assert.deepEqual(restored, minimal);
    assert.equal('assignedAgentId' in (restored ?? {}), false);
    assert.equal('environmentPreference' in (restored ?? {}), false);
    assert.equal('completedAt' in (restored ?? {}), false);
    (store as { close?: () => void }).close?.();
  });

  test(`[${label}] creating the same Task twice does not duplicate it`, async () => {
    const store = makeStore();
    await store.create(sampleTask());
    await store.create(sampleTask({ title: 'A different title' }));
    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.title, 'Ship the Task entity', 'the first durable Task wins');
    (store as { close?: () => void }).close?.();
  });

  test(`[${label}] saving a Task updates it in place`, async () => {
    const store = makeStore();
    await store.create(sampleTask());
    await store.save(sampleTask({ status: 'done', updatedAt: 2_000, completedAt: 2_000 }));
    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.status, 'done');
    assert.equal(all[0]?.completedAt, 2_000);
    (store as { close?: () => void }).close?.();
  });

  test(`[${label}] Tasks are filterable by project and by status`, async () => {
    const store = makeStore();
    await store.create(sampleTask());
    await store.create(
      sampleTask({ id: 'task-3', projectId: 'project-other', status: 'blocked', createdAt: 2_000, updatedAt: 2_000 }),
    );

    assert.deepEqual(
      (await store.list({ projectId: 'project-sprout' })).map((task) => task.id),
      ['task-1'],
    );
    assert.deepEqual(
      (await store.list({ status: 'blocked' })).map((task) => task.id),
      ['task-3'],
    );
    assert.deepEqual(
      (await store.list({ projectId: 'project-sprout', status: 'blocked' })),
      [],
    );
    (store as { close?: () => void }).close?.();
  });

  test(`[${label}] linking a run twice returns the one link`, async () => {
    const store = makeStore();
    await store.create(sampleTask());
    const first = await store.linkRun({ taskId: 'task-1', runId: 'run-a', agentId: 'agent-scout', now: 20 });
    const second = await store.linkRun({ taskId: 'task-1', runId: 'run-a', agentId: 'agent-scout', now: 30 });
    assert.equal(first.sequence, 1);
    assert.deepEqual(second, first);
    assert.equal((await store.listRuns('task-1')).length, 1);
    (store as { close?: () => void }).close?.();
  });

  test(`[${label}] linked runs keep their admission order`, async () => {
    const store = makeStore();
    await store.create(sampleTask());
    for (const runId of ['run-c', 'run-a', 'run-b']) {
      await store.linkRun({ taskId: 'task-1', runId, agentId: 'agent-scout', now: 1 });
    }
    assert.deepEqual(
      (await store.listRuns('task-1')).map((link) => `${link.sequence}:${link.runId}`),
      ['1:run-c', '2:run-a', '3:run-b'],
    );
    (store as { close?: () => void }).close?.();
  });

  test(`[${label}] a run summary is recorded against its link and survives a read`, async () => {
    const store = makeStore();
    await store.create(sampleTask());
    await store.linkRun({ taskId: 'task-1', runId: 'run-a', agentId: 'agent-scout', now: 20 });
    await store.recordRunSummary({
      taskId: 'task-1',
      runId: 'run-a',
      agentId: 'agent-scout',
      status: 'completed',
      summary: 'Wrote the schema and its tests.',
      recordedAt: 40,
    });

    const link = (await store.listRuns('task-1'))[0]!;
    assert.deepEqual(link.summary, {
      runId: 'run-a',
      agentId: 'agent-scout',
      status: 'completed',
      summary: 'Wrote the schema and its tests.',
      recordedAt: 40,
    });
    const withRuns = await store.getWithRuns('task-1');
    assert.equal(withRuns?.runs.length, 1);
    assert.equal(withRuns?.task.id, 'task-1');
    (store as { close?: () => void }).close?.();
  });

  test(`[${label}] a summary for an unlinked run is refused`, async () => {
    const store = makeStore();
    await store.create(sampleTask());
    await assert.rejects(
      store.recordRunSummary({
        taskId: 'task-1',
        runId: 'run-ghost',
        agentId: 'agent-scout',
        status: 'completed',
        summary: 'nothing',
        recordedAt: 1,
      }),
      /not linked/,
    );
    (store as { close?: () => void }).close?.();
  });

  test(`[${label}] getWithRuns for an unknown Task is undefined`, async () => {
    const store = makeStore();
    assert.equal(await store.getWithRuns('task-nobody'), undefined);
    (store as { close?: () => void }).close?.();
  });
}

test('a Task, its status, and its run links survive a process restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-restart-'));
  const path = join(directory, 'store.db');
  try {
    const first = new SqliteTaskStore({ filename: path });
    await first.create(sampleTask());
    await first.linkRun({ taskId: 'task-1', runId: 'run-a', agentId: 'agent-scout', now: 20 });
    await first.recordRunSummary({
      taskId: 'task-1',
      runId: 'run-a',
      agentId: 'agent-scout',
      status: 'completed',
      summary: 'First run done.',
      recordedAt: 30,
    });
    await first.save(sampleTask({ status: 'in-progress', updatedAt: 3_000 }));
    first.close();

    // A fresh store over the same file, as a restarted Sprout process would use.
    const second = new SqliteTaskStore({ filename: path });
    const restored = await second.get('task-1');
    assert.equal(restored?.status, 'in-progress');
    assert.equal(restored?.updatedAt, 3_000);
    assert.deepEqual(restored?.constraints, sampleTask().constraints);
    assert.deepEqual(restored?.environmentPreference, { kind: 'definition', id: 'container-linux' });
    const links = await second.listRuns('task-1');
    assert.equal(links.length, 1);
    assert.equal(links[0]?.summary?.summary, 'First run done.');
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the store interface is satisfied by both backends', () => {
  const inMemory: TaskStore = new InMemoryTaskStore();
  const sqlite: TaskStore = new SqliteTaskStore({ filename: ':memory:' });
  assert.equal(typeof inMemory.linkRun, 'function');
  assert.equal(typeof sqlite.linkRun, 'function');
  (sqlite as SqliteTaskStore).close();
});
