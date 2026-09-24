import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  test(`#128 ${backend}: authenticated v2/v3 probes and incompatible wire keep one receipt history`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-128-wire-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory });
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      let mode: 'v2' | 'v3' | 'duplicate' | 'incompatible' = 'v2';
      const workerTime = { v2: 51_000, v3: 52_000, duplicate: 53_000, incompatible: 54_000 };
      let calls = 0;
      await h.connect(id, join(directory, 'worker-key.pem'), {
        readiness: () => ({ protocolVersion: WORKER_PROTOCOL_VERSION, engines: [{ engine: 'scripted', installed: true,
          readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] }],
          probe: { at: workerTime.v2, latencyMs: 3, protocolOk: true, enginesOk: true,
            source: 'worker', version: '1', summary: 'bootstrap wire control' } }),
        readinessProbe: async (params) => {
        calls += 1;
        const probe = { at: workerTime[mode], latencyMs: 3, protocolOk: true, enginesOk: true,
          source: 'worker' as const, version: '1', summary: 'synthetic wire control' };
        const engines = [{ engine: 'scripted', installed: true, readiness: 'ready' as const,
          modelAvailability: 'available' as const, models: ['scripted-model'], targetModels: [], modelIdPresent: true,
          ...(params.requirements?.revisionsByEngine?.scripted !== undefined
            ? { requirementRevision: params.requirements.revisionsByEngine.scripted } : {}) }];
        return { readiness: { protocolVersion: mode === 'v2' || mode === 'duplicate' ? '2' : mode === 'v3' ? '3' : '4',
          engines, probe: mode === 'duplicate' ? { ...probe, summary: 'contradictory' } : probe }, probe };
        },
      });
      const store = h.runtime.stores.environmentReadiness;
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');
      // An empty-target worker/info bootstrap uses its own complete v3
      // envelope; v2 translation is exercised by the explicit request below.
      await h.runtime.observeWorkerReadiness(id);
      assert.equal(calls, 0, 'empty-target bootstrap comes from worker/info, not a fabricated request');
      await waitFor(async () => (await store.getCurrentObservation(INSTANCE_ID)) !== undefined,
        'empty-target bootstrap receipt');
      assert.equal((await store.getCurrentObservation(INSTANCE_ID))?.probe.at, workerTime.v2);
      const post = () => fetch(`${h.base}/api/environments/enrollments/${id}/probes`, { method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ requiredModels: ['forged'], connectionEpoch: 999,
          probe: { source: 'browser', summary: 'forged' } }) });
      const before = (await store.listObservations(INSTANCE_ID)).length;
      const old = await post();
      assert.equal(old.status, 201);
      const oldReceipt = (await old.json()) as { receipt: { observationId: string; probe: { source: string } } };
      assert.equal(oldReceipt.receipt.probe.source, 'worker');
      assert.equal((await store.getCurrentObservation(INSTANCE_ID))?.probe.at, workerTime.v2);
      mode = 'v3';
      const fresh = await post();
      assert.equal(fresh.status, 201);
      const freshReceipt = (await fresh.json()) as { receipt: { observationId: string } };
      assert.notEqual(oldReceipt.receipt.observationId, freshReceipt.receipt.observationId);
      assert.equal((await store.getCurrentObservation(INSTANCE_ID))?.observationId, freshReceipt.receipt.observationId);
      assert.equal((await store.getCurrentObservation(INSTANCE_ID))?.probe.at, workerTime.v3);
      assert.equal((await store.listObservations(INSTANCE_ID)).length, before + 2);
      const get = await fetch(`${h.base}/api/environments/enrollments/${id}/readiness`,
        { headers: { cookie: h.cookie } });
      assert.equal(get.status, 200);
      const current = (await get.json()) as { receipt?: { observationId: string; probe: { at: number } };
        readiness: { probe?: { at: number } } };
      assert.equal(current.receipt?.observationId, freshReceipt.receipt.observationId);
      assert.equal(current.receipt?.probe.at, workerTime.v3);
      assert.equal(current.readiness.probe?.at, workerTime.v3);
      const historical = await fetch(`${h.base}/api/environments/enrollments/${id}/receipts/${oldReceipt.receipt.observationId}`,
        { headers: { cookie: h.cookie } });
      assert.equal(historical.status, 200);
      const history = (await historical.json()) as { receipt: { observationId: string; probe: { at: number } } };
      assert.equal(history.receipt.observationId, oldReceipt.receipt.observationId);
      assert.equal(history.receipt.probe.at, workerTime.v2);
      for (const rejected of ['duplicate', 'incompatible'] as const) {
        mode = rejected;
        assert.notEqual((await post()).status, 201);
        assert.equal((await store.getCurrentObservation(INSTANCE_ID))?.observationId, freshReceipt.receipt.observationId);
        assert.equal((await store.listObservations(INSTANCE_ID)).length, before + 2);
      }
    } finally { await h.close(); }
  });

  test(`#128 ${backend}: composed wire matrix keeps receipts, neutral refusal, and privacy`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sprout-128-matrix-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const privacyMarker = 'SPROUT_SYNTHETIC_MATRIX_SENTINEL_7f3a9c1e5d2b4806a1c9e7f3b5d2084c';
    const hostileSummary = `probe at /synthetic-private/${privacyMarker}/worker.sock`;
    const wireCases = [
      { name: 'supported-v2', version: '2', contradictory: false, commits: true },
      { name: 'current-v3', version: '3', contradictory: false, commits: true },
      { name: 'incompatible-v4', version: '4', contradictory: false, commits: false },
      { name: 'contradictory-v2', version: '2', contradictory: true, commits: false },
    ] as const;

    for (const wire of wireCases) {
      const directory = join(root, wire.name);
      mkdirSync(directory, { recursive: true });
      const h = await readinessWorkflowHarness({ backend, directory,
        agents: [{ ...agent('scout'), engine: 'codex', model: 'matrix-target' }] });
      try {
        const id = (await h.runtime.enrollments.list())[0]!.id;
        const store = h.runtime.stores.environmentReadiness;
        // Count every mutation attempt so a refused envelope is proven to reach
        // no commit at all, rather than inferred from a fixed sleep.
        let commitAttempts = 0;
        const originalCommit = store.commitObservation.bind(store);
        store.commitObservation = async (...args) => { commitAttempts += 1; return originalCommit(...args); };
        let calls = 0;
        let settledCalls = 0;
        await h.connect(id, join(directory, 'worker-key.pem'), { readinessProbe: async (params) => {
          calls += 1;
          const probe = { at: 90_000 + calls * 1_000, latencyMs: 7, protocolOk: true, enginesOk: true,
            source: 'worker' as const, version: '0.154.0', summary: hostileSummary };
          const revision = params.requirements?.revisionsByEngine?.codex;
          const targets = params.requirements?.modelsByEngine?.codex ?? [];
          const engines = [{ engine: 'codex', installed: true, authenticated: true, readiness: 'ready' as const,
            modelAvailability: 'available' as const, models: [...targets], targetModels: [...targets],
            modelIdPresent: targets.length > 0, probedAt: 5, probeExitCode: 0, source: 'codex-account-read' as const,
            ...(revision !== undefined ? { requirementRevision: revision } : {}) }];
          settledCalls += 1;
          return { readiness: { protocolVersion: wire.version, engines,
            probe: wire.contradictory ? { ...probe, summary: 'contradictory copy' } : probe }, probe };
        } });
        const human = () => fetch(`${h.base}/api/environments/enrollments/${id}/probes`, { method: 'POST',
          headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
          body: JSON.stringify({ requiredModels: ['forged'], connectionEpoch: 999,
            probe: { source: 'browser', summary: 'forged' } }) });
        const get = async () => fetch(`${h.base}/api/environments/enrollments/${id}/readiness`,
          { headers: { cookie: h.cookie } });
        // The automatic target trigger fires on acceptance.
        await waitFor(() => calls > 0, `${wire.name} automatic target probe`);
        await waitFor(() => settledCalls >= 1, `${wire.name} automatic Worker response`);
        if (wire.commits) {
          await waitFor(async () => (await store.listObservations(INSTANCE_ID)).length === 1, `${wire.name} commit`);
          await h.runtime.refreshEnvironmentCatalog();
          const history = await store.listObservations(INSTANCE_ID);
          const current = await store.getCurrentObservation(INSTANCE_ID);
          assert.equal(commitAttempts, 1, `${wire.name}: exactly one committed mutation`);
          assert.equal(history.length, 1, `${wire.name}: exactly the automatic observation`);
          assert.ok(current, `${wire.name}: current observation present`);
          assert.equal(current!.observationId, history[0]!.observationId, `${wire.name}: current is the committed observation`);
          assert.equal(current!.probe.at, 91_000, `${wire.name}: truthful Worker time survives commit`);
          assert.ok(!JSON.stringify(current).includes(privacyMarker), `${wire.name}: privacy sentinel never persisted`);

          // The Human trigger uses the same canonical path after acceptance.
          const post = await human();
          const postText = await post.text();
          assert.equal(post.status, 201, postText);
          const posted = JSON.parse(postText) as { receipt: { observationId: string; probe: { at: number; source?: string; summary: string } } };
          assert.equal(posted.receipt.probe.source, 'worker', `${wire.name}: a browser cannot forge provenance`);
          assert.equal(posted.receipt.probe.at, 92_000, `${wire.name}: Human-trigger Worker time is truthful`);
          const currentAfter = (await store.getCurrentObservation(INSTANCE_ID))!;
          assert.equal(currentAfter.observationId, posted.receipt.observationId, `${wire.name}: Human receipt is current`);
          assert.equal((await store.listObservations(INSTANCE_ID)).length, 2, `${wire.name}: one row per committed trigger`);

          const body = (await (await get()).json()) as { receipt?: { observationId: string; probe: { at: number; summary: string } };
            readiness: { probe?: { at: number; summary: string } }; probes: readonly { at: number }[] };
          assert.equal(body.receipt?.observationId, posted.receipt.observationId, `${wire.name}: GET identifies the committed receipt`);
          assert.equal(body.receipt?.probe.at, 92_000, `${wire.name}: GET receipt Worker time`);
          assert.equal(body.readiness.probe?.at, 92_000, `${wire.name}: current readiness Worker time`);
          assert.equal(body.probes.length, 2, `${wire.name}: durable history is inspectable`);
          assert.ok(!JSON.stringify(body).includes(privacyMarker), `${wire.name}: privacy survives the query seam`);
          assert.ok(!JSON.stringify(body).includes('/synthetic-private/'), `${wire.name}: host paths are redacted`);
          const historical = await fetch(`${h.base}/api/environments/enrollments/${id}/receipts/${history[0]!.observationId}`,
            { headers: { cookie: h.cookie } });
          assert.equal(historical.status, 200, `${wire.name}: historical receipt stays retrievable`);
          // Synthetic target-bound known-ready gate control: this proves the gate
          // can admit established evidence, not that live account entitlement is provable.
          assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, true, `${wire.name}: target-bound known-ready evidence admits`);
        } else {
          // The automatic trigger already consumed and refused this envelope. The
          // Human trigger shares the same validator, so its deterministic HTTP
          // settlement proves the same refusal reaches the request boundary too.
          const post = await human();
          const postText = await post.text();
          assert.notEqual(post.status, 201, `${wire.name}: Human-trigger refusal is not a success`);
          assert.ok(!postText.includes('"receipt"'), `${wire.name}: a refused Human trigger returns no receipt`);
          const history = await store.listObservations(INSTANCE_ID);
          const current = await store.getCurrentObservation(INSTANCE_ID);
          assert.equal(commitAttempts, 0, `${wire.name}: neither trigger ever attempted a mutation`);
          assert.equal(history.length, 0, `${wire.name}: an incompatible envelope never mutates observation history`);
          assert.equal(current, undefined, `${wire.name}: an incompatible envelope establishes no current state`);
          const response = await get();
          assert.equal(response.status, 200, `${wire.name}: the neutral state stays inspectable`);
          const body = (await response.json()) as { receipt?: unknown; readiness: { probe?: unknown; summary: { level: string } }; probes: readonly unknown[] };
          assert.equal(body.receipt, undefined, `${wire.name}: no receipt in the neutral projection`);
          assert.equal(body.readiness.probe, undefined, `${wire.name}: no fabricated current probe`);
          assert.deepEqual(body.probes, [], `${wire.name}: no fabricated probe history`);
          assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false, `${wire.name}: ineligible`);
          assert.equal((await h.runtime.enrollments.get(id))?.status, 'approved', `${wire.name}: enrollment authority is preserved`);
        }
      } finally { await h.close(); }
    }
  });

  test(`#128 ${backend}: a gateway protocol-mismatch refusal is an inspectable neutral state`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-128-gateway-skew-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'matrix-target' }] });
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      await h.connect(id, join(directory, 'unapproved-key.pem'), {}, '99').catch(() => undefined);
      const unproved = await fetch(`${h.base}/api/environments/enrollments/${id}/readiness`,
        { headers: { cookie: h.cookie } });
      assert.equal(((await unproved.json()) as { connectionAttempt?: unknown }).connectionAttempt, undefined,
        'a different Worker identity cannot publish a version-skew diagnostic');
      const refusal = await h.connect(id, join(directory, 'worker-key.pem'), {}, '99').then(
        () => undefined, (error: unknown) => error);
      assert.ok(refusal instanceof Error, 'the mismatched Worker is refused before acceptance');
      // The Worker host receives the explicit version-skew explanation on its own
      // authenticated channel: the connector surfaces the core's `incompatible`
      // refusal code rather than a generic transport error.
      assert.equal((refusal as { code?: string }).code, 'incompatible',
        'the refused Worker host gets an explicit incompatible explanation');
      assert.equal(h.runtime.workerGateway.liveFor(INSTANCE_ID), undefined, 'no epoch is minted');
      const response = await fetch(`${h.base}/api/environments/enrollments/${id}/readiness`, { headers: { cookie: h.cookie } });
      assert.equal(response.status, 200, 'the refusal stays inspectable over the query seam');
      const body = (await response.json()) as { connectionAttempt?: { outcome: string; reason: string; at: number };
        readiness: { compatibility: { state: string; detail?: string }; summary: { level: string }; probe?: unknown }; probes: readonly unknown[] };
      // Pre-epoch refusal never becomes current readiness. The Human sees a
      // separate core-owned attempt diagnostic, not echoed Worker claims.
      assert.equal(body.readiness.compatibility.state, 'unknown');
      assert.equal(body.readiness.compatibility.detail, undefined);
      assert.equal(body.connectionAttempt?.outcome, 'incompatible');
      assert.equal(body.connectionAttempt?.reason, 'the Worker protocol is incompatible with this Sprout build');
      assert.ok(Number.isFinite(body.connectionAttempt?.at));
      assert.equal(body.readiness.summary.level, 'red');
      assert.equal(body.readiness.probe, undefined);
      assert.deepEqual(body.probes, []);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
      assert.equal((await h.runtime.enrollments.get(id))?.status, 'approved');
      await h.connect(id, join(directory, 'worker-key.pem'));
      const recovered = await fetch(`${h.base}/api/environments/enrollments/${id}/readiness`,
        { headers: { cookie: h.cookie } });
      assert.equal(((await recovered.json()) as { connectionAttempt?: unknown }).connectionAttempt, undefined,
        'a later accepted connection clears the old refusal diagnostic');
    } finally { await h.close(); }
  });

  test(`#128 ${backend}: an empty-target bootstrap honours supported v2 and refuses an unsupported envelope`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sprout-128-bootstrap-skew-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // No configured target model selects the `worker/info` bootstrap trigger.
    const cases = [
      { name: 'v2', version: '2', commits: true },
      { name: 'v4', version: '4', commits: false },
    ] as const;
    for (const wireCase of cases) {
      const directory = join(root, wireCase.name);
      mkdirSync(directory, { recursive: true });
      const h = await readinessWorkflowHarness({ backend, directory });
      try {
        const id = (await h.runtime.enrollments.list())[0]!.id;
        const store = h.runtime.stores.environmentReadiness;
        let commitAttempts = 0;
        const originalCommit = store.commitObservation.bind(store);
        store.commitObservation = async (...args) => { commitAttempts += 1; return originalCommit(...args); };
        await h.connect(id, join(directory, 'worker-key.pem'), {
          readiness: () => ({ protocolVersion: wireCase.version, engines: [{ engine: 'scripted', installed: true,
            readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] }],
            probe: { at: 96_000, latencyMs: 3, protocolOk: true, enginesOk: true, source: 'worker',
              version: '1', summary: 'bootstrap envelope' } }),
        });
        await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');
        await h.runtime.observeWorkerReadiness(id);
        if (wireCase.commits) {
          await waitFor(async () => (await store.getCurrentObservation(INSTANCE_ID)) !== undefined, 'bootstrap commit');
          const current = (await store.getCurrentObservation(INSTANCE_ID))!;
          assert.equal(current.probe.at, 96_000, `${wireCase.name}: truthful Worker time survives bootstrap`);
          assert.equal(commitAttempts, 1, `${wireCase.name}: exactly one committed bootstrap mutation`);
        } else {
          // Deterministic: the observation path is idempotent and already
          // settled, so a second observe transitions nothing and proves the
          // refused envelope never reaches a commit without a timer as evidence.
          await h.runtime.observeWorkerReadiness(id);
          assert.equal(commitAttempts, 0, `${wireCase.name}: the unsupported envelope never attempts a mutation`);
          assert.equal((await store.getCurrentObservation(INSTANCE_ID)), undefined, `${wireCase.name}: no bootstrap observation commits`);
        }
        const response = await fetch(`${h.base}/api/environments/enrollments/${id}/readiness`, { headers: { cookie: h.cookie } });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { readiness: { probe?: { at: number } }; probes: readonly unknown[] };
        if (wireCase.commits) {
          assert.equal(body.readiness.probe?.at, 96_000, `${wireCase.name}: current bootstrap probe is inspectable`);
          assert.equal(body.probes.length, 1, `${wireCase.name}: bootstrap history is inspectable`);
        } else {
          assert.equal(body.readiness.probe, undefined, `${wireCase.name}: no fabricated current probe`);
          assert.deepEqual(body.probes, [], `${wireCase.name}: no fabricated history`);
        }
        assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false, `${wireCase.name}: bootstrap cannot authorize an unmeasured target`);
        assert.equal((await h.runtime.enrollments.get(id))?.status, 'approved', `${wireCase.name}: authority is preserved`);
      } finally { await h.close(); }
    }
  });
}
