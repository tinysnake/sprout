import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentRun } from './model.ts';
import { SqliteRunStore } from './sqlite-store.ts';

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
