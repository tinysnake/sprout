import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { createSessionEventProgressState, sessionEventDisposition } from './engine/pi-runner-events.ts';
import { mapPiEvent, newPiTurnState } from './engine/pi-protocol.ts';
import type { HostPiEngineAdapter } from './engine/pi-host.ts';
import type { AgentRunEvent, RemoteWorkspaceOperationResult, StartSessionRequest } from './engine/port.ts';
import { toRunView } from './web/views.ts';
import type { ProjectMcpClientLauncher } from './worker/project-mcp.ts';
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

test('Host-run without a leased Work Environment refuses an authorized Project read', async (t) => {
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
      assert.ok(request.remoteWorkspace, 'Runtime supplies its pinned workspace boundary');
      const session = await localEngine.startSession(request);
      const tools = request.remoteWorkspace;
      return {
        sessionId: session.sessionId,
        engineSessionKey: session.engineSessionKey,
        run(prompt: string) {
          const turn = session.run(prompt);
          const read = tools!.read('sentinel.txt');
          return {
            events: turn.events,
            completion: Promise.all([turn.completion, read]).then(([result, operation]) => {
              observed.push(operation);
              return result;
            }),
          };
        },
        interrupt: () => session.interrupt(),
        close: () => session.close(),
      };
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
    assert.deepEqual(authorized.operations, [], 'a read-only capability with no lease receives no bound operations');
    const direct = await authorized.read('sentinel.txt');
    assert.equal(direct.failure, 'lease-required');
    assert.equal(readFileSync(join(workerRoot, 'repos', 'remote-read', 'sentinel.txt'), 'utf8'), 'REMOTE_WORKER_SENTINEL');

    const { id } = await runtime.orchestrator.submit({
      agentId: 'scout', projectId: 'remote-read-project', prompt: 'Read sentinel.txt.',
    });
    const run = await runtime.orchestrator.waitFor(id);
    if (run.status !== 'completed') throw new Error(`Host-run failed: ${run.failure ?? 'no failure detail'}`);
    assert.equal(run.executionMode, 'host-run');
    assert.equal(run.engineHostProfileId, 'profile-runtime-remote-read');
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.status, 'failed');
    assert.equal(observed[0]?.failure, 'lease-required');
    assert.equal(runtime.pool.leases().length, 0, 'the run performs no lazy acquisition');
  } finally {
    await runtime.close();
  }
});

