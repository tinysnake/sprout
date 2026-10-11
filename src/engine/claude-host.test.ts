import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

import {
  CLAUDE_CODE_AUTHORIZED_MODEL,
  HostClaudeEngineAdapter,
  hostClaudeIsolationProfileForTest,
  type HostClaudeLaunchInput,
} from './claude-host.ts';
import type { AgentRunEvent, RemoteWorkspaceTools, StartSessionRequest } from './port.ts';

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

function request(remoteContent = 'REMOTE_CONTENT'): StartSessionRequest {
  const tools: RemoteWorkspaceTools = {
    binding: { projectId: 'project', environmentInstanceId: 'environment', bindingId: 'binding', generation: 1,
      connectionEpoch: 1, workspaceId: 'workspace', kind: 'default' },
    operations: ['read'],
    async read(path, operationId) {
      assert.equal(path, 'remote.txt');
      assert.match(operationId ?? '', /^[0-9a-f-]{36}$/);
      return { operationId: operationId ?? 'missing', projectId: 'project', environmentInstanceId: 'environment',
        bindingId: 'binding', generation: 1, connectionEpoch: 1, workspaceId: 'workspace', operation: 'read',
        status: 'completed', path, content: remoteContent };
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
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'safe assistant before api_key=synthetic-secret endpoint https://gateway.invalid:4312 hostname buildbox-7 path /Users/worker/private.txt after' }] } }) + '\n');
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

test('Claude auth helper only returns the credential whose pinned settings still match', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-auth-helper-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  const pinPath = join(directory, 'auth-pin.json');
  const configured = {
    model: CLAUDE_CODE_AUTHORIZED_MODEL, effortLevel: 'high',
    env: { ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_AUTH_TOKEN: 'synthetic-auth-material' },
  };
  const fingerprint = createHash('sha256').update(JSON.stringify({
    model: configured.model, effortLevel: configured.effortLevel,
    baseUrl: configured.env.ANTHROPIC_BASE_URL, authToken: configured.env.ANTHROPIC_AUTH_TOKEN,
  })).digest('hex');
  writeFileSync(settingsPath, JSON.stringify(configured));
  writeFileSync(pinPath, JSON.stringify({ model: configured.model, effortLevel: configured.effortLevel,
    baseUrl: configured.env.ANTHROPIC_BASE_URL, authorizationFingerprint: fingerprint }));
  const helper = new URL('./claude-auth-helper.mjs', import.meta.url);
  const accepted = spawnSync(process.execPath, [helper.pathname, settingsPath, pinPath], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(accepted.status, 0);
  assert.equal(accepted.stdout, configured.env.ANTHROPIC_AUTH_TOKEN);
  configured.env.ANTHROPIC_AUTH_TOKEN = 'changed-synthetic-auth-material';
  writeFileSync(settingsPath, JSON.stringify(configured));
  const refused = spawnSync(process.execPath, [helper.pathname, settingsPath, pinPath], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, '');
});

test('Host Claude maps probe exceptions to bounded readiness facts without retaining raw text', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-readiness-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  settings(settingsPath);
  const adapter = new HostClaudeEngineAdapter({
    binaryPath: '/usr/bin/true', settingsPath, runnerRoot: join(directory, 'runner'),
    probeProcess: async () => { throw new Error('synthetic token endpoint private path'); },
  });
  const readiness = await adapter.readiness(true);
  assert.equal(readiness.status, 'unavailable');
  assert.deepEqual(readiness.probeFailure, { step: 'read user configuration', reason: 'probe error' });
  assert.doesNotMatch(JSON.stringify(readiness), /synthetic|token|endpoint|private path/);
});

