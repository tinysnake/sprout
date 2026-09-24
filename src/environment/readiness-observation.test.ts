import assert from 'node:assert/strict';

import { test } from 'node:test';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { createReadinessObservation, readReadinessObservation } from './readiness-observation.ts';

import { InMemoryEnvironmentReadinessStore, type EnvironmentReadinessStore } from './readiness-store.ts';

import { SqliteEnvironmentReadinessStore } from './sqlite-readiness-store.ts';

import { workerReadinessProbeFixture } from '../worker/readiness-fixture.ts';

import { createReadinessAuthorityTestSeam } from './readiness-authority.test-support.ts';

import { readinessRequirements } from './readiness.ts';

import { projectCatalogEntry } from './catalog.ts';

import { createPendingEnrollment } from './enrollment.ts';


const readinessAuthorityTestSeam = createReadinessAuthorityTestSeam();

/** Private adapter fixtures reserve the same durable scope that a workflow would issue. */
async function issued(store: EnvironmentReadinessStore, result: unknown,
  scope: Parameters<typeof createReadinessObservation>[1]) {
  const attempt = await store.issueAttempt(scope.environmentInstanceId, scope.authority, false,
    scope.requirements?.requiredModels ?? [], scope.requirements);
  assert.ok(attempt);
  return createReadinessObservation(result, { ...scope, attempt });
}


