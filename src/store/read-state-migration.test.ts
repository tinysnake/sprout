import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateOrInitializeDatabase, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './schema.ts';

test('v27 to v28 adds only durable scope read cursors and preserves them on repeated initialization', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateOrInitializeDatabase(db, { filename: ':memory:', targetVersion: 27 });
    db.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('kept');");
    migrateOrInitializeDatabase(db, { filename: ':memory:' });
    assert.equal(getSchemaVersion(db), CURRENT_SCHEMA_VERSION);
    assert.deepEqual({ ...db.prepare('SELECT * FROM preserved').get() }, { value: 'kept' });
    const columns = db.prepare('PRAGMA table_info(collaboration_read_markers)').all().map((row) => row['name']);
    assert.deepEqual(columns, ['scope_id', 'human_id', 'message_id']);
    db.prepare('INSERT INTO collaboration_read_markers VALUES (?, ?, ?)').run('scope', 'human', 'message');
    migrateOrInitializeDatabase(db, { filename: ':memory:' });
    assert.equal(db.prepare('SELECT message_id FROM collaboration_read_markers').get()?.['message_id'], 'message');
    assert.throws(() => db.exec("INSERT INTO collaboration_read_markers VALUES ('bad', 'human', '')"));
  } finally { db.close(); }
});
