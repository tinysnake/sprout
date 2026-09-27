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
    assert.equal(statSync(`${path}.lock.sqlite`).mode & 0o777, 0o600);
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

test('a newer epoch waits for an old process paused between epoch check and rename', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-epoch-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal');
  const seed = new WorkerRecoveryJournal(path, 1);
  seed.begin('session-1', 'turn-1');
  const old = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { WorkerRecoveryJournal } from './src/worker/recovery-journal.ts';
    const path = process.argv[1];
    const journal = new WorkerRecoveryJournal(path, 1);
    const rename = fs.renameSync;
    let paused = false;
    fs.renameSync = (source, destination) => {
      if (destination === path && !paused) {
        paused = true;
        process.stdout.write('paused\\n');
        fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      }
      rename(source, destination);
    };
    syncBuiltinESMExports();
    journal.event('turn-1', { type: 'notice', text: 'retained' });
    process.stdout.write('committed\\n');
  `, path], { stdio: ['pipe', 'pipe', 'ignore'] });
  let newer: ReturnType<typeof spawn> | undefined;
  const output = (child: ReturnType<typeof spawn>, text: string) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${text}`)), 5_000);
    let received = '';
    child.stdout!.on('data', (data: Buffer) => {
      received += data.toString();
      if (received.includes(text)) { clearTimeout(timeout); resolve(); }
    });
    child.once('error', reject);
    child.once('exit', () => { if (!received.includes(text)) reject(new Error(`exited before ${text}`)); });
  });
  try {
    await output(old, 'paused');
    newer = spawn(process.execPath, ['--input-type=module', '-e', `
      import { WorkerRecoveryJournal } from './src/worker/recovery-journal.ts';
      process.stdout.write('starting\\n');
      new WorkerRecoveryJournal(process.argv[1], 2);
      process.stdout.write('advanced\\n');
    `, path], { stdio: ['ignore', 'pipe', 'ignore'] });
    let advanced = false;
    const advancedOutput = output(newer, 'advanced').then(() => { advanced = true; });
    await output(newer, 'starting');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(advanced, false, 'epoch advancement cannot pass a writer paused after the old epoch check');
    old.stdin!.write('x');
    await output(old, 'committed');
    await advancedOutput;
    const snapshot = new WorkerRecoveryJournal(path, 2).snapshot();
    assert.equal(snapshot.epoch, 2);
    assert.equal(snapshot.turns[0]?.events[0]?.sequence, 1, 'new epoch retained the old committed event');
  } finally {
    old.kill('SIGKILL');
    newer?.kill('SIGKILL');
  }
});

test('a killed process releases the epoch lock without dropping retained facts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-lock-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal');
  const first = new WorkerRecoveryJournal(path, 1);
  first.begin('s', 't');
  first.event('t', { type: 'notice', text: 'retained' });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1] + '.lock.sqlite');
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    setInterval(() => {}, 1000);
  `, path], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout!.once('data', (data: Buffer) => data.toString().includes('locked') ? resolve() : reject(new Error('not locked')));
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const next = new WorkerRecoveryJournal(path, 2);
    assert.equal(next.snapshot().turns[0]?.events[0]?.sequence, 1);
  } finally { child.kill('SIGKILL'); }
});
