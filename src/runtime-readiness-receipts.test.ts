import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';
import {
  agent,
  INSTANCE_ID,
  readinessWorkflowHarness,
  waitFor,
} from './runtime-test-harness.ts';

for (const backend of ['memory', 'sqlite'] as const) {
  test(`#126 ${backend}: malformed requirement scope refuses through accepted Runtime authority without mutation`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-126-scope-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const probe = { at: Date.now(), latencyMs: 5, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '1.0.0', summary: 'scope probe' };
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe }, probe,
        }),
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');
      const authority = h.runtime.workerGateway.authorizeObservation(INSTANCE_ID);
      assert.ok(authority);
      const result = { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe };
      const store = h.runtime.stores.environmentReadiness;
      const before = await store.getCurrentObservation(INSTANCE_ID);
      const history = await store.listObservations(INSTANCE_ID);
      const probes = await store.listProbes(INSTANCE_ID);
      for (const requirements of [null, [], 1, 'bad', { unknown: true },
        { revision: 'bad/revision' }, { requiredModels: [null] }, { requiredModels: ['bad/model'] }]) {
        assert.equal(await h.runtime.enrollments.recordReadinessObservation(
          enrollmentId, result, authority, { requirements } as never,
        ), undefined);
        assert.deepEqual(await store.getCurrentObservation(INSTANCE_ID), before);
        assert.deepEqual(await store.listObservations(INSTANCE_ID), history);
        assert.deepEqual(await store.listProbes(INSTANCE_ID), probes);
      }
      const ticket = await h.runtime.enrollments.issueReadinessAttempt(enrollmentId, authority, false, [], { requiredModels: [] });
      assert.ok(ticket);
      const wrong = { ...ticket, sequence: ticket.sequence + 1 };
      assert.equal(await h.runtime.enrollments.recordReadinessObservation(enrollmentId, result, authority, { attempt: wrong }), undefined);
      const substituted = { ...ticket, requirements: { revision: 'r1', requiredModels: ['safe-model'] } };
      assert.equal(await h.runtime.enrollments.recordReadinessObservation(enrollmentId, result, authority, { attempt: substituted }), undefined);
      assert.deepEqual(await store.getCurrentObservation(INSTANCE_ID), before);
      assert.deepEqual(await store.listObservations(INSTANCE_ID), history);
      assert.deepEqual(await store.listProbes(INSTANCE_ID), probes);
      const receipt = await h.runtime.enrollments.recordReadinessObservation(enrollmentId, result, authority, { attempt: ticket });
      assert.ok(receipt);
      assert.deepEqual(receipt.requirements, { requiredModels: [] });
    } finally {
      await h.close();
    }
  });

  test(`#126 ${backend}: concurrent read during an in-flight commit returns facts and probe from the same observation (Scenario 8)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-126-concurrent-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const initialProbe = {
        at: 10_000, latencyMs: 5, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '1.0.0', summary: 'initial probe',
      };
      const secondProbe = {
        at: 20_000, latencyMs: 7, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '1.0.0', summary: 'second probe',
      };

      let currentProbeResult = initialProbe;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            engines: [
              { engine: 'codex', version: '1.0.0', installed: true, authenticated: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-6-astra'] },
            ],
            probe: currentProbeResult,
          },
          probe: currentProbeResult,
        }),
      });
      await waitFor(
        async () => (await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID)).length >= 1,
        'startup observation',
      );

      // Intercept store commit to hold during the second probe commit
      const store = h.runtime.stores.environmentReadiness;
      const origCommit = store.commitObservation.bind(store);
      let commitStartedSignal!: () => void;
      const commitStartedPromise = new Promise<void>((r) => { commitStartedSignal = r; });
      let releaseCommit!: () => void;
      const releasePromise = new Promise<void>((r) => { releaseCommit = r; });

      store.commitObservation = async (...args) => {
        commitStartedSignal();
        await releasePromise;
        return origCommit(...args);
      };

      currentProbeResult = secondProbe;
      const pendingPost = fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });

      await commitStartedPromise;

      // Concurrent read during the in-flight commit window
      const concurrentGet = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/readiness`, {
        headers: { cookie: h.cookie },
      });
      assert.equal(concurrentGet.status, 200);
      const concurrentBody = (await concurrentGet.json()) as {
        readonly readiness: { readonly observationId?: string; readonly probe?: { readonly at: number } };
        readonly receipt?: { readonly observationId: string };
      };
      // Before commit finishes, current readiness has not advanced
      if (concurrentBody.readiness.probe !== undefined) {
        assert.equal(concurrentBody.readiness.probe.at, initialProbe.at);
      }

      // Complete commit
      releaseCommit();
      const postResponse = await pendingPost;
      assert.equal(postResponse.status, 201);
      const postBody = (await postResponse.json()) as {
        readonly probe: { readonly at: number };
        readonly receipt: { readonly observationId: string; readonly sequence: number };
      };
      assert.equal(postBody.probe.at, secondProbe.at);
      assert.ok(postBody.receipt.observationId.length > 0);

      // Post-commit read: both facts and probe metadata come from the second observation
      const postGet = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/readiness`, {
        headers: { cookie: h.cookie },
      });
      assert.equal(postGet.status, 200);
      const postGetBody = (await postGet.json()) as {
        readonly readiness: { readonly observationId?: string; readonly probe?: { readonly at: number } };
        readonly receipt?: { readonly observationId: string };
      };
      assert.equal(postGetBody.readiness.observationId, postBody.receipt.observationId);
      assert.equal(postGetBody.readiness.probe?.at, secondProbe.at);
      assert.equal(postGetBody.receipt?.observationId, postBody.receipt.observationId);
    } finally {
      await h.close();
    }
  });

  test(`#126 ${backend}: committed receipts identify exact observation and support direct retrieval with multi-engine provenance (Scenario 11)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-126-receipt-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const multiProbe = {
        at: 50_000, latencyMs: 8, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: 'multi-v1-custom/unpinned', summary: 'multi engine probe',
      };
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            engines: [
              { engine: 'codex', version: 'raw-unsupported-version-build', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-6-astra'] },
              { engine: 'pi', version: '0.86.1', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['pi-model'] },
            ],
            probe: multiProbe,
          },
          probe: multiProbe,
        }),
      });
      await waitFor(
        async () => (await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID)).length >= 1,
        'startup probe',
      );

      // 1. POST probe returns receipt identifying exact canonical observation
      const postRes = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(postRes.status, 201);
      const postBody = (await postRes.json()) as {
        readonly probe: { readonly at: number; readonly source?: string };
        readonly receipt: { readonly observationId: string; readonly sequence: number; readonly committedAt: number };
      };
      assert.equal(postBody.probe.source, 'worker');
      const observationId = postBody.receipt.observationId;
      assert.ok(observationId.startsWith('obs-'));

      // 2. Subsequent GET /readiness identifies the same observation directly
      const getRes = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/readiness`, {
        headers: { cookie: h.cookie },
      });
      assert.equal(getRes.status, 200);
      const getBody = (await getRes.json()) as {
        readonly readiness: {
          readonly observationId?: string;
          readonly engines: readonly { readonly engine: string; readonly version?: string }[];
        };
        readonly receipt?: { readonly observationId: string; readonly sequence: number };
      };
      assert.equal(getBody.readiness.observationId, observationId);
      assert.equal(getBody.receipt?.observationId, observationId);
      assert.equal(getBody.receipt?.sequence, postBody.receipt.sequence);

      // Canonical unknown-version and multi-engine provenance
      const codexEngine = getBody.readiness.engines.find((e) => e.engine === 'codex');
      const piEngine = getBody.readiness.engines.find((e) => e.engine === 'pi');
      assert.equal(codexEngine?.version, 'unknown-version', 'unsupported version format is sanitized to unknown-version');
      assert.equal(piEngine?.version, '0.86.1');

      // 3. Direct retrieval via GET /receipts/:observationId without history scan
      const directReceiptRes = await fetch(
        `${h.base}/api/environments/enrollments/${enrollmentId}/receipts/${observationId}`,
        { headers: { cookie: h.cookie } },
      );
      assert.equal(directReceiptRes.status, 200);
      const directReceiptBody = (await directReceiptRes.json()) as { readonly receipt: { readonly observationId: string } };
      assert.equal(directReceiptBody.receipt.observationId, observationId);
      assert.deepEqual((directReceiptBody.receipt as unknown as { readiness: unknown }).readiness,
        (postBody.receipt as unknown as { readiness: unknown }).readiness);

      // Unknown observation id returns 404
      const notFoundReceipt = await fetch(
        `${h.base}/api/environments/enrollments/${enrollmentId}/receipts/obs-non-existent`,
        { headers: { cookie: h.cookie } },
      );
      assert.equal(notFoundReceipt.status, 404);
    } finally {
      await h.close();
    }
  });

  test(`#126 ${backend}: defensive copies on API responses cannot affect stored state or admission (Scenario 12)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-126-defensive-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const probeFact = {
        at: 60_000, latencyMs: 5, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '1.0.0', summary: 'probe for defensive test',
      };
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            engines: [
              { engine: 'codex', version: '1.0.0', installed: true, readiness: 'unknown', modelAvailability: 'unknown', models: [] },
            ],
            probe: probeFact,
          },
          probe: probeFact,
        }),
      });
      await waitFor(
        async () => (await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID)).length >= 1,
        'startup observation',
      );

      const postRes = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(postRes.status, 201);
      const postBody = (await postRes.json()) as Record<string, any>;
      // Attempt mutation of response payload
      postBody.receipt.observationId = 'forged-obs-id';
      postBody.probe.protocolOk = false;

      const getRes = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/readiness`, {
        headers: { cookie: h.cookie },
      });
      assert.equal(getRes.status, 200);
      const getBody = (await getRes.json()) as Record<string, any>;
      // Attempt mutation of GET payload
      getBody.readiness.engines[0].readiness = 'ready';
      getBody.readiness.engines[0].models = { state: 'available', models: ['gpt-6-astra'] };

      // Verify stored state in runtime and admission eligibility are untouched
      const currentObs = await h.runtime.stores.environmentReadiness.getCurrentObservation(INSTANCE_ID);
      assert.ok(currentObs);
      assert.notEqual(currentObs.observationId, 'forged-obs-id');
      assert.equal(currentObs.readiness.engines[0]?.readiness, 'unknown');
      assert.equal(currentObs.probe.protocolOk, true);

      // Admission still refuses because engine readiness is unknown
      await h.runtime.refreshEnvironmentCatalog();
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
    } finally {
      await h.close();
    }
  });
}
