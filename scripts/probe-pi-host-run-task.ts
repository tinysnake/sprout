import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProductionHostPiAdapter, type HostPiEngineAdapter } from '../src/engine/pi-host.ts';
import type { EngineSession, RemoteProjectMcpTools, RemoteWorkspaceOperationResult, StartSessionRequest } from '../src/engine/port.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from '../src/worker/enrollment-connector.ts';
import { sanitizedProbeErrorFields } from '../src/engine/pi-error-facts.ts';
import { toTaskContextState } from '../src/web/views.ts';
import {
  connectRuntimeWorker,
  createRuntime,
  hostConfiguration,
  INSTANCE_ID,
  project,
  runtimePorts,
} from '../src/runtime-test-harness.ts';

/**
 * Bounded model-issued Host-run Task probe through the local Anthropic-compatible gateway.
 * Prints sanitized facts only and removes temporary Pi session and workspace data.
 */
const root = await mkdtemp(join(tmpdir(), 'sprout-host-task-probe-'));
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let taskLeaseId: string | undefined;
let stage = 'host-pi-profile';
const observedOperations: { readonly kind: string; readonly status: string; readonly failure: string; readonly inputMatchedExpected: boolean; readonly inputFacts: readonly string[]; readonly bindingMatched: boolean; readonly taskLeaseHeld: boolean }[] = [];
const remoteFailureCodes = new Set([
  'invalid-path', 'not-text', 'file-too-large', 'content-conflict', 'invalid-patch', 'operation-limit',
  'command-not-allowed', 'command-timeout', 'run-context-unavailable', 'not-found', 'unsupported',
  'operation-identity-conflict', 'outcome-unknown-inspect-required', 'operation-journal-unavailable',
  'command-start-failed', 'command-failed', 'cancelled', 'descendant-process-unknown',
  'command-supervision-unsupported',
]);

const taskCommandArgs = ['--version'];
const taskFixturePath = 'README.md';
let runPromptNamesTarget = false;
let runPromptContainsExactRead = false;

type Binding = {
  readonly projectId: string;
  readonly environmentInstanceId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly connectionEpoch: number;
  readonly workspaceId: string;
};

