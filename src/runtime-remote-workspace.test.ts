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
  waitFor,
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
    const authorized = await runtime.environmentOperations.attach('remote-read-project', 'scout');
    assert.equal(authorized.binding.bindingId, access.current?.bindingId);
    const direct = await runtime.enrollmentEnvironment.executeWorkspaceFileOperation(INSTANCE_ID, {
      ...authorized.binding, kind: 'relative', workspacePath: 'repos/remote-read', operationId: 'direct-runtime-read',
      operation: 'read', path: 'sentinel.txt',
    });
    if (direct.status !== 'completed') throw new Error(`Direct Worker RPC failed: ${direct.failure ?? 'no failure detail'}`);
    assert.equal(direct.content, 'REMOTE_WORKER_SENTINEL');

    const { id } = await runtime.orchestrator.submit({
      agentId: 'scout', projectId: 'remote-read-project', prompt: 'Read sentinel.txt.',
    });
    const run = await runtime.orchestrator.waitFor(id);
    if (run.status !== 'completed') throw new Error(`Host-run failed: ${run.failure ?? 'no failure detail'}`);
    assert.equal(run.executionMode, 'host-run');
    assert.equal(run.engineHostProfileId, 'profile-runtime-remote-read');
    assert.equal(observed.length, 1);
    if (observed[0]?.status !== 'completed') throw new Error(`Remote read failed: ${observed[0]?.failure ?? 'no failure detail'}`);
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
    await waitFor(() => runtime.workerGateway.liveFor(INSTANCE_ID) === undefined, 'Worker disconnection');
    const readiness = await runtime.environmentOperations.bindingReadiness('disconnected-read-project');
    assert.equal(readiness[0]?.status, 'blocked');
    assert.equal(readiness[0]?.reason, 'worker-offline');
    await assert.rejects(
      tools.read('sentinel.txt'),
      (error: unknown) => error instanceof Error && 'reason' in error && error.reason === 'worker-offline',
    );
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

test('Host-run calls typed Project MCP tools under its active Environment lease and refuses a recovering lease', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-project-mcp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker-workspaces');
  const keyPath = join(directory, 'worker-key.pem');
  const model = 'provider/model-host';
  const runtimeProject = { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] };
  const localEngine = new ScriptedEngineAdapter({ turns: [scriptedTurn('Project MCP tool completed.')] });
  const observed: unknown[] = [];
  const hostPi = {
    id: 'pi', profileId: 'profile-runtime-project-mcp', authorizedModel: model,
    capabilities: localEngine.capabilities,
    async readiness() {
      return { profileId: 'profile-runtime-project-mcp', engine: 'pi', status: 'ready', installation: 'ready',
        authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4', observedAt: 1 };
    },
    async startSession(request: StartSessionRequest) {
      const mcp = request.remoteProjectMcp;
      assert.ok(mcp, 'Runtime supplies its lease-bound Project MCP tools');
      assert.equal(mcp.tools.length, 1);
      assert.equal(mcp.tools[0]?.inputSchema.type, 'object');
      const lease = runtime.pool.leases().find(row => row.capability === 'project-mcp');
      assert.ok(lease);
      assert.equal(lease.state, 'active');
      assert.equal(lease.holderKind, 'run');
      observed.push(await mcp.call(mcp.tools[0]!.name, { text: 'hello from Pi' }));
      runtime.pool.markRecovering(lease.id);
      await assert.rejects(mcp.call(mcp.tools[0]!.name, { text: 'stale call' }), /lease-required/);
      assert.deepEqual(await mcp.call('mcp_unrelated_tool', { text: 'wrong origin' }), { status: 'failed', reason: 'unknown-tool' });
      observed.push(await mcp.call(mcp.tools[0]!.name, { text: 12 } as unknown as Record<string, unknown>));
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
    hostPi,
  });
  try {
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID, displayName: 'Project MCP Worker', publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos', protocolVersion: '3.0', capabilityRequests: ['project-mcp'], engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, { capabilityPermissions: { 'project-mcp': true } });
    await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
    const projectId = 'remote-mcp-project';
    await runtime.projectService.create({ id: projectId, displayName: 'Remote MCP Project' });
    await runtime.projectService.addMembership(projectId, { agentId: 'scout' });
    await runtime.projectService.updateContent(projectId, { mcpConfiguration: { format: 'claude-code-mcp-json-v1' } });
    const access = await runtime.projectAccess.grant({
      projectId, environmentInstanceId: INSTANCE_ID, selection: { kind: 'relative', path: 'repos/remote-mcp' },
    });
    assert.ok(access.current);
    assert.equal(runtime.pool.requiresLease(INSTANCE_ID, 'project-mcp'), true, 'the enrolled catalog requires the MCP lease');
    assert.deepEqual(runtime.projects.get(projectId)?.availableEnvironmentInstanceIds, [INSTANCE_ID], 'the active Project access grants the enrolled instance');
    const serverScript = `
      import { createInterface } from 'node:readline';
      const tools = [{ name: 'echo', description: 'Echo supplied text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }];
      const input = createInterface({ input: process.stdin });
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      input.on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
        else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools } });
        else if (request.method === 'tools/call') send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: request.params.arguments.text }] } });
      });
    `;
    writeFileSync(join(workerRoot, 'repos', 'remote-mcp', '.mcp.json'), JSON.stringify({ mcpServers: {
      'fixture-server': { command: process.execPath, args: ['--input-type=module', '-e', serverScript] },
    } }));
    const { id } = await runtime.orchestrator.submit({ agentId: 'scout', projectId, prompt: 'Use the Project MCP echo tool.' });
    const run = await runtime.orchestrator.waitFor(id);
    assert.equal(run.status, 'completed', run.failure ?? 'run did not complete');
    assert.deepEqual(observed, [
      { status: 'completed', text: 'hello from Pi' },
      { status: 'failed', reason: 'invalid-arguments' },
    ]);
    assert.equal(runtime.pool.leases().find(row => row.capability === 'project-mcp')?.state, 'recovering');
  } finally {
    await runtime.close();
  }
});
