import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { createReadinessAuthorityTestSeam } from './environment/readiness-authority.test-support.ts';
import {
  type WorkerInfo,
} from './worker/protocol.ts';
import {
  loadOrCreateWorkerIdentity,
  workerPublicKey,
} from './worker/enrollment-connector.ts';
import {
  connectRuntimeWorker,
  createRuntime,
  hostConfiguration,
  inMemoryStores,
  INSTANCE_ID,
  observeSyntheticReady,
  readinessAuthority,
  runtimePort,
  runtimePorts,
  scriptedEnvironment,
  scriptedReadinessProbe,
  testComposition,
  waitFor,
} from './runtime-test-harness.ts';

test('the composed runtime exposes durable enrollment and readiness through its router and SQLite store (#87)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-enrollment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'sprout.db');

  const environment = scriptedEnvironment({
    adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
  });
  // A real SQLite store, so this proves the enrollment domain is mounted on the
  // same durable handle as every other M2 domain rather than a test double.
  const runtime = await createRuntime({
    configuration: hostConfiguration({ databasePath }),
    projectRoot: '/synthetic/project-root',
    environment,
  });
  try {
    const keyPath = join(directory, 'worker-key.pem');
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID,
      displayName: 'Composed Environment',
      publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos',
      protocolVersion: '2.1',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    assert.equal(requested.enrollment.environmentInstanceId, INSTANCE_ID);

    await runtime.enrollments.approve(requested.enrollment.id, {
      capabilityPermissions: { 'agent-run': true },
    });
    await connectRuntimeWorker(runtime, requested.enrollment.id, keyPath);
    // Only the engine this build's configured Agents actually run on is required,
    // so a single ready engine is a complete Environment.
    await waitFor(async () => (await runtime.enrollments.readiness(requested.enrollment.id)).receipt !== undefined,
      'accepted Worker bootstrap receipt');

    const assembled = await runtime.enrollments.readiness(requested.enrollment.id);
    assert.equal(assembled.summary.level, 'green', assembled.summary.reason);
    assert.ok(assembled.summary.reason.length > 0);
    // The configured engine is the one required engine; no second engine is
    // fabricated as required by an empty configuration.
    assert.equal(
      assembled.readiness.engines.find((engine) => engine.engine === 'scripted')?.required,
      true,
    );
    assert.equal(
      assembled.readiness.engines.some((engine) => engine.engine === 'pi'),
      false,
      'no unconfigured engine is invented',
    );

    // The same composition serves the router over HTTP.
    const port = await runtimePort(runtime);
    const listing = await fetch(`http://127.0.0.1:${port}/api/environments/enrollments`);
    assert.equal(listing.status, 401, 'the enrollment route stays behind the #84 auth boundary');
  } finally {
    await runtime.close();
  }
});

test('the runtime refuses to observe readiness without an accepted Worker epoch (#87)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-worker-readiness-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'sprout.db');

  // The Worker reports what it verified: installed engines with honestly
  // unknown login and model state, exactly what `worker/info` now declares.
  const workerInfo: WorkerInfo = {
    pid: 4242,
    environmentInstanceId: INSTANCE_ID,
    engines: [],
    readiness: {
      protocolVersion: '2.1',
      engines: [
        { engine: 'scripted', installed: true, readiness: 'unknown', modelAvailability: 'unknown', models: [] },
      ],
    },
  };
  let infoReads = 0;
  const environment = {
    ...scriptedEnvironment({
      adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
    }),
    async info() {
      infoReads += 1;
      return workerInfo;
    },
  };
  const runtime = await createRuntime({
    configuration: hostConfiguration({ databasePath }),
    projectRoot: '/synthetic/project-root',
    environment,
  });
  try {
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID,
      displayName: 'Composed Environment',
      publicKey: 'composed-public-key',
      platform: 'macos',
      protocolVersion: '2.1',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;

    // A pending enrollment is not observed: authority comes first.
    // No accepted Worker exists: approval alone is not evidence.
    assert.equal(infoReads, 0, 'no Worker info is read before approval');

    await runtime.enrollments.approve(enrollmentId, { capabilityPermissions: { 'agent-run': true } });
    // Approval alone cannot collect Worker facts.
    assert.equal(infoReads, 0, 'approval alone cannot mint Worker observation authority');

    const assembled = await runtime.enrollments.readiness(enrollmentId);
    assert.equal(assembled.readiness.connection.state, 'never-connected');
    assert.equal(assembled.readiness.compatibility.state, 'unknown');
    const engine = assembled.readiness.engines[0];
    assert.equal(engine?.engine, 'scripted');
    assert.equal(engine?.installed, false, 'no accepted epoch means no executable fact');
    assert.equal(engine?.readiness, 'unknown');
    assert.equal(engine?.models.state, 'unknown');
    assert.equal(assembled.summary.level, 'red', 'an unknown required engine blocks work honestly');

    // A revoked enrollment stops being observed; the last approved observation
    // is never overwritten by an unapproved Worker.
    await runtime.enrollments.revoke(enrollmentId, 'rotated');
    // Revocation cannot collect Worker facts.
    assert.equal(infoReads, 0, 'no Worker info is read after revocation');
  } finally {
    await runtime.close();
  }
});

