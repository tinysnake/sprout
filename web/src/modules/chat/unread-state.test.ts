import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUnreadState } from './unread-state.ts';

test('concurrent observers wait for the durable receipt before treating the conversation as settled', async () => {
  let release!: (value: typeof row) => void;
  let receiptDone = false;
  const state = createUnreadState({ listUnread: async () => [{ ...row, count: receiptDone ? 0 : 2 }], markRead: () => new Promise((resolve) => { release = (value) => { receiptDone = true; resolve(value); }; }) });
  const first = state.markRead('scope', ['seen']);
  let settled = false;
  const second = state.markRead('scope', ['seen']).then(() => { settled = true; });
  try { await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false, 'arrival observers cannot announce before the receipt settles'); }
  finally { release({ ...row, count: 0 }); await first; await second; }
  assert.equal(state.count('scope'), 0);
});

const row = { scopeId: 'scope', projectId: 'project', count: 2 };
test('unread projection rejects hostile counts and reports unavailable instead of inventing zero read state', async () => {
  for (const count of [-1, NaN, Infinity, 0.5]) {
    const state = createUnreadState({ listUnread: async () => [{ ...row, count }], markRead: async () => row });
    await state.refresh();
    assert.equal(state.available.value, false);
    assert.deepEqual(state.scopes.value, []);
  }
  const empty = createUnreadState({ listUnread: async () => [], markRead: async () => row });
  await empty.refresh(); assert.equal(empty.available.value, true); assert.equal(empty.total.value, 0);
});

test('failed read receipts retain durable unread and retry without a local optimistic clear', async () => {
  let fail = true;
  const state = createUnreadState({ listUnread: async () => [{ ...row, count: fail ? 2 : 0 }], markRead: async () => { if (fail) throw new Error('offline'); return { ...row, count: 0 }; } });
  await state.refresh(); await state.markRead('scope', ['seen']); assert.equal(state.count('scope'), 2);
  fail = false; await state.markRead('scope', ['seen']); assert.equal(state.count('scope'), 0);
});

test('a summary started before a read receipt cannot restore obsolete unread counts', async () => {
  let release!: (rows: readonly typeof row[]) => void;
  let calls = 0;
  const state = createUnreadState({ listUnread: () => ++calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve([{ ...row, count: 0 }]), markRead: async () => ({ ...row, count: 0 }) });
  const refresh = state.refresh(); const receipt = state.markRead('scope', ['seen']);
  release([row]); await refresh; await receipt;
  assert.equal(state.count('scope'), 0); assert.equal(state.available.value, true);
});
