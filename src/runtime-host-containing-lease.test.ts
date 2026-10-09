import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import type { HostPiEngineAdapter } from './engine/pi-host.ts';
import type { StartSessionRequest, RemoteWorkspaceTools } from './engine/port.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from './worker/enrollment-connector.ts';
import { connectRuntimeWorker, createRuntime, hostConfiguration, INSTANCE_ID, project, scriptedTurn, waitFor } from './runtime-test-harness.ts';

for (const outcome of ['confirmed', 'no-mutation', 'turn-unknown', 'mutation-unknown', 'stop-unknown'] as const) {
  test(`one Host Pi turn calls typed MCP and remotely edits under the same protected containing lease: ${outcome}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-combined-host-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const workerRoot = join(directory, 'worker');
    const workspace = join(workerRoot, 'repos', 'combined');
    const keyPath = join(directory, 'worker-key.pem');
    const model = 'provider/model-host';
    const engine = new ScriptedEngineAdapter({ turns: [scriptedTurn('Both tools completed.')] });
    let tools: RemoteWorkspaceTools | undefined;
    let leaseId: string | undefined;
    let operationId: string | undefined;
    let allowInspection = outcome !== 'mutation-unknown';
    let turnCalled = false;
    let confirmMcpStop: (() => Promise<void>) | undefined;
    const hostPi = {
      id: 'pi', profileId: 'combined-host', authorizedModel: model, capabilities: engine.capabilities,
      async readiness() {
        return { profileId: 'combined-host', engine: 'pi', status: 'ready', installation: 'ready', authentication: 'ready',
          modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4', observedAt: 1 };
      },
      async startSession(request: StartSessionRequest) {
        const session = await engine.startSession(request);
        return { ...session, run(prompt: string) {
          const turn = session.run(prompt);
          return { events: turn.events, completion: (async () => {
            turnCalled = true;
            tools = request.remoteWorkspace;
            const mcp = request.remoteProjectMcp;
            assert.ok(tools?.edit);
            assert.ok(mcp);
            assert.equal(runtime.pool.leases().length, 1);
            const lease = runtime.pool.leases()[0]!;
            leaseId = lease.id;
            assert.equal(lease.capability, 'project-mcp');
            assert.equal(lease.state, 'active');
            assert.deepEqual(await mcp.call(mcp.tools[0]!.name, { text: 'typed call' }), { status: 'completed', text: 'typed call' });
            if (outcome !== 'no-mutation') {
              const edit = await tools.edit('target.txt', 'before', 'after', 'combined-edit');
              operationId = edit.operationId;
              assert.equal(edit.status, outcome === 'mutation-unknown' ? 'failed' : 'completed', `remote edit: ${edit.failure}`);
              if (outcome === 'mutation-unknown') assert.equal(edit.failure, 'outcome-unknown-inspect-required');
              assert.equal(readFileSync(join(workspace, 'target.txt'), 'utf8'), 'after');
              assert.deepEqual(runtime.pool.leases().map(row => row.id), [leaseId]);
            }
            const result = await turn.completion;
            return outcome === 'turn-unknown' ? { ...result, status: 'interrupted' as const } : result;
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
      const enrollment = await runtime.enrollments.requestEnrollment({ environmentInstanceId: INSTANCE_ID, displayName: 'Combined Worker',
        publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
        capabilityRequests: ['agent-run', 'project-mcp', 'read-only-investigation'], engineFacts: [] });
      await runtime.enrollments.approve(enrollment.enrollment.id, { capabilityPermissions: { 'agent-run': true, 'project-mcp': true, 'read-only-investigation': true } });
      await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
      await runtime.projectService.create({ id: 'combined-project', displayName: 'Combined Project' });
      await runtime.projectService.addMembership('combined-project', { agentId: 'scout' });
      await runtime.projectService.updateContent('combined-project', { mcpConfiguration: { format: 'claude-code-mcp-json-v1' } });
      await runtime.projectAccess.grant({ projectId: 'combined-project', environmentInstanceId: INSTANCE_ID, selection: { kind: 'relative', path: 'repos/combined' } });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, 'target.txt'), 'before');
      const script = `import { createInterface } from 'node:readline';
        const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
        createInterface({ input: process.stdin }).on('line', line => {
          const r = JSON.parse(line);
          if (r.method === 'initialize') send({ jsonrpc: '2.0', id: r.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
          if (r.method === 'tools/list') send({ jsonrpc: '2.0', id: r.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] } });
          if (r.method === 'tools/call') send({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: r.params.arguments.text }] } });
        });`;
      writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ['--input-type=module', '-e', script] } } }));
      const execute = runtime.enrollmentEnvironment.executeWorkspaceFileOperation.bind(runtime.enrollmentEnvironment);
      runtime.enrollmentEnvironment.executeWorkspaceFileOperation = async (...args) => {
        assert.equal(runtime.pool.leases().length, 1);
        assert.equal(runtime.pool.getLease(leaseId!)?.state, 'active');
        const result = await execute(...args);
        if (outcome === 'mutation-unknown') throw new Error('Lost mutation reply');
        return result;
      };
      const inspect = runtime.enrollmentEnvironment.inspectWorkspaceFileOperation.bind(runtime.enrollmentEnvironment);
      runtime.enrollmentEnvironment.inspectWorkspaceFileOperation = async (...args) => {
        if (!allowInspection) throw new Error('Inspection unavailable');
        return inspect(...args);
      };
      const recycle = runtime.enrollmentEnvironment.recycleRunContext.bind(runtime.enrollmentEnvironment);
      runtime.enrollmentEnvironment.recycleRunContext = async (...args) => {
        assert.notEqual(runtime.pool.getLease(leaseId!)?.state, 'released', 'cleanup still owns the containing lease');
        return recycle(...args);
      };
      if (outcome === 'stop-unknown') {
        const stop = runtime.enrollmentEnvironment.stopProjectMcp.bind(runtime.enrollmentEnvironment);
        runtime.enrollmentEnvironment.stopProjectMcp = async (...args) => { const result = await stop(...args); return { ...result, status: 'uncertain' }; };
        confirmMcpStop = async () => {
          runtime.enrollmentEnvironment.stopProjectMcp = stop;
          await runtime.environmentOperations.reconcileProjectMcpProcesses(INSTANCE_ID);
        };
      }
      const run = await runtime.orchestrator.submit({ agentId: 'scout', projectId: 'combined-project', prompt: 'Call typed echo and edit target.' });
      const settled = await runtime.orchestrator.waitFor(run.id);
      assert.equal(settled.status, outcome === 'turn-unknown' ? 'interrupted' : 'completed', settled.failure ?? 'Host turn failed');
      assert.equal(turnCalled, true);
      assert.equal(settled.leaseId, leaseId);
      if (outcome === 'confirmed' || outcome === 'no-mutation') assert.equal(runtime.pool.getLease(leaseId!)?.state, 'released');
      else {
        assert.equal(runtime.pool.getLease(leaseId!)?.state, 'recovering');
        const conflict = await runtime.pool.acquireBoundOperationLeaseRevalidated({ instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'another-run', runId: 'another-run', ttlMs: 60_000 });
        assert.equal(conflict.ok, false);
        if (outcome === 'mutation-unknown') {
          allowInspection = true;
          assert.equal((await tools!.inspect(operationId!)).status, 'completed');
          await tools!.settle!('settled');
          await waitFor(() => runtime.pool.getLease(leaseId!)?.state === 'released', 'confirmed shared lease settlement');
          assert.equal(runtime.pool.getLease(leaseId!)?.state, 'released', 'confirmed mutation settlement and MCP stop release the containing lease');
        } else if (outcome === 'stop-unknown') {
          await assert.rejects(runtime.recovery.release(leaseId!), 'unconfirmed settlement cannot release recovery');
          await confirmMcpStop!();
          const recovery = await runtime.recovery.forLease(leaseId!);
          assert.ok(recovery);
          await runtime.recovery.observeReconnect(leaseId!, {
            enrollmentId: enrollment.enrollment.id, environmentInstanceId: INSTANCE_ID,
            ...(recovery.workerIdentityDigest !== undefined ? { workerIdentityDigest: recovery.workerIdentityDigest } : {}),
            identityVerified: true, protocolCompatible: true, permissionsAllowed: true, hadActiveRun: true,
          });
          await runtime.recovery.synchronizeEvidence(leaseId!, { hadActiveRun: true, evidence: {
            retainedEventCount: settled.events.length, turnSettlementObserved: true, engineSessionStopped: true,
            terminalStatus: 'completed', taskContextRecycled: true,
          } });
          await runtime.recovery.release(leaseId!);
          assert.equal(runtime.pool.getLease(leaseId!)?.state, 'released', 'confirmed recovery releases the same containing lease');
        }
      }
    } finally { await runtime.close(); }
  });
}