test('standalone Host-run keeps Environment history but refuses bound reads without a lease', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-binding-switch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const model = 'provider/model-binding-switch';
  const environmentA = INSTANCE_ID;
  const environmentB = 'z-binding-switch-instance-b';
  const workers = [
    [environmentA, join(directory, 'worker-a')],
    [environmentB, join(directory, 'worker-b')],
  ] as const;
  for (const [environment, root] of workers) {
    mkdirSync(join(root, 'repos', 'switch-work'), { recursive: true });
    writeFileSync(join(root, 'repos', 'switch-work', 'origin.txt'), environment);
  }
  const runtimeProject = { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] };
  const localEngine = new ScriptedEngineAdapter({ turns: [
    scriptedTurn('Completed work in Environment A.'),
    scriptedTurn('Continued work in Environment B.'),
    scriptedTurn('Continued with the current Environment B session.'),
  ] });
  const starts: StartSessionRequest[] = [];
  const reads: RemoteWorkspaceOperationResult[] = [];
  const hostPi = {
    id: 'pi', profileId: 'profile-binding-switch', authorizedModel: model,
    capabilities: localEngine.capabilities,
    async readiness() {
      return { profileId: 'profile-binding-switch', engine: 'pi', status: 'ready', installation: 'ready',
        authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4', observedAt: 1 };
    },
    async startSession(request: StartSessionRequest) {
      starts.push(request);
      const session = await localEngine.startSession(request);
      return {
        sessionId: session.sessionId,
        get engineSessionKey() { return session.engineSessionKey; },
        run(prompt: string) {
          const turn = session.run(prompt);
          const shouldRead = starts.length <= 3;
          const operation = shouldRead ? request.remoteWorkspace?.read('origin.txt') : undefined;
          if (shouldRead && operation === undefined) throw new Error('the selected Environment did not publish workspace tools');
          return {
            events: turn.events,
            completion: operation === undefined
              ? turn.completion
              : Promise.all([turn.completion, operation]).then(([result, read]) => {
                reads.push(read);
                return result;
              }),
          };
        },
        interrupt: () => session.interrupt(),
        close: () => session.close(),
      };
    },
  } as unknown as HostPiEngineAdapter;
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run', environmentSource: 'enrollment',
      runtimeConfiguration: {
        agents: [{ id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model, effort: 'medium',
          workOptions: [{ id: 'host-pi', engine: 'pi', workModel: model, effort: 'medium' }] }],
        project: runtimeProject,
      },
      databasePath: join(directory, 'state.db'),
    }),
    projectRoot: '/synthetic/project-root', hostPi,
  });

  try {
    for (const [index, [environment, root]] of workers.entries()) {
      const keyPath = join(directory, `worker-${index}.pem`);
      const identity = loadOrCreateWorkerIdentity(keyPath);
      const enrollment = await runtime.enrollments.requestEnrollment({
        environmentInstanceId: environment, displayName: `Binding switch Worker ${index}`,
        publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
        capabilityRequests: ['read-only-investigation'], engineFacts: [],
      });
      await runtime.enrollments.approve(enrollment.enrollment.id, {
        capabilityPermissions: { 'read-only-investigation': true },
      });
      await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, root);
    }
    await runtime.projectService.create({ id: 'binding-switch-project', displayName: 'Binding switch Project' });
    await runtime.projectService.addMembership('binding-switch-project', {
      agentId: 'scout', responsibilities: [], collaborationInstructions: '',
    });
    for (const environment of [environmentA, environmentB]) {
      await runtime.projectAccess.grant({
        projectId: 'binding-switch-project', environmentInstanceId: environment,
        selection: { kind: 'relative', path: 'repos/switch-work' },
      });
    }

    const submit = async (
      workEnvironmentInstanceId: string | undefined,
      prompt: string,
      scope = 'binding-switch-conversation',
    ) => {
      const { id } = await runtime.orchestrator.submit({
        agentId: 'scout', projectId: 'binding-switch-project',
        ...(workEnvironmentInstanceId !== undefined ? { workEnvironmentInstanceId } : {}),
        sessionKeyScope: { kind: 'conversation', id: scope }, prompt,
      });
      return runtime.orchestrator.waitFor(id);
    };
    const runA = await submit(environmentA, 'Read the current Environment origin.');
    const runB = await submit(environmentB, 'Continue the work in the selected Environment.');
    const runBResume = await submit(undefined, 'Continue with the current grant.');
    const isolatedScope = await submit(undefined, 'Start an independent conversation.', 'other-conversation');
    await runtime.projectAccess.end({ projectId: 'binding-switch-project', environmentInstanceId: environmentB });
    const unavailable = await submit('binding-switch-unauthorized', 'Use only the requested Environment.');
    const retainedBindingUnavailable = await submit(undefined, 'Keep the last selected Environment; fail closed.');

    assert.equal(runA.status, 'completed');
    assert.equal(runB.status, 'completed');
    assert.equal(runBResume.status, 'completed');
    assert.equal(isolatedScope.status, 'completed');
    assert.equal(isolatedScope.requestedWorkEnvironmentInstanceId, undefined);
    assert.equal(isolatedScope.workspaceBinding?.environmentInstanceId, environmentA,
      'a new conversation does not inherit B from another conversation and follows only the Project default');
    assert.equal(unavailable.status, 'failed');
    assert.equal(unavailable.workspaceBindingStatus, 'unavailable');
    assert.equal(retainedBindingUnavailable.status, 'failed', 'a revoked retained binding cannot fall back to Environment A');
    assert.equal(retainedBindingUnavailable.workspaceBindingStatus, 'unavailable');
    assert.equal(starts.length, 4, 'an unavailable requested or retained Environment does not start a local fallback session');
    assert.equal(runA.workspaceBindingStatus, 'active');
    assert.equal(runB.workspaceBindingStatus, 'active');
    assert.equal(runA.workspaceBinding?.environmentInstanceId, environmentA);
    assert.equal(runB.workspaceBinding?.environmentInstanceId, environmentB);
    assert.equal(runA.workspaceBinding?.generation, 1);
    assert.equal(runB.workspaceBinding?.generation, 1);
    assert.equal(runBResume.requestedWorkEnvironmentInstanceId, environmentB,
      'the latest authorized binding stays selected when the next activation omits a selector');
    assert.equal(retainedBindingUnavailable.requestedWorkEnvironmentInstanceId, environmentB,
      'an unavailable retained binding stays the attempted binding instead of selecting another grant');
    assert.equal(reads[0]?.failure, 'lease-required');
    assert.equal(reads[1]?.failure, 'lease-required');
    assert.equal(reads[2]?.failure, 'lease-required');
    assert.equal(starts[0]?.resumeSessionKey, undefined);
    assert.equal(starts[1]?.resumeSessionKey, undefined, 'Environment B cannot resume Environment A native history');
    assert.equal(starts[2]?.resumeSessionKey, 'scripted-key-2', 'same current grant resumes its native session');
    const promptB = localEngine.sessions[1]?.prompts[0] ?? '';
    assert.match(promptB, /Sprout switched the current Work Environment from composition-instance to z-binding-switch-instance-b/);
    assert.match(starts[1]?.instructions ?? '', /Sprout current workspace and capability snapshot/);
    assert.match(starts[1]?.instructions ?? '', /Environment: z-binding-switch-instance-b/);
    assert.ok(starts[1]?.instructions?.includes('Remote workspace operations: none'));
    assert.match(starts[1]?.instructions ?? '', /Binding change: Sprout switched the current Work Environment from composition-instance to z-binding-switch-instance-b/);
    assert.match(promptB, /Environment composition-instance, relative workspace at binding generation 1: Completed work in Environment A\./);
    assert.match(starts[2]?.instructions ?? '', /Sprout current workspace and capability snapshot/,
      'native resume reconstructs the current state in the session system prompt');
    assert.match(starts[2]?.instructions ?? '', /Environment: z-binding-switch-instance-b/);
    assert.match(starts[3]?.instructions ?? '', /Status: active/);
    assert.match(starts[3]?.instructions ?? '', /Environment: composition-instance/);
    assert.equal(starts[3]?.remoteWorkspace?.binding.environmentInstanceId, environmentA,
      'a separate conversation resolves the Project default instead of inheriting Environment B');
    const staleRead = await starts[0]?.remoteWorkspace?.read('origin.txt');
    assert.equal(staleRead?.status, 'failed', 'a prior generation cannot call after the new binding is published');
    assert.equal(reads.length, 3, 'the stale call never executes against either Worker');
    assert.equal(runtime.pool.leases().length, 0, 'selected read-only Work Environments do not acquire leases lazily');
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
    const refused = await tools.read('sentinel.txt');
    assert.equal(refused.status, 'failed');
    assert.equal(refused.failure, 'lease-required', 'without a lease, the disconnected Worker is never contacted');
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

