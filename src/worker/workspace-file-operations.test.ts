import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EndpointCarrier } from './carrier.ts';
import { WorkerWorkspace } from './workspace.ts';
import { WorkerWorkspaceFiles } from './workspace-file-operations.ts';

test('Worker MCP inspection reads only the bound root manifest and returns sanitized stdio descriptors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sprout-mcp-inspection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkerWorkspace(root);
  const selected = await workspace.validateWorkspace({ projectId: 'project-mcp', environmentInstanceId: 'env-mcp', kind: 'relative', path: 'repo' });
  const files = new WorkerWorkspaceFiles(workspace, 'env-mcp');
  const binding = {
    projectId: 'project-mcp', environmentInstanceId: 'env-mcp', bindingId: 'binding-mcp',
    generation: 1, connectionEpoch: 1, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo',
  } as const;
  await files.attach(binding);
  await writeFile(join(root, 'repo', '.mcp.json'), JSON.stringify({ mcpServers: {
    filesystem: { command: 'fixture-command', args: ['--label', 'private-config-field'], env: { FIXTURE_SETTING: 'private-config-field' } },
  } }));
  const inspection = await files.inspectMcpConfiguration({ ...binding, format: 'claude-code-mcp-json-v1' });
  assert.deepEqual(inspection, {
    status: 'valid', format: 'claude-code-mcp-json-v1', servers: [{ name: 'filesystem', transport: 'stdio' }],
  });
  assert.equal(JSON.stringify(inspection).includes('fixture-command'), false);
  assert.equal(JSON.stringify(inspection).includes('private-config-field'), false);

  await writeFile(join(root, 'repo', '.mcp.json'), JSON.stringify({ mcpServers: {
    remote: { type: 'http', url: 'https://example.invalid/mcp' },
  } }));
  const unsupported = await files.inspectMcpConfiguration({ ...binding, format: 'claude-code-mcp-json-v1' });
  assert.equal(unsupported.status, 'unsupported');
  assert.deepEqual(unsupported.servers, []);
});

