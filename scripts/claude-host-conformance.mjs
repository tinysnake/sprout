/** Bounded Host-run conformance fixtures for no-Environment and authorized Workspace/Project MCP Task scenarios. */
import { createServer } from 'node:http';
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
import { toTaskContextState } from '../src/web/views.ts';

const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-host-conformance-'));
const projectId = 'claude-live-conformance-project';
const agentId = 'claude-live-conformance-agent';
const marker = 'REMOTE_ORIGIN_CLAUDE_HOST_PROBE';
const taskHttpMode = process.argv.includes('--task-http');
const taskCommandMode = process.argv.includes('--task-command');
const taskMode = taskHttpMode || taskCommandMode;
const noEnvironmentMode = process.argv.includes('--no-environment');
const httpToolDescription = 'Return a fixed bounded HTTP fixture result.';
const observations = { workspace: [], projectMcp: [], workspaceCatalog: [] };
let runtime;
let httpMcpServer;
let httpMcpRequests = 0;
let httpMcpToolCalls = 0;
let httpMcpInputsMatched = true;
let taskLeaseId;
let evidenceReported = false;

async function startHttpProjectMcp() {
  httpMcpServer = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      httpMcpRequests += 1;
      if (request.method === 'DELETE') {
        response.writeHead(204).end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      let message;
      try { message = JSON.parse(body); }
      catch { response.writeHead(400).end(); return; }
      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
      } else if (message.method === 'tools/list') {
        const result = {
          jsonrpc: '2.0', id: message.id,
          result: { tools: [{ name: 'http_echo', description: httpToolDescription, inputSchema: {
            type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false,
          } }] },
        };
        response.writeHead(200, { 'content-type': 'text/event-stream' })
          .end(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
      } else if (message.method === 'tools/call') {
        httpMcpToolCalls += 1;
        const matched = message.params?.name === 'http_echo' && message.params.arguments?.text === 'HTTP_OK';
        httpMcpInputsMatched &&= matched;
        const text = matched ? 'HTTP_OK' : 'HTTP_DIFFERENT';
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] },
        }));
      } else {
        response.writeHead(400).end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    httpMcpServer.once('error', reject);
    httpMcpServer.listen(0, 'localhost', resolve);
  });
  const address = httpMcpServer.address();
  if (!address || typeof address === 'string') throw new Error('http-mcp-fixture-listen-failed');
  return `http://localhost:${address.port}/mcp`;
}

