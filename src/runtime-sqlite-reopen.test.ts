import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_PROTOCOL_VERSION, type WorkerReadinessProbeParams } from './worker/protocol.ts';
import type { WorkerEnrollmentConnection } from './worker/enrollment-connector.ts';
import {
  agent,
  connectRuntimeWorker,
  createRuntime,
  enrollEligibleInstance,
  hostConfiguration,
  INSTANCE_ID,
  observeSyntheticReady,
  readinessAuthority,
  readinessWorkflowHarness,
  waitFor,
  testComposition,
} from './runtime-test-harness.ts';

test('E2: the catalog, its records, and Project access survive a SQLite reopen', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'sprout.db');

  const first = await createRuntime({
    configuration: hostConfiguration({ databasePath, environmentSource: 'enrollment' }),
    projectRoot: '/synthetic/project-root',
  });
  const keyPath = join(directory, 'host-a-key.pem');
  const enrollmentId = await enrollEligibleInstance(first, 'host-a', keyPath);
  const firstEpoch = first.workerGateway.currentConnectionEpoch(enrollmentId)!;
  const firstAuthority = testComposition(first).workerGateway.authorizeObservation('host-a')!;
  await first.close();

  // Reopen exactly as a restart would: no in-memory epoch survives, but the
  // enrolled instance and its durable catalog record remain inspectable.
  const second = await createRuntime({
    configuration: hostConfiguration({ databasePath, environmentSource: 'enrollment' }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const record = await second.stores.environmentCatalog.get('host-a');
    assert.equal(record?.definition.platform, 'macos');
    assert.ok(second.environmentCatalog.entry('host-a') !== undefined, 'entry survives reopen');
    assert.equal(second.environmentCatalog.entry('host-a')?.eligible, false, 'no epoch after a restart');

    // A restart must not restart the authority namespace at epoch 1. The new
    // authenticated connection receives a durable, strictly newer generation,
    // and the old persisted readiness cannot make that connection eligible.
    await connectRuntimeWorker(second, enrollmentId, keyPath);
    const replacement = second.workerGateway.currentConnectionEpoch(enrollmentId)!;
    assert.ok(replacement > firstEpoch, 'restart keeps the epoch high-water mark');
    await second.refreshEnvironmentCatalog();
    assert.equal(
      second.environmentCatalog.entry('host-a')?.eligible,
      false,
      'the replacement cannot inherit readiness from the pre-restart connection',
    );

    // Delayed old facts remain non-authoritative; only readiness produced by
    // the replacement epoch restores admission.
    await observeSyntheticReady(second, enrollmentId, firstAuthority);
    await second.refreshEnvironmentCatalog();
    assert.equal(second.environmentCatalog.entry('host-a')?.eligible, false);
    await observeSyntheticReady(second, enrollmentId,
      readinessAuthority(second, enrollmentId, replacement));
    await second.refreshEnvironmentCatalog();
    assert.equal(second.environmentCatalog.entry('host-a')?.eligible, true);
  } finally {
    await second.close();
  }
});

