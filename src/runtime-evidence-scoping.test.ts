import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from './worker/enrollment-connector.ts';
import {
  agent,
  connectRuntimeWorker,
  createRuntime,
  hostConfiguration,
  inMemoryStores,
  INSTANCE_ID,
  observeSyntheticReady,
  readinessAuthority,
  readinessWorkflowHarness,
  scriptedReadinessProbe,
  scriptedScope,
  waitFor,
} from './runtime-test-harness.ts';

for (const backend of ['memory', 'sqlite'] as const) {
  test(`#127 ${backend}: delayed acceptance probe cannot overwrite later HTTP evidence`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-127-accept-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }] });
    let release: (() => void) | undefined;
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started: (() => void) | undefined;
      const start = new Promise<void>((resolve) => { started = resolve; });
      let calls = 0;
      await h.connect(id, join(directory, 'worker-key.pem'), { readinessProbe: async () => {
        const call = ++calls;
        if (call === 1) { started?.(); await gate; }
        const probe = { at: call === 1 ? 9000 : 1, latencyMs: 1, protocolOk: true,
          enginesOk: call === 1, source: 'worker' as const, version: '1.0.0', summary: 'acceptance order' };
        return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, probe,
          engines: [{ engine: 'codex', installed: call === 1, readiness: call === 1 ? 'ready' as const : 'login-required' as const,
            modelAvailability: 'unknown' as const, models: [] }] }, probe };
      } });
      await start;
      const response = await fetch(`${h.base}/api/environments/enrollments/${id}/probes`, {
        method: 'POST', headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 201);
      release?.();
      await waitFor(async () => (await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID)).length === 1,
        'later login-required commit');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const history = await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID);
      assert.equal(history.length, 1);
      assert.equal(history[0]!.probe.at, 1);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
    } finally { release?.(); await h.close(); }
  });
  test(`#127 ${backend}: issue order survives reverse Worker completion, skew, and negative evidence`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-127-order-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory });
    let release: (() => void) | undefined;
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started: (() => void) | undefined;
      const firstStarted = new Promise<void>((resolve) => { started = resolve; });
      let calls = 0;
      let replayId: string | undefined;
      let conflicting = false;
      const fact = (state: 'ready' | 'missing', at: number) => {
        const probe = { at, latencyMs: 1, protocolOk: true, enginesOk: state === 'ready',
          source: 'worker' as const, version: '1.0.0', summary: state };
        return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION,
          engines: [{ engine: 'scripted', version: '1.0.0', installed: state === 'ready', readiness: state,
            modelAvailability: state === 'ready' ? 'available' as const : 'none' as const,
            models: state === 'ready' ? ['scripted-model'] : [], targetModels: [], modelIdPresent: state === 'ready',
            ...(scriptedScope.revisionsByEngine?.scripted !== undefined ? { requirementRevision: scriptedScope.revisionsByEngine.scripted } : {}) }], probe }, probe };
      };
      await h.connect(id, join(directory, 'worker-key.pem'), {
        readiness: () => fact('ready', 100).readiness,
        readinessProbe: async (params) => {
          calls++;
          if (calls === 1) { started?.(); await gate; return fact('ready', 9_000_000); }
          if (calls === 2) replayId = params.attemptId;
          return { ...fact(conflicting ? 'ready' : 'missing', 2),
            ...(calls > 2 ? { attemptId: replayId } : {}) };
        },
      });
      await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'bootstrap');
      await h.runtime.observeWorkerReadiness(id);
      assert.equal((await h.runtime.enrollments.listProbes(id)).length, 1, 'worker/info reread is inspection only');
      const post = () => fetch(`${h.base}/api/environments/enrollments/${id}/probes`, {
        method: 'POST', headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' }, body: '{}',
      });
      const older = post();
      await firstStarted;
      const newer = await post();
      assert.equal(newer.status, 201);
      const originalReceipt = ((await newer.json()) as { receipt: { observationId: string; sequence: number } }).receipt;
      await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === false, 'negative admission');
      release?.();
      const stale = await older;
      assert.equal(stale.status, 409, 'superseded attempt is neutral, not a successful probe');
      assert.equal(((await stale.json()) as { code?: string }).code, 'superseded-observation');
      const observations = await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID);
      assert.equal(observations.length, 2, 'bootstrap and later negative only');
      assert.ok(observations[0]!.sequence < observations[1]!.sequence);
      assert.equal(observations[1]!.probe.at, 2, 'Worker clock is not ordering authority');
      assert.equal((await h.runtime.enrollments.listProbes(id)).length, 2);
      assert.equal((await h.runtime.stores.environmentReadiness.getCurrentObservation(INSTANCE_ID))?.observationId,
        observations[1]!.observationId);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
      await h.runtime.observeWorkerReadiness(id);
      assert.equal((await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID)).length, 2,
        'bootstrap reread cannot supersede a later targeted negative');
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
      const repeat = await post();
      assert.equal(repeat.status, 201);
      assert.deepEqual(((await repeat.json()) as { receipt: { observationId: string; sequence: number } }).receipt,
        originalReceipt, 'exact redelivery returns the original receipt');
      assert.equal((await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID)).length, 2,
        'same authenticated identity and content has one history entry');
      conflicting = true;
      const conflict = await post();
      assert.equal(conflict.status, 409, 'changed content under committed identity is refused');
      assert.equal(((await conflict.json()) as { code?: string }).code, 'conflicting-observation');
      assert.equal((await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID)).length, 2);
    } finally { release?.(); await h.close(); }
  });
  for (const missing of ['omitted', 'undefined'] as const) {
    test(`exposed ${backend} readiness store refuses ${missing} probe without admitting work (R118-API-002)`, async (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'sprout-store-ingress-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const runtime = await createRuntime({
        configuration: hostConfiguration({
          databasePath: join(directory, 'sprout.db'), environmentSource: 'enrollment',
        }),
        projectRoot: '/synthetic/project-root',
        ...(backend === 'memory' ? { stores: inMemoryStores() } : {}),
      });
      try {
        const keyPath = join(directory, 'worker-key.pem');
        const identity = loadOrCreateWorkerIdentity(keyPath);
        const { enrollment } = await runtime.enrollments.requestEnrollment({
          environmentInstanceId: 'host-store-ingress', displayName: 'Store ingress',
          publicKey: workerPublicKey(identity.privateKey), platform: 'macos',
          capabilityRequests: [ADMISSION_CAPABILITY], engineFacts: [],
        });
        await runtime.enrollments.approve(enrollment.id, {
          capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
        });
        await connectRuntimeWorker(runtime, enrollment.id, keyPath);
        const epoch = runtime.workerGateway.currentConnectionEpoch(enrollment.id)!;
        const authority = readinessAuthority(runtime, enrollment.id, epoch);
        assert.equal(authority.isCurrent(), true);
        const raw = {
          readiness: {
            enrollmentId: enrollment.id, connectionEpoch: epoch,
            connection: { state: 'online', lastConfirmedAt: Date.now() },
            compatibility: { state: 'compatible', workerProtocolVersion: '2' },
            engines: [{ engine: 'scripted', installed: true, readiness: 'ready', required: true,
              models: { state: 'available', models: ['scripted-model'] } }],
          },
          ...(missing === 'undefined' ? { probe: undefined } : {}),
        };
        const store = runtime.stores.environmentReadiness;
        const recorded = await store.commitObservation(enrollment.environmentInstanceId, raw as never, authority);
        await runtime.refreshEnvironmentCatalog();
        assert.equal(recorded, false);
        assert.equal(await store.getReadiness(enrollment.environmentInstanceId), undefined);
        assert.deepEqual(await store.listProbes(enrollment.environmentInstanceId), []);
        assert.equal(runtime.environmentCatalog.entry(enrollment.environmentInstanceId)?.eligible, false);

        // Read methods are not a raw write seam either. Mutating a returned
        // unknown observation must not silently turn the instance admissible.
        const unknown = scriptedReadinessProbe();
        Reflect.set(unknown.readiness.engines[0]!, 'modelAvailability', 'unknown');
        assert.equal(await runtime.enrollments.observeReadiness(enrollment.id, unknown, authority), true);
        const readback = await store.getReadiness(enrollment.environmentInstanceId);
        assert.ok(readback);
        Reflect.set(readback.engines[0]!.models, 'state', 'available');
        const history = await store.listProbes(enrollment.environmentInstanceId);
        Reflect.set(history[0]!, 'source', 'unknown');
        await runtime.refreshEnvironmentCatalog();
        assert.equal(runtime.environmentCatalog.entry(enrollment.environmentInstanceId)?.eligible, false);
        assert.equal((await store.getReadiness(enrollment.environmentInstanceId))?.engines[0]?.models.state, 'unknown');
        assert.equal((await store.listProbes(enrollment.environmentInstanceId))[0]?.source, 'worker');

        // The refusal is input validation, not a broken authority/admission path.
        assert.ok(await observeSyntheticReady(runtime, enrollment.id, authority));
        await runtime.refreshEnvironmentCatalog();
        assert.equal(runtime.environmentCatalog.entry(enrollment.environmentInstanceId)?.eligible, true);
        assert.equal((await store.listProbes(enrollment.environmentInstanceId)).length, 2);
      } finally {
        await runtime.close();
      }
    });
  }
}
