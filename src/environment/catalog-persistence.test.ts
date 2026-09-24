/**
 * E2 (#116) contract tests for the dynamic, instance-keyed Environment catalog.
 *
 * The catalog is the one projection from durable enrollment authority plus
 * observed readiness facts to the instances that may admit automatic Project/run
 * work. These tests cross that projection directly and through the
 * `EnvironmentPool` membership gate, so the pure rules and the pool's behaviour
 * are asserted at the same seam resolution and admission use.
 *
 * No personal, host, network, or credential details appear here. Instance ids
 * and addresses are documentation placeholders.
 */

import { test } from 'node:test';

import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';import { ADMISSION_CAPABILITY, EnvironmentCatalog, projectCatalogEntry, type EnvironmentCatalogInput } from './catalog.ts';

import {
  InMemoryEnvironmentCatalogStore,
  type EnvironmentCatalogStore,
} from './catalog-store.ts';

import { SqliteEnvironmentCatalogStore } from './sqlite-catalog-store.ts';

import { EnvironmentPool } from './pool.ts';

import { InMemoryLeaseStore } from './pool.ts';

import { createPendingEnrollment, type EnvironmentEnrollment } from './enrollment.ts';

import type { ConnectionFact, EngineReadinessFact, WorkSafetyState } from './readiness.ts';

import type { ObservedReadiness } from './readiness-store.ts';

import { SUPPORTED_WORKER_PROTOCOL } from './enrollment-service.ts';


const NOW = 1_700_000_000_000;


function enrollment(overrides: {
  readonly id?: string;
  readonly instanceId?: string;
  readonly status?: EnvironmentEnrollment['status'];
  readonly permissions?: Readonly<Record<string, boolean>>;
  readonly platform?: string;
} = {}): EnvironmentEnrollment {
  const requested = createPendingEnrollment({
    id: overrides.id ?? 'enroll-1',
    environmentInstanceId: overrides.instanceId ?? 'mac-enrolled-1',
    displayName: 'Enrolled Environment',
    identityDigest: 'identity-digest-1',
    platform: overrides.platform ?? 'macos',
    capabilityRequests: [ADMISSION_CAPABILITY],
    engineFacts: [],
    at: NOW,
  });
  return {
    ...requested,
    status: overrides.status ?? 'approved',
    everApproved: true,
    capabilityPermissions: overrides.permissions ?? { [ADMISSION_CAPABILITY]: true },
    updatedAt: NOW,
  };
}


function observed(overrides: {
  readonly connection?: ConnectionFact['state'];
  readonly compatibility?: ObservedReadiness['compatibility']['state'];
  readonly protocolVersion?: string;
  readonly engineReadiness?: 'ready' | 'unknown' | 'missing' | 'login-required';
  readonly models?: 'available' | 'unknown' | 'none';
  readonly enrollmentId?: string;
  readonly connectionEpoch?: number;
} = {}): ObservedReadiness {
  const engines: EngineReadinessFact[] = [
    {
      engine: 'codex',
      installed: true,
      readiness: overrides.engineReadiness ?? 'ready',
      required: false,
      models: { state: overrides.models ?? 'available', models: ['codex-model'] },
    },
  ];
  return {
    enrollmentId: overrides.enrollmentId ?? 'enroll-1',
    connectionEpoch: overrides.connectionEpoch ?? 1,
    connection: { state: overrides.connection ?? 'online', lastConfirmedAt: NOW },
    compatibility: {
      state: overrides.compatibility ?? 'compatible',
      workerProtocolVersion: overrides.protocolVersion ?? '2',
    },
    engines,
  };
}


function input(overrides: Partial<EnvironmentCatalogInput> & {
  readonly enrollment?: EnvironmentEnrollment;
} = {}): EnvironmentCatalogInput {
  const selectedEnrollment = overrides.enrollment ?? enrollment();
  return {
    enrollment: selectedEnrollment,
    currentEpoch: 'currentEpoch' in overrides ? overrides.currentEpoch : 1,
    observed: 'observed' in overrides
      ? overrides.observed
      : observed({ enrollmentId: selectedEnrollment.id }),
    workSafety: overrides.workSafety ?? ('clear' as WorkSafetyState),
    requiredEngines: overrides.requiredEngines ?? overrides.requirements?.requiredEngines ?? ['codex'],
    ...(overrides.requirements !== undefined ? { requirements: overrides.requirements } : {}),
    supportedProtocol: overrides.supportedProtocol ?? SUPPORTED_WORKER_PROTOCOL,
    now: overrides.now ?? NOW,
  };
}


