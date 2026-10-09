import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { EndpointCarrier } from './carrier.ts';
import { WorkerWorkspace } from './workspace.ts';
import { WorkerWorkspaceFiles } from './workspace-file-operations.ts';
import { WorkerProjectMcp, type ProjectMcpClientLauncher } from './project-mcp.ts';

test('Worker MCP inspection reads the bound root manifest and returns sanitized stdio and HTTP descriptors', async (t) => {
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
    remote: { type: 'http', url: 'https://private-origin.example/mcp?token=private-origin-token', headers: { Authorization: 'Bearer private-header-token' } },
  } }));
  const inspectedHttp = await files.inspectMcpConfiguration({ ...binding, format: 'claude-code-mcp-json-v1' });
  assert.deepEqual(inspectedHttp, {
    status: 'valid', format: 'claude-code-mcp-json-v1', servers: [{ name: 'remote', transport: 'http' }],
  });
  assert.equal(JSON.stringify(inspectedHttp).includes('private-origin.example'), false);
  assert.equal(JSON.stringify(inspectedHttp).includes('private-origin-token'), false);
  assert.equal(JSON.stringify(inspectedHttp).includes('private-header-token'), false);
});

test('Worker starts and calls a remote-origin HTTP MCP server directly with bounded typed tools and private authorization', async (t) => {
  const originRequests: { method: string; authorization?: string; session?: string; protocolVersion?: string }[] = [];
  let toolCalls = 0;
  let proxyHits = 0;
  let originUrl = '';
  const origin = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      originRequests.push({
        method: request.method ?? '',
        ...(typeof request.headers.authorization === 'string' ? { authorization: request.headers.authorization } : {}),
        ...(typeof request.headers['mcp-session-id'] === 'string' ? { session: request.headers['mcp-session-id'] } : {}),
        ...(typeof request.headers['mcp-protocol-version'] === 'string' ? { protocolVersion: request.headers['mcp-protocol-version'] } : {}),
      });
      if (request.method === 'DELETE') {
        response.writeHead(204).end();
        return;
      }
      const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'private-session-sentinel' }).end(JSON.stringify({
          jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
      } else if (message.method === 'tools/list') {
        const result = {
          jsonrpc: '2.0', id: message.id,
          result: { tools: [{
            name: 'remote_echo', description: `Endpoint ${originUrl} session private-session-sentinel`,
            inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Authorization Bearer private-header-token' } }, required: ['text'], additionalProperties: false },
          }] },
        };
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
      } else if (message.method === 'tools/call') {
        toolCalls += 1;
        const text = `origin=${originUrl}; authorization=${request.headers.authorization}; session=${request.headers['mcp-session-id']}`;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] },
        }));
      } else {
        response.writeHead(404).end();
      }
    });
  });
  const proxy = createServer((_request, response) => { proxyHits += 1; response.writeHead(502).end(); });
  const originPort = await listenLocalServer(origin);
  const proxyPort = await listenLocalServer(proxy);
  originUrl = `http://localhost:${originPort}/mcp?token=private-origin-token`;
  const priorProxyEnvironment = saveProxyEnvironment();
  process.env.HTTP_PROXY = `http://localhost:${proxyPort}`;
  process.env.http_proxy = `http://localhost:${proxyPort}`;
  process.env.HTTPS_PROXY = `http://localhost:${proxyPort}`;
  process.env.https_proxy = `http://localhost:${proxyPort}`;
  process.env.ALL_PROXY = `http://localhost:${proxyPort}`;
  process.env.all_proxy = `http://localhost:${proxyPort}`;
  t.after(async () => {
    restoreProxyEnvironment(priorProxyEnvironment);
    await closeLocalServer(origin);
    await closeLocalServer(proxy);
  });

  const workerRoot = await mkdtemp(join(tmpdir(), 'sprout-mcp-http-worker-'));
  t.after(() => rm(workerRoot, { recursive: true, force: true }));
  const connection = await worker(workerRoot);
  t.after(() => connection.close());
  const selected = await connection.contexts.validateWorkspace({ projectId: 'project-http-mcp', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const binding = {
    projectId: 'project-http-mcp', environmentInstanceId: 'env-1', bindingId: 'binding-http-mcp',
    generation: 1, connectionEpoch: 4, workspaceId: selected.workspaceId, kind: 'relative' as const, path: 'repo',
  };
  await connection.contexts.attachWorkspaceBinding(binding);
  await writeFile(join(workerRoot, 'repo', '.mcp.json'), JSON.stringify({ mcpServers: {
    remote: { type: 'http', url: originUrl, headers: { Authorization: 'Bearer private-header-token' } },
  } }));
  const lease = { leaseId: 'lease-http-mcp', holderKind: 'run' as const, holderId: 'run-http-mcp', runId: 'run-http-mcp' };
  const processId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const started = await connection.contexts.startProjectMcp({ ...binding, ...lease, processId, format: 'claude-code-mcp-json-v1' });
  assert.equal(started.status, 'ready');
  assert.equal(started.servers[0]?.tools.length, 1);
  const catalogText = JSON.stringify(started);
  for (const secret of [originUrl, `localhost:${originPort}`, 'private-origin-token', 'private-header-token', 'private-session-sentinel']) {
    assert.equal(catalogText.includes(secret), false, `the typed catalog must not expose ${secret}`);
  }
  const declaration = started.servers[0]?.tools[0];
  assert.ok(declaration);
  assert.equal(declaration.description.includes('private-session-sentinel'), false);
  assert.equal(JSON.stringify(declaration.inputSchema).includes('private-header-token'), false);
  const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const callInput = { ...binding, ...lease, processId, operationId, toolId: declaration.id, arguments: { text: 'hello' } };
  const called = await connection.contexts.callProjectMcpTool(callInput);
  assert.equal(called.status, 'completed');
  const resultText = called.text ?? '';
  for (const secret of [originUrl, `localhost:${originPort}`, 'private-origin-token', 'private-header-token', 'private-session-sentinel']) {
    assert.equal(resultText.includes(secret), false, `the model-visible result must not expose ${secret}`);
  }
  assert.deepEqual(await connection.contexts.callProjectMcpTool(callInput), called, 'a retry with the same durable operation id reuses its result');
  assert.equal(toolCalls, 1);
  assert.equal(proxyHits, 0, 'the configured host proxy fixture received no request');
  assert.ok(originRequests.length >= 4, 'initialize, notification, discovery and invocation reached the configured origin');
  assert.ok(originRequests.every(row => row.authorization === 'Bearer private-header-token'));
  assert.ok(originRequests.every(row => row.protocolVersion === '2025-06-18'));
  assert.ok(originRequests.filter(row => row.method !== 'POST' || row.session !== undefined).length >= 3);
  const stopped = await connection.contexts.stopProjectMcp({ ...binding, ...lease, processId });
  assert.deepEqual(stopped, { processId, status: 'stopped' });
  assert.ok(originRequests.some(row => row.method === 'DELETE' && row.session === 'private-session-sentinel'));
  assert.ok(originRequests.filter(row => row.session !== undefined).length >= 4);
});

