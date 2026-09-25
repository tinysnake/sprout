import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough, Duplex } from 'node:stream';
import { test } from 'node:test';

import { createForegroundWorkerOptions, createWorkerCli, WORKER_EXIT } from './worker-cli.ts';
import { EnvironmentWorker } from '../server.ts';
import { WorkerReadinessClient } from '../client.ts';
import { LineJsonRpcTransport } from '../../engine/jsonrpc.ts';
import type { ReadinessCommandRunner } from '../readiness.ts';
import { WORKER_METHODS, WORKER_PROTOCOL_VERSION, type WorkerInfo } from '../protocol.ts';
import { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey, type WorkerEnrollmentConnection } from '../enrollment-connector.ts';
import { generateWorkerIdentity, signWorkerChallenge } from '../../environment/worker-proof.ts';
import { EnvironmentEnrollmentService } from '../../environment/enrollment-service.ts';
import { InMemoryEnrollmentStore } from '../../environment/enrollment-store.ts';
import { InMemoryEnvironmentReadinessStore } from '../../environment/readiness-store.ts';
import { InMemoryRecoveryStore } from '../../environment/recovery-store.ts';
import { EnvironmentRecoveryService } from '../../environment/recovery-service.ts';
import { EnvironmentArchiveService } from '../../environment/archive.ts';
import { EnvironmentPool, InMemoryLeaseStore } from '../../environment/pool.ts';
import { OperatorSessionService } from '../../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../../auth/store.ts';
import { WorkerGateway } from '../gateway.ts';
import { EnrollmentWorkerPort } from '../enrollment-port.ts';
import { EnvironmentReadinessWorkflow } from '../../environment/readiness-workflow.ts';
import { createRunApi } from '../../web/api.ts';
import { createEnvironmentRouter } from '../../web/environment-router.ts';
import { ensureStateDirectory, workerHostPaths, writePrivateFile } from './host-state.ts';

const INSTANCE_ID = 'test-worker-env-1';

function mockCommandRunner(): {
  readonly runner: ReadinessCommandRunner;
  readonly calls: { binary: string; args: readonly string[] }[];
} {
  const calls: { binary: string; args: readonly string[] }[] = [];
  const runner: ReadinessCommandRunner = {
    async run(binary, args) {
      calls.push({ binary, args });
      if (args[0] === '--version') {
        return {
          stdout: binary.includes('codex') ? 'codex-cli 0.154.0' : 'pi 0.86.1',
          exitCode: 0,
        };
      }
      if (args[0] === 'auth' && args[1] === 'check') {
        return {
          stdout: JSON.stringify({ status: 'ready', provider: 'openai-codex', authType: 'oauth' }),
          exitCode: 0,
        };
      }
      return { stdout: '{}', exitCode: 0 };
    },
    async accountRead() {
      return {
        stdout: JSON.stringify({
          account: { type: 'chatgpt', email: 'must-not-survive@example.com', planType: 'plus' },
          requiresOpenaiAuth: true,
        }),
        exitCode: 0,
      };
    },
    async bundledModels() {
      return {
        stdout: JSON.stringify({ models: [{ slug: 'gpt-6-astra' }] }),
        exitCode: 0,
      };
    },
  };
  return { runner, calls };
}

