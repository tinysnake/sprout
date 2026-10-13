import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRuntimes } from '@botiverse/oar';

// Real OAR/Pi sessions, forced by a synthetic provider. No credentials or model inference.
// Emit only reduced facts. Temporary roots and native records are removed on exit.
const root = mkdtempSync(join(tmpdir(), 'sprout-oar-pi-policy-'));
const ambient = join(root, 'ambient-agent');
const controlled = join(root, 'controlled-agent');
const cwd = join(root, 'project');
const receipts = Object.fromEntries(['agent', 'project', 'bash', 'newTool', 'stdio'].map(name => [name, join(root, `${name}-receipt`)]));
for (const directory of [ambient, controlled, cwd, join(ambient, 'extensions'), join(cwd, '.pi', 'extensions')]) mkdirSync(directory, { recursive: true });
const saved = Object.fromEntries(['OAR_PI_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'no_proxy', 'NO_PROXY'].map(name => [name, process.env[name]]));
process.env.no_proxy = process.env.NO_PROXY = 'localhost';
process.env.PI_CODING_AGENT_DIR = ambient;
let session;
let phase;
let calls;
let observations;
const facts = { evidenceClass: 'scripted', oar: '0.59.1', node: process.versions.node, platform: process.platform };
const server = createServer(async (request, response) => {
  let input = ''; for await (const chunk of request) input += chunk;
  const body = JSON.parse(input);
  calls++;
  observations.advertised = (body.tools ?? []).map(tool => tool.function.name);
  const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'forced-call');
  if (result) {
    observations.resultSeen = true;
    observations.denied = /not found|not available|unknown|disabled|denied/i.test(String(result.content));
  }
  const toolName = phase.startsWith('new-tool') ? 'unapproved_fixture_tool' : 'bash';
  const args = toolName === 'bash' ? { command: `touch '${receipts.bash}'` } : {};
  const delta = calls === 1
    ? { role: 'assistant', tool_calls: [{ index: 0, id: 'forced-call', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] }
    : { role: 'assistant', content: 'FIXTURE_DONE' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] });
  response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
  response.write(`data: ${JSON.stringify(chunk({}, calls === 1 ? 'tool_calls' : 'stop'))}\n\n`);
  response.end('data: [DONE]\n\n');
});
const deadline = setTimeout(() => { console.log(JSON.stringify({ evidenceClass: 'scripted', incomplete: true })); process.exit(2); }, 90000);
try {
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  // The assigned loopback endpoint stays in the temporary configuration only.
  const models = { providers: { fixture: { baseUrl: `http://localhost:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic-fixture', models: [{ id: 'forced-tools', reasoning: false, contextWindow: 8192, maxTokens: 1024 }] } } };
  for (const directory of [ambient, controlled]) writeFileSync(join(directory, 'models.json'), JSON.stringify(models));
  writeFileSync(join(ambient, 'extensions', 'ambient-receipt.ts'), `import { writeFileSync } from 'node:fs'; export default function() { writeFileSync(${JSON.stringify(receipts.agent)}, 'loaded'); }`);
  writeFileSync(join(cwd, '.pi', 'extensions', 'receipt.ts'), `import { writeFileSync } from 'node:fs'; export default function(pi) {
    writeFileSync(${JSON.stringify(receipts.project)}, 'loaded');
    pi.registerTool({ name: 'unapproved_fixture_tool', label: 'Synthetic unapproved tool', description: 'Synthetic resource effect',
      parameters: { type: 'object', properties: {} }, execute: async () => {
        writeFileSync(${JSON.stringify(receipts.newTool)}, 'executed'); return { content: [{ type: 'text', text: 'effect-created' }], details: {} };
      } });
  }`);
  const runtime = defaultRuntimes.require('pi');
  const installation = await runtime.installation();
  assert.equal(installation.kind, 'available');
  async function run(name, agentDir, options = {}) {
    phase = name; calls = 0; observations = { resultSeen: false, denied: false, attempted: false, advertised: [] };
    process.env.OAR_PI_AGENT_DIR = agentDir;
    session = await runtime.session(installation, { cwd, model: 'fixture/forced-tools', ...options });
    const ended = new Promise(resolve => session.events(event => {
      if (event.kind === 'tool_call_started') observations.attempted = true;
      if (event.kind === 'turn_ended') resolve(event.outcome.kind);
    }));
    await session.prompt('Execute the forced synthetic capability.');
    const outcome = await ended;
    await session.dispose(); session = undefined;
    return { ...observations, outcome, providerRequests: calls };
  }
  const positive = await run('positive', ambient);
  assert.ok(positive.attempted && positive.resultSeen && !positive.denied && existsSync(receipts.bash));
  assert.ok(existsSync(receipts.agent) && existsSync(receipts.project));
  facts.unrestrictedBashCreatesResource = true;
  facts.ambientAgentAndProjectExtensionsExecute = true;
  for (const name of ['agent', 'project', 'bash']) rmSync(receipts[name]);
  const disallowedTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
  const negative = await run('denied', controlled, { disallowedTools });
  assert.ok(negative.attempted && negative.resultSeen && negative.denied && !existsSync(receipts.bash));
  assert.ok(!negative.advertised.includes('bash'));
  facts.forcedBashAttemptDenied = true;
  facts.deniedBashResourceAbsent = true;
  facts.deniedBashNotAdvertised = true;
  facts.controlledAgentRootExcludesAmbientAgentExtension = !existsSync(receipts.agent);
  facts.projectExtensionStillExecutes = existsSync(receipts.project);
  const newTool = await run('new-tool', controlled, { disallowedTools });
  assert.ok(newTool.attempted && newTool.resultSeen && !newTool.denied && existsSync(receipts.newTool));
  facts.unlistedExtensionToolCreatesResource = true;
  // A wildcard can deny everything, including approved tools; it supplies no allowlist exception.
  rmSync(receipts.newTool);
  const wildcard = await run('new-tool-all-denied', controlled, { disallowedTools: ['*'] });
  assert.ok(wildcard.attempted && wildcard.resultSeen && wildcard.denied && !existsSync(receipts.newTool));
  assert.equal(wildcard.advertised.length, 0);
  facts.wildcardDeniesAllTools = true;
  // Explicitly attempting CLI loader controls is refused by the published surface.
  let launchRefused = false;
  try { session = await runtime.session(installation, { cwd, launchArgs: ['--no-extensions', '--no-tools'] }); }
  catch (error) { launchRefused = error.name === 'UnsupportedOptionError'; }
  facts.loaderLaunchArgsRefused = launchRefused;
  assert.ok(launchRefused);
  // OAR accepts host stdio. This is a real process effect, not an argv assertion.
  phase = 'stdio'; calls = 0;
  session = await runtime.session(installation, { cwd, model: 'fixture/forced-tools', mcpServers: [{ name: 'fixture', command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(receipts.stdio)}, 'executed')`] }] });
  await session.prompt('Trigger the synthetic MCP connection.');
  for (let attempt = 0; attempt < 800 && !existsSync(receipts.stdio); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
  facts.hostStdioMcpProcessExecuted = existsSync(receipts.stdio);
  assert.ok(facts.hostStdioMcpProcessExecuted);
  await session.dispose(); session = undefined;
  facts.runs = { positive, negative, newTool, wildcard };
  assert.ok(facts.controlledAgentRootExcludesAmbientAgentExtension && facts.projectExtensionStillExecutes);
  console.log(JSON.stringify(facts));
} finally {
  clearTimeout(deadline);
  await session?.dispose();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
}