test('Project MCP discovery failure keeps the Task lease recovering until child termination is confirmed', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-project-mcp-discovery-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker-workspaces');
  const keyPath = join(directory, 'worker-key.pem');
  const model = 'provider/model-host';
  const runtimeProject = { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] };
  const localEngine = new ScriptedEngineAdapter({ turns: [scriptedTurn('MCP discovery should block startup.')] });
  let closeCalls = 0;
  const launcher: ProjectMcpClientLauncher = async (_server, _cwd, onCreated) => {
    const client = {
      async discoverTools() { throw new Error('fixture discovery failed'); },
      async callTool() { return {}; },
      async close() { closeCalls += 1; return closeCalls >= 3; },
    };
    onCreated(client);
    return client;
  };
  const hostPi = {
    id: 'pi', profileId: 'profile-runtime-project-mcp-discovery-failure', authorizedModel: model,
    capabilities: localEngine.capabilities,
    async readiness() {
      return { profileId: 'profile-runtime-project-mcp-discovery-failure', engine: 'pi', status: 'ready', installation: 'ready',
        authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4', observedAt: 1 };
    },
    async startSession() { throw new Error('Host Pi must not start after MCP discovery fails'); },
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
      environmentInstanceId: INSTANCE_ID, displayName: 'Uncertain MCP Worker', publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos', protocolVersion: '3.0', capabilityRequests: ['agent-run', 'project-mcp'], engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, { capabilityPermissions: { 'agent-run': true, 'project-mcp': true } });
    await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot, launcher);
    const projectId = 'remote-mcp-discovery-failure';
    await runtime.projectService.create({ id: projectId, displayName: 'Discovery Failure Project' });
    await runtime.projectService.addMembership(projectId, { agentId: 'scout' });
    await runtime.projectService.updateContent(projectId, { mcpConfiguration: { format: 'claude-code-mcp-json-v1' } });
    await runtime.projectAccess.grant({
      projectId, environmentInstanceId: INSTANCE_ID, selection: { kind: 'relative', path: 'repos/discovery-failure' },
    });
    mkdirSync(join(workerRoot, 'repos', 'discovery-failure'), { recursive: true });
    writeFileSync(join(workerRoot, 'repos', 'discovery-failure', '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'unused' } } }));
    const task = await runtime.tasks.create({ projectId, title: 'MCP discovery failure', goal: 'Prove uncertain cleanup keeps the Task lease', assignedAgentId: 'scout' });
    const begun = await runtime.tasks.begin(task.id);
    const advanced = await runtime.tasks.advance(task.id, { prompt: 'Start the Project MCP tool.' });
    const run = await runtime.orchestrator.waitFor(advanced.runId);
    assert.equal(run.status, 'failed');
    assert.equal(closeCalls, 2, 'discovery failure and Worker stop both fail to confirm termination');
    const leaseId = begun.environmentLeaseId;
    assert.ok(leaseId);
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'recovering');
    assert.ok(await runtime.recovery.forLease(leaseId), 'shared Environment recovery retains the Task lease');
    const openProcess = new DatabaseSync(join(directory, 'state.db'));
    try {
      const row = openProcess.prepare('SELECT process_id, state, holder_kind, holder_id, run_id FROM remote_project_mcp_processes LIMIT 1').get() as Record<string, unknown> | undefined;
      assert.equal(row?.state, 'uncertain');
      assert.equal(row?.holder_kind, 'task');
      assert.equal(row?.holder_id, task.id);
      assert.equal(row?.run_id, advanced.runId);
    } finally {
      openProcess.close();
    }

    await runtime.environmentOperations.reconcileProjectMcpProcesses(INSTANCE_ID);
    assert.equal(closeCalls, 3, 'reconciliation reaches the retained child identity and confirms termination');
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'recovering');
  } finally {
    await runtime.close();
  }
  const database = new DatabaseSync(join(directory, 'state.db'));
  try {
    const row = database.prepare('SELECT state FROM remote_project_mcp_processes LIMIT 1').get() as Record<string, unknown> | undefined;
    assert.equal(row?.state, 'stopped');
  } finally {
    database.close();
  }
});