try {
  if (Number(taskHttpMode) + Number(taskCommandMode) + Number(noEnvironmentMode) > 1) {
    throw new Error('choose-one-conformance-scenario');
  }
  const workerRoot = join(directory, 'worker');
  const workspace = join(workerRoot, 'repos', 'claude-live');
  const repoRoot = join(workerRoot, 'repos');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'origin.txt'), marker);
  if (taskCommandMode) {
    writeFileSync(join(workspace, 'proof.test.cjs'), [
      "const assert = require('node:assert/strict');",
      "const { readFileSync } = require('node:fs');",
      "const test = require('node:test');",
      "const marker = 'READY';",
      "test('authorized remote origin marker matches the edited fixture', () => {",
      "  assert.equal(readFileSync('origin.txt', 'utf8'), marker);",
      '});',
      '',
    ].join('\n'));
  } else {
    writeFileSync(join(workspace, 'proof.txt'), 'READY');
  }
  writeFileSync(join(repoRoot, 'host-sentinel.txt'), 'WORKER_SENTINEL_UNCHANGED');

  const mcpServer = `import { createInterface } from 'node:readline'; import { writeFileSync } from 'node:fs'; const send=value=>process.stdout.write(JSON.stringify(value)+'\\n'); createInterface({input:process.stdin}).on('line',line=>{ const r=JSON.parse(line); if(r.method==='initialize') send({jsonrpc:'2.0',id:r.id,result:{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}}); else if(r.method==='tools/list') send({jsonrpc:'2.0',id:r.id,result:{tools:[{name:'record_marker',description:'Record the marker read from the authorized remote workspace.',inputSchema:{type:'object',properties:{marker:{type:'string'}},required:['marker'],additionalProperties:false}}]}}); else if(r.method==='tools/call'){ const a=r.params.arguments; if(r.params.name==='record_marker'&&a.marker===${JSON.stringify(marker)}) { writeFileSync('mcp-proof.txt',a.marker); send({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:'marker recorded'}]}}); } else send({jsonrpc:'2.0',id:r.id,result:{isError:true,content:[{type:'text',text:'marker refused'}]}}); } });`;
  const httpUrl = taskHttpMode ? await startHttpProjectMcp() : undefined;
  writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({
    mcpServers: {
      fixture: { command: process.execPath, args: ['--input-type=module', '-e', mcpServer] },
      ...(httpUrl !== undefined ? { 'http-fixture': { type: 'http', url: httpUrl } } : {}),
    },
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
  const taskLeaseHeld = () => taskLeaseId !== undefined && runtime.pool.getLease(taskLeaseId)?.state === 'active';
  const originalAttach = operations.attach.bind(operations);
  operations.attach = async (...args) => {
    const tools = await originalAttach(...args);
    observations.workspaceCatalog.push({
      operations: tools.operations ?? [],
      commandMethodAvailable: typeof tools.command === 'function',
    });
    const classify = path => path === 'origin.txt' ? 'origin'
      : path === (taskCommandMode ? 'proof.test.cjs' : 'proof.txt') ? 'proof'
        : path === '../host-sentinel.txt' ? 'outside-workspace' : 'other';
    return {
      ...tools,
      read: async (path, operationId) => {
        const result = await tools.read(path, operationId);
        observations.workspace.push({
          operation: 'read', pathClass: classify(path), status: result.status, taskLeaseHeld: taskLeaseHeld(),
          ...(result.failure !== undefined ? { failure: result.failure } : {}),
        });
        return result;
      },
      edit: async (path, oldText, newText, operationId) => {
        const result = await tools.edit(path, oldText, newText, operationId);
        observations.workspace.push({
          operation: 'edit', pathClass: classify(path), status: result.status, taskLeaseHeld: taskLeaseHeld(),
          ...(result.failure !== undefined ? { failure: result.failure } : {}),
        });
        return result;
      },
      search: async (query, path, operationId) => {
        const result = await tools.search(query, path, operationId);
        observations.workspace.push({
          operation: 'search', pathClass: path === undefined ? 'workspace-root' : classify(path),
          status: result.status, taskLeaseHeld: taskLeaseHeld(),
          ...(result.failure !== undefined ? { failure: result.failure } : {}),
        });
        return result;
      },
      ...(typeof tools.command === 'function' ? {
        command: async (executable, args, options, operationId, onProgress) => {
          const result = await tools.command(executable, args, options, operationId, onProgress);
          const output = result.output ?? '';
          observations.workspace.push({
            operation: 'command', pathClass: 'command-test', status: result.status,
            executableMatched: executable === 'node', args: [...args],
            argsMatched: args.length === 2 && args[0] === '--test' && args[1] === 'proof.test.cjs',
            cwd: options.cwd ?? '.', timeoutMs: options.timeoutMs ?? 30_000,
            exitCode: result.exitCode ?? null,
            testOutputMatched: output.includes('tests 1') && output.includes('pass 1') && output.includes('fail 0') &&
              output.includes('authorized remote origin marker matches the edited fixture'),
            output, taskLeaseHeld: taskLeaseHeld(),
          });
          return result;
        },
      } : {}),
    };
  };
  const originalAttachMcp = operations.attachProjectMcpTools.bind(operations);
  operations.attachProjectMcpTools = async (...args) => {
    const tools = await originalAttachMcp(...args);
    const httpToolName = tools.tools.find(row => row.description === httpToolDescription)?.name;
    const stdioToolName = tools.tools.find(row => row.description === 'Record the marker read from the authorized remote workspace.')?.name;
    return {
      ...tools,
      call: async (name, arguments_) => {
        const result = await tools.call(name, arguments_);
        const tool = name === httpToolName ? 'http' : name === stdioToolName ? 'stdio' : 'other';
        observations.projectMcp.push({
          tool: tools.tools.some(row => row.name === name) ? tool : 'other',
          status: result.status,
          markerAccepted: result.status === 'completed' && result.text === 'marker recorded',
          inputMatched: tool === 'http' ? arguments_.text === 'HTTP_OK' : tool === 'stdio' && arguments_.marker === marker,
          outputMatched: tool === 'http' ? result.status === 'completed' && result.text === 'HTTP_OK' : tool === 'stdio' && result.status === 'completed' && result.text === 'marker recorded',
          taskLeaseHeld: taskLeaseHeld(),
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
  if (!noEnvironmentMode) {
    await runtime.projectService.updateContent(projectId, { mcpConfiguration: { format: 'claude-code-mcp-json-v1' } });
    await runtime.projectAccess.grant({
      projectId,
      environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'relative', path: 'repos/claude-live' },
    });
  }

  const startedAt = Date.now();
  let taskId;
  let runId;
  let taskPlacementRecorded = false;
  let initialTaskLeaseHeld = false;
  if (taskMode) {
    const actor = await runtime.taskProposals.humanAuthority(projectId);
    const proposal = await runtime.taskProposals.propose(projectId, actor, {
      title: taskCommandMode ? 'Bounded Claude Host-run remote command Task' : 'Bounded Claude Host-run HTTP MCP Task',
      goal: taskCommandMode
        ? 'Run one authorized remote Node test from a Host-run Task, then complete the bounded Task.'
        : 'Exercise HTTP Project MCP and complete one bounded Host-run Task.',
      constraints: taskCommandMode ? [
        'Use only the authorized remote Workspace and listed Project MCP tools.',
        'Read origin.txt and copy its exact marker into proof.test.cjs by replacing the exact line const marker = \'READY\'; with const marker = \'REMOTE_ORIGIN_CLAUDE_HOST_PROBE\';.',
        'Call the stdio marker recorder with the marker.',
        'Run workspace_command exactly once with executable node, args [--test, proof.test.cjs], cwd ., and timeoutMs 30000. proof.test.cjs is both the edited proof and the test entry point.',
      ] : [
        'Use only the authorized remote Workspace and listed Project MCP tools.',
        'Read origin.txt and copy its exact marker into proof.txt by replacing READY.',
        'Call the stdio marker recorder with the marker, and call the HTTP echo tool with exactly HTTP_OK.',
      ],
      validationCriteria: [taskCommandMode
        ? 'The remote Node test and stdio Project MCP check succeed under the Task lease, then the Task completes and releases its lease.'
        : 'The remote file and both Project MCP checks succeed under the Task lease, then the Task completes and releases its lease.'],
    });
    const begun = await runtime.taskAdmissions.beginForHuman(proposal.id, {
      expectedRevision: proposal.revision,
      environmentInstanceId: INSTANCE_ID,
      lead: actor,
      reason: taskCommandMode
        ? 'Authorize one bounded Claude remote command/test Task probe.'
        : 'Authorize one bounded Claude HTTP MCP and Task lifecycle probe.',
    });
    taskId = begun.task.id;
    taskLeaseId = begun.task.environmentLeaseId;
    taskPlacementRecorded = begun.task.executionPlacement?.mode === 'host-run';
    initialTaskLeaseHeld = taskLeaseHeld();
    if (!taskLeaseId || !initialTaskLeaseHeld || !taskPlacementRecorded) {
      console.log(JSON.stringify({ status: 'task-admission-incomplete', initialTaskLeaseHeld, taskPlacementRecorded }));
      evidenceReported = true;
      process.exitCode = 1;
    } else {
      const taskPrompt = taskCommandMode
        ? 'Use only the listed remote Workspace and Project MCP tools. Read origin.txt. In proof.test.cjs, replace the exact line const marker = \'READY\'; with const marker = \'REMOTE_ORIGIN_CLAUDE_HOST_PROBE\';. Call the stdio Project MCP tool described as "Record the marker read from the authorized remote workspace." with that marker. Then call workspace_command exactly once with {"executable":"node","args":["--test","proof.test.cjs"],"cwd":".","timeoutMs":30000}. proof.test.cjs is both the edited proof and the test entry point. Confirm the one-test command passes. Use exactly these four operations; do not call any other tool or use any other path. Return one short outcome.'
        : `Use only the listed remote Workspace and Project MCP tools. First read origin.txt and copy its exact marker. Call the stdio Project MCP tool described as "Record the marker read from the authorized remote workspace." with that marker. Edit proof.txt by replacing READY with the exact marker. Call the HTTP Project MCP tool described as "${httpToolDescription}" with exactly {"text":"HTTP_OK"}. Use each of these four tools exactly once; do not call any other tool or attempt any other path. Return one short outcome.`;
      const advanced = await runtime.taskAdmissions.advanceForHuman(taskId, {
        targetAgentId: agentId,
        reason: taskCommandMode ? 'Run the bounded remote command/test Task check.' : 'Run the bounded HTTP Project MCP Task check.',
        prompt: taskPrompt,
      });
      runId = advanced.runId;
    }
  } else if (noEnvironmentMode) {
    const submitted = await runtime.orchestrator.submit({
      agentId,
      projectId,
      prompt: 'This is a bounded no-Environment Host-run conversation. No Environment, remote Workspace, or Project MCP tool is attached. Reply with exactly PONG and do not attempt any tool call.',
    });
    runId = submitted.id;
  } else {
    const submitted = await runtime.orchestrator.submit({
      agentId,
      projectId,
      workEnvironmentInstanceId: INSTANCE_ID,
      prompt: 'This is a bounded conformance task. Use only the listed remote workspace and Project MCP tools. Read origin.txt and copy its exact marker. Call the Project MCP tool record_marker with that marker. Edit proof.txt by replacing READY with that exact marker. Then try one read of ../host-sentinel.txt; the selected workspace boundary must refuse it. Do not try another path and do not use any local or built-in work tool. Reply with a short outcome.',
    });
    runId = submitted.id;
  }

  if (runId !== undefined) {
    let timeoutHandle;
    const settled = await Promise.race([
      runtime.orchestrator.waitFor(runId).then(run => ({ run })),
      new Promise(resolve => {
        timeoutHandle = setTimeout(() => resolve({ timeout: true }), 125_000);
        timeoutHandle.unref();
      }),
    ]);
    clearTimeout(timeoutHandle);
    if (settled.timeout) {
      console.log(JSON.stringify({ status: 'timed-out', platform: process.platform === 'darwin' ? 'macOS' : 'other', scenario: noEnvironmentMode ? 'no-environment-conversation' : taskCommandMode ? 'remote-command-test-task' : taskHttpMode ? 'http-mcp-task' : 'stdio-origin' }));
      evidenceReported = true;
      process.exitCode = 1;
    } else {
      const run = settled.run;
      const readFixture = path => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };
      const proofFileMatches = () => {
        const content = readFixture(join(workspace, taskCommandMode ? 'proof.test.cjs' : 'proof.txt'));
        return taskCommandMode ? content?.includes(`const marker = '${marker}';`) === true : content === marker;
      };
      const finalFiles = {
        proofMatches: proofFileMatches(),
        projectMcpMatches: readFixture(join(workspace, 'mcp-proof.txt')) === marker,
        ...(!taskHttpMode ? { workerSentinelUnchanged: readFixture(join(repoRoot, 'host-sentinel.txt')) === 'WORKER_SENTINEL_UNCHANGED' } : {}),
      };
      const readiness = await runtime.hostClaudeReadiness();
      const finalMessage = run.events.filter(event => event.type === 'message' && event.final).at(-1);
      const exactPong = finalMessage?.text.trim() === 'PONG';
      const modelIssuedTools = run.events.filter(event => event.type === 'tool-call').map(event => event.name);
      let taskAfterRun;
      let taskIdleAfterRun = false;
      let runUsedTaskLease = false;
      let taskLeaseHeldAfterRun = false;
      let taskLeaseHeldForEveryOperation = false;
      let completionClaimSubmitted = false;
      let taskEndedSafely = false;
      let workspacePersistsAfterTaskEnd = false;
      let httpMcpPassed = false;
      let remoteCommandTestPassed = false;
      if (taskMode && taskId && taskLeaseId) {
        taskAfterRun = await runtime.tasks.get(taskId);
        taskIdleAfterRun = taskAfterRun?.environmentLifecycleState === 'idle';
        runUsedTaskLease = run.leaseId === taskLeaseId;
        taskLeaseHeldAfterRun = taskLeaseHeld();
        const observed = [...observations.workspace, ...observations.projectMcp];
        taskLeaseHeldForEveryOperation = observed.length >= 4 && observed.length <= (taskCommandMode ? 12 : 4) &&
          observed.every(row => row.taskLeaseHeld);
        const unexpectedWorkspaceSuccess = observations.workspace.some(row => row.pathClass === 'other' && row.status === 'completed');
        const httpOperations = observations.projectMcp.filter(row => row.tool === 'http' && row.status === 'completed' && row.inputMatched && row.outputMatched);
        const stdioOperations = observations.projectMcp.filter(row => row.tool === 'stdio' && row.status === 'completed' && row.inputMatched && row.outputMatched);
        httpMcpPassed = taskHttpMode && httpMcpToolCalls === 1 && httpMcpInputsMatched && httpOperations.length === 1;
        const commandOperations = observations.workspace.filter(row => row.operation === 'command' && row.pathClass === 'command-test');
        const commandCatalogAvailable = observations.workspaceCatalog.some(row => row.operations.includes('command') && row.commandMethodAvailable);
        const commandToolCallObserved = modelIssuedTools.includes('mcp__sprout__workspace_command');
        remoteCommandTestPassed = taskCommandMode && commandCatalogAvailable && commandToolCallObserved &&
          commandOperations.length === 1 && commandOperations[0].status === 'completed' &&
          commandOperations[0].executableMatched && commandOperations[0].argsMatched && commandOperations[0].timeoutMs === 30_000 &&
          commandOperations[0].exitCode === 0 && commandOperations[0].testOutputMatched;
        const taskOperationsComplete = run.status === 'completed' && run.workOption?.engine === 'claude' &&
          observations.workspace.filter(row => row.operation === 'read' && row.pathClass === 'origin' && row.status === 'completed').length === 1 &&
          observations.workspace.filter(row => row.operation === 'edit' && row.pathClass === 'proof' && row.status === 'completed').length === 1 &&
          stdioOperations.length === 1 && taskLeaseHeldForEveryOperation && !unexpectedWorkspaceSuccess &&
          finalFiles.proofMatches && finalFiles.projectMcpMatches &&
          (taskCommandMode ? remoteCommandTestPassed : httpMcpPassed);
        if (taskOperationsComplete && runUsedTaskLease && taskIdleAfterRun && taskLeaseHeldAfterRun) {
          const claim = await runtime.taskControls.submitCompletionClaimForHuman(taskId, {
            outcomeSummary: taskCommandMode
              ? 'The bounded remote Node test and Project MCP check completed.'
              : 'The bounded remote Workspace and HTTP Project MCP check completed.',
            validationEvidence: [taskCommandMode
              ? 'The remote Node test passed and the Project file persisted.'
              : 'The HTTP tool returned the expected fixture result and the Project file persisted.'],
            durableChanges: ['The Project workspace contains the bounded proof file.'],
            limitations: ['This Task does not exercise mode-changing service restart or no-replay reconciliation.'],
            recommendedDisposition: 'complete',
          });
          const claimId = claim.completionClaims?.at(-1)?.id;
          completionClaimSubmitted = claimId !== undefined;
          if (claimId) {
            const ended = await runtime.taskControls.validateForHuman(taskId, {
              claimId, decision: 'accept', reason: taskCommandMode ? 'The bounded remote command/test Task checks passed.' : 'The bounded HTTP MCP Task checks passed.',
            });
            taskEndedSafely = ended.status === 'done' && toTaskContextState(ended) === 'recycled' &&
              runtime.pool.getLease(taskLeaseId)?.state === 'released';
            workspacePersistsAfterTaskEnd = proofFileMatches();
          }
        }
      }
      const leaseStates = runtime.pool.leases().map(row => row.state);
      const taskLifecyclePassed = taskMode && taskPlacementRecorded && initialTaskLeaseHeld && runUsedTaskLease &&
        taskIdleAfterRun && taskLeaseHeldAfterRun && taskLeaseHeldForEveryOperation && completionClaimSubmitted &&
        taskEndedSafely && workspacePersistsAfterTaskEnd && runtime.pool.getLease(taskLeaseId)?.state === 'released';
      const noEnvironmentPassed = noEnvironmentMode && run.status === 'completed' && run.workOption?.engine === 'claude' &&
        run.executionPlacement?.mode === 'host-run' && run.environmentInstanceId === '' && run.workspaceBinding === undefined &&
        run.workspaceBindingStatus === 'detached' && observations.workspaceCatalog.length === 0 &&
        observations.workspace.length === 0 && observations.projectMcp.length === 0 && modelIssuedTools.length === 0 && exactPong;
      const expectedEvidence = noEnvironmentMode
        ? noEnvironmentPassed
        : taskCommandMode
          ? remoteCommandTestPassed && taskLifecyclePassed && run.status === 'completed' && run.workOption?.engine === 'claude'
          : taskHttpMode
            ? httpMcpPassed && taskLifecyclePassed && run.status === 'completed' && run.workOption?.engine === 'claude'
            : run.status === 'completed' && run.workOption?.engine === 'claude' &&
              observations.workspace.some(row => row.operation === 'read' && row.pathClass === 'origin' && row.status === 'completed') &&
              observations.workspace.some(row => row.operation === 'edit' && row.pathClass === 'proof' && row.status === 'completed') &&
              observations.workspace.some(row => row.operation === 'read' && row.pathClass === 'outside-workspace' && row.status === 'failed' && row.failure === 'invalid-path') &&
              observations.projectMcp.some(row => row.tool === 'stdio' && row.markerAccepted) &&
              finalFiles.proofMatches && finalFiles.projectMcpMatches && finalFiles.workerSentinelUnchanged &&
              leaseStates.length > 0 && leaseStates.every(state => state === 'released');
      const facts = {
        status: expectedEvidence ? 'passed' : 'failed',
        evidenceTier: 'model-issued',
        scenario: noEnvironmentMode ? 'no-environment-conversation'
          : taskCommandMode ? 'remote-command-test-task'
            : taskHttpMode ? 'http-project-mcp-and-task-lifecycle' : 'stdio-origin-boundary',
        platform: process.platform === 'darwin' ? 'macOS' : 'other',
        workerPlacement: 'disposable enrolled Worker on the same host',
        engine: run.workOption?.engine,
        version: readiness?.version,
        resolvedModel: readiness?.resolvedModel,
        elapsedMs: Date.now() - startedAt,
        nativeCatalogVerified: run.status === 'completed',
        executionMode: run.executionPlacement?.mode,
        environmentAttached: run.environmentInstanceId !== '',
        workspaceBindingPresent: run.workspaceBinding !== undefined,
        workspaceBindingStatus: run.workspaceBindingStatus,
        exactPong,
        modelIssuedTools,
        workspaceCatalog: observations.workspaceCatalog,
        workspace: observations.workspace,
        projectMcp: observations.projectMcp,
        noEnvironmentPassed,
        remoteCommandTest: taskCommandMode ? {
          catalogAdvertisedCommand: observations.workspaceCatalog.some(row => row.operations.includes('command')),
          commandMethodAvailable: observations.workspaceCatalog.some(row => row.commandMethodAvailable),
          modelIssuedToolCallObserved: modelIssuedTools.includes('mcp__sprout__workspace_command'),
          operationPassed: remoteCommandTestPassed,
        } : undefined,
        ...(taskMode ? {
          httpProjectMcp: taskHttpMode ? { toolCalls: httpMcpToolCalls, requests: httpMcpRequests, inputsMatched: httpMcpInputsMatched, passed: httpMcpPassed } : undefined,
          taskLifecycle: {
            placementRecorded: taskPlacementRecorded, initialLeaseHeld: initialTaskLeaseHeld, runUsedTaskLease,
            taskIdleAfterRun, taskLeaseHeldAfterRun, taskLeaseHeldForEveryOperation,
            completionClaimSubmitted, taskEndedSafely, workspacePersistsAfterTaskEnd,
            passed: taskLifecyclePassed,
            finalLeaseState: taskLeaseId ? runtime.pool.getLease(taskLeaseId)?.state ?? 'missing' : 'missing',
          },
        } : {}),
        finalFiles,
        leaseStates,
        tokenUsage: run.tokenUsage,
      };
      console.log(JSON.stringify(facts));
      evidenceReported = true;
      if (!expectedEvidence) process.exitCode = 1;
    }
  }
} catch {
  if (!evidenceReported) console.log(JSON.stringify({ status: 'failed', failure: 'harness-or-runtime-error' }));
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.close().catch(() => undefined);
  if (httpMcpServer?.listening) await new Promise(resolve => httpMcpServer.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
}
