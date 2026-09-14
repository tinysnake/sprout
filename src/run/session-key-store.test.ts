import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InMemorySessionKeyStore,
  sessionKeyId,
  type SessionKeyIdentity,
  type StoredSessionKey,
} from './session-key-store.ts';
import { SqliteSessionKeyStore } from './sqlite-store.ts';

const identity: SessionKeyIdentity = {
  agentId: 'agent-scout',
  engine: 'pi',
  environmentInstanceId: 'mac-mini-1',
  workingDirectory: '/srv/work',
};

function record(overrides: Partial<StoredSessionKey> = {}): StoredSessionKey {
  return { ...identity, key: 'sess-1', updatedAt: 1_000, ...overrides };
}

test('an unknown slot has no key rather than a default', async () => {
  const store = new InMemorySessionKeyStore();
  assert.equal(await store.get(identity), undefined);
});

test('a stored key round-trips through SQLite across a restart', async () => {
  // A new store instance on the same file is a new process reading what the
  // previous one persisted, which is what "survives a Sprout restart" means.
  const dir = mkdtempSync(join(tmpdir(), 'sprout-session-key-'));
  const dbPath = join(dir, 'sprout.db');

  const writer = new SqliteSessionKeyStore({ filename: dbPath });
  await writer.save(record({ key: 'sess-persisted' }));
  writer.close();

  const reader = new SqliteSessionKeyStore({ filename: dbPath });
  const restored = await reader.get(identity);
  reader.close();

  assert.deepEqual(restored, record({ key: 'sess-persisted' }));
});

test('re-saving a slot replaces its key instead of duplicating it', async () => {
  const store = new SqliteSessionKeyStore({ filename: ':memory:' });
  await store.save(record({ key: 'first' }));
  await store.save(record({ key: 'second', updatedAt: 2_000 }));

  const all = await store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.key, 'second');
  assert.equal(all[0]?.updatedAt, 2_000);
  store.close();
});

test('deleting a slot forgets it so a run starts fresh', async () => {
  const store = new InMemorySessionKeyStore();
  await store.save(record());
  await store.delete(identity);
  assert.equal(await store.get(identity), undefined);
});

test('two slots that differ only by working directory never collide', async () => {
  // Pi and opencode couple their stored record to the working directory (#19),
  // so a key from one directory must not be offered to another.
  const store = new InMemorySessionKeyStore();
  await store.save(record({ workingDirectory: '/srv/one', key: 'k-one' }));
  await store.save(record({ workingDirectory: '/srv/two', key: 'k-two' }));

  assert.equal((await store.get({ ...identity, workingDirectory: '/srv/one' }))?.key, 'k-one');
  assert.equal((await store.get({ ...identity, workingDirectory: '/srv/two' }))?.key, 'k-two');
});

test('a working directory containing the slot delimiter does not collide', () => {
  // The slot is a JSON tuple, not a joined string, precisely so a path
  // containing a delimiter cannot masquerade as another slot.
  const a = sessionKeyId({ ...identity, workingDirectory: '/srv/a" , "agent-scout' });
  const b = sessionKeyId({ ...identity, workingDirectory: '/srv/a' });
  assert.notEqual(a, b);
});
