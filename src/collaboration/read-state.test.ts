import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCollaborationStore } from './store.ts';
import { SqliteCollaborationStore } from './sqlite-store.ts';
import type { Message } from './model.ts';

test('a vacuumed safety copy preserves the read cursor and later unread messages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-unread-copy-'));
  const filename = join(directory, 'store.db');
  const copy = join(directory, 'copy.db');
  let store = new SqliteCollaborationStore({ filename });
  try {
    for (const id of ['gap', 'seen', 'unseen']) await store.postMessage({ message: { id, scopeId: 'scope', projectId: 'project', channel: 'project', author: { id: 'agent', kind: 'agent' }, body: 'PRIVATE', recipients: [], deliveryKey: id, createdAt: 1 }, plan: { inputId: id, decisions: [], observations: [] }, now: 1 });
    await store.markReadThrough('scope', 'human', 'seen');
    store.close();
    const db = new DatabaseSync(filename);
    try { db.exec("DELETE FROM collaboration_messages WHERE id = 'gap'"); db.prepare('VACUUM INTO ?').run(copy); } finally { db.close(); }
    store = new SqliteCollaborationStore({ filename: copy });
    assert.equal(await store.unreadCount('scope', 'human'), 1, 'row renumbering cannot hide the unread message');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const backend of ['memory', 'sqlite'] as const) {
  test(`${backend}: read cursors isolate scopes and Humans, exclude own messages, and never acknowledge unseen arrivals`, async () => {
    const store = backend === 'memory' ? new InMemoryCollaborationStore() : new SqliteCollaborationStore({ filename: ':memory:' });
    const post = async (id: string, scopeId: string, authorId = 'agent') => {
      const message: Message = { id, projectId: 'project', scopeId, channel: 'project', author: { id: authorId, kind: authorId === 'human' ? 'human' : 'agent' }, body: 'PRIVATE_MESSAGE_CONTENT', recipients: [], deliveryKey: id, createdAt: 1 };
      await store.postMessage({ message, plan: { inputId: id, decisions: [], observations: [] }, now: 1 });
    };
    try {
      await post('first', 'a'); await post('other', 'b'); await post('self', 'a', 'human');
      assert.equal(await store.unreadCount('a', 'human'), 1);
      await store.markReadThrough('a', 'human', 'first');
      await post('later-same-time', 'a');
      assert.equal(await store.unreadCount('a', 'human'), 1);
      assert.equal(await store.unreadCount('b', 'human'), 1);
      assert.equal(await store.unreadCount('a', 'another-human'), 3);
      await store.markReadThrough('a', 'human', 'later-same-time');
      await store.markReadThrough('a', 'human', 'first');
      assert.equal(await store.unreadCount('a', 'human'), 0, 'late commands cannot move a cursor backwards');
      await assert.rejects(store.markReadThrough('a', 'human', 'other'), /scope/i);
      await assert.rejects(store.markReadThrough('a', 'human', 'missing'), /message/i);
    } finally { if (store instanceof SqliteCollaborationStore) store.close(); }
  });
}

test('SQLite unread and read state survive reopening without clearing another scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-unread-'));
  const filename = join(directory, 'store.db');
  let store = new SqliteCollaborationStore({ filename });
  try {
    for (const scopeId of ['a', 'b']) await store.postMessage({ message: { id: scopeId, scopeId, projectId: 'project', channel: 'project', author: { id: 'agent', kind: 'agent' }, body: 'PRIVATE', recipients: [], deliveryKey: scopeId, createdAt: 1 }, plan: { inputId: scopeId, decisions: [], observations: [] }, now: 1 });
    store.close(); store = new SqliteCollaborationStore({ filename });
    assert.equal(await store.unreadCount('a', 'human'), 1);
    await store.markReadThrough('a', 'human', 'a');
    store.close(); store = new SqliteCollaborationStore({ filename });
    assert.equal(await store.unreadCount('a', 'human'), 0);
    assert.equal(await store.unreadCount('b', 'human'), 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
