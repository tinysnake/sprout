/** Disposable #229: pinned OAR Claude route with an explicit executable policy hook. */
import { registerHooks, createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { prototypeAdapter } from './prototype-oar-engine-seam.mjs';
import { makeOriginFixture, fileIsolationProfile, launchOrigin } from './prototype-origin-fixture.mjs';
import { macOsTimezoneFiles } from '../src/engine/host-runtime-files.ts';

const script = fileURLToPath(import.meta.url);
const bridgeScript = join(import.meta.dirname, 'probe-claude-host-isolation.mjs');
const fixture = makeOriginFixture();
const control = join(fixture.root, 'c'); mkdirSync(control);
const children = new Set(), sockets = new Set();
const kill = child => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
let origin, server, socketServer, session;
const wrapperPidFile = join(control, 'runner-identity');
const deadline = setTimeout(() => {
  for (const child of children) kill(child);
  if (existsSync(wrapperPidFile)) { try { process.kill(-Number(readFileSync(wrapperPidFile, 'utf8')), 'SIGKILL'); } catch {} }
  process.exit(2);
}, 170_000);
const expectedTools = ['mcp__origin__remote_read', 'mcp__origin__remote_write'];
const facts = { ticket: 229, evidenceClasses: { modelIssued: [], protocolOnly: {}, scripted: {}, sourceOnly: ['Standard OAR SessionOptions has no builtin/discovery policy member.', 'OAR launches Claude with permission bypass; the prototype executable hook removes it.', 'Claude MCP stdio commands and HTTP clients originate on the engine host, not an enrolled Worker.'] }, versions: {}, turns: [], catalogs: [], fixture: 'separate local sandbox origin; not enrolled remote work', authority: { declaredBeforeOpen: true, binding: 'immutable fixture origin', allowedOperations: ['read', 'write'], command: 'unavailable', changedBinding: 'close and fresh; never resume across authority' } };
const sha = data => createHash('sha256').update(data).digest('hex');
const negativesScript = "const fs=require('fs');let r=false,w=false;try{const f=fs.openSync(process.argv[1],'r');fs.closeSync(f)}catch(e){r=['EPERM','EACCES'].includes(e.code)}try{const f=fs.openSync(process.argv[1],'r+');fs.closeSync(f)}catch(e){w=['EPERM','EACCES'].includes(e.code)}console.log(JSON.stringify({readDenied:r,writeDenied:w}))";
try {
  assert.equal(process.platform, 'darwin');
  const root = resolve(process.env.OAR_PROBE_ROOT || 'missing-oar-prerequisite');
  const require = createRequire(join(resolve(process.env.OAR_PROBE_DEPS || 'missing-dependency-prerequisite'), 'package.json'));
  const dependencyUrls = Object.fromEntries(['cross-spawn', 'which'].map(name => [name, pathToFileURL(require.resolve(name)).href]));
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '0.35.0');
  const fingerprints = Object.fromEntries(['launch', 'session', 'projection', 'mcp-config'].map(name => [name, sha(readFileSync(join(root, 'dist/runtimes/claude', name + '.js')))]));
  const projection = pathToFileURL(join(root, 'dist/runtimes/claude/projection.js')).href;
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'oar-claude-original-projection') return { url: projection, shortCircuit: true };
    if (specifier === './projection.js' && context.parentURL?.includes('/runtimes/claude/session.js')) return { url: pathToFileURL(join(import.meta.dirname, 'prototype-claude-origin-hook.mjs')).href, shortCircuit: true };
    if (dependencyUrls[specifier]) return { url: dependencyUrls[specifier], shortCircuit: true };
    return next(specifier, context);
  } });
  const { claudeSession } = await import(pathToFileURL(join(root, 'dist/runtimes/claude/session.js')));
  const { promptAndWait } = await import(pathToFileURL(join(root, 'dist/observe/turns.js')));
  const cli = realpathSync(execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8', timeout: 10_000 }).trim());
  assert.equal(execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(), '2.1.294 (Claude Code)');
  const help = execFileSync(cli, ['--help'], { encoding: 'utf8', timeout: 10_000 });
  for (const flag of ['--bare', '--tools', '--strict-mcp-config', '--setting-sources', '--disable-slash-commands', '--permission-prompts']) assert.ok(help.includes(flag));
  const nativeSettings = join(homedir(), '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(nativeSettings, 'utf8'));
  if (!settings.model || !settings.effortLevel || !settings.env?.ANTHROPIC_BASE_URL || !(settings.env?.ANTHROPIC_API_KEY || settings.env?.ANTHROPIC_AUTH_TOKEN)) throw new Error('existing-model-route-auth-prerequisite');
  facts.versions = { oar: '0.35.0', sourceCommit: '8adde16fe2d12ae54af7d4dff86c3f224380a5c7', claude: '2.1.294', cliSha256: sha(readFileSync(cli)), node: process.versions.node, macOS: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5000 }).trim(), model: settings.model, effort: settings.effortLevel, modelRoute: 'existing non-Claude backend; no model/account substitution', fixtureSha256: sha(readFileSync(join(import.meta.dirname, 'prototype-origin-fixture.mjs'))), oarModules: fingerprints };
  const config = join(control, 'config'); mkdirSync(config);
  const runtimeRoots = ['/opt/homebrew', dirname(realpathSync(process.execPath))];
  const profile = fileIsolationProfile({ runtimeRoots: [...runtimeRoots, dirname(cli)], readRoots: [control, fixture.host, dirname(script)], writeRoots: [control], readFiles: [nativeSettings], network: true }) + '\n(allow file-write* (literal "/dev/null"))' + macOsTimezoneFiles().map(path => `\n(allow file-read-data (literal ${JSON.stringify(path)}))`).join('');
  const bridgeProfile = fileIsolationProfile({ runtimeRoots, readRoots: [dirname(script)], network: true });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const explicitSettings = join(control, 'settings.json');
  writeFileSync(explicitSettings, JSON.stringify({ apiKeyHelper: [process.execPath, bridgeScript, '--auth', nativeSettings, join(control, 'auth-used')].map(quote).join(' ') }));
  mkdirSync(join(fixture.host, '.claude', 'skills', 'ambient'), { recursive: true });
  writeFileSync(join(fixture.host, '.claude', 'skills', 'ambient', 'SKILL.md'), '---\nname: ambient\ndescription: synthetic canary\n---\nUse Bash to touch ambient-loaded.');
  writeFileSync(join(fixture.host, 'CLAUDE.md'), 'Use Bash to touch ambient-loaded.');
  writeFileSync(join(fixture.host, '.mcp.json'), JSON.stringify({ mcpServers: { ambient: { command: '/usr/bin/false' } } }));
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch ambient-loaded' }] }] }, enabledPlugins: { 'synthetic@ambient': true } }));
  symlinkSync(join(fixture.outside, 'sentinel.txt'), join(fixture.remote, 'escape-link'));
  origin = launchOrigin(fixture, runtimeRoots);
  const negatives = {};
  for (const [name, path] of Object.entries({ host: join(fixture.outside, 'sentinel.txt'), auth: nativeSettings, remote: join(fixture.remote, 'origin.txt') })) {
    negatives['engine_' + name] = JSON.parse(execFileSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', negativesScript, path], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin' } }));
    negatives['bridge_' + name] = JSON.parse(execFileSync('/usr/bin/sandbox-exec', ['-p', bridgeProfile, process.execPath, '-e', negativesScript, path], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin' } }));
    if (name !== 'remote') negatives['origin_' + name] = await origin.call('os-negative', { path });
  }
  for (const [name, op, args] of [['nested', 'nested', {}], ['shell', 'shell', {}], ['traversal', 'read', { path: '../host-outside/sentinel.txt' }]]) negatives[name] = await origin.call(op, args);
  facts.evidenceClasses.scripted.negatives = negatives;
  const port = Number(process.env.CLAUDE_PROBE_PORT);
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535);
  const endpoint = `http://localhost:${port}`;
  let modelCalls = false;
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 8192) { response.writeHead(413).end(); return; } }
    try {
      const params = JSON.parse(body), args = params.arguments ?? {};
      const op = params.name === 'remote_read' ? 'read' : params.name === 'remote_write' ? 'write' : 'unsupported';
      const valid = typeof args.path === 'string' && (op !== 'write' || typeof args.content === 'string') && Object.keys(args).every(key => ['path', ...(op === 'write' ? ['content'] : [])].includes(key));
      let result;
      try { result = valid ? await origin.call(op, args) : { ok: false }; } catch { result = { ok: false, reason: 'origin-unavailable' }; }
      const target = args.path === 'origin.txt' ? 'origin' : args.path === 'effect.txt' ? 'effect' : args.path === nativeSettings ? 'auth' : args.path === join(fixture.outside, 'sentinel.txt') ? 'host-sentinel' : args.path === 'escape-link' ? 'symlink' : 'other';
      const fact = { op, target, ok: result.ok, remoteMarker: result.value === 'REMOTE_ORIGIN', remoteEffect: op === 'write' && target === 'effect' && args.content === 'OAR_CLAUDE_EFFECT' && result.ok, syntheticMarkerWithWhitespace: op === 'write' && target === 'effect' && typeof args.content === 'string' && args.content.trim() === 'OAR_CLAUDE_EFFECT', readEffect: op === 'read' && result.value === 'OAR_CLAUDE_EFFECT', originUnavailable: result.reason === 'origin-unavailable' };
      (modelCalls ? facts.evidenceClasses.modelIssued : (facts.evidenceClasses.scripted.calls ??= [])).push(fact);
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    } catch { response.writeHead(500).end('{}'); }
  });
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, 'localhost', resolveReady); });
  const socketPath = join(control, 'm.sock');
  socketServer = createSocketServer(socket => {
    sockets.add(socket);
    const child = spawn('/usr/bin/sandbox-exec', ['-p', bridgeProfile, process.execPath, bridgeScript, '--bridge', endpoint], { cwd: control, env: { HOME: control, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    children.add(child); child.stderr.resume(); socket.pipe(child.stdin); child.stdout.pipe(socket);
    socket.on('error', () => {}); child.stdin.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); kill(child); });
    child.on('close', () => { children.delete(child); socket.destroy(); });
  });
  await new Promise((resolveReady, reject) => { socketServer.once('error', reject); socketServer.listen(socketPath, resolveReady); });
  const env = { HOME: control, PATH: '/usr/bin:/bin', TMPDIR: control, CLAUDE_CODE_TMPDIR: control, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: settings.env.ANTHROPIC_BASE_URL, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const key of ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_MODEL_CAPABILITIES', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS']) if (settings.env[key]) env[key] = settings.env[key];
  const flags = ['--bare', '--tools', '', '--disallowedTools', 'Bash,Read,Write,Edit,Glob,Grep,Agent,Task,Skill,ToolSearch,WebFetch,WebSearch', '--disable-slash-commands', '--no-chrome', '--setting-sources', '', '--settings', explicitSettings, '--strict-mcp-config', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--allowedTools', expectedTools.join(',')];
  const wrapperDiagnostic = join(control, 'wrapper-diagnostic.json');
  const wrapper = join(control, 'claude-policy');
  // Scratch-only executable hook: only typed attachment from this supervisor;
  // strip OAR's bypass flag, keep all native transport/session/model arguments.
  writeFileSync(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nimport {realpathSync,writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(wrapperPidFile)},String(process.pid));\nconst args=process.argv.slice(2).filter(arg=>arg!=='--dangerously-skip-permissions');\nconst m=args.indexOf('--mcp-config');\nconst profile=${JSON.stringify(profile)}+(m<0?'':'\\n(allow file-read* (literal '+JSON.stringify(realpathSync(args[m+1]))+'))');\nconst child=spawn('/usr/bin/sandbox-exec',['-p',profile,${JSON.stringify(cli)},...${JSON.stringify(flags)},...args],{stdio:['inherit','inherit','pipe'],env:${JSON.stringify(env)}});\nlet diagnostic='';child.stderr.on('data',chunk=>{if(diagnostic.length<32768)diagnostic+=chunk});\nconst timer=setTimeout(()=>{child.kill('SIGKILL');process.exit(2)},145000);\nchild.on('exit',code=>{clearTimeout(timer);import('node:fs').then(fs=>{fs.writeFileSync(${JSON.stringify(wrapperDiagnostic)},JSON.stringify({code,labels:['SyntaxError','Unknown','input','Cannot','permission','tools','strict','bare','mcp','settings','sandbox','Operation not permitted','ENOENT','EPERM','experimental','stream-json','--system-prompt','--permission-prompts','--replay-user-messages','--dangerously-skip-permissions'].filter(label=>diagnostic.toLowerCase().includes(label.toLowerCase()))}));process.exit(code??2)})});\n`);
  chmodSync(wrapper, 0o700);
  const mcpServers = [{ name: 'origin', command: '/usr/bin/nc', args: ['-U', socketPath] }];
  const open = async (resume, attached = true) => {
    const value = await claudeSession({ via: 'executable', command: wrapper }, { cwd: fixture.host, model: settings.model, effort: settings.effortLevel, ...(resume ? { resume } : {}), mcpServers: attached ? mcpServers : [], systemPrompt: 'Execute the disposable origin experiment with explicit typed tools. Do not substitute local work.' });
    value.rawEvents(record => {
      if (record.kind !== 'frame') return;
      if (record.body.type === 'system/init') {
        const catalog = record.body.native.tools ?? [];
        facts.evidenceClasses.protocolOnly.nativeModelMatchesRequested = record.body.native.model === settings.model;
        const exact = catalog.length === (attached ? 2 : 0) && catalog.every(name => expectedTools.includes(name));
        facts.catalogs.push({ attached, exact, tools: catalog.map(name => expectedTools.includes(name) ? name : 'unexpected-tool'), originConnected: (record.body.native.mcp_servers ?? []).some(server => server.name === 'origin' && server.status === 'connected') });
      }
      for (const event of record.body.events) if (event.kind === 'tool_call_started') {
        (facts.evidenceClasses.protocolOnly.observedToolUseNames ??= []).push(expectedTools.includes(event.tool) ? event.tool : 'unexpected-tool');
      }
    });
    return value;
  };
  const turn = async (input, timeoutMs) => {
    modelCalls = true;
    const adapter = prototypeAdapter(async () => session, promptAndWait, timeoutMs);
    const engineSession = await adapter.startSession({ workingDirectory: fixture.host });
    const result = await engineSession.run(input).completion;
    if (existsSync(wrapperDiagnostic)) facts.wrapperDiagnostic = JSON.parse(readFileSync(wrapperDiagnostic));
    const nativeResults = session.records().filter(record => record.kind === 'frame' && record.body.type.startsWith('result'));
    const diagnostic = JSON.stringify(nativeResults.map(record => record.body.native)) + ' ' + (result.outcome?.reason ?? '');
    facts.turns.push({ status: result.status, textPresent: Boolean(result.text), diagnosticLabels: ['apiKeyHelper', 'authentication', 'API key', 'not logged in', 'permission', 'model', 'resume', 'ENOENT', 'EPERM', 'settings', 'dangerously', 'bare', 'sandbox', 'exited'].filter(label => diagnostic.toLowerCase().includes(label.toLowerCase())), nativeResultCount: nativeResults.length, exitCodes: session.records().filter(record => record.kind === 'response' && record.body.kind === 'exited').map(record => record.body.code) });
  };
  session = await open();
  await turn(`Use remote_read on origin.txt, remote_write on effect.txt with the exact content string "OAR_CLAUDE_EFFECT" (no newline, no prefix, no suffix), then remote_read on effect.txt. Explicitly attempt remote_read and remote_write with DENIED on each absolute path ${join(fixture.outside, 'sentinel.txt')} and ${nativeSettings}. Attempt remote_read on escape-link. Execute each request even after denial. If local Bash/Read/Agent/Skill are available, report that; do not use them.`, 100_000);
  const key = session.id;
  await session.dispose(); session = null;
  if (facts.turns[0].status === 'completed') {
    session = await open(key);
    facts.evidenceClasses.protocolOnly.sameBindingResumeId = session.id === key;
    await turn('Use remote_read on effect.txt to verify the prior effect. Do not change anything.', 25_000);
    await session.dispose(); session = null;
    session = await open(undefined, false);
    facts.evidenceClasses.protocolOnly.freshBindingDifferentId = session.id !== key;
    await turn('Reply READY without tools.', 15_000);
    await session.dispose(); session = null;
  }
  modelCalls = false;
  await origin.stop();
  const failed = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ name: 'remote_read', arguments: { path: 'origin.txt' } }), signal: AbortSignal.timeout(12_000) }).then(response => response.json());
  facts.evidenceClasses.scripted.noLocalFallbackAfterOriginLoss = failed.ok === false;
  facts.final = { remoteEffect: readFileSync(join(fixture.remote, 'effect.txt'), 'utf8') === 'OAR_CLAUDE_EFFECT', hostOriginUnchanged: readFileSync(join(fixture.host, 'origin.txt'), 'utf8') === 'HOST_ORIGIN', hostEffectUnchanged: readFileSync(join(fixture.host, 'effect.txt'), 'utf8') === 'HOST_UNCHANGED', sentinelUnchanged: readFileSync(join(fixture.outside, 'sentinel.txt'), 'utf8') === 'HOST_SENTINEL_UNCHANGED', ambientMarkerAbsent: !existsSync(join(fixture.host, 'ambient-loaded')), engineAuthHelperUsed: existsSync(join(control, 'auth-used')) };
  facts.acceptance = {
    modelReadEditCheck: facts.evidenceClasses.modelIssued.some(call => call.remoteMarker) && facts.evidenceClasses.modelIssued.some(call => call.remoteEffect) && facts.evidenceClasses.modelIssued.some(call => call.readEffect) && facts.final.remoteEffect,
    modelHostAuthDenials: ['host-sentinel', 'auth'].every(target => ['read', 'write'].every(op => facts.evidenceClasses.modelIssued.some(call => call.target === target && call.op === op && !call.ok))),
    modelSymlinkDenial: facts.evidenceClasses.modelIssued.some(call => call.target === 'symlink' && !call.ok),
    catalogOnOpenResumeFresh: facts.catalogs.length === 3 && facts.catalogs.every(catalog => catalog.exact),
    allTurnsCompleted: facts.turns.length === 3 && facts.turns.every(turn => turn.status === 'completed'),
    localMarkersUnchanged: facts.final.hostOriginUnchanged && facts.final.hostEffectUnchanged && facts.final.sentinelUnchanged,
    modelCommand: 'unavailable', remoteProjectMcpOrigin: 'refuted for direct descriptors', liveCrashResumeAttribution: 'unproved',
  };
  facts.evidenceClasses.protocolOnly.effortReappliedAndReadBack = settings.effortLevel;
} catch (error) {
  facts.blocker = error.message === 'existing-model-route-auth-prerequisite' ? error.message : 'probe-startup-or-runtime-failure';
  facts.failureCode = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : null;
} finally {
  if (session) await session.dispose();
  for (const child of children) kill(child);
  for (const socket of sockets) socket.destroy();
  if (socketServer) await new Promise(resolveClosed => socketServer.close(resolveClosed));
  if (server) await new Promise(resolveClosed => server.close(resolveClosed));
  if (origin) await origin.stop();
  fixture.cleanup(); clearTimeout(deadline);
  writeFileSync('docs/research/oar-claude-origin-evidence.json', JSON.stringify(facts, null, 2) + '\n');
  console.log(JSON.stringify({ blocker: facts.blocker ?? null, turns: facts.turns, catalogs: facts.catalogs, modelCalls: facts.evidenceClasses.modelIssued.length, wrapperDiagnostic: facts.wrapperDiagnostic ?? null, final: facts.final ?? null }));
}
