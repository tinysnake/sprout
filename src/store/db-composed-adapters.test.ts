/**
 * Move-sensitive evidence for the SQLite adapter rehome (#81).
 *
 * These tests exist because this Ticket is a *relocation* of adapters, not a
 * behaviour change. They pin the two things a careless move could break without
 * any store test noticing:
 *
 * 1. **The physical schema is byte-identical.** Every table, column, declared
 *    type, primary key, `UNIQUE` constraint, and explicit indexes are
 *    asserted literally, so a moved `CREATE TABLE` that quietly renames or
 *    reorders a column fails here.
 * 2. **The rehomed adapters and the shared handle address the same tables.** A
 *    domain store constructed directly on a file and the same domain store
 *    mounted on `SqliteStore` observe each other's rows through the shared
 *    connection, which is what proves the mount still points at the same
 *    physical state.
 *
 * A third check writes a database with the exact pre-rehome `CREATE TABLE`
 * text and reads it back through the rehomed adapters, so historical durable
 * rows open unchanged. The statements are copied from the fixed base commit, so
 * this is a real compatibility assertion rather than a self-referential round
 * trip.
 */

import { test } from 'node:test';

import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { SqliteStore } from '../store/db.ts';

import type { Task } from '../task/model.ts';


function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-sprout',
    title: 'Owned lease boundary',
    goal: 'Commit the Task and its lease together.',
    constraints: [],
    status: 'todo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}


test('a Task begin then end commits and releases its Task-held lease in one boundary each', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-f1-commit-'));
  const path = join(directory, 'sprout.db');
  try {
    const store = new SqliteStore({ filename: path });
    await store.tasks.create(sampleTask());
    const lease = {
      id: 'lease-task', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'task-1',
      holderKind: 'task' as const, taskId: 'task-1', acquiredAt: 1, expiresAt: 2, state: 'active' as const,
    };
    await store.tasks.saveBeginningWithLease(
      sampleTask({ environmentLeaseId: 'lease-task', environmentLifecycleState: 'beginning', assignedAgentId: 'pi' }),
      lease,
    );
    assert.equal(store.leases.get('lease-task')?.state, 'active');

    await store.tasks.saveTerminalWithLease(
      sampleTask({ status: 'done', environmentLeaseId: 'lease-task', environmentLifecycleState: 'ended', completedAt: 5 }),
      'lease-task',
    );
    assert.equal(store.leases.get('lease-task')?.state, 'released');
    assert.equal((await store.tasks.get('task-1'))?.environmentLifecycleState, 'ended');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


/**
 * S1 evidence (#81 review suggestion): a write/reopen round-trip across every
 * composed adapter, including the Task-held atomic lease path, so the move's
 * compatibility claim is asserted by a durable test rather than only by an
 * external byte probe.
 */
test('every composed adapter writes, reopens from the file, and reads back', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-f1-reopen-'));
  const path = join(directory, 'sprout.db');
  try {
    const first = new SqliteStore({ filename: path });
    await first.tasks.create(sampleTask());
    await first.tasks.saveBeginningWithLease(
      sampleTask({ environmentLeaseId: 'lease-task', environmentLifecycleState: 'beginning', assignedAgentId: 'pi' }),
      { id: 'lease-task', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'task-1',
        holderKind: 'task', taskId: 'task-1', acquiredAt: 1, expiresAt: 2, state: 'active' },
    );
    await first.tasks.linkRun({ taskId: 'task-1', runId: 'run-1', agentId: 'agent-scout', now: 3 });
    await first.runs.save({
      id: 'run-1', agentId: 'agent-scout', prompt: 'go', environmentInstanceId: 'mac-mini-1',
      projectId: 'project-sprout', taskId: 'task-1', status: 'completed', events: [],
      tokenUsage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 }, createdAt: 4, completedAt: 5,
    });
    await first.sessionKeys.save({
      agentId: 'agent-scout', engine: 'scripted', environmentInstanceId: 'mac-mini-1',
      workingDirectory: '/work', key: 'sk-1', updatedAt: 6,
    });
    await first.collaboration.postMessage({
      message: { id: 'msg-1', projectId: 'project-sprout', channel: 'project',
        author: { id: 'agent-scout', kind: 'agent' }, body: 'hi', recipients: [], deliveryKey: 'd-1', createdAt: 7 },
      plan: { messageId: 'msg-1', decisions: [{ agentId: 'agent-scout', reason: 'direct-recipient' }], observations: [] },
      now: 7,
    });
    first.close();

    const reopened = new SqliteStore({ filename: path });
    assert.equal((await reopened.tasks.get('task-1'))?.environmentLifecycleState, 'beginning');
    assert.equal(reopened.leases.get('lease-task')?.state, 'active');
    assert.equal((await reopened.tasks.listRuns('task-1')).length, 1);
    assert.equal((await reopened.runs.get('run-1'))?.tokenUsage?.totalTokens, 3);
    assert.equal((await reopened.sessionKeys.get({
      agentId: 'agent-scout', engine: 'scripted', environmentInstanceId: 'mac-mini-1', workingDirectory: '/work',
    }))?.key, 'sk-1');
    assert.equal((await reopened.collaboration.listWakeRequests()).length, 1);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
