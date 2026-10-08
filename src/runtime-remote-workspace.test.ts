import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import type { HostPiEngineAdapter } from './engine/pi-host.ts';
import type { RemoteWorkspaceOperationResult, StartSessionRequest } from './engine/port.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from './worker/enrollment-connector.ts';
import {
  connectRuntimeWorker,
  createRuntime,
  hostConfiguration,
  INSTANCE_ID,
  project,
  scriptedTurn,
} from './runtime-test-harness.ts';

test('Host-run reads an authorized Project file through an enrolled Worker without a remote model engine', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-remote-read-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker-workspaces');
  const keyPath = join(directory, 'worker-key.pem');
  const model = 'provider/model-host';
  const runtimeProject = { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] };
  const localEngine = new ScriptedEngineAdapter({ turns: [scriptedTurn('I read the remote sentinel.')] });
  const observed: RemoteWorkspaceOperationResult[] = [];
  const hostPi = {
    id: 'pi', profileId: 'profile-runtime-remote-read', authorizedModel: model,
    capabilities: localEngine.capabilities,
    async readiness() {
      return { profileId: 'profile-runtime-remote-read', engine: 'pi', status: 'ready', installation: 'ready',
        authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4', observedAt: 1 };
    },
    async startSession(request: StartSessionRequest) {
      assert.ok(request.remoteWorkspace, 'Runtime supplies only its authorized remote workspace tools');
      observed.push(await request.remoteWorkspace.read('sentinel.txt'));
      return localEngine.startSession(request);
    },
  } as unknown as HostPiEngineAdapter;
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run', environmentSource: 'enrollment',
      runtimeConfiguration: {
        agents: [{
          id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model, effort: 'medium',
          workOptions: [{ id: 'host-pi', engine: 'pi', workModel: model, effort: 'medium' }],
        }],
        project: runtimeProject,
      },
      databasePath: join(directory, 'state.db'),
    }),
    projectRoot: '/synthetic/project-root',
    environment: {
      async adapters() { return new Map(); },
      async contexts() { return { async prepare() { return { bootstrapInstructions: '' }; }, async recycle() {} }; },
      async close() {},
    },
    hostPi,
  });

  try {
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID,
      displayName: 'Remote file Worker',
      publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos',
      protocolVersion: '3.0',
      capabilityRequests: ['read-only-investigation'],
      engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, {
      capabilityPermissions: { 'read-only-investigation': true },
    });
    await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
    const info = await runtime.enrollmentEnvironment.info?.(INSTANCE_ID);
    assert.deepEqual(info?.engines, [], 'the remote Worker has no model engine or remote login');
    assert.ok(info?.workspaceOperations, 'the Worker independently advertises its remote file capability');

    await runtime.projectService.create({ id: 'remote-read-project', displayName: 'Remote read Project' });
    await runtime.projectService.addMembership('remote-read-project', { agentId: 'scout' });
    const access = await runtime.projectAccess.grant({
      projectId: 'remote-read-project', environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'relative', path: 'repos/remote-read' },
    });
    assert.ok(access.current?.generation);
    writeFileSync(join(workerRoot, 'repos', 'remote-read', 'sentinel.txt'), 'REMOTE_WORKER_SENTINEL');
    const bindingReadiness = await runtime.environmentOperations.bindingReadiness('remote-read-project');
    assert.equal(bindingReadiness[0]?.status, 'ready', 'remote binding readiness does not depend on an engine login');

    const { id } = await runtime.orchestrator.submit({
      agentId: 'scout', projectId: 'remote-read-project', prompt: 'Read sentinel.txt.',
    });
    const run = await runtime.orchestrator.waitFor(id);
    assert.equal(run.status, 'completed');
    assert.equal(run.executionMode, 'host-run');
    assert.equal(run.engineHostProfileId, 'profile-runtime-remote-read');
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.status, 'completed');
    assert.equal(observed[0]?.content, 'REMOTE_WORKER_SENTINEL');
    assert.equal(observed[0]?.projectId, 'remote-read-project');
    assert.equal(observed[0]?.bindingId, access.current?.bindingId);
    assert.equal(observed[0]?.generation, access.current?.generation);
    assert.equal(observed[0]?.environmentInstanceId, INSTANCE_ID);
    assert.equal(observed[0]?.workspaceId, access.current?.workspaceId);
    assert.equal(observed[0]?.connectionEpoch, runtime.workerGateway.currentConnectionEpoch(enrollment.enrollment.id));
    assert.deepEqual(runtime.pool.leases(), [], 'the authorized read is explicitly lease-free');
  } finally {
    await runtime.close();
  }
});

