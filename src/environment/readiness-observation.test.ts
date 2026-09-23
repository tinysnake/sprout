import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadinessObservation, readReadinessObservation } from './readiness-observation.ts';
import { InMemoryEnvironmentReadinessStore } from './readiness-store.ts';
import { SqliteEnvironmentReadinessStore } from './sqlite-readiness-store.ts';
import { workerReadinessProbeFixture } from '../worker/readiness-fixture.ts';
import { mintTestObservationAuthority } from './readiness-authority.ts';

for (const backend of ['memory', 'sqlite'] as const) {
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
    const authority = mintTestObservationAuthority({
      environmentInstanceId: 'env-1',
      enrollmentId: 'enroll-1',
      connectionEpoch: 7,
      isCurrent: () => current,
    });
    const result = workerReadinessProbeFixture({
      protocolVersion: '2', observedAt: 1_234,
      engines: [{ engine: 'pi', installed: true, readiness: 'unknown', modelAvailability: 'unknown', models: [] }],
    });
    const scope = { environmentInstanceId: 'env-1', authority, supported: { minMajor: 2, maxMajor: 2 }, at: 1_234 };
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
    const observation = createReadinessObservation(result, scope);
    assert.ok(observation);
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
    assert.equal(await store.commitObservation('env-1', observation, mintTestObservationAuthority({ environmentInstanceId: 'env-1', enrollmentId: 'enroll-1', connectionEpoch: 8 })), false);
    assert.equal(await store.commitObservation('env-1', observation, mintTestObservationAuthority({ environmentInstanceId: 'env-1', enrollmentId: 'enroll-other', connectionEpoch: 7 })), false);
    assert.equal(await store.commitObservation('env-1', observation, mintTestObservationAuthority({ environmentInstanceId: 'env-other', enrollmentId: 'enroll-1', connectionEpoch: 7 })), false);
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
    assert.equal(await store.commitObservation('env-1', observation, authority), true);
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
}
