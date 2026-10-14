/**
 * #271 scripted prerequisites probe: engine credential reachability, tool-surface
 * credential denial with an unrestricted positive control, declared-profile open
 * denial for the credential file, executed hook/plugin/MCP child reads, a broker
 * process/service-name scan, and supervisor stop/teardown/resume on the shared OAR
 * Claude route (OAR 0.59.1 / Claude 2.1.294 / macOS).
 *
 * Reduced booleans only. Raw provider requests, prompts, auth output and any
 * credential material stay in memory and are never written to the evidence file.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, writeSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OarEngineAdapter } from '../src/engine/oar.ts';
import { redactSensitiveText } from '../src/environment/privacy.ts';
import { fileIsolationProfile } from './prototype-origin-fixture.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sprout-oar-claude-prereqs-')));
const configDir = join(root, 'config');
mkdirSync(configDir);
const canaryPath = join(root, 'canary.txt');
const canaryMarker = 'CONTROL_MARKER_271';
writeFileSync(canaryPath, canaryMarker);
const credentialPath = join(homedir(), '.claude', '.credentials.json');

const facts = {
  ticket: 271,
  evidenceClass: 'scripted',
  pins: {},
  engineAuth: { statusRan: false, reachable: false },
  credentialFile: { present: false, openableWithoutIsolation: false, profileRunOk: false, openDeniedUnderDeclaredProfile: false },
  childAccess: {
    unrestrictedPositiveControl: { attempted: false, readSucceeded: false },
    hook: { processLaunched: false, exitCode: null, attempted: false, readSucceeded: false, denied: false },
    plugin: { processLaunched: false, exitCode: null, attempted: false, readSucceeded: false, denied: false },
    mcp: { processLaunched: false, exitCode: null, attempted: false, readSucceeded: false, denied: false, initializeObserved: false },
  },
  brokerPresenceCheck: { processScanExecuted: false, processRowsScanned: 0, brokerNamePatternProcessRows: 0, credentialRelatedBrokerNamePatternProcessRows: 0, launchdScanExecuted: false, launchdRowsScanned: 0, brokerNamePatternServiceRows: 0, credentialRelatedBrokerNamePatternServiceRows: 0 },
  toolSurface: {
    fresh: { turnCompleted: false, forcedReadAttemptObserved: false, providerReceivedToolResult: false, denied: false, credentialMaterialObserved: false },
    resumed: { resumeAccepted: false, turnCompleted: false, forcedReadAttemptObserved: false, providerReceivedToolResult: false, denied: false, credentialMaterialObserved: false },
    unrestrictedControl: { turnCompleted: false, providerReceivedToolResult: false, markerObserved: false },
  },
  supervisor: { preCloseRunnerAlive: false, preCloseDescendantCount: 0, freshTurnCompleted: false, runnerGoneAfterClose: false, descendantsTracked: 0, descendantsGoneAfterClose: 0, resumeRunnerGoneAfterClose: false },
  providerRequests: 0,
  ok: false,
};
let exitCode = 1;
const deadline = setTimeout(() => {
  facts.incomplete = true;
  writeEvidence();
  cleanupHard();
  server.closeAllConnections?.();
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}, 150_000);

function writeEvidence() {
  try {
    writeFileSync(new URL('../docs/research/271-oar-claude-prerequisite-evidence.json', import.meta.url), JSON.stringify(facts, null, 2) + '\n');
  } catch { /* evidence write is best effort; stdout carries the same facts */ }
}

