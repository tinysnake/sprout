import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import { createPendingEnrollment } from './environment/enrollment.ts';
import { workerIdentityDigest } from './environment/enrollment-identity.ts';
import { resolveEnvironmentInstance } from './project/resolve.ts';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import {
  createRuntime,
  hostConfiguration,
  scriptedStartupReadiness,
  scriptedTurn,
  waitFor,
  testComposition,
} from './runtime-test-harness.ts';

test('E2: an authenticated inbound connection admits a run on the enrolled instance', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-e2e-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
      engineId: 'scripted',
      // The default Project (scout member, no static instance) is used; access
      // arrives through the catalog below.
      runtimeConfiguration: {},
    }),
    projectRoot: '/synthetic/project-root',
  });

  const { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } = await import(
    './worker/enrollment-connector.ts'
  );
  const { EnvironmentWorker } = await import('./worker/server.ts');
  const { WORKER_PROTOCOL_VERSION } = await import('./worker/protocol.ts');
  const { signWorkerChallenge } = await import('./environment/worker-proof.ts');

  const keyDirectory = mkdtempSync(join(tmpdir(), 'sprout-e2-key-'));
  t.after(() => rmSync(keyDirectory, { recursive: true, force: true }));
  const keyPath = join(keyDirectory, 'worker-key.pem');

  const connections: { close(): void }[] = [];
  let worker: InstanceType<typeof EnvironmentWorker> | undefined;
  try {
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'enrolled-host-1',
      displayName: 'Enrolled Host One',
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;
    const claimSecret = requested.claim?.secret ?? '';
    // Claim the one-use secret with the host key, prove possession, then approve.
    const host = loadOrCreateWorkerIdentity(keyPath);
    await runtime.enrollments.claimEnrollment(enrollmentId, claimSecret);
    const challenge = await runtime.enrollments.issueChallenge(enrollmentId);
    await runtime.enrollments.connectWorker({
      enrollmentId,
      proof: {
        challengeId: challenge.id,
        publicKey: workerPublicKey(host.privateKey),
        signature: signWorkerChallenge(host.privateKey, challenge),
      },
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: WORKER_PROTOCOL_VERSION },
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
      ],
    });
    await runtime.enrollments.approve(enrollmentId, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });

    assert.equal(runtime.environmentCatalog.entry('enrolled-host-1')?.eligible, false, 'no connection yet');

    // The Worker initiates the outbound connection to the Sprout instance; the
    // production path never dials it.
    const { port } = await runtime.api.listen(0, '127.0.0.1');
    const connection = await connectWorkerEnrollment({
      target: {
        enrollmentId,
        host: '127.0.0.1',
        port,
        claimSecret: undefined,
        identityKeyPath: keyPath,
      },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engineFacts: [{ engine: 'scripted', installed: true, authenticated: true, models: ['scripted-model'] }],
    });
    connections.push(connection);

    // Start the Worker's neutral JSON-RPC server over the accepted channel.
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'sprout-e2-ws-'));
    t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    worker = new EnvironmentWorker({
      environmentInstanceId: 'enrolled-host-1',
      engines: new Map([
        ['scripted', new ScriptedEngineAdapter({ turns: [scriptedTurn('enrolled reply')] })],
      ]),
      input: connection.stream,
      output: connection.stream,
      workspaceRoot,
      // The Worker declares its own neutral, non-inference readiness facts
      // (ADR-0013). A real probe implementation is E4 (#118); here the Worker
      // states what it verified so the catalog can reach eligibility.
      readiness: scriptedStartupReadiness,
    });

    // The acceptance observer records the delegated readiness; wait for the
    // catalog to admit the instance without any restart.
    await waitFor(
      () => runtime.environmentCatalog.entry('enrolled-host-1')?.eligible === true,
      'the catalog admits the connected instance',
    );

    // A Human grants the Project access to exactly the catalog instance (#93);
    // the Worker validates the workspace over the same accepted connection, so
    // Project access, execution, and leases resolve the same instance.
    const authorityProject = await runtime.projectService.create({
      id: 'enrolled-project',
      displayName: 'Enrolled Project',
      goal: 'Execute on the enrolled instance.',
      agentMemberships: [{ agentId: 'scout' }],
    });
    await runtime.projectAccess.grant({
      projectId: authorityProject.id,
      environmentInstanceId: 'enrolled-host-1',
      selection: { kind: 'default' },
    });

    const run = await runtime.orchestrator.submit({
      agentId: 'scout',
      prompt: 'run on the enrolled instance',
      projectId: authorityProject.id,
    });
    const settled = await runtime.orchestrator.waitFor(run.id);
    assert.equal(settled.failure ?? 'no-failure', 'no-failure');
    assert.equal(settled.environmentInstanceId, 'enrolled-host-1');
    assert.equal(settled.status, 'completed');
    assert.equal(settled.result?.status === 'completed' ? settled.result.text : undefined, 'enrolled reply');

    // Transport close synchronously fences the already-published catalog and
    // pool before the store-backed refresh can cross its first await. Resolution
    // in that exact window must fail closed while the durable entry remains.
    const accepted = runtime.workerGateway.liveFor('enrolled-host-1');
    assert.ok(accepted !== undefined);
    testComposition(runtime).workerGateway.liveFor('enrolled-host-1')!.close();
    assert.equal(runtime.environmentCatalog.entry('enrolled-host-1')?.eligible, false);
    assert.ok(runtime.environmentCatalog.entry('enrolled-host-1') !== undefined, 'offline stays inspectable');
    assert.equal(runtime.pool.requiresLease('enrolled-host-1', ADMISSION_CAPABILITY), undefined);
    assert.deepEqual(
      resolveEnvironmentInstance([runtime.projects.get(authorityProject.id)!], ADMISSION_CAPABILITY, runtime.pool),
      { ok: false, reason: 'no-available-environment' },
    );

    // Reconnect receives the next authority generation and can restore
    // eligibility only after this connection reports its own readiness.
    await worker.shutdown().catch(() => undefined);
    worker = undefined;
    const replacement = await connectWorkerEnrollment({
      target: {
        enrollmentId,
        host: '127.0.0.1',
        port,
        claimSecret: undefined,
        identityKeyPath: keyPath,
      },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engineFacts: [{ engine: 'scripted', installed: true, authenticated: true, models: ['scripted-model'] }],
    });
    connections.push(replacement);
    assert.ok(replacement.epoch > connection.epoch);
    worker = new EnvironmentWorker({
      environmentInstanceId: 'enrolled-host-1',
      engines: new Map([
        ['scripted', new ScriptedEngineAdapter({ turns: [scriptedTurn('replacement reply')] })],
      ]),
      input: replacement.stream,
      output: replacement.stream,
      workspaceRoot,
      readiness: scriptedStartupReadiness,
    });
    await waitFor(
      () => runtime.environmentCatalog.entry('enrolled-host-1')?.eligible === true,
      'the replacement connection to restore current-epoch eligibility',
    );
  } finally {
    await worker?.shutdown().catch(() => undefined);
    for (const connection of connections) connection.close();
    await runtime.close();
  }
});