test('Host-run Task calls typed Project MCP tools under its Task-held Environment lease and protects uncertainty', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-project-mcp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker-workspaces');
  const keyPath = join(directory, 'worker-key.pem');
  const model = 'provider/model-host';
  const runtimeProject = { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] };
  const localEngine = new ScriptedEngineAdapter({ turns: [scriptedTurn('Project MCP tool completed.')] });
  const observed: unknown[] = [];
  let closeWorkerConnection: (() => void) | undefined;
  let taskId: string | undefined;
  let taskLeaseId: string | undefined;
  let taskRunId: string | undefined;
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
      const lease = runtime.pool.leases().find(row => row.capability === 'agent-run');
      assert.ok(lease);
      assert.equal(lease.state, 'active');
      assert.equal(lease.holderKind, 'task');
      observed.push(await mcp.call(mcp.tools[0]!.name, { text: 'hello from Pi' }));
      assert.deepEqual(await mcp.call('mcp_unrelated_tool', { text: 'wrong origin' }), { status: 'failed', reason: 'unknown-tool' });
      observed.push(await mcp.call(mcp.tools[0]!.name, { text: 12 } as unknown as Record<string, unknown>));
      closeWorkerConnection?.();
      await waitFor(() => runtime.workerGateway.liveFor(INSTANCE_ID) === undefined, 'Worker disconnection before MCP stop');
      assert.deepEqual(await mcp.call(mcp.tools[0]!.name, { text: 'stale call' }), { status: 'failed', reason: 'worker-refused' });
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
      platform: 'macos', protocolVersion: '3.0', capabilityRequests: ['agent-run', 'project-mcp'], engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, { capabilityPermissions: { 'agent-run': true, 'project-mcp': true } });
    const connection = await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
    closeWorkerConnection = () => connection.close();
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
    const task = await runtime.tasks.create({ projectId, title: 'Remote MCP Task', goal: 'Use the remote Project MCP tool', assignedAgentId: 'scout' });
    taskId = task.id;
    const begun = await runtime.tasks.begin(task.id);
    taskLeaseId = begun.environmentLeaseId;
    assert.equal(begun.environmentInstanceId, INSTANCE_ID);
    const advanced = await runtime.tasks.advance(task.id, { prompt: 'Use the Project MCP echo tool.' });
    taskRunId = advanced.runId;
    const run = await runtime.orchestrator.waitFor(advanced.runId);
    assert.equal(run.status, 'completed', run.failure ?? 'run did not complete');
    assert.deepEqual(observed, [
      { status: 'completed', text: 'hello from Pi' },
      { status: 'failed', reason: 'invalid-arguments' },
    ], `observed MCP results: ${JSON.stringify(observed)}`);
    assert.equal(runtime.pool.leases().some(row => row.capability === 'project-mcp'), false, 'MCP reuses the Task-held lease instead of acquiring another lease');
    assert.equal(runtime.pool.leases().find(row => row.capability === 'agent-run')?.state, 'recovering');
    assert.ok(taskLeaseId);
    assert.ok(await runtime.recovery.forLease(taskLeaseId), 'uncertain MCP stop opens shared Environment recovery');
  } finally {
    await runtime.close();
  }
  if (taskId && taskLeaseId && taskRunId) {
    const database = new DatabaseSync(join(directory, 'state.db'));
    try {
      const processRow = database.prepare('SELECT process_id, state, holder_kind, holder_id, task_id, run_id FROM remote_project_mcp_processes LIMIT 1').get() as Record<string, unknown> | undefined;
      const operationRow = database.prepare('SELECT state, process_id, tool_id FROM remote_project_mcp_operations LIMIT 1').get() as Record<string, unknown> | undefined;
      assert.equal(processRow?.state, 'uncertain');
      assert.equal(processRow?.holder_kind, 'task');
      assert.equal(processRow?.holder_id, taskId);
      assert.equal(processRow?.task_id, taskId);
      assert.equal(processRow?.run_id, taskRunId);
      assert.equal(operationRow?.state, 'completed');
      assert.equal(operationRow?.process_id, processRow?.process_id);
      assert.equal(typeof operationRow?.tool_id, 'string');
    } finally {
      database.close();
    }
  }
});