test('#128 sqlite: HTTP Agent target edit survives reopen and scopes the next authenticated request', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-128-reopen-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agents = [{ ...agent('scout'), engine: 'codex', model: 'old-target' }];
  const first = await readinessWorkflowHarness({ backend: 'sqlite', directory, agents });
  const id = (await first.runtime.enrollments.list())[0]!.id;
  const keyPath = join(directory, 'worker-key.pem');
  let historicalId: string;
  try {
    await first.runtime.agentService.create({ id: 'scout', displayName: 'Scout',
      workOptions: [{ engine: 'codex', workModel: 'old-target', effort: 'medium' }] });
    await first.connect(id, keyPath, { readinessProbe: async (params) => {
      const probe = { at: 71_000, latencyMs: 3, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '3', summary: 'old target' };
      return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, probe, engines: [
        { engine: 'codex', installed: true, authenticated: true, readiness: 'ready',
          modelAvailability: 'available', models: ['old-target'], targetModels: ['old-target'],
          modelIdPresent: true, requirementRevision: params.requirements!.revisionsByEngine!.codex! },
      ] }, probe };
    } });
    await waitFor(async () => (await first.runtime.stores.environmentReadiness.getCurrentObservation(INSTANCE_ID)) !== undefined,
      'old target observation');
    historicalId = (await first.runtime.stores.environmentReadiness.getCurrentObservation(INSTANCE_ID))!.observationId;
    const edited = await fetch(`${first.base}/api/agents/scout/configuration`, { method: 'POST',
      headers: { cookie: first.cookie, 'x-sprout-csrf': first.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Scout', workOptions: [
        { engine: 'codex', workModel: 'new-target', effort: 'medium' },
      ] }),
    });
    assert.equal(edited.status, 200);
    await first.runtime.refreshEnvironmentCatalog();
    assert.equal(first.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
  } finally { await first.close(); }

  // Deliberately pass the stale configured seed: the durable Agent edit must win.
  const second = await readinessWorkflowHarness({ backend: 'sqlite', directory, agents, reopen: true });
  try {
    const history = await fetch(`${second.base}/api/environments/enrollments/${id}/receipts/${historicalId!}`,
      { headers: { cookie: second.cookie } });
    assert.equal(history.status, 200);
    assert.equal(second.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
    const received: WorkerReadinessProbeParams[] = [];
    await second.connect(id, keyPath, { readinessProbe: async (params) => {
      received.push(params);
      const probe = { at: 82_000, latencyMs: 4, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '3', summary: 'new target' };
      return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, probe, engines: [
        { engine: 'codex', installed: true, authenticated: true, readiness: 'ready',
          modelAvailability: 'available', models: ['new-target'], targetModels: ['new-target'],
          modelIdPresent: true, requirementRevision: params.requirements!.revisionsByEngine!.codex! },
      ] }, probe };
    } });
    await waitFor(() => received.length > 0, 'post-reopen Worker request');
    assert.deepEqual(received[0]?.requirements?.modelsByEngine?.codex, ['new-target']);
    const response = await fetch(`${second.base}/api/environments/enrollments/${id}/probes`, { method: 'POST',
      headers: { cookie: second.cookie, 'x-sprout-csrf': second.csrf, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 201);
    assert.deepEqual(received.at(-1)?.requirements?.modelsByEngine?.codex, ['new-target']);
    const { receipt } = (await response.json()) as { receipt: { observationId: string } };
    assert.notEqual(receipt.observationId, historicalId!);
    const current = (await second.runtime.stores.environmentReadiness.getCurrentObservation(INSTANCE_ID))!;
    assert.equal(current.observationId, receipt.observationId);
    assert.equal(current.probe.at, 82_000, 'Worker time survives the reopened commit');
    assert.equal(second.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, true);
  } finally { await second.close(); }
});

