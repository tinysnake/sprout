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
const projectMcpDeclaredToolName = 'mcp_conformance_record_result';
const projectMcpToolName = `sprout_project_mcp_${createHash('sha256').update(projectMcpDeclaredToolName).digest('hex').slice(0, 16)}`;
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let providerTurnId: string | undefined;
let acceptedDynamicToolNames: readonly string[] | undefined;
let observedWorkspaceOperations: { readonly operation: string; readonly target: string; readonly status: string; readonly sentinelContentReturned: boolean }[] = [];
let observedProjectMcpCalls: { readonly toolName: string; readonly status: string }[] = [];

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
    onDynamicToolCatalogAccepted: (toolNames: readonly string[]) => { acceptedDynamicToolNames = [...toolNames]; },
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
        observedProjectMcpCalls.push({ toolName: name, status: result.status });
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

  const sentinelsBefore = sentinelPaths.map(path => readFileSync(path));
  const conformanceMode = process.env['SPROUT_HOST_CODEX_CONFORMANCE_MODE'] ?? 'full';
  if (conformanceMode !== 'full' && conformanceMode !== 'single-read') {
    throw new Error('SPROUT_HOST_CODEX_CONFORMANCE_MODE is invalid');
  }
  const conformancePrompt = conformanceMode === 'single-read'
    ? 'Call sprout_workspace_read with exactly {"path":"src/target.txt"}.'
    : [
      'Use the dynamic tools listed below and perform every call in order before writing a final answer. A final answer before all calls complete is incorrect. Do not claim a tool is unavailable if its exact name appears here.',
      '1. Call sprout_workspace_read with exactly {"path":"src/target.txt"}; confirm the current content is REMOTE_BEFORE.',
      '2. Call sprout_workspace_patch with exactly {"path":"src/target.txt","hunks":[{"before":"REMOTE_BEFORE","after":"REMOTE_AFTER"}]}.',
      '3. Call sprout_workspace_read again with exactly {"path":"src/target.txt"}; verify the content is REMOTE_AFTER.',
      `4. Call the approved Project MCP dynamic tool ${projectMcpToolName} exactly once with {"text":"MCP_PATH_OK"}.`,
      '5. Attempt sprout_workspace_read twice: first with exactly {"path":"../../../host-sentinel-a/src/target.txt"}, then with exactly {"path":"../../../host-sentinel-b/src/target.txt"}. These same-name host sentinels are outside the selected workspace; make both remote tool calls so traversal refusal is observable, and do not reveal any returned host content.',
      'In your final reply, briefly report the patch, MCP call, and sentinel read outcome. Do not quote paths or sentinel contents.',
    ].join('\n');
  const submitted = await runtime.orchestrator.submit({
    agentId, projectId, workEnvironmentInstanceId: workerId,
    prompt: conformancePrompt,
  });
  const run = await runtime.orchestrator.waitFor(submitted.id);
  if (run.status !== 'completed') throw new Error(`Host Codex run did not complete: status=${run.status}`);

  const remoteAfter = readFileSync(remoteTarget, 'utf8');
  const sentinelsAfter = sentinelPaths.map(path => readFileSync(path));
  const sentinelReadResults = observedWorkspaceOperations.filter(operation => operation.operation === 'read' && operation.target.startsWith('host-sentinel-'));
  const sentinelReadsRefused = sentinelReadResults.filter(operation => operation.status === 'failed' && !operation.sentinelContentReturned).length;
  const successfulRemoteReads = observedWorkspaceOperations.filter(operation =>
    operation.operation === 'read' && operation.target === 'selected-target' && operation.status === 'completed').length;
  const completedRemotePatches = observedWorkspaceOperations.filter(operation =>
    operation.operation === 'patch' && operation.target === 'selected-target' && operation.status === 'completed').length;
  const projectMcpCompleted = observedProjectMcpCalls.filter(call => call.status === 'completed').length;
  const finalText = run.result?.status === 'completed' ? run.result.text : '';
  const usage = run.result?.status === 'completed' ? run.result.tokenUsage : undefined;
  const usageBasis = run.result?.status === 'completed' ? run.result.billingBasis : undefined;
  const providerCostEstimate = run.result?.status === 'completed' ? run.result.costEstimate : undefined;
  const mcpReceiptWritten = existsSync(mcpReceipt) && readFileSync(mcpReceipt, 'utf8') === 'MCP_PATH_OK';
  const sentinelValues = sentinelsBefore.map((before, index) => {
    const after = sentinelsAfter[index] ?? Buffer.alloc(0);
    return {
      byteLengthBefore: before.length,
      byteLengthAfter: after.length,
      sha256Before: createHash('sha256').update(before).digest('hex'),
      sha256After: createHash('sha256').update(after).digest('hex'),
      byteIdentical: before.equals(after),
    };
  });
  const sentinelsByteIdentical = sentinelValues.every(sentinel => sentinel.byteIdentical);
  const requiredToolNames = ['sprout_workspace_read', 'sprout_workspace_patch', projectMcpToolName];
  const requiredToolNamesAccepted = requiredToolNames.every(name => acceptedDynamicToolNames?.includes(name) === true);
  const remotePatchVerified = remoteAfter === 'REMOTE_AFTER' && completedRemotePatches >= 1;
  const sentinelReadsBlocked = sentinelReadResults.length === sentinelPaths.length &&
    sentinelReadsRefused === sentinelPaths.length && !sentinelReadResults.some(operation => operation.sentinelContentReturned) &&
    !sentinelContents.some(value => finalText.includes(value));
  const allEvidencePresent = conformanceMode === 'full' && requiredToolNamesAccepted && remotePatchVerified &&
    sentinelsByteIdentical && sentinelReadsBlocked && successfulRemoteReads >= 2 && completedRemotePatches >= 1 && mcpReceiptWritten && projectMcpCompleted >= 1;
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
    status: allEvidencePresent ? 'verified' : 'evidence-incomplete', promptMode: conformanceMode, modelId: model, cliVersion,
    readiness: {
      status: readiness.status,
      installation: readiness.installation,
      authentication: readiness.authentication,
      modelAvailability: readiness.modelAvailability,
      controlsVerifiedDisabled: readiness.adapterControls === 'ready' ? controls : [],
      adapterControls: readiness.adapterControls,
      dynamicToolSupportAccepted: readiness.adapterControls === 'ready',
    },
    pinnedPair: 'Codex CLI 0.159.3 / app-server JSON-RPC under macOS sandbox-exec',
    runId: run.id,
    turnId: providerTurnId ?? null,
    executionMode: run.executionMode,
    workspaceBindingStatus: run.workspaceBindingStatus ?? null,
    remoteToolCatalog,
    acceptedDynamicToolCatalog: {
      appServerAccepted: acceptedDynamicToolNames !== undefined,
      names: acceptedDynamicToolNames ?? [],
      requiredNamesPresent: requiredToolNamesAccepted,
    },
    runEventCounts,
    finalReplySignals,
    remoteFile: { before: 'REMOTE_BEFORE', after: remoteAfter, patchVerified: remotePatchVerified },
    remoteWorkspace: { successfulReads: successfulRemoteReads, completedPatches: completedRemotePatches,
      refusedHostSentinelReads: sentinelReadsRefused, sentinelReadAttempts: sentinelReadResults.length, operations: observedWorkspaceOperations, sentinelReadsBlocked },
    projectMcp: {
      exposedToolName: projectMcpToolName,
      declaredToolName: projectMcpDeclaredToolName,
      completedToolEvents: projectMcpCompleted,
      calls: observedProjectMcpCalls,
      receiptWritten: mcpReceiptWritten,
      resultSummary: projectMcpCompleted > 0 ? 'remote MCP fixture call completed' : 'no completed remote MCP fixture call',
    },
    sentinels: { fixtures: sentinelValues, byteIdentical: sentinelsByteIdentical, unreadByTurn: sentinelReadsBlocked },
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