test('E2: a legacy same-instance enrollment cannot inherit stale readiness through gateway acceptance', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-instance-authority-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
      engineId: 'scripted',
      runtimeConfiguration: {},
    }),
    projectRoot: '/synthetic/project-root',
  });
  const { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } = await import(
    './worker/enrollment-connector.ts'
  );
  const { EnvironmentWorker } = await import('./worker/server.ts');
  const { WORKER_PROTOCOL_VERSION } = await import('./worker/protocol.ts');
  const keyDirectory = mkdtempSync(join(tmpdir(), 'sprout-e2-instance-authority-key-'));
  t.after(() => rmSync(keyDirectory, { recursive: true, force: true }));
  const firstKeyPath = join(keyDirectory, 'first-worker-key.pem');
  const secondKeyPath = join(keyDirectory, 'second-worker-key.pem');
  const instanceId = 'one-instance';
  const connections: { close(): void }[] = [];
  let firstWorker: InstanceType<typeof EnvironmentWorker> | undefined;
  let secondWorker: InstanceType<typeof EnvironmentWorker> | undefined;
  try {
    const firstIdentity = loadOrCreateWorkerIdentity(firstKeyPath);
    const first = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: instanceId,
      displayName: 'First authority',
      publicKey: workerPublicKey(firstIdentity.privateKey),
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    await runtime.enrollments.approve(first.enrollment.id, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    const { port } = await runtime.api.listen(0, '127.0.0.1');
    const firstConnection = await connectWorkerEnrollment({
      target: {
        enrollmentId: first.enrollment.id,
        host: '127.0.0.1',
        port,
        claimSecret: undefined,
        identityKeyPath: firstKeyPath,
      },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engineFacts: [],
    });
    connections.push(firstConnection);
    firstWorker = new EnvironmentWorker({
      environmentInstanceId: instanceId,
      engines: new Map(),
      input: firstConnection.stream,
      output: firstConnection.stream,
      readiness: scriptedStartupReadiness,
    });
    await waitFor(
      () => runtime.environmentCatalog.entry(instanceId)?.eligible === true,
      'the first enrollment to establish readiness',
    );
    assert.equal((await runtime.stores.environmentReadiness.getReadiness(instanceId))?.enrollmentId, first.enrollment.id);

    // Public creation now refuses another authority for this instance. Insert a
    // historical sibling directly to prove the runtime and real gateway still
    // fail closed when reopening legacy data with that invalid shape.
    const secondIdentity = loadOrCreateWorkerIdentity(secondKeyPath);
    const legacySibling = createPendingEnrollment({
      id: 'legacy-second-enrollment',
      environmentInstanceId: instanceId,
      displayName: 'Historical sibling',
      identityDigest: workerIdentityDigest(workerPublicKey(secondIdentity.privateKey)),
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
      at: Date.now() + 1,
    });
    await runtime.stores.enrollments.save(legacySibling);
    await runtime.enrollments.approve(legacySibling.id, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    await runtime.refreshEnvironmentCatalog();

    const secondConnection = await connectWorkerEnrollment({
      target: {
        enrollmentId: legacySibling.id,
        host: '127.0.0.1',
        port,
        claimSecret: undefined,
        identityKeyPath: secondKeyPath,
      },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engineFacts: [],
    });
    connections.push(secondConnection);
    assert.equal(secondConnection.epoch, 1, 'the sibling has a fresh per-enrollment epoch');
    assert.equal(runtime.workerGateway.liveFor(instanceId)?.enrollment.id, legacySibling.id);
    assert.equal(runtime.workerGateway.isCurrentConnection(first.enrollment.id, firstConnection.connectionId), false);
    assert.equal(runtime.environmentCatalog.entry(instanceId)?.eligible, false, 'acceptance clears stale facts before publishing epoch one');
    assert.equal(runtime.pool.requiresLease(instanceId, ADMISSION_CAPABILITY), undefined);

    // Fresh readiness from the second accepted transport is the only fact that
    // can restore admission. This proves both exact readiness ownership and the
    // one-live-transport gateway fence in the production composition.
    secondWorker = new EnvironmentWorker({
      environmentInstanceId: instanceId,
      engines: new Map(),
      input: secondConnection.stream,
      output: secondConnection.stream,
      readiness: scriptedStartupReadiness,
    });
    await waitFor(
      () => runtime.environmentCatalog.entry(instanceId)?.eligible === true,
      'fresh second-enrollment readiness',
    );
    assert.equal((await runtime.stores.environmentReadiness.getReadiness(instanceId))?.enrollmentId, legacySibling.id);
  } finally {
    await firstWorker?.shutdown().catch(() => undefined);
    await secondWorker?.shutdown().catch(() => undefined);
    for (const connection of connections) connection.close();
    await runtime.close();
  }
});