test('Worker reports denied HTTP MCP authorization as an unavailable remote server without fallback', async (t) => {
  const server = createServer((_request, response) => { response.writeHead(403).end(); });
  const port = await listenLocalServer(server);
  t.after(() => closeLocalServer(server));
  const root = await mkdtemp(join(tmpdir(), 'sprout-mcp-http-denied-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connection = await worker(root);
  t.after(() => connection.close());
  const selected = await connection.contexts.validateWorkspace({ projectId: 'project-http-denied', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const binding = {
    projectId: 'project-http-denied', environmentInstanceId: 'env-1', bindingId: 'binding-http-denied',
    generation: 1, connectionEpoch: 4, workspaceId: selected.workspaceId, kind: 'relative' as const, path: 'repo',
  };
  await connection.contexts.attachWorkspaceBinding(binding);
  await writeFile(join(root, 'repo', '.mcp.json'), JSON.stringify({ mcpServers: {
    denied: { type: 'http', url: `http://localhost:${port}/mcp`, headers: { Authorization: 'Bearer private-denied-token' } },
  } }));
  const processId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const lease = { leaseId: 'lease-http-denied', holderKind: 'run' as const, holderId: 'run-http-denied', runId: 'run-http-denied' };
  const started = await connection.contexts.startProjectMcp({ ...binding, ...lease, processId, format: 'claude-code-mcp-json-v1' });
  assert.deepEqual(started, {
    processId, status: 'blocked', reason: 'unavailable',
    servers: [{ name: 'denied', status: 'unavailable', tools: [] }],
  });
  assert.equal(JSON.stringify(started).includes('private-denied-token'), false);
  assert.deepEqual(await connection.contexts.stopProjectMcp({ ...binding, ...lease, processId }), { processId, status: 'stopped' });
});

test('Worker reports a missing MCP server dependency without exposing command configuration', async (t) => {
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
    const tools = [
      { name: 'echo', description: 'Echo the supplied text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
      { name: 'secret-check', description: 'Check the server process environment.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    ];
    const input = createInterface({ input: process.stdin });
    function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
    input.on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
      else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools } });
      else if (request.method === 'tools/call') {
        const text = request.params.name === 'secret-check'
          ? 'configured=' + process.env.MCP_FIXTURE_PRIVATE + '; inherited=' + (process.env.SPROUT_TEST_PRIVATE_TOKEN ?? 'unset')
          : request.params.arguments.text;
        send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text }] } });
      }
    });
  `;
  await writeFile(join(workerRoot, 'repo', '.mcp.json'), JSON.stringify({ mcpServers: {
    'fixture-server': { command: process.execPath, args: ['--input-type=module', '-e', serverScript], env: { MCP_FIXTURE_PRIVATE: 'private-config-value' } },
  } }));
  const lease = { leaseId: 'lease-mcp-1', holderKind: 'run' as const, holderId: 'run-mcp-1', runId: 'run-mcp-1' };
  const processId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const startInput = { ...binding, ...lease, processId, format: 'claude-code-mcp-json-v1' as const };
  const started = await connection.contexts.startProjectMcp(startInput);
  assert.equal(started.status, 'ready');
  assert.equal(started.processId, processId);
  assert.deepEqual(await connection.contexts.startProjectMcp(startInput), started, 'retry with the durable process id reuses the supervised process');
  assert.equal(started.servers.length, 1);
  assert.equal(started.servers[0]?.name, 'fixture-server');
  assert.deepEqual(started.servers[0]?.tools.map(tool => tool.name), ['echo', 'secret-check']);
  assert.equal(JSON.stringify(started).includes('private-config-value'), false);
  assert.equal(JSON.stringify(started).includes(process.execPath), false);
  assert.equal(JSON.stringify(started).includes(workerRoot), false);
  assert.equal(await readFile(join(workerRoot, 'repo', 'mcp-worker-location.txt'), 'utf8'), 'launched-in-bound-workspace');
  assert.equal(await readFile(join(hostRoot, 'mcp-worker-location.txt')).catch(() => ''), '', 'the configured host-side directory was not used');
  const toolId = started.servers[0]?.tools[0]?.id;
  assert.ok(processId);
  assert.ok(toolId);
  const operationId = '11111111-1111-4111-8111-111111111111';
  const callInput = { ...binding, ...lease, processId, operationId, toolId, arguments: { text: 'hello from Project tool' } };
  const call = await connection.contexts.callProjectMcpTool(callInput);
  assert.deepEqual(call, { processId, operationId, status: 'completed', text: 'hello from Project tool' });
  assert.deepEqual(await connection.contexts.callProjectMcpTool(callInput), call, 'retry with the same operation identity returns the bounded result without another call');
  const secretTool = started.servers[0]?.tools.find(tool => tool.name === 'secret-check');
  assert.ok(secretTool);
  const secretCheck = await connection.contexts.callProjectMcpTool({
    ...binding, ...lease, processId, operationId: '44444444-4444-4444-8444-444444444444', toolId: secretTool.id, arguments: {},
  });
  assert.deepEqual(secretCheck, {
    processId, operationId: '44444444-4444-4444-8444-444444444444', status: 'completed',
    text: 'configured=<redacted-project-mcp-secret>; inherited=unset',
  }, 'explicit MCP env secrets are redacted and Worker process secrets are not inherited');
  assert.equal(JSON.stringify(secretCheck).includes('private-config-value'), false);
  assert.equal(JSON.stringify(secretCheck).includes('worker-process-secret-sentinel'), false);
  assert.deepEqual(await connection.contexts.callProjectMcpTool({ ...callInput, arguments: { text: 'different arguments' } }),
    { processId, operationId, status: 'failed', reason: 'worker-refused' });
  const invalidOperationId = '22222222-2222-4222-8222-222222222222';
  const invalid = await connection.contexts.callProjectMcpTool({ ...binding, ...lease, processId, operationId: invalidOperationId, toolId, arguments: { text: 12 } });
  assert.deepEqual(invalid, { processId, operationId: invalidOperationId, status: 'failed', reason: 'invalid-arguments' });
  const wrongOperationId = '33333333-3333-4333-8333-333333333333';
  const wrongLease = await connection.contexts.callProjectMcpTool({ ...binding, ...lease, leaseId: 'lease-other', processId, operationId: wrongOperationId, toolId, arguments: { text: 'must not route' } });
  assert.deepEqual(wrongLease, { processId, operationId: wrongOperationId, status: 'failed', reason: 'worker-refused' });
  const stopped = await connection.contexts.stopProjectMcp({ ...binding, ...lease, processId });
  assert.deepEqual(stopped, { processId, status: 'stopped' });
});

test('Worker reports a missing MCP server dependency without exposing command configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sprout-mcp-missing-dependency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connection = await worker(root);
  t.after(() => connection.close());
  const selected = await connection.contexts.validateWorkspace({ projectId: 'missing-mcp', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const binding = {
    projectId: 'missing-mcp', environmentInstanceId: 'env-1', bindingId: 'binding-missing',
    generation: 1, connectionEpoch: 4, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo',
  } as const;
  await connection.contexts.attachWorkspaceBinding(binding);
  await writeFile(join(root, 'repo', '.mcp.json'), JSON.stringify({ mcpServers: {
    missing: { command: 'sprout-ticket-244-missing-mcp-fixture-command' },
  } }));
  const processId = '55555555-5555-4555-8555-555555555555';
  const lease = { leaseId: 'lease-missing', holderKind: 'run' as const, holderId: 'run-missing', runId: 'run-missing' };
  const started = await connection.contexts.startProjectMcp({
    ...binding, ...lease, processId, format: 'claude-code-mcp-json-v1',
  });
  assert.deepEqual(started, {
    processId, status: 'blocked', reason: 'missing',
    servers: [{ name: 'missing', status: 'missing-dependency', tools: [] }],
  });
  assert.equal(JSON.stringify(started).includes('sprout-ticket-244-missing-mcp-fixture-command'), false);
  assert.deepEqual(await connection.contexts.stopProjectMcp({ ...binding, ...lease, processId }), { processId, status: 'stopped' });
});

test('Worker retains launch and discovery failures until process termination is confirmed', async (t) => {
  for (const failure of ['launch', 'discovery'] as const) {
    const root = await mkdtemp(join(tmpdir(), `sprout-mcp-${failure}-uncertain-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = new WorkerWorkspace(root);
    const selected = await workspace.validateWorkspace({ projectId: `project-${failure}`, environmentInstanceId: 'env-uncertain', kind: 'relative', path: 'repo' });
    const binding = {
      projectId: `project-${failure}`, environmentInstanceId: 'env-uncertain', bindingId: `binding-${failure}`,
      generation: 1, connectionEpoch: 1, workspaceId: selected.workspaceId, kind: 'relative' as const, path: 'repo',
    };
    await writeFile(join(root, 'repo', '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'unused' } } }));
    let closeCalls = 0;
    let launches = 0;
    const client = {
      async discoverTools() {
        if (failure === 'discovery') throw new Error('fixture discovery failed');
        return [];
      },
      async callTool() { return {}; },
      async close() { closeCalls += 1; return closeCalls >= 3; },
    };
    const launcher: ProjectMcpClientLauncher = async (_server, _cwd, onCreated) => {
      launches += 1;
      onCreated(client);
      if (failure === 'launch') {
        await client.close();
        throw new Error('fixture initialization failed');
      }
      return client;
    };
    const supervisor = new WorkerProjectMcp(workspace, 'env-uncertain', launcher);
    await supervisor.attach(binding);
    const lease = { leaseId: `lease-${failure}`, holderKind: 'run' as const, holderId: `run-${failure}`, runId: `run-${failure}` };
    const start = { ...binding, ...lease, processId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', format: 'claude-code-mcp-json-v1' as const };
    const catalog = await supervisor.start(start);
    assert.equal(catalog.status, 'blocked', `${failure} failure is reported as unavailable`);
    assert.deepEqual(await supervisor.start(start), catalog, 'retry reuses the tracked process identity');
    assert.equal(launches, 1);
    assert.deepEqual(await supervisor.stop({ ...binding, ...lease, processId: start.processId }), { processId: start.processId, status: 'uncertain' });
    assert.equal(closeCalls, 2, 'the failed child remains tracked after its first unconfirmed close');
    assert.deepEqual(await supervisor.stop({ ...binding, ...lease, processId: start.processId }), { processId: start.processId, status: 'stopped' });
    assert.equal(closeCalls, 3, 'the same child identity remains available for confirmed cleanup');
  }
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

test('Worker edits and patches only the pinned remote Project file', async (t) => {
  const hostRoot = await mkdtemp(join(tmpdir(), 'sprout-edit-host-'));
  const workerRoot = await mkdtemp(join(tmpdir(), 'sprout-edit-worker-'));
  t.after(async () => {
    await rm(hostRoot, { recursive: true, force: true });
    await rm(workerRoot, { recursive: true, force: true });
  });
  const connection = await worker(workerRoot);
  t.after(() => connection.close());
  const hostSentinel = join(hostRoot, 'same-name.txt');
  await writeFile(hostSentinel, 'HOST_SENTINEL');
  const selected = await connection.contexts.validateWorkspace({ projectId: 'project-edit', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const remoteFile = join(workerRoot, 'repo', 'same-name.txt');
  await writeFile(remoteFile, 'remote old\nsecond line\n');
  const binding = {
    projectId: 'project-edit', environmentInstanceId: 'env-1', bindingId: 'binding-edit',
    generation: 3, connectionEpoch: 8, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo',
  } as const;
  await connection.contexts.attachWorkspaceBinding(binding);
  const { path: workspacePath, ...bindingIdentity } = binding;
  const operationBinding = { ...bindingIdentity, workspacePath };

  const edited = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'remote-edit-1', operation: 'edit', path: 'same-name.txt', oldText: 'old', newText: 'changed' });
  assert.equal(edited.status, 'completed');
  assert.equal(edited.operation, 'edit');
  assert.deepEqual(edited.changedPaths, ['same-name.txt']);
  assert.equal(await readFile(remoteFile, 'utf8'), 'remote changed\nsecond line\n');
  assert.equal(await readFile(hostSentinel, 'utf8'), 'HOST_SENTINEL');

  const patched = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'remote-patch-1', operation: 'patch', path: 'same-name.txt', hunks: [
    { before: 'remote changed', after: 'REMOTE_PROJECT_SENTINEL' },
    { before: 'second line', after: 'test passed' },
  ] });
  assert.equal(patched.status, 'completed');
  assert.deepEqual(patched.changedPaths, ['same-name.txt']);
  assert.equal(await readFile(remoteFile, 'utf8'), 'REMOTE_PROJECT_SENTINEL\ntest passed\n');
  assert.equal(await readFile(hostSentinel, 'utf8'), 'HOST_SENTINEL');

  const conflict = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'remote-patch-conflict', operation: 'patch', path: 'same-name.txt', hunks: [{ before: 'absent text', after: 'would be unsafe' }] });
  assert.equal(conflict.status, 'failed');
  assert.equal(conflict.failure, 'content-conflict');
  assert.equal(await readFile(remoteFile, 'utf8'), 'REMOTE_PROJECT_SENTINEL\ntest passed\n');
});