test('Worker launches a selected stdio MCP server in the bound workspace, validates calls, and fences by lease', async (t) => {
  const workerRoot = await mkdtemp(join(tmpdir(), 'sprout-mcp-worker-'));
  const hostRoot = await mkdtemp(join(tmpdir(), 'sprout-mcp-host-'));
  t.after(async () => {
    await rm(workerRoot, { recursive: true, force: true });
    await rm(hostRoot, { recursive: true, force: true });
  });
  const connection = await worker(workerRoot);
  t.after(() => connection.close());
  const selected = await connection.contexts.validateWorkspace({ projectId: 'project-mcp', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const binding = {
    projectId: 'project-mcp', environmentInstanceId: 'env-1', bindingId: 'binding-mcp',
    generation: 1, connectionEpoch: 4, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo',
  } as const;
  await connection.contexts.attachWorkspaceBinding(binding);
  const serverScript = `
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    writeFileSync('mcp-worker-location.txt', 'launched-in-bound-workspace');
    const tools = [{ name: 'echo', description: 'Echo the supplied text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }];
    const input = createInterface({ input: process.stdin });
    function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
    input.on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
      else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools } });
      else if (request.method === 'tools/call') send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: request.params.arguments.text }] } });
    });
  `;
  await writeFile(join(workerRoot, 'repo', '.mcp.json'), JSON.stringify({ mcpServers: {
    'fixture-server': { command: process.execPath, args: ['--input-type=module', '-e', serverScript], env: { MCP_FIXTURE_PRIVATE: 'private-config-value' } },
  } }));
  const lease = { leaseId: 'lease-mcp-1', holderKind: 'run' as const, holderId: 'run-mcp-1', runId: 'run-mcp-1' };
  const started = await connection.contexts.startProjectMcp({ ...binding, ...lease, format: 'claude-code-mcp-json-v1' });
  assert.equal(started.status, 'ready');
  assert.equal(started.servers.length, 1);
  assert.equal(started.servers[0]?.name, 'fixture-server');
  assert.deepEqual(started.servers[0]?.tools.map(tool => ({ name: tool.name, server: tool.server })), [{ name: 'echo', server: 'fixture-server' }]);
  assert.equal(JSON.stringify(started).includes('private-config-value'), false);
  assert.equal(JSON.stringify(started).includes(process.execPath), false);
  assert.equal(JSON.stringify(started).includes(workerRoot), false);
  assert.equal(await readFile(join(workerRoot, 'repo', 'mcp-worker-location.txt'), 'utf8'), 'launched-in-bound-workspace');
  assert.equal(await readFile(join(hostRoot, 'mcp-worker-location.txt')).catch(() => ''), '', 'the configured host-side directory was not used');
  const processId = started.processId;
  const toolId = started.servers[0]?.tools[0]?.id;
  assert.ok(processId);
  assert.ok(toolId);
  const call = await connection.contexts.callProjectMcpTool({ ...binding, ...lease, processId, toolId, arguments: { text: 'hello from Project tool' } });
  assert.deepEqual(call, { status: 'completed', text: 'hello from Project tool' });
  const invalid = await connection.contexts.callProjectMcpTool({ ...binding, ...lease, processId, toolId, arguments: { text: 12 } });
  assert.deepEqual(invalid, { status: 'failed', reason: 'invalid-arguments' });
  const wrongLease = await connection.contexts.callProjectMcpTool({ ...binding, ...lease, leaseId: 'lease-other', processId, toolId, arguments: { text: 'must not route' } });
  assert.deepEqual(wrongLease, { status: 'failed', reason: 'worker-refused' });
  const stopped = await connection.contexts.stopProjectMcp({ ...binding, ...lease, processId });
  assert.deepEqual(stopped, { status: 'stopped' });
});

test('Worker file reads return the same-name remote sentinel and deny traversal, another Project, and host paths', async (t) => {
  const hostRoot = await mkdtemp(join(tmpdir(), 'sprout-host-sentinel-'));
  const workerRoot = await mkdtemp(join(tmpdir(), 'sprout-remote-sentinel-'));
  t.after(async () => {
    await rm(hostRoot, { recursive: true, force: true });
    await rm(workerRoot, { recursive: true, force: true });
  });
  const connection = await worker(workerRoot);
  t.after(() => connection.close());
  const hostSentinel = join(hostRoot, 'sentinel.txt');
  await writeFile(hostSentinel, 'LOCAL_HOST_SENTINEL');
  const selected = await connection.contexts.validateWorkspace({ projectId: 'project-1', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  await writeFile(join(workerRoot, 'repo', 'sentinel.txt'), 'REMOTE_PROJECT_SENTINEL');
  const binding = {
    projectId: 'project-1', environmentInstanceId: 'env-1', bindingId: 'binding-1',
    generation: 1, connectionEpoch: 4, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo',
  } as const;
  await connection.contexts.attachWorkspaceBinding(binding);

  const { path: workspacePath, ...bindingIdentity } = binding;
  const operationBinding = { ...bindingIdentity, workspacePath };
  const remote = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'remote-read-1', operation: 'read', path: 'sentinel.txt' });
  if (remote.status !== 'completed') throw new Error(`Worker read failed: ${remote.failure ?? 'no failure detail'}`);
  assert.equal(remote.content, 'REMOTE_PROJECT_SENTINEL');
  assert.notEqual(remote.content, 'LOCAL_HOST_SENTINEL', 'the same-name host fixture is not the read origin');
  assert.equal(remote.projectId, 'project-1');
  assert.equal(remote.bindingId, 'binding-1');
  assert.equal(remote.generation, 1);
  assert.equal(remote.connectionEpoch, 4);

  const traversal = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'traversal-1', operation: 'read', path: '../sentinel.txt' });
  assert.equal(traversal.status, 'failed');
  assert.equal(traversal.failure, 'invalid-path');
  const hostRead = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'host-read-1', operation: 'read', path: hostSentinel });
  assert.equal(hostRead.status, 'failed');
  assert.equal(hostRead.failure, 'invalid-path');
  await assert.rejects(
    connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, projectId: 'project-2', operationId: 'cross-project-1', operation: 'read', path: 'sentinel.txt' }),
    /Worker request could not be completed/i,
  );
});


