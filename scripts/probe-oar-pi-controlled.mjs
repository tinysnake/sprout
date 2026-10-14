import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { defaultRuntimes } from '@botiverse/oar';
import { OarEngineAdapter } from '../src/engine/oar.ts';
import { prepareOarRuntimePolicy, assertOarRuntimePolicy } from '../src/engine/oar-runtime-policy.ts';

// Scripted production-adapter execution with a fixture host Pi configuration.
// Only reduced facts leave temporary roots; provider auth is an environment reference.
const root = mkdtempSync(join(tmpdir(), 'sprout-controlled-pi-'));
const cwd = join(root, 'project');
const agentDir = join(root, 'host-agent');
const extensionDir = join(agentDir, 'extensions');
const projectPi = join(cwd, '.pi');
const projectSettings = join(projectPi, 'settings.json');
const agentSettings = join(agentDir, 'settings.json');
const piSdkEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const codemodeExtensionPath = join(dirname(piSdkEntry), 'extensions', 'codemode', 'index.js');
const originalProject = '{ "defaultTools": ["read", "bash", "edit", "write", "codemode"], "theme": "project" }\n';
const originalAgent = JSON.stringify({ defaultTools: ['read', 'bash', 'edit', 'write', 'codemode'], extensions: [codemodeExtensionPath], theme: 'host' }) + '\n';
const receipts = Object.fromEntries(
  ['extension-loaded', 'extension-tool', 'bash', 'edit', 'write', 'powershell', 'codemode', 'stdio', 'origin'].map(name => [name, join(root, `${name}-receipt`)]),
);
for (const directory of [cwd, projectPi, extensionDir]) mkdirSync(directory, { recursive: true });
writeFileSync(projectSettings, originalProject, { mode: 0o600 });
writeFileSync(agentSettings, originalAgent, { mode: 0o600 });
const saved = Object.fromEntries(
  ['PI_CODING_AGENT_DIR', 'OAR_PI_AGENT_DIR', 'SPROUT_OAR_FIXTURE_KEY', 'SPROUT_OAR_PWSH_PATH', 'SPROUT_OAR_POWERSHELL_RECEIPT', 'no_proxy', 'NO_PROXY'].map(name => [name, process.env[name]]),
);
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.OAR_PI_AGENT_DIR;
process.env.SPROUT_OAR_FIXTURE_KEY = 'fixture-only';
process.env.no_proxy = process.env.NO_PROXY = 'localhost';

let active;
let rawSession;
let phase;
let calls;
let observation;
let runner;
let lease;
let server;
const facts = { evidenceClass: 'scripted', command: 'node scripts/probe-oar-pi-controlled.mjs', runs: {} };
const allBuiltins = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell', 'codemode'];
const httpServer = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' }).end();
    return;
  }
  let input = '';
  for await (const chunk of request) input += chunk;
  let body;
  try {
    body = JSON.parse(input);
  } catch {
    console.error(JSON.stringify({ event: 'fixture-provider-invalid-request', method: request.method, contentType: request.headers['content-type'] ?? null, bytes: Buffer.byteLength(input) }));
    response.writeHead(400).end();
    return;
  }
  calls++;
  observation.advertised = (body.tools ?? []).map(tool => tool.function.name).sort();
  const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'forced');
  if (result) {
    observation.resultSeen = true;
    observation.result = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    observation.denied = /not found|not available|unknown|disabled|denied|not registered/i.test(observation.result);
  }
  const delta = calls === 1
    ? { role: 'assistant', tool_calls: [{ index: 0, id: 'forced', type: 'function', function: { name: phase.tool, arguments: JSON.stringify(phase.args) } }] }
    : { role: 'assistant', content: 'DONE' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (value, finish_reason) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason }] });
  response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
  response.write(`data: ${JSON.stringify(chunk({}, calls === 1 ? 'tool_calls' : 'stop'))}\n\n`);
  response.end('data: [DONE]\n\n');
});

