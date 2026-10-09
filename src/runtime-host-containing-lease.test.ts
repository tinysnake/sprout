import { DatabaseSync } from 'node:sqlite';
import { SqliteRemoteOperationIdentityStore } from './operations/remote-operation-store.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import type { HostPiEngineAdapter } from './engine/pi-host.ts';
import type { StartSessionRequest, RemoteWorkspaceTools } from './engine/port.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from './worker/enrollment-connector.ts';
import { connectRuntimeWorker, createRuntime, hostConfiguration, INSTANCE_ID, project, scriptedTurn, waitFor } from './runtime-test-harness.ts';

for (const outcome of ['confirmed', 'no-mutation', 'turn-unknown', 'mutation-unknown', 'stop-unknown', 'mcp-only-past-ttl', 'first-mutation-past-ttl', 'renewal-loss-past-ttl', 'discovery-past-ttl', 'discovery-stop-unknown'] as const) {
  test(`one Host Pi turn calls typed MCP and remotely edits under the same protected containing lease: ${outcome}`, async t => {
    const discoveryHeld = outcome.startsWith('discovery-');
    const timed = outcome.endsWith('past-ttl') || discoveryHeld;
    let discoveryConflict: boolean | undefined;
    let discoveryLeaseState: string | undefined;
    let discoveryProcessId: string | undefined;
    const leaseTtlMs = 3_000;
    let workspaceSettled = false;
    let mcpStopped = false;
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
    let confirmedStopStatus: string | undefined;
    let confirmedStopError: string | undefined;
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
            if (discoveryHeld) assert.equal(discoveryConflict, true, 'discovery beyond TTL must refuse a competing activation');
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
            if (timed) {
              // Only the lease clock and renewal interval are virtual; Worker I/O stays real.
              if (outcome === 'renewal-loss-past-ttl') t.mock.timers.setTime(Date.now() + 2 * leaseTtlMs);
              else for (let elapsed = 0; elapsed < 2 * leaseTtlMs; elapsed += 1_000) t.mock.timers.tick(1_000);
              const conflict = await runtime.pool.acquireBoundOperationLeaseRevalidated({ instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'competitor', runId: 'competitor', ttlMs: leaseTtlMs });
              assert.equal(conflict.ok, false, 'an open MCP turn must refuse a second holder beyond TTL');
              assert.equal(runtime.pool.getLease(leaseId!)?.state, outcome === 'renewal-loss-past-ttl' ? 'recovering' : 'active');
              assert.deepEqual(runtime.pool.leases().map(row => row.id), [leaseId]);
            }
            if (outcome !== 'no-mutation' && outcome !== 'mcp-only-past-ttl' && outcome !== 'renewal-loss-past-ttl') {
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
      executionMode: 'host-run', environmentSource: 'enrollment', ...(timed ? { leaseTtlMs } : {}), databasePath: join(directory, 'state.db'),
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
        import { writeFileSync, existsSync } from 'node:fs';
        const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
        createInterface({ input: process.stdin }).on('line', line => {
          const r = JSON.parse(line);
          if (r.method === 'initialize') send({ jsonrpc: '2.0', id: r.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
          if (r.method === 'tools/list') {
            const respond = () => send({ jsonrpc: '2.0', id: r.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] } });
            ${discoveryHeld ? `writeFileSync('discovery-held', 'held');
            const polling = setInterval(() => { if (existsSync('discovery-continue')) { clearInterval(polling); respond(); } }, 5);` : 'respond();'}
          }
          if (r.method === 'tools/call') send({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: r.params.arguments.text }] } });
        });`;
      writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ['--input-type=module', '-e', script] } } }));
      if (discoveryHeld) {
        const start = runtime.enrollmentEnvironment.startProjectMcp.bind(runtime.enrollmentEnvironment);
        runtime.enrollmentEnvironment.startProjectMcp = async (...args) => {
          discoveryProcessId = args[1].processId;
          const starting = start(...args);
          try {
            await waitFor(() => existsSync(join(workspace, 'discovery-held')), 'real stdio MCP discovery request');
            leaseId = runtime.pool.leases()[0]!.id;
            for (let elapsed = 0; elapsed < 2 * leaseTtlMs; elapsed += 1_000) t.mock.timers.tick(1_000);
            const conflict = await runtime.pool.acquireBoundOperationLeaseRevalidated({ instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'discovery-competitor', runId: 'discovery-competitor', ttlMs: leaseTtlMs });
            discoveryConflict = !conflict.ok;
            if (conflict.ok) runtime.pool.releaseLease(conflict.lease.id);
            discoveryLeaseState = runtime.pool.getLease(leaseId)?.state;
          } finally { writeFileSync(join(workspace, 'discovery-continue'), 'continue'); }
          return starting;
        };
      }
      const settleWorkspace = runtime.environmentOperations.attach.bind(runtime.environmentOperations);
      runtime.environmentOperations.attach = async (...args) => {
        const surface = await settleWorkspace(...args);
        const settle = surface.settle!.bind(surface);
        return { ...surface, settle: async outcome => {
          if (timed) {
            assert.equal(mcpStopped, true, 'workspace settlement follows confirmed MCP stop');
            assert.notEqual(runtime.pool.getLease(leaseId!)?.state, 'released');
            for (let elapsed = 0; elapsed < 2 * leaseTtlMs; elapsed += 1_000) t.mock.timers.tick(1_000);
            const conflict = await runtime.pool.acquireBoundOperationLeaseRevalidated({ instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'cleanup-competitor', runId: 'cleanup-competitor', ttlMs: leaseTtlMs });
            assert.equal(conflict.ok, false, 'workspace cleanup still owns the same lease');
          }
          await settle(outcome);
          workspaceSettled = true;
        } };
      };
      const actualStopProjectMcp = runtime.enrollmentEnvironment.stopProjectMcp.bind(runtime.enrollmentEnvironment);
      if (timed) {
        runtime.enrollmentEnvironment.stopProjectMcp = async (...args) => {
          assert.equal(workspaceSettled, false);
          assert.notEqual(runtime.pool.getLease(leaseId!)?.state, 'released');
          for (let elapsed = 0; elapsed < 2 * leaseTtlMs; elapsed += 1_000) t.mock.timers.tick(1_000);
          const conflict = await runtime.pool.acquireBoundOperationLeaseRevalidated({ instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'stop-competitor', runId: 'stop-competitor', ttlMs: leaseTtlMs });
          assert.equal(conflict.ok, false, 'MCP stop still owns the same lease');
          const result = await actualStopProjectMcp(...args);
          assert.equal(result.status, 'stopped');
          mcpStopped = true;
          return result;
        };
      }
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
        if (timed) {
          assert.equal(mcpStopped, true, 'MCP process stop must precede context recycling');
          await Promise.resolve();
          for (let elapsed = 0; elapsed < 2 * leaseTtlMs; elapsed += 1_000) t.mock.timers.tick(1_000);
          const conflict = await runtime.pool.acquireBoundOperationLeaseRevalidated({ instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'recycle-competitor', runId: 'recycle-competitor', ttlMs: leaseTtlMs });
          assert.equal(conflict.ok, false, 'asynchronous recycling retains the lease beyond TTL');
          assert.equal(runtime.pool.getLease(leaseId!)?.state, 'active', 'renewal continues during asynchronous cleanup');
        }
        return recycle(...args);
      };
      if (outcome === 'stop-unknown' || outcome === 'discovery-stop-unknown') {
        const stopWithLeaseChecks = runtime.enrollmentEnvironment.stopProjectMcp.bind(runtime.enrollmentEnvironment);
        runtime.enrollmentEnvironment.stopProjectMcp = async (...args) => { const result = await stopWithLeaseChecks(...args); return { ...result, status: 'uncertain' }; };
        confirmMcpStop = async () => {
          runtime.enrollmentEnvironment.stopProjectMcp = async (...args) => {
            try {
              const result = await actualStopProjectMcp(...args);
              confirmedStopStatus = result.status;
              return result;
            } catch (error) {
              confirmedStopError = error instanceof Error ? error.message : 'unknown stop failure';
              throw error;
            }
          };
          await runtime.environmentOperations.reconcileProjectMcpProcesses(INSTANCE_ID);
        };
      }
      if (timed) t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
      const run = await runtime.orchestrator.submit({ agentId: 'scout', projectId: 'combined-project', prompt: 'Call typed echo and edit target.' });
      const settled = await runtime.orchestrator.waitFor(run.id);
      if (discoveryHeld) {
        assert.equal(discoveryConflict, true, 'discovery beyond TTL must refuse a competing activation');
        assert.equal(discoveryLeaseState, 'active', 'admission renewal protects the lease before workspace attachment');
      }
      assert.equal(settled.status, outcome === 'turn-unknown' ? 'interrupted' : 'completed', settled.failure ?? 'Host turn failed');
      assert.equal(turnCalled, true);
      assert.equal(settled.leaseId, leaseId);
      if (timed) {
        assert.equal(mcpStopped, true, 'the MCP process stop completed before the Host-run settled');
        assert.equal(workspaceSettled, true, 'the workspace settled after the MCP process stop');
      }
      if (outcome === 'confirmed' || outcome === 'no-mutation' || outcome === 'mcp-only-past-ttl' || outcome === 'first-mutation-past-ttl' || outcome === 'discovery-past-ttl') assert.equal(runtime.pool.getLease(leaseId!)?.state, 'released');
      else {
        assert.equal(runtime.pool.getLease(leaseId!)?.state, 'recovering');
        const conflict = await runtime.pool.acquireBoundOperationLeaseRevalidated({ instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'another-run', runId: 'another-run', ttlMs: 60_000 });
        assert.equal(conflict.ok, false);
        if (outcome === 'mutation-unknown') {
          const database = new DatabaseSync(join(directory, 'state.db'));
          try {
            const operation = await new SqliteRemoteOperationIdentityStore(database).get(operationId!);
            assert.equal(operation?.leaseId, leaseId, 'the durable operation points to its containing lease');
            assert.equal(operation?.runId, run.id, 'the durable operation points to its run');
            assert.equal(operation?.holderKind, 'run');
          } finally { database.close(); }
          allowInspection = true;
          assert.equal((await tools!.inspect(operationId!)).status, 'completed');
          await tools!.settle!('settled');
          await waitFor(() => runtime.pool.getLease(leaseId!)?.state === 'released', 'confirmed shared lease settlement');
          assert.equal(runtime.pool.getLease(leaseId!)?.state, 'released', 'confirmed mutation settlement and MCP stop release the containing lease');
        } else if (outcome === 'stop-unknown' || outcome === 'discovery-stop-unknown') {
          const database = new DatabaseSync(join(directory, 'state.db'));
          let processes;
          try { processes = await new SqliteRemoteOperationIdentityStore(database).listOpenMcpProcesses(INSTANCE_ID); }
          finally { database.close(); }
          assert.equal(processes.length, 1);
          assert.equal(processes[0]!.leaseId, leaseId);
          assert.equal(processes[0]!.state, 'uncertain');
          assert.equal(processes[0]!.agentId, 'scout');
          assert.equal(processes[0]!.enrollmentId, enrollment.enrollment.id);
          assert.equal(processes[0]!.workerIdentityDigest, enrollment.enrollment.worker.identityDigest);
          assert.equal(processes[0]!.holderKind, 'run');
          assert.equal(processes[0]!.runId, settled.id);
          assert.equal(processes[0]!.taskId, undefined);
          assert.equal(processes[0]!.holderId, runtime.pool.getLease(leaseId!)?.holderId);
          assert.equal(runtime.pool.getLease(leaseId!)?.capability, 'project-mcp');
          const accepted = runtime.workerGateway.liveFor(INSTANCE_ID);
          assert.ok(accepted);
          assert.equal(processes[0]!.enrollmentId, accepted.enrollment.id);
          assert.equal(processes[0]!.workerIdentityDigest, accepted.enrollment.worker.identityDigest);
          assert.equal(runtime.pool.getLease(leaseId!)?.id, processes[0]!.leaseId);
          assert.equal(runtime.pool.getLease(leaseId!)?.instanceId, processes[0]!.environmentInstanceId);
          assert.equal(runtime.pool.getLease(leaseId!)?.holderKind ?? 'run', processes[0]!.holderKind);
          assert.equal(runtime.pool.getLease(leaseId!)?.taskId, processes[0]!.taskId);
          assert.equal(runtime.pool.getLease(leaseId!)?.runId, processes[0]!.runId);
          assert.equal(runtime.pool.getLease(leaseId!)?.state, 'recovering');
          if (discoveryHeld) assert.equal(processes[0]!.processId, discoveryProcessId, 'recovery retains the process identity dispatched before discovery');
          await assert.rejects(runtime.recovery.release(leaseId!), 'unconfirmed settlement cannot release recovery');
          await confirmMcpStop!();
          assert.ok(confirmedStopStatus, `stop result missing: ${confirmedStopError ?? 'method was not called'}`);
          const recovery = await runtime.recovery.forLease(leaseId!);
          assert.ok(recovery);
          await runtime.recovery.observeReconnect(leaseId!, {
            enrollmentId: enrollment.enrollment.id, environmentInstanceId: INSTANCE_ID,
            ...(recovery.workerIdentityDigest !== undefined ? { workerIdentityDigest: recovery.workerIdentityDigest } : {}),
            identityVerified: true, protocolCompatible: true, permissionsAllowed: true, hadActiveRun: true,
          });
          const synchronized = await runtime.recovery.synchronizeEvidence(leaseId!, { hadActiveRun: true, evidence: {
            retainedEventCount: settled.events.length, turnSettlementObserved: true, engineSessionStopped: true,
            terminalStatus: 'completed', taskContextRecycled: true,
          } });
          const remote = synchronized.remoteWorkEvidence;
          assert.ok(remote);
          assert.equal(remote.workspaceOperations.running, 0, 'workspace operation still running after confirmation');
          assert.equal(remote.workspaceOperations.unknown, 0, 'workspace operation outcome remains unknown after confirmation');
          assert.equal(remote.workspaceOperations.cancelRequested, 0, 'workspace cancellation remains unresolved after confirmation');
          assert.equal(remote.workspaceOperations.recoveryRequired, 0, 'workspace operation still requires recovery after confirmation');
          assert.equal(remote.projectMcpOperations.running, 0, 'Project MCP call still running after confirmation');
          assert.equal(remote.projectMcpOperations.uncertain, 0, 'Project MCP call remains uncertain after confirmation');
          assert.equal(remote.projectMcpProcesses.starting, 0, 'Project MCP process is still starting after confirmation');
          assert.equal(remote.projectMcpProcesses.running, 0, 'Project MCP process is still running after confirmation');
          assert.equal(remote.projectMcpProcesses.stopping, 0, 'Project MCP process is still stopping after confirmation');
          assert.equal(remote.projectMcpProcesses.uncertain, 0, 'Project MCP process remains uncertain after confirmation');
          await runtime.recovery.release(leaseId!);
          assert.equal(runtime.pool.getLease(leaseId!)?.state, 'released', 'confirmed recovery releases the same containing lease');
        }
      }
      if (outcome === 'mcp-only-past-ttl' || outcome === 'first-mutation-past-ttl') {
        const next = await runtime.pool.acquireBoundOperationLeaseRevalidated({ instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'after-cleanup', runId: 'after-cleanup', ttlMs: leaseTtlMs });
        assert.equal(next.ok, true, 'another holder enters only after confirmed cleanup');
        if (next.ok) runtime.pool.releaseLease(next.lease.id);
      }
    } finally { await runtime.close(); }
  });
}

test('restart reconciliation settles remote work without releasing an uncertain MCP process lease', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-host-restart-remote-work-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker');
  const workspace = join(workerRoot, 'repos', 'restart');
  const keyPath = join(directory, 'worker-key.pem');
  const databasePath = join(directory, 'state.db');
  const model = 'provider/model-host';
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

  const makeHostPi = (holdTurn: boolean) => {
    const engine = new ScriptedEngineAdapter({ turns: [scriptedTurn('Host run ended after remote work.')] });
    let closeSession: (() => Promise<void>) | undefined;
    let signalRemoteWorkStarted: (() => void) | undefined;
    const remoteWorkStarted = new Promise<void>(resolve => { signalRemoteWorkStarted = resolve; });
    const adapter = {
      id: 'pi', profileId: 'restart-host', authorizedModel: model, capabilities: engine.capabilities,
      async readiness() {
        return { profileId: 'restart-host', engine: 'pi', status: 'ready', installation: 'ready', authentication: 'ready',
          modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4', observedAt: 1 };
      },
      async startSession(request: StartSessionRequest) {
        const session = await engine.startSession(request);
        closeSession = session.close.bind(session);
        return { ...session,
          run(prompt: string) {
            const turn = session.run(prompt);
            return { events: turn.events, completion: (async () => {
              const mcp = request.remoteProjectMcp;
              assert.ok(mcp);
              const call = mcp.call;
              const toolName = mcp.tools[0]?.name;
              if (call === undefined || toolName === undefined) throw new Error('Project MCP tools are unavailable');
              assert.deepEqual(await call(toolName, { text: 'restart call' }), { status: 'completed', text: 'restart call' });
              const editRemote = request.remoteWorkspace?.edit;
              if (editRemote === undefined) throw new Error('Remote workspace edit is unavailable');
              const edit = await editRemote('target.txt', 'before', 'after', 'restart-edit');
              assert.equal(edit.status, 'failed');
              signalRemoteWorkStarted?.();
              if (holdTurn) await new Promise<void>(() => undefined);
              return turn.completion;
            })() };
          }, interrupt: session.interrupt.bind(session), close: session.close.bind(session),
        };
      },
    } as unknown as HostPiEngineAdapter;
    return { adapter, remoteWorkStarted, closeSession: async () => { await closeSession?.(); } };
  };
  const configuration = hostConfiguration({
    executionMode: 'host-run', environmentSource: 'enrollment', databasePath,
    runtimeConfiguration: { agents: [{ id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model, effort: 'medium',
      workOptions: [{ id: 'host-pi', engine: 'pi', workModel: model, effort: 'medium' }] }],
      project: { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] } },
  });
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let leaseId: string | undefined;
  let operationId: string | undefined;
  let processId: string | undefined;
  let firstHost: ReturnType<typeof makeHostPi> | undefined;
  try {
    firstHost = makeHostPi(true);
    runtime = await createRuntime({ configuration, projectRoot: '/synthetic/project-root', hostPi: firstHost.adapter });
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const requested = await runtime.enrollments.requestEnrollment({ environmentInstanceId: INSTANCE_ID, displayName: 'Restart Worker',
      publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
      capabilityRequests: ['agent-run', 'project-mcp', 'read-only-investigation'], engineFacts: [] });
    await runtime.enrollments.approve(requested.enrollment.id, { capabilityPermissions: {
      'agent-run': true, 'project-mcp': true, 'read-only-investigation': true,
    } });
    await connectRuntimeWorker(runtime, requested.enrollment.id, keyPath, undefined, workerRoot);
    await runtime.projectService.create({ id: 'restart-project', displayName: 'Restart Project' });
    await runtime.projectService.addMembership('restart-project', { agentId: 'scout' });
    await runtime.projectService.updateContent('restart-project', { mcpConfiguration: { format: 'claude-code-mcp-json-v1' } });
    await runtime.projectAccess.grant({ projectId: 'restart-project', environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'relative', path: 'repos/restart' } });

    const execute = runtime.enrollmentEnvironment.executeWorkspaceFileOperation.bind(runtime.enrollmentEnvironment);
    runtime.enrollmentEnvironment.executeWorkspaceFileOperation = async (...args) => {
      await execute(...args);
      operationId = args[1].operationId;
      throw new Error('Lost Worker edit response after the file changed');
    };
    runtime.enrollmentEnvironment.inspectWorkspaceFileOperation = async () => { throw new Error('Worker inspection was unavailable before restart'); };
    const run = await runtime.orchestrator.submit({ agentId: 'scout', projectId: 'restart-project', prompt: 'Use the remote Project MCP tool and edit the file.' });
    await firstHost.remoteWorkStarted;
    assert.equal((await runtime.orchestrator.load(run.id))?.status, 'running', 'Host-run remains active while its turn is held');
    assert.equal(readFileSync(join(workspace, 'target.txt'), 'utf8'), 'after', 'the remote edit ran before its reply was lost');
    leaseId = runtime.pool.leases().find(lease => lease.runId === run.id)?.id;
    assert.ok(leaseId);
    assert.ok(operationId);
    const initialDatabase = new DatabaseSync(databasePath);
    try {
      const store = new SqliteRemoteOperationIdentityStore(initialDatabase);
      const operation = await store.get(operationId);
      const processes = await store.listOpenMcpProcesses(INSTANCE_ID);
      assert.equal(operation?.state, 'unknown', 'Sprout keeps the lost edit reply unresolved before restart');
      assert.equal(operation?.leaseId, leaseId, 'the unresolved operation retains its containing lease');
      assert.equal(processes.length, 1, 'the MCP process identity is durable before restart');
      assert.equal(processes[0]!.state, 'running', 'the MCP process remains open while the Host-run is held');
      assert.equal(processes[0]!.agentId, 'scout');
      processId = processes[0]!.processId;
    } finally { initialDatabase.close(); }
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'active', 'the in-flight Host-run retains its original active lease');
    const inFlightCompetitor = await runtime.pool.acquireBoundOperationLeaseRevalidated({ instanceId: INSTANCE_ID,
      capability: 'agent-run', holderId: 'in-flight-competitor', runId: 'in-flight-competitor', ttlMs: 60_000 });
    assert.equal(inFlightCompetitor.ok, false, 'the active Host-run lease still blocks competing admission');
    await runtime.close();
    runtime = undefined;
    await firstHost.closeSession();

    runtime = await createRuntime({ configuration, projectRoot: '/synthetic/project-root', hostPi: makeHostPi(false).adapter });
    await runtime.reconcile();
    const recoveredRun = await runtime.orchestrator.load(run.id);
    assert.equal(recoveredRun?.status, 'failed', `the Host-run status after restart is ${recoveredRun?.status ?? 'missing'}`);
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'recovering', 'restart keeps the persisted lease in recovery');
    const competitor = await runtime.pool.acquireBoundOperationLeaseRevalidated({ instanceId: INSTANCE_ID,
      capability: 'agent-run', holderId: 'restart-competitor', runId: 'restart-competitor', ttlMs: 60_000 });
    assert.equal(competitor.ok, false, 'the original lease fences admission throughout reconciliation');

    await connectRuntimeWorker(runtime, requested.enrollment.id, keyPath, undefined, workerRoot);
    await waitFor(async () => {
      const database = new DatabaseSync(databasePath);
      try {
        const row = await new SqliteRemoteOperationIdentityStore(database).get(operationId!);
        const record = await runtime!.recovery.forLease(leaseId!);
        return row?.state === 'completed' && record?.remoteWorkEvidence?.workspaceOperations.unknown === 0 &&
          record.remoteWorkEvidence.projectMcpProcesses.uncertain === 1;
      } finally { database.close(); }
    }, 'remote operation inspection and MCP process reconciliation after restart');
    const database = new DatabaseSync(databasePath);
    try {
      const store = new SqliteRemoteOperationIdentityStore(database);
      const row = await store.get(operationId!);
      const process = await store.getMcpProcess(processId!);
      assert.equal(row?.state, 'completed', 'the Worker journal proves the edit completed without replaying it');
      assert.equal(process?.processId, processId, 'the original MCP process identity remains durable');
      assert.equal(process?.leaseId, leaseId, 'the process remains attached to the original containing lease');
      assert.equal(process?.state, 'uncertain', 'a new Worker epoch cannot turn not-found into stop proof');
    } finally { database.close(); }
    const recovery = await runtime.recovery.forLease(leaseId);
    assert.ok(recovery);
    assert.ok(recovery.unresolvedFacts.some(fact => fact.includes('Project MCP process')));
    await assert.rejects(runtime.recovery.release(leaseId));
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'recovering');
  } finally {
    if (runtime !== undefined) await runtime.close();
  }
});