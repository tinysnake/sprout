import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InMemorySessionKeyStore,
  sessionKeyId,
  workingDirectoryId,
  type SessionKeyIdentity,
  type SessionKeyWrite,
} from './session-key-store.ts';
import { SqliteSessionKeyStore } from './sqlite-store.ts';

const identity: SessionKeyIdentity = {
  agentId: 'agent-scout',
  engine: 'pi',
  environmentInstanceId: 'mac-mini-1',
  executionPlacement: {
    mode: 'environment-hosted',
    engineHost: { kind: 'environment', id: 'mac-mini-1', profile: { platform: 'macos', boundary: 'shared-host' } },
  },
  scope: { kind: 'conversation', id: 'project-channel' },
  workingDirectory: '/srv/work',
};

function record(overrides: Partial<SessionKeyWrite> = {}): SessionKeyWrite {
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

  assert.deepEqual(restored, {
    agentId: identity.agentId,
    engine: identity.engine,
    environmentInstanceId: identity.environmentInstanceId,
    executionPlacement: identity.executionPlacement,
    scope: identity.scope,
    workingDirectoryId: workingDirectoryId(identity.workingDirectory),
    key: 'sess-persisted',
    updatedAt: 1_000,
  });
});

test('Host-run continuation slots include the execution mode and Engine host profile', async () => {
  const store = new InMemorySessionKeyStore();
  const hostA = { ...identity, environmentInstanceId: '', executionMode: 'host-run' as const, engineHostProfileId: 'profile-a' };
  const hostB = { ...hostA, engineHostProfileId: 'profile-b' };
  await store.save({ ...hostA, key: 'host-a', updatedAt: 1_000 });
  await store.save({ ...hostB, key: 'host-b', updatedAt: 1_001 });
  assert.notEqual(sessionKeyId({ ...hostA, workingDirectory: identity.workingDirectory }),
    sessionKeyId({ ...hostB, workingDirectory: identity.workingDirectory }));
  assert.equal((await store.get({ ...hostA, workingDirectory: identity.workingDirectory }))?.key, 'host-a');
  assert.equal((await store.get({ ...hostB, workingDirectory: identity.workingDirectory }))?.key, 'host-b');
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

test('execution mode, host profile, and authorized scope partition continuation slots', async () => {
  const store = new InMemorySessionKeyStore();
  await store.save(record({ key: 'private-session' }));
  const hostRun = {
    ...identity,
    executionPlacement: {
      mode: 'host-run' as const,
      engineHost: {
        kind: 'sprout' as const,
        id: 'sprout-test',
        profile: { platform: 'macos' as const, boundary: 'shared-host' as const },
      },
    },
  };
  const containerProfile = {
    ...identity,
    executionPlacement: {
      ...identity.executionPlacement!,
      engineHost: {
        ...identity.executionPlacement!.engineHost,
        profile: { platform: 'macos' as const, boundary: 'container' as const },
      },
    },
  };
  const otherConversation = { ...identity, scope: { kind: 'conversation' as const, id: 'another-channel' } };
  const routingBatch = { ...identity, scope: { kind: 'routing-batch' as const, id: 'batch-1' } };
  const taskScope = { ...identity, scope: { kind: 'task' as const, id: 'task-1' } };
  assert.equal((await store.get(hostRun))?.key, undefined);
  assert.equal((await store.get(containerProfile))?.key, undefined);
  assert.equal((await store.get(otherConversation))?.key, undefined);
  assert.equal((await store.get(routingBatch))?.key, undefined);
  assert.equal((await store.get(taskScope))?.key, undefined);
});

test('a working directory containing the slot delimiter does not collide', () => {
  // The slot is a JSON tuple, not a joined string, precisely so a path
  // containing a delimiter cannot masquerade as another slot.
  const a = sessionKeyId({ ...identity, workingDirectory: '/srv/a" , "agent-scout' });
  const b = sessionKeyId({ ...identity, workingDirectory: '/srv/a' });
  assert.notEqual(a, b);
});

test('SQLite session-key rows do not retain the working directory verbatim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-session-key-privacy-'));
  const dbPath = join(dir, 'sprout.db');
  const rawWorkingDirectory = '/srv/synthetic-private-workspace';
  const writer = new SqliteSessionKeyStore({ filename: dbPath });
  await writer.save(record({ workingDirectory: rawWorkingDirectory }));
  writer.close();

  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT slot, working_directory_id, session_key FROM agent_session_keys').all();
  db.close();

  assert.equal(JSON.stringify(rows).includes(rawWorkingDirectory), false);
});

test('a versioned hashed session-key table is re-keyed with Environment-hosted identity dimensions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-session-key-v2-'));
  const dbPath = join(dir, 'sprout.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE agent_session_keys (
    slot TEXT PRIMARY KEY, agent_id TEXT NOT NULL, engine TEXT NOT NULL,
    environment_instance_id TEXT NOT NULL, working_directory_id TEXT NOT NULL,
    session_key TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  const directoryId = workingDirectoryId(identity.workingDirectory);
  db.prepare(`INSERT INTO agent_session_keys VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    JSON.stringify([identity.agentId, identity.engine, identity.environmentInstanceId, directoryId]),
    identity.agentId, identity.engine, identity.environmentInstanceId, directoryId, 'sess-v2', 1_000,
  );
  const store = new SqliteSessionKeyStore({ db });
  const restored = await store.get(identity);
  const rows = db.prepare('SELECT * FROM agent_session_keys').all();
  store.close();
  db.close();

  assert.equal(restored?.key, 'sess-v2');
  assert.equal(restored?.executionMode, 'environment-hosted');
  assert.equal(restored?.engineHostProfileId, identity.environmentInstanceId);
  assert.equal(rows.length, 1);
});

test('opening a legacy session-key table removes verbatim working directories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-session-key-legacy-'));
  const dbPath = join(dir, 'sprout.db');
  const rawWorkingDirectory = '/srv/synthetic-legacy-workspace';
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE agent_session_keys (
      slot TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      environment_instance_id TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      session_key TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO agent_session_keys VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    JSON.stringify(['agent-scout', 'pi', 'mac-mini-1', rawWorkingDirectory]),
    'agent-scout',
    'pi',
    'mac-mini-1',
    rawWorkingDirectory,
    'sess-legacy',
    1_000,
  );

  const store = new SqliteSessionKeyStore({ db });
  const restored = await store.get({
    ...identity,
    environmentInstanceId: 'mac-mini-1',
    executionPlacement: {
      mode: 'environment-hosted',
      engineHost: { kind: 'environment', id: 'mac-mini-1', profile: { platform: 'unknown', boundary: 'unknown' } },
    },
    scope: { kind: 'conversation', id: 'legacy-unscoped' },
    workingDirectory: rawWorkingDirectory,
  });
  const rows = db.prepare('SELECT * FROM agent_session_keys').all();
  store.close();
  db.close();

  assert.equal(restored?.key, 'sess-legacy', 'the key remains available after migration');
  assert.equal(restored?.workingDirectoryId, workingDirectoryId(rawWorkingDirectory));
  assert.equal(JSON.stringify(rows).includes(rawWorkingDirectory), false);
});
