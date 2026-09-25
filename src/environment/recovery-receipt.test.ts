import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRecoveryStore } from './sqlite-recovery-store.ts';
import type { JournalTurn } from '../worker/recovery-journal.ts';

test('SQLite reopen preserves contiguous receipt before ack; duplicates do not advance it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-receipt-'));
  try {
    const path = join(dir, 'store.db');
    const turn: JournalTurn = { sessionId: 's', turnId: 't', runId: 'run-1', acknowledged: 0, settlementAcknowledged: false,
      events: [{ sequence: 1, event: { type: 'notice', text: 'delivered' } }],
      settlement: { status: 'completed', text: '' } };
    const first = new SqliteRecoveryStore({ filename: path });
    assert.deepEqual(await first.receiveWorkerTurn('enroll', turn), { sequence: 1, settlement: true, eventCount: 1 });
    first.close();
    const reopened = new SqliteRecoveryStore({ filename: path });
    assert.deepEqual(await reopened.receiveWorkerTurn('enroll', turn), { sequence: 1, settlement: true, eventCount: 1 });
    await assert.rejects(reopened.receiveWorkerTurn('enroll', { ...turn,
      events: [{ sequence: 1, event: { type: 'notice', text: 'conflicting duplicate' } }] }), /conflicting duplicate Worker event/);
    assert.deepEqual(await reopened.workerRunReceipt('enroll', 'run-1'), {
      eventCount: 1, terminal: true, settlementStatus: 'completed', pending: true,
    });
    await reopened.acknowledgeWorkerTurn('enroll', 't', 1, true);
    assert.equal((await reopened.workerRunEvents('enroll', 'run-1')).length, 1,
      'ack progress cannot discard payload before run projection');
    assert.deepEqual(await reopened.workerRunReceipt('enroll', 'run-1'), {
      eventCount: 1, terminal: true, settlementStatus: 'completed', pending: false,
    });
    await reopened.receiveWorkerContext('enroll', 'task-1', 'prepared');
    assert.equal(await reopened.workerContext('enroll', 'task-1'), 'prepared');
    await assert.rejects(reopened.receiveWorkerTurn('enroll', { ...turn,
      events: [{ sequence: 3, event: { type: 'notice', text: 'gap' } }] }), /missing Worker event sequence/);
    await reopened.compactWorkerRun('enroll', 'run-1');
    assert.equal((await reopened.workerRunEvents('enroll', 'run-1')).length, 0);
    assert.deepEqual(await reopened.receiveWorkerTurn('enroll', turn), { sequence: 1, settlement: true, eventCount: 1 });
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing settlement leaves the run explicitly pending and cannot compact its event journal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-missing-settlement-'));
  try {
    const store = new SqliteRecoveryStore({ filename: join(dir, 'store.db') });
    const turn: JournalTurn = { sessionId: 's', turnId: 't', runId: 'run-1', acknowledged: 0,
      settlementAcknowledged: false, events: [{ sequence: 1, event: { type: 'notice', text: 'retained' } }] };
    assert.deepEqual(await store.receiveWorkerTurn('enroll', turn), { sequence: 1, settlement: false, eventCount: 1 });
    await store.acknowledgeWorkerTurn('enroll', 't', 1, false);
    assert.deepEqual(await store.workerRunReceipt('enroll', 'run-1'), { eventCount: 1, terminal: false, pending: true });
    await assert.rejects(store.compactWorkerRun('enroll', 'run-1'), /unacknowledged/);
    assert.equal((await store.workerRunEvents('enroll', 'run-1')).length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a legacy unbound turn prunes payload only after durable full ack', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-unbound-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.db');
  const store = new SqliteRecoveryStore({ filename: path });
  const turn: JournalTurn = { sessionId: 's', turnId: 'legacy-turn', acknowledged: 0,
    settlementAcknowledged: false, events: [{ sequence: 1, event: { type: 'notice', text: 'destined for Sprout' } }],
    settlement: { status: 'completed', text: '' } };
  try {
    await store.receiveWorkerTurn('enroll', turn);
    await store.compactUnboundWorkerTurns('enroll');
    await store.acknowledgeWorkerTurn('enroll', turn.turnId, 1, true);
    await store.compactUnboundWorkerTurns('enroll');
    assert.deepEqual(await store.receiveWorkerTurn('enroll', turn), { sequence: 1, settlement: true, eventCount: 1 });
  } finally { store.close(); }
  const db = new DatabaseSync(path);
  try {
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM worker_recovery_events').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT compacted FROM worker_recovery_receipts').get() as { compacted: number }).compacted, 1);
  } finally { db.close(); }
});
