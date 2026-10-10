import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CLAUDE_CODE_AUTHORIZED_MODEL,
  HostClaudeEngineAdapter,
  hostClaudeIsolationProfileForTest,
  type HostClaudeLaunchInput,
} from './claude-host.ts';
import type { RemoteWorkspaceTools, StartSessionRequest } from './port.ts';

function settings(path: string, values: { readonly model?: string; readonly effortLevel?: string; readonly token?: string } = {}): void {
  writeFileSync(path, JSON.stringify({
    model: values.model ?? CLAUDE_CODE_AUTHORIZED_MODEL,
    effortLevel: values.effortLevel ?? 'high',
    env: {
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      ...(values.token === undefined ? { ANTHROPIC_AUTH_TOKEN: 'synthetic-auth-material' } : { ANTHROPIC_AUTH_TOKEN: values.token }),
    },
  }), { mode: 0o600 });
}

function request(): StartSessionRequest {
  const tools: RemoteWorkspaceTools = {
    binding: { projectId: 'project', environmentInstanceId: 'environment', bindingId: 'binding', generation: 1,
      connectionEpoch: 1, workspaceId: 'workspace', kind: 'default' },
    operations: ['read'],
    async read(path, operationId) {
      assert.equal(path, 'remote.txt');
      assert.match(operationId ?? '', /^[0-9a-f-]{36}$/);
      return { operationId: operationId ?? 'missing', projectId: 'project', environmentInstanceId: 'environment',
        bindingId: 'binding', generation: 1, connectionEpoch: 1, workspaceId: 'workspace', operation: 'read',
        status: 'completed', path, content: 'REMOTE_CONTENT' };
    },
    async search() { throw new Error('not exposed'); },
    async inspect() { return { status: 'unknown' }; },
    async cancel() { return { accepted: false, status: 'unknown' }; },
  };
  return { agentId: 'claude-agent', workingDirectory: '/remote/working-directory', model: CLAUDE_CODE_AUTHORIZED_MODEL,
    effort: 'high', remoteWorkspace: tools, instructions: 'Use only authorized remote tools.' };
}

function fakeCliScript(): string {
  return String.raw`
const fs = require('node:fs');
const net = require('node:net');
let input = '';
process.stdin.on('data', chunk => input += chunk.toString());
process.stdin.on('end', async () => {
  const args = process.argv.slice(1);
  const configPath = args[args.indexOf('--mcp-config') + 1];
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const socketPath = config.mcpServers.sprout.args[1];
  const socket = net.createConnection(socketPath);
  let buffer = '';
  let nextId = 1;
  const waiting = new Map();
  socket.on('data', chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const reply = JSON.parse(line);
      const resolve = waiting.get(reply.id);
      if (resolve) { waiting.delete(reply.id); resolve(reply); }
    }
  });
  const rpc = (method, params) => new Promise(resolve => {
    const id = nextId++;
    waiting.set(id, resolve);
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await new Promise(resolve => socket.once('connect', resolve));
  await rpc('initialize', { protocolVersion: '2025-03-26' });
  const catalog = await rpc('tools/list', {});
  const names = catalog.result.tools.map(tool => 'mcp__sprout__' + tool.name);
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native-claude-session', tools: names,
    mcp_servers: [{ name: 'sprout', status: 'connected' }] }) + '\n');
  const called = await rpc('tools/call', { name: 'workspace_read', arguments: { path: 'remote.txt' } });
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: names[0] }] } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: called.result.content }] } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Remote read complete.', usage: { input_tokens: 7, output_tokens: 3 } }) + '\n');
  socket.end();
});
`;
}

test('Host Claude reads and refuses the exact user-configured model without inferring a replacement', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  settings(settingsPath);
  let spawned = 0;
  const adapter = new HostClaudeEngineAdapter({
    binaryPath: '/usr/bin/true', settingsPath, runnerRoot: join(directory, 'runner'),
    probeProcess: async input => ({ profileId: input.profileId, engine: 'claude', status: 'ready', installation: 'ready',
      authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '2.1.294',
      resolvedModel: CLAUDE_CODE_AUTHORIZED_MODEL, supportedEfforts: ['high'], observedAt: 1 }),
    spawnProcess: () => { spawned += 1; throw new Error('must not spawn for refused settings'); },
  });
  const refusedModel = await adapter.startSession({ ...request(), model: 'substitute/model' }).then(() => false, () => true);
  assert.equal(refusedModel, true);
  settings(settingsPath, { model: 'changed/model' });
  const refusedConfig = await adapter.startSession(request()).then(() => false, () => true);
  assert.equal(refusedConfig, true);
  settings(settingsPath, { token: '' });
  const refusedAuth = await adapter.startSession(request()).then(() => false, () => true);
  assert.equal(refusedAuth, true);
  assert.equal(spawned, 0);
});

test('Host Claude maps probe exceptions to bounded readiness facts without retaining raw text', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-readiness-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adapter = new HostClaudeEngineAdapter({
    runnerRoot: join(directory, 'runner'),
    probeProcess: async () => { throw new Error('synthetic token endpoint private path'); },
  });
  const readiness = await adapter.readiness(true);
  assert.equal(readiness.status, 'unavailable');
  assert.deepEqual(readiness.probeFailure, { step: 'read user configuration', reason: 'probe error' });
  assert.doesNotMatch(JSON.stringify(readiness), /synthetic|token|endpoint|private path/);
});

