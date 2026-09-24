import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkerConnectionRegistry } from './worker-epoch.ts';
import { SqliteWorkerConnectionEpochStore } from './worker-epoch-store.ts';

test('the first accepted connection is epoch 1 and each later one is strictly greater', () => {
  const registry = new WorkerConnectionRegistry({ clock: () => 1_000, idFactory: ids() });
  const first = registry.accept('enroll-1');
  assert.equal(first.epoch, 1);
  const second = registry.accept('enroll-1');
  assert.equal(second.epoch, 2);
  const third = registry.accept('enroll-1');
  assert.equal(third.epoch, 3);
});

test('a newer epoch invalidates the old one and stale facts are refused deterministically', () => {
  const registry = new WorkerConnectionRegistry({ clock: () => 1_000, idFactory: ids() });
  const first = registry.accept('enroll-1');
  const second = registry.accept('enroll-1');
  assert.equal(registry.isCurrent('enroll-1', second.connectionId), true);
  assert.equal(registry.isCurrent('enroll-1', first.connectionId), false);
  const decision = registry.decide('enroll-1', first.connectionId);
  assert.deepEqual(decision, { accepted: false, reason: 'superseded' });
  assert.deepEqual(registry.decide('enroll-1', second.connectionId).accepted, true);
});

test('epochs are independent per enrollment', () => {
  const registry = new WorkerConnectionRegistry({ clock: () => 1_000, idFactory: ids() });
  assert.equal(registry.accept('a').epoch, 1);
  assert.equal(registry.accept('b').epoch, 1);
  assert.equal(registry.accept('a').epoch, 2);
});

test('invalidation without replacement clears the current epoch and refuses a late fact', () => {
  const registry = new WorkerConnectionRegistry({ clock: () => 1_000, idFactory: ids() });
  const only = registry.accept('enroll-1');
  assert.equal(registry.invalidate('enroll-1', only.connectionId), true);
  assert.equal(registry.current('enroll-1'), undefined);
  assert.deepEqual(registry.decide('enroll-1', only.connectionId), {
    accepted: false,
    reason: 'superseded',
  });
  // A fact for an enrollment that never connected is unknown, not stale.
  assert.deepEqual(registry.decide('never', 'x'), { accepted: false, reason: 'unknown-enrollment' });
});

test('a recreated registry allocates a strictly newer durable epoch after restart', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-worker-epoch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'sprout.db');

  const firstStore = new SqliteWorkerConnectionEpochStore({ filename });
  const firstRegistry = new WorkerConnectionRegistry({
    store: firstStore,
    clock: () => 1_000,
    idFactory: () => 'connection-before-restart',
  });
  const first = firstRegistry.accept('enroll-1');
  firstStore.close();

  const secondStore = new SqliteWorkerConnectionEpochStore({ filename });
  const secondRegistry = new WorkerConnectionRegistry({
    store: secondStore,
    clock: () => 2_000,
    idFactory: () => 'connection-after-restart',
  });
  const second = secondRegistry.accept('enroll-1');
  assert.equal(first.epoch, 1);
  assert.equal(second.epoch, 2);
  assert.deepEqual(secondRegistry.decide('enroll-1', first.connectionId), {
    accepted: false,
    reason: 'stale-epoch',
  });
  secondStore.close();
});

function ids(): () => string {
  let n = 0;
  return () => `conn-${++n}`;
}
