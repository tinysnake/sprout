import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from './model.ts';
import { EnvironmentPool, InMemoryLeaseStore } from './pool.ts';

const macDefinition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [
    { name: 'agent-run', requiresLease: true },
    { name: 'read-only-investigation', requiresLease: false },
  ],
};

const macInstance: EnvironmentInstance = {
  id: 'mac-mini-1',
  definitionId: 'macos-workstation',
};

function poolAt(startMs: number) {
  let now = startMs;
  const pool = new EnvironmentPool({
    definitions: [macDefinition],
    instances: [macInstance],
    clock: { now: () => now },
  });
  return { pool, advance: (ms: number) => { now += ms; } };
}

test('a capacity-intensive capability can be leased exclusively', () => {
  const { pool } = poolAt(1_000);
  const result = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.lease.state, 'active');
  assert.equal(result.ok && result.lease.holderId, 'agent-a');
});

test('a second holder cannot lease an instance that is already leased', () => {
  const { pool } = poolAt(1_000);
  pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });

  const conflict = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-b',
    ttlMs: 60_000,
  });

  assert.equal(conflict.ok, false);
  assert.equal(conflict.ok === false && conflict.reason, 'conflict');
  assert.equal(conflict.ok === false && conflict.heldBy, 'agent-a');
});

test('releasing a lease makes the instance acquirable again', () => {
  const { pool } = poolAt(1_000);
  const first = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const released = pool.releaseLease(first.lease.id);
  assert.equal(released?.state, 'released');

  const second = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-b',
    ttlMs: 60_000,
  });
  assert.equal(second.ok, true);
});

test('a restarted pool does not reuse the id of a released durable lease', () => {
  const store = new InMemoryLeaseStore();
  const firstPool = new EnvironmentPool({ definitions: [macDefinition], instances: [macInstance], store });
  const first = firstPool.acquireLease({ instanceId: 'mac-mini-1', capability: 'agent-run', mode: 'read-write', holderId: 'agent-a', ttlMs: 60_000 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  firstPool.releaseLease(first.lease.id);

  const restartedPool = new EnvironmentPool({ definitions: [macDefinition], instances: [macInstance], store });
  const second = restartedPool.acquireLease({ instanceId: 'mac-mini-1', capability: 'agent-run', mode: 'read-write', holderId: 'agent-b', ttlMs: 60_000 });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.notEqual(second.lease.id, first.lease.id);
});

test('an expired lease stops blocking its instance', () => {
  const { pool, advance } = poolAt(1_000);
  pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });

  advance(60_001);

  assert.equal(pool.activeLease('mac-mini-1'), undefined);
  const second = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-b',
    ttlMs: 60_000,
  });
  assert.equal(second.ok, true);
});

test('extending an active lease keeps the instance reserved', () => {
  const { pool, advance } = poolAt(1_000);
  const acquired = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;

  advance(50_000);
  const extended = pool.extendLease(acquired.lease.id, 60_000);
  assert.equal(extended?.expiresAt, 111_000);

  advance(30_000);
  const conflict = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-b',
    ttlMs: 60_000,
  });
  assert.equal(conflict.ok, false);
});

test('a read-only capability does not require a lease', () => {
  const { pool } = poolAt(1_000);
  assert.equal(pool.requiresLease('mac-mini-1', 'read-only-investigation'), false);
  assert.equal(pool.requiresLease('mac-mini-1', 'agent-run'), true);

  const result = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'read-only-investigation',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'lease-not-required');
});

test('leasing an unknown instance or capability fails precisely', () => {
  const { pool } = poolAt(1_000);

  const unknownInstance = pool.acquireLease({
    instanceId: 'nope',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  assert.equal(unknownInstance.ok === false && unknownInstance.reason, 'unknown-instance');

  const unknownCapability = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'nope',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  assert.equal(unknownCapability.ok === false && unknownCapability.reason, 'unknown-capability');
});

test('leases are recorded for observability', () => {
  const { pool } = poolAt(1_000);
  pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  const all = pool.leases();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.holderId, 'agent-a');
});

test('a recovering lease blocks acquisition and callers see the recovery state', () => {
  const { pool } = poolAt(1_000);
  const acquired = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;

  const recovering = pool.markRecovering(acquired.lease.id);
  assert.equal(recovering?.state, 'recovering');

  const conflict = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-b',
    ttlMs: 60_000,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ok === false && conflict.reason, 'conflict');
  assert.equal(conflict.ok === false && conflict.state, 'recovering');
  assert.equal(conflict.ok === false && conflict.heldBy, 'agent-a');
});

