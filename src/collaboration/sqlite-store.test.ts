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
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteCollaborationStore } from './sqlite-store.ts';
import { wakeIdempotencyKey } from './store.ts';
import type { Message, WakePlan } from './model.ts';
import type { ProjectEvent } from './events.ts';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    projectId: 'project-sprout',
    scopeId: 'dm-1',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'hello',
    recipients: ['scout'],
    deliveryKey: 'delivery-1',
    createdAt: 1,
    ...overrides,
  };
}

function plan(inputId: string, agentId: string): WakePlan {
  return {
    inputId,
    decisions: [{ agentId, reason: 'direct-recipient' }],
    observations: [],
  };
}

function event(overrides: Partial<ProjectEvent> = {}): ProjectEvent {
  return {
    id: 'evt-1',
    projectId: 'project-sprout',
    kind: 'task-blocker',
    summary: 'Task T1 is blocked',
    producer: { id: 'sprout', kind: 'system' },
    disposition: 'addressed',
    responsibleAgentIds: ['scout'],
    deliveryKey: 'event-delivery-1',
    createdAt: 1,
    ...overrides,
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
    assert.equal(stored.wakes[0]?.inputId, 'msg-1', 'the wake names its causal input');

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
        inputId: 'msg-1',
        decisions: [],
        observations: [
          { agentId: '*', status: 'suppressed', reason: 'unaddressed', detail: 'not needed' },
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

test('a Project event and its wake requests persist, dedupe, and survive a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-collab-events-'));
  const path = join(directory, 'store.db');
  try {
    const first = new SqliteCollaborationStore({ filename: path });
    const stored = await first.publishEvent({
      event: event(),
      plan: {
        inputId: 'evt-1',
        decisions: [{ agentId: 'scout', reason: 'event-addressed' }],
        observations: [],
      },
      now: 1,
    });
    assert.equal(stored.duplicate, false);

    // Same delivery key, different id: the key, not the id, is the identity.
    const retry = await first.publishEvent({
      event: event({ id: 'evt-other' }),
      plan: {
        inputId: 'evt-other',
        decisions: [{ agentId: 'scout', reason: 'event-addressed' }],
        observations: [],
      },
      now: 2,
    });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.event.id, 'evt-1');
    assert.equal(retry.wakes.length, 1, 'a retry does not add a second wake request');
    first.close();

    const second = new SqliteCollaborationStore({ filename: path });
    const restored = await second.getEvent('evt-1');
    assert.equal(restored?.kind, 'task-blocker');
    assert.equal(restored?.disposition, 'addressed');
    assert.equal(restored?.producer.kind, 'system');
    assert.deepEqual(restored?.responsibleAgentIds, ['scout']);
    assert.equal((await second.listEvents('project-sprout')).length, 1);
    assert.equal((await second.listEvents('other-project')).length, 0);
    const wake = await second.getWakeRequest(wakeIdempotencyKey('evt-1', 'scout'));
    assert.equal(wake?.inputId, 'evt-1');
    assert.equal(wake?.status, 'pending');
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a schema-v18 database forward-migrates to scoped inputs and Project events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-collab-migrate-'));
  const path = join(directory, 'store.db');
  try {
    // A pre-#96 database: messages had no scope, wakes and observations keyed
    // on `message_id`, and no Project event table existed. Written directly so
    // the migration is exercised against real legacy rows.
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA user_version = 18;
      CREATE TABLE collaboration_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        body TEXT NOT NULL,
        recipients TEXT NOT NULL,
        delivery_key TEXT NOT NULL UNIQUE,
        in_reply_to TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE collaboration_wake_requests (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        run_id TEXT,
        detail TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE collaboration_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO collaboration_messages VALUES
        ('msg-project', 'project-sprout', 'project', 'human-lead', 'human', 'hi @all', '[]', 'legacy-1', NULL, 1),
        ('msg-direct', 'project-sprout', 'direct', 'human-lead', 'human', 'ping', '["scout"]', 'legacy-2', NULL, 2);
      INSERT INTO collaboration_wake_requests VALUES
        ('wake-1', 'msg-project', 'project-sprout', 'scout', 'broadcast', 'admitted', 'msg-project:scout', 'run-1', NULL, 1);
      INSERT INTO collaboration_observations (message_id, agent_id, status, reason, detail, created_at)
        VALUES ('msg-project', '*', 'suppressed', 'wake-model', 'legacy note', 1);
    `);
    legacy.close();

    const store = new SqliteCollaborationStore({ filename: path });
    const messages = await store.listMessages();
    const projectMessage = messages.find((message) => message.id === 'msg-project');
    const directMessage = messages.find((message) => message.id === 'msg-direct');
    // The Project channel's scope id is exact and derivable; a legacy direct
    // message's pair is not recoverable, so it keeps an empty scope id —
    // readable history that can never receive a new Message.
    assert.equal(projectMessage?.scopeId, 'channel-project-sprout');
    assert.equal(directMessage?.scopeId, '');

    const wake = await store.getWakeRequest('msg-project:scout');
    assert.equal(wake?.inputId, 'msg-project', 'message_id renamed to input_id');
    assert.equal(store.observations('msg-project').length, 1);

    // The migrated database accepts the new shapes end to end.
    const migrated = await store.publishEvent({ event: event({ deliveryKey: 'migrated-event' }), plan: { inputId: 'evt-1', decisions: [], observations: [] }, now: 5 });
    assert.equal(migrated.duplicate, false);
    assert.equal((await store.listEvents()).length, 1);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