test('composed Runtime fails an attached remote read after Worker disconnection without local fallback', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-remote-disconnected-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker-workspaces');
  const keyPath = join(directory, 'worker-key.pem');
  const localRoot = join(directory, 'local-files');
  const localSentinel = join(localRoot, 'sentinel.txt');
  mkdirSync(localRoot, { recursive: true });
  writeFileSync(localSentinel, 'LOCAL_HOST_SENTINEL');
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run', environmentSource: 'enrollment',
      databasePath: join(directory, 'state.db'),
    }),
    projectRoot: '/synthetic/project-root',
    environment: {
      async adapters() { return new Map(); },
      async contexts() { return { async prepare() { return { bootstrapInstructions: '' }; }, async recycle() {} }; },
      async close() {},
    },
  });
  try {
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID, displayName: 'Disconnecting file Worker',
      publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
      capabilityRequests: ['read-only-investigation'], engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, {
      capabilityPermissions: { 'read-only-investigation': true },
    });
    const connection = await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
    await runtime.projectService.create({ id: 'disconnected-read-project', displayName: 'Disconnected read Project' });
    await runtime.projectService.addMembership('disconnected-read-project', { agentId: 'scout' });
    const access = await runtime.projectAccess.grant({
      projectId: 'disconnected-read-project', environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'relative', path: 'repos/disconnected' },
    });
    writeFileSync(join(workerRoot, 'repos', 'disconnected', 'sentinel.txt'), 'REMOTE_WORKER_SENTINEL');
    const tools = await runtime.environmentOperations.attach('disconnected-read-project', 'scout');
    assert.equal(tools.binding.bindingId, access.current?.bindingId);

    connection.close();
    const readiness = await runtime.environmentOperations.bindingReadiness('disconnected-read-project');
    assert.equal(readiness[0]?.status, 'blocked');
    assert.equal(readiness[0]?.reason, 'worker-offline');
    const result = await tools.read('sentinel.txt');
    assert.equal(result.status, 'failed');
    assert.equal(result.content, undefined);
    assert.equal(result.failure, 'worker-unavailable');
    assert.notEqual(result.content, 'LOCAL_HOST_SENTINEL', 'a lost Worker never falls back to a same-name local file');
    assert.equal(runtime.workerGateway.liveFor(INSTANCE_ID), undefined);
  } finally {
    await runtime.close();
  }
});


test('composed Runtime blocks remote reads when the enrolled Worker lacks the file capability permission', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-remote-denied-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyPath = join(directory, 'worker-key.pem');
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run', environmentSource: 'enrollment',
      databasePath: join(directory, 'state.db'),
    }),
    projectRoot: '/synthetic/project-root',
    environment: {
      async adapters() { return new Map(); },
      async contexts() { return { async prepare() { return { bootstrapInstructions: '' }; }, async recycle() {} }; },
      async close() {},
    },
  });
  try {
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID, displayName: 'Denied file Worker',
      publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
      capabilityRequests: ['read-only-investigation'], engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, {
      capabilityPermissions: { 'read-only-investigation': false },
    });
    await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, join(directory, 'worker-workspaces'));
    await runtime.projectService.create({ id: 'denied-read-project', displayName: 'Denied read Project' });
    await runtime.projectService.addMembership('denied-read-project', { agentId: 'scout' });
    await runtime.projectAccess.grant({
      projectId: 'denied-read-project', environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'relative', path: 'repos/denied' },
    });

    const readiness = await runtime.environmentOperations.bindingReadiness('denied-read-project');
    assert.equal(readiness[0]?.status, 'blocked');
    assert.equal(readiness[0]?.reason, 'capability-denied');
    await assert.rejects(
      runtime.environmentOperations.attach('denied-read-project', 'scout'),
      (error: unknown) => error instanceof Error && 'reason' in error && error.reason === 'capability-denied',
    );
  } finally {
    await runtime.close();
  }
});
