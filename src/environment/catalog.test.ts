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
import { DatabaseSync } from 'node:sqlite';

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
import { readinessRequirements } from './readiness.ts';

const NOW = 1_700_000_000_000;

test('#128: Pi-only and multi-engine targets bind applicable measured evidence, not aggregate availability', () => {
  const pi = readinessRequirements([{ engine: 'pi', workModel: 'pi-model' }]);
  assert.deepEqual(pi.modelsByEngine, { pi: ['pi-model'] });
  const both = readinessRequirements([{ engine: 'codex', workModel: 'codex-model' }, { engine: 'pi', workModel: 'pi-model' }]);
  const base = observed();
  const evidence = (scope: typeof both, engines: ObservedReadiness['engines']) => input({
    requirements: scope,
    observed: { ...base, requirements: scope, engines },
  });
  const codex = { ...base.engines[0]!, modelIdPresent: true, targetModels: ['codex-model'], requirementRevision: both.revisionsByEngine!.codex! };
  const piEngine = { ...codex, engine: 'pi', models: { state: 'available' as const, models: ['pi-model'] }, targetModels: ['pi-model'], requirementRevision: both.revisionsByEngine!.pi! };
  assert.equal(projectCatalogEntry(evidence(both, [codex])).eligible, false, 'missing applicable engine blocks');
  assert.equal(projectCatalogEntry(evidence(both, [codex, { ...piEngine, targetModels: [] }])).eligible, false, 'Pi auth alone cannot prove a local model');
  assert.equal(projectCatalogEntry(evidence(both, [codex, piEngine])).eligible, true);
  const piChanged = readinessRequirements([{ engine: 'codex', workModel: 'codex-model' }, { engine: 'pi', workModel: 'new-pi-model' }]);
  assert.equal(projectCatalogEntry({ ...evidence(both, [codex, piEngine]), requirements: piChanged }).eligible, false,
    'the changed Pi target remains blocking');
  assert.equal(piChanged.revisionsByEngine?.codex, both.revisionsByEngine?.codex,
    'independent Codex proof survives a Pi target edit');
  assert.equal(projectCatalogEntry(evidence(both, [{ ...codex, targetModels: [] }, piEngine])).eligible, false, 'aggregate available cannot bypass target proof');
  const changed = readinessRequirements([{ engine: 'codex', workModel: 'codex-model' }, { engine: 'pi', workModel: 'pi-model' }], [{ id: 'agent', configurationVersion: 2 }]);
  assert.equal(projectCatalogEntry({ ...evidence(both, [codex, piEngine]), requirements: changed }).eligible, false, 'same targets with a new revision invalidate');
  const unrelated = readinessRequirements([{ engine: 'codex', workModel: 'codex-model' }, { engine: 'pi', workModel: 'pi-model' }]);
  assert.equal(unrelated.revision, both.revision);
  assert.equal(projectCatalogEntry(evidence(pi, [{ ...piEngine, requirementRevision: pi.revisionsByEngine!.pi! }])).eligible, true);
});

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
    requiredEngines: overrides.requiredEngines ?? ['codex'],
    ...(overrides.requirements !== undefined ? { requirements: overrides.requirements } : {}),
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

  // A new epoch is not allowed to reuse facts from the disconnected epoch.
  catalog.setEpoch('enroll-1', 2);
  assert.deepEqual(catalog.eligibleInstanceIds(), []);
  assert.equal(catalog.entry('mac-enrolled-1')?.currentEpoch, 2);
});

test('readiness is authoritative only for its current Worker connection epoch', () => {
  const catalog = new EnvironmentCatalog();
  catalog.update([input({ currentEpoch: 1, observed: observed({ connectionEpoch: 1 }) })]);
  assert.equal(catalog.entry('mac-enrolled-1')?.eligible, true, 'epoch one facts admit epoch one only');

  // Disconnect/reconnect and a duplicate/replacement both produce a newer
  // authority epoch. Neither may inherit the prior connection's ready facts.
  catalog.setEpoch('enroll-1', undefined);
  assert.equal(catalog.entry('mac-enrolled-1')?.eligible, false);
  catalog.setEpoch('enroll-1', 2);
  assert.equal(catalog.entry('mac-enrolled-1')?.eligible, false, 'reconnect needs new facts');

  // A late old observation stays explicitly non-authoritative for epoch two.
  catalog.update([input({ currentEpoch: 2, observed: observed({ connectionEpoch: 1 }) })]);
  const stale = catalog.entry('mac-enrolled-1')!;
  assert.equal(stale.eligible, false);
  const refusal = admissionRefusal(stale);
  assert.equal(refusal.ok, false);
  if (!refusal.ok) assert.equal(refusal.reason, 'not-current-epoch');

  catalog.update([input({ currentEpoch: 2, observed: observed({ connectionEpoch: 2 }) })]);
  assert.equal(catalog.entry('mac-enrolled-1')?.eligible, true, 'only fresh epoch two facts restore admission');

  // A delayed transport-close event for epoch one must not fence the already
  // current replacement. Close fencing is conditional on the exact generation.
  assert.equal(catalog.clearEpoch('enroll-1', 1), false);
  assert.equal(catalog.entry('mac-enrolled-1')?.eligible, true);
  assert.equal(catalog.clearEpoch('enroll-1', 2), true);
  assert.equal(catalog.entry('mac-enrolled-1')?.eligible, false);
});