test('#126 sqlite: SQLite reopen preserves historical receipts while requiring fresh accepted Worker evidence for current state (Scenario 13)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-126-reopen-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  // First session: connect real worker, approve, probe, record receipt R1
  const h1 = await readinessWorkflowHarness({
    backend: 'sqlite',
    directory,
    agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
  });
  const enrollmentId = (await h1.runtime.enrollments.list())[0]!.id;
  const keyPath = join(directory, 'worker-key.pem');
  const probeFact1 = {
    at: 70_000, latencyMs: 5, protocolOk: true, enginesOk: true,
    source: 'worker' as const, version: '1.0.0', summary: 'first session probe',
  };
  await h1.connect(enrollmentId, keyPath, {
    readinessProbe: async () => ({
      readiness: {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engines: [
          { engine: 'codex', version: '1.0.0', installed: true, authenticated: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-6-astra'] },
        ],
        probe: probeFact1,
      },
      probe: probeFact1,
    }),
  });
  await waitFor(
    async () => (await h1.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID)).length >= 1,
    'first startup',
  );
  const postRes1 = await fetch(`${h1.base}/api/environments/enrollments/${enrollmentId}/probes`, {
    method: 'POST',
    headers: { cookie: h1.cookie, 'x-sprout-csrf': h1.csrf, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(postRes1.status, 201);
  const postBody1 = (await postRes1.json()) as { readonly receipt: { readonly observationId: string; readonly sequence: number; readonly connectionEpoch: number } };
  const receipt1Id = postBody1.receipt.observationId;
  await h1.close();

  // Second session (reopen): before worker reconnects, old receipt is inspectable as history
  // but cannot establish current success
  const credential = randomBytes(16).toString('base64url');
  const second = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
      operatorCredential: credential,
      runtimeConfiguration: { agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }] },
    }),
    projectRoot: '/synthetic/project-root',
  });
  const { port: port2 } = await second.api.listen(0, '127.0.0.1');
  const base2 = `http://127.0.0.1:${port2}`;
  const session2 = await fetch(`${base2}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  const cookie2 = (session2.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  const { csrfToken: csrf2 } = (await session2.json()) as { csrfToken: string };

  const connections: WorkerEnrollmentConnection[] = [];
  const workers: InstanceType<typeof import('./worker/server.ts').EnvironmentWorker>[] = [];
  try {
    const reopenedGet = await fetch(`${base2}/api/environments/enrollments/${enrollmentId}/readiness`, {
      headers: { cookie: cookie2 },
    });
    assert.equal(reopenedGet.status, 200);
    const reopenedBody = (await reopenedGet.json()) as {
      readonly readiness: { readonly connection: { readonly state: string }; readonly probe?: unknown };
      readonly receipt?: unknown;
    };
    // Reopened database has no live worker connection: cannot establish current success
    assert.equal(reopenedBody.readiness.probe, undefined);
    assert.equal(reopenedBody.receipt, undefined);
    assert.equal(second.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);

    // Old receipt R1 remains directly inspectable as history
    const histReceiptRes = await fetch(`${base2}/api/environments/enrollments/${enrollmentId}/receipts/${receipt1Id}`, {
      headers: { cookie: cookie2 },
    });
    assert.equal(histReceiptRes.status, 200);
    const histReceiptBody = (await histReceiptRes.json()) as { readonly receipt: { readonly observationId: string } };
    assert.equal(histReceiptBody.receipt.observationId, receipt1Id);

    // Fresh accepted Worker evidence is required to establish current success
    const probeFact2 = {
      at: 80_000, latencyMs: 6, protocolOk: true, enginesOk: true,
      source: 'worker' as const, version: '1.0.0', summary: 'second session probe',
    };
    const { connectWorkerEnrollment } = await import('./worker/enrollment-connector.ts');
    const { EnvironmentWorker } = await import('./worker/server.ts');
    const conn2 = await connectWorkerEnrollment({
      target: { enrollmentId, host: '127.0.0.1', port: port2, claimSecret: undefined, identityKeyPath: keyPath },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engineFacts: [{ engine: 'codex', installed: true, authenticated: true, models: [] }],
    });
    connections.push(conn2);
    workers.push(new EnvironmentWorker({
      environmentInstanceId: INSTANCE_ID,
      engines: new Map(),
      input: conn2.stream,
      output: conn2.stream,
      readinessProbe: async () => ({
        readiness: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          engines: [
            { engine: 'codex', version: '1.0.0', installed: true, authenticated: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-6-astra'] },
          ],
          probe: probeFact2,
        },
        probe: probeFact2,
      }),
    }));
    await waitFor(
      () => second.workerGateway.liveFor(INSTANCE_ID) !== undefined,
      'reconnected channel',
    );

    const postRes2 = await fetch(`${base2}/api/environments/enrollments/${enrollmentId}/probes`, {
      method: 'POST',
      headers: { cookie: cookie2, 'x-sprout-csrf': csrf2, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(postRes2.status, 201);
    const postBody2 = (await postRes2.json()) as { readonly receipt: { readonly observationId: string; readonly sequence: number; readonly connectionEpoch: number } };
    assert.notEqual(postBody2.receipt.observationId, receipt1Id);
    assert.ok(postBody2.receipt.sequence > postBody1.receipt.sequence);

    // Verify durable internal store receipts track monotonic epochs
    const internal1 = await second.stores.environmentReadiness.getReceipt(INSTANCE_ID, receipt1Id);
    const internal2 = await second.stores.environmentReadiness.getReceipt(INSTANCE_ID, postBody2.receipt.observationId);
    assert.ok(internal1 && internal2);
    assert.ok(internal2.connectionEpoch > internal1.connectionEpoch);

    // Now current readiness has the fresh receipt
    const freshGet = await fetch(`${base2}/api/environments/enrollments/${enrollmentId}/readiness`, {
      headers: { cookie: cookie2 },
    });
    const freshBody = (await freshGet.json()) as { readonly receipt?: { readonly observationId: string } };
    assert.equal(freshBody.receipt?.observationId, postBody2.receipt.observationId);
  } finally {
    for (const w of workers) await w.shutdown().catch(() => undefined);
    for (const c of connections) c.close();
    await second.close();
  }
});
