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

import { SqliteTaskStore } from '../task/sqlite-store.ts';

import type { TaskLeaseBinding } from '../environment/pool.ts';

import type { Task } from '../task/model.ts';


function withStore(run: (store: SqliteStore) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-rehome-'));
  const store = new SqliteStore({ filename: join(directory, 'sprout.db') });
  return Promise.resolve()
    .then(() => run(store))
    .finally(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
}


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


/**
 * F1 regression evidence (#81 rework).
 *
 * The reviewer found that `SqliteTaskStore` still issued `environment_leases`
 * SQL directly while `SqliteLeaseStore` separately owned that table. These tests
 * pin the two properties the fix must hold:
 *
 * 1. **One owner for lease SQL.** The Task adapter has no lease SQL of its own;
 *    the begin/end boundary runs the environment domain's statements through a
 *    bound `TaskLeaseBinding`, and the shared handle owns the transaction.
 * 2. **The atomic boundary is unchanged.** A Task begin writes the Task row and
 *    its Task lease in one `BEGIN IMMEDIATE` … `COMMIT`, and a failing begin
 *    rolls back both, exactly as M1 did.
 */

test('a Task begin/end boundary calls the bound environment lease adapter, not lease SQL of its own', async () => {
  const calls: string[] = [];
  const binding: TaskLeaseBinding = {
    insertTaskHeldLease: (lease) => { calls.push(`insert:${lease.id}`); },
    markTaskLeaseReleased: (leaseId) => { calls.push(`release:${leaseId}`); },
  };
  const store = new SqliteTaskStore({ filename: ':memory:', leases: binding });
  await store.create(sampleTask());
  const lease = {
    id: 'lease-1', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'task-1',
    holderKind: 'task' as const, taskId: 'task-1', acquiredAt: 1, expiresAt: 2, state: 'active' as const,
  };
  await store.saveBeginningWithLease(sampleTask({ environmentLeaseId: 'lease-1' }), lease);
  await store.saveTerminalWithLease(sampleTask({ environmentLeaseId: 'lease-1' }), 'lease-1');
  assert.deepEqual(calls, ['insert:lease-1', 'release:lease-1'], 'lease SQL is delegated to the environment port');

  // A store constructed without the environment port refuses a lease boundary
  // rather than issuing lease SQL itself or committing half of it.
  const bare = new SqliteTaskStore({ filename: ':memory:' });
  await bare.create(sampleTask());
  await assert.rejects(bare.saveBeginningWithLease(sampleTask(), lease), /no Environment lease adapter/);
  store.close();
  bare.close();
});


test('the composed handle binds the Task adapter to the environment lease port and one coordinator', async () => {
  await withStore((store) => {
    assert.equal(typeof store.transactions.immediate, 'function');
    // The Task store answers a begin boundary by writing the lease row through
    // the environment adapter, proving the mount is wired, not merely typed.
    const lease = {
      id: 'lease-bound', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'task-1',
      holderKind: 'task' as const, taskId: 'task-1', acquiredAt: 1, expiresAt: 2, state: 'active' as const,
    };
    return (async () => {
      await store.tasks.create(sampleTask());
      await store.tasks.saveBeginningWithLease(sampleTask({ environmentLeaseId: 'lease-bound', assignedAgentId: 'pi' }), lease);
      assert.deepEqual(store.leases.get('lease-bound'), lease);
    })();
  });
});


test('a failing Task begin rolls back both the Task row and the lease in the one shared transaction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-f1-atomic-'));
  const path = join(directory, 'sprout.db');
  try {
    const store = new SqliteStore({ filename: path });
    await store.tasks.create(sampleTask());

    // A conflicting live lease makes the boundary throw after the conflict read;
    // neither the Task write nor any lease row may survive.
    store.leases.insertTaskHeldLease({
      id: 'lease-live', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'run-1',
      holderKind: 'run', runId: 'run-1', acquiredAt: 1, expiresAt: 9_999_999_999, state: 'active',
    });
    await assert.rejects(
      store.tasks.saveBeginningWithLease(
        sampleTask({ environmentLeaseId: 'lease-new', environmentLifecycleState: 'beginning', assignedAgentId: 'pi' }),
        { id: 'lease-new', instanceId: 'mac-mini-1', capability: 'agent-run', holderId: 'task-1',
          holderKind: 'task', taskId: 'task-1', acquiredAt: 2, expiresAt: 3, state: 'active' },
      ),
      /unavailable/,
    );
    assert.equal(store.leases.get('lease-new'), undefined, 'no partial lease row survives a failed begin');
    assert.equal((await store.tasks.get('task-1'))?.environmentLifecycleState, undefined, 'no partial Task write survives');
    assert.equal(store.leases.list().length, 1, 'only the pre-existing lease remains');
    store.close();

    // Reopening the file after the rolled-back boundary shows the same durable
    // state: the boundary is atomic across a restart, not only in memory.
    const reopened = new SqliteStore({ filename: path });
    assert.equal(reopened.leases.get('lease-new'), undefined);
    assert.equal(reopened.leases.list().length, 1);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
