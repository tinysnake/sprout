import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerConnectionRegistry } from './worker-epoch.ts';

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

function ids(): () => string {
  let n = 0;
  return () => `conn-${++n}`;
}
