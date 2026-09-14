/**
 * Store-level evidence for the two invariants the probe depends on.
 *
 * These tests use a real SQLite file (not `:memory:`) and reopen it, so a
 * passing test is a statement about durability across a process restart rather
 * than about one process's memory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteCollaborationStore } from './sqlite-store.ts';
import { wakeIdempotencyKey } from './store.ts';
import type { Message, WakePlan } from './model.ts';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'hello',
    recipients: ['scout'],
    deliveryKey: 'delivery-1',
    createdAt: 1,
    ...overrides,
  };
}

function plan(messageId: string, agentId: string): WakePlan {
  return {
    messageId,
    decisions: [{ agentId, reason: 'direct-recipient' }],
    observations: [],
  };
}

function withDatabase(run: (store: SqliteCollaborationStore, path: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-collab-store-'));
  const path = join(directory, 'store.db');
  const store = new SqliteCollaborationStore({ filename: path });
  return run(store, path).finally(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

test('a message and its wake requests become durable together', async () => {
  await withDatabase(async (store) => {
    const stored = await store.postMessage({ message: message(), plan: plan('msg-1', 'scout'), now: 1 });
    assert.equal(stored.duplicate, false);
    assert.equal(stored.wakes.length, 1);

    // The wake is already durable at this point — before any run is admitted.
    const wake = await store.getWakeRequest(wakeIdempotencyKey('msg-1', 'scout'));
    assert.equal(wake?.status, 'pending');
    assert.equal(wake?.runId, undefined);
  });
});

test('a Message and its wake requests survive a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-collab-restart-'));
  const path = join(directory, 'store.db');
  try {
    const first = new SqliteCollaborationStore({ filename: path });
    await first.postMessage({ message: message(), plan: plan('msg-1', 'scout'), now: 1 });
    await first.admitWake({
      idempotencyKey: wakeIdempotencyKey('msg-1', 'scout'),
      runId: 'run-1',
      now: 2,
    });
    first.close();

    // A fresh store over the same file, as a restarted Sprout process would use.
    const second = new SqliteCollaborationStore({ filename: path });
    const restoredMessage = await second.getMessage('msg-1');
    assert.equal(restoredMessage?.body, 'hello');
    const restoredWake = await second.getWakeRequest(wakeIdempotencyKey('msg-1', 'scout'));
    assert.equal(restoredWake?.status, 'admitted');
    assert.equal(restoredWake?.runId, 'run-1');
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a repeated delivery key inserts nothing and returns the stored input', async () => {
  await withDatabase(async (store) => {
    const first = await store.postMessage({ message: message(), plan: plan('msg-1', 'scout'), now: 1 });
    const second = await store.postMessage({
      // Same delivery key, different id: the key, not the id, is the identity.
      message: message({ id: 'msg-other' }),
      plan: plan('msg-other', 'scout'),
      now: 2,
    });

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.message.id, 'msg-1', 'the first durable message wins');
    const messages = await store.listMessages();
    assert.equal(messages.length, 1);
    const wakes = await store.listWakeRequests();
    assert.equal(wakes.length, 1, 'a retry does not add a second wake request');
  });
});

test('only one of two admissions wins the same wake', async () => {
  await withDatabase(async (store) => {
    await store.postMessage({ message: message(), plan: plan('msg-1', 'scout'), now: 1 });
    const key = wakeIdempotencyKey('msg-1', 'scout');
    const first = await store.admitWake({ idempotencyKey: key, runId: 'run-a', now: 2 });
    const second = await store.admitWake({ idempotencyKey: key, runId: 'run-b', now: 3 });

    assert.deepEqual(first, {
      admitted: true,
      wake: (await store.getWakeRequest(key))!,
    });
    assert.equal(second.admitted, false, 'the second admission is refused');
    assert.equal(second.wake.runId, 'run-a', 'the first run keeps the wake');
  });
});

test('suppressed and failed wake outcomes are durable, not silent', async () => {
  await withDatabase(async (store) => {
    await store.postMessage({
      message: message(),
      plan: {
        messageId: 'msg-1',
        decisions: [],
        observations: [
          { agentId: '*', status: 'suppressed', reason: 'wake-model', detail: 'not needed' },
          { agentId: 'ghost', status: 'failed', reason: 'direct-recipient', detail: 'not a member' },
        ],
      },
      now: 1,
    });
    const observations = store.observations('msg-1');
    assert.equal(observations.length, 2);
    assert.deepEqual(
      observations.map((observation) => `${observation.status}:${observation.agentId}`),
      ['suppressed:*', 'failed:ghost'],
    );
  });
});
