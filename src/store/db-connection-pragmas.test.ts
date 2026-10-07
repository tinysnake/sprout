import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';

import { SqliteStore } from './db.ts';

test('SqliteStore retries DELETE-to-WAL conversion while a competing writer releases its lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-db-wal-contention-'));
  const filename = join(directory, 'state.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.close();

  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    await new Promise((resolve) => setTimeout(resolve, 60));
    db.exec('COMMIT');
    db.close();
  `, filename], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('locked')) resolve();
      });
      child.stderr.on('data', (chunk: Buffer) => reject(new Error(chunk.toString())));
    });

    const store = new SqliteStore({ filename });
    try {
      assert.equal((store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
      assert.equal((store.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
    } finally {
      store.close();
    }
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`writer exited with ${code}`)));
    });
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

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