test('a newly accepted enrollment synchronously discards same-instance facts from a prior enrollment', () => {
  const first = enrollment({ id: 'enroll-first', instanceId: 'shared-instance' });
  const replacement = enrollment({ id: 'enroll-replacement', instanceId: 'shared-instance' });
  const catalog = new EnvironmentCatalog();
  catalog.update([
    input({
      enrollment: first,
      currentEpoch: 1,
      observed: observed({ enrollmentId: first.id, connectionEpoch: 1 }),
    }),
  ]);
  assert.equal(catalog.entry('shared-instance')?.eligible, true);

  // This models a legacy sibling arriving between refreshes. Its new
  // per-enrollment epoch is also numerically one, but setEpoch must first
  // erase the prior observed facts before it publishes any membership.
  catalog.update([
    input({
      enrollment: replacement,
      currentEpoch: undefined,
      observed: observed({ enrollmentId: first.id, connectionEpoch: 1 }),
    }),
  ]);
  catalog.setEpoch(replacement.id, 1);
  assert.equal(catalog.entry('shared-instance')?.eligible, false);
  assert.equal(catalog.entry('shared-instance')?.observed, undefined);

  // A store refresh cannot re-authorize the old enrollment just because its
  // numeric epoch equals the replacement's first epoch.
  catalog.update([
    input({
      enrollment: replacement,
      currentEpoch: 1,
      observed: observed({ enrollmentId: first.id, connectionEpoch: 1 }),
    }),
  ]);
  assert.equal(catalog.entry('shared-instance')?.eligible, false);

  catalog.update([
    input({
      enrollment: replacement,
      currentEpoch: 1,
      observed: observed({ enrollmentId: replacement.id, connectionEpoch: 1 }),
    }),
  ]);
  assert.equal(catalog.entry('shared-instance')?.eligible, true);
});

test('an unknown Worker platform remains explicit and cannot admit or resolve as macOS', () => {
  const known = enrollment();
  const entry = projectCatalogEntry(input({
    enrollment: { ...known, worker: { ...known.worker, platform: 'future-os' } },
  }));
  assert.equal(entry.definition.platform, 'unknown');
  assert.equal(entry.instance.definitionId, 'enrolled-unknown');
  assert.equal(entry.eligible, false);
  const refusal = admissionRefusal(entry);
  assert.equal(refusal.ok, false);
  if (!refusal.ok) assert.equal(refusal.reason, 'unsupported-platform');

  const pool = new EnvironmentPool({
    definitions: [entry.definition],
    instances: [entry.instance],
    eligibleInstanceIds: [],
  });
  assert.equal(pool.requiresLease(entry.instanceId, ADMISSION_CAPABILITY), undefined);
  assert.equal(pool.instance(entry.instanceId)?.definitionId, 'enrolled-unknown');
});

test('an unknown platform survives durable catalog reopen as an ineligible fact', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-catalog-unknown-platform-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'sprout.db');
  const known = enrollment();
  const entry = projectCatalogEntry(input({
    enrollment: { ...known, worker: { ...known.worker, platform: 'unsupported-platform' } },
  }));
  const writer = new SqliteEnvironmentCatalogStore({ filename });
  await writer.save({
    instanceId: entry.instanceId,
    enrollmentId: entry.enrollmentId,
    definition: entry.definition,
    instance: entry.instance,
    updatedAt: NOW,
  });
  writer.close();

  const reader = new SqliteEnvironmentCatalogStore({ filename });
  const record = await reader.get(entry.instanceId);
  reader.close();
  assert.equal(record?.definition.platform, 'unknown');
  assert.equal(record?.instance.definitionId, 'enrolled-unknown');
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
    input({
      enrollment: approved,
      currentEpoch: 3,
      observed: observed({ enrollmentId: 'enroll-new', connectionEpoch: 3 }),
    }),
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