function toolArgs(name) {
  switch (name) {
    case 'bash': return { command: `touch '${receipts.bash}'` };
    case 'edit': return { path: 'edit-target.txt', edits: [{ oldText: 'before', newText: 'after' }] };
    case 'write': return { path: 'write-target.txt', content: 'written-by-tool' };
    case 'read': return { path: 'read-target.txt' };
    case 'grep': return { pattern: 'GREP_CONTROL_SENTINEL', path: 'grep-target.txt', literal: true };
    case 'find': return { pattern: 'find-target.txt', path: '.' };
    case 'ls': return { path: '.' };
    case 'powershell': return { command: `Set-Content -LiteralPath '${receipts.powershell}' -Value 'written-by-tool'` };
    case 'codemode': return { code: `await tools.bash({command: ${JSON.stringify(`touch '${receipts.codemode}'`)}}); return 'codemode-ran';` };
    case 'fixture_extension_tool': return {};
    case 'mcp__sprout_workspace__remote_read': return {};
    default: throw new Error('Unknown fixture tool');
  }
}
function resetEffects() {
  for (const path of Object.values(receipts)) rmSync(path, { force: true });
  for (const name of ['write-target.txt', 'grep-target.txt', 'find-target.txt']) rmSync(join(cwd, name), { force: true });
  writeFileSync(join(cwd, 'edit-target.txt'), 'before');
  writeFileSync(join(cwd, 'read-target.txt'), 'READ_CONTROL_SENTINEL');
  writeFileSync(join(cwd, 'grep-target.txt'), 'GREP_CONTROL_SENTINEL');
  writeFileSync(join(cwd, 'find-target.txt'), 'FIND_CONTROL_SENTINEL');
}
function positiveEffect(name, result) {
  if (name === 'read') return result.includes('READ_CONTROL_SENTINEL');
  if (name === 'grep') return result.includes('GREP_CONTROL_SENTINEL');
  if (name === 'find') return result.includes('find-target.txt');
  if (name === 'ls') return result.includes('read-target.txt');
  if (name === 'edit') return readFileSync(join(cwd, 'edit-target.txt'), 'utf8') === 'after';
  if (name === 'write') return readFileSync(join(cwd, 'write-target.txt'), 'utf8') === 'written-by-tool';
  if (name === 'fixture_extension_tool') return existsSync(receipts['extension-tool']);
  if (name === 'mcp__sprout_workspace__remote_read') return existsSync(receipts.origin);
  return existsSync(receipts[name]);
}
function negativeEffectAbsent(name) {
  if (name === 'read') return !observation.result.includes('READ_CONTROL_SENTINEL');
  if (name === 'grep') return !observation.result.includes('GREP_CONTROL_SENTINEL');
  if (name === 'find') return !observation.result.includes('find-target.txt');
  if (name === 'ls') return !observation.result.includes('read-target.txt');
  if (name === 'edit') return readFileSync(join(cwd, 'edit-target.txt'), 'utf8') === 'before';
  if (name === 'write') return !existsSync(join(cwd, 'write-target.txt'));
  return !existsSync(receipts[name]);
}
function preparePowerShellPositiveControl() {
  if (process.platform === 'win32') return () => {};
  const directory = join(root, 'fixture-bin');
  mkdirSync(directory);
  const wherePath = join(directory, 'where');
  const shellPath = join(directory, 'pwsh.exe');
  writeFileSync(wherePath, `#!/bin/sh\nprintf '%s\\n' "$SPROUT_OAR_PWSH_PATH"\n`, { mode: 0o700 });
  writeFileSync(shellPath, `#!/bin/sh\nprintf 'powershell-fixture-effect' > "$SPROUT_OAR_POWERSHELL_RECEIPT"\nprintf 'powershell-fixture-output\\n'\n`, { mode: 0o700 });
  chmodSync(wherePath, 0o700);
  chmodSync(shellPath, 0o700);
  const pathKey = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
  const previousPath = process.env[pathKey];
  const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const previousShellPath = process.env.SPROUT_OAR_PWSH_PATH;
  const previousReceipt = process.env.SPROUT_OAR_POWERSHELL_RECEIPT;
  process.env[pathKey] = [directory, previousPath].filter(Boolean).join(delimiter);
  process.env.SPROUT_OAR_PWSH_PATH = shellPath;
  process.env.SPROUT_OAR_POWERSHELL_RECEIPT = receipts.powershell;
  Object.defineProperty(process, 'platform', { ...previousPlatform, value: 'win32' });
  return () => {
    Object.defineProperty(process, 'platform', previousPlatform);
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousShellPath === undefined) delete process.env.SPROUT_OAR_PWSH_PATH;
    else process.env.SPROUT_OAR_PWSH_PATH = previousShellPath;
    if (previousReceipt === undefined) delete process.env.SPROUT_OAR_POWERSHELL_RECEIPT;
    else process.env.SPROUT_OAR_POWERSHELL_RECEIPT = previousReceipt;
  };
}
async function runUnrestricted(name) {
  const simulatedPowerShell = name === 'powershell' && process.platform !== 'win32';
  const restorePowerShellFixture = name === 'powershell' ? preparePowerShellPositiveControl() : undefined;
  try { return await runUnrestrictedSession(name, simulatedPowerShell); }
  finally { restorePowerShellFixture?.(); }
}
async function runUnrestrictedSession(name, simulatedPowerShell) {
  phase = { tool: name, args: toolArgs(name) };
  calls = 0;
  resetEffects();
  observation = { resultSeen: false, denied: false, result: '', advertised: [] };
  rawSession = await defaultRuntimes.require('pi').session(await defaultRuntimes.require('pi').installation(), {
    cwd,
    model: 'fixture/forced',
  });
  const ended = new Promise(resolve => rawSession.events(event => {
    if (event.kind === 'turn_ended') resolve(event.outcome.kind);
  }));
  await rawSession.prompt('Run the unrestricted positive-control tool call.');
  observation.outcome = await ended;
  await rawSession.dispose(); rawSession = undefined;
  assert.equal(observation.outcome, 'completed');
  assert.ok(observation.resultSeen && !observation.denied && observation.advertised.includes(name));
  const effectObserved = positiveEffect(name, observation.result);
  assert.ok(effectObserved, `${name} unrestricted control had an observable effect`);
  return { advertised: observation.advertised, providerVisibleResult: true, effectObserved: true, ...(simulatedPowerShell ? { executionFixture: 'temporary pwsh.exe shell stub' } : {}) };
}
async function runControlled(name, options = {}) {
  phase = { tool: name, args: toolArgs(name) };
  calls = 0;
  resetEffects();
  observation = { resultSeen: false, denied: false, result: '', advertised: [] };
  runner = undefined;
  const remoteProjectMcp = {
    tools: [{ name: 'remote_read', description: 'Worker-origin fixture read', inputSchema: { type: 'object', properties: {} } }],
    async call() { writeFileSync(receipts.origin, 'worker-contract-called'); return { status: 'completed', content: 'REMOTE_ORIGIN' }; },
  };
  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    piConfigurationProvider: { resolve: () => ({ agentDir }) },
    spawnProcess(command, args, spawnOptions) {
      runner = spawn(command, args, spawnOptions);
      return runner;
    },
  });
  active = await adapter.startSession({
    agentId: 'fixture',
    workingDirectory: cwd,
    model: 'fixture/forced',
    ...(options.withOrigin ? { remoteProjectMcp } : {}),
  });
  assert.ok(existsSync(receipts['extension-loaded']), 'Installed host extension loaded in the controlled session');
  assert.equal(statSync(join(extensionDir, 'fixture.ts')).mode & 0o777, 0o600);
  assert.equal(statSync(join(projectPi, 'mcp.json')).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(agentSettings, 'utf8')).defaultTools, []);
  assert.deepEqual(JSON.parse(readFileSync(projectSettings, 'utf8')).defaultTools, []);
  assert.equal(statSync(agentSettings).mode & 0o777, 0o600);
  assert.equal(statSync(projectSettings).mode & 0o777, 0o600);
  assert.equal(statSync(join(agentDir, '.sprout-oar-policy', 'settings.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(projectPi, '.sprout-oar-policy', 'settings.json')).mode & 0o777, 0o600);
  const turn = active.run('Execute the forced fixture tool call.');
  const drain = (async () => { try { for await (const _event of turn.events) {} } catch {} })();
  observation.outcome = (await turn.completion).status;
  await drain;
  assert.equal(observation.outcome, 'completed');
  assert.ok(calls >= 2 && observation.resultSeen);
  if (options.killRunner) {
    const exited = once(runner, 'exit');
    runner.kill('SIGKILL');
    await exited;
  }
  await active.close(); active = undefined;
  assert.equal(readFileSync(projectSettings, 'utf8'), originalProject);
  assert.equal(readFileSync(agentSettings, 'utf8'), originalAgent);
  assert.equal(existsSync(join(projectPi, '.sprout-oar-policy')), false);
  assert.equal(existsSync(join(agentDir, '.sprout-oar-policy')), false);
  return { advertised: observation.advertised, resultSeen: observation.resultSeen, denied: observation.denied, outcome: observation.outcome };
}

try {
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(Number(process.env.SPROUT_OAR_PROBE_PORT), 'localhost', resolve);
  });
  const baseUrl = `http://localhost:${httpServer.address().port}/v1`;
  writeFileSync(join(extensionDir, 'fixture.ts'), `import { writeFileSync } from 'node:fs'; export default function(pi) {
    writeFileSync(${JSON.stringify(receipts['extension-loaded'])}, 'loaded');
    pi.registerProvider('fixture', { baseUrl: ${JSON.stringify(baseUrl)}, api: 'openai-completions', apiKey: '$SPROUT_OAR_FIXTURE_KEY', models: [{ id: 'forced', name: 'Fixture model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] });
    pi.registerTool({ name: 'fixture_extension_tool', label: 'Fixture extension tool', description: 'Writes an observable receipt', parameters: { type: 'object', properties: {} }, execute: async () => {
      writeFileSync(${JSON.stringify(receipts['extension-tool'])}, 'executed'); return { content: [{ type: 'text', text: 'extension-effect' }], details: {} };
    } });
    pi.on('session_start', () => pi.setActiveTools(${JSON.stringify([...allBuiltins, 'fixture_extension_tool'])}));
  }`, { mode: 0o600 });
  const installation = await defaultRuntimes.require('pi').installation();
  assert.equal(installation.kind, 'available');
  const hostExtensionInventory = ['fixture.ts'];
  facts.hostExtensionsLoaded = hostExtensionInventory;
  facts.hostExtensionTools = ['fixture_extension_tool'];
  facts.hostModelProvider = 'fixture';

  const stdio = {
    name: 'unapproved',
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(receipts.stdio)}, 'executed')`],
  };
  writeFileSync(join(projectPi, 'mcp.json'), JSON.stringify({ mcpServers: { unapproved: stdio } }), { mode: 0o600 });

  // The unrestricted arm proves each forced built-in call can succeed in this fixture.
  for (const name of allBuiltins) facts.runs[`${name}.unrestricted`] = await runUnrestricted(name);

  // The production adapter's shared policy empties both Pi default-tool layers.
  for (const name of allBuiltins) {
    const denied = await runControlled(name);
    assert.ok(denied.resultSeen && denied.denied, `${name} denial was visible to the provider`);
    assert.ok(!denied.advertised.includes(name), `${name} was not advertised`);
    assert.ok(negativeEffectAbsent(name), `${name} denied attempt had no effect`);
    facts.runs[`${name}.empty-defaults`] = { advertised: denied.advertised, providerVisibleError: true, noEffect: true };
  }

  const extensionRun = await runControlled('fixture_extension_tool');
  assert.ok(extensionRun.advertised.includes('fixture_extension_tool'));
  assert.ok(!observation.denied && positiveEffect('fixture_extension_tool', observation.result));
  facts.runs['fixture_extension_tool.empty-defaults'] = { advertised: extensionRun.advertised, effectObserved: true };
  facts.hostExtensionProviderResolved = true;

  const origin = await runControlled('mcp__sprout_workspace__remote_read', { withOrigin: true, killRunner: true });
  assert.ok(origin.advertised.includes('mcp__sprout_workspace__remote_read'));
  assert.ok(!origin.denied && existsSync(receipts.origin));
  facts.workerOriginMcpContractToolExecuted = true;
  facts.forcedRunnerSigkillRestoredSettings = true;

  // A genuinely supplied stdio entry is rejected by the runner guard before OAR opens it.
  lease = prepareOarRuntimePolicy('pi', cwd, { agentDir });
  try {
    const options = { cwd: lease.descriptor.cwd, mcpServers: [stdio], disallowedTools: lease.descriptor.disallowedTools };
    assert.throws(() => assertOarRuntimePolicy('pi', options, lease.descriptor), /route is blocked/);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/engine/oar-runner-entry.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    const response = once(lines, 'line');
    const closed = once(child, 'close');
    try {
      child.stdin.write(`${JSON.stringify({ op: 'start', runtimeId: 'pi', options, hostPolicy: { pi: lease.descriptor } })}\n`);
      const [line] = await response;
      const message = JSON.parse(line);
      assert.equal(message.kind, 'error');
      assert.match(message.message, /route is blocked/);
    } finally { lines.close(); child.kill('SIGKILL'); await closed; }
    assert.equal(existsSync(receipts.stdio), false);
    facts.explicitStdioRejectedBeforeOpen = true;
  } finally { lease.close(); lease = undefined; }
  assert.equal(readFileSync(projectSettings, 'utf8'), originalProject);
  assert.equal(readFileSync(agentSettings, 'utf8'), originalAgent);
  facts.projectAndHostSettingsRestoredExactly = true;
  facts.extensionToolWasVisibleUnderEmptyDefaults = true;
  facts.evidenceLimit = 'Scripted provider and RemoteProjectMcpTools fixture; not a model-issued enrolled Worker turn.';
  console.log(JSON.stringify(facts));
} finally {
  await active?.close();
  await rawSession?.dispose();
  lease?.close();
  httpServer.closeAllConnections();
  await new Promise(resolve => httpServer.close(resolve));
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