async function assertCatalogStoreRetainsIndependently(store: EnvironmentCatalogStore): Promise<void> {
  const entry = projectCatalogEntry(input({ currentEpoch: undefined }));
  await store.save({
    instanceId: entry.instanceId,
    enrollmentId: entry.enrollmentId,
    definition: entry.definition,
    instance: entry.instance,
    updatedAt: NOW,
  });
  const record = await store.get('mac-enrolled-1');
  assert.equal(record?.enrollmentId, 'enroll-1');
  assert.equal(record?.definition.platform, 'macos');
  assert.deepEqual((await store.list()).map((row) => row.instanceId), ['mac-enrolled-1']);
}


test('the pool publishes exactly the eligible membership and preserves lease history', () => {
  const store = new InMemoryLeaseStore();
  const catalog = new EnvironmentCatalog();
  catalog.update([
    input({ enrollment: enrollment({ id: 'enroll-a', instanceId: 'host-a' }) }),
    input({
      enrollment: enrollment({ id: 'enroll-b', instanceId: 'host-b' }),
      observed: observed({ connection: 'offline' }),
      currentEpoch: undefined,
    }),
  ]);
  const pool = new EnvironmentPool({
    definitions: [],
    instances: [],
    store,
    idFactory: () => 'lease-1',
  });
  pool.synchronize({
    definitions: catalog.entries().map((entry) => entry.definition),
    instances: catalog.entries().map((entry) => entry.instance),
    eligibleInstanceIds: catalog.eligibleInstanceIds(),
  });

  assert.equal(pool.requiresLease('host-a', 'agent-run'), true);
  assert.equal(
    pool.requiresLease('host-b', 'agent-run'),
    undefined,
    'an offline instance cannot serve a capability for new work',
  );
  assert.ok(pool.instance('host-b') !== undefined, 'the offline instance stays inspectable');

  // Acquire a lease on the eligible instance, then make it ineligible. The lease
  // and its historical reference survive the membership change untouched.
  const acquired = pool.acquireLease({
    instanceId: 'host-a',
    capability: 'agent-run',
    holderId: 'scout',
    runId: 'run-1',
    ttlMs: 60_000,
  });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  catalog.setEpoch('enroll-a', undefined);
  pool.synchronize({
    definitions: catalog.entries().map((entry) => entry.definition),
    instances: catalog.entries().map((entry) => entry.instance),
    eligibleInstanceIds: catalog.eligibleInstanceIds(),
  });
  assert.equal(pool.requiresLease('host-a', 'agent-run'), undefined, 'now ineligible');
  assert.equal(pool.getLease(acquired.lease.id)?.state, 'active', 'lease invariant preserved');
  assert.equal(pool.activeLease('host-a')?.id, acquired.lease.id);
  assert.ok(pool.instance('host-a') !== undefined, 'ineligible instance still resolvable for history');
});


test('the durable catalog store retains entries independently of connectivity', async () => {
  await assertCatalogStoreRetainsIndependently(new InMemoryEnvironmentCatalogStore());
});


test('the SQLite catalog record survives reopen with no live connection', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'sprout.db');
  const writer = new SqliteEnvironmentCatalogStore({ filename });
  await assertCatalogStoreRetainsIndependently(writer);
  writer.close();

  // Reopen as a fresh process would: the entry, its definition, and its instance
  // are a durable catalog fact even though no Worker ever connected.
  const reader = new SqliteEnvironmentCatalogStore({ filename });
  const record = await reader.get('mac-enrolled-1');
  assert.equal(record?.enrollmentId, 'enroll-1');
  assert.deepEqual(record?.instance, {
    id: 'mac-enrolled-1',
    definitionId: 'enrolled-macos',
  });
  reader.close();
});