test('createForegroundWorkerOptions measures startup readiness and serves probe RPC over JSON-RPC (#143)', async () => {
  const { runner } = mockCommandRunner();
  const serverInput = new PassThrough();
  const serverOutput = new PassThrough();

  const options = await createForegroundWorkerOptions({
    input: serverInput,
    output: serverOutput,
    environmentInstanceId: INSTANCE_ID,
    locate: () => undefined,
    environment: {
      SPROUT_CODEX_BIN: '/synthetic/codex',
      SPROUT_PI_BIN: '/synthetic/pi',
    },
    readinessProbeOptions: {
      commandRunner: runner,
      clock: () => 10_000,
    },
  });

  // 1. Startup probe was measured before the first worker/info call
  const initialReadiness = options.readiness?.();
  assert.ok(initialReadiness !== undefined, 'startup readiness is present');
  assert.equal(initialReadiness.protocolVersion, '3');
  const initialCodex = initialReadiness.engines.find((e) => e.engine === 'codex');
  const initialPi = initialReadiness.engines.find((e) => e.engine === 'pi');
  assert.equal(initialCodex?.installed, true);
  assert.equal(initialCodex?.version, '0.154.0');
  assert.equal(initialCodex?.readiness, 'ready');
  assert.equal(initialCodex?.authMode, 'chatgpt');
  assert.equal(initialPi?.installed, true);
  assert.equal(initialPi?.version, '0.86.1');
  assert.equal(initialPi?.readiness, 'ready');

  const worker = new EnvironmentWorker(options);

  // Core-side transport wired directly to worker streams
  const clientTransport = new LineJsonRpcTransport({
    input: serverOutput,
    output: serverInput,
  });

  try {
    // 2. worker/info returns measured readiness facts, not the static unknown placeholder
    const info = (await clientTransport.request(WORKER_METHODS.info, {})) as WorkerInfo;
    assert.equal(info.environmentInstanceId, INSTANCE_ID);
    assert.ok(info.readiness !== undefined, 'readiness projection is present on worker/info');
    const infoCodex = info.readiness.engines.find((e: { engine: string }) => e.engine === 'codex');
    const infoPi = info.readiness.engines.find((e: { engine: string }) => e.engine === 'pi');
    assert.equal(infoCodex?.version, '0.154.0');
    assert.equal(infoCodex?.readiness, 'ready');
    assert.equal(infoPi?.version, '0.86.1');
    assert.equal(infoPi?.readiness, 'ready');

    // 3. worker/readiness-probe succeeds (does NOT throw "Worker has no non-inference readiness probe")
    const readinessClient = new WorkerReadinessClient(clientTransport);
    const probeResult = await readinessClient.probe({
      attemptId: 'obs-00000000-0000-0000-0000-000000000001',
      requiredModels: ['gpt-6-astra'],
    });

    assert.ok(probeResult !== undefined, 'probe result returned');
    assert.equal(probeResult.attemptId, 'obs-00000000-0000-0000-0000-000000000001');
    assert.equal(probeResult.probe.source, 'worker');
    assert.equal(probeResult.probe.protocolOk, true);
    assert.equal(probeResult.probe.enginesOk, true);

    const probeEngines = (('readiness' in probeResult && probeResult.readiness
      ? probeResult.readiness.engines
      : (probeResult as unknown as { engines: readonly { engine: string; version?: string; readiness: string; modelIdPresent?: boolean }[] }).engines) ?? []);
    const probedCodex = probeEngines.find((e) => e.engine === 'codex');
    assert.equal(probedCodex?.version, '0.154.0');
    assert.equal(probedCodex?.readiness, 'ready');
    assert.equal(probedCodex?.modelIdPresent, true);

    // 4. Subsequent worker/info reflects the updated measured projection
    const infoAfterProbe = (await clientTransport.request(WORKER_METHODS.info, {})) as WorkerInfo;
    const codexAfter = infoAfterProbe.readiness?.engines.find((e: { engine: string }) => e.engine === 'codex');
    assert.equal(codexAfter?.modelIdPresent, true);
  } finally {
    clientTransport.close();
    await worker.shutdown();
  }
});

