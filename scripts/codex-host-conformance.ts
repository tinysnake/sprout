import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostCodexEngineAdapter } from '../src/engine/codex-host.ts';
import { redactSensitiveText } from '../src/environment/privacy.ts';
import {
  connectRuntimeWorker,
  createRuntime,
  hostConfiguration,
  inMemoryStores,
  project,
} from '../src/runtime-test-harness.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from '../src/worker/enrollment-connector.ts';

const expectedModel = 'gpt-6.1-sol';
const model = process.env['SPROUT_HOST_CODEX_MODEL'];
if (model !== expectedModel) throw new Error('SPROUT_HOST_CODEX_MODEL does not match the Human-authorized model');

const controls = ['shell_tool', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use', 'code_mode', 'code_mode_host'];
const directory = mkdtempSync(join(tmpdir(), 'sprout-host-codex-conformance-'));
const projectId = 'codex-conformance-project';
const agentId = 'codex-conformance-agent';
const workerId = 'codex-conformance-worker';
const workspaceRelativePath = 'src/target.txt';
const mcpReceipt = join(directory, 'remote-worker', 'repos', 'conformance', 'mcp-receipt.txt');
const remoteTarget = join(directory, 'remote-worker', 'repos', 'conformance', workspaceRelativePath);
const sentinelPaths = [
  join(directory, 'host-sentinel-a', workspaceRelativePath),
  join(directory, 'host-sentinel-b', workspaceRelativePath),
];
const sentinelContents = ['HOST_SENTINEL_ALPHA', 'HOST_SENTINEL_BETA'];
const projectMcpToolName = `sprout_project_mcp_${createHash('sha256').update('record_result').digest('hex').slice(0, 16)}`;
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let providerTurnId: string | undefined;
let observedWorkspaceOperations: { readonly operation: string; readonly target: string; readonly status: string; readonly sentinelContentReturned: boolean }[] = [];
let observedProjectMcpStatuses: string[] = [];

function safeFailure(error: unknown): string {
  const source = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSensitiveText(source)
    .replace(/(?:localhost|127(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]):\d{1,5}/gi, '<redacted-endpoint>')
    .replace(/\b(?:\w[\w.-]*):\d{2,5}\b/g, '<redacted-endpoint>')
    .slice(0, 700);
}

try {
  const cliVersion = execFileSync(process.env['SPROUT_HOST_CODEX_BIN'] ?? 'codex', ['--version'], { encoding: 'utf8' }).trim();
  const runnerRoot = join(directory, 'codex-runner');
  const codexOptions = {
    binaryPath: process.env['SPROUT_HOST_CODEX_BIN'] ?? 'codex',
    model,
    runnerRoot,
    ...(process.env['CODEX_HOME'] !== undefined ? { codexHome: process.env['CODEX_HOME'] } : {}),
    onTurnStarted: (turnId: string) => { providerTurnId = turnId; },
  };
  const hostCodex = new HostCodexEngineAdapter(codexOptions);
  let remoteToolCatalog = { workspaceOperations: [] as readonly string[], projectMcpToolCount: 0 };
  const startHostCodexSession = hostCodex.startSession.bind(hostCodex);
  hostCodex.startSession = async request => {
    const sourceWorkspace = request.remoteWorkspace;
    const sourceProjectMcp = request.remoteProjectMcp;
    remoteToolCatalog = {
      workspaceOperations: [...(sourceWorkspace?.operations ?? [])],
      projectMcpToolCount: sourceProjectMcp?.tools.length ?? 0,
    };
    const workspace = sourceWorkspace === undefined ? undefined : {
      ...sourceWorkspace,
      read: async (path: string, operationId?: string) => {
        const result = await sourceWorkspace.read(path, operationId);
        const target = path === 'src/target.txt' ? 'selected-target'
          : path === '../../../host-sentinel-a/src/target.txt' ? 'host-sentinel-a'
            : path === '../../../host-sentinel-b/src/target.txt' ? 'host-sentinel-b' : 'other';
        observedWorkspaceOperations.push({ operation: 'read', target, status: result.status,
          sentinelContentReturned: sentinelContents.some(value => result.content?.includes(value)) });
        return result;
      },
      ...(sourceWorkspace.patch !== undefined ? { patch: async (path: string, hunks: readonly { readonly before: string; readonly after: string }[], operationId?: string) => {
        const result = await sourceWorkspace.patch!(path, hunks, operationId);
        observedWorkspaceOperations.push({ operation: 'patch', target: path === 'src/target.txt' ? 'selected-target' : 'other',
          status: result.status, sentinelContentReturned: sentinelContents.some(value => result.content?.includes(value)) });
        return result;
      } } : {}),
    };
    const projectMcp = sourceProjectMcp === undefined ? undefined : {
      ...sourceProjectMcp,
      call: async (name: string, arguments_: Readonly<Record<string, unknown>>) => {
        const result = await sourceProjectMcp.call(name, arguments_);
        observedProjectMcpStatuses.push(result.status);
        return result;
      },
    };
    return await startHostCodexSession({
      ...request,
      ...(workspace !== undefined ? { remoteWorkspace: workspace } : {}),
      ...(projectMcp !== undefined ? { remoteProjectMcp: projectMcp } : {}),
    });
  };
  const readiness = await hostCodex.readiness(true);
  if (readiness.status !== 'ready' || readiness.adapterControls !== 'ready') {
    const diagnostic = readiness.probeFailure === undefined
      ? ''
      : `; probe failed at ${readiness.probeFailure.step}: ${readiness.probeFailure.reason}`;
    throw new Error(`Host Codex readiness failed: installation=${readiness.installation}, authentication=${readiness.authentication}, model=${readiness.modelAvailability}, controls=${readiness.adapterControls}${diagnostic}`);
  }

  const workerRoot = join(directory, 'remote-worker');
  mkdirSync(join(workerRoot, 'repos', 'conformance', 'src'), { recursive: true });
  writeFileSync(remoteTarget, 'REMOTE_BEFORE');
  for (let index = 0; index < sentinelPaths.length; index += 1) {
    mkdirSync(join(directory, `host-sentinel-${index === 0 ? 'a' : 'b'}`, 'src'), { recursive: true });
    writeFileSync(sentinelPaths[index]!, sentinelContents[index]!);
  }

  const mcpServer = `
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    const receipt = process.argv[1];
    const tools = [{ name: 'record_result', description: 'Write the conformance marker after the remote workspace patch is verified.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }];
    const input = createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    input.on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'conformance-fixture', version: '1' } } });
      else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools } });
      else if (request.method === 'tools/call' && request.params?.name === 'record_result') {
        writeFileSync(receipt, request.params.arguments.text, 'utf8');
        send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'recorded' }] } });
      }
    });
  `;
  writeFileSync(join(workerRoot, 'repos', 'conformance', '.mcp.json'), JSON.stringify({
    mcpServers: {
      conformance: { command: process.execPath, args: ['--input-type=module', '-e', mcpServer, mcpReceipt] },
    },
  }));

  const keyPath = join(directory, 'worker-identity.pem');
  const identity = loadOrCreateWorkerIdentity(keyPath);
  runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run', environmentSource: 'enrollment', databasePath: join(directory, 'runtime.db'),
      runtimeConfiguration: {
        agents: [{
          id: agentId, name: 'Codex conformance agent', engine: 'codex', capability: 'agent-run',
          model, effort: 'low',
          workOptions: [{ id: 'authorized-host-codex', engine: 'codex', workModel: model, effort: 'low' }],
        }],
        project: {
          ...project(), memberships: [{ agentId, responsibilities: [], collaborationInstructions: '' }],
        },
      },
    }),
    projectRoot: directory,
    stores: inMemoryStores(),
    hostCodex,
  });
  const enrollment = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: workerId, displayName: 'Disposable Codex conformance Worker',
    publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
    capabilityRequests: ['agent-run', 'project-mcp', 'read-only-investigation'], engineFacts: [],
  });
  await runtime.enrollments.approve(enrollment.enrollment.id, {
    capabilityPermissions: { 'agent-run': true, 'project-mcp': true, 'read-only-investigation': true },
  });
  await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
  await runtime.projectService.create({ id: projectId, displayName: 'Disposable Codex conformance Project' });
  await runtime.projectService.addMembership(projectId, { agentId });
  await runtime.projectService.updateContent(projectId, { mcpConfiguration: { format: 'claude-code-mcp-json-v1' } });
  await runtime.projectAccess.grant({
    projectId, environmentInstanceId: workerId, selection: { kind: 'relative', path: 'repos/conformance' },
  });

  const sentinelsBefore = sentinelPaths.map(path => readFileSync(path, 'utf8'));
  const submitted = await runtime.orchestrator.submit({
    agentId, projectId, workEnvironmentInstanceId: workerId,
    prompt: [
      'Complete every operation below by calling the named Sprout tools. Do not answer from your own knowledge and do not write a final reply until all available remote operations have been called.',
      'First call sprout_workspace_read with exactly {"path":"src/target.txt"}.',
      'Then call sprout_workspace_patch with exactly {"path":"src/target.txt","hunks":[{"before":"REMOTE_BEFORE","after":"REMOTE_AFTER"}]}.',
      'Call sprout_workspace_read again with exactly {"path":"src/target.txt"} and verify the returned content is REMOTE_AFTER.',
      `Then call the approved Project MCP tool ${projectMcpToolName} exactly once with {"text":"MCP_PATH_OK"}.`,
      `Finally call sprout_workspace_read with each path ../../../host-sentinel-a/src/target.txt and ../../../host-sentinel-b/src/target.txt. Those names match the host sentinels outside the selected workspace; the selected remote tool must refuse traversal without exposing their contents.`,
      'In your final reply, report whether both sentinel reads were refused and whether the remote patch and Project MCP call succeeded. Do not quote any host path or sentinel content.',
    ].join('\n'),
  });
  const run = await runtime.orchestrator.waitFor(submitted.id);
  if (run.status !== 'completed') throw new Error(`Host Codex run did not complete: status=${run.status}`);

  const remoteAfter = readFileSync(remoteTarget, 'utf8');
  const sentinelsAfter = sentinelPaths.map(path => readFileSync(path, 'utf8'));
  const sentinelReadResults = observedWorkspaceOperations.filter(operation => operation.operation === 'read' && operation.target.startsWith('host-sentinel-'));
  const sentinelReadsRefused = sentinelReadResults.filter(operation => operation.status === 'failed' && !operation.sentinelContentReturned).length;
  const successfulRemoteReads = observedWorkspaceOperations.filter(operation =>
    operation.operation === 'read' && operation.target === 'selected-target' && operation.status === 'completed').length;
  const completedRemotePatches = observedWorkspaceOperations.filter(operation =>
    operation.operation === 'patch' && operation.target === 'selected-target' && operation.status === 'completed').length;
  const projectMcpCompleted = observedProjectMcpStatuses.filter(status => status === 'completed').length;
  const finalText = run.result?.status === 'completed' ? run.result.text : '';
  const usage = run.result?.status === 'completed' ? run.result.tokenUsage : undefined;
  const usageBasis = run.result?.status === 'completed' ? run.result.billingBasis : undefined;
  const providerCostEstimate = run.result?.status === 'completed' ? run.result.costEstimate : undefined;
  const mcpReceiptWritten = existsSync(mcpReceipt) && readFileSync(mcpReceipt, 'utf8') === 'MCP_PATH_OK';
  const sentinelValues = sentinelsBefore.map((before, index) => ({ before, after: sentinelsAfter[index] ?? '', unchanged: before === sentinelsAfter[index] }));
  const remotePatchVerified = remoteAfter === 'REMOTE_AFTER' && completedRemotePatches >= 1;
  const sentinelReadsBlocked = sentinelReadResults.length === sentinelPaths.length &&
    sentinelReadsRefused === sentinelPaths.length && !sentinelReadResults.some(operation => operation.sentinelContentReturned) &&
    !sentinelContents.some(value => finalText.includes(value));
  const allEvidencePresent = remotePatchVerified && sentinelsBefore.every((value, index) => value === sentinelsAfter[index]) &&
    sentinelReadsBlocked && successfulRemoteReads >= 2 && completedRemotePatches >= 1 && mcpReceiptWritten && projectMcpCompleted >= 1;
  const runEventCounts = run.events.reduce<Record<string, number>>((counts, event) => {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  }, {});
  const finalReplySignals = {
    mentionsWorkspace: /workspace|file|patch/i.test(finalText),
    mentionsProjectMcp: /mcp|record_result/i.test(finalText),
    mentionsTools: /tool/i.test(finalText),
    mentionsFailure: /could not|couldn't|cannot|can't|unable|error|failed|refused/i.test(finalText),
    saysNoToolsAvailable: /no (?:available )?tools|tools? (?:are )?not available|without tools/i.test(finalText),
    includesSentinelContent: sentinelContents.some(value => finalText.includes(value)),
  };

  process.stdout.write(JSON.stringify({
    status: allEvidencePresent ? 'verified' : 'evidence-incomplete', modelId: model, cliVersion,
    readiness: {
      status: readiness.status,
      installation: readiness.installation,
      authentication: readiness.authentication,
      modelAvailability: readiness.modelAvailability,
      controlsFoundDisabled: controls,
      dynamicToolSupportAccepted: readiness.adapterControls === 'ready',
    },
    pinnedPair: 'Codex CLI 0.159.3 / app-server JSON-RPC under macOS sandbox-exec',
    runId: run.id,
    turnId: providerTurnId ?? null,
    executionMode: run.executionMode,
    workspaceBindingStatus: run.workspaceBindingStatus ?? null,
    remoteToolCatalog,
    runEventCounts,
    finalReplySignals,
    remoteFile: { before: 'REMOTE_BEFORE', after: remoteAfter, patchVerified: remotePatchVerified },
    remoteWorkspace: { successfulReads: successfulRemoteReads, completedPatches: completedRemotePatches,
      refusedHostSentinelReads: sentinelReadsRefused, sentinelReadAttempts: sentinelReadResults.length, operations: observedWorkspaceOperations, sentinelReadsBlocked },
    projectMcp: { completedToolEvents: projectMcpCompleted, callStatuses: observedProjectMcpStatuses, receiptWritten: mcpReceiptWritten },
    sentinels: { values: sentinelValues, unreadByTurn: sentinelReadsBlocked },
    usage: usage === undefined ? 'unavailable' : usage,
    billingBasis: usageBasis ?? 'unknown',
    providerCostEstimate: providerCostEstimate ?? 'unavailable',
  }) + '\n');
  if (!allEvidencePresent) process.exitCode = 1;

} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'failed', failure: safeFailure(error) }) + '\n');
  process.exitCode = 1;
} finally {
  await runtime?.close().catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
}