test('resolving recovery makes the instance acquirable again', () => {
  const { pool } = poolAt(1_000);
  const acquired = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;

  pool.markRecovering(acquired.lease.id);
  const resolved = pool.resolveRecovery(acquired.lease.id);
  assert.equal(resolved?.state, 'released');

  const second = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-b',
    ttlMs: 60_000,
  });
  assert.equal(second.ok, true);
});

test('a recovering lease does not expire with time and cannot be extended', () => {
  const { pool, advance } = poolAt(1_000);
  const acquired = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;

  pool.markRecovering(acquired.lease.id);
  assert.equal(pool.extendLease(acquired.lease.id, 60_000), undefined);

  advance(100_000);

  const conflict = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-b',
    ttlMs: 60_000,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ok === false && conflict.state, 'recovering');
});

test('lease changes persist to a LeaseStore', () => {
  const store = new InMemoryLeaseStore();
  let now = 1_000;
  const pool = new EnvironmentPool({
    definitions: [macDefinition],
    instances: [macInstance],
    store,
    clock: { now: () => now },
  });

  const acquired = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-a',
    runId: 'run-1',
    ttlMs: 60_000,
  });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;

  assert.equal(store.get(acquired.lease.id)?.state, 'active');
  assert.equal(store.get(acquired.lease.id)?.runId, 'run-1');

  pool.markRecovering(acquired.lease.id);
  assert.equal(store.get(acquired.lease.id)?.state, 'recovering');

  pool.releaseLease(acquired.lease.id);
  assert.equal(store.get(acquired.lease.id)?.state, 'released');
});

test('leases in the store are reloaded on pool initialization', () => {
  const store = new InMemoryLeaseStore();
  store.save({
    id: 'lease-prior',
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-prior',
    acquiredAt: 1_000,
    expiresAt: 100_000,
    state: 'active',
  });

  const pool = new EnvironmentPool({
    definitions: [macDefinition],
    instances: [macInstance],
    store,
    clock: { now: () => 2_000 },
  });

  assert.equal(pool.activeLease('mac-mini-1')?.id, 'lease-prior');
  const conflict = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    mode: 'read-write',
    holderId: 'agent-new',
    ttlMs: 60_000,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ok === false && conflict.heldBy, 'agent-prior');
});

