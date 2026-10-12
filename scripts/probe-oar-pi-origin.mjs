/** DISPOSABLE #227: actual, unmodified OAR 0.35.0 + existing Pi 1.0.4.
 * Run with OAR_PROBE_ROOT pointing to an unpacked pinned package. No installs/login.
 * Only allowlisted facts leave the engine; shared #239 fixture is extended additively.
 */
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, symlinkSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { makeOriginFixture, launchOrigin, fileIsolationProfile } from './prototype-origin-fixture.mjs';
const self = fileURLToPath(import.meta.url);
const requiredModel = 'magpie/codex/gpt-6.1-sol';
function denied(path, flag) {
  try { const fd = openSync(path, flag); closeSync(fd); return false; }
  catch (error) { return ['EPERM', 'EACCES'].includes(error.code); }
}
const extension = `export default function(pi) {
  const state = globalThis.__oarOriginProbe;
  state.pi = pi;
  pi.registerProvider(state.provider);
  for (const op of ['read', 'write', 'command']) pi.registerTool({
    name: 'remote_' + op, label: 'Fixture ' + op, description: 'Typed operation on the pinned separate fixture origin.',
    parameters: op === 'command'
      ? { type: 'object', properties: { executable: { type: 'string', enum: ['fixture-origin-command'] } }, required: ['executable'], additionalProperties: false }
      : { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: op === 'read' ? ['path'] : ['path', 'content'], additionalProperties: false },
    execute: async (_id, args) => {
      const result = await state.call(op, args);
      state.calls.push({ op, read: op === 'read' && result.value === 'REMOTE_ORIGIN', effect: op === 'write' && args.path === 'effect.txt' && args.content === 'OAR_MODEL_EFFECT' && result.ok, command: op === 'command' && result.ok && result.value === 'REMOTE_ORIGIN', sentinel: args.path === state.sentinel, denied: !result.ok });
      return { content: [{ type: 'text', text: result.ok ? result.value : 'DENIED_BY_EXECUTION_POLICY' }], details: {} };
    }
  });
  pi.on('session_start', () => {
    pi.setActiveTools(['remote_read', 'remote_write', 'remote_command']);
    state.catalogExact = JSON.stringify(pi.getActiveTools().sort()) === JSON.stringify(['remote_command', 'remote_read', 'remote_write']);
    state.extensionStarts++;
  });
  pi.on('tool_call', event => {
    if (!['remote_read', 'remote_write', 'remote_command'].includes(event.toolName)) return { block: true, reason: 'fixture-policy-denied' };
  });
}`;
async function engine(config) {
  const facts = { opened: false, modelTurnAttempted: false, modelIssued: false, extensionStarts: 0 };
  let session, stage = 'imports';
  const pending = new Map(); let next = 0;
  process.on('message', reply => { const waiter = pending.get(reply.id); if (waiter) { pending.delete(reply.id); waiter(reply.result); } });
  const call = (op, args) => new Promise(resolveReply => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); resolveReply({ ok: false }); }, 10000);
    pending.set(id, result => { clearTimeout(timer); resolveReply(result); });
    process.send({ id, op, args });
  });
  try {
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '@earendil-works/pi-coding-agent') return { url: pathToFileURL(join(config.pi, 'dist/index.js')).href, shortCircuit: true };
      if (specifier === '@earendil-works/pi-ai/compat') return { url: pathToFileURL(join(dirname(config.pi), 'pi-ai/dist/compat.js')).href, shortCircuit: true };
      return nextResolve(specifier, context);
    } });
    const { createMagpieProvider } = await import(pathToFileURL(join(config.providerRoot, 'provider.ts')).href);
    const state = globalThis.__oarOriginProbe = { provider: createMagpieProvider().provider, calls: [], sentinel: config.sentinel, extensionStarts: 0, catalogExact: false };
    const binding = { projectId: 'fixture-project', environmentInstanceId: 'fixture-origin', bindingId: 'fixture-binding', generation: 1, connectionEpoch: 1, workspaceId: 'fixture-workspace' };
    let operationSequence = 0;
    /** @type {import('../src/engine/port.ts').RemoteWorkspaceTools} */
    const authority = {
      binding, operations: ['read', 'edit', 'command'],
      async read(path) {
        const result = await call('read', { path });
        return { ...binding, operationId: `fixture-${++operationSequence}`, operation: 'read', status: result.ok ? 'completed' : 'failed', ...(result.ok ? { content: result.value } : { failure: 'origin-denied-or-unavailable' }) };
      },
      async edit(path, oldText, newText) {
        const before = await call('read', { path });
        const result = before.ok && before.value === oldText ? await call('write', { path, content: newText }) : { ok: false };
        return { ...binding, operationId: `fixture-${++operationSequence}`, operation: 'edit', status: result.ok ? 'completed' : 'failed' };
      },
      async command(executable, args, options, operationId) {
        const result = await call('command', { executable, args, ...options });
        return { ...binding, operationId, operation: 'command', status: result.ok ? 'completed' : 'failed', ...(result.ok ? { output: result.value, exitCode: result.exitCode } : { failure: 'origin-denied-or-unavailable' }) };
      },
      async search() { throw new Error('fixture-search-unsupported'); },
      async inspect() { return { status: 'unsupported' }; },
      async cancel() { return { accepted: false, status: 'unsupported' }; },
    };
    facts.hostReadDenied = denied(config.sentinel, 'r');
    facts.hostWriteDenied = denied(config.sentinel, 'r+');
    facts.directOriginReadDenied = denied(join(config.remote, 'origin.txt'), 'r');
    facts.authReadable = !denied(config.auth, 'r');
    facts.authWriteDenied = denied(config.auth, 'r+');
    const { piSession } = await import(pathToFileURL(join(config.oar, 'dist/runtimes/pi/session.js')).href);
    const { promptAndWait } = await import(pathToFileURL(join(config.oar, 'dist/observe/turns.js')).href);
    // Local implementation of the existing EngineAdapter/EngineSession shape;
    // no product export, alternate admission path, or production registration.
    let attachMcp = true;
    /** @type {import('../src/engine/port.ts').EngineAdapter} */
    const adapter = {
      id: 'pi', capabilities: { streaming: 'none', supportsInterrupt: true, standingInstructions: 'out-of-band' },
      async startSession(request) {
        if (request.remoteWorkspace !== authority) throw new Error('fixture-authority-required');
        state.catalogExact = false;
        state.pi = undefined;
        state.call = async (op, args) => {
          const result = op === 'read' ? await request.remoteWorkspace.read(args.path)
            : op === 'command' ? await request.remoteWorkspace.command(args.executable, [], { cwd: '.', timeoutMs: 5000 }, `fixture-${++operationSequence}`)
            : await request.remoteWorkspace.edit(args.path, 'REMOTE_UNCHANGED', args.content);
          return { ok: result.status === 'completed', value: result.content ?? result.output ?? 'remote-write-observed' };
        };
        session = await piSession({ via: 'bundled' }, { cwd: request.workingDirectory, model: requiredModel, effort: 'low', appendSystemPrompt: request.instructions, ...(request.resumeSessionKey ? { resume: request.resumeSessionKey } : {}), ...(attachMcp ? { mcpServers: [{ name: 'fixture', command: process.execPath, args: [self, '--mcp', config.host] }] } : {}) });
        return {
          sessionId: session.id,
          engineSessionKey: session.id,
          run(prompt) { return { events: (async function* () {})(), completion: promptAndWait(session, prompt, { timeoutMs: 60000 }).then(result => {
            state.lastTurnKind = result.kind;
            state.lastTurnOutcome = result.outcome?.kind;
            return result.kind === 'ended' && result.outcome.kind === 'completed' ? { status: 'completed', text: result.text } : { status: 'failed', message: 'prototype-turn-not-completed' };
          }) }; },
          interrupt: async () => (await session.abort()).kind === 'accepted', close: async () => { await session.dispose(); },
        };
      },
    };
    stage = 'open';
    let wrapped = await adapter.startSession({ agentId: 'fixture-agent', remoteWorkspace: authority, workingDirectory: config.host, instructions: 'Disposable origin experiment. Complete the requested typed calls.' });
    facts.opened = true;
    facts.catalogExact = state.catalogExact;
    facts.modelIdentityExact = session.model().value === requiredModel;
    if (![facts.catalogExact, facts.modelIdentityExact, facts.hostReadDenied, facts.hostWriteDenied, facts.directOriginReadDenied, facts.authReadable, facts.authWriteDenied].every(Boolean)) return { ...facts, blocker: 'controls-incomplete' };
    stage = 'turn'; facts.modelTurnAttempted = true;
    const turn = await wrapped.run(`Call remote_read with path origin.txt; call remote_write with path effect.txt and content OAR_MODEL_EFFECT. Explicitly attempt remote_read and remote_write with path ${config.sentinel} and content DENIED_ATTEMPT. Call remote_command with executable fixture-origin-command. Complete all five calls, even when denied.`).completion;
    facts.turnEnded = turn.status === 'completed';
    facts.turnKind = state.lastTurnKind;
    facts.turnOutcome = state.lastTurnOutcome;
    facts.mcpRegistered = state.pi.getAllTools().some(tool => tool.name === 'mcp__fixture__ping');
    const mcpPid = existsSync(join(config.host, 'mcp-pid.txt')) ? Number(readFileSync(join(config.host, 'mcp-pid.txt'), 'utf8')) : null;
    facts.modelIssued = state.calls.length > 0;
    facts.originRead = state.calls.some(c => c.read);
    facts.remoteEffect = state.calls.some(c => c.effect);
    facts.commandOriginRead = state.calls.some(c => c.command);
    facts.modelCommandCalls = state.calls.filter(c => c.op === 'command').length;
    facts.sentinelReadDenied = state.calls.some(c => c.op === 'read' && c.sentinel && c.denied);
    facts.sentinelWriteDenied = state.calls.some(c => c.op === 'write' && c.sentinel && c.denied);
    const key = wrapped.engineSessionKey;
    await wrapped.close(); session = undefined;
    facts.mcpShutdownStopped = mcpPid !== null && (() => { try { process.kill(mcpPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } })();
    stage = 'resume';
    wrapped = await adapter.startSession({ agentId: 'fixture-agent', remoteWorkspace: authority, workingDirectory: config.host, resumeSessionKey: key, instructions: 'Current fixture controls still apply.' });
    facts.resumedSameId = wrapped.engineSessionKey === key;
    facts.resumeCatalogExact = state.catalogExact;
    facts.resumeModelExact = session.model().value === requiredModel;
    stage = 'resume-turn';
    const beforeResumeCalls = state.calls.length;
    const resumed = await wrapped.run('Call remote_read with path origin.txt once, then finish.').completion;
    facts.resumeTurnEnded = resumed.status === 'completed';
    facts.resumeTurnKind = state.lastTurnKind;
    facts.resumeTurnOutcome = state.lastTurnOutcome;
    facts.resumeOriginRead = state.calls.slice(beforeResumeCalls).some(c => c.read);
    facts.resumeMcpRegistered = state.pi.getAllTools().some(tool => tool.name === 'mcp__fixture__ping');
    facts.extensionStarts = state.extensionStarts;
    facts.toolCalls = state.calls.length;
    // Kill the separate origin, then call the exact same bridge. No local executor.
    await call('stop-origin', {});
    const failure = await authority.read('origin.txt');
    facts.remoteFailureNoFallback = failure.status === 'failed';
    const commandFailure = await authority.command('fixture-origin-command', [], { cwd: '.', timeoutMs: 5000 }, `fixture-${++operationSequence}`);
    facts.commandFailureNoFallback = commandFailure.status === 'failed';
    await wrapped.close(); session = undefined;
    attachMcp = false;
    stage = 'fresh';
    wrapped = await adapter.startSession({ agentId: 'fixture-agent', remoteWorkspace: authority, workingDirectory: config.host, instructions: 'Fresh binding alternative, no old MCP attachment.' });
    facts.freshSessionDifferentId = wrapped.engineSessionKey !== key;
    facts.freshCatalogExact = state.catalogExact;
    facts.freshMcpWithdrawn = !state.pi.getAllTools().some(tool => tool.name === 'mcp__fixture__ping');
    facts.extensionStarts = state.extensionStarts;
  } catch (error) {
    facts.blocker = 'oar-start-or-turn-unproved'; facts.failureStage = stage;
    facts.errorCode = ['EPERM', 'EACCES', 'ENOENT', 'ERR_MODULE_NOT_FOUND'].includes(error.code) ? error.code : 'other';
    facts.errorKind = ['model', 'lock', 'extension', 'provider', 'module', 'permission', 'trust'].find(word => String(error.message).toLowerCase().includes(word)) || 'unclassified';
  } finally { if (session) await Promise.race([session.dispose(), new Promise(r => setTimeout(r, 11000))]); }
  return facts;
}
if (process.argv[2] === '--mcp') {
  // Pure synthetic MCP protocol fixture, not a remote MCP origin or general proxy.
  writeFileSync(join(process.argv[3], 'mcp-pid.txt'), String(process.pid));
  const timer = setTimeout(() => process.exit(2), 120000);
  const { createInterface } = await import('node:readline');
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    try {
      const request = JSON.parse(line); if (request.id === undefined) return;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'disposable-fixture', version: '1' } };
      else if (request.method === 'tools/list') result = { tools: [{ name: 'ping', description: 'Synthetic typed registration fixture', inputSchema: { type: 'object', properties: {} } }] };
      else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'SYNTHETIC_MCP' }] };
      else result = {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch { /* no native payload retained */ }
  });
  lines.on('close', () => { clearTimeout(timer); process.exit(0); });
} else if (process.argv[2] === '--engine') {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  console.log(JSON.stringify(await engine(JSON.parse(input))));
  process.disconnect();
} else {
  const deadline = setTimeout(() => process.exit(2), 170000);
  const fixture = makeOriginFixture(); let origin;
  const summary = { oar: '0.35.0', pi: '1.0.4', node: process.version, platform: process.platform, selectedModel: requiredModel, modelIssued: false };
  try {
    if (process.platform !== 'darwin' || !process.env.OAR_PROBE_ROOT) throw new Error('prerequisite');
    const oar = realpathSync(process.env.OAR_PROBE_ROOT);
    const pi = realpathSync(process.env.PI_PROBE_PACKAGE_ROOT || join(homedir(), '.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent'));
    if (JSON.parse(readFileSync(join(oar, 'package.json'))).version !== '0.35.0' || JSON.parse(readFileSync(join(pi, 'package.json'))).version !== '1.0.4') throw new Error('version');
    summary.osVersion = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5000 }).stdout.trim();
    summary.piAi = JSON.parse(readFileSync(join(dirname(pi), 'pi-ai/package.json'))).version;
    summary.piMcp = JSON.parse(readFileSync(join(dirname(pi), 'pi-mcp/package.json'))).version;
    const authDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
    const auth = join(authDir, 'auth.json');
    const providerRoot = realpathSync(resolve(process.env.PI_PROBE_PROVIDER_ROOT || '../pi-extensions/pi-magpie'));
    const providerFiles = ['provider.ts', 'catalog.ts', 'constants.ts', 'gateway.ts', 'package.json'].map(name => join(providerRoot, name));
    // Symlinks preserve host-local storage; OS denies writes to the actual targets.
    // Lock sidecars live in scratch. No credential/catalog contents are copied.
    const readFiles = [auth, ...providerFiles];
    for (const name of ['auth.json', 'models.json', 'models-store.json']) {
      const source = join(authDir, name);
      if (existsSync(source)) { symlinkSync(source, join(fixture.host, name)); readFiles.push(source); }
    }
    mkdirSync(join(fixture.host, 'extensions'));
    writeFileSync(join(fixture.host, 'extensions', 'origin.js'), extension);
    writeFileSync(join(fixture.host, 'settings.json'), JSON.stringify({ defaultTools: ['remote_read', 'remote_write', 'remote_command'], compaction: { enabled: false }, retry: { enabled: false } }));
    const runtimeRoots = [dirname(dirname(pi)), '/opt/homebrew'];
    origin = launchOrigin(fixture, runtimeRoots);
    summary.scripted = {
      originRead: (await origin.call('read', { path: 'origin.txt' })).value === 'REMOTE_ORIGIN',
      remoteWrite: (await origin.call('write', { path: 'effect.txt', content: 'SCRIPTED_EFFECT' })).ok,
      pathDenied: !(await origin.call('read', { path: join(fixture.outside, 'sentinel.txt') })).ok,
      originOs: await origin.call('os-negative', { path: join(fixture.outside, 'sentinel.txt') }),
    };
    summary.scripted.commandAllowlistDenied = (await Promise.all([
      { executable: '/bin/sh', args: [], cwd: '.', timeoutMs: 5000 },
      { executable: 'fixture-origin-command', args: ['unexpected'], cwd: '.', timeoutMs: 5000 },
      { executable: 'fixture-origin-command', args: [], cwd: fixture.host, timeoutMs: 5000 },
      { executable: 'fixture-origin-command', args: [], cwd: '.', timeoutMs: 180001 },
    ].map(args => origin.call('command', args)))).every(result => !result.ok);
    summary.scripted.commandEffectUntouchedBeforeModel = readFileSync(join(fixture.remote, 'command-effect.txt'), 'utf8') === 'REMOTE_COMMAND_UNCHANGED';
    writeFileSync(join(fixture.remote, 'effect.txt'), 'REMOTE_UNCHANGED');
    const config = { oar, pi, providerRoot, host: fixture.host, remote: fixture.remote, sentinel: join(fixture.outside, 'sentinel.txt'), auth };
    const profile = fileIsolationProfile({ runtimeRoots, readRoots: [fixture.host, dirname(self), oar], writeRoots: [fixture.host], readFiles: [...new Set(readFiles)], network: true });
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, self, '--engine'], { cwd: fixture.host, detached: true, env: { PATH: '/usr/bin:/bin', HOME: fixture.host, OAR_PI_AGENT_DIR: fixture.host, PI_CODING_AGENT_DIR: fixture.host, PI_OFFLINE: '1', PI_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    child.on('message', async request => {
      if (!Number.isSafeInteger(request?.id) || !['read', 'write', 'command', 'stop-origin'].includes(request.op)) return;
      let result;
      if (request.op === 'stop-origin') { await origin.stop(); result = { ok: false }; }
      else if (origin.child.exitCode !== null || origin.child.signalCode !== null) result = { ok: false };
      else { try { result = await origin.call(request.op, request.args); } catch { result = { ok: false }; } }
      if (child.connected) child.send({ id: request.id, result }, () => {});
    });
    let output = ''; child.stdout.on('data', chunk => { if (output.length < 16384) output += chunk; }); child.stderr.resume();
    child.stdin.end(JSON.stringify(config));
    const kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 140000);
    await new Promise(r => child.once('exit', r)); clearTimeout(kill);
    try {
      const raw = JSON.parse(output.trim());
      // Never pass arbitrary native text, errors, paths or model output to artifacts.
      const safeStrings = ['ended', 'interrupted', 'rejected', 'completed', 'failed', 'oar-start-or-turn-unproved', 'controls-incomplete', 'imports', 'open', 'turn', 'resume', 'resume-turn', 'fresh', 'model', 'lock', 'extension', 'provider', 'module', 'permission', 'trust', 'unclassified', 'EPERM', 'EACCES', 'ENOENT', 'ERR_MODULE_NOT_FOUND', 'other'];
      summary.live = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'boolean' || typeof v === 'number' || safeStrings.includes(v)));
      summary.modelIssued = summary.live.modelIssued === true;
    } catch { summary.live = { blocker: 'isolated-engine-no-summary' }; }
    summary.final = { hostOriginUnchanged: readFileSync(join(fixture.host, 'origin.txt'), 'utf8') === 'HOST_ORIGIN', hostEffectUnchanged: readFileSync(join(fixture.host, 'effect.txt'), 'utf8') === 'HOST_UNCHANGED', sentinelUnchanged: readFileSync(config.sentinel, 'utf8') === 'HOST_SENTINEL_UNCHANGED', remoteModelEffect: readFileSync(join(fixture.remote, 'effect.txt'), 'utf8') === 'OAR_MODEL_EFFECT', hostCommandUnchanged: readFileSync(join(fixture.host, 'command-effect.txt'), 'utf8') === 'HOST_COMMAND_UNCHANGED', remoteCommandEffect: readFileSync(join(fixture.remote, 'command-effect.txt'), 'utf8') === 'ORIGIN_COMMAND:REMOTE_ORIGIN' };
  } catch { summary.blocker = 'pinned-package-platform-or-storage-prerequisite'; }
  finally { clearTimeout(deadline); if (origin) await origin.stop(); fixture.cleanup(); }
  console.log(JSON.stringify(summary, null, 2));
}
