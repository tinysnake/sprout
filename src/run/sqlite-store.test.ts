import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AgentRun } from './model.ts';
import { SqliteRunStore, SqliteLeaseStore, SqliteStore } from './sqlite-store.ts';
import type { EnvironmentLease } from '../environment/pool.ts';

function sampleRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    agentId: 'agent-scout',
    prompt: 'say hi',
    environmentInstanceId: 'mac-mini-1',
    status: 'completed',
    events: [
      { type: 'notice', text: 'starting' },
      { type: 'tool-call', name: 'shell', detail: 'echo hi' },
      { type: 'message', text: 'done', final: true },
    ],
    leaseId: 'lease-1',
    result: { status: 'completed', text: 'done' },
    createdAt: 1_000,
    completedAt: 2_000,
    ...overrides,
  };
}

test('a run survives being written to disk and read back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-sqlite-'));
  const writer = new SqliteRunStore({ filename: join(dir, 'sprout.db') });
  await writer.save(sampleRun());
  writer.close();

  // A second store instance is a new process reading the same file.
  const reader = new SqliteRunStore({ filename: join(dir, 'sprout.db') });
  const restored = await reader.get('run-1');
  reader.close();

  assert.deepEqual(restored, sampleRun());
});

test('saving the same run again updates it rather than duplicating it', async () => {
  const store = new SqliteRunStore({ filename: ':memory:' });
  await store.save(sampleRun());
  await store.save(sampleRun({ status: 'failed', failure: 'engine exploded', completedAt: 3_000 }));

  const all = await store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.status, 'failed');
  assert.equal(all[0]?.failure, 'engine exploded');
  store.close();
});

test('a run with no optional fields round-trips without inventing them', async () => {
  const store = new SqliteRunStore({ filename: ':memory:' });
  const minimal: AgentRun = {
    id: 'run-2',
    agentId: 'agent-scout',
    prompt: 'hi',
    environmentInstanceId: 'mac-mini-1',
    status: 'running',
    events: [],
    createdAt: 10,
  };
  await store.save(minimal);

  const restored = await store.get('run-2');
  assert.deepEqual(restored, minimal);
  assert.equal('result' in (restored ?? {}), false);
  assert.equal('leaseId' in (restored ?? {}), false);
  store.close();
});

test('a run records the environment instance and project it used, and they survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-sqlite-run-project-'));
  const dbPath = join(dir, 'sprout.db');
  const writer = new SqliteRunStore({ filename: dbPath });
  await writer.save(sampleRun({ environmentInstanceId: 'container-1', projectId: 'project-sprout' }));
  writer.close();

  const reader = new SqliteRunStore({ filename: dbPath });
  const restored = await reader.get('run-1');
  reader.close();

  assert.equal(restored?.environmentInstanceId, 'container-1');
  assert.equal(restored?.projectId, 'project-sprout');
});

test('a run written before the project column existed still reads back', async () => {
  // The column was added after runs shipped; a database from before it must keep
  // its runs rather than fail, and they simply carry no recorded project.
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      environment_instance_id TEXT NOT NULL,
      status TEXT NOT NULL,
      events TEXT NOT NULL,
      lease_id TEXT,
      failure TEXT,
      result TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);
  db.exec(`INSERT INTO agent_runs
    (id, agent_id, prompt, environment_instance_id, status, events, created_at)
    VALUES ('legacy-1', 'agent-scout', 'hi', 'mac-mini-1', 'completed', '[]', 1)`);

  const store = new SqliteRunStore({ db });
  const restored = await store.get('legacy-1');
  assert.equal(restored?.environmentInstanceId, 'mac-mini-1');
  assert.equal('projectId' in (restored ?? {}), false);
  store.close();
});

test('listing runs returns them newest first', async () => {
  const store = new SqliteRunStore({ filename: ':memory:' });
  await store.save(sampleRun({ id: 'older', createdAt: 1_000 }));
  await store.save(sampleRun({ id: 'newer', createdAt: 5_000 }));

  const all = await store.list();
  assert.deepEqual(
    all.map((run) => run.id),
    ['newer', 'older'],
  );
  store.close();
});

test('an unknown run is undefined rather than an error', async () => {
  const store = new SqliteRunStore({ filename: ':memory:' });
  assert.equal(await store.get('nope'), undefined);
  store.close();
});

test('a lease survives being written to disk and read back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-sqlite-lease-'));
  const dbPath = join(dir, 'sprout.db');
  const writer = new SqliteLeaseStore({ filename: dbPath });

  const lease: EnvironmentLease = {
    id: 'lease-100',
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    holderId: 'agent-scout',
    runId: 'run-1',
    acquiredAt: 1_000,
    expiresAt: 60_000,
    state: 'active',
  };
  writer.save(lease);
  writer.close();

  const reader = new SqliteLeaseStore({ filename: dbPath });
  const restored = reader.get('lease-100');
  reader.close();

  assert.deepEqual(restored, lease);
});

test('saving the same lease again updates state and expiry', () => {
  const store = new SqliteLeaseStore({ filename: ':memory:' });
  const initial: EnvironmentLease = {
    id: 'lease-1',
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    holderId: 'agent-scout',
    acquiredAt: 1_000,
    expiresAt: 60_000,
    state: 'active',
  };
  store.save(initial);

  store.save({ ...initial, state: 'recovering', expiresAt: 120_000 });
  const updated = store.get('lease-1');
  assert.equal(updated?.state, 'recovering');
  assert.equal(updated?.expiresAt, 120_000);

  const all = store.list();
  assert.equal(all.length, 1);
  store.close();
});

test('SqliteStore manages runs, leases, and session keys over one SQLite connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-sqlite-unified-'));
  const store = new SqliteStore({ filename: join(dir, 'sprout.db') });

  await store.runs.save(sampleRun({ id: 'run-unified' }));
  store.leases.save({
    id: 'lease-unified',
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    holderId: 'agent-scout',
    runId: 'run-unified',
    acquiredAt: 1_000,
    expiresAt: 60_000,
    state: 'active',
  });
  await store.sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'pi',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'sess-unified',
    updatedAt: 2_000,
  });

  const restoredRun = await store.runs.get('run-unified');
  const restoredLease = store.leases.get('lease-unified');
  const restoredKey = await store.sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'pi',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
  });

  assert.equal(restoredRun?.id, 'run-unified');
  assert.equal(restoredLease?.id, 'lease-unified');
  assert.equal(restoredLease?.runId, 'run-unified');
  assert.equal(restoredKey?.key, 'sess-unified');

  store.close();
});