function report(facts: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(facts)}\n`);
}

async function availablePortInAssignedRange(): Promise<number> {
  for (let port = 41000; port <= 41009; port++) {
    const server = createServer();
    const available = await new Promise<boolean>((resolveProbe) => {
      server.once('error', () => resolveProbe(false));
      server.listen(port, 'localhost', () => server.close(() => resolveProbe(true)));
    });
    if (available) return port;
  }
  throw new Error('assigned-port-block-unavailable');
}

function relativePathShape(value: string | undefined): string {
  if (value === undefined) return 'omitted';
  if (value.length === 0) return 'empty';
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return 'absolute';
  const segments = normalized.split('/');
  if (segments.includes('..')) return 'parent-segment';
  if (segments.includes('.')) return 'dot-segment';
  if (segments.some(segment => segment.length === 0)) return 'empty-segment';
  return segments.length === 1 ? (normalized === taskFixturePath ? 'workspace-root-target-file' : 'workspace-root-file') : 'nested-relative';
}

function commandCwdShape(value: string | undefined): string {
  if (value === undefined) return 'omitted-project-root';
  if (value === '.') return 'explicit-project-root';
  return relativePathShape(value);
}

function bindingsMatch(left: Binding, right: Binding): boolean {
  return left.projectId === right.projectId && left.environmentInstanceId === right.environmentInstanceId &&
    left.bindingId === right.bindingId && left.generation === right.generation &&
    left.connectionEpoch === right.connectionEpoch && left.workspaceId === right.workspaceId;
}

function taskLeaseHeld(): boolean {
  if (!runtime || !taskLeaseId) return false;
  const lease = runtime.pool.getLease(taskLeaseId);
  const leases = runtime.pool.leases();
  return lease?.holderKind === 'task' && lease.state === 'active' && leases.length === 1 && leases[0]?.id === taskLeaseId;
}

function observeTaskCapabilities(adapter: HostPiEngineAdapter): HostPiEngineAdapter {
  return {
    id: adapter.id,
    profileId: adapter.profileId,
    authorizedModel: adapter.authorizedModel,
    capabilities: adapter.capabilities,
    readiness: adapter.readiness.bind(adapter),
    async startSession(request: StartSessionRequest) {
      const workspace = request.remoteWorkspace;
      if (!workspace) return adapter.startSession(request);
      const observeWorkspace = async <T extends RemoteWorkspaceOperationResult>(kind: string, inputMatchedExpected: boolean, inputFacts: readonly string[], operation: () => Promise<T>): Promise<T> => {
        const response = await operation();
        observedOperations.push({
          kind,
          status: response.status,
          failure: response.failure === undefined ? 'none' : remoteFailureCodes.has(response.failure) ? response.failure : 'other',
          inputMatchedExpected,
          inputFacts,
          bindingMatched: bindingsMatch(response, workspace.binding),
          taskLeaseHeld: taskLeaseHeld(),
        });
        return response;
      };
      const observedWorkspace = {
        ...workspace,
        async read(path: string, operationId?: string) {
          return observeWorkspace('read', path === taskFixturePath, [`path:${relativePathShape(path)}`], () => workspace.read(path, operationId));
        },
        async search(query: string, path?: string, operationId?: string) {
          return observeWorkspace('search', false, [`path:${relativePathShape(path)}`, `query:${query.length > 0 ? 'nonempty' : 'empty'}`], () => workspace.search(query, path, operationId));
        },
        ...(workspace.edit ? { async edit(path: string, oldText: string, newText: string, operationId?: string) {
          const exactText = oldText === 'before' && newText === 'after';
          return observeWorkspace('edit', path === taskFixturePath && exactText, [`path:${relativePathShape(path)}`, `edit-text:${exactText ? 'expected' : 'different'}`], () => workspace.edit!(path, oldText, newText, operationId));
        } } : {}),
        ...(workspace.command ? { async command(executable: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs?: number }, operationId: string,
          onProgress?: (progress: import('../src/engine/port.ts').RemoteWorkspaceProgress) => void) {
          const exactArgs = args.length === taskCommandArgs.length && args.every((arg, index) => arg === taskCommandArgs[index]);
          const executableShape = executable === 'node' || executable === 'npm' ? executable : 'other';
          const commandFacts = [`executable:${executableShape}`, `args:${exactArgs ? 'expected' : 'different'}`, `cwd:${commandCwdShape(options.cwd)}`];
          return observeWorkspace('command', executable === 'node' && exactArgs, commandFacts, () => workspace.command!(executable, args, options, operationId, onProgress));
        } } : {}),
        ...(workspace.patch ? { async patch(path: string, hunks: readonly { readonly before: string; readonly after: string }[], operationId?: string) {
          const exactPatch = hunks.length === 1 && hunks[0]?.before === 'before' && hunks[0]?.after === 'after';
          return observeWorkspace('patch', path === taskFixturePath && exactPatch, [`path:${relativePathShape(path)}`, `patch:${exactPatch ? 'expected' : 'different'}`], () => workspace.patch!(path, hunks, operationId));
        } } : {}),
      };
      const mcp = request.remoteProjectMcp;
      const observedMcp: RemoteProjectMcpTools | undefined = mcp ? {
        ...mcp,
        async call(name, arguments_) {
          const response = await mcp.call(name, arguments_);
          observedOperations.push({
            kind: 'mcp',
            status: response.status,
            failure: response.reason === undefined ? 'none' : 'mcp-operation-failed',
            inputMatchedExpected: name === mcp.tools.find(tool => tool.name === name)?.name && arguments_.text === 'MCP_OK',
            inputFacts: [`tool:${mcp.tools.some(tool => tool.name === name) ? 'advertised' : 'unadvertised'}`, `text:${arguments_.text === 'MCP_OK' ? 'expected' : 'different'}`],
            bindingMatched: bindingsMatch(mcp.binding, workspace.binding),
            taskLeaseHeld: taskLeaseHeld(),
          });
          return response;
        },
      } : undefined;
      return adapter.startSession({
        ...request,
        remoteWorkspace: observedWorkspace,
        ...(observedMcp ? { remoteProjectMcp: observedMcp } : {}),
      }).then((session: EngineSession) => ({
        ...session,
        run(prompt: string) {
          runPromptNamesTarget = prompt.includes(taskFixturePath);
          runPromptContainsExactRead = prompt.includes(`"path":"${taskFixturePath}"`);
          return session.run(prompt);
        },
        interrupt: session.interrupt.bind(session),
        close: session.close.bind(session),
      }));
    },
  } as unknown as HostPiEngineAdapter;
}

try {
  const pi = createProductionHostPiAdapter({
    ...process.env,
    SPROUT_HOST_PI_PROVIDER: 'magpie',
    SPROUT_HOST_PI_MODEL: 'codex/gpt-6.1-sol',
  }, {
    providerRoot: resolve(process.cwd(), '..', 'pi-extensions', 'pi-magpie'),
    runnerRoot: join(root, 'engine-runner'),
  });
  if (!pi) {
    report({ outcome: 'blocked', stage, reason: 'host-pi-profile-unconfigured' });
    process.exitCode = 2;
  } else {
    const readiness = await pi.readiness(true);
    if (readiness.status !== 'ready') {
      report({ outcome: 'blocked', stage, reason: 'host-pi-readiness-unavailable',
        installation: readiness.installation, authentication: readiness.authentication,
        modelAvailability: readiness.modelAvailability, adapterControls: readiness.adapterControls });
      process.exitCode = 2;
    } else {
      const workerRoot = join(root, 'worker-workspaces');
      const projectRoot = join(root, 'host-project-files');
      await mkdir(projectRoot, { recursive: true });
      stage = 'runtime-create';
      const hostPi = observeTaskCapabilities(pi);
      runtime = await createRuntime({
        configuration: hostConfiguration({
          executionMode: 'host-run', environmentSource: 'enrollment', databasePath: ':memory:',
          runtimeConfiguration: {
            agents: [{
              id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model: pi.authorizedModel, effort: 'medium',
              workOptions: [{ id: 'host-pi-exact', engine: 'pi', workModel: pi.authorizedModel, effort: 'medium' }],
            }],
            project: { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] },
          },
        }),
        projectRoot,
        hostPi,
      });

      stage = 'worker-enrollment';
      const port = await availablePortInAssignedRange();
      const listening = await runtime.api.listen(port);
      runtimePorts.set(runtime, Promise.resolve(listening.port));
      const identityPath = join(root, 'worker-identity.pem');
      const identity = loadOrCreateWorkerIdentity(identityPath);
      const enrollment = await runtime.enrollments.requestEnrollment({
        environmentInstanceId: INSTANCE_ID,
        displayName: 'Authorized Task Environment',
        publicKey: workerPublicKey(identity.privateKey),
        platform: 'macos', protocolVersion: '3.0',
        capabilityRequests: ['agent-run', 'project-mcp', 'read-only-investigation'], engineFacts: [],
      });
      await runtime.enrollments.approve(enrollment.enrollment.id, {
        capabilityPermissions: { 'agent-run': true, 'project-mcp': true, 'read-only-investigation': true },
      });
      await connectRuntimeWorker(runtime, enrollment.enrollment.id, identityPath, undefined, workerRoot);

      stage = 'project-setup';
      await runtime.projectService.create({ id: 'host-task-proof-project', displayName: 'Host-run Task proof Project' });
      await runtime.projectService.addMembership('host-task-proof-project', { agentId: 'scout' });
      await runtime.projectService.updateContent('host-task-proof-project', {
        mcpConfiguration: { format: 'claude-code-mcp-json-v1' },
      });
      const workspacePath = join(workerRoot, 'repos', 'task-proof');
      await runtime.projectAccess.grant({
        projectId: 'host-task-proof-project', environmentInstanceId: INSTANCE_ID,
        selection: { kind: 'relative', path: 'repos/task-proof' },
      });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(join(workspacePath, taskFixturePath), 'before');
      const mcpServer = `import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
  if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', description: 'Echo the supplied text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] } });
  if (request.method === 'tools/call') send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: request.params.arguments.text }] } });
});`;
      await writeFile(join(workspacePath, '.mcp.json'), JSON.stringify({
        mcpServers: { fixture: { command: process.execPath, args: ['--input-type=module', '-e', mcpServer] } },
      }));

      stage = 'task-approval';
      const actor = await runtime.taskProposals.humanAuthority('host-task-proof-project');
      const proposal = await runtime.taskProposals.propose('host-task-proof-project', actor, {
        title: 'Bounded Host-run workspace Task',
        goal: 'Use the authorized Project workspace and Project MCP tools in one bounded activation.',
        constraints: [
          'Use only the provided tools and do not disclose file contents.',
          `The only file to read and edit is ${taskFixturePath} at the root of the authorized Project workspace. Its initial content is before; replace it with after using remote_edit.`,
          'Remote file paths are relative to the Project workspace root, not the Pi session or Task context directory. The remote command starts at the Project workspace root; omit cwd.',
        ],
        validationCriteria: ['Remote read, edit, command, and Project MCP calls succeed under the Task lease, then the Project file persists after safe Task end.'],
      });
      const begun = await runtime.taskAdmissions.beginForHuman(proposal.id, {
        expectedRevision: proposal.revision,
        environmentInstanceId: INSTANCE_ID,
        lead: actor,
        reason: 'Authorize one bounded Host-run Task probe.',
      });
      const taskId = begun.task.id;
      taskLeaseId = begun.task.environmentLeaseId;
      const initialTaskLeaseHeld = taskLeaseHeld();
      if (!taskLeaseId || !initialTaskLeaseHeld || begun.task.executionPlacement?.mode !== 'host-run') {
        report({ outcome: 'model-issued-task-incomplete', stage, reason: 'task-admission-invariant-failed', initialTaskLeaseHeld,
          placementRecorded: begun.task.executionPlacement?.mode === 'host-run' });
        process.exitCode = 1;
      } else {
        stage = 'model-issued-task-run';
        const advanced = await runtime.taskAdmissions.advanceForHuman(taskId, {
          targetAgentId: 'scout',
          reason: 'Run the bounded workspace and MCP check.',
          prompt: `Use only these four tools once each in this order: remote_read, remote_edit, remote_command, then the available Project MCP echo tool. The exact single file is ${taskFixturePath} at the root of the authorized Project workspace, not the Pi session or Task context directory. First call remote_read with exactly {"path":"${taskFixturePath}"}. Next call remote_edit on that same file with exactly {"path":"${taskFixturePath}","oldText":"before","newText":"after"}. Then call remote_command with executable "node" and args ${JSON.stringify(taskCommandArgs)}; omit cwd because it runs from the Project workspace root. Finally call the advertised echo Project MCP tool once with {"text":"MCP_OK"}. Do not call remote_search or any other tool, repeat calls, or include tool arguments, file contents, or command output in your final response. Report the check result in one short sentence.`,
        });
        const settledRun = await runtime.orchestrator.waitFor(advanced.runId);
        const afterRunTask = await runtime.tasks.get(taskId);
        const nestedRunUsedTaskLease = settledRun.leaseId === taskLeaseId;
        const activeAfterRun = taskLeaseHeld();
        const requiredOperationsComplete = ['mcp', 'read', 'edit', 'command'].every(kind =>
          observedOperations.filter(operation => operation.kind === kind && operation.status === 'completed' &&
            operation.inputMatchedExpected && operation.bindingMatched && operation.taskLeaseHeld).length === 1);
        const operationsWithinBound = observedOperations.length <= 10;
        const operationsComplete = requiredOperationsComplete && operationsWithinBound &&
          observedOperations.every(operation => operation.bindingMatched && operation.taskLeaseHeld);
        const remoteFileEdited = await readFile(join(workspacePath, taskFixturePath), 'utf8') === 'after';
        const remoteCommandPassed = observedOperations.some(operation => operation.kind === 'command' && operation.status === 'completed');
        const runSettledSafely = settledRun.status === 'completed' && nestedRunUsedTaskLease && activeAfterRun &&
          afterRunTask?.environmentLifecycleState === 'idle';
        let taskEndedSafely = false;
        let workspacePersistsAfterTaskEnd = false;
        if (runSettledSafely && operationsComplete && remoteFileEdited && remoteCommandPassed) {
          stage = 'task-end';
          const claim = await runtime.taskControls.submitCompletionClaimForHuman(taskId, {
            outcomeSummary: 'The bounded remote workspace and Project MCP check completed.',
            validationEvidence: ['The remote command passed and the Project file was persisted.'],
            durableChanges: ['The Project workspace contains the checked file.'],
            limitations: [],
            recommendedDisposition: 'complete',
          });
          const claimId = claim.completionClaims?.at(-1)?.id;
          if (claimId) {
            const ended = await runtime.taskControls.validateForHuman(taskId, {
              claimId, decision: 'accept', reason: 'The bounded Project checks passed.',
            });
            taskEndedSafely = ended.status === 'done' && toTaskContextState(ended) === 'recycled' &&
              runtime.pool.getLease(taskLeaseId)?.state === 'released';
            workspacePersistsAfterTaskEnd = await readFile(join(workspacePath, taskFixturePath), 'utf8') === 'after';
          }
        }
        const accepted = runSettledSafely && operationsComplete && remoteFileEdited && remoteCommandPassed &&
          taskEndedSafely && workspacePersistsAfterTaskEnd;
        report({
          outcome: accepted ? 'model-issued-host-run-task-passed' : 'model-issued-host-run-task-incomplete',
          runStatus: settledRun.status,
          operationKinds: observedOperations.map(operation => operation.kind),
          operationStatuses: observedOperations.map(operation => operation.status),
          operationFailures: observedOperations.map(operation => operation.failure),
          operationInputsMatched: observedOperations.map(operation => operation.inputMatchedExpected),
          operationInputFacts: observedOperations.map(operation => operation.inputFacts),
          operationLeaseStates: observedOperations.map(operation => operation.taskLeaseHeld),
          operationBindingsMatched: observedOperations.every(operation => operation.bindingMatched),
          taskLeaseHeldForEveryOperation: observedOperations.length > 0 && observedOperations.every(operation => operation.taskLeaseHeld),
          operationsWithinBound,
          runPromptNamesTarget,
          runPromptContainsExactRead,
          nestedRunUsedTaskLease,
          taskLeaseActiveAfterRun: activeAfterRun,
          taskIdleAfterRun: afterRunTask?.environmentLifecycleState === 'idle',
          remoteFileEdited,
          remoteCommandPassed,
          taskEndedSafely,
          workspacePersistsAfterTaskEnd,
          finalLeaseState: runtime.pool.getLease(taskLeaseId)?.state ?? 'missing',
        });
        if (!accepted) process.exitCode = 1;
      }
    }
  }
} catch (error) {
  report({ outcome: 'blocked', reason: 'bounded-probe-failed', stage, ...sanitizedProbeErrorFields(error) });
  process.exitCode = 2;
} finally {
  if (runtime) await runtime.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