// --- Scripted provider: forces a Read of the credential file (denied arms) or
// of a canary file (unrestricted control), and serves plain text turns. ---
let mode = 'text';
let modeRequests = 0;
const setMode = next => { mode = next; modeRequests = 0; };
const credentialLike = /anthropic|api[_-]?key|authorization|bearer|\bsk-[a-z0-9]/i;
const server = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; if (body.length > 1_000_000) request.destroy(); });
  request.on('end', () => {
    if (!request.url?.includes('/messages')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return; }
    if (request.url.includes('count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":10}'); return; }
    facts.providerRequests++;
    modeRequests++;
    let parsed;
    try { parsed = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
    const results = (parsed.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
    if (mode === 'deny' || mode === 'resumed-deny') {
      const fact = facts.toolSurface[mode === 'deny' ? 'fresh' : 'resumed'];
      const result = results.find(entry => entry.tool_use_id === 'forced-credential-read');
      if (result) {
        fact.providerReceivedToolResult = true;
        fact.denied = result.is_error === true;
        fact.credentialMaterialObserved ||= credentialLike.test(JSON.stringify(result.content));
      }
    }
    if (mode === 'control') {
      const result = results.find(entry => entry.tool_use_id === 'forced-control-read');
      if (result) {
        facts.toolSurface.unrestrictedControl.providerReceivedToolResult = true;
        facts.toolSurface.unrestrictedControl.markerObserved ||= JSON.stringify(result.content).includes(canaryMarker);
      }
    }
    const forced = (mode === 'deny' || mode === 'resumed-deny')
      ? { type: 'tool_use', id: 'forced-credential-read', name: 'Read', input: { file_path: credentialPath } }
      : mode === 'control'
        ? { type: 'tool_use', id: 'forced-control-read', name: 'Read', input: { file_path: canaryPath } }
        : { type: 'text', text: 'PROBE_TURN_FINISHED' };
    const block = modeRequests === 1 ? forced : { type: 'text', text: 'PROBE_TURN_FINISHED' };
    const message = { id: `msg_probe_${facts.providerRequests}`, type: 'message', role: 'assistant', model: parsed.model, content: [block], stop_reason: modeRequests === 1 && block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
    if (!parsed.stream) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message)); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
    send('message_stop', { type: 'message_stop' });
    response.end();
  });
});

const children = new Set();
const runners = [];
const cleanupHard = () => {
  for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } } }
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function descendants(pid) {
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift();
    let output = '';
    try { output = execFileSync('/usr/bin/pgrep', ['-P', String(current)], { encoding: 'utf8', timeout: 2000 }); } catch { continue; }
    for (const line of output.split('\n')) {
      const child = Number(line.trim());
      if (Number.isInteger(child) && child > 0) { found.push(child); queue.push(child); }
    }
  }
  return found;
}
const waitGone = async pids => {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (pids.every(pid => !alive(pid))) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
};
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const readJsonIfPresent = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
};

const runNativeProbe = async (cli, args, env, root, children, descendants) => {
  const child = spawn(cli, args, { cwd: root, env, stdio: 'ignore' });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const seenDescendants = new Set();
  const sample = () => { if (typeof child.pid === 'number') for (const pid of descendants(child.pid)) seenDescendants.add(pid); };
  const sampler = setInterval(sample, 250);
  let timedOut = false;
  let launchFailed = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2_000).unref(); }, 25_000);
  const outcome = await new Promise(resolve => {
    child.once('error', () => { launchFailed = true; resolve({ exitCode: null, signal: null }); });
    child.once('exit', (code, signal) => resolve({ exitCode: code, signal }));
  });
  clearTimeout(timer);
  clearInterval(sampler);
  sample();
  const tracked = [...seenDescendants];
  const leftovers = tracked.filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } });
  for (const pid of leftovers) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (leftovers.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } })) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const pid of leftovers) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  const descendantsGone = tracked.filter(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }).length;
  return { ...outcome, launchFailed, timedOut, descendantsTracked: tracked.length, descendantsGone };
};