test('Host Claude refuses a changed account configuration after readiness has been accepted', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-config-pin-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  settings(settingsPath);
  const adapter = new HostClaudeEngineAdapter({
    binaryPath: '/usr/bin/true', settingsPath, runnerRoot: join(directory, 'runner'),
    probeProcess: async input => ({ profileId: input.profileId, engine: 'claude', status: 'ready', installation: 'ready',
      authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '2.1.294',
      resolvedModel: CLAUDE_CODE_AUTHORIZED_MODEL, supportedEfforts: ['high'], observedAt: 1 }),
  });
  assert.equal((await adapter.readiness(true)).status, 'ready');
  settings(settingsPath, { token: 'different-synthetic-auth-material' });
  const changed = await adapter.readiness(true);
  assert.equal(changed.status, 'unavailable');
  assert.deepEqual(changed.probeFailure, { step: 'verify authentication configuration', reason: 'configuration changed' });
  assert.doesNotMatch(JSON.stringify(changed), /synthetic-auth-material|different-synthetic/);
});

test('Host Claude bridges only typed Environment tools and translates native stream events and usage', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-session-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  settings(settingsPath);
  const binaryDirectory = join(directory, 'bin');
  mkdirSync(binaryDirectory);
  const binaryPath = join(binaryDirectory, 'claude');
  writeFileSync(binaryPath, 'synthetic CLI executable\n', { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaryDirectory}${delimiter}${previousPath ?? ''}`;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  let remoteReads = 0;
  const resumeKeys: (string | undefined)[] = [];
  const requested = request();
  const workspace = requested.remoteWorkspace!;
  const guardedWorkspace: RemoteWorkspaceTools = { ...workspace, async read(path, operationId) {
    remoteReads += 1;
    return workspace.read(path, operationId);
  } };
  const adapter = new HostClaudeEngineAdapter({
    binaryPath: 'claude', settingsPath, runnerRoot: join(directory, 'runner'),
    probeProcess: async input => ({ profileId: input.profileId, engine: 'claude', status: 'ready', installation: 'ready',
      authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '2.1.294',
      resolvedModel: CLAUDE_CODE_AUTHORIZED_MODEL, supportedEfforts: ['high'], observedAt: 1 }),
    spawnProcess: (input, args) => {
      resumeKeys.push(args.includes('--resume') ? args[args.indexOf('--resume') + 1] : undefined);
      assert.equal(input.binaryPath, realpathSync(binaryPath), 'a bare CLI name resolves before launch');
      assert.ok(args.includes('--bare'));
      assert.ok(args.includes('--strict-mcp-config'));
      assert.ok(args.includes('--tools'));
      assert.ok(args.includes(''));
      const invocationSettings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1]!, 'utf8')) as { readonly model: string; readonly effortLevel: string };
      assert.equal(invocationSettings.model, CLAUDE_CODE_AUTHORIZED_MODEL, 'the CLI receives the model projected from its own user settings');
      assert.equal(invocationSettings.effortLevel, 'high');
      assert.equal(args.includes('--model'), false, 'the adapter does not override Claude Code model selection');
      assert.equal(args.includes('--effort'), false, 'the adapter does not override Claude Code effort selection');
      assert.ok(!args.some(arg => ['Bash', 'Read', 'Write', 'Edit'].includes(arg)));
      return spawn(process.execPath, ['-e', fakeCliScript(), '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
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
    const resumed = session.run('Continue the same authorized remote session.');
    const resumedResult = await resumed.completion;
    assert.equal(resumedResult.status, 'completed');
    assert.deepEqual(resumeKeys, [undefined, 'native-claude-session']);
    assert.equal(remoteReads, 2, 'both turns use the typed Environment capability');
    assert.ok(observed.includes('tool-call'));
    assert.ok(observed.includes('tool-output'));
    assert.ok(observed.includes('message'));
  } finally { await session.close(); }
});

test('Host Claude sanitizes assistant text and remote tool results before live events and final results', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-output-privacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  settings(settingsPath);
  const binaryDirectory = join(directory, 'bin');
  mkdirSync(binaryDirectory);
  const binaryPath = join(binaryDirectory, 'claude');
  writeFileSync(binaryPath, 'synthetic CLI executable\\n', { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaryDirectory}${delimiter}${previousPath ?? ''}`;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  const assistantMarkers = 'api_key=synthetic-secret endpoint https://gateway.invalid:4312 hostname buildbox-7 path /Users/worker/private.txt';
  const toolMarkers = 'token=remote-secret https://remote.invalid:8443 node-12 /private/remote/secret.txt';
  const remoteWorkspace = request(`safe tool before ${toolMarkers} after`).remoteWorkspace!;
  const script = fakeCliScript()
    .replace('api_key=synthetic-secret endpoint https://gateway.invalid:4312 hostname buildbox-7 path /Users/worker/private.txt', assistantMarkers)
    .replace("'Remote read complete.'", JSON.stringify(`safe final before ${assistantMarkers} after`));
  const adapter = new HostClaudeEngineAdapter({
    binaryPath: 'claude', settingsPath, runnerRoot: join(directory, 'runner'),
    probeProcess: async input => ({ profileId: input.profileId, engine: 'claude', status: 'ready', installation: 'ready',
      authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '2.1.294',
      resolvedModel: CLAUDE_CODE_AUTHORIZED_MODEL, supportedEfforts: ['high'], observedAt: 1 }),
    spawnProcess: (_input, args) => spawn(process.execPath, ['-e', script, '--', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    }),
  });
  const session = await adapter.startSession({ ...request(), remoteWorkspace });
  try {
    const turn = session.run('Read one authorized remote file.');
    const eventDrain = (async () => {
      const events: AgentRunEvent[] = [];
      for await (const event of turn.events) events.push(event);
      return events;
    })();
    const result = await turn.completion;
    const events = await eventDrain;
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    const serialized = JSON.stringify({ events, result });
    for (const marker of ['synthetic-secret', 'gateway.invalid', 'buildbox-7', '/Users/worker/private.txt',
      'remote-secret', 'remote.invalid', 'node-12', '/private/remote/secret.txt']) {
      assert.ok(!serialized.includes(marker), `sensitive marker survived live Claude output: ${marker}`);
    }
    assert.ok(events.some(event => event.type === 'message' && event.text.includes('safe assistant before')));
    assert.ok(events.some(event => event.type === 'message' && event.text.includes('after')));
    assert.ok(events.some(event => event.type === 'tool-output' && event.text.includes('safe tool before')));
    assert.ok(events.some(event => event.type === 'tool-output' && event.text.includes('after')));
    assert.ok(result.text.includes('safe final before'));
    assert.ok(result.text.includes('after'));
  } finally { await session.close(); }
});

