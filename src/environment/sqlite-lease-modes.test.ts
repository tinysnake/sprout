import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { EnvironmentPool } from './pool.ts';
import { SqliteLeaseStore } from './sqlite-store.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from './model.ts';
import type { LeaseStore } from './pool.ts';

const definition: EnvironmentDefinition = {
  id: 'mode-test-definition',
  platform: 'container',
  capabilities: [
    { name: 'agent-run', requiresLease: true, leaseMode: 'read-write' },
    { name: 'read-only-investigation', requiresLease: true, leaseMode: 'read' },
  ],
};
const instance: EnvironmentInstance = { id: 'mode-test-instance', definitionId: definition.id };

function poolWith(store: LeaseStore): EnvironmentPool {
  return new EnvironmentPool({ definitions: [definition], instances: [instance], store, clock: { now: () => 1_000 } });
}

test('lease mode survives SQLite reopen and historical rows stay read-write', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-lease-mode-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'leases.db');
  const firstStore = new SqliteLeaseStore({ filename });
  const firstPool = poolWith(firstStore);
  const first = firstPool.acquireLease({
    instanceId: instance.id, capability: 'read-only-investigation', mode: 'read',
    holderId: 'reader-a', runId: 'run-reader-a', ttlMs: 60_000,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(firstStore.get(first.lease.id)?.mode, 'read');
  firstStore.close();

  const reopenedStore = new SqliteLeaseStore({ filename });
  const reopenedPool = poolWith(reopenedStore);
  const second = reopenedPool.acquireLease({
    instanceId: instance.id, capability: 'read-only-investigation', mode: 'read',
    holderId: 'reader-b', runId: 'run-reader-b', ttlMs: 60_000,
  });
  assert.equal(second.ok, true, 'a stored read lease allows a second reader after reopening SQLite');
  assert.equal(reopenedStore.get(first.lease.id)?.mode, 'read');

  const legacyDb = new DatabaseSync(':memory:');
  legacyDb.exec(`
    CREATE TABLE environment_leases (
      id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, capability TEXT NOT NULL,
      holder_id TEXT NOT NULL, holder_kind TEXT, run_id TEXT, task_id TEXT,
      acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL
    );
    INSERT INTO environment_leases
      (id, instance_id, capability, holder_id, holder_kind, run_id, task_id, acquired_at, expires_at, state)
    VALUES ('legacy-writer', 'mode-test-instance', 'agent-run', 'legacy-holder', 'run', 'legacy-run', NULL, 1, 60000, 'active');
  `);
  const legacyStore = new SqliteLeaseStore({ db: legacyDb });
  assert.equal(legacyStore.get('legacy-writer')?.mode, 'read-write');
  const legacyPool = poolWith(legacyStore);
  const refusedReader = legacyPool.acquireLease({
    instanceId: instance.id, capability: 'read-only-investigation', mode: 'read',
    holderId: 'reader-c', runId: 'run-reader-c', ttlMs: 60_000,
  });
  assert.equal(refusedReader.ok, false);
  assert.equal(refusedReader.ok === false && refusedReader.reason, 'conflict');
  assert.deepEqual(refusedReader.ok === false && refusedReader.conflict, {
    kind: 'reader-blocked-by-writer',
    writer: { leaseId: 'legacy-writer', holderId: 'legacy-holder', state: 'active' },
  });

  reopenedStore.close();
  legacyStore.close();
  legacyDb.close();
});