for (const backend of ['memory', 'sqlite'] as const) {
  test(`#128 ${backend}: committed old aggregate and new revision-bound target evidence remain distinct`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-scope-'));
    const store = backend === 'memory' ? new InMemoryEnvironmentReadinessStore() :
      new SqliteEnvironmentReadinessStore({ filename: join(directory, 'readiness.db') });
    t.after(() => { if (store instanceof SqliteEnvironmentReadinessStore) store.close(); rmSync(directory, { recursive: true, force: true }); });
    const authority = readinessAuthorityTestSeam.mint({ environmentInstanceId: 'env-1', enrollmentId: 'enroll-1', connectionEpoch: 7 });
    const requirements = readinessRequirements([{ engine: 'codex', workModel: 'target' }]);
    const enrollment = { ...createPendingEnrollment({ id: 'enroll-1', environmentInstanceId: 'env-1', displayName: 'Host',
      identityDigest: 'digest', platform: 'macos', capabilityRequests: ['agent-run'], engineFacts: [], at: 1 }),
      status: 'approved' as const, everApproved: true, capabilityPermissions: { 'agent-run': true } };
    const probe = { at: 100, latencyMs: 1, protocolOk: true, enginesOk: true, source: 'worker' as const, version: '2', summary: 'ready' };
    const engine = { engine: 'codex', installed: true, readiness: 'ready' as const, modelAvailability: 'available' as const,
      models: ['target'], authenticated: true };
    const scope = { environmentInstanceId: 'env-1', authority, supported: { minMajor: 2, maxMajor: 3 }, at: 100,
      verifyAuthority: readinessAuthorityTestSeam.verify, requirements };
    const project = async (current = requirements) => projectCatalogEntry({ enrollment, observed: await store.getReadiness('env-1'),
      workSafety: 'clear', currentEpoch: 7, requiredEngines: ['codex'], requirements: current,
      supportedProtocol: scope.supported, now: 100 });
    const old = await issued(store, { readiness: { protocolVersion: '2', engines: [engine], probe }, probe }, scope);
    assert.ok(old);
    assert.ok(await store.commitObservation('env-1', old, authority));
    assert.equal((await project()).eligible, false, 'old aggregate available lacks measured targets');
    const fresh = await issued(store, { protocolVersion: '3', engines: [{ ...engine, modelIdPresent: true,
      targetModels: ['target'], requirementRevision: requirements.revisionsByEngine!.codex }], probe }, scope);
    assert.ok(fresh);
    assert.ok(await store.commitObservation('env-1', fresh, authority));
    assert.equal((await project()).eligible, true);
    const changed = readinessRequirements([{ engine: 'codex', workModel: 'target' }], [{ id: 'agent', configurationVersion: 2 }]);
    assert.equal((await project(changed)).eligible, false, 'same target under a new revision requires fresh evidence');
    const missing = await issued(store, { protocolVersion: '3', engines: [{ ...engine, modelIdPresent: true,
      targetModels: ['target'] }], probe }, { ...scope, requirements: changed });
    assert.ok(missing);
    assert.ok(await store.commitObservation('env-1', missing, authority));
    assert.equal((await project(changed)).eligible, false, 'missing Worker revision cannot satisfy core scope');
  });
  test(`${backend} mutation accepts only scoped opaque canonical observations (R118-API-002)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-opaque-readiness-'));
    const store = backend === 'memory'
      ? new InMemoryEnvironmentReadinessStore()
      : new SqliteEnvironmentReadinessStore({ filename: join(directory, 'readiness.db') });
    t.after(() => {
      if (store instanceof SqliteEnvironmentReadinessStore) store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    let current = true;
    const authority = readinessAuthorityTestSeam.mint({
      environmentInstanceId: 'env-1',
      enrollmentId: 'enroll-1',
      connectionEpoch: 7,
      isCurrent: () => current,
    });
    const result = workerReadinessProbeFixture({
      protocolVersion: '2', observedAt: 1_234,
      engines: [{ engine: 'pi', installed: true, readiness: 'unknown', modelAvailability: 'unknown', models: [] }],
    });
    const scope = { environmentInstanceId: 'env-1', authority, supported: { minMajor: 2, maxMajor: 2 }, at: 1_234, verifyAuthority: readinessAuthorityTestSeam.verify };
    const { probe: _probe, ...missingEmbedded } = result.readiness;
    for (const invalid of [
      undefined, { readiness: result.readiness }, { ...result, probe: undefined },
      { ...result, readiness: missingEmbedded },
      { ...result, probe: { ...result.probe, at: -1 } },
      { ...result, probe: { ...result.probe, at: 9_999 } },
      { readiness: { ...result.readiness, probe: { ...result.probe, source: 'unknown' } },
        probe: { ...result.probe, source: 'unknown' } },
    ]) {
      assert.equal(createReadinessObservation(invalid, scope), undefined, 'the only constructor validates complete pairs');
    }
    const requirements = { requiredModels: ['safe-model'] };
    const attempt = await store.issueAttempt('env-1', authority, false, requirements.requiredModels, requirements);
    assert.ok(attempt);
    const observation = createReadinessObservation(result, { ...scope, attempt, observationId: '../unsafe/path', requirements } as typeof scope & { observationId: string; requirements: typeof requirements });
    assert.ok(observation);
    requirements.requiredModels[0] = 'changed';
    assert.notEqual(readReadinessObservation('env-1', observation, authority)?.observationId, '../unsafe/path');
    assert.deepEqual(readReadinessObservation('env-1', observation, authority)?.requirements?.requiredModels, ['safe-model']);
    assert.equal(Reflect.set(observation, 'probe', undefined), false, 'the opaque handle is immutable');
    const pair = readReadinessObservation('env-1', observation, authority);
    assert.ok(pair);
    const raw = { readiness: pair.readiness };
    for (const forged of [
      undefined, null, {}, raw, { ...raw, probe: undefined },
      { ...raw, probe: {} }, { ...raw, probe: { ...pair.probe, source: 'unknown' } },
      { ...raw, probe: { ...pair.probe, source: undefined } },
      pair, result, { ...observation }, structuredClone(observation), Object.create(observation),
    ]) {
      assert.equal(await store.commitObservation('env-1', forged as never, authority), false);
      assert.equal(await store.getReadiness('env-1'), undefined);
      assert.deepEqual(await store.listProbes('env-1'), []);
    }
    assert.equal(await store.commitObservation('env-other', observation, authority), false);
    assert.equal(await store.commitObservation('env-1', observation, { ...authority, connectionEpoch: 8 } as never), false);
    assert.equal(await store.commitObservation('env-1', observation, { ...authority, enrollmentId: 'enroll-other' } as never), false);
    assert.equal(await store.commitObservation('env-1', observation, readinessAuthorityTestSeam.mint({ environmentInstanceId: 'env-1', enrollmentId: 'enroll-1', connectionEpoch: 8 })), false);
    assert.equal(await store.commitObservation('env-1', observation, readinessAuthorityTestSeam.mint({ environmentInstanceId: 'env-1', enrollmentId: 'enroll-other', connectionEpoch: 7 })), false);
    assert.equal(await store.commitObservation('env-1', observation, readinessAuthorityTestSeam.mint({ environmentInstanceId: 'env-other', enrollmentId: 'enroll-1', connectionEpoch: 7 })), false);
    assert.equal(await store.commitObservation('env-1', observation, { enrollmentId: 'enroll-1', connectionEpoch: 7, isCurrent: () => true } as never), false, 'caller-assembled authority is refused');
    assert.equal(await store.commitObservation('env-1', observation, { ...authority } as never), false, 'copied authority is refused');
    assert.equal(await store.getReadiness('env-other'), undefined);
    assert.deepEqual(await store.listProbes('env-other'), []);

    // Neither changing the original input nor changing a read of the opaque
    // payload can change the validated snapshot held behind that handle.
    Reflect.set(result.readiness.engines[0]!, 'modelAvailability', 'available');
    Reflect.set(result.probe, 'source', 'unknown');
    Reflect.set(pair.readiness.engines[0]!.models, 'state', 'available');
    Reflect.set(pair.probe, 'source', 'unknown');
    current = false;
    assert.equal(await store.commitObservation('env-1', observation, authority), false);
    assert.equal(await store.commitObservation('env-1', observation, { ...authority, isCurrent: () => true } as never), false, 'a replacement callback cannot bypass the original guard');
    assert.equal(await store.getReadiness('env-1'), undefined);
    assert.deepEqual(await store.listProbes('env-1'), []);
    current = true;
    const receipt = await store.commitObservation('env-1', observation, authority);
    assert.ok(receipt);
    assert.equal(typeof receipt, 'object');
    assert.equal(receipt.environmentInstanceId, 'env-1');
    assert.equal(receipt.connectionEpoch, 7);
    assert.ok(receipt.observationId.startsWith('obs-'));
    const before = await store.getCurrentObservation('env-1');
    const beforeHistory = await store.listObservations('env-1');
    const beforeProbes = await store.listProbes('env-1');
    const canonicalResult = workerReadinessProbeFixture({
      protocolVersion: '2', observedAt: 1_234,
      engines: [{ engine: 'pi', installed: true, readiness: 'unknown', modelAvailability: 'unknown', models: [] }],
    });
    const malformedScopes: unknown[] = [null, [], 1, 'bad', true, { unknown: true },
      { revision: '' }, { revision: 4 }, { revision: 'bad/revision' },
      { requiredModels: null }, { requiredModels: 'model' }, { requiredModels: [1] },
      { requiredModels: ['bad/model'] }, { requiredModels: [, 'model'] },
      { requiredEngines: [null] }, { requiredEngines: {} },
      { requiredModels: ['model'], extra: true },
    ];
    for (const malformed of malformedScopes) {
      const refused = createReadinessObservation(canonicalResult, { ...scope, requirements: malformed } as never);
      assert.equal(refused, undefined, `malformed requirement scope refused: ${String(malformed)}`);
      assert.equal(await store.commitObservation('env-1', refused as never, authority), false);
      assert.deepEqual(await store.getCurrentObservation('env-1'), before);
      assert.deepEqual(await store.listObservations('env-1'), beforeHistory);
      assert.deepEqual(await store.listProbes('env-1'), beforeProbes);
    }
    const canonical = createReadinessObservation(canonicalResult, { ...scope, requirements: {
      revision: 'r_1', requiredEngines: ['pi'], requiredModels: ['safe-model'],
    } });
    assert.ok(canonical);
    assert.deepEqual(readReadinessObservation('env-1', canonical, authority)?.requirements,
      { revision: 'r_1', requiredEngines: ['pi'], requiredModels: ['safe-model'] });
    const stored = await store.getReadiness('env-1');
    const history = await store.listProbes('env-1');
    assert.equal(stored?.engines[0]?.models.state, 'unknown');
    assert.equal(stored?.connectionEpoch, 7);
    assert.deepEqual(history, [{
      enrollmentId: 'enroll-1', connectionEpoch: 7, at: 1_234, latencyMs: 5,
      protocolOk: true, enginesOk: true, source: 'worker', version: 'unknown-version',
      summary: 'Synthetic Worker readiness probe.',
    }]);
    assert.equal(await store.commitObservation('env-1', raw as never, authority), false);
    assert.deepEqual(await store.getReadiness('env-1'), stored, 'refused writes cannot overwrite existing readiness');
    assert.deepEqual(await store.listProbes('env-1'), history, 'refused writes cannot append history');
  });

  test(`${backend} atomic failure and coherent reads across sequential observations (Scenario 8, #126)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-obs-coherent-'));
    const store = backend === 'memory'
      ? new InMemoryEnvironmentReadinessStore()
      : new SqliteEnvironmentReadinessStore({ filename: join(directory, 'readiness.db') });
    t.after(() => {
      if (store instanceof SqliteEnvironmentReadinessStore) store.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const authority = readinessAuthorityTestSeam.mint({
      environmentInstanceId: 'env-1',
      enrollmentId: 'enroll-1',
      connectionEpoch: 1,
      isCurrent: () => true,
    });
    const scope = {
      environmentInstanceId: 'env-1',
      authority,
      supported: { minMajor: 2, maxMajor: 2 },
      at: 1_000,
      verifyAuthority: readinessAuthorityTestSeam.verify,
    };

    // 1. Missing / invalid observation produces atomic failure: no partial writes
    const invalidResult = { readiness: { engines: [] }, probe: undefined };
    const invalidObs = createReadinessObservation(invalidResult, scope);
    assert.equal(invalidObs, undefined);
    assert.equal(await store.getCurrentObservation('env-1'), undefined);
    assert.equal(await store.getReadiness('env-1'), undefined);
    assert.deepEqual(await store.listProbes('env-1'), []);

    // 2. First valid observation commits atomically
    const result1 = workerReadinessProbeFixture({
      protocolVersion: '2',
      observedAt: 1_000,
      engines: [{ engine: 'pi', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['model-a'] }],
    });
    const obs1 = await issued(store, result1, scope);
    assert.ok(obs1);
    const receipt1 = await store.commitObservation('env-1', obs1, authority);
    assert.ok(receipt1);
    assert.equal(receipt1.sequence, 1);

    const current1 = await store.getCurrentObservation('env-1');
    assert.ok(current1);
    assert.equal(current1.observationId, receipt1.observationId);
    assert.equal(current1.readiness.observationId, receipt1.observationId);
    assert.equal(current1.probe.at, receipt1.probe.at);
    assert.equal(current1.sequence, 1);

    // 3. Second valid observation commits atomically and advances current observation reference
    const result2 = workerReadinessProbeFixture({
      protocolVersion: '2',
      observedAt: 2_000,
      engines: [{ engine: 'pi', installed: true, readiness: 'login-required', modelAvailability: 'unknown', models: [] }],
    });
    const obs2 = await issued(store, result2, { ...scope, at: 2_000 });
    assert.ok(obs2);
    const receipt2 = await store.commitObservation('env-1', obs2, authority);
    assert.ok(receipt2);
    assert.equal(receipt2.sequence, 2);
    assert.notEqual(receipt2.observationId, receipt1.observationId);

    // Current observation is observation 2; facts and probe are coherent from observation 2
    const current2 = await store.getCurrentObservation('env-1');
    assert.ok(current2);
    assert.equal(current2.observationId, receipt2.observationId);
    assert.equal(current2.readiness.observationId, receipt2.observationId);
    assert.equal(current2.readiness.engines[0]?.readiness, 'login-required');
    assert.equal(current2.probe.at, result2.probe.at);
    assert.equal(current2.sequence, 2);

    // History preserves both observations in persisted order
    const history = await store.listProbes('env-1');
    assert.equal(history.length, 2);
    assert.equal(history[0]?.at, result1.probe.at);
    assert.equal(history[1]?.at, result2.probe.at);

    // Direct observation retrieval finds each observation by its identity
    const direct1 = await store.getObservation('env-1', receipt1.observationId);
    assert.ok(direct1);
    assert.equal(direct1.observationId, receipt1.observationId);
    assert.equal(direct1.sequence, 1);

    const direct2 = await store.getObservation('env-1', receipt2.observationId);
    assert.ok(direct2);
    assert.equal(direct2.observationId, receipt2.observationId);
    assert.equal(direct2.sequence, 2);
  });

  test(`${backend} exact receipt retrieval, canonical unknown-version, and multi-engine provenance (Scenario 11, #126)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-obs-receipt-'));
    const store = backend === 'memory'
      ? new InMemoryEnvironmentReadinessStore()
      : new SqliteEnvironmentReadinessStore({ filename: join(directory, 'readiness.db') });
    t.after(() => {
      if (store instanceof SqliteEnvironmentReadinessStore) store.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const authority = readinessAuthorityTestSeam.mint({
      environmentInstanceId: 'env-multi',
      enrollmentId: 'enroll-multi',
      connectionEpoch: 3,
      isCurrent: () => true,
    });
    const scope = {
      environmentInstanceId: 'env-multi',
      authority,
      supported: { minMajor: 2, maxMajor: 2 },
      at: 3_000,
      verifyAuthority: readinessAuthorityTestSeam.verify,
    };

    // Multi-engine with unknown version for codex and valid semver for pi
    const result = workerReadinessProbeFixture({
      protocolVersion: '2',
      observedAt: 3_000,
      engines: [
        {
          engine: 'codex',
          version: 'custom-build-alpha/preview',
          installed: true,
          readiness: 'ready',
          modelAvailability: 'available',
          models: ['gpt-5'],
        },
        {
          engine: 'pi',
          version: '0.86.1',
          installed: true,
          readiness: 'ready',
          modelAvailability: 'available',
          models: ['pi-special'],
        },
      ],
    });

    const observation = await issued(store, result, scope);
    assert.ok(observation);
    const receipt = await store.commitObservation('env-multi', observation, authority);
    assert.ok(receipt);

    // Direct retrieval of exact committed receipt
    const retrievedReceipt = await store.getReceipt('env-multi', receipt.observationId);
    assert.ok(retrievedReceipt);
    assert.deepEqual(retrievedReceipt, receipt);
    assert.equal(retrievedReceipt.readiness.engines[0]?.version, 'unknown-version');
    assert.equal(retrievedReceipt.authorityScope.connectionEpoch, receipt.connectionEpoch);
    assert.equal(typeof retrievedReceipt.authorityScope.connectionId, 'string');

    // Direct retrieval of exact committed observation
    const retrievedObs = await store.getObservation('env-multi', receipt.observationId);
    assert.ok(retrievedObs);
    assert.equal(retrievedObs.observationId, receipt.observationId);
    assert.deepEqual(retrievedObs.readiness, receipt.readiness);
    assert.deepEqual(retrievedObs.probe, receipt.probe);
    assert.equal(retrievedObs.readiness.engines.length, 2);
    assert.equal(retrievedObs.readiness.engines[0]?.version, 'unknown-version');
    assert.equal(retrievedObs.readiness.engines[1]?.version, '0.86.1');

    // Unknown receipt ID returns undefined
    assert.equal(await store.getReceipt('env-multi', 'obs-non-existent'), undefined);
    assert.equal(await store.getObservation('env-multi', 'obs-non-existent'), undefined);
  });

  test(`${backend} defensive values cannot affect stored state or admission (Scenario 12, #126)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-obs-defensive-'));
    const store = backend === 'memory'
      ? new InMemoryEnvironmentReadinessStore()
      : new SqliteEnvironmentReadinessStore({ filename: join(directory, 'readiness.db') });
    t.after(() => {
      if (store instanceof SqliteEnvironmentReadinessStore) store.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const authority = readinessAuthorityTestSeam.mint({
      environmentInstanceId: 'env-def',
      enrollmentId: 'enroll-def',
      connectionEpoch: 5,
      isCurrent: () => true,
    });
    const scope = {
      environmentInstanceId: 'env-def',
      authority,
      supported: { minMajor: 2, maxMajor: 2 },
      at: 4_000,
      verifyAuthority: readinessAuthorityTestSeam.verify,
    };

    const result = workerReadinessProbeFixture({
      protocolVersion: '2',
      observedAt: 4_000,
      engines: [{ engine: 'pi', installed: true, readiness: 'unknown', modelAvailability: 'unknown', models: [] }],
    });
    const observation = await issued(store, result, scope);
    assert.ok(observation);
    const receipt = await store.commitObservation('env-def', observation, authority);
    assert.ok(receipt);

    // Mutate returned receipt
    Reflect.set(receipt, 'observationId', 'forged-obs');
    Reflect.set(receipt.probe, 'summary', 'forged-summary');
    Reflect.set(receipt, 'sequence', 999);

    // Mutate returned current observation
    const current = await store.getCurrentObservation('env-def');
    assert.ok(current);
    Reflect.set(current.readiness.engines[0]!, 'readiness', 'ready');
    Reflect.set(current.readiness.engines[0]!.models, 'state', 'available');
    Reflect.set(current.probe, 'protocolOk', false);

    // Mutate returned readiness document
    const readiness = await store.getReadiness('env-def');
    assert.ok(readiness);
    Reflect.set(readiness.engines[0]!, 'readiness', 'ready');

    // Mutate returned probes list
    const probes = await store.listProbes('env-def');
    Reflect.set(probes[0]!, 'source', 'forged');

    // Fresh read proves stored state is completely unaffected
    const freshCurrent = await store.getCurrentObservation('env-def');
    assert.ok(freshCurrent);
    assert.notEqual(freshCurrent.observationId, 'forged-obs');
    assert.equal(freshCurrent.sequence, 1);
    assert.equal(freshCurrent.readiness.engines[0]?.readiness, 'unknown');
    assert.equal(freshCurrent.readiness.engines[0]?.models.state, 'unknown');
    assert.equal(freshCurrent.probe.protocolOk, true);
    assert.equal(freshCurrent.probe.summary, 'Synthetic Worker readiness probe.');

    const freshReadiness = await store.getReadiness('env-def');
    assert.equal(freshReadiness?.engines[0]?.readiness, 'unknown');

    const freshProbes = await store.listProbes('env-def');
    assert.equal(freshProbes[0]?.source, 'worker');
  });
}