test('unmeasurable engines retain minimal-honest fallback without fabricating facts (#126)', async () => {
  const { runner } = mockCommandRunner();
  const serverInput = new PassThrough();
  const serverOutput = new PassThrough();

  const options = await createForegroundWorkerOptions({
    input: serverInput,
    output: serverOutput,
    environmentInstanceId: INSTANCE_ID,
    locate: () => undefined,
    // agy cannot be measured by probeEnvironmentReadiness; extra-engine is not configured on host
    engineIds: ['codex', 'extra-engine'],
    environment: {
      SPROUT_CODEX_BIN: '/synthetic/codex',
      SPROUT_AGY_BIN: '/synthetic/agy',
    },
    readinessProbeOptions: {
      commandRunner: runner,
      clock: () => 20_000,
    },
  });

  const readiness = options.readiness?.();
  assert.ok(readiness !== undefined);

  // Codex is measured
  const codexFact = readiness.engines.find((e) => e.engine === 'codex');
  assert.equal(codexFact?.installed, true);
  assert.equal(codexFact?.readiness, 'ready');
  assert.equal(codexFact?.version, '0.154.0');

  // Agy was in configurations but cannot be measured: returns unknownFact
  const agyFact = readiness.engines.find((e) => e.engine === 'agy');
  assert.equal(agyFact?.installed, true);
  assert.equal(agyFact?.readiness, 'unknown');
  assert.equal(agyFact?.modelAvailability, 'unknown');
  assert.deepEqual(agyFact?.models, []);

  // Extra engine was in engineIds but not in host configurations: retains minimal-honest fallback
  const extraFact = readiness.engines.find((e) => e.engine === 'extra-engine');
  assert.equal(extraFact?.installed, true);
  assert.equal(extraFact?.readiness, 'unknown');
  assert.equal(extraFact?.modelAvailability, 'unknown');
  assert.deepEqual(extraFact?.models, []);

  const worker = new EnvironmentWorker(options);
  const clientTransport = new LineJsonRpcTransport({
    input: serverOutput,
    output: serverInput,
  });

  try {
    const readinessClient = new WorkerReadinessClient(clientTransport);
    const probeResult = await readinessClient.probe();
    const probeEngines = (('readiness' in probeResult && probeResult.readiness
      ? probeResult.readiness.engines
      : (probeResult as unknown as { engines: readonly { engine: string; readiness: string; modelAvailability: string }[] }).engines) ?? []);
    const probedAgy = probeEngines.find((e) => e.engine === 'agy');
    assert.equal(probedAgy?.readiness, 'unknown');
    assert.equal(probedAgy?.modelAvailability, 'unknown');
    const probedExtra = probeEngines.find((e) => e.engine === 'extra-engine');
    assert.equal(probedExtra?.readiness, 'unknown');
  } finally {
    clientTransport.close();
    await worker.shutdown();
  }
});

interface IntegrationHarness {
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
  readonly httpPort: number;
  readonly enrollments: EnvironmentEnrollmentService;
  readonly gateway: WorkerGateway;
  close(): Promise<void>;
}