let adapterSession;
let controlSession;
let port;
try {
  // --- Pins and prerequisites ---
  assert.equal(process.platform, 'darwin');
  const cli = realpathSync(execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 10_000 }).trim());
  const cliVersion = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const oarVersion = JSON.parse(readFileSync(new URL('../node_modules/@botiverse/oar/package.json', import.meta.url), 'utf8')).version;
  facts.pins = { oar: oarVersion, cli: cliVersion, node: process.versions.node, platform: process.platform, macOS: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5_000 }).trim() };
  assert.equal(oarVersion, '0.59.1');
  assert.equal(cliVersion, '2.1.294 (Claude Code)');

  // --- Engine credential reachability: auth status output is parsed to booleans and discarded. ---
  try {
    const auth = JSON.parse(execFileSync(cli, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    facts.engineAuth.statusRan = true;
    facts.engineAuth.reachable = auth.loggedIn === true && typeof auth.authMethod === 'string';
  } catch { facts.engineAuth.statusRan = true; facts.engineAuth.reachable = false; }

  // --- Credential file open: unrestricted positive control vs declared isolation profile. ---
  facts.credentialFile.present = existsSync(credentialPath);
  const openProbe = "const fs=require('fs');try{const fd=fs.openSync(process.argv[1],'r');fs.closeSync(fd);process.stdout.write(JSON.stringify({opened:true}))}catch(e){process.stdout.write(JSON.stringify({opened:false,denied:['EPERM','EACCES'].includes(e.code)}))}";
  if (facts.credentialFile.present) {
    const ambient = spawnSync(process.execPath, ['-e', openProbe, credentialPath], { encoding: 'utf8', timeout: 15_000 });
    facts.credentialFile.openableWithoutIsolation = ambient.error === undefined && ambient.status === 0 && JSON.parse(ambient.stdout || '{}').opened === true;
    const profile = fileIsolationProfile({ runtimeRoots: ['/opt/homebrew', dirname(realpathSync(process.execPath))] });
    const guarded = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', openProbe, credentialPath], { encoding: 'utf8', timeout: 15_000, env: { PATH: '/usr/bin:/bin' } });
    facts.credentialFile.profileRunOk = guarded.error === undefined && guarded.status === 0;
    facts.credentialFile.openDeniedUnderDeclaredProfile = facts.credentialFile.profileRunOk && JSON.parse(guarded.stdout || '{}').denied === true;
  }

  // --- Scripted provider on a configured reserved range or an ephemeral port. ---
  const loopbackAddress = (await lookup('localhost', { family: 4 })).address;
  assert.ok(loopbackAddress.startsWith('127.'), 'localhost-did-not-resolve-to-loopback');
  const requestedRange = process.env.SPROUT_OAR_PROBE_PORT_RANGE;
  if (requestedRange !== undefined) {
    const match = /^(\d+)-(\d+)$/.exec(requestedRange);
    assert.ok(match, 'invalid-probe-port-range');
    const first = Number(match[1]);
    const last = Number(match[2]);
    assert.ok(Number.isSafeInteger(first) && Number.isSafeInteger(last) && first > 0 && last >= first && last <= 65535 && last - first <= 1000, 'invalid-probe-port-range');
    for (let candidate = first; candidate <= last; candidate++) {
      const bound = await new Promise(resolve => {
        const onError = () => { server.removeListener('listening', onListening); resolve(false); };
        const onListening = () => { server.removeListener('error', onError); resolve(true); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, loopbackAddress);
      });
      if (bound) { port = candidate; break; }
    }
    assert.ok(port !== undefined, 'no-free-configured-port');
    facts.providerListener = { bound: true, allocation: 'environment-range' };
  } else {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, loopbackAddress, resolve);
    });
    port = server.address().port;
    facts.providerListener = { bound: true, allocation: 'ephemeral' };
  }
  const probeEnv = {
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `http://${loopbackAddress}:${port}`,
    ANTHROPIC_AUTH_TOKEN: '{{PROBE_SYNTHETIC_TOKEN}}',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };

  // --- Actual same-user reads by each configured Claude child surface. The
  // receipts contain booleans only; file contents and paths stay out of output. ---
  const receiptDir = join(root, 'child-access-receipts');
  mkdirSync(receiptDir, { mode: 0o700 });
  const readerPath = join(root, 'credential-child-reader.mjs');
  writeFileSync(readerPath, `import { readFileSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst target = ${JSON.stringify(credentialPath)};\nconst directory = ${JSON.stringify(receiptDir)};\nexport function attemptCredentialRead(role) { let readSucceeded = false; let denied = false; try { const discarded = readFileSync(target); readSucceeded = true; void discarded; } catch (error) { denied = ['EPERM', 'EACCES'].includes(error.code); } writeFileSync(join(directory, role + '.json'), JSON.stringify({ attempted: true, readSucceeded, denied }), { mode: 0o600 }); }\nif (['hook', 'plugin', 'unrestrictedPositiveControl'].includes(process.argv[2])) attemptCredentialRead(process.argv[2]);\n`, { mode: 0o600 });
  const mcpReaderPath = join(root, 'credential-mcp-child.mjs');
  const mcpFixturePath = new URL('./prototype-claude-fixture-bridge.mjs', import.meta.url);
  const mcpSource = readFileSync(mcpFixturePath, 'utf8')
    .replace("import { createInterface } from 'node:readline';", `import { createInterface } from 'node:readline';\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst credentialPath = ${JSON.stringify(credentialPath)};\nconst receiptPath = ${JSON.stringify(join(receiptDir, 'mcp.json'))};\nlet credentialReadSucceeded = false; let credentialReadDenied = false; try { const discarded = readFileSync(credentialPath); credentialReadSucceeded = true; void discarded; } catch (error) { credentialReadDenied = ['EPERM', 'EACCES'].includes(error.code); }\nwriteFileSync(receiptPath, JSON.stringify({ attempted: true, readSucceeded: credentialReadSucceeded, denied: credentialReadDenied }), { mode: 0o600 });`)
    .replace("if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'disposable-origin-bridge', version: '229.2' } };", "if (request.method === 'initialize') { result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'disposable-origin-bridge', version: '229.2' } }; const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); receipt.initializeObserved = true; writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 }); }");
  assert.ok(mcpSource.includes('initializeObserved'));
  writeFileSync(mcpReaderPath, mcpSource, { mode: 0o600 });
  const cleanProbeEnv = {
    HOME: root,
    PATH: [dirname(cli), dirname(realpathSync(process.execPath)), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    TMPDIR: root,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_TMPDIR: root,
    ANTHROPIC_BASE_URL: `http://${loopbackAddress}:${port}`,
    ANTHROPIC_AUTH_TOKEN: '{{PROBE_SYNTHETIC_TOKEN}}',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  const baseNativeArgs = ['--print', '--output-format', 'json', '--verbose', '--model', 'claude-sonnet-4-6', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config'];
  const runChildSurface = async (role, settingSources, extraArgs = [], mcpConfig = '{"mcpServers":{}}') => {
    const receiptPath = join(receiptDir, `${role}.json`);
    rmSync(receiptPath, { force: true });
    setMode('text');
    const outcome = await runNativeProbe(cli, [...baseNativeArgs, '--setting-sources', settingSources, '--mcp-config', mcpConfig, ...extraArgs, 'Reply READY.'], cleanProbeEnv, root, children, descendants);
    const receipt = readJsonIfPresent(receiptPath);
    Object.assign(facts.childAccess[role], {
      processLaunched: !outcome.launchFailed,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      descendantsTracked: outcome.descendantsTracked,
      descendantsGone: outcome.descendantsGone,
      attempted: receipt?.attempted === true,
      readSucceeded: receipt?.readSucceeded === true,
      denied: receipt?.denied === true,
      ...(role === 'mcp' ? { initializeObserved: receipt?.initializeObserved === true } : {}),
    });
  };
  const positive = spawnSync(process.execPath, [readerPath, 'unrestrictedPositiveControl'], { timeout: 10_000, stdio: 'ignore' });
  const positiveReceipt = readJsonIfPresent(join(receiptDir, 'unrestrictedPositiveControl.json'));
  facts.childAccess.unrestrictedPositiveControl = { attempted: positive.status === 0 && positiveReceipt?.attempted === true, readSucceeded: positive.status === 0 && positiveReceipt?.readSucceeded === true };

  const brokerPattern = /broker/i;
  const credentialBrokerPattern = /(?:credential|secret|token|auth|key).*broker|broker.*(?:credential|secret|token|auth|key)/i;
  const processRows = execFileSync('/bin/ps', ['-axo', 'comm'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  facts.brokerPresenceCheck.processScanExecuted = true;
  facts.brokerPresenceCheck.processRowsScanned = processRows.length;
  facts.brokerPresenceCheck.brokerNamePatternProcessRows = processRows.filter(row => brokerPattern.test(row)).length;
  facts.brokerPresenceCheck.credentialRelatedBrokerNamePatternProcessRows = processRows.filter(row => credentialBrokerPattern.test(row)).length;
  try {
    const serviceRows = execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    facts.brokerPresenceCheck.launchdScanExecuted = true;
    facts.brokerPresenceCheck.launchdRowsScanned = serviceRows.length;
    facts.brokerPresenceCheck.brokerNamePatternServiceRows = serviceRows.filter(row => brokerPattern.test(row)).length;
    facts.brokerPresenceCheck.credentialRelatedBrokerNamePatternServiceRows = serviceRows.filter(row => credentialBrokerPattern.test(row)).length;
  } catch { facts.brokerPresenceCheck.launchdScanExecuted = false; }

  const userSettings = join(configDir, 'settings.json');
  const hookCommand = `${shellQuote(process.execPath)} ${shellQuote(readerPath)} hook`;
  writeFileSync(userSettings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] }] } }), { mode: 0o600 });
  await runChildSurface('hook', '', ['--settings', userSettings]);
  rmSync(userSettings, { force: true });

  const pluginDir = join(root, 'credential-observation-plugin');
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(pluginDir, 'hooks'), { recursive: true });
  writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'credential-observation', version: '1.0.0' }), { mode: 0o600 });
  const pluginHookCommand = `${shellQuote(process.execPath)} ${shellQuote(readerPath)} plugin`;
  writeFileSync(join(pluginDir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: pluginHookCommand, timeout: 5 }] }] } }), { mode: 0o600 });
  await runChildSurface('plugin', '', ['--plugin-dir', pluginDir]);
  rmSync(pluginDir, { recursive: true, force: true });

  const mcpReceiptPath = join(receiptDir, 'mcp.json');
  rmSync(mcpReceiptPath, { force: true });
  const mcpChild = spawn(process.execPath, [mcpReaderPath, `http://${loopbackAddress}:${port}/bridge`], { cwd: root, env: cleanProbeEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  children.add(mcpChild);
  let mcpLaunchFailed = false;
  let mcpTimedOut = false;
  let mcpProtocolResponse = false;
  let lineBuffer = '';
  let resolveInitialize;
  const initializeResponse = new Promise(resolve => { resolveInitialize = resolve; });
  const mcpExit = new Promise(resolve => {
    mcpChild.once('error', () => { mcpLaunchFailed = true; children.delete(mcpChild); resolve({ exitCode: null, signal: null }); });
    mcpChild.once('exit', (code, signal) => { children.delete(mcpChild); resolve({ exitCode: code, signal }); });
  });
  mcpChild.stdout.on('data', chunk => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const response = JSON.parse(line);
        if (response.id === 1 && response.result?.serverInfo?.name === 'disposable-origin-bridge') {
          mcpProtocolResponse = true;
          resolveInitialize(true);
        }
      } catch { /* ignore non-protocol output; it is never retained */ }
    }
  });
  mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sprout-prerequisite-probe', version: '1.0.0' } } }) + '\n');
  const initializeTimer = setTimeout(() => resolveInitialize(false), 5_000);
  const handshakeCompleted = await initializeResponse;
  clearTimeout(initializeTimer);
  if (handshakeCompleted) mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  mcpChild.stdin.end();
  const mcpExitTimer = setTimeout(() => { mcpTimedOut = true; mcpChild.kill('SIGKILL'); }, 5_000);
  const mcpOutcome = await mcpExit;
  clearTimeout(mcpExitTimer);
  const mcpReceipt = readJsonIfPresent(mcpReceiptPath);
  Object.assign(facts.childAccess.mcp, {
    processLaunched: !mcpLaunchFailed,
    launchContext: 'standalone-stdio-mcp-harness',
    protocolHandshakeEvidenceClass: 'protocol-only',
    exitCode: mcpOutcome.exitCode,
    timedOut: mcpTimedOut,
    descendantsTracked: 0,
    descendantsGone: 0,
    attempted: mcpReceipt?.attempted === true,
    readSucceeded: mcpReceipt?.readSucceeded === true,
    denied: mcpReceipt?.denied === true,
    initializeObserved: handshakeCompleted && mcpReceipt?.initializeObserved === true && mcpProtocolResponse,
  });

  const spawnProcess = (command, args, options) => {
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    runners.push(child);
    child.on('exit', () => children.delete(child));
    return child;
  };
  const adapter = new OarEngineAdapter({ runtimeId: 'claude', binaryPath: cli, spawnProcess });
  const start = extra => adapter.startSession({ agentId: 'probe', workingDirectory: root, model: 'claude-sonnet-4-6', sessionEnvironment: probeEnv, ...extra });
  const runTurn = async (session, prompt, track) => {
    const turn = session.run(prompt);
    const toolNames = [];
    const events = (async () => { for await (const event of turn.events) { if (event.type === 'tool-call') toolNames.push(event.name); } })();
    let result;
    try { result = await turn.completion; } catch { result = { status: 'failed' }; }
    try { await events; } catch { /* failed queue ends the iterator */ }
    track?.(result, toolNames);
    return result;
  };

  // --- Fresh session through the shared adapter: forced credential Read is attempted and must be denied. ---
  adapterSession = await start();
  setMode('deny');
  await runTurn(adapterSession, 'Perform the requested capability check now.', (result, names) => {
    facts.toolSurface.fresh.turnCompleted = result.status === 'completed';
    facts.toolSurface.fresh.forcedReadAttemptObserved = names.includes('Read');
  });
  await adapterSession.close(); adapterSession = undefined;

  // --- Unrestricted positive control: same forced Read without any tool policy. ---
  const { defaultRuntimes } = await import('@botiverse/oar');
  controlSession = await defaultRuntimes.require('claude').session({ via: 'executable', command: cli }, { cwd: root, model: 'claude-sonnet-4-6', env: { ...probeEnv, ANTHROPIC_API_KEY: null } });
  setMode('control');
  const controlEnded = new Promise(resolve => controlSession.events(event => { if (event.kind === 'turn_ended') resolve(event.outcome.kind); }));
  await controlSession.prompt('Perform the requested capability check now.');
  facts.toolSurface.unrestrictedControl.turnCompleted = (await controlEnded) === 'completed';
  await controlSession.dispose(); controlSession = undefined;

  // --- Supervisor stop: child teardown observed externally after close. ---
  adapterSession = await start();
  const runnerPid = runners.at(-1)?.pid;
  assert.ok(typeof runnerPid === 'number');
  const preClose = descendants(runnerPid);
  facts.supervisor.preCloseRunnerAlive = alive(runnerPid);
  facts.supervisor.preCloseDescendantCount = preClose.length;
  setMode('text');
  await runTurn(adapterSession, 'Reply with one word.', result => {
    facts.supervisor.freshTurnCompleted = result.status === 'completed';
  });
  const sessionKey = adapterSession.engineSessionKey;
  const trackedPids = [...new Set([...preClose, ...descendants(runnerPid)])];
  await adapterSession.close(); adapterSession = undefined;
  facts.supervisor.runnerGoneAfterClose = await waitGone([runnerPid]);
  facts.supervisor.descendantsGoneAfterClose = trackedPids.filter(pid => !alive(pid)).length;
  facts.supervisor.descendantsTracked = trackedPids.length;

  // --- Session resumption within unchanged authority: resume, then the same attempted denial. ---
  adapterSession = await start({ resumeSessionKey: sessionKey });
  facts.toolSurface.resumed.resumeAccepted = true;
  const resumeRunnerPid = runners.at(-1)?.pid;
  setMode('resumed-deny');
  await runTurn(adapterSession, 'Perform the requested capability check now.', (result, names) => {
    facts.toolSurface.resumed.turnCompleted = result.status === 'completed';
    facts.toolSurface.resumed.forcedReadAttemptObserved = names.includes('Read');
  });
  await adapterSession.close(); adapterSession = undefined;
  facts.supervisor.resumeRunnerGoneAfterClose = typeof resumeRunnerPid === 'number' && (await waitGone([resumeRunnerPid]));

  facts.ok = Boolean(
    facts.engineAuth.reachable &&
    facts.credentialFile.present &&
    facts.credentialFile.openableWithoutIsolation &&
    facts.credentialFile.openDeniedUnderDeclaredProfile &&
    facts.toolSurface.fresh.turnCompleted &&
    facts.toolSurface.fresh.forcedReadAttemptObserved &&
    facts.toolSurface.fresh.providerReceivedToolResult &&
    facts.toolSurface.fresh.denied &&
    !facts.toolSurface.fresh.credentialMaterialObserved &&
    facts.toolSurface.unrestrictedControl.turnCompleted &&
    facts.toolSurface.unrestrictedControl.providerReceivedToolResult &&
    facts.toolSurface.unrestrictedControl.markerObserved &&
    facts.toolSurface.resumed.resumeAccepted &&
    facts.toolSurface.resumed.turnCompleted &&
    facts.toolSurface.resumed.forcedReadAttemptObserved &&
    facts.toolSurface.resumed.denied &&
    !facts.toolSurface.resumed.credentialMaterialObserved &&
    facts.childAccess.unrestrictedPositiveControl.attempted &&
    facts.childAccess.unrestrictedPositiveControl.readSucceeded &&
    ['hook', 'plugin', 'mcp'].every(role => facts.childAccess[role].processLaunched && facts.childAccess[role].exitCode === 0 && !facts.childAccess[role].timedOut && facts.childAccess[role].attempted && facts.childAccess[role].readSucceeded && facts.childAccess[role].descendantsTracked === facts.childAccess[role].descendantsGone) &&
    facts.childAccess.mcp.processLaunched &&
    facts.childAccess.mcp.exitCode === 0 &&
    !facts.childAccess.mcp.timedOut &&
    facts.childAccess.mcp.attempted &&
    facts.childAccess.mcp.readSucceeded &&
    facts.childAccess.mcp.initializeObserved &&
    facts.brokerPresenceCheck.processScanExecuted &&
    facts.brokerPresenceCheck.launchdScanExecuted &&
    facts.supervisor.preCloseRunnerAlive &&
    facts.supervisor.preCloseDescendantCount > 0 &&
    facts.supervisor.freshTurnCompleted &&
    facts.supervisor.runnerGoneAfterClose &&
    facts.supervisor.descendantsTracked > 0 &&
    facts.supervisor.descendantsGoneAfterClose === facts.supervisor.descendantsTracked &&
    facts.supervisor.resumeRunnerGoneAfterClose,
  );
  exitCode = facts.ok ? 0 : 1;
} catch (error) {
  facts.failure = redactSensitiveText(error instanceof Error ? error.message : String(error));
  facts.ok = false;
  exitCode = 1;
} finally {
  clearTimeout(deadline);
  try { await adapterSession?.close(); } catch { /* recorded above */ }
  try { await controlSession?.dispose(); } catch { /* recorded above */ }
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  cleanupHard();
  rmSync(root, { recursive: true, force: true });
  writeEvidence();
  writeSync(1, JSON.stringify(facts) + '\n');
  setTimeout(() => process.exit(exitCode), 250).unref();
  process.exitCode = exitCode;
}
