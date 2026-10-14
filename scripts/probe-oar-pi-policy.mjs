import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRuntimes } from '@botiverse/oar';

// Scripted real OAR/Pi sessions using a fixture host agent directory.
// Only reduced facts leave the temporary roots; the local provider uses an env reference.
const root = mkdtempSync(join(tmpdir(), 'sprout-oar-pi-policy-'));
const agentDir = join(root, 'host-agent');
const cwd = join(root, 'project');
const extensionDir = join(agentDir, 'extensions');
const settingsPath = join(agentDir, 'settings.json');
const piSdkEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const codemodeExtensionPath = join(dirname(piSdkEntry), 'extensions', 'codemode', 'index.js');
const receipts = Object.fromEntries(
  ['extension-loaded', 'extension-tool', 'bash', 'edit', 'write', 'powershell', 'codemode'].map(name => [name, join(root, `${name}-receipt`)]),
);
mkdirSync(extensionDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
const saved = Object.fromEntries(
  ['OAR_PI_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'SPROUT_OAR_FIXTURE_KEY', 'SPROUT_OAR_PWSH_PATH', 'SPROUT_OAR_POWERSHELL_RECEIPT', 'no_proxy', 'NO_PROXY'].map(name => [name, process.env[name]]),
);
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.OAR_PI_AGENT_DIR;
process.env.SPROUT_OAR_FIXTURE_KEY = 'fixture-only';
process.env.no_proxy = process.env.NO_PROXY = 'localhost';

let session;
let phase;
let calls;
let observation;
let timer;
const facts = { evidenceClass: 'scripted', oar: '0.59.1', node: process.versions.node, runs: {} };
const allTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell', 'codemode'];
const server = createServer(async (request, response) => {
  let input = '';
  for await (const chunk of request) input += chunk;
  const body = JSON.parse(input);
  calls++;
  observation.advertised = (body.tools ?? []).map(tool => tool.function.name).sort();
  const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'forced');
  if (result) {
    observation.resultSeen = true;
    observation.result = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    observation.denied = /not found|not available|unknown|disabled|denied|not registered/i.test(observation.result);
  }
  const { tool, args } = phase.call;
  const delta = calls === 1
    ? { role: 'assistant', tool_calls: [{ index: 0, id: 'forced', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }
    : { role: 'assistant', content: 'FIXTURE_DONE' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (value, finish_reason) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason }] });
  response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
  response.write(`data: ${JSON.stringify(chunk({}, calls === 1 ? 'tool_calls' : 'stop'))}\n\n`);
  response.end('data: [DONE]\n\n');
});

function settings(defaultTools) {
  writeFileSync(settingsPath, JSON.stringify({ defaultTools, extensions: [codemodeExtensionPath], theme: 'fixture-host' }), { mode: 0o600 });
}
function argumentsFor(name) {
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
    default: throw new Error('Unknown fixture tool');
  }
}
function resetEffects() {
  for (const name of Object.values(receipts)) rmSync(name, { force: true });
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
  try { return { result: await run(name, allTools), simulatedPowerShell }; }
  finally { restorePowerShellFixture?.(); }
}
async function run(name, defaultTools, disallowedTools = undefined) {
  settings(defaultTools);
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  resetEffects();
  phase = { name, call: { tool: name, args: argumentsFor(name) } };
  calls = 0;
  observation = { resultSeen: false, denied: false, result: '', advertised: [] };
  session = await defaultRuntimes.require('pi').session(await defaultRuntimes.require('pi').installation(), {
    cwd,
    model: 'fixture/forced',
    ...(disallowedTools ? { disallowedTools } : {}),
  });
  assert.equal(session.model?.().value, 'fixture/forced', 'Provider registered by installed host extension resolved');
  const ended = new Promise(resolve => session.events(event => {
    if (event.kind === 'turn_ended') resolve(event.outcome.kind);
  }));
  await session.prompt('Execute the forced fixture tool call.');
  const outcome = await ended;
  await session.dispose(); session = undefined;
  return { ...observation, outcome, providerRequests: calls };
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.SPROUT_OAR_PROBE_PORT), 'localhost', resolve);
  });
  const baseUrl = `http://localhost:${server.address().port}/v1`;
  writeFileSync(join(extensionDir, 'fixture.ts'), `import { writeFileSync } from 'node:fs'; export default function(pi) {
    writeFileSync(${JSON.stringify(receipts['extension-loaded'])}, 'loaded');
    pi.registerProvider('fixture', { baseUrl: ${JSON.stringify(baseUrl)}, api: 'openai-completions', apiKey: '$SPROUT_OAR_FIXTURE_KEY', models: [{ id: 'forced', name: 'Fixture model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] });
    pi.registerTool({ name: 'fixture_extension_tool', label: 'Fixture extension tool', description: 'Writes an observable receipt', parameters: { type: 'object', properties: {} }, execute: async () => {
      writeFileSync(${JSON.stringify(receipts['extension-tool'])}, 'executed'); return { content: [{ type: 'text', text: 'extension-effect' }], details: {} };
    } });
    pi.on('session_start', () => pi.setActiveTools(${JSON.stringify([...allTools, 'fixture_extension_tool'])}));
  }`, { mode: 0o600 });
  assert.equal(statSync(join(extensionDir, 'fixture.ts')).mode & 0o777, 0o600);
  facts.hostExtensionsLoaded = ['fixture.ts'];
  facts.hostExtensionTools = ['fixture_extension_tool'];
  facts.hostExtensionProviderRegistered = existsSync(join(extensionDir, 'fixture.ts'));

  for (const name of allTools) {
    const control = await runUnrestricted(name);
    const unrestricted = control.result;
    assert.equal(unrestricted.outcome, 'completed');
    assert.ok(unrestricted.resultSeen && !unrestricted.denied && unrestricted.advertised.includes(name), `${name} unrestricted call failed (denied=${unrestricted.denied}, advertised=${unrestricted.advertised.join(',')})`);
    const effectObserved = positiveEffect(name, unrestricted.result);
    assert.ok(effectObserved, `${name} unrestricted control had an observable effect`);
    facts.runs[`${name}.unrestricted`] = { advertised: unrestricted.advertised, providerVisibleResult: true, effectObserved: true, ...(control.simulatedPowerShell ? { executionFixture: 'temporary pwsh.exe shell stub' } : {}) };

    const denied = await run(name, [], ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell', 'codemode']);
    assert.equal(denied.outcome, 'completed');
    assert.ok(denied.resultSeen && denied.denied, `${name} denial reached the provider as an error`);
    assert.ok(!denied.advertised.includes(name), `${name} is absent from the restricted provider tool list`);
    assert.ok(negativeEffectAbsent(name), `${name} denied attempt had no effect`);
    facts.runs[`${name}.empty-defaults`] = { advertised: denied.advertised, providerVisibleError: true, noEffect: true };
  }

  const extension = await run('fixture_extension_tool', [], ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell', 'codemode']);
  assert.equal(extension.outcome, 'completed');
  assert.ok(extension.resultSeen && !extension.denied && extension.advertised.includes('fixture_extension_tool'));
  assert.ok(positiveEffect('fixture_extension_tool', extension.result));
  assert.ok(existsSync(receipts['extension-loaded']));
  facts.runs['fixture_extension_tool.empty-defaults'] = { advertised: extension.advertised, effectObserved: true };
  facts.hostExtensionProviderResolved = true;
  console.log(JSON.stringify(facts));
} finally {
  clearTimeout(timer);
  await session?.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