async function createIntegrationHarness(): Promise<IntegrationHarness> {
  const pool = new EnvironmentPool({ definitions: [], instances: [], store: new InMemoryLeaseStore() });
  const gateways: { current: WorkerGateway | undefined } = { current: undefined };
  const enrollments = new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness: new InMemoryEnvironmentReadinessStore(),
    currentConnectionEpoch: (enrollmentId) => gateways.current?.currentConnectionEpoch(enrollmentId),
    onAuthorityLost: (enrollmentId) => gateways.current?.invalidateEnrollment(enrollmentId),
    verifyObservationAuthority: (authority, scope) => gateways.current?.verifyObservationAuthority(authority, scope),
    idFactory: () => 'enroll-cli-1',
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

  return {
    base,
    cookie,
    csrf: csrfToken,
    httpPort,
    enrollments,
    gateway,
    async close() {
      gateway.close();
      await api.close();
      await port.close();
    },
  };
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('Worker served via foreground serve path satisfies Issue #143 acceptance criteria', async (t) => {
  const h = await createIntegrationHarness();
  const directory = mkdtempSync(join(tmpdir(), 'sprout-143-test-'));
  const keyPath = join(directory, 'worker-key.pem');

  // Step 1: Enroll and approve
  const requested = await h.enrollments.requestEnrollment({
    environmentInstanceId: INSTANCE_ID,
    displayName: 'CLI Worker',
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  const secret = requested.claim?.secret ?? '';
  const host = loadOrCreateWorkerIdentity(keyPath);
  await h.enrollments.claimEnrollment('enroll-cli-1', secret);
  const challenge = await h.enrollments.issueChallenge('enroll-cli-1');
  await h.enrollments.connectWorker({
    enrollmentId: 'enroll-cli-1',
    proof: {
      challengeId: challenge.id,
      publicKey: workerPublicKey(host.privateKey),
      signature: signWorkerChallenge(host.privateKey, challenge),
    },
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: WORKER_PROTOCOL_VERSION },
    engines: [],
  });
  await h.enrollments.approve('enroll-cli-1', { capabilityPermissions: { 'agent-run': true } });

  // Acceptance Criterion 3: A probe against a Worker without a live connection returns typed 409 offline refusal (#142)
  const offlineResponse = await fetch(`${h.base}/api/environments/enrollments/enroll-cli-1/probes`, {
    method: 'POST',
    headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(offlineResponse.status, 409);
  const offlineBody = (await offlineResponse.json()) as { error: string; code?: string };
  assert.equal(offlineBody.error, 'the Environment Worker is offline');
  assert.equal(offlineBody.code, 'unavailable');

  // Step 2: Establish the real outbound Worker connection over WebSocket,
  // and serve it using createForegroundWorkerOptions (the exact helper serveForeground uses).
  const { runner } = mockCommandRunner();
  const connection = await connectWorkerEnrollment({
    target: {
      enrollmentId: 'enroll-cli-1',
      host: '127.0.0.1',
      port: h.httpPort,
      claimSecret: undefined,
      identityKeyPath: keyPath,
    },
    protocolVersion: WORKER_PROTOCOL_VERSION,
    engineFacts: [{ engine: 'codex', installed: true, authenticated: true, models: [] }],
  });

  const workerOptions = await createForegroundWorkerOptions({
    stream: connection.stream,
    environmentInstanceId: INSTANCE_ID,
    locate: () => undefined,
    environment: {
      SPROUT_CODEX_BIN: '/synthetic/codex',
    },
    readinessProbeOptions: {
      commandRunner: runner,
      clock: () => 30_000,
    },
  });

  const worker = new EnvironmentWorker(workerOptions);
  t.after(async () => {
    await worker.shutdown().catch(() => undefined);
    connection.stream.destroy();
    connection.close();
    await h.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await waitFor(() => h.gateway.liveFor(INSTANCE_ID) !== undefined, 'gateway registered live channel');

  // Acceptance Criterion 1: With a Worker served via serveForeground helper,
  // a Human-requested probe returns 201 with committed receipt and observed engine facts.
  const probeResponse = await fetch(`${h.base}/api/environments/enrollments/enroll-cli-1/probes`, {
    method: 'POST',
    headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const probeText = await probeResponse.text();
  assert.equal(probeResponse.status, 201, `Expected 201, got ${probeResponse.status}: ${probeText}`);

  const probeBody = JSON.parse(probeText) as {
    probe: { source?: string; version?: string; enginesOk: boolean };
    readiness?: { engines: readonly { engine: string; version?: string; installed: boolean; readiness: string }[] };
  };
  assert.equal(probeBody.probe.source, 'worker');
  assert.equal(probeBody.probe.version, '0.154.0');
  assert.equal(probeBody.probe.enginesOk, true);

  // Acceptance Criterion 2: The readiness projection after the probe reflects the Worker's
  // measured engines (installed/readiness/models), not the static 'unknown' placeholder.
  const readinessResponse = await fetch(`${h.base}/api/environments/enrollments/enroll-cli-1/readiness`, {
    headers: { cookie: h.cookie },
  });
  assert.equal(readinessResponse.status, 200);
  const readinessBody = (await readinessResponse.json()) as {
    readiness: {
      enrollmentStatus: string;
      engines: readonly { engine: string; version?: string; installed: boolean; readiness: string; modelIdPresent?: boolean }[];
      probe?: { version?: string };
    };
    probes: readonly { version?: string }[];
  };
  assert.equal(readinessBody.readiness.enrollmentStatus, 'approved');
  assert.equal(readinessBody.readiness.probe?.version, '0.154.0');
  const codexReadiness = readinessBody.readiness.engines.find((e) => e.engine === 'codex');
  assert.equal(codexReadiness?.installed, true);
  assert.equal(codexReadiness?.version, '0.154.0');
  assert.equal(codexReadiness?.readiness, 'ready');
  assert.equal(codexReadiness?.modelIdPresent, true);
  assert.equal(readinessBody.probes.length >= 1, true);
  assert.equal(readinessBody.probes[0]?.version, '0.154.0');
});

test('createWorkerCli start serves foreground with registered readiness probe (#143)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-cli-readiness-'));
  const paths = workerHostPaths({
    HOME: root,
    SPROUT_WORKER_HOME: join(root, 'state'),
    SPROUT_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents'),
    SPROUT_CLI_PATH: '/synthetic/bin/sprout',
  });
  const out: string[] = [];
  const err: string[] = [];
  const { runner } = mockCommandRunner();

  // Create stream pair for the simulated outbound connection
  const toWorker = new PassThrough();
  const toClient = new PassThrough();

  const clientTransport = new LineJsonRpcTransport({
    input: toClient,
    output: toWorker,
  });

  const connectionStream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      toClient.write(chunk);
      callback();
    },
    destroy(error, callback) {
      toWorker.destroy(error ?? undefined);
      toClient.destroy(error ?? undefined);
      callback(error);
    },
  });
  toWorker.on('data', (chunk) => connectionStream.push(chunk));
  toWorker.on('end', () => connectionStream.push(null));

  const connection: WorkerEnrollmentConnection = {
    stream: connectionStream,
    enrollmentId: 'enroll-synth-1',
    environmentInstanceId: 'env-synth-1',
    epoch: 1,
    connectionId: 'c-1',
    close: () => {
      connectionStream.destroy();
    },
  };

  const cli = createWorkerCli({
    paths: () => paths,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    connect: async () => connection,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    readinessProbeOptions: {
      commandRunner: runner,
      clock: () => 40_000,
    },
  });

  ensureStateDirectory(paths);
  writePrivateFile(paths.configPath, JSON.stringify({
    version: 1,
    enrollmentId: 'enroll-synth-1',
    environmentInstanceId: 'env-synth-1',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    endpoint: { host: '127.0.0.1', port: 5174 },
    identityFileName: 'identity.pem',
  }));
  writePrivateFile(paths.identityPath, generateWorkerIdentity().privateKey);

  try {
    // Run start without dependencies.serve; it will run serveForeground
    const startPromise = cli.run(['start'], {
      PATH: '',
      SPROUT_CODEX_BIN: '/synthetic/codex',
    });

    // Probe the foreground worker over clientTransport
    const readinessClient = new WorkerReadinessClient(clientTransport);
    const probeResult = await readinessClient.probe({ requiredModels: ['gpt-6-astra'] });
    assert.equal(probeResult.probe.source, 'worker');
    const probeEngines = (('readiness' in probeResult && probeResult.readiness
      ? probeResult.readiness.engines
      : (probeResult as unknown as { engines: readonly { engine: string; version?: string }[] }).engines) ?? []);
    const codex = probeEngines.find((e) => e.engine === 'codex');
    assert.equal(codex?.version, '0.154.0');

    // Close the connection stream so serveForeground exits cleanly
    connection.close();
    assert.equal(await startPromise, WORKER_EXIT.ok);
  } finally {
    clientTransport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