test('Host Claude bridges only typed Environment tools and translates native stream events and usage', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-session-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  settings(settingsPath);
  let remoteReads = 0;
  const requested = request();
  const workspace = requested.remoteWorkspace!;
  const guardedWorkspace: RemoteWorkspaceTools = { ...workspace, async read(path, operationId) {
    remoteReads += 1;
    return workspace.read(path, operationId);
  } };
  const adapter = new HostClaudeEngineAdapter({
    binaryPath: '/usr/bin/true', settingsPath, runnerRoot: join(directory, 'runner'),
    probeProcess: async input => ({ profileId: input.profileId, engine: 'claude', status: 'ready', installation: 'ready',
      authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '2.1.294',
      resolvedModel: CLAUDE_CODE_AUTHORIZED_MODEL, supportedEfforts: ['high'], observedAt: 1 }),
    spawnProcess: (_input, args) => {
      assert.ok(args.includes('--bare'));
      assert.ok(args.includes('--strict-mcp-config'));
      assert.ok(args.includes('--tools'));
      assert.ok(args.includes(''));
      assert.equal(args[args.indexOf('--model') + 1], CLAUDE_CODE_AUTHORIZED_MODEL);
      assert.equal(args[args.indexOf('--effort') + 1], 'high');
      assert.ok(!args.some(arg => ['Bash', 'Read', 'Write', 'Edit'].includes(arg)));
      return spawn(process.execPath, ['-e', fakeCliScript(), '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
  });
  const session = await adapter.startSession({ ...requested, remoteWorkspace: guardedWorkspace });
  try {
    const turn = session.run('Read the remote fixture.');
    const observed: string[] = [];
    const drain = (async () => { for await (const event of turn.events) observed.push(event.type); })();
    const result = await turn.completion;
    await drain;
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    assert.equal(result.text, 'Remote read complete.');
    assert.deepEqual(result.tokenUsage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    assert.equal(session.engineSessionKey, 'native-claude-session');
    assert.equal(remoteReads, 1, 'the native MCP call crossed the typed Environment capability once');
    assert.ok(observed.includes('tool-call'));
    assert.ok(observed.includes('tool-output'));
    assert.ok(observed.includes('message'));
  } finally { await session.close(); }
});

test('Host Claude rejects a reported builtin or unexpected remote tool catalog', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  settings(settingsPath);
  const adapter = new HostClaudeEngineAdapter({
    binaryPath: '/usr/bin/true', settingsPath, runnerRoot: join(directory, 'runner'),
    probeProcess: async input => ({ profileId: input.profileId, engine: 'claude', status: 'ready', installation: 'ready',
      authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '2.1.294',
      resolvedModel: CLAUDE_CODE_AUTHORIZED_MODEL, supportedEfforts: ['high'], observedAt: 1 }),
    spawnProcess: (_input, args) => spawn(process.execPath, ['-e', fakeCliScript().replace("const names = catalog.result.tools.map(tool => 'mcp__sprout__' + tool.name);", "const names = [...catalog.result.tools.map(tool => 'mcp__sprout__' + tool.name), 'Bash'];"), '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  const session = await adapter.startSession(request());
  try {
    const turn = session.run('Do not run local work.');
    const result = await turn.completion;
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.match(result.message, /controls could not be verified/);
  } finally { await session.close(); }
});

test('Host Claude Seatbelt profile blocks host sentinel reads and writes while allowing its runner', { skip: process.platform !== 'darwin' }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-isolation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agentRoot = join(directory, 'runner');
  const controlRoot = join(directory, 'control');
  mkdirSync(agentRoot); mkdirSync(controlRoot);
  const settingsPath = join(directory, 'user-settings.json');
  const sentinel = join(directory, 'host-sentinel.txt');
  settings(settingsPath);
  writeFileSync(sentinel, 'UNCHANGED');
  const input: HostClaudeLaunchInput = {
    profileId: 'test-profile', binaryPath: '/usr/bin/true', settingsPath, runnerRoot: directory,
    clock: Date.now, agentId: 'test-agent', agentRoot, controlRoot,
    settings: { model: CLAUDE_CODE_AUTHORIZED_MODEL, effortLevel: 'high', baseUrl: 'https://example.invalid', hasAuthToken: true },
  };
  const profile = hostClaudeIsolationProfileForTest(input);
  const script = `const fs=require('node:fs');const p=require('node:path');let hr=false,hw=false,aw=false;try{fs.readFileSync(process.argv[1])}catch(e){hr=['EPERM','EACCES'].includes(e.code)}try{fs.writeFileSync(process.argv[1],'CHANGED')}catch(e){hw=['EPERM','EACCES'].includes(e.code)}try{fs.writeFileSync(process.argv[2],'CHANGED')}catch(e){aw=['EPERM','EACCES'].includes(e.code)}fs.writeFileSync(p.join(process.argv[3],'runner-check.txt'),'OK');process.stdout.write(JSON.stringify({hr,hw,aw,runner:true}))`;
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', script, sentinel, settingsPath, agentRoot], {
    encoding: 'utf8', timeout: 10_000, cwd: agentRoot, env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `sandbox exit: ${result.signal ?? 'none'}; ${result.stderr.replaceAll(directory, '<tmp>').slice(0, 400)}`);
  assert.deepEqual(JSON.parse(result.stdout), { hr: true, hw: true, aw: true, runner: true });
  assert.equal(readFileSync(sentinel, 'utf8'), 'UNCHANGED');
});