test('read leases share an instance while read-write leases exclude every holder', () => {
  const definition: EnvironmentDefinition = {
    ...macDefinition,
    capabilities: [
      { name: 'agent-run', requiresLease: true, leaseMode: 'read-write' },
      { name: 'read-only-investigation', requiresLease: true, leaseMode: 'read' },
    ],
  };
  const pool = new EnvironmentPool({ definitions: [definition], instances: [macInstance], clock: { now: () => 1_000 } });
  const readA = pool.acquireLease({
    instanceId: 'mac-mini-1', capability: 'read-only-investigation', mode: 'read',
    holderId: 'reader-a', runId: 'run-reader-a', ttlMs: 60_000,
  });
  assert.equal(readA.ok, true);
  const readB = pool.acquireLease({
    instanceId: 'mac-mini-1', capability: 'read-only-investigation', mode: 'read',
    holderId: 'reader-b', runId: 'run-reader-b', ttlMs: 60_000,
  });
  assert.equal(readB.ok, true, 'multiple readers may hold one instance concurrently');
  const unsupportedReadWriter = pool.acquireLease({
    instanceId: 'mac-mini-1', capability: 'agent-run', mode: 'read',
    holderId: 'reader-with-write-capability', ttlMs: 60_000,
  });
  assert.equal(unsupportedReadWriter.ok === false && unsupportedReadWriter.reason, 'mode-not-supported');

  const writerConflict = pool.acquireLease({
    instanceId: 'mac-mini-1', capability: 'agent-run', mode: 'read-write',
    holderId: 'writer', runId: 'run-writer', ttlMs: 60_000,
  });
  assert.equal(writerConflict.ok, false);
  assert.equal(writerConflict.ok === false && writerConflict.reason, 'conflict');
  assert.deepEqual(writerConflict.ok === false && writerConflict.conflict, {
    kind: 'writer-blocked-by-readers',
    readers: [
      { leaseId: readA.ok ? readA.lease.id : '', holderId: 'reader-a', state: 'active' },
      { leaseId: readB.ok ? readB.lease.id : '', holderId: 'reader-b', state: 'active' },
    ],
  });

  if (readA.ok) pool.releaseLease(readA.lease.id);
  if (readB.ok) pool.releaseLease(readB.lease.id);
  const writer = pool.acquireLease({
    instanceId: 'mac-mini-1', capability: 'agent-run', mode: 'read-write',
    holderId: 'writer', runId: 'run-writer', ttlMs: 60_000,
  });
  assert.equal(writer.ok, true);
  const secondWriter = pool.acquireLease({
    instanceId: 'mac-mini-1', capability: 'agent-run', mode: 'read-write',
    holderId: 'writer-b', runId: 'run-writer-b', ttlMs: 60_000,
  });
  assert.deepEqual(secondWriter.ok === false && secondWriter.conflict, {
    kind: 'writer-blocked-by-writer',
    writer: writer.ok ? { leaseId: writer.lease.id, holderId: 'writer', state: 'active' } : undefined,
  });
  const readerConflict = pool.acquireLease({
    instanceId: 'mac-mini-1', capability: 'read-only-investigation', mode: 'read',
    holderId: 'reader-c', runId: 'run-reader-c', ttlMs: 60_000,
  });
  assert.equal(readerConflict.ok, false);
  assert.deepEqual(readerConflict.ok === false && readerConflict.conflict, {
    kind: 'reader-blocked-by-writer',
    writer: writer.ok ? { leaseId: writer.lease.id, holderId: 'writer', state: 'active' } : undefined,
  });
});

test('recovery and release stay scoped to one reader lease', () => {
  const definition: EnvironmentDefinition = {
    ...macDefinition,
    capabilities: [
      { name: 'agent-run', requiresLease: true, leaseMode: 'read-write' },
      { name: 'read-only-investigation', requiresLease: true, leaseMode: 'read' },
    ],
  };
  const pool = new EnvironmentPool({ definitions: [definition], instances: [macInstance], clock: { now: () => 1_000 } });
  const first = pool.acquireLease({ instanceId: 'mac-mini-1', capability: 'read-only-investigation', mode: 'read',
    holderId: 'reader-a', runId: 'run-reader-a', ttlMs: 60_000 });
  const second = pool.acquireLease({ instanceId: 'mac-mini-1', capability: 'read-only-investigation', mode: 'read',
    holderId: 'reader-b', runId: 'run-reader-b', ttlMs: 60_000 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  pool.markRecovering(first.lease.id);
  const blocked = pool.acquireLease({ instanceId: 'mac-mini-1', capability: 'agent-run', mode: 'read-write',
    holderId: 'writer', runId: 'run-writer', ttlMs: 60_000 });
  assert.deepEqual(blocked.ok === false && blocked.conflict, {
    kind: 'recovery',
    holders: [{ leaseId: first.lease.id, holderId: 'reader-a', state: 'recovering' }],
  });
  assert.equal(pool.resolveRecovery(first.lease.id)?.state, 'released');
  assert.deepEqual(pool.activeLeases('mac-mini-1').map((lease) => lease.id), [second.lease.id]);

  const third = pool.acquireLease({ instanceId: 'mac-mini-1', capability: 'read-only-investigation', mode: 'read',
    holderId: 'reader-c', runId: 'run-reader-c', ttlMs: 60_000 });
  assert.equal(third.ok, true, 'resolving one reader leaves the other active and admits another reader');
  pool.releaseLease(second.lease.id);
  if (third.ok) pool.releaseLease(third.lease.id);
  assert.deepEqual(pool.activeLeases('mac-mini-1'), []);
});
