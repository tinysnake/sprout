import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteRecoveryStore } from './sqlite-recovery-store.ts';
import type { JournalTurn } from '../worker/recovery-journal.ts';

test('SQLite reopen preserves contiguous receipt before ack; duplicates do not advance it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-receipt-'));
  try {
    const path = join(dir, 'store.db');
    const turn: JournalTurn = { sessionId: 's', turnId: 't', acknowledged: 0, settlementAcknowledged: false,
      events: [{ sequence: 1, event: { type: 'notice', text: 'delivered' } }],
      settlement: { status: 'completed', text: '' } };
    const first = new SqliteRecoveryStore({ filename: path });
    assert.deepEqual(await first.receiveWorkerTurn('enroll', turn), { sequence: 1, settlement: true, eventCount: 1 });
    first.close();
    const reopened = new SqliteRecoveryStore({ filename: path });
    assert.deepEqual(await reopened.receiveWorkerTurn('enroll', turn), { sequence: 1, settlement: true, eventCount: 1 });
    await assert.rejects(reopened.receiveWorkerTurn('enroll', { ...turn,
      events: [{ sequence: 3, event: { type: 'notice', text: 'gap' } }] }), /missing Worker event sequence/);
    assert.deepEqual(await reopened.receiveWorkerTurn('enroll', turn), { sequence: 1, settlement: true, eventCount: 1 });
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
