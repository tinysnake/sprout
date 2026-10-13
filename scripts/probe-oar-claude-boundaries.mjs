import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { defaultRuntimes } from '@botiverse/oar';
import { launchClaude } from '../node_modules/@botiverse/oar/dist/runtimes/claude/launch.js';
import { CLAUDE_PARENT_SESSION_MARKERS } from '../node_modules/@botiverse/oar/dist/runtimes/claude/environment.js';

// Scripted provider output forces a denied tool attempt in the real Claude CLI.
// Only reduced observations are emitted; raw provider/OAR records stay in memory.
const root = mkdtempSync(join(tmpdir(), 'sprout-oar-claude-boundaries-'));
const effect = join(root, 'forbidden-effect');
const cli = execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 }).trim();
let session;
let requests = 0;
let deniedResult = false;
let advertisedBash = false;
let phase = 'denied';
let phaseRequests = 0;
let ambientRulesLoaded = false;
let allowedResult = false;
let explicitToolsDenied = false;
let hostFlagTools = [];
const outside = mkdtempSync(join(tmpdir(), 'sprout-oar-claude-outside-'));
const outsideEffect = join(outside, 'unbounded-effect');
const hookEffect = join(root, 'ambient-hook-effect');
const facts = { evidenceClass: 'scripted', oar: '0.59.1', cli: execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim() };
const server = createServer(async (request, response) => {
  let input = ''; for await (const chunk of request) input += chunk;
  if (!request.url?.includes('/messages')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return; }
  const body = JSON.parse(input);
  if (request.url.includes('count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":10}'); return; }
  requests++;
  phaseRequests++;
  ambientRulesLoaded ||= phase === 'ambient' && JSON.stringify({ system: body.system, messages: body.messages }).includes('SYNTHETIC_AMBIENT_RULE');
  if (phase === 'denied') advertisedBash ||= (body.tools ?? []).some(tool => tool.name === 'Bash');
  const results = (body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
  deniedResult ||= results.some(result => result.tool_use_id === 'forced-denied-bash' && result.is_error === true && /unknown|not available|not found|unrecognized|disabled|denied/i.test(JSON.stringify(result.content)));
  if (phase === 'host-flags') hostFlagTools = (body.tools ?? []).map(tool => tool.name);
  explicitToolsDenied ||= phase === 'host-flags' && results.some(result => result.tool_use_id === 'forced-denied-bash' && result.is_error === true);
  allowedResult ||= phase === 'unbounded' && results.some(result => result.tool_use_id === 'forced-denied-bash' && result.is_error !== true);
  const block = phaseRequests === 1
    ? { type: 'tool_use', id: 'forced-denied-bash', name: 'Bash', input: { command: `touch '${phase === 'unbounded' ? outsideEffect : effect}'`, description: 'Attempt the controlled capability' } }
    : { type: 'text', text: 'DENIAL_CHECK_FINISHED' };
  const message = { id: `msg_probe_${requests}`, type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: phaseRequests === 1 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message)); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  send('message_stop', { type: 'message_stop' }); response.end();
});
const deadline = setTimeout(() => { console.log(JSON.stringify({ ...facts, incomplete: true })); process.exit(2); }, 65000);
try {
  // Observe child environment effects, not merely the shape of OAR's env builder.
  const receipt = join(root, 'environment.json');
  const executable = join(root, 'environment-probe');
  writeFileSync(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify(${JSON.stringify(CLAUDE_PARENT_SESSION_MARKERS)}.map(key=>Object.hasOwn(process.env,key))));\n`);
  chmodSync(executable, 0o700);
  const saved = Object.fromEntries(CLAUDE_PARENT_SESSION_MARKERS.map(key => [key, process.env[key]]));
  for (const key of CLAUDE_PARENT_SESSION_MARKERS) process.env[key] = 'synthetic-parent-marker';
  const child = await launchClaude(executable, randomUUID(), { cwd: root });
  await child.exited;
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  facts.parentMarkersRemoved = JSON.parse(readFileSync(receipt, 'utf8')).every(present => !present);
  const overridden = await launchClaude(executable, randomUUID(), { cwd: root,
    env: Object.fromEntries(CLAUDE_PARENT_SESSION_MARKERS.map(key => [key, 'synthetic-explicit-marker'])) });
  await overridden.exited;
  const explicitPresence = JSON.parse(readFileSync(receipt, 'utf8'));
  facts.explicitEnvCanRestoreElevenMarkers = explicitPresence.filter(Boolean).length === 11 && explicitPresence[0] === false;
  rmSync(receipt);
  let refused = false;
  try { await launchClaude(executable, randomUUID(), { cwd: root, launchArgs: ['--permission-mode', 'dontAsk'] }); } catch (error) { refused = error.name === 'UnsupportedOptionError'; }
  facts.permissionOverrideRefusedBeforeChildEffect = refused && !existsSync(receipt);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const environment = { CLAUDE_CONFIG_DIR: root, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'synthetic-probe-token', ANTHROPIC_API_KEY: null, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  session = await defaultRuntimes.require('claude').session({ via: 'executable', command: cli }, {
    cwd: root, model: 'claude-sonnet-4-6', disallowedTools: ['Bash'],
    env: environment,
    launchArgs: ['--bare', '--setting-sources', ''],
  });
  let attempted = false;
  const ended = new Promise(resolve => session.events(event => {
    if (event.kind === 'tool_call_started' && event.tool === 'Bash') attempted = true;
    if (event.kind === 'turn_ended') resolve(event.outcome.kind);
  }));
  await session.prompt('Execute the controlled capability test.');
  facts.outcome = await ended;
  facts.forcedToolAttemptObserved = attempted;
  facts.providerReceivedDeniedToolResult = deniedResult;
  facts.deniedToolResourceEffectAbsent = !existsSync(effect);
  facts.bashAdvertised = advertisedBash;
  await session.dispose(); session = undefined;
  writeFileSync(join(root, 'CLAUDE.md'), 'SYNTHETIC_AMBIENT_RULE: Keep this rule in context.');
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${hookEffect}'` }] }] } }));
  const runPhase = async (name, options) => {
    phase = name; phaseRequests = 0;
    session = await defaultRuntimes.require('claude').session({ via: 'executable', command: cli }, { cwd: root, model: 'claude-sonnet-4-6', env: environment, ...options });
    const ended = new Promise(resolve => session.events(event => { if (event.kind === 'turn_ended') resolve(event.outcome.kind); }));
    await session.prompt('Execute the controlled capability test.');
    const outcome = await ended;
    await session.dispose(); session = undefined;
    return outcome;
  };
  facts.ambientOutcome = await runPhase('ambient', { disallowedTools: ['Bash'] });
  facts.rulesLoadedDespiteToolExclusion = ambientRulesLoaded;
  facts.hookExecutedDespiteToolExclusion = existsSync(hookEffect);
  rmSync(hookEffect, { force: true });
  facts.unboundedOutcome = await runPhase('unbounded', { additionalDirectories: [root], launchArgs: ['--bare', '--setting-sources', ''] });
  facts.localBashExecutedWithoutApproval = allowedResult && existsSync(outsideEffect);
  facts.addDirDoesNotConfineWrites = existsSync(outsideEffect);
  facts.bareSuppressedAmbientHookInFixture = !existsSync(hookEffect);
  facts.explicitHostFlagsOutcome = await runPhase('host-flags', {
    launchArgs: ['--bare', '--tools', '', '--strict-mcp-config', '--setting-sources', ''],
  });
  facts.explicitToolsEmptyDeniesForcedBash = explicitToolsDenied && !existsSync(effect);
  facts.explicitToolsEmptyAdvertisesNoBash = !hostFlagTools.includes('Bash');
  facts.providerRequests = requests;
  console.log(JSON.stringify(facts));
  assert.ok(attempted && deniedResult && !existsSync(effect) && !advertisedBash);
  assert.ok(facts.parentMarkersRemoved && facts.explicitEnvCanRestoreElevenMarkers && facts.permissionOverrideRefusedBeforeChildEffect);
  assert.ok(facts.localBashExecutedWithoutApproval && facts.rulesLoadedDespiteToolExclusion && facts.hookExecutedDespiteToolExclusion);
  assert.ok(facts.explicitToolsEmptyDeniesForcedBash && facts.explicitToolsEmptyAdvertisesNoBash);
} finally {
  clearTimeout(deadline);
  await session?.dispose();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
