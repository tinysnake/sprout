import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { WorkerRecoveryJournal } from './recovery-journal.ts';

test('journal survives restart, fences stale acknowledgements and compacts only after settlement ack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-recovery-'));
  try {
    const path = join(dir, 'journal');
    const journal = new WorkerRecoveryJournal(path, 1);
    journal.engineStarted();
    journal.context('task-1', 'prepared');
    journal.begin('session-1', 'turn-1');
    const event = { type: 'notice' as const, text: 'event already destined for Sprout' };
    journal.event('turn-1', event);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /secret|prompt|credential/);
    const restarted = new WorkerRecoveryJournal(path, 2);
    assert.throws(() => journal.context('task', 'recycled'), /stale recovery journal epoch/);
    assert.throws(() => journal.engineStopped(), /stale recovery journal epoch/);
    assert.throws(() => new WorkerRecoveryJournal(path, 1), /stale recovery journal epoch/);
    restarted.engineStopped();
    assert.equal(restarted.snapshot().engineStopped, false, 'a new process cannot certify its predecessor’s orphan');
    // A torn staging write cannot replace the fsynced/renamed journal.
    writeFileSync(`${path}.partial.tmp`, '{', { mode: 0o600 });
    assert.equal(new WorkerRecoveryJournal(path, 2).snapshot().turns.length, 1);
    assert.equal(restarted.snapshot().engineStopped, false);
    assert.equal(restarted.snapshot().taskContexts['task-1'], 'prepared');
    assert.throws(() => restarted.acknowledgeContext(1, 'task-1', 'prepared'), /stale/);
    restarted.acknowledgeContext(2, 'task-1', 'prepared');
    assert.equal(restarted.snapshot().taskContexts['task-1'], undefined);
    assert.equal(restarted.snapshot().turns[0]?.events[0]?.sequence, 1);
    assert.throws(() => restarted.acknowledge(1, 'turn-1', 1, false), /stale/);
    assert.throws(() => restarted.acknowledge(2, 'turn-1', 2, false), /invalid/);
    restarted.acknowledge(2, 'turn-1', 1, false);
    assert.equal(restarted.snapshot().turns.length, 1);
    restarted.settled('turn-1', { status: 'completed', text: '' });
    const third = new WorkerRecoveryJournal(path, 3);
    assert.equal(third.snapshot().turns.length, 1);
    assert.throws(() => restarted.acknowledge(2, 'turn-1', 1, true), /stale recovery journal epoch/);
    third.acknowledge(3, 'turn-1', 1, true);
    assert.equal(third.snapshot().turns.length, 0);
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

test('journal rejects capacity overflow before changing its durable record', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-bounded-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal');
  const journal = new WorkerRecoveryJournal(path, 1);
  journal.begin('s', 't');
  const before = readFileSync(path, 'utf8');
  assert.throws(() => journal.event('t', { type: 'notice', text: 'x'.repeat(4 * 1024 * 1024) }),
    /capacity exceeded/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(new WorkerRecoveryJournal(path, 2).snapshot().turns.length, 1);
});

test('a killed Worker process leaves its unacknowledged turn and unproved engine fence on disk', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-kill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { WorkerRecoveryJournal } from './src/worker/recovery-journal.ts';
    const journal = new WorkerRecoveryJournal(process.argv[1], 1);
    journal.engineStarted(); journal.begin('s', 't', 'run-1');
    journal.event('t', { type: 'notice', text: 'event destined for Sprout' });
    process.stdout.write('ready\\n'); setInterval(() => {}, 1000);
  `, path], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.stdout!.once('data', (data: Buffer) => data.toString().includes('ready') ? resolve() : reject(new Error('worker not ready')));
    });
    child.kill('SIGKILL');
    const signal = await new Promise<string | null>((resolve) => child.once('exit', (_code, ended) => resolve(ended)));
    assert.equal(signal, 'SIGKILL');
    const restarted = new WorkerRecoveryJournal(path, 2);
    assert.equal(restarted.snapshot().engineStopped, false);
    assert.deepEqual(restarted.snapshot().turns.map((turn) => ({ id: turn.runId, seq: turn.events[0]?.sequence })),
      [{ id: 'run-1', seq: 1 }]);
  } finally { if (!child.killed) child.kill('SIGKILL'); }
});