test('the composed runtime exposes the outbound Worker gateway without its epoch issuer (#115)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-gateway-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = scriptedEnvironment({
    adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
  });
  const runtime = await createRuntime({
    configuration: hostConfiguration({ databasePath: join(directory, 'sprout.db') }),
    projectRoot: '/synthetic/project-root',
    environment,
  });
  try {
    assert.notEqual(runtime.workerGateway, undefined);
    assert.equal('epochs' in runtime.workerGateway, false, 'the mutable epoch issuer is not application-facing');
    assert.notEqual(runtime.enrollmentEnvironment, undefined);

    // A Web-created pending enrollment carries a one-use claim, and the machine
    // claim route consumes it without a browser cookie.
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID,
      displayName: 'Outbound Environment',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    const secret = requested.claim?.secret ?? '';
    assert.notEqual(secret, '');
    const { port } = await runtime.api.listen(0);
    runtimePorts.set(runtime, Promise.resolve(port));
    const claimed = await fetch(
      `http://127.0.0.1:${port}/api/worker/enrollments/${encodeURIComponent(requested.enrollment.id)}/claim`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimSecret: secret }),
      },
    );
    assert.equal(claimed.status, 200);
    assert.equal(claimed.headers.get('set-cookie'), null, 'the machine route sets no Human cookie');
  } finally {
    await runtime.close();
  }
});

test('production Runtime rejects an isolated test verifier capability (R125-AUTH-001)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-authority-boundary-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
    stores: inMemoryStores(),
  });
  try {
    const keyPath = join(directory, 'worker-key.pem');
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const { enrollment } = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'authority-boundary-host',
      displayName: 'Authority Boundary Host',
      publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.id, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    await connectRuntimeWorker(runtime, enrollment.id, keyPath);
    const live = runtime.workerGateway.liveFor(enrollment.environmentInstanceId)!;
    const foreignAuthority = createReadinessAuthorityTestSeam().mint({
      environmentInstanceId: enrollment.environmentInstanceId,
      enrollmentId: enrollment.id,
      connectionId: live.epoch.connectionId,
      connectionEpoch: live.epoch.epoch,
      lifecycleGeneration: testComposition(runtime).enrollments.lifecycleAuthority.generation(enrollment.id),
      isCurrent: () => true,
    });

    assert.equal(
      await testComposition(runtime).enrollments.observeReadiness(enrollment.id, scriptedReadinessProbe(), foreignAuthority),
      false,
      'production composition verifies only capabilities minted by its authenticated Gateway',
    );
    assert.equal(await runtime.stores.environmentReadiness.getReadiness(enrollment.environmentInstanceId), undefined);
  } finally {
    await runtime.close();
  }
});

test('the enrollment environment source composes without a configured carrier', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-enrollment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
    stores: inMemoryStores(),
  });
  try {
    assert.equal(runtime.environmentSource, 'enrollment');
    assert.equal(runtime.engines.size, 0, 'no configured Worker is started or dialed');
    assert.notEqual(runtime.enrollmentEnvironment, undefined);
    assert.equal(runtime.definition, undefined, 'no static configured definition exists under enrollment');
    assert.equal(runtime.instance, undefined, 'no static configured instance exists under enrollment');
    assert.equal(runtime.environmentCatalog.entries().length, 0, 'production starts with zero Environments');
    // A run cannot resolve a Worker before an instance is enrolled and eligible:
    // the catalog gate fails closed rather than dialing the Sprout host.
    const submitted = await runtime.orchestrator.submit({ agentId: 'scout', prompt: 'go' });
    const run = await runtime.orchestrator.waitFor(submitted.id);
    assert.equal(run.status, 'failed');
    assert.match(run.failure ?? '', /no available environment for capability/);
  } finally {
    await runtime.close();
  }
});

test('production starts with zero Environments and admits an enrolled instance without restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credential = 'e2-catalog-credential';
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
      operatorCredential: credential,
    }),
    projectRoot: '/synthetic/project-root',
  });

  try {
    // Production starts and serves authenticated Web with zero Environment
    // instances.
    assert.equal(runtime.environmentCatalog.entries().length, 0);
    assert.deepEqual(runtime.pool.leases(), []);
    const { port } = await runtime.api.listen(0);
    runtimePorts.set(runtime, Promise.resolve(port));
    assert.ok(port > 0);
    const base = `http://127.0.0.1:${port}`;
    const signIn = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(signIn.status, 201, 'authenticated Web serves with zero Environments');
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const listing = await fetch(`${base}/api/environments/enrollments`, { headers: { cookie } });
    assert.equal(listing.status, 200);
    assert.deepEqual(((await listing.json()) as { enrollments: unknown[] }).enrollments, []);

    // A Human creates and approves a pending enrollment with a pre-proven
    // identity; no Worker is dialed by the core.
    const keyPath = join(directory, 'worker-key.pem');
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'enrolled-host-1',
      displayName: 'Enrolled Host One',
      publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;
    await runtime.enrollments.approve(enrollmentId, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    // The instance is a durable catalog entry even before any connection, and
    // the write API cannot mint unscoped readiness to make it eligible.
    await runtime.refreshEnvironmentCatalog();
    const entry = runtime.environmentCatalog.entry('enrolled-host-1');
    assert.ok(entry !== undefined);
    assert.equal(entry.eligible, false, 'no accepted epoch yet admits nothing');
    assert.equal(
      (await runtime.stores.environmentCatalog.get('enrolled-host-1'))?.enrollmentId,
      enrollmentId,
    );

    // A current, authenticated connection and facts from that exact epoch are
    // required; production admits it without a restart.
    await connectRuntimeWorker(runtime, enrollmentId, keyPath);
    const epoch = runtime.workerGateway.currentConnectionEpoch(enrollmentId)!;
    await observeSyntheticReady(runtime, enrollmentId,
      readinessAuthority(runtime, enrollmentId, epoch));
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('enrolled-host-1')?.eligible, true);
    await runtime.refreshEnvironmentCatalog();
  } finally {
    await runtime.close();
  }
});