test('Host-run without a containing lease refuses edit, patch, and command without changing remote work', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-remote-mutation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker-workspaces');
  const hostRoot = join(directory, 'host-project');
  const keyPath = join(directory, 'worker-key.pem');
  const model = 'provider/model-host';
  const localFile = join(hostRoot, 'repos', 'remote-mutation', 'src', 'target.txt');
  mkdirSync(join(hostRoot, 'repos', 'remote-mutation', 'src'), { recursive: true });
  writeFileSync(localFile, 'LOCAL_SENTINEL');
  const localEngine = new ScriptedEngineAdapter({ turns: [scriptedTurn('Remote changes completed.')] });
  const observed: RemoteWorkspaceOperationResult[] = [];
  let inspection: { readonly status: string; readonly operation?: RemoteWorkspaceOperationResult } | undefined;
  let conflictingReplay: RemoteWorkspaceOperationResult | undefined;
  let matchingReplay: RemoteWorkspaceOperationResult | undefined;
  let workerDispatches = 0;
  let leasesDuringRun: readonly { readonly capability: string }[] = [];
  const commandProgress: { readonly sequence: number; readonly stream: string; readonly text: string }[] = [];
  const pathSentinel = '/srv/synthetic-host/private/remote-sentinel.txt';
  const credentialSentinel = 'api_key=ghp_abcdefghijklmnopqrstuvwx';
  let runContext: import('./worker/protocol.ts').RunContextParams | undefined;
  let leaseStateWhenRunContextPrepared: string | undefined;
  let runContextRecycled = false;
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  const hostPi = {
    id: 'pi', profileId: 'profile-runtime-remote-mutation', authorizedModel: model,
    capabilities: localEngine.capabilities,
    async readiness() {
      return { profileId: 'profile-runtime-remote-mutation', engine: 'pi', status: 'ready', installation: 'ready',
        authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4', observedAt: 1 };
    },
    async startSession(request: StartSessionRequest) {
      assert.deepEqual(request.remoteWorkspace?.operations, [], 'the Host-run has no lease and receives no bound tools');
      const tools = request.remoteWorkspace!;
      const runEvents: AgentRunEvent[] = [];
      const turnState = newPiTurnState();
      const eventState = {
        settled: false,
        remoteToolNames: ['remote_read', 'remote_search', 'remote_edit', 'remote_patch', 'remote_command', 'remote_inspect'],
        progress: createSessionEventProgressState(),
      };
      const emitPiEvent = (event: Record<string, unknown>): void => {
        const disposition = sessionEventDisposition(event, eventState);
        if (disposition.action === 'pi-event') runEvents.push(...mapPiEvent(disposition.event, turnState).events);
      };
      const startTool = (toolName: string, args: unknown, toolCallId: string): void => {
        emitPiEvent({ type: 'tool_execution_start', toolName, args, toolCallId });
      };
      const endTool = (toolName: string, result: RemoteWorkspaceOperationResult | { readonly status: string; readonly operation?: RemoteWorkspaceOperationResult }, toolCallId: string): void => {
        emitPiEvent({ type: 'tool_execution_end', toolName, toolCallId, result: { content: [], details: result }, isError: result.status !== 'completed' });
      };
      const executeRemoteTools = async (): Promise<void> => {
        const editArgs = { path: 'src/target.txt', oldText: pathSentinel, newText: credentialSentinel };
      startTool('remote_edit', editArgs, 'call-edit-1');
      observed.push(await tools.edit!('src/target.txt', pathSentinel, credentialSentinel, 'sdk-edit-1'));
      endTool('remote_edit', observed[0]!, 'call-edit-1');
      startTool('remote_inspect', { operationId: observed[0]!.operationId }, 'call-inspect-1');
      inspection = await tools.inspect(observed[0]!.operationId);
      endTool('remote_inspect', inspection, 'call-inspect-1');
      const conflictingArgs = { path: 'src/target.txt', oldText: pathSentinel, newText: 'CHANGED_PAYLOAD' };
      startTool('remote_edit', conflictingArgs, 'call-edit-2');
      conflictingReplay = await tools.edit!('src/target.txt', pathSentinel, 'CHANGED_PAYLOAD', 'sdk-edit-1');
      endTool('remote_edit', conflictingReplay, 'call-edit-2');
      startTool('remote_edit', editArgs, 'call-edit-3');
      matchingReplay = await tools.edit!('src/target.txt', pathSentinel, credentialSentinel, 'sdk-edit-1');
      endTool('remote_edit', matchingReplay, 'call-edit-3');
      const patchArgs = { path: 'src/target.txt', hunks: [{ before: credentialSentinel, after: 'REMOTE_PATCHED' }] };
      startTool('remote_patch', patchArgs, 'call-patch-1');
      observed.push(await tools.patch!('src/target.txt', [{ before: credentialSentinel, after: 'REMOTE_PATCHED' }], 'sdk-patch-1'));
      endTool('remote_patch', observed[1]!, 'call-patch-1');
      const commandArgs = ['-e', "process.stdout.write('REMOTE_COMMAND_OK\\n')", pathSentinel];
      startTool('remote_command', { executable: 'node', args: commandArgs, cwd: 'src', timeoutMs: 5_000 }, 'sdk-command-1');
      let commandOutput = '';
      observed.push(await tools.command!('node', commandArgs, { cwd: 'src', timeoutMs: 5_000 }, 'sdk-command-1', progress => {
        commandProgress.push(progress);
        commandOutput += progress.text;
        emitPiEvent({ type: 'tool_execution_update', toolName: 'remote_command', toolCallId: 'sdk-command-1',
          partialResult: { content: [{ type: 'text', text: commandOutput }], details: { sequence: progress.sequence, stream: progress.stream } } });
      }));
      endTool('remote_command', observed[2]!, 'sdk-command-1');
      leasesDuringRun = runtime!.pool.leases();
      };
      const session = await localEngine.startSession(request);
      return {
        sessionId: session.sessionId,
        engineSessionKey: session.engineSessionKey,
        run(prompt: string) {
          const turn = session.run(prompt);
          const operations = executeRemoteTools();
          return {
            events: (async function* () {
              await operations;
              yield* runEvents;
              for await (const event of turn.events) yield event;
            })(),
            completion: Promise.all([turn.completion, operations]).then(([result]) => result),
          };
        },
        interrupt: session.interrupt.bind(session),
        close: session.close.bind(session),
      };
    },
  } as unknown as HostPiEngineAdapter;
  runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run', environmentSource: 'enrollment',
      runtimeConfiguration: {
        agents: [{ id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model, effort: 'medium',
          workOptions: [{ id: 'host-pi', engine: 'pi', workModel: model, effort: 'medium' }] }],
        project: { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] },
      },
      databasePath: join(directory, 'state.db'),
    }),
    projectRoot: hostRoot,
    hostPi,
  });

  try {
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID, displayName: 'Remote mutation Worker',
      publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
      capabilityRequests: ['agent-run', 'read-only-investigation'], engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, {
      capabilityPermissions: { 'agent-run': true, 'read-only-investigation': true },
    });
    await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
    assert.equal(runtime.pool.requiresLeaseForBoundOperation(INSTANCE_ID, 'agent-run'), true);
    const prepareRunContext = runtime.enrollmentEnvironment.prepareRunContext.bind(runtime.enrollmentEnvironment);
    runtime.enrollmentEnvironment.prepareRunContext = async (environmentInstanceId, input) => {
      runContext = input;
      leaseStateWhenRunContextPrepared = runtime!.pool.leases().find(lease => lease.runId === input.runId)?.state;
      return prepareRunContext(environmentInstanceId, input);
    };
    const recycleRunContext = runtime.enrollmentEnvironment.recycleRunContext.bind(runtime.enrollmentEnvironment);
    runtime.enrollmentEnvironment.recycleRunContext = async (environmentInstanceId, input) => {
      await recycleRunContext(environmentInstanceId, input);
      runContextRecycled = true;
    };
    const execute = runtime.enrollmentEnvironment.executeWorkspaceFileOperation.bind(runtime.enrollmentEnvironment);
    let loseNextResponse = true;
    runtime.enrollmentEnvironment.executeWorkspaceFileOperation = async (environmentInstanceId, input, onProgress) => {
      workerDispatches++;
      const result = await execute(environmentInstanceId, input, onProgress);
      if (loseNextResponse && (input.operation === 'edit' || input.operation === 'patch')) {
        loseNextResponse = false;
        throw new Error('simulated Worker response loss');
      }
      return result;
    };
    await runtime.projectService.create({ id: 'remote-mutation-project', displayName: 'Remote mutation Project' });
    await runtime.projectService.addMembership('remote-mutation-project', { agentId: 'scout' });
    const access = await runtime.projectAccess.grant({
      projectId: 'remote-mutation-project', environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'relative', path: 'repos/remote-mutation' },
    });
    mkdirSync(join(workerRoot, 'repos', 'remote-mutation', 'src'), { recursive: true });
    writeFileSync(join(workerRoot, 'repos', 'remote-mutation', 'src', 'target.txt'), pathSentinel);

    const submitted = await runtime.orchestrator.submit({ agentId: 'scout', projectId: 'remote-mutation-project', prompt: 'Edit and patch the remote file.' });
    const run = await runtime.orchestrator.waitFor(submitted.id);
    if (run.status !== 'completed') throw new Error(`Host-run failed: ${run.failure ?? 'no failure detail'}`);
    const projection = toRunView(run);
    const persistedEvents = JSON.stringify(run.events);
    const projectedEvents = JSON.stringify(projection.events);
    for (const sentinel of [pathSentinel, credentialSentinel]) {
      assert.ok(!persistedEvents.includes(sentinel), `persisted Run events omit ${sentinel.startsWith('/') ? 'the host path' : 'the credential'}`);
      assert.ok(!projectedEvents.includes(sentinel), `Web Run projection omits ${sentinel.startsWith('/') ? 'the host path' : 'the credential'}`);
    }
    assert.match(persistedEvents, /Remote edit failed\./, 'remote edit status is visible independently of the model summary');
    assert.doesNotMatch(persistedEvents, /REMOTE_COMMAND_OK/);
    assert.deepEqual(projection.events, run.events, 'the Web Run projection carries the sanitized persisted events');
    const commandOutcomeIndex = run.events.findIndex(event => event.type === 'notice' && event.text === 'Remote command failed.');
    const summaryIndex = run.events.findIndex(event => event.type === 'message' && event.final);
    assert.ok(commandOutcomeIndex >= 0 && summaryIndex > commandOutcomeIndex, 'the refusal is visible before the model summary');
    assert.deepEqual(observed.map(result => result.status), ['failed', 'failed', 'failed']);
    assert.equal(observed[0]?.failure, 'containing-lease-unavailable');
    assert.equal(inspection?.status, 'not-found');
    assert.equal(conflictingReplay?.failure, 'containing-lease-unavailable');
    assert.equal(matchingReplay?.failure, 'containing-lease-unavailable');
    assert.equal(workerDispatches, 0, 'edit, patch, and command never reach the Worker');
    assert.deepEqual(commandProgress, []);
    assert.equal(observed[2]?.operation, 'command');
    assert.equal(observed[2]?.failure, 'containing-lease-unavailable');
    assert.ok(observed.every(result => result.environmentInstanceId === INSTANCE_ID && result.bindingId === access.current?.bindingId));
    assert.equal(readFileSync(join(workerRoot, 'repos', 'remote-mutation', 'src', 'target.txt'), 'utf8'), pathSentinel,
      'all refused operations preserve the remote workspace bytes');
    assert.equal(readFileSync(localFile, 'utf8'), 'LOCAL_SENTINEL');
    assert.deepEqual(leasesDuringRun, []);
    assert.equal(leaseStateWhenRunContextPrepared, undefined);
    assert.equal(runContext, undefined);
    assert.equal(runContextRecycled, false);
    assert.equal(runtime.pool.leases().length, 0, 'no lease was acquired by a workspace operation');

    const replay = conflictingReplay!;
    assert.equal(replay.failure, 'containing-lease-unavailable');
    assert.equal(readFileSync(join(workerRoot, 'repos', 'remote-mutation', 'src', 'target.txt'), 'utf8'), pathSentinel);
    const sameIdentity = matchingReplay!;
    assert.equal(sameIdentity.failure, 'containing-lease-unavailable');

    const holder = await runtime.pool.acquireBoundOperationLeaseRevalidated({
      instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'other-agent', runId: 'other-run', ttlMs: 60_000,
    });
    assert.equal(holder.ok, true);
    const blockedTools = await runtime.environmentOperations.attach('remote-mutation-project', 'scout', 'blocked-run');
    const blocked = await blockedTools.edit!('src/target.txt', 'REMOTE_PATCHED', 'SHOULD_NOT_APPLY', 'blocked-edit-1');
    assert.equal(blocked.failure, 'containing-lease-unavailable');
    assert.equal(readFileSync(join(workerRoot, 'repos', 'remote-mutation', 'src', 'target.txt'), 'utf8'), pathSentinel);
    assert.equal(runtime.pool.getLease(holder.lease.id)?.state, 'active', 'refused workspace tools do not alter the competing lease');
    runtime.pool.releaseLease(holder.lease.id);
  } finally {
    await runtime.close();
  }
});

