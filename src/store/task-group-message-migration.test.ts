import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_SCHEMA_VERSION, defaultSafetyCopyPath, getSchemaVersion, migrateOrInitializeDatabase } from './schema.ts';

test('Task-group intent upgrade preserves legacy Messages and a pre-upgrade safety copy across reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-task-group-migration-'));
  const filename = join(directory, 'store.sqlite');
  let db = new DatabaseSync(filename);
  try {
    db.exec("CREATE TABLE collaboration_messages (id TEXT PRIMARY KEY, body TEXT, in_reply_to TEXT); INSERT INTO collaboration_messages VALUES ('m', 'preserved', 'parent'); PRAGMA user_version = 28;");
    migrateOrInitializeDatabase(db, { filename });
    assert.equal(getSchemaVersion(db), CURRENT_SCHEMA_VERSION);
    assert.deepEqual({ ...db.prepare('SELECT * FROM collaboration_messages').get() }, { id: 'm', body: 'preserved', in_reply_to: 'parent', message_kind: 'status' });
    assert.equal(existsSync(defaultSafetyCopyPath(filename)), true);
    const backup = new DatabaseSync(defaultSafetyCopyPath(filename));
    try {
      assert.equal(getSchemaVersion(backup), 28);
      assert.deepEqual({ ...backup.prepare('SELECT * FROM collaboration_messages').get() }, { id: 'm', body: 'preserved', in_reply_to: 'parent' });
    } finally { backup.close(); }
    db.close(); db = new DatabaseSync(filename);
    migrateOrInitializeDatabase(db, { filename });
    assert.equal(db.prepare('SELECT message_kind FROM collaboration_messages').get()?.['message_kind'], 'status');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
