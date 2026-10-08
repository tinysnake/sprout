import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { createSessionEventProgressState, sessionEventDisposition } from './engine/pi-runner-events.ts';
import { mapPiEvent, newPiTurnState } from './engine/pi-protocol.ts';
import type { HostPiEngineAdapter } from './engine/pi-host.ts';
import type { AgentRunEvent, RemoteWorkspaceOperationResult, StartSessionRequest } from './engine/port.ts';
import { toRunView } from './web/views.ts';
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

test('Host-run edits and patches only through the enrolled Worker with one run-held lease', async (t) => {
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
      assert.deepEqual(request.remoteWorkspace?.operations, ['read', 'search', 'edit', 'patch', 'command']);
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
      const session = await localEngine.startSession(request);
      return {
        sessionId: session.sessionId,
        engineSessionKey: session.engineSessionKey,
        run(prompt: string) {
          const turn = session.run(prompt);
          return {
            events: (async function* () {
              yield* runEvents;
              for await (const event of turn.events) yield event;
            })(),
            completion: turn.completion,
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
    assert.match(persistedEvents, /Remote command completed\./);
    assert.match(persistedEvents, /REMOTE_COMMAND_OK/);
    assert.deepEqual(projection.events, run.events, 'the Web Run projection carries the sanitized persisted events');
    const commandOutcomeIndex = run.events.findIndex(event => event.type === 'notice' && event.text === 'Remote command completed.');
    const summaryIndex = run.events.findIndex(event => event.type === 'message' && event.final);
    assert.ok(commandOutcomeIndex >= 0 && summaryIndex > commandOutcomeIndex, 'the remote outcome is visible before the model summary');
    assert.deepEqual(observed.map(result => result.status), ['failed', 'completed', 'completed'], JSON.stringify(observed));
    assert.equal(observed[0]?.failure, 'outcome-unknown-inspect-required');
    assert.equal(inspection?.status, 'completed');
    assert.equal(inspection?.operation?.status, 'completed');
    assert.equal(conflictingReplay?.failure, 'operation-identity-conflict');
    assert.equal(matchingReplay?.failure, 'operation-outcome-inspection-required');
    assert.equal(workerDispatches, 3, 'neither same-identity retry nor conflicting reuse reaches the Worker');
    assert.deepEqual(commandProgress.map(progress => progress.sequence), [1]);
    assert.equal(commandProgress[0]?.stream, 'stdout');
    assert.equal(commandProgress[0]?.text, 'REMOTE_COMMAND_OK\n');
    assert.equal(observed[2]?.operation, 'command');
    assert.equal(observed[2]?.output, 'REMOTE_COMMAND_OK\n');
    assert.ok(observed.every(result => result.environmentInstanceId === INSTANCE_ID && result.bindingId === access.current?.bindingId));
    assert.equal(readFileSync(join(workerRoot, 'repos', 'remote-mutation', 'src', 'target.txt'), 'utf8'), 'REMOTE_PATCHED');
    assert.equal(readFileSync(localFile, 'utf8'), 'LOCAL_SENTINEL');
    assert.equal(leasesDuringRun.length, 1);
    assert.equal(leasesDuringRun[0]?.capability, 'agent-run');
    assert.equal(leaseStateWhenRunContextPrepared, 'active', 'the temporary Run context is prepared only after lease acquisition');
    assert.equal(runContext?.runId, submitted.id);
    assert.equal(runContextRecycled, true, 'the Run context is recycled after known operation settlement');
    assert.equal(await runtime.enrollmentEnvironment.inspectRunContext(INSTANCE_ID, runContext!), 'absent');
    assert.equal(runtime.pool.leases().length, 1, 'the released lease remains inspectable');
    assert.equal(runtime.pool.leases()[0]?.state, 'released', 'the run releases its lease after confirmed settlement');

    const replay = conflictingReplay!;
    assert.equal(replay.failure, 'operation-identity-conflict');
    assert.equal(readFileSync(join(workerRoot, 'repos', 'remote-mutation', 'src', 'target.txt'), 'utf8'), 'REMOTE_PATCHED');
    const sameIdentity = matchingReplay!;
    assert.equal(sameIdentity.failure, 'operation-outcome-inspection-required');

    const holder = await runtime.pool.acquireBoundOperationLeaseRevalidated({
      instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'other-agent', runId: 'other-run', ttlMs: 60_000,
    });
    assert.equal(holder.ok, true);
    const blockedTools = await runtime.environmentOperations.attach('remote-mutation-project', 'scout', 'blocked-run');
    const blocked = await blockedTools.edit!('src/target.txt', 'REMOTE_PATCHED', 'SHOULD_NOT_APPLY', 'blocked-edit-1');
    assert.equal(blocked.failure, 'lease-conflict');
    assert.equal(blocked.leaseConflict?.holderId, 'other-agent');
    assert.equal(readFileSync(join(workerRoot, 'repos', 'remote-mutation', 'src', 'target.txt'), 'utf8'), 'REMOTE_PATCHED');
    runtime.pool.releaseLease(holder.lease.id);
  } finally {
    await runtime.close();
  }
});

test('an interrupted Host run protects its lease until remote command settlement is confirmed', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-remote-command-cancel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker-workspaces');
  const hostRoot = join(directory, 'host-project');
  const keyPath = join(directory, 'worker-key.pem');
  const model = 'provider/model-host';
  const localEngine = new ScriptedEngineAdapter({ turns: [] });
  let commandResult: Promise<RemoteWorkspaceOperationResult> | undefined;
  let remoteTools: NonNullable<StartSessionRequest['remoteWorkspace']> | undefined;
  let runContext: import('./worker/protocol.ts').RunContextParams | undefined;
  let commandStarted!: () => void;
  const started = new Promise<void>(resolve => { commandStarted = resolve; });
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
            { timeoutMs: 10_000 }, 'sdk-command-cancel-1', () => commandStarted());
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
    const prepareRunContext = runtime.enrollmentEnvironment.prepareRunContext.bind(runtime.enrollmentEnvironment);
    runtime.enrollmentEnvironment.prepareRunContext = async (environmentInstanceId, input) => {
      runContext = input;
      return prepareRunContext(environmentInstanceId, input);
    };
    await runtime.projectService.create({ id: 'remote-command-cancel-project', displayName: 'Remote command cancellation Project' });
    await runtime.projectService.addMembership('remote-command-cancel-project', { agentId: 'scout' });
    await runtime.projectAccess.grant({ projectId: 'remote-command-cancel-project', environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'relative', path: 'repos/remote-command-cancel' } });
    const submitted = await runtime.orchestrator.submit({ agentId: 'scout', projectId: 'remote-command-cancel-project', prompt: 'Run a remote command.' });
    await started;

    const actualCancel = runtime.enrollmentEnvironment.cancelWorkspaceFileOperation!.bind(runtime.enrollmentEnvironment);
    const actualInspect = runtime.enrollmentEnvironment.inspectWorkspaceFileOperation!.bind(runtime.enrollmentEnvironment);
    let unresolvedCancel: Parameters<typeof actualCancel>[1] | undefined;
    let cancelCallStarted!: () => void;
    const cancelStarted = new Promise<void>(resolve => { cancelCallStarted = resolve; });
    let resolveCancel!: (result: Awaited<ReturnType<typeof actualCancel>>) => void;
    runtime.enrollmentEnvironment.cancelWorkspaceFileOperation = async (_environmentInstanceId, input) => {
      unresolvedCancel = input;
      cancelCallStarted();
      return await new Promise(resolve => { resolveCancel = resolve; });
    };
    let inspectCallStarted!: () => void;
    const inspectStarted = new Promise<void>(resolve => { inspectCallStarted = resolve; });
    let resolveInspect!: (result: Awaited<ReturnType<typeof actualInspect>>) => void;
    runtime.enrollmentEnvironment.inspectWorkspaceFileOperation = async () => {
      inspectCallStarted();
      return await new Promise(resolve => { resolveInspect = resolve; });
    };
    const interrupting = runtime.orchestrator.interrupt(submitted.id);
    const contenderInput = { instanceId: INSTANCE_ID, capability: 'agent-run', holderId: 'other-agent', runId: 'other-run', ttlMs: 1_000 };
    try {
      await cancelStarted;
      await new Promise(resolve => setTimeout(resolve, 1_100));
      assert.equal(runtime.pool.leases()[0]?.state, 'recovering', 'unknown settlement protects the lease before awaiting cancellation');
      const whileCancelling = await runtime.pool.acquireBoundOperationLeaseRevalidated(contenderInput);
      if (whileCancelling.ok) runtime.pool.releaseLease(whileCancelling.lease.id);
      assert.equal(whileCancelling.ok, false, 'a second run cannot acquire the target after its original lease TTL');

      resolveCancel({ accepted: false, status: 'running' });
      await inspectStarted;
      await new Promise(resolve => setTimeout(resolve, 1_100));
      assert.equal(runtime.pool.leases()[0]?.state, 'recovering', 'a connected Worker that does not answer inspection remains protected');
      const whileInspecting = await runtime.pool.acquireBoundOperationLeaseRevalidated(contenderInput);
      if (whileInspecting.ok) runtime.pool.releaseLease(whileInspecting.lease.id);
      assert.equal(whileInspecting.ok, false, 'inspection timeout does not free the pinned Environment');

      resolveInspect({ status: 'unknown' });
      const interrupted = await interrupting;
      assert.equal(interrupted.status, 'interrupted', 'the Human-authorized interruption outcome is retained');
      assert.equal(runtime.pool.leases()[0]?.state, 'recovering', 'unknown inspection leaves explicit recovery required');
    } finally {
      resolveCancel?.({ accepted: false, status: 'running' });
      resolveInspect?.({ status: 'unknown' });
    }

    runtime.enrollmentEnvironment.cancelWorkspaceFileOperation = actualCancel;
    runtime.enrollmentEnvironment.inspectWorkspaceFileOperation = actualInspect;
    assert.ok(unresolvedCancel);
    assert.equal((await remoteTools!.cancel(unresolvedCancel.operationId)).accepted, true, 'explicit recovery requests cancellation');
    const result = await commandResult!;
    assert.equal(result.status, 'cancelled');
    const recovered = await remoteTools!.inspect(unresolvedCancel.operationId);
    assert.equal(recovered.status, 'cancelled', 'explicit Worker inspection confirms settlement before release');
    await waitFor(() => runtime.pool.leases()[0]?.state === 'released', 'confirmed command and Run context cleanup');
    assert.equal(await runtime.enrollmentEnvironment.inspectRunContext(INSTANCE_ID, runContext!), 'absent');
  } finally {
    await runtime.close();
  }
});