test('Worker refuses a same-generation binding retarget and fences calls after a new generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sprout-workspace-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkerWorkspace(root);
  const first = await workspace.validateWorkspace({ projectId: 'project-1', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo-one' });
  const second = await workspace.validateWorkspace({ projectId: 'project-1', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo-two' });
  await writeFile(join(root, 'repo-one', 'sentinel.txt'), 'first workspace');
  await writeFile(join(root, 'repo-two', 'sentinel.txt'), 'second workspace');

  const files = new WorkerWorkspaceFiles(workspace, 'env-1');
  const binding = {
    projectId: 'project-1', environmentInstanceId: 'env-1', bindingId: 'binding-1',
    generation: 1, connectionEpoch: 4, workspaceId: first.workspaceId, kind: 'relative', path: 'repo-one',
  } as const;
  await files.attach(binding);
  const { path: firstWorkspacePath, ...firstIdentity } = binding;
  const firstOperationBinding = { ...firstIdentity, workspacePath: firstWorkspacePath };
  await assert.rejects(files.attach({ ...binding, workspaceId: second.workspaceId, path: 'repo-two' }), /conflicting workspace binding/);

  const firstRead = await files.execute({ ...firstOperationBinding, operationId: 'operation-1', operation: 'read', path: 'sentinel.txt' });
  assert.equal(firstRead.content, 'first workspace', 'a refused attach leaves the original generation bound');

  const next = { ...binding, bindingId: 'binding-2', generation: 2, workspaceId: second.workspaceId, path: 'repo-two' } as const;
  const { path: secondWorkspacePath, ...secondIdentity } = next;
  const secondOperationBinding = { ...secondIdentity, workspacePath: secondWorkspacePath };
  await files.attach(next);
  await assert.rejects(
    files.execute({ ...firstOperationBinding, operationId: 'operation-2', operation: 'read', path: 'sentinel.txt' }),
    /stale workspace binding/,
  );
  const secondRead = await files.execute({ ...secondOperationBinding, operationId: 'operation-3', operation: 'read', path: 'sentinel.txt' });
  assert.equal(secondRead.content, 'second workspace');

  await assert.rejects(files.attach({ ...next, bindingId: 'binding-3', generation: 3, connectionEpoch: 3 }), /stale workspace binding/);
});

async function worker(root: string) {
  const server = new URL('./server.ts', import.meta.url).pathname;
  const carrier = new URL('./carrier.ts', import.meta.url).pathname;
  const scripted = new URL('../engine/scripted.ts', import.meta.url).pathname;
  return EndpointCarrier.start({
    command: process.execPath,
    args: ['--input-type=module', '-e', `
      import { EnvironmentWorker } from ${JSON.stringify(server)};
      import { ScriptedEngineAdapter } from ${JSON.stringify(scripted)};
      import { serveWorkerEndpoint, WORKER_READY_PREFIX } from ${JSON.stringify(carrier)};
      const endpoint = await serveWorkerEndpoint({ serve: (socket) => new EnvironmentWorker({
        environmentInstanceId: 'env-1', engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
        input: socket, output: socket, workspaceRoot: ${JSON.stringify(root)},
      }) });
      process.stdout.write(WORKER_READY_PREFIX + JSON.stringify(endpoint.ready) + '\\n');
    `],
    label: 'workspace-file-worker',
    onLog: (line) => process.stderr.write(`${line}\\n`),
  });
}
