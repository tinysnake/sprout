import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRemoteOperationIdentityStore } from './operations/remote-operation-store.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentRecoveryError } from './environment/recovery-service.ts';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import type { HostPiEngineAdapter } from './engine/pi-host.ts';
import type { StartSessionRequest } from './engine/port.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from './worker/enrollment-connector.ts';
import { connectRuntimeWorker, createRuntime, hostConfiguration, INSTANCE_ID, project, scriptedTurn } from './runtime-test-harness.ts';

test('an HTTP MCP call whose effect succeeds but response is lost remains uncertain until confirmed recovery', async t => {
  let effectCount = 0;
  let sessionCloseCount = 0;
  const origin = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method === 'DELETE') {
        sessionCloseCount += 1;
        response.writeHead(204).end();
        return;
      }
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' }).end(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
      } else if (message.method === 'tools/list') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { tools: [{ name: 'apply_effect', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] },
        }));
      } else if (message.method === 'tools/call') {
        effectCount += 1;
        request.socket.destroy();
      } else {
        response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    origin.once('error', reject);
    origin.listen(0, 'localhost', resolve);
  });
  t.after(async () => new Promise<void>(resolve => origin.close(() => resolve())));
  const address = origin.address();
  assert.ok(address && typeof address === 'object');

  const directory = mkdtempSync(join(tmpdir(), 'sprout-mcp-uncertain-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker');
  const keyPath = join(directory, 'worker-key.pem');
  const model = 'provider/model-host';
  const engine = new ScriptedEngineAdapter({ turns: [scriptedTurn('Tool call returned.')] });
  let leaseId: string | undefined;
  let operationId: string | undefined;
  let outwardResult: unknown;
  const hostPi = {
    id: 'pi', profileId: 'mcp-uncertain', authorizedModel: model, capabilities: engine.capabilities,
    async readiness() {
      return { profileId: 'mcp-uncertain', engine: 'pi', status: 'ready', installation: 'ready', authentication: 'ready',
        modelAvailability: 'available', adapterControls: 'ready', version: '1', observedAt: 1 };
    },
    async startSession(request: StartSessionRequest) {
      const session = await engine.startSession(request);
      return { ...session, run(prompt: string) {
        const turn = session.run(prompt);
        return { events: turn.events, completion: (async () => {
          const lease = runtime.pool.leases()[0];
          assert.ok(lease);
          leaseId = lease.id;
          const mcp = request.remoteProjectMcp;
          assert.ok(mcp);
          outwardResult = await mcp.call(mcp.tools[0]!.name, { value: 'apply once' });
          const conflict = await runtime.pool.acquireBoundOperationLeaseRevalidated({
            instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'competitor', runId: 'competitor', ttlMs: 60_000,
          });
          if (conflict.ok) runtime.pool.releaseLease(conflict.lease.id);
          assert.equal(conflict.ok, false, 'the active containing lease refuses a competing activation');
          assert.equal(runtime.pool.getLease(leaseId!)?.state, 'recovering');
          return await turn.completion;
        })() };
      }, interrupt: session.interrupt.bind(session), close: session.close.bind(session) };
    },
  } as unknown as HostPiEngineAdapter;
  const runtime = await createRuntime({ configuration: hostConfiguration({
    executionMode: 'host-run', environmentSource: 'enrollment', databasePath: join(directory, 'state.db'),
    runtimeConfiguration: { agents: [{ id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model, effort: 'medium',
      workOptions: [{ id: 'host-pi', engine: 'pi', workModel: model, effort: 'medium' }] }],
      project: { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] } },
  }), projectRoot: '/synthetic/project-root', hostPi });
  try {
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const enrollment = await runtime.enrollments.requestEnrollment({ environmentInstanceId: INSTANCE_ID, displayName: 'Fixture Worker',
      publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
      capabilityRequests: ['agent-run', 'project-mcp', 'read-only-investigation'], engineFacts: [] });
    await runtime.enrollments.approve(enrollment.enrollment.id, { capabilityPermissions: { 'agent-run': true, 'project-mcp': true, 'read-only-investigation': true } });
    await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
    await runtime.projectService.create({ id: 'mcp-project', displayName: 'MCP Project' });
    await runtime.projectService.addMembership('mcp-project', { agentId: 'scout' });
    await runtime.projectService.updateContent('mcp-project', { mcpConfiguration: { format: 'claude-code-mcp-json-v1' } });
    await runtime.projectAccess.grant({ projectId: 'mcp-project', environmentInstanceId: INSTANCE_ID, selection: { kind: 'relative', path: 'repos/mcp' } });
    const workspace = join(workerRoot, 'repos', 'mcp');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: {
      fixture: { type: 'http', url: `http://localhost:${address.port}/mcp` },
    } }));
    const call = runtime.enrollmentEnvironment.callProjectMcpTool.bind(runtime.enrollmentEnvironment);
    runtime.enrollmentEnvironment.callProjectMcpTool = async (...args) => {
      operationId = args[1].operationId;
      return call(...args);
    };

    const run = await runtime.orchestrator.submit({ agentId: 'scout', projectId: 'mcp-project', prompt: 'Call the configured MCP tool.' });
    const settled = await runtime.orchestrator.waitFor(run.id);
    assert.equal(settled.status, 'completed');
    assert.equal(effectCount, 1, 'the remote side effect happened before the fixture dropped the response');
    assert.deepEqual(outwardResult, { status: 'failed', reason: 'server-error' }, 'the model receives the same sanitized failure');
    assert.ok(leaseId);
    assert.ok(operationId);
    const database = new DatabaseSync(join(directory, 'state.db'));
    try {
      const store = new SqliteRemoteOperationIdentityStore(database);
      const operation = await store.getMcpOperation(operationId);
      assert.equal(sessionCloseCount, 1, 'the HTTP session was successfully closed after the lost response');
      assert.equal(operation?.state, 'uncertain', 'session closure supplies no invocation-specific settlement evidence');
      assert.equal(operation?.leaseId, leaseId);
    } finally { database.close(); }
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'recovering');
    const conflict = await runtime.pool.acquireBoundOperationLeaseRevalidated({
      instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'competitor-after-call', runId: 'competitor-after-call', ttlMs: 60_000,
    });
    assert.equal(conflict.ok, false, 'another run cannot acquire the containing lease while the effect is uncertain');
    const recovery = await runtime.recovery.forLease(leaseId);
    assert.ok(recovery);
    await assert.rejects(runtime.recovery.release(leaseId), 'unconfirmed settlement cannot release recovery');
    await runtime.recovery.observeReconnect(leaseId, {
      enrollmentId: enrollment.enrollment.id, environmentInstanceId: INSTANCE_ID,
      ...(recovery.workerIdentityDigest !== undefined ? { workerIdentityDigest: recovery.workerIdentityDigest } : {}),
      identityVerified: true, protocolCompatible: true, permissionsAllowed: true, hadActiveRun: true,
    });
    await runtime.recovery.synchronizeEvidence(leaseId, { hadActiveRun: true, evidence: {
      retainedEventCount: settled.events.length, turnSettlementObserved: true, engineSessionStopped: true,
      terminalStatus: 'completed', taskContextRecycled: true,
    } });
    await assert.rejects(runtime.recovery.release(leaseId), (error: unknown) =>
      error instanceof EnvironmentRecoveryError && error.code === 'evidence-not-synchronized');
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'recovering', 'engine settlement preserves the same containing lease');
    const recoveredDatabase = new DatabaseSync(join(directory, 'state.db'));
    try {
      const operation = await new SqliteRemoteOperationIdentityStore(recoveredDatabase).getMcpOperation(operationId);
      assert.equal(operation?.state, 'uncertain', 'engine settlement cannot confirm the lost remote outcome');
      assert.equal(operation?.leaseId, leaseId);
      assert.equal(effectCount, 1, 'ordinary recovery never replays the uncertain call');
    } finally { recoveredDatabase.close(); }
  } finally { await runtime.close(); }
});
