#!/usr/bin/env node
/**
 * Research probe for installed Codex, without model inference or personal config.
 * Usage: node scripts/probe-codex-host-tool-restrictions.mjs [--codex-binary <path>]
 * Verifies config controls, detached environment selection, read-only read scope,
 * and standalone executor filesystem RPCs using disposable local files only.
 * Does not verify the model's complete tool set or native remote tool routing.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const index = process.argv.indexOf('--codex-binary');
const binary = index === -1 ? 'codex' : process.argv[index + 1];
assert.ok(binary, 'Missing --codex-binary value');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
const root = await mkdtemp(join(tmpdir(), 'sprout-codex-tools-probe-'));
const home = join(root, 'config');
const workspace = join(root, 'workspace');
await mkdir(home);
await mkdir(workspace);
const env = { ...process.env, CODEX_HOME: home };
// This probe does not require account authentication.
for (const key of Object.keys(env)) {
  if (/^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN)$/.test(key)) delete env[key];
}
const clients = [];
let executorBridge;
const bridgeChildren = new Set();
function open(args, cwd = workspace) {
  const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`RPC error ${message.error.code}`));
    else entry.resolve(message.result);
  });
  const fail = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Probe child closed before answering'));
    }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);
  const client = {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Probe timeout: ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    async close() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
        try { await exited; } finally { clearTimeout(timer); }
      }
      lines.close();
    },
  };
  clients.push(client);
  return client;
}
try {
  console.log(version);
  const app = open(['app-server', '--listen', 'stdio://', '--strict-config',
    '--disable', 'shell_tool', '--disable', 'unified_exec',
    '--disable', 'view_image', '--disable', 'multi_agent', '--disable', 'hooks']);
  await app.request('initialize', {
    clientInfo: { name: 'sprout-tool-restrictions-probe', version: '0.0.0' },
    capabilities: { experimentalApi: true },
  });
  app.notify('initialized');
  const config = await app.request('config/read', { includeLayers: false });
  for (const feature of ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'hooks']) {
    assert.equal(config.config.features[feature], false, `${feature} must be disabled`);
  }
  console.log('PASS: installed app-server accepts and reports disabled shell/image/subagent/hook controls.');
  const thread = await app.request('thread/start', {
    cwd: workspace, environments: [], sandbox: 'read-only',
    approvalPolicy: 'never', ephemeral: true,
    model: 'gpt-5.4', baseInstructions: 'Protocol probe; no model turn is requested.',
  });
  assert.ok(thread.thread.id);
  console.log('PASS: thread/start accepts an explicit empty execution-environment selection.');

  const sentinel = join(root, 'outside-workspace.txt');
  await writeFile(sentinel, 'DISPOSABLE_HOST_SENTINEL');
  const nodeBinary = await realpath(process.execPath);
  const result = await app.request('command/exec', {
    command: [nodeBinary, '-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))', sentinel],
    cwd: workspace, sandboxPolicy: { type: 'readOnly' }, timeoutMs: 5000,
  });
  if (result.stdout?.includes('DISPOSABLE_HOST_SENTINEL')) {
    console.log('OBSERVED: read-only permits reading the disposable file outside cwd; it is not workspace-only read isolation.');
  } else {
    console.log(`OBSERVED: outside-cwd read did not succeed (exit ${result.exitCode}); inspect platform enforcement separately.`);
  }

  const executor = open(['exec-server', '--listen', 'stdio://']);
  await executor.request('initialize', { clientName: 'sprout-executor-probe' });
  executor.notify('initialized');
  const file = join(workspace, 'executor-file.txt');
  const uri = pathToFileURL(file).href;
  await executor.request('fs/writeFile', {
    path: uri, dataBase64: Buffer.from('EXECUTOR_SENTINEL').toString('base64'),
  });
  const data = await executor.request('fs/readFile', { path: uri });
  assert.equal(Buffer.from(data.dataBase64, 'base64').toString(), 'EXECUTOR_SENTINEL');
  assert.equal(await readFile(file, 'utf8'), 'EXECUTOR_SENTINEL');
  console.log('PASS: standalone exec-server initializes and performs filesystem write/read RPCs.');

  // A disposable loopback bridge exercises app-server's real executor attachment.
  // Separate cwd simulates placement; it does not provide machine or OS isolation.
  const executorWorkspace = join(root, 'executor-workspace');
  await mkdir(executorWorkspace);
  executorBridge = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    executorBridge.once('listening', resolve);
    executorBridge.once('error', reject);
  });
  executorBridge.on('connection', (socket) => {
    const child = spawn(binary, ['exec-server', '--listen', 'stdio://'], {
      cwd: executorWorkspace, env, stdio: ['pipe', 'pipe', 'ignore'],
    });
    bridgeChildren.add(child);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (socket.readyState === 1) socket.send(line);
    });
    socket.on('message', (data) => child.stdin.write(`${data.toString()}\n`));
    socket.on('close', () => { child.kill('SIGTERM'); lines.close(); });
    child.on('error', () => socket.close());
    child.on('exit', () => { bridgeChildren.delete(child); socket.close(); lines.close(); });
  });
  const address = executorBridge.address();
  assert.ok(address && typeof address === 'object');
  await app.request('environment/add', {
    environmentId: 'probe-executor',
    execServerUrl: `ws://127.0.0.1:${address.port}`,
    connectTimeoutMs: 5000,
  });
  const info = await app.request('environment/info', { environmentId: 'probe-executor' });
  assert.ok(info);
  const attached = await app.request('thread/start', {
    cwd: workspace,
    environments: [{ environmentId: 'probe-executor', cwd: executorWorkspace }],
    sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
    model: 'gpt-5.4', baseInstructions: 'Protocol probe; no model turn is requested.',
  });
  assert.ok(attached.thread.id);
  console.log('PASS: app-server attaches an executor via environment/add and accepts a thread bound to its separate workspace.');
  console.log('No model turn, real remote host, or personal configuration was used.');
} finally {
  await Promise.all(clients.map((client) => client.close()));
  if (executorBridge) {
    for (const socket of executorBridge.clients) socket.terminate();
    await new Promise((resolve) => executorBridge.close(resolve));
  }
  await Promise.all([...bridgeChildren].map((child) => new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    child.once('exit', () => clearTimeout(timer));
  })));
  await rm(root, { recursive: true, force: true });
}