test('Host Claude reports an explicit stale native session refusal for the shared fresh-session fallback', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-claude-resume-refused-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  settings(settingsPath);
  const adapter = new HostClaudeEngineAdapter({
    binaryPath: '/usr/bin/true', settingsPath, runnerRoot: join(directory, 'runner'),
    probeProcess: async input => ({ profileId: input.profileId, engine: 'claude', status: 'ready', installation: 'ready',
      authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '2.1.294',
      resolvedModel: CLAUDE_CODE_AUTHORIZED_MODEL, supportedEfforts: ['high'], observedAt: 1 }),
    spawnProcess: (_input, args) => {
      assert.equal(args[args.indexOf('--resume') + 1], 'stale-native-session');
      return spawn(process.execPath, ['-e', "process.stderr.write('No conversation found for session.'); process.exit(1);"], {
        stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      });
    },
  });
  const session = await adapter.startSession({ ...request(), resumeSessionKey: 'stale-native-session' });
  try {
    const result = await session.run('Continue the prior session.').completion;
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.resumeRefused, true);
      assert.equal(result.message, 'Claude Code refused the requested native session');
    }
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
    settings: { model: CLAUDE_CODE_AUTHORIZED_MODEL, effortLevel: 'high', baseUrl: 'https://example.invalid', hasAuthToken: true, authorizationFingerprint: 'test-only' },
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
