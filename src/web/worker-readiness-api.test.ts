/**
 * API-level readiness lifecycle integration for #118 (R118-API-002).
 *
 * These tests replace the synthetic `requestProbe` seam with the **real**
 * production chain: a real `EnvironmentEnrollmentService`, the real
 * `WorkerGateway` accepting a real outbound Worker connection, the real
 * `EnrollmentWorkerPort`, the real `EnvironmentReadinessWorkflow` explicit
 * `request()` trigger (the Human-requested probe mode), and the real HTTP
 * `EnvironmentRouter` behind the Human auth boundary. The Worker's neutral
 * JSON-RPC server runs over the accepted channel and its probe can be delayed,
 * so a revoke/reset/disconnect can be interleaved into the response window.
 *
 * What this proves that a synthetic seam cannot:
 * - the browser POST and GET cross the authenticated gateway epoch;
 * - revoke/reset close the accepted channel and invalidate the epoch;
 * - a POST whose Worker response is delayed past a revoke never returns the old
 *   probe, and GET never projects stale current facts;
 * - a channel close removes current facts without deleting durable history.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';
import { InMemoryEnrollmentStore } from '../environment/enrollment-store.ts';
import { InMemoryEnvironmentReadinessStore } from '../environment/readiness-store.ts';
import { InMemoryRecoveryStore } from '../environment/recovery-store.ts';
import { EnvironmentRecoveryService } from '../environment/recovery-service.ts';
import { EnvironmentArchiveService } from '../environment/archive.ts';
import { EnvironmentPool, InMemoryLeaseStore } from '../environment/pool.ts';
import { OperatorSessionService } from '../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../auth/store.ts';
import { WorkerGateway } from '../worker/gateway.ts';
import { EnrollmentWorkerPort } from '../worker/enrollment-port.ts';
import { EnvironmentReadinessWorkflow } from '../environment/readiness-workflow.ts';
import { EnvironmentWorker } from '../worker/server.ts';
import { WORKER_PROTOCOL_VERSION, type WorkerReadinessFacts, type WorkerReadinessProbeParams, type WorkerReadinessProbeResult } from '../worker/protocol.ts';
import { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } from '../worker/enrollment-connector.ts';
import type { WorkerEnrollmentConnection } from '../worker/enrollment-connector.ts';
import { signWorkerChallenge } from '../environment/worker-proof.ts';
import { createRunApi } from './api.ts';
import { createEnvironmentRouter } from './environment-router.ts';

const INSTANCE_ID = 'mac-mini-1';

interface Harness {
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
  readonly enrollments: EnvironmentEnrollmentService;
  readonly gateway: WorkerGateway;
  connect(
    keyPath: string,
    readinessProbe?: (params: WorkerReadinessProbeParams) => Promise<WorkerReadinessFacts | WorkerReadinessProbeResult>,
  ): Promise<WorkerEnrollmentConnection>;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const pool = new EnvironmentPool({ definitions: [], instances: [], store: new InMemoryLeaseStore() });
  const gateways: { current: WorkerGateway | undefined } = { current: undefined };
  const enrollments = new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness: new InMemoryEnvironmentReadinessStore(),
    currentConnectionEpoch: (enrollmentId) => gateways.current?.epochs.current(enrollmentId)?.epoch,
    onAuthorityLost: (enrollmentId) => gateways.current?.invalidateEnrollment(enrollmentId),
    idFactory: () => 'enroll-1',
    clock: () => 10_000,
  });
  const recovery = new EnvironmentRecoveryService({
    store: new InMemoryRecoveryStore(),
    leases: pool,
    clock: () => 10_000,
  });
  const archive = new EnvironmentArchiveService({
    enrollments: new InMemoryEnrollmentStore(),
    leases: pool,
    recovery,
    lifecycleAuthority: enrollments.lifecycleAuthority,
    clock: () => 10_000,
  });
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  const credential = randomBytes(32).toString('base64url');
  await auth.initializeOrRecover(credential);

  const gateway = new WorkerGateway({
    enrollments,
    handshakeTimeoutMs: 5_000,
    requiredModels: () => ['gpt-6-astra'],
  });
  gateways.current = gateway;
  const port = new EnrollmentWorkerPort({ gateway });

  const workflow = new EnvironmentReadinessWorkflow({
    enrollments,
    workerGateway: gateway,
    workerEpochs: gateway.epochs,
    environment: port,
    refreshEnvironmentCatalog: async () => undefined,
  });
  const requestProbe = (enrollmentId: string) => workflow.request(enrollmentId);
  const api = createRunApi({
    orchestrator: { subscribe: () => () => undefined, load: async () => undefined } as never,
    agents: { list: () => [], get: () => undefined } as never,
    auth,
    workerGateway: gateway,
    routers: [createEnvironmentRouter({ enrollments, recovery, archive, requestProbe })],
  });
  const { port: httpPort } = await api.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${httpPort}`;
  const session = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  assert.equal(session.status, 201);
  const cookie = (session.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  const { csrfToken } = (await session.json()) as { csrfToken: string };

  const workers: EnvironmentWorker[] = [];
  const connections: WorkerEnrollmentConnection[] = [];
  return {
    base,
    cookie,
    csrf: csrfToken,
    enrollments,
    gateway,
    async connect(keyPath, readinessProbe) {
      const connection = await connectWorkerEnrollment({
        target: { enrollmentId: 'enroll-1', host: '127.0.0.1', port: httpPort, claimSecret: undefined, identityKeyPath: keyPath },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engineFacts: [{ engine: 'pi', installed: true, authenticated: true, models: [] }],
      });
      connections.push(connection);
      const declaration: WorkerReadinessFacts = {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engines: [{
          engine: 'pi', version: '0.86.1', installed: true, readiness: 'ready',
          modelAvailability: 'unknown', models: [], authenticated: true,
          authType: 'oauth', modelIdPresent: false, probedAt: 1, probeExitCode: 0, source: 'pi-auth-check',
        }],
      };
      workers.push(new EnvironmentWorker({
        environmentInstanceId: INSTANCE_ID,
        engines: new Map(),
        input: connection.stream,
        output: connection.stream,
        readiness: () => declaration,
        readinessProbe: async (params) => {
          const supplied = readinessProbe === undefined ? declaration : await readinessProbe(params);
          // Invalid-result fixtures intentionally cross this real JSON-RPC
          // boundary. The core, not this test Worker, must reject them.
          if ('readiness' in supplied && 'probe' in supplied) return supplied;
          const readiness = supplied;
          const probe = {
            at: 5_000, latencyMs: 9, protocolOk: true, enginesOk: true, source: 'worker' as const,
            version: '0.86.1', summary: 'Worker non-inference readiness probe completed.',
          };
          // Production `runProbe()` returns readiness documents that embed the
          // probe they were produced with; the core records the embedded one.
          return { readiness: { ...readiness, probe }, probe };
        },
      }));
      return connection;
    },
    async close() {
      for (const worker of workers) await worker.shutdown().catch(() => undefined);
      for (const connection of connections) connection.close();
      await api.close();
      await port.close();
    },
  };
}

function post(h: Harness, path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(h: Harness, path: string): Promise<Response> {
  return fetch(`${h.base}${path}`, { headers: { cookie: h.cookie } });
}

/** Claim, prove, and approve using the same host key the connector uses. */
async function enrollAndApprove(h: Harness, keyPath: string): Promise<void> {
  const requested = await h.enrollments.requestEnrollment({
    environmentInstanceId: INSTANCE_ID,
    displayName: 'Local Mac',
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  const secret = requested.claim?.secret ?? '';
  const host = loadOrCreateWorkerIdentity(keyPath);
  await h.enrollments.claimEnrollment('enroll-1', secret);
  const challenge = await h.enrollments.issueChallenge('enroll-1');
  await h.enrollments.connectWorker({
    enrollmentId: 'enroll-1',
    proof: {
      challengeId: challenge.id,
      publicKey: workerPublicKey(host.privateKey),
      signature: signWorkerChallenge(host.privateKey, challenge),
    },
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: WORKER_PROTOCOL_VERSION },
    engines: [],
  });
  await h.enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
}

function tmpKey(): { readonly path: string; readonly cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-118-api-'));
  return { path: join(directory, 'worker-key.pem'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a pending enrollment has no probe authority over the real gateway (R118-API-002)', async (t) => {
  const h = await harness();
  const key = tmpKey();
  t.after(async () => { key.cleanup(); await h.close(); });
  await h.enrollments.requestEnrollment({
    environmentInstanceId: INSTANCE_ID, displayName: 'Local Mac', platform: 'macos',
    capabilityRequests: ['agent-run'], engineFacts: [],
  });
  assert.equal((await post(h, '/api/environments/enrollments/enroll-1/probes', { forged: true })).status, 409);
});

test('a real accepted Worker probe crosses the gateway epoch and GET returns coherent facts (R118-API-002)', async (t) => {
  const h = await harness();
  const key = tmpKey();
  t.after(async () => { key.cleanup(); await h.close(); });
  await enrollAndApprove(h, key.path);
  await h.connect(key.path);
  await waitFor(() => h.gateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel register');

  const probe = await post(h, '/api/environments/enrollments/enroll-1/probes');
  const probeText = await probe.text();
  assert.equal(probe.status, 201, probeText);
  const body = JSON.parse(probeText) as { probe: { latencyMs: number; source?: string; version?: string } };
  assert.equal(body.probe.latencyMs, 9, 'the Worker-measured latency is returned, not a browser value');
  assert.equal(body.probe.source, 'worker');
  assert.equal(body.probe.version, '0.86.1');

  const readiness = await get(h, '/api/environments/enrollments/enroll-1/readiness');
  assert.equal(readiness.status, 200);
  const readinessBody = (await readiness.json()) as {
    readiness: { enrollmentStatus: string; engines: { engine: string; version?: string }[]; probe?: { version?: string } };
    probes: readonly { version?: string }[];
  };
  assert.equal(readinessBody.readiness.enrollmentStatus, 'approved');
  assert.equal(readinessBody.readiness.engines[0]?.version, '0.86.1');
  assert.equal(readinessBody.readiness.probe?.version, '0.86.1');
  assert.deepEqual(readinessBody.probes.map((p) => p.version), ['0.86.1']);
});

test('POST returns the committed sanitized probe when the Worker version is unknown (R118-API-002)', async (t) => {
  const h = await harness();
  const key = tmpKey();
  t.after(async () => { key.cleanup(); await h.close(); });
  await enrollAndApprove(h, key.path);
  await h.connect(key.path, async () => {
    const probe = {
      at: 5_000, latencyMs: 9, protocolOk: true, enginesOk: true,
      source: 'worker' as const, version: 'unknown', summary: 'Worker probe version unavailable.',
    };
    return {
      readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe },
      probe,
    };
  });
  await waitFor(() => h.gateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel register');

  const response = await post(h, '/api/environments/enrollments/enroll-1/probes');
  const responseText = await response.text();
  assert.equal(response.status, 201, responseText);
  const returned = JSON.parse(responseText) as { probe: { version?: string } };
  assert.equal(returned.probe.version, 'unknown-version');
  const committed = await h.enrollments.listProbes('enroll-1');
  assert.equal(committed.at(-1)?.version, 'unknown-version');
  assert.deepEqual(returned.probe, {
    at: committed.at(-1)?.at,
    latencyMs: committed.at(-1)?.latencyMs,
    protocolOk: committed.at(-1)?.protocolOk,
    enginesOk: committed.at(-1)?.enginesOk,
    source: committed.at(-1)?.source,
    version: committed.at(-1)?.version,
    summary: committed.at(-1)?.summary,
  });
});

test('the authenticated JSON-RPC probe receives only core-configured target models (R118-MODEL-004)', async (t) => {
  const h = await harness();
  const key = tmpKey();
  t.after(async () => { key.cleanup(); await h.close(); });
  await enrollAndApprove(h, key.path);
  let received: WorkerReadinessProbeParams | undefined;
  await h.connect(key.path, async (params) => {
    received = params;
    return {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engines: [{
        engine: 'pi', version: '0.86.1', installed: true, readiness: 'ready',
        modelAvailability: 'unknown', models: [], authenticated: true,
        authType: 'oauth', modelIdPresent: false, probedAt: 1, probeExitCode: 0, source: 'pi-auth-check',
      }],
    };
  });
  await waitFor(() => h.gateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel register');
  assert.equal((await post(h, '/api/environments/enrollments/enroll-1/probes', { requiredModels: ['browser-forgery'] })).status, 201);
  assert.deepEqual(received, { requiredModels: ['gpt-6-astra'] });
});

test('missing or mismatched JSON-RPC probe facts are never committed or returned (R118-API-002)', async (t) => {
  for (const result of [
    // Missing the embedded observation makes POST/GET incoherent.
    {
      readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [] },
      probe: { at: 5_000, latencyMs: 9, protocolOk: true, enginesOk: true, source: 'worker', version: '0.86.1', summary: 'probe' },
    },
    // Both shapes are valid individually but must describe the same fact.
    {
      readiness: {
        protocolVersion: WORKER_PROTOCOL_VERSION, engines: [],
        probe: { at: 5_000, latencyMs: 9, protocolOk: true, enginesOk: true, source: 'worker', version: '0.86.1', summary: 'embedded' },
      },
      probe: { at: 5_000, latencyMs: 9, protocolOk: true, enginesOk: true, source: 'worker', version: '0.86.1', summary: 'returned' },
    },
  ]) {
    const h = await harness();
    const key = tmpKey();
    t.after(async () => { key.cleanup(); await h.close(); });
    await enrollAndApprove(h, key.path);
    await h.connect(key.path, async () => result as unknown as WorkerReadinessProbeResult);
    await waitFor(() => h.gateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel register');
    const response = await post(h, '/api/environments/enrollments/enroll-1/probes');
    assert.notEqual(response.status, 201);
    assert.equal((await response.json() as { probe?: unknown }).probe, undefined);
    const readiness = await get(h, '/api/environments/enrollments/enroll-1/readiness');
    assert.deepEqual((await readiness.json() as { probes: readonly unknown[] }).probes, []);
  }
});

test('provider, account, and unknown probe sources from real JSON-RPC never reach GET or POST (R118-BOUNDARY-003)', async (t) => {
  for (const source of ['provider-account', 'openai-codex', 'unknown']) {
    const h = await harness();
    const key = tmpKey();
    t.after(async () => { key.cleanup(); await h.close(); });
    await enrollAndApprove(h, key.path);
    await h.connect(key.path, async () => ({
      readiness: {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engines: [],
        probe: {
          at: 5_000, latencyMs: 9, protocolOk: true, enginesOk: true,
          source, version: '0.86.1', summary: 'safe summary',
        },
      },
      probe: {
        at: 5_000, latencyMs: 9, protocolOk: true, enginesOk: true,
        source, version: '0.86.1', summary: 'safe summary',
      },
    }) as unknown as WorkerReadinessProbeResult);
    await waitFor(() => h.gateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel register');
    const response = await post(h, '/api/environments/enrollments/enroll-1/probes');
    assert.notEqual(response.status, 201);
    const responseText = await response.text();
    assert.equal((JSON.parse(responseText) as { probe?: unknown }).probe, undefined);
    if (source !== 'unknown') assert.equal(responseText.includes(source), false);
    const readiness = await get(h, '/api/environments/enrollments/enroll-1/readiness');
    const readinessText = await readiness.text();
    const readinessBody = JSON.parse(readinessText) as {
      readonly readiness: { readonly probe?: { readonly source?: string } };
      readonly probes: readonly { readonly source?: string }[];
    };
    assert.equal(readinessBody.readiness.probe?.source, undefined);
    assert.deepEqual(readinessBody.probes.map((probe) => probe.source), []);
    if (source !== 'unknown') assert.equal(readinessText.includes(source), false);
    assert.deepEqual(await h.enrollments.listProbes('enroll-1'), []);
  }
});

test('revoke closes the real channel and no GET/POST fact survives the lifecycle (R118-API-002)', async (t) => {
  const h = await harness();
  const key = tmpKey();
  t.after(async () => { key.cleanup(); await h.close(); });
  await enrollAndApprove(h, key.path);
  await h.connect(key.path);
  await waitFor(() => h.gateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel register');
  assert.equal((await post(h, '/api/environments/enrollments/enroll-1/probes')).status, 201);

  const connection = h.gateway.liveFor(INSTANCE_ID)!;
  await h.enrollments.revoke('enroll-1', 'retired');
  assert.equal(h.gateway.liveFor(INSTANCE_ID), undefined, 'the accepted channel is removed synchronously');
  assert.equal(h.gateway.epochs.current('enroll-1'), undefined, 'the epoch is invalidated');
  assert.equal(connection.epoch.epoch, 1);

  const readiness = await get(h, '/api/environments/enrollments/enroll-1/readiness');
  const body = (await readiness.json()) as {
    readiness: { enrollmentStatus: string; connection: { state: string }; engines: { installed: boolean }[]; probe?: unknown };
    probes: readonly unknown[];
  };
  assert.equal(body.readiness.enrollmentStatus, 'revoked');
  assert.equal(body.readiness.connection.state, 'never-connected');
  assert.equal(body.readiness.engines[0]?.installed, undefined, 'no stale installed/current fact');
  assert.equal(body.readiness.probe, undefined, 'no stale current probe');
  assert.deepEqual(body.probes, [], 'revoked history is not projected as current');

  assert.equal((await post(h, '/api/environments/enrollments/enroll-1/probes')).status, 409);
});

test('reset over the real gateway invalidates the epoch and returns no current facts (R118-API-002)', async (t) => {
  const h = await harness();
  const key = tmpKey();
  t.after(async () => { key.cleanup(); await h.close(); });
  await enrollAndApprove(h, key.path);
  await h.connect(key.path);
  await waitFor(() => h.gateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel register');
  assert.equal((await post(h, '/api/environments/enrollments/enroll-1/probes')).status, 201);

  await h.enrollments.reset('enroll-1', 'rotate');
  assert.equal(h.gateway.liveFor(INSTANCE_ID), undefined);
  assert.equal(h.gateway.epochs.current('enroll-1'), undefined);

  const body = (await (await get(h, '/api/environments/enrollments/enroll-1/readiness')).json()) as {
    readiness: { enrollmentStatus: string; probe?: unknown; connection: { state: string } };
    probes: readonly unknown[];
  };
  assert.equal(body.readiness.enrollmentStatus, 'pending');
  assert.equal(body.readiness.probe, undefined);
  assert.deepEqual(body.probes, []);
  assert.equal((await post(h, '/api/environments/enrollments/enroll-1/probes')).status, 409);
});

test('a revoke inside the real probe response window never returns the old probe (R118-API-002)', async (t) => {
  const h = await harness();
  const key = tmpKey();
  t.after(async () => { key.cleanup(); await h.close(); });
  await enrollAndApprove(h, key.path);
  // Delay the Worker probe so the revoke lands while the response is in flight.
  let releaseProbe: (() => void) | undefined;
  const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
  let probeStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { probeStarted = resolve; });
  await h.connect(key.path, async () => {
    probeStarted?.();
    await probeGate;
    return {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engines: [{
        engine: 'pi', version: '0.86.1', installed: true, readiness: 'ready',
        modelAvailability: 'unknown', models: [], authenticated: true,
        authType: 'oauth', modelIdPresent: false, probedAt: 1, probeExitCode: 0, source: 'pi-auth-check',
      }],
    };
  });
  await waitFor(() => h.gateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel register');

  const pending = post(h, '/api/environments/enrollments/enroll-1/probes');
  await started;
  await h.enrollments.revoke('enroll-1', 'retired mid-probe');
  releaseProbe?.();
  const response = await pending;
  assert.notEqual(response.status, 201, 'a superseded response is never reported as a successful probe');
  const body = (await response.json()) as { probe?: unknown };
  assert.equal(body.probe, undefined, 'no stale probe payload is returned');
});

test('a channel close removes current facts without deleting probe history (R118-API-002)', async (t) => {
  const h = await harness();
  const key = tmpKey();
  t.after(async () => { key.cleanup(); await h.close(); });
  await enrollAndApprove(h, key.path);
  await h.connect(key.path);
  await waitFor(() => h.gateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel register');
  assert.equal((await post(h, '/api/environments/enrollments/enroll-1/probes')).status, 201);

  // Closing the accepted channel (the Worker disconnecting) invalidates the
  // epoch through the gateway's close listener.
  h.gateway.liveFor(INSTANCE_ID)!.close();
  await waitFor(() => h.gateway.liveFor(INSTANCE_ID) === undefined, 'channel close invalidates the epoch');

  const body = (await (await get(h, '/api/environments/enrollments/enroll-1/readiness')).json()) as {
    readiness: { connection: { state: string }; engines: { installed: boolean }[]; probe?: unknown };
    probes: readonly unknown[];
  };
  assert.notEqual(body.readiness.connection.state, 'online', 'a dead channel is not reported online');
  assert.equal(body.readiness.engines[0]?.installed, undefined, 'no current engine fact without a live epoch');
  assert.equal(body.readiness.probe, undefined, 'no current probe without a live epoch');
  assert.deepEqual(body.probes.map((p) => (p as { version?: string }).version), ['0.86.1'], 'durable probe history remains inspectable across a disconnect');
});
