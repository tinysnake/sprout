import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { defaultRuntimes } from '@botiverse/oar';
import { OarEngineAdapter } from '../src/engine/oar.ts';
import { prepareOarRuntimePolicy, assertOarRuntimePolicy } from '../src/engine/oar-runtime-policy.ts';

// Scripted real OAR/Pi execution. Only reduced facts leave the temporary roots.
const root = mkdtempSync(join(tmpdir(), 'sprout-controlled-pi-'));
const cwd = join(root, 'project');
const ambient = join(root, 'ambient');
const receipts = Object.fromEntries(['loaded', 'extension', 'bash', 'stdio', 'origin'].map(name => [name, join(root, name)]));
for (const directory of [cwd, ambient, join(cwd, '.pi', 'extensions')]) mkdirSync(directory, { recursive: true });
const settings = join(cwd, '.pi', 'settings.json');
const original = '{ "theme": "dark" }\n';
writeFileSync(settings, original);
writeFileSync(join(cwd, '.pi', 'extensions', 'receipt.ts'), `import { writeFileSync } from 'node:fs'; export default function(pi) {
  writeFileSync(${JSON.stringify(receipts.loaded)}, 'loaded');
  pi.registerTool({ name: 'unapproved_tool', label: 'Unapproved fixture', description: 'Create fixture receipt',
    parameters: { type: 'object', properties: {} }, execute: async () => {
      writeFileSync(${JSON.stringify(receipts.extension)}, 'executed'); return { content: [{ type: 'text', text: 'effect' }], details: {} };
    } });
}`);
let phase;
let calls;
let observation;
let active;
let rawSession;
const savedPin = process.env.OAR_PI_AGENT_DIR;
const savedProxy = [process.env.no_proxy, process.env.NO_PROXY];
process.env.no_proxy = process.env.NO_PROXY = 'localhost';
const facts = { evidenceClass: 'scripted', command: 'node scripts/probe-oar-pi-controlled.mjs', runs: {} };
const server = createServer(async (request, response) => {
  let input = ''; for await (const chunk of request) input += chunk;
  const body = JSON.parse(input);
  calls++;
  observation.providerRequests = calls;
  observation.advertised = (body.tools ?? []).map(tool => tool.function.name).sort();
  const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'forced');
  if (result) {
    observation.resultSeen = true;
    observation.denied = /not found|not available|unknown|disabled|denied/i.test(String(result.content));
  }
  const name = phase.includes('extension') ? 'unapproved_tool' : phase.includes('origin') ? 'mcp__sprout_workspace__remote_read' : 'bash';
  const args = name === 'bash' ? { command: `touch '${receipts.bash}'` } : {};
  const delta = calls === 1
    ? { role: 'assistant', tool_calls: [{ index: 0, id: 'forced', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    : { role: 'assistant', content: 'DONE' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] });
  response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
  response.write(`data: ${JSON.stringify(chunk({}, calls === 1 ? 'tool_calls' : 'stop'))}\n\n`);
  response.end('data: [DONE]\n\n');
});
const deadline = setTimeout(() => { console.log(JSON.stringify({ evidenceClass: 'scripted', incomplete: true })); process.exit(2); }, 110000);
try {
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  const models = { providers: { fixture: { baseUrl: `http://localhost:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic-fixture', models: [{ id: 'forced', reasoning: false, contextWindow: 8192, maxTokens: 1024 }] } } };
  writeFileSync(join(ambient, 'models.json'), JSON.stringify(models));
  process.env.OAR_PI_AGENT_DIR = ambient;
  const runtime = defaultRuntimes.require('pi');
  const installation = await runtime.installation();
  assert.equal(installation.kind, 'available');
  async function positive(name) {
    phase = name; calls = 0; observation = { resultSeen: false, denied: false };
    rawSession = await runtime.session(installation, { cwd, model: 'fixture/forced' });
    const ended = new Promise(resolve => rawSession.events(event => { if (event.kind === 'turn_ended') resolve(event.outcome.kind); }));
    await rawSession.prompt('Execute the forced fixture call.');
    observation.outcome = await ended; // Do not dispose on prompt acceptance.
    assert.equal(observation.outcome, 'completed');
    assert.ok(calls >= 2 && observation.resultSeen && !observation.denied, JSON.stringify({ name, calls, ...observation }));
    await rawSession.dispose(); rawSession = undefined;
    facts.runs[name] = { ...observation };
  }
  await positive('unrestricted-extension');
  assert.ok(existsSync(receipts.loaded) && existsSync(receipts.extension));
  await positive('unrestricted-bash');
  assert.ok(existsSync(receipts.bash));
  for (const key of ['loaded', 'extension', 'bash']) rmSync(receipts[key], { force: true });
  // Ambient MCP config is also present while the controlled route runs.
  const stdio = { name: 'unapproved', command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(receipts.stdio)}, 'executed')`] };
  writeFileSync(join(cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { unapproved: stdio } }));
  const remoteProjectMcp = {
    tools: [{ name: 'remote_read', description: 'Worker-origin fixture read', inputSchema: { type: 'object', properties: {} } }],
    async call() { writeFileSync(receipts.origin, 'worker-contract-called'); return { status: 'completed', content: 'REMOTE_ORIGIN' }; },
  };
  async function controlled(name, withOrigin) {
    phase = name; calls = 0; observation = { resultSeen: false, denied: false };
    let runner;
    const adapter = new OarEngineAdapter({ runtimeId: 'pi', piModels: models, spawnProcess(command, args, options) {
      runner = spawn(command, args, options); return runner;
    } });
    active = await adapter.startSession({ agentId: 'fixture', workingDirectory: cwd, model: 'fixture/forced',
      ...(withOrigin ? { remoteProjectMcp } : {}) });
    const turn = active.run('Execute the forced fixture call.');
    const drain = (async () => { try { for await (const _event of turn.events) {} } catch {} })();
    observation.outcome = (await turn.completion).status;
    await drain;
    assert.equal(observation.outcome, 'completed');
    assert.ok(calls >= 2 && observation.resultSeen);
    if (name === 'approved-origin') {
      const exited = once(runner, 'exit');
      runner.kill('SIGKILL'); await exited;
      facts.forcedRunnerExitRestored = true;
    }
    await active.close(); active = undefined;
    // Parent restores on process exit; close waits for that process.
    assert.equal(readFileSync(settings, 'utf8'), original);
    assert.equal(existsSync(join(cwd, '.pi', '.sprout-oar-policy')), false);
    facts.runs[name] = { ...observation };
  }
  await controlled('denied-bash', false);
  assert.equal(observation.advertised.length, 0);
  assert.ok(observation.denied && !existsSync(receipts.bash));
  await controlled('denied-extension', true);
  assert.deepEqual(observation.advertised, ['mcp__sprout_workspace__remote_read']);
  assert.ok(observation.denied && !existsSync(receipts.loaded) && !existsSync(receipts.extension));
  await controlled('approved-origin', true);
  assert.deepEqual(observation.advertised, ['mcp__sprout_workspace__remote_read']);
  assert.ok(!observation.denied && existsSync(receipts.origin));
  // A genuinely supplied stdio entry is rejected by the same runner guard before OAR opens.
  const lease = prepareOarRuntimePolicy('pi', cwd, { models });
  try {
    const options = { cwd: lease.descriptor.cwd, mcpServers: [stdio] };
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
  } finally { lease.close(); }
  assert.equal(readFileSync(settings, 'utf8'), original);
  facts.projectSettingsRestoredExactly = true;
  facts.ambientExtensionNotLoaded = !existsSync(receipts.loaded);
  facts.hostStdioResourceAbsent = !existsSync(receipts.stdio);
  facts.originEvidenceLimit = 'Scripted RemoteProjectMcpTools contract fixture; not an enrolled Worker or model-issued run.';
  console.log(JSON.stringify(facts));
} finally {
  clearTimeout(deadline);
  await active?.close(); await rawSession?.dispose();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (savedPin === undefined) delete process.env.OAR_PI_AGENT_DIR; else process.env.OAR_PI_AGENT_DIR = savedPin;
  for (const [index, name] of ['no_proxy', 'NO_PROXY'].entries()) {
    if (savedProxy[index] === undefined) delete process.env[name]; else process.env[name] = savedProxy[index];
  }
  rmSync(root, { recursive: true, force: true });
}
