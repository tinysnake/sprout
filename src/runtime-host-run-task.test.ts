import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import type { HostPiEngineAdapter } from './engine/pi-host.ts';
import type { StartSessionRequest } from './engine/port.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from './worker/enrollment-connector.ts';
import { toTaskContextState } from './web/views.ts';
import { connectRuntimeWorker, createRuntime, hostConfiguration, INSTANCE_ID, project, scriptedTurn } from './runtime-test-harness.ts';

test('Human-authorized Host-run Task uses Sprout Pi and keeps workspace and MCP under its Environment lease', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-host-task-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker');
  const workspace = join(workerRoot, 'repos', 'host-task');
  const keyPath = join(directory, 'worker-key.pem');
  const model = 'provider/model-host';
  const engine = new ScriptedEngineAdapter({ turns: [scriptedTurn('Task step completed.')] });
  let runToolsUsed = false;
  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  const hostPi = {
    id: 'pi', profileId: 'host-task-profile', authorizedModel: model, capabilities: engine.capabilities,
    async readiness() {
      return { profileId: 'host-task-profile', engine: 'pi', status: 'ready', installation: 'ready', authentication: 'ready',
        modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4', observedAt: 1 };
    },
    async startSession(request: StartSessionRequest) {
      const session = await engine.startSession(request);
      return {
        ...session,
        run(prompt: string) {
          const turn = session.run(prompt);
          return { events: turn.events, completion: (async () => {
            const leaseRows = runtime.pool.leases();
            assert.equal(leaseRows.length, 1, 'workspace and MCP calls share the Task lease');
            assert.equal(leaseRows[0]?.holderKind, 'task');
            assert.equal(leaseRows[0]?.state, 'active');
            const workspaceTools = request.remoteWorkspace;
            const mcpTools = request.remoteProjectMcp;
            assert.ok(workspaceTools?.edit);
            assert.ok(workspaceTools.command);
            assert.ok(mcpTools);
            assert.deepEqual(await mcpTools.call(mcpTools.tools[0]!.name, { text: 'task-held-mcp' }), {
              status: 'completed', text: 'task-held-mcp',
            });
            const edited = await workspaceTools.edit('proof.txt', 'before', 'after', 'host-task-edit');
            assert.equal(edited.status, 'completed', edited.failure ?? 'remote edit failed');
            assert.equal(readFileSync(join(workspace, 'proof.txt'), 'utf8'), 'after');
            const checked = await workspaceTools.command('node', ['--input-type=module', '-e',
              "import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; assert.equal(await readFile('proof.txt', 'utf8'), 'after');"],
            { timeoutMs: 15_000 }, 'host-task-test');
            assert.equal(checked.status, 'completed', checked.failure ?? 'remote workspace check failed');
            assert.deepEqual(runtime.pool.leases().map(row => row.id), [leaseRows[0]!.id]);
            runToolsUsed = true;
            return turn.completion;
          })() };
        },
        interrupt: session.interrupt.bind(session),
        close: session.close.bind(session),
      };
    },
  } as unknown as HostPiEngineAdapter;

  runtime = await createRuntime({ configuration: hostConfiguration({
    executionMode: 'host-run', environmentSource: 'enrollment', databasePath: join(directory, 'state.db'),
    runtimeConfiguration: {
      agents: [{ id: 'scout', name: 'Scout', engine: 'pi', capability: 'agent-run', model, effort: 'medium',
        workOptions: [{ id: 'host-pi', engine: 'pi', workModel: model, effort: 'medium' }] }],
      project: { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] },
    },
  }), projectRoot: '/synthetic/project-root', hostPi });
  try {
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID, displayName: 'Host Task Worker',
      publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
      capabilityRequests: ['agent-run', 'project-mcp', 'read-only-investigation'], engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, {
      capabilityPermissions: { 'agent-run': true, 'project-mcp': true, 'read-only-investigation': true },
    });
    await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
    await runtime.projectService.create({ id: 'host-task-project', displayName: 'Host Task Project' });
    await runtime.projectService.addMembership('host-task-project', { agentId: 'scout' });
    await runtime.projectService.updateContent('host-task-project', {
      mcpConfiguration: { format: 'claude-code-mcp-json-v1' },
    });
    await runtime.projectAccess.grant({ projectId: 'host-task-project', environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'relative', path: 'repos/host-task' } });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'proof.txt'), 'before');
    const mcpServer = `import { createInterface } from 'node:readline';
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      createInterface({ input: process.stdin }).on('line', line => {
        const r = JSON.parse(line);
        if (r.method === 'initialize') send({ jsonrpc: '2.0', id: r.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
        if (r.method === 'tools/list') send({ jsonrpc: '2.0', id: r.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] } });
        if (r.method === 'tools/call') send({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: r.params.arguments.text }] } });
      });`;
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({
      mcpServers: { fixture: { command: process.execPath, args: ['--input-type=module', '-e', mcpServer] } },
    }));

    const actor = await runtime.taskProposals.humanAuthority('host-task-project');
    const proposal = await runtime.taskProposals.propose('host-task-project', actor, {
      title: 'Host-run workspace task', goal: 'Use the selected Environment workspace and Project MCP tools.',
      constraints: [], validationCriteria: ['The bounded Project workspace check passes.'],
    });
    const begun = await runtime.taskAdmissions.beginForHuman(proposal.id, {
      expectedRevision: proposal.revision, environmentInstanceId: INSTANCE_ID,
      lead: actor, reason: 'Authorize one bounded Host-run Task.',
    });
    const taskId = begun.task.id;
    const taskLeaseId = begun.task.environmentLeaseId;
    assert.ok(taskLeaseId);
    assert.equal(begun.task.executionPlacement?.mode, 'host-run');
    assert.equal(runtime.pool.getLease(taskLeaseId)?.holderKind, 'task');
    assert.equal(runtime.pool.leases().length, 1);

    const advanced = await runtime.taskAdmissions.advanceForHuman(taskId, {
      targetAgentId: 'scout', reason: 'Run the bounded workspace check.',
    });
    const settled = await runtime.orchestrator.waitFor(advanced.runId);
    assert.equal(settled.status, 'completed', settled.failure ?? 'Host-run Task failed');
    assert.equal(settled.executionPlacement?.mode, 'host-run');
    assert.equal(settled.leaseId, taskLeaseId);
    assert.equal(runToolsUsed, true);
    assert.equal((await runtime.tasks.get(taskId))?.environmentLifecycleState, 'idle');
    assert.equal(runtime.pool.getLease(taskLeaseId)?.state, 'active', 'a settled nested run retains the Task lease');

    const claimed = await runtime.taskControls.submitCompletionClaimForHuman(taskId, {
      outcomeSummary: 'The Host-run Task passed its Project workspace check.',
      validationEvidence: ['The Environment Worker command confirmed the Host-run edit.'],
      durableChanges: ['proof.txt contains the edited content.'], limitations: [], recommendedDisposition: 'complete',
    });
    const claimId = claimed.completionClaims?.at(-1)?.id;
    assert.ok(claimId);
    const validated = await runtime.taskControls.validateForHuman(taskId, {
      claimId, decision: 'accept', reason: 'The recorded check and workspace edit are confirmed.',
    });
    assert.equal(validated.status, 'done');
    assert.equal(toTaskContextState(validated), 'recycled');
    assert.equal(runtime.pool.getLease(taskLeaseId)?.state, 'released');
    assert.equal(readFileSync(join(workspace, 'proof.txt'), 'utf8'), 'after', 'Task end preserves the Project workspace');
    assert.deepEqual(runtime.pool.leases().map(row => row.id), [taskLeaseId]);
  } finally {
    await runtime.close();
  }
});