test('Worker operation identities replay completed edits without applying them twice and reject conflicting reuse', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sprout-edit-identity-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = new WorkerWorkspace(root);
  const selected = await workspace.validateWorkspace({ projectId: 'project-identity', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const target = join(root, 'repo', 'file.txt');
  await writeFile(target, 'before');
  const files = new WorkerWorkspaceFiles(workspace, 'env-1');
  const binding = { projectId: 'project-identity', environmentInstanceId: 'env-1', bindingId: 'binding-identity', generation: 1, connectionEpoch: 1, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo' } as const;
  await files.attach(binding);
  const { path, ...bindingIdentity } = binding;
  const request = { ...bindingIdentity, workspacePath: path, operationId: 'stable-edit-id', operation: 'edit' as const, path: 'file.txt', oldText: 'before', newText: 'after' };
  const first = await files.execute(request);
  const replay = await files.execute(request);
  assert.deepEqual(replay, first);
  const inspection = await files.inspect({ ...bindingIdentity, path, operationId: 'stable-edit-id' });
  assert.equal(inspection.status, 'completed');
  assert.deepEqual(inspection.result, first);
  assert.equal(await readFile(target, 'utf8'), 'after');
  const conflict = await files.execute({ ...request, newText: 'conflicting' });
  assert.equal(conflict.status, 'failed');
  assert.equal(conflict.failure, 'operation-identity-conflict');
  assert.equal(await readFile(target, 'utf8'), 'after');

  const restarted = new WorkerWorkspaceFiles(workspace, 'env-1');
  await restarted.attach(binding);
  const durableInspection = await restarted.inspect({ ...binding, operationId: 'stable-edit-id' });
  assert.equal(durableInspection.status, 'completed');
  assert.deepEqual(durableInspection.result, first);
  assert.deepEqual(await restarted.execute(request), first, 'the durable journal returns the known result without repeating the edit');
  assert.equal(await readFile(target, 'utf8'), 'after');
});

test('Worker recycles temporary Run context separately and preserves the persistent Project workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sprout-worker-run-context-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = new WorkerWorkspace(root);
  const selected = await workspace.validateWorkspace({ projectId: 'run-context-project', environmentInstanceId: 'env-1', kind: 'relative', path: 'repos/project' });
  const binding = { projectId: 'run-context-project', environmentInstanceId: 'env-1', bindingId: 'run-context-binding', generation: 1,
    connectionEpoch: 1, workspaceId: selected.workspaceId, kind: 'relative', path: 'repos/project' } as const;
  const persistentFile = join(root, 'repos', 'project', 'src', 'result.txt');
  await mkdir(join(root, 'repos', 'project', 'src'), { recursive: true });
  await writeFile(persistentFile, 'persistent Project result');
  const files = new WorkerWorkspaceFiles(workspace, 'env-1');
  await files.attach(binding);
  const context = { ...binding, runId: 'run-context-one' };
  assert.deepEqual(await files.prepareRunContext(context), { prepared: true });
  assert.equal(await files.inspectRunContext(context), 'present');
  const contextDirectory = join(root, '.sprout-worker-state', 'run-contexts',
    createHash('sha256').update(context.projectId).digest('hex').slice(0, 24),
    createHash('sha256').update(context.runId).digest('hex').slice(0, 24));
  assert.equal((await readFile(join(contextDirectory, 'manifest.json'), 'utf8')).includes('sprout-run-context-v1'), true);
  const scratchFile = join(contextDirectory, 'scratch.txt');
  await writeFile(scratchFile, 'temporary Run data');
  assert.equal(await files.inspectRunContext(context), 'present');
  assert.equal((await readFile(persistentFile, 'utf8')), 'persistent Project result');

  await files.recycleRunContext(context);
  assert.equal(await files.inspectRunContext(context), 'absent');
  await assert.rejects(readFile(scratchFile));
  assert.equal((await readFile(persistentFile, 'utf8')), 'persistent Project result');
});

test('Worker commands stream bounded sequenced output and cancellation remains inspectable until the process stops', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sprout-worker-command-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = new WorkerWorkspace(root);
  const selected = await workspace.validateWorkspace({ projectId: 'command-project', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const binding = { projectId: 'command-project', environmentInstanceId: 'env-1', bindingId: 'command-binding', generation: 1,
    connectionEpoch: 1, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo' } as const;
  const { path, ...bindingIdentity } = binding;
  const progress: { operationId: string; sequence: number; stream: string; text: string }[] = [];
  let cancelStartedResolve!: () => void;
  const cancelStarted = new Promise<void>(resolve => { cancelStartedResolve = resolve; });
  const streamedFiles = new WorkerWorkspaceFiles(workspace, 'env-1', chunk => {
    progress.push(chunk);
    if (chunk.operationId === 'command-cancel-1') cancelStartedResolve();
  });
  await streamedFiles.attach(binding);
  const commandRunContext = { ...binding, runId: 'command-test-run' };
  await streamedFiles.prepareRunContext(commandRunContext);
  const streamed = await streamedFiles.execute({ ...bindingIdentity, workspacePath: path, operationId: 'command-stream-1', runId: commandRunContext.runId,
    operation: 'command', executable: 'node', args: ['-e', "process.stdout.write('OUT');process.stderr.write('ERR')"], cwd: '.', timeoutMs: 5_000 });
  assert.equal(streamed.status, 'completed');
  assert.equal(streamed.exitCode, 0);
  assert.equal(streamed.output, 'OUTERR');
  assert.deepEqual(streamed.outputChunks?.map(chunk => chunk.sequence), [1, 2]);
  assert.deepEqual(progress.map(chunk => chunk.sequence), [1, 2]);
  assert.deepEqual(progress.map(chunk => chunk.stream), ['stdout', 'stderr']);

  const bounded = await streamedFiles.execute({ ...bindingIdentity, workspacePath: path, operationId: 'command-output-limit-1', runId: commandRunContext.runId,
    operation: 'command', executable: 'node', args: ['-e', "process.stdout.write('x'.repeat(50000))"], timeoutMs: 5_000 });
  assert.equal(bounded.status, 'completed');
  assert.equal(bounded.truncated, true);
  assert.equal(Buffer.byteLength(bounded.output ?? '', 'utf8'), 32 * 1024);
  assert.deepEqual(bounded.outputChunks?.map(chunk => chunk.sequence), Array.from({ length: 32 }, (_, index) => index + 1));

  const actualProjectRoot = await workspace.projectWorkingDirectory(selected.workspaceId, selected.path, selected.kind);
  const sanitized = await streamedFiles.execute({ ...bindingIdentity, workspacePath: path, operationId: 'command-sanitized-output-1',
    operation: 'command', runId: commandRunContext.runId, executable: 'node', args: ['-e', `process.stdout.write('\\u001b[31m${actualProjectRoot}/private.txt\\u001b[0m:'+process.env.SPROUT_RUN_CONTEXT+'/scratch')`], timeoutMs: 5_000 });
  assert.equal(sanitized.status, 'completed');
  assert.equal(sanitized.output, '<project>/private.txt:<run-context>/scratch');
  assert.doesNotMatch(sanitized.output ?? '', /\\u001b|sprout-worker-command-/);

  const timedOut = await streamedFiles.execute({ ...bindingIdentity, workspacePath: path, operationId: 'command-timeout-1', runId: commandRunContext.runId,
    operation: 'command', executable: 'node', args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 });
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.failure, 'command-timeout');
  assert.equal((await streamedFiles.inspect({ ...binding, operationId: 'command-timeout-1' })).status, 'failed');

  const cancellationPromise = streamedFiles.execute({ ...bindingIdentity, workspacePath: path, operationId: 'command-cancel-1', runId: commandRunContext.runId,
    operation: 'command', executable: 'node', args: ['-e', "console.log('started');setInterval(()=>{},1000)"], timeoutMs: 10_000 });
  await cancelStarted;
  const accepted = await streamedFiles.cancel({ ...binding, operationId: 'command-cancel-1' });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.status, 'cancel-requested');
  assert.equal((await streamedFiles.inspect({ ...binding, operationId: 'command-cancel-1' })).status, 'cancel-requested');
  const stopped = await cancellationPromise;
  assert.equal(stopped.status, 'cancelled');
  assert.equal((await streamedFiles.inspect({ ...binding, operationId: 'command-cancel-1' })).status, 'cancelled');
});

test('Worker reports recovery-required when cancellation cannot prove descendant settlement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sprout-worker-command-recovery-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = new WorkerWorkspace(root);
  const selected = await workspace.validateWorkspace({ projectId: 'command-recovery-project', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const binding = { projectId: 'command-recovery-project', environmentInstanceId: 'env-1', bindingId: 'command-recovery-binding', generation: 1,
    connectionEpoch: 1, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo' } as const;
  let commandStarted!: () => void;
  const started = new Promise<void>(resolve => { commandStarted = resolve; });
  const files = new WorkerWorkspaceFiles(workspace, 'env-1', chunk => {
    if (chunk.operationId === 'command-unknown-1') commandStarted();
  }, {
    groupAlive: () => true,
    signalGroup: (pid, signal) => { try { process.kill(-pid, signal); return true; } catch { return false; } },
    gracePeriodMs: 25,
  });
  await files.attach(binding);
  const commandRunContext = { ...binding, runId: 'command-recovery-run' };
  await files.prepareRunContext(commandRunContext);
  const { path, ...identity } = binding;
  const operation = files.execute({ ...identity, workspacePath: path, operationId: 'command-unknown-1', runId: commandRunContext.runId, operation: 'command', executable: 'node',
    args: ['-e', "console.log('started');setInterval(()=>{},1000)"], timeoutMs: 10_000 });
  await started;
  const cancel = await files.cancel({ ...binding, operationId: 'command-unknown-1' });
  assert.equal(cancel.accepted, true);
  assert.equal(cancel.status, 'cancel-requested');
  const result = await operation;
  assert.equal(result.status, 'recovery-required');
  assert.equal(result.failure, 'descendant-process-unknown');
  assert.equal((await files.inspect({ ...binding, operationId: 'command-unknown-1' })).status, 'recovery-required');
});

async function listenLocalServer(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local MCP fixture did not bind a TCP port');
  return address.port;
}

function closeLocalServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const PROXY_ENVIRONMENT_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'] as const;
function saveProxyEnvironment(): Record<typeof PROXY_ENVIRONMENT_KEYS[number], string | undefined> {
  return Object.fromEntries(PROXY_ENVIRONMENT_KEYS.map(key => [key, process.env[key]])) as Record<typeof PROXY_ENVIRONMENT_KEYS[number], string | undefined>;
}
function restoreProxyEnvironment(previous: Record<typeof PROXY_ENVIRONMENT_KEYS[number], string | undefined>): void {
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

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
      process.env.SPROUT_TEST_PRIVATE_TOKEN = 'worker-process-secret-sentinel';
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