test('catalog stores persist only portable facts and sanitize historical records', async (t) => {
  const unsafe = {
    instanceId: 'portable-instance',
    enrollmentId: 'portable-enrollment',
    definition: {
      id: 'portable-definition',
      platform: 'macos',
      capabilities: [{ name: 'agent-run', requiresLease: true }],
      host: 'internal-host.example',
      diagnostic: 'raw stderr token=synthetic-secret',
    },
    instance: {
      id: 'portable-instance',
      definitionId: 'portable-definition',
      workingDirectory: '/host-data/private-workspace',
      privateKey: 'synthetic-private-key',
      browserSecret: 'synthetic-browser-secret',
      engineCredential: 'synthetic-engine-credential',
      address: '198.51.100.9',
    },
    updatedAt: NOW,
  } as unknown as import('./catalog-store.ts').EnvironmentCatalogRecord;

  const memory = new InMemoryEnvironmentCatalogStore();
  await memory.save(unsafe);
  const memorySerialized = JSON.stringify(await memory.get('portable-instance'));
  for (const forbidden of ['workingDirectory', 'privateKey', 'browserSecret', 'engineCredential', '198.51', 'synthetic-secret']) {
    assert.equal(memorySerialized.includes(forbidden), false, `memory excludes ${forbidden}`);
  }

  const directory = mkdtempSync(join(tmpdir(), 'sprout-catalog-privacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'sprout.db');
  // Seed a v11 row as an earlier E2 build could have persisted it, then let the
  // v11->v12 durable-store migration erase unapproved historical fields.
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    PRAGMA user_version = 11;
    CREATE TABLE environment_catalog (
      instance_id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL,
      document TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  legacy.prepare('INSERT INTO environment_catalog VALUES (?, ?, ?, ?)').run(
    unsafe.instanceId,
    unsafe.enrollmentId,
    JSON.stringify({ definition: unsafe.definition, instance: unsafe.instance }),
    unsafe.updatedAt,
  );
  legacy.close();

  const store = new SqliteEnvironmentCatalogStore({ filename });
  const record = await store.get('portable-instance');
  assert.equal(record?.instance.workingDirectory, undefined);
  store.close();
  const reopened = new DatabaseSync(filename);
  const row = reopened.prepare('SELECT document FROM environment_catalog WHERE instance_id = ?')
    .get('portable-instance') as { readonly document: string };
  reopened.close();
  for (const forbidden of ['workingDirectory', 'privateKey', 'browserSecret', 'engineCredential', '198.51', 'synthetic-secret']) {
    assert.equal(row.document.includes(forbidden), false, `historical SQLite row excludes ${forbidden}`);
  }
});


test('historical privacy migration preserves colliding unsafe identities across reopen and rerun', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-catalog-collision-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'sprout.db');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    PRAGMA user_version = 11;
    CREATE TABLE environment_catalog (
      instance_id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL,
      document TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const insert = legacy.prepare('INSERT INTO environment_catalog VALUES (?, ?, ?, ?)');
  for (const [index, instanceId] of ['/private/legacy/host-a', '/private/legacy/host-b'].entries()) {
    insert.run(
      instanceId,
      `/private/legacy/enrollment-${index}`,
      JSON.stringify({
        definition: {
          id: `/private/legacy/definition-${index}`,
          platform: 'macos',
          capabilities: [{ name: 'agent-run', requiresLease: true }],
        },
        instance: {
          id: instanceId,
          definitionId: `/private/legacy/definition-${index}`,
          workingDirectory: `/private/legacy/work-${index}`,
        },
      }),
      NOW + index,
    );
  }
  legacy.close();

  const first = new SqliteEnvironmentCatalogStore({ filename });
  const once = await first.list();
  first.close();
  assert.equal(once.length, 2, 'no historical record is collapsed');
  assert.equal(new Set(once.map((record) => record.instanceId)).size, 2);
  assert.equal(new Set(once.map((record) => record.enrollmentId)).size, 2);
  const serialized = JSON.stringify(once);
  assert.equal(serialized.includes('/private/legacy'), false, 'no historical private path survives');

  // Reopen proves the migrated rows are durable. Re-running the migration from
  // its input version proves sanitization is deterministic and idempotent.
  const reopened = new SqliteEnvironmentCatalogStore({ filename });
  assert.deepEqual(await reopened.list(), once);
  reopened.close();
  const rewind = new DatabaseSync(filename);
  rewind.exec('PRAGMA user_version = 11;');
  rewind.close();
  const rerun = new SqliteEnvironmentCatalogStore({ filename });
  assert.deepEqual(await rerun.list(), once);
  rerun.close();
});
