import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkerRecoveryJournal } from './recovery-journal.ts';

test('journal survives restart, fences stale acknowledgements and compacts only after settlement ack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-recovery-'));
  try {
    const path = join(dir, 'journal');
    const journal = new WorkerRecoveryJournal(path, 1);
    journal.engineStarted();
    journal.begin('session-1', 'turn-1');
    const event = { type: 'notice' as const, text: 'event already destined for Sprout' };
    journal.event('turn-1', event);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /secret|prompt|credential/);
    const restarted = new WorkerRecoveryJournal(path, 2);
    // A torn staging write cannot replace the fsynced/renamed journal.
    writeFileSync(`${path}.partial.tmp`, '{', { mode: 0o600 });
    assert.equal(new WorkerRecoveryJournal(path, 2).snapshot().turns.length, 1);
    assert.equal(restarted.snapshot().engineStopped, false);
    assert.equal(restarted.snapshot().turns[0]?.events[0]?.sequence, 1);
    assert.throws(() => restarted.acknowledge(1, 'turn-1', 1, false), /stale/);
    assert.throws(() => restarted.acknowledge(2, 'turn-1', 2, false), /invalid/);
    restarted.acknowledge(2, 'turn-1', 1, false);
    assert.equal(restarted.snapshot().turns.length, 1);
    restarted.settled('turn-1', { status: 'completed', text: '' });
    assert.equal(new WorkerRecoveryJournal(path, 3).snapshot().turns.length, 1);
    restarted.acknowledge(2, 'turn-1', 1, true);
    assert.equal(restarted.snapshot().turns.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt and partial journal is refused, never treated as an empty one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-recovery-'));
  try {
    const path = join(dir, 'journal');
    writeFileSync(path, '{', { mode: 0o600 });
    assert.throws(() => new WorkerRecoveryJournal(path, 1), /cannot be opened/);
    assert.equal(readFileSync(path, 'utf8'), '{');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
