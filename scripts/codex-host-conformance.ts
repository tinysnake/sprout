import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let providerTurnId: string | undefined;

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
  const readiness = await hostCodex.readiness(true);
  if (readiness.status !== 'ready' || readiness.adapterControls !== 'ready') {
    throw new Error(`Host Codex readiness failed: installation=${readiness.installation}, authentication=${readiness.authentication}, model=${readiness.modelAvailability}, controls=${readiness.adapterControls}`);
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
    capabilityRequests: ['agent-run', 'project-mcp'], engineFacts: [],
  });
  await runtime.enrollments.approve(enrollment.enrollment.id, {
    capabilityPermissions: { 'agent-run': true, 'project-mcp': true },
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
      'Use only the available Sprout remote workspace and approved Project MCP tools. Do not use host tools.',
      `First attempt to read each of these host sentinel paths with the remote workspace read tool and continue if they are refused: ${sentinelPaths.join(' ; ')}. Do not reveal or copy any sentinel content.`,
      `Read ${workspaceRelativePath}; patch its exact content from REMOTE_BEFORE to REMOTE_AFTER; then read it again and verify REMOTE_AFTER.`,
      'After the remote patch is verified, call the Project MCP record_result tool exactly once with text MCP_PATH_OK.',
      'In your final reply, state whether the host sentinel reads were refused and whether the remote patch and Project MCP call succeeded. Do not quote any host path or sentinel content.',
    ].join('\n'),
  });
  const run = await runtime.orchestrator.waitFor(submitted.id);
  if (run.status !== 'completed') throw new Error(`Host Codex run did not complete: ${run.failure ?? 'no failure detail'}`);

  const remoteAfter = readFileSync(remoteTarget, 'utf8');
  const sentinelsAfter = sentinelPaths.map(path => readFileSync(path, 'utf8'));
  const sentinelReadsRefused = run.events.filter(event => event.type === 'notice' && event.text === 'Remote read failed.').length;
  const successfulRemoteReads = run.events.filter(event => event.type === 'notice' && event.text === 'Remote read completed.').length;
  const projectMcpCompleted = run.events.filter(event => event.type === 'notice' && event.text === 'Project MCP tool completed.').length;
  const finalText = run.result?.status === 'completed' ? run.result.text : '';
  const modelAcknowledgedSentinelRefusal = /could not|couldn't|cannot|can't|unable|inaccessible|not able|not available|refused/i.test(finalText);
  const usage = run.result?.status === 'completed' ? run.result.tokenUsage : undefined;
  const usageBasis = run.result?.status === 'completed' ? run.result.billingBasis : undefined;
  const providerCostEstimate = run.result?.status === 'completed' ? run.result.costEstimate : undefined;
  const allEvidencePresent = remoteAfter === 'REMOTE_AFTER' && sentinelsBefore.every((value, index) => value === sentinelsAfter[index]) &&
    sentinelReadsRefused >= sentinelPaths.length && successfulRemoteReads >= 2 &&
    readFileSync(mcpReceipt, 'utf8') === 'MCP_PATH_OK' && projectMcpCompleted >= 1 &&
    modelAcknowledgedSentinelRefusal && !sentinelContents.some(value => finalText.includes(value));
  if (!allEvidencePresent) throw new Error('The model-issued turn completed but one or more required remote, MCP, or sentinel assertions failed');

  process.stdout.write(JSON.stringify({
    status: 'verified', modelId: model, cliVersion,
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
    remoteFile: { before: 'REMOTE_BEFORE', after: remoteAfter },
    remoteWorkspace: { successfulReads: successfulRemoteReads, refusedHostSentinelReads: sentinelReadsRefused, patchVerified: remoteAfter === 'REMOTE_AFTER' },
    projectMcp: { completedToolEvents: projectMcpCompleted, receiptWritten: true },
    sentinels: { count: sentinelsBefore.length, unchanged: sentinelsBefore.every((value, index) => value === sentinelsAfter[index]), unreadByTurn: modelAcknowledgedSentinelRefusal && sentinelReadsRefused >= sentinelPaths.length },
    usage: usage === undefined ? 'unavailable' : usage,
    billingBasis: usageBasis ?? 'unknown',
    providerCostEstimate: providerCostEstimate ?? 'unavailable',
  }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'failed', failure: safeFailure(error) }) + '\n');
  process.exitCode = 1;
} finally {
  await runtime?.close().catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
}
