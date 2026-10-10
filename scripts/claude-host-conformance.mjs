/** One bounded model-issued run against a disposable enrolled Worker and Project fixture. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostClaudeEngineAdapter, CLAUDE_CODE_AUTHORIZED_MODEL } from '../src/engine/claude-host.ts';
import {
  createRuntime,
  connectRuntimeWorker,
  hostConfiguration,
  inMemoryStores,
  project,
  INSTANCE_ID,
} from '../src/runtime-test-harness.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from '../src/worker/enrollment-connector.ts';

const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-host-conformance-'));
const projectId = 'claude-live-conformance-project';
const agentId = 'claude-live-conformance-agent';
const marker = 'REMOTE_ORIGIN_CLAUDE_HOST_PROBE';
const observations = { workspace: [], projectMcp: [] };
let runtime;
let evidenceReported = false;

try {
  const workerRoot = join(directory, 'worker');
  const workspace = join(workerRoot, 'repos', 'claude-live');
  const repoRoot = join(workerRoot, 'repos');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'origin.txt'), marker);
  writeFileSync(join(workspace, 'proof.txt'), 'READY');
  writeFileSync(join(repoRoot, 'host-sentinel.txt'), 'WORKER_SENTINEL_UNCHANGED');

  const mcpServer = `import { createInterface } from 'node:readline'; import { writeFileSync } from 'node:fs'; const send=value=>process.stdout.write(JSON.stringify(value)+'\\n'); createInterface({input:process.stdin}).on('line',line=>{ const r=JSON.parse(line); if(r.method==='initialize') send({jsonrpc:'2.0',id:r.id,result:{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}}); else if(r.method==='tools/list') send({jsonrpc:'2.0',id:r.id,result:{tools:[{name:'record_marker',description:'Record the marker read from the authorized remote workspace.',inputSchema:{type:'object',properties:{marker:{type:'string'}},required:['marker'],additionalProperties:false}}]}}); else if(r.method==='tools/call'){ const a=r.params.arguments; if(r.params.name==='record_marker'&&a.marker===${JSON.stringify(marker)}) { writeFileSync('mcp-proof.txt',a.marker); send({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:'marker recorded'}]}}); } else send({jsonrpc:'2.0',id:r.id,result:{isError:true,content:[{type:'text',text:'marker refused'}]}}); } });`;
  writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: ['--input-type=module', '-e', mcpServer] } },
  }));

  runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run',
      environmentSource: 'enrollment',
      databasePath: join(directory, 'state.db'),
      runtimeConfiguration: {
        agents: [{
          id: agentId,
          name: 'Claude Conformance Agent',
          engine: 'claude',
          capability: 'agent-run',
          model: CLAUDE_CODE_AUTHORIZED_MODEL,
          effort: 'high',
          workOptions: [{
            id: 'authorized-claude',
            engine: 'claude',
            workModel: CLAUDE_CODE_AUTHORIZED_MODEL,
            effort: 'high',
          }],
        }],
        project: { ...project(), memberships: [{ agentId, responsibilities: [], collaborationInstructions: '' }] },
      },
    }),
    projectRoot: directory,
    stores: inMemoryStores(),
    hostClaude: new HostClaudeEngineAdapter({ runnerRoot: join(directory, 'host-runner') }),
  });

  const operations = runtime.environmentOperations;
  const originalAttach = operations.attach.bind(operations);
  operations.attach = async (...args) => {
    const tools = await originalAttach(...args);
    const classify = path => path === 'origin.txt' ? 'origin'
      : path === 'proof.txt' ? 'proof'
        : path === '../host-sentinel.txt' ? 'outside-workspace' : 'other';
    return {
      ...tools,
      read: async (path, operationId) => {
        const result = await tools.read(path, operationId);
        observations.workspace.push({
          operation: 'read', pathClass: classify(path), status: result.status,
          ...(result.failure === 'invalid-path' ? { failure: 'invalid-path' } : {}),
        });
        return result;
      },
      edit: async (path, oldText, newText, operationId) => {
        const result = await tools.edit(path, oldText, newText, operationId);
        observations.workspace.push({ operation: 'edit', pathClass: classify(path), status: result.status });
        return result;
      },
    };
  };
  const originalAttachMcp = operations.attachProjectMcpTools.bind(operations);
  operations.attachProjectMcpTools = async (...args) => {
    const tools = await originalAttachMcp(...args);
    return {
      ...tools,
      call: async (name, arguments_) => {
        const result = await tools.call(name, arguments_);
        observations.projectMcp.push({
          tool: tools.tools.some(row => row.name === name) ? 'project-mcp' : 'other',
          status: result.status,
          markerAccepted: result.status === 'completed' && result.text === 'marker recorded',
        });
        return result;
      },
    };
  };

  const identityPath = join(directory, 'worker-key.pem');
  const identity = loadOrCreateWorkerIdentity(identityPath);
  const requested = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: INSTANCE_ID,
    displayName: 'Disposable Claude Conformance Worker',
    publicKey: workerPublicKey(identity.privateKey),
    platform: 'macos',
    protocolVersion: '3.0',
    capabilityRequests: ['agent-run', 'project-mcp', 'read-only-investigation'],
    engineFacts: [],
  });
  await runtime.enrollments.approve(requested.enrollment.id, {
    capabilityPermissions: { 'agent-run': true, 'project-mcp': true, 'read-only-investigation': true },
  });
  await connectRuntimeWorker(runtime, requested.enrollment.id, identityPath, undefined, workerRoot);
  await runtime.projectService.create({ id: projectId, displayName: 'Claude live conformance fixture' });
  await runtime.projectService.addMembership(projectId, { agentId, responsibilities: [], collaborationInstructions: '' });
  await runtime.projectService.updateContent(projectId, { mcpConfiguration: { format: 'claude-code-mcp-json-v1' } });
  await runtime.projectAccess.grant({
    projectId,
    environmentInstanceId: INSTANCE_ID,
    selection: { kind: 'relative', path: 'repos/claude-live' },
  });

  const startedAt = Date.now();
  const submitted = await runtime.orchestrator.submit({
    agentId,
    projectId,
    workEnvironmentInstanceId: INSTANCE_ID,
    prompt: 'This is a bounded conformance task. Use only the listed remote workspace and Project MCP tools. Read origin.txt and copy its exact marker. Call the Project MCP tool record_marker with that marker. Edit proof.txt by replacing READY with that exact marker. Then try one read of ../host-sentinel.txt; the selected workspace boundary must refuse it. Do not try another path and do not use any local or built-in work tool. Reply with a short outcome.',
  });
  let timeoutHandle;
  const settled = await Promise.race([
    runtime.orchestrator.waitFor(submitted.id).then(run => ({ run })),
    new Promise(resolve => {
      timeoutHandle = setTimeout(() => resolve({ timeout: true }), 125_000);
      timeoutHandle.unref();
    }),
  ]);
  clearTimeout(timeoutHandle);
  if (settled.timeout) {
    console.log(JSON.stringify({ status: 'timed-out', platform: process.platform === 'darwin' ? 'macOS' : 'other' }));
    evidenceReported = true;
    process.exitCode = 1;
  } else {
    const run = settled.run;
    const readFixture = path => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };
    const finalFiles = {
      proofMatches: readFixture(join(workspace, 'proof.txt')) === marker,
      projectMcpMatches: readFixture(join(workspace, 'mcp-proof.txt')) === marker,
      workerSentinelUnchanged: readFixture(join(repoRoot, 'host-sentinel.txt')) === 'WORKER_SENTINEL_UNCHANGED',
    };
    const readiness = await runtime.hostClaudeReadiness();
    const leaseStates = runtime.pool.leases().map(row => row.state);
    const expectedEvidence = run.status === 'completed' && run.workOption?.engine === 'claude' &&
      observations.workspace.some(row => row.operation === 'read' && row.pathClass === 'origin' && row.status === 'completed') &&
      observations.workspace.some(row => row.operation === 'edit' && row.pathClass === 'proof' && row.status === 'completed') &&
      observations.workspace.some(row => row.operation === 'read' && row.pathClass === 'outside-workspace' && row.status === 'failed' && row.failure === 'invalid-path') &&
      observations.projectMcp.some(row => row.tool === 'project-mcp' && row.markerAccepted) &&
      finalFiles.proofMatches && finalFiles.projectMcpMatches && finalFiles.workerSentinelUnchanged &&
      leaseStates.length > 0 && leaseStates.every(state => state === 'released');
    const facts = {
      status: expectedEvidence ? 'passed' : 'failed',
      evidenceTier: 'model-issued',
      platform: process.platform === 'darwin' ? 'macOS' : 'other',
      workerPlacement: 'disposable enrolled Worker on the same host',
      engine: run.workOption?.engine,
      version: readiness?.version,
      resolvedModel: readiness?.resolvedModel,
      elapsedMs: Date.now() - startedAt,
      nativeCatalogVerified: run.status === 'completed',
      eventTypes: run.events.map(event => event.type),
      workspace: observations.workspace,
      projectMcp: observations.projectMcp,
      finalFiles,
      leaseStates,
      tokenUsage: run.tokenUsage,
    };
    console.log(JSON.stringify(facts));
    evidenceReported = true;
    if (!expectedEvidence) process.exitCode = 1;
  }
} catch {
  if (!evidenceReported) console.log(JSON.stringify({ status: 'failed', failure: 'harness-or-runtime-error' }));
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.close().catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
}