test('an unselected Host-run Work Environment refuses bound commands without acquiring a lease', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-remote-command-cancel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker-workspaces');
  const hostRoot = join(directory, 'host-project');
  const keyPath = join(directory, 'worker-key.pem');
  const model = 'provider/model-host';
  const localEngine = new ScriptedEngineAdapter({ turns: [] });
  let commandResult: Promise<RemoteWorkspaceOperationResult> | undefined;
  let remoteTools: NonNullable<StartSessionRequest['remoteWorkspace']> | undefined;
  let workerDispatches = 0;
  let resolveCommandAttempt!: (result: RemoteWorkspaceOperationResult) => void;
  const commandAttempt = new Promise<RemoteWorkspaceOperationResult>(resolve => { resolveCommandAttempt = resolve; });
  let settleCompletion!: (result: { readonly status: 'interrupted' }) => void;
  const completion = new Promise<{ readonly status: 'interrupted' }>(resolve => { settleCompletion = resolve; });
  const hostPi = {
    id: 'pi', profileId: 'profile-runtime-remote-command-cancel', authorizedModel: model,
    capabilities: localEngine.capabilities,
    async readiness() {
      return { profileId: 'profile-runtime-remote-command-cancel', engine: 'pi', status: 'ready', installation: 'ready',
        authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4', observedAt: 1 };
    },
    async startSession(request: StartSessionRequest) {
      const tools = request.remoteWorkspace!;
      remoteTools = tools;
      return {
        sessionId: 'command-cancel-session', engineSessionKey: 'command-cancel-session',
        run() {
          commandResult = tools.command!('node', ['-e', "process.stdout.write('STARTED\\n');setInterval(()=>{},1000)"],
            { timeoutMs: 10_000 }, 'sdk-command-cancel-1');
          void commandResult.then(result => {
            resolveCommandAttempt(result);
            settleCompletion({ status: 'interrupted' });
          });
          return { events: (async function* () {})(), completion };
        },
        async interrupt() { return true; },
        async close() { settleCompletion({ status: 'interrupted' }); },
      };
    },
  } as unknown as HostPiEngineAdapter;
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run', environmentSource: 'enrollment',
      runtimeConfiguration: {
        agents: [{ id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model, effort: 'medium',
          workOptions: [{ id: 'host-pi', engine: 'pi', workModel: model, effort: 'medium' }] }],
        project: { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] },
      },
      databasePath: join(directory, 'state.db'),
      leaseTtlMs: 1_000,
    }), projectRoot: hostRoot, hostPi,
  });
  try {
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID, displayName: 'Remote command cancellation Worker',
      publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
      capabilityRequests: ['agent-run', 'read-only-investigation'], engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, {
      capabilityPermissions: { 'agent-run': true, 'read-only-investigation': true },
    });
    await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
    const execute = runtime.enrollmentEnvironment.executeWorkspaceFileOperation.bind(runtime.enrollmentEnvironment);
    runtime.enrollmentEnvironment.executeWorkspaceFileOperation = async (...args) => {
      workerDispatches++;
      return await execute(...args);
    };
    await runtime.projectService.create({ id: 'remote-command-cancel-project', displayName: 'Remote command cancellation Project' });
    await runtime.projectService.addMembership('remote-command-cancel-project', { agentId: 'scout' });
    await runtime.projectAccess.grant({ projectId: 'remote-command-cancel-project', environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'relative', path: 'repos/remote-command-cancel' } });
    const submitted = await runtime.orchestrator.submit({ agentId: 'scout', projectId: 'remote-command-cancel-project', prompt: 'Run a remote command.' });
    const refused = await commandAttempt;
    assert.equal(refused.status, 'failed');
    assert.equal(refused.failure, 'containing-lease-unavailable');
    assert.deepEqual(remoteTools?.operations, [], 'the run receives no bound workspace operation catalog');
    assert.equal(workerDispatches, 0, 'the refused command performs no remote operation');
    assert.equal(runtime.pool.leases().length, 0, 'a run with no selected leased Work Environment acquires no lease');
    await waitFor(async () => (await runtime.orchestrator.load(submitted.id))?.status === 'interrupted', 'the run settles after refusing bound work');
    assert.equal((await runtime.orchestrator.load(submitted.id))?.status, 'interrupted');
  } finally {
    await runtime.close();
  }
});
