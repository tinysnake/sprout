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

import {
  ADMISSION_CAPABILITY,
  EnvironmentCatalog,
  admissionRefusal,
  projectCatalogEntry,
  selectInstanceEnrollment,
  type EnvironmentCatalogInput,
} from './catalog.ts';
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
  return {
    enrollment: overrides.enrollment ?? enrollment(),
    currentEpoch: 'currentEpoch' in overrides ? overrides.currentEpoch : 1,
    observed: 'observed' in overrides ? overrides.observed : observed(),
    workSafety: overrides.workSafety ?? ('clear' as WorkSafetyState),
    requiredEngines: overrides.requiredEngines ?? ['codex'],
    supportedProtocol: overrides.supportedProtocol ?? SUPPORTED_WORKER_PROTOCOL,
    now: overrides.now ?? NOW,
  };
}

test('an approved, current-epoch, compatible, permission-satisfied, ready instance is eligible', () => {
  const entry = projectCatalogEntry(input());
  assert.equal(entry.eligible, true);
  assert.equal(entry.instanceId, 'mac-enrolled-1');
  assert.equal(entry.definition.platform, 'macos');
  assert.deepEqual(admissionRefusal(entry), {
    ok: true,
    instanceId: 'mac-enrolled-1',
    enrollmentId: 'enroll-1',
  });
});

test('every ineligible fact keeps the instance in the catalog but blocks admission', () => {
  const cases: readonly {
    readonly name: string;
    readonly overrides: Parameters<typeof input>[0];
    readonly reason: string;
  }[] = [
    { name: 'pending', overrides: { enrollment: enrollment({ status: 'pending' }) }, reason: 'not-approved' },
    { name: 'revoked', overrides: { enrollment: enrollment({ status: 'revoked' }) }, reason: 'revoked' },
    { name: 'archived', overrides: { enrollment: enrollment({ status: 'archived' }) }, reason: 'archived' },
    {
      name: 'permission-incomplete',
      overrides: { enrollment: enrollment({ permissions: { [ADMISSION_CAPABILITY]: false } }) },
      reason: 'permission-incomplete',
    },
    { name: 'not-current-epoch', overrides: { currentEpoch: undefined }, reason: 'not-current-epoch' },
    { name: 'offline', overrides: { observed: observed({ connection: 'offline' }) }, reason: 'readiness-unknown' },
    {
      name: 'incompatible',
      overrides: { observed: observed({ compatibility: 'incompatible', protocolVersion: '1' }) },
      reason: 'readiness-unknown',
    },
    {
      name: 'readiness-unknown',
      overrides: { observed: observed({ engineReadiness: 'unknown' }) },
      reason: 'readiness-unknown',
    },
    { name: 'recovery', overrides: { workSafety: 'recovery' }, reason: 'work-unsafe' },
    { name: 'reconciling', overrides: { workSafety: 'reconciling' }, reason: 'work-unsafe' },
  ];

  for (const testCase of cases) {
    const entry = projectCatalogEntry(input(testCase.overrides));
    assert.equal(entry.instanceId, 'mac-enrolled-1', `${testCase.name}: instance remains inspectable`);
    assert.equal(entry.eligible, false, `${testCase.name}: must not admit work`);
    const refusal = admissionRefusal(entry);
    assert.equal(refusal.ok, false, `${testCase.name}: refusal`);
    if (!refusal.ok) assert.equal(refusal.reason, testCase.reason, testCase.name);
  }
});

test('a held lease does not block admission; only recovery or reconciling does', () => {
  for (const workSafety of ['clear', 'held'] as const) {
    assert.equal(projectCatalogEntry(input({ workSafety })).eligible, true, workSafety);
  }
});

test('an unknown instance has no catalog entry and resolves a typed refusal', () => {
  const catalog = new EnvironmentCatalog();
  catalog.update([input()]);
  const refusal = catalog.admission('not-enrolled');
  assert.equal(refusal.ok, false);
  if (!refusal.ok) assert.equal(refusal.reason, 'unknown-instance');
});

test('the catalog is keyed by instance id and updates dynamically', () => {
  const catalog = new EnvironmentCatalog();
  catalog.update([input()]);
  assert.deepEqual(catalog.instanceIds(), ['mac-enrolled-1']);
  assert.deepEqual(catalog.eligibleInstanceIds(), ['mac-enrolled-1']);

  // An epoch loss (channel closed) is a fact change on the same catalog entry.
  catalog.setEpoch('enroll-1', undefined);
  assert.deepEqual(catalog.instanceIds(), ['mac-enrolled-1'], 'offline never deletes the entry');
  assert.deepEqual(catalog.eligibleInstanceIds(), []);

  // A newer epoch restores eligibility without a process restart.
  catalog.setEpoch('enroll-1', 2);
  assert.deepEqual(catalog.eligibleInstanceIds(), ['mac-enrolled-1']);
  assert.equal(catalog.entry('mac-enrolled-1')?.currentEpoch, 2);
});

test('multi-instance catalog keeps every instance independent', () => {
  const catalog = new EnvironmentCatalog();
  catalog.update([
    input({ enrollment: enrollment({ id: 'enroll-a', instanceId: 'host-a' }) }),
    input({
      enrollment: enrollment({ id: 'enroll-b', instanceId: 'host-b', status: 'pending' }),
      observed: undefined,
      currentEpoch: undefined,
    }),
  ]);
  assert.deepEqual([...catalog.instanceIds()].sort(), ['host-a', 'host-b']);
  assert.deepEqual(catalog.eligibleInstanceIds(), ['host-a']);
});

test('an eligible enrollment is preferred over a superseded sibling for one instance id', () => {
  const pending = enrollment({ id: 'enroll-old', instanceId: 'host-a', status: 'pending' });
  const approved = enrollment({ id: 'enroll-new', instanceId: 'host-a' });
  const catalog = new EnvironmentCatalog();
  catalog.update([
    input({ enrollment: pending, observed: undefined, currentEpoch: undefined }),
    input({ enrollment: approved, currentEpoch: 3 }),
  ]);
  const entry = catalog.entry('host-a');
  assert.equal(entry?.enrollmentId, 'enroll-new');
  assert.equal(entry?.eligible, true);
});

test('selectInstanceEnrollment prefers an approved record over pending or revoked siblings', () => {
  const revoked = enrollment({ id: 'r', instanceId: 'host', status: 'revoked' });
  const pending = enrollment({ id: 'p', instanceId: 'host', status: 'pending' });
  const approved = enrollment({ id: 'a', instanceId: 'host' });
  assert.equal(selectInstanceEnrollment([revoked, pending, approved])?.id, 'a');
  assert.equal(selectInstanceEnrollment([]), undefined);
});

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
