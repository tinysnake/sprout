import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerReadinessProbeParams,
} from './worker/protocol.ts';
import {
  agent,
  INSTANCE_ID,
  readinessWorkflowHarness,
  waitFor,
  testComposition,
} from './runtime-test-harness.ts';
import { ReadinessOutcomeError } from './environment/readiness-workflow.ts';

for (const backend of ['memory', 'sqlite'] as const) {
  test(`#124 ${backend}: startup and automatic target probes cross one workflow and commit canonical facts`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-target-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      let received: WorkerReadinessProbeParams | undefined;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async (params) => {
          received = params;
          const probe = {
            at: Date.now(), latencyMs: 8, protocolOk: true, enginesOk: true,
            source: 'worker' as const, version: '0.154.0', summary: 'target probe',
          };
          return {
            readiness: {
              protocolVersion: WORKER_PROTOCOL_VERSION,
              engines: [
                { engine: 'scripted', version: '1.0.0', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] },
                { engine: 'codex', version: '0.154.0', installed: true, readiness: 'ready', modelAvailability: 'unknown', models: [], authenticated: true, authMode: 'chatgpt', probedAt: 2, probeExitCode: 0, source: 'codex-account-read', targetModels: params.requirements?.modelsByEngine?.codex ?? [], ...(params.requirements?.revision !== undefined ? { requirementRevision: params.requirements.revision } : {}) },
              ],
              probe,
            },
            probe,
          };
        },
      });
      await waitFor(() => received !== undefined, 'the target probe to reach the Worker');
      assert.deepEqual(received?.requiredModels, ['gpt-6-astra'], 'targets are core-owned');
      assert.match(received?.attemptId ?? '', /^obs-/);
      await waitFor(async () => (await h.runtime.enrollments.listProbes(enrollmentId)).length > 0, 'target-probe receipt');
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false, 'unknown entitlement is not admissible');
      const readiness = await h.runtime.enrollments.readiness(enrollmentId);
      assert.equal(readiness.readiness.probe?.latencyMs, 8);
      const codex = readiness.readiness.engines.find((engine) => engine.engine === 'codex');
      assert.equal(codex?.version, '0.154.0');
      assert.equal(codex?.source, 'codex-account-read');
    } finally {
      await h.close();
    }
  });

  test(`#124 ${backend}: empty-target bootstrap commits one canonical observation`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-bootstrap-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      await assert.rejects(testComposition(h.runtime).readinessWorkflow.request(enrollmentId),
        (error: unknown) => error instanceof ReadinessOutcomeError && error.disposition === 'unavailable');
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readiness: () => ({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          engines: [
            { engine: 'scripted', version: '1.0.0', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] },
          ],
          probe: { at: Date.now(), latencyMs: 4, protocolOk: true, enginesOk: true, source: 'worker', version: '1.0.0', summary: 'bootstrap probe' },
        }),
      });
      await waitFor(async () => (await h.runtime.enrollments.listProbes(enrollmentId)).length > 0, 'bootstrap receipt');
      const probes = await h.runtime.enrollments.listProbes(enrollmentId);
      assert.ok(probes.length >= 1, 'the bootstrap observation is durable');
      assert.equal(probes.at(-1)?.source, 'worker');
      const readiness = await h.runtime.enrollments.readiness(enrollmentId);
      assert.equal(readiness.readiness.connection.state, 'online');
      assert.equal(readiness.readiness.probe?.version, '1.0.0');
      assert.equal(readiness.summary.level, 'green', readiness.summary.reason);
    } finally {
      await h.close();
    }
  });

  test(`#124 ${backend}: a browser POST is request-only and cannot supply facts`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-request-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async (params) => {
          const probe = {
            at: Date.now(), latencyMs: 9, protocolOk: true, enginesOk: true,
            source: 'worker' as const, version: '0.154.0', summary: 'requested probe',
          };
          return {
            readiness: {
              protocolVersion: WORKER_PROTOCOL_VERSION,
              engines: [
                { engine: 'scripted', version: '1.0.0', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] },
                { engine: 'codex', version: '0.154.0', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-6-astra'], authenticated: true, probedAt: 5, probeExitCode: 0, source: 'codex-account-read' as const, targetModels: params.requirements?.modelsByEngine?.codex ?? [], modelIdPresent: true, ...(params.requirements?.revisionsByEngine?.codex !== undefined ? { requirementRevision: params.requirements.revisionsByEngine.codex } : {}) },
              ],
              probe,
            },
            probe,
          };
        },
      });
      await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'startup eligibility');
      const response = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({
          readiness: { engines: [{ engine: 'forged', readiness: 'ready' }] },
          probe: { source: 'browser', version: 'forged', summary: 'browser fact' },
          connectionEpoch: 999,
          requiredModels: ['browser-forgery'],
        }),
      });
      const text = await response.text();
      assert.equal(response.status, 201, text);
      assert.equal(text.includes('browser fact'), false);
      const returned = JSON.parse(text) as { probe: { source?: string } };
      assert.equal(returned.probe.source, 'worker');
      const committed = await testComposition(h.runtime).readinessWorkflow.request(enrollmentId);
      assert.match(committed.observationId, /^obs-/);
      assert.ok(await h.runtime.enrollments.getReceipt(enrollmentId, committed.observationId));
    } finally {
      await h.close();
    }
  });

  test(`#124 ${backend}: contradictory Worker probe copies never mutate observation state`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-malformed-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const valid = { at: Date.now(), latencyMs: 9, protocolOk: true, enginesOk: true, source: 'worker' as const, version: '0.154.0', summary: 'probe' };
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe: valid },
          probe: { ...valid, summary: 'contradictory returned copy' },
        }),
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');
      const response = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.notEqual(response.status, 201);
      await assert.rejects(testComposition(h.runtime).readinessWorkflow.request(enrollmentId),
        (error: unknown) => error instanceof ReadinessOutcomeError && error.disposition === 'unavailable');
      const readiness = await h.runtime.enrollments.readiness(enrollmentId);
      assert.equal(readiness.readiness.probe, undefined, 'no committed probe from a contradictory result');
      assert.deepEqual(await h.runtime.enrollments.listProbes(enrollmentId), []);
    } finally {
      await h.close();
    }
  });

  test(`#124 ${backend}: revoke inside the probe window reports no current facts`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-revoke-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started: (() => void) | undefined;
      const startedProbe = new Promise<void>((resolve) => { started = resolve; });
      let calls = 0;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => {
          calls += 1;
          started?.();
          await gate;
          const probe = {
            at: Date.now(), latencyMs: 9, protocolOk: true, enginesOk: true,
            source: 'worker' as const, version: '0.154.0', summary: 'delayed probe',
          };
          return {
            readiness: {
              protocolVersion: WORKER_PROTOCOL_VERSION,
              engines: [
                { engine: 'scripted', version: '1.0.0', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] },
                { engine: 'codex', version: '0.154.0', installed: true, readiness: 'ready', modelAvailability: 'unknown', models: [], authenticated: true, probedAt: 5, probeExitCode: 0, source: 'codex-account-read' },
              ],
              probe,
            },
            probe,
          };
        },
      });
      await startedProbe;
      const pending = fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      await h.runtime.enrollments.revoke(enrollmentId, 'retired mid-probe');
      release?.();
      const response = await pending;
      assert.notEqual(response.status, 201, 'a superseded response is never a successful probe');
      assert.equal(((await response.json()) as { probe?: unknown }).probe, undefined);
      const readiness = await h.runtime.enrollments.readiness(enrollmentId);
      assert.equal(readiness.readiness.connection.state, 'never-connected');
      assert.equal(readiness.readiness.probe, undefined);
      assert.deepEqual(await h.runtime.enrollments.listProbes(enrollmentId), []);
      assert.ok(calls >= 1, 'the real Worker probe was exercised before the revoke');
    } finally {
      await h.close();
    }
  });

  test(`#124 ${backend}: malformed readiness/engine facts are refused over the accepted Worker without mutation`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-engine-facts-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      // A configured target model selects the explicit target-probe collection
      // mode, so the same malformed result also crosses the automatic path.
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const probe = {
        at: Date.now(), latencyMs: 7, protocolOk: true, enginesOk: false,
        source: 'worker' as const, version: '0.154.0', summary: 'malformed engine facts probe',
      };
      // Every engine below is invalid for a distinct reason: unknown readiness
      // enum, non-boolean installed, unknown model-availability enum, non-array
      // models, and an extra disallowed field. The result envelope and probe
      // record are valid, so a refusal can only come from the engine-fact guard.
      const malformedEngines = [
        { engine: 'codex', installed: true, readiness: 'certainly-ready', modelAvailability: 'available', models: [] },
        { engine: 'pi', installed: 'yes', readiness: 'ready', modelAvailability: 'available', models: [] },
        { engine: 'opencode', installed: true, readiness: 'ready', modelAvailability: 'plenty', models: [] },
        { engine: 'agy', installed: true, readiness: 'ready', modelAvailability: 'available', models: 'a-model' },
        { engine: 'cursor', installed: true, readiness: 'ready', modelAvailability: 'available', models: [], accountEmail: 'worker@invalid' },
      ];
      let calls = 0;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => {
          calls += 1;
          return {
            readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: malformedEngines, probe },
            probe,
          } as never;
        },
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');
      // Automatic trigger: the transitional entry point delegates to the one
      // composed workflow. Await it so the refusal is deterministic rather than
      // inferred from an absent store row.
      await waitFor(() => calls >= 1, 'automatic accepted-Worker probe');
      assert.ok(calls >= 1, 'the real Worker JSON-RPC probe was exercised');
      assert.equal(
        await h.runtime.stores.environmentReadiness.getReadiness(INSTANCE_ID),
        undefined,
        'a malformed engine fact must not commit a readiness document',
      );
      assert.deepEqual(
        await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID),
        [],
        'a malformed engine fact must not append probe history',
      );
      // Explicit trigger: the Human-requested probe crosses the same workflow.
      const response = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.notEqual(response.status, 201, 'a malformed engine fact is never a successful probe');
      assert.equal(((await response.json()) as { probe?: unknown }).probe, undefined);
      await assert.rejects(testComposition(h.runtime).readinessWorkflow.request(enrollmentId),
        (error: unknown) => error instanceof ReadinessOutcomeError && error.disposition === 'malformed');
      assert.equal(
        await h.runtime.stores.environmentReadiness.getReadiness(INSTANCE_ID),
        undefined,
        'the explicit path must also leave no readiness document',
      );
      assert.deepEqual(
        await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID),
        [],
        'the explicit path must also append no probe history',
      );
      const assembled = await h.runtime.enrollments.readiness(enrollmentId);
      assert.equal(assembled.readiness.connection.state, 'never-connected');
      assert.deepEqual(assembled.probes, []);
    } finally {
      await h.close();
    }
  });
}
