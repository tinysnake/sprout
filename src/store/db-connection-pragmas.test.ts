import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SqliteStore } from './db.ts';

test('SqliteStore converts an existing DELETE database to WAL and sets bounded busy timeout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-db-pragmas-'));
  const filename = join(directory, 'state.sqlite');
  const legacy = new DatabaseSync(filename);
  assert.equal((legacy.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
  legacy.close();

  const store = new SqliteStore({ filename });
  try {
    assert.equal((store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.equal((store.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
