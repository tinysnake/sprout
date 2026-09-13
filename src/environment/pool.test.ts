import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from './model.ts';
import { EnvironmentPool } from './pool.ts';

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
    holderId: 'agent-a',
    ttlMs: 60_000,
  });

  const conflict = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
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
    holderId: 'agent-b',
    ttlMs: 60_000,
  });
  assert.equal(second.ok, true);
});

test('an expired lease stops blocking its instance', () => {
  const { pool, advance } = poolAt(1_000);
  pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });

  advance(60_001);

  assert.equal(pool.activeLease('mac-mini-1'), undefined);
  const second = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
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
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  assert.equal(unknownInstance.ok === false && unknownInstance.reason, 'unknown-instance');

  const unknownCapability = pool.acquireLease({
    instanceId: 'mac-mini-1',
    capability: 'nope',
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
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  const all = pool.leases();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.holderId, 'agent-a');
});
