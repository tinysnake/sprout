import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OarEngineAdapter, type OarRunnerProcess } from './oar.ts';
import { EngineStartError } from './port.ts';
import { assertOarRuntimePolicy, hostPiConfigurationProvider, prepareOarRuntimePolicy } from './oar-runtime-policy.ts';

// Risk: a failed overlay silently starts an uncontrolled vendor loader.
test('OAR Pi refuses fresh and resumed sessions when project settings cannot be controlled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-refused-'));
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi', 'settings.json'), 'invalid JSON');
  let spawns = 0;
  const adapter = new OarEngineAdapter({ runtimeId: 'pi', spawnProcess: () => {
    spawns++;
    throw new Error('uncontrolled runner reached');
  } });
  try {
    for (const resumeSessionKey of [undefined, 'prior-session']) {
      await assert.rejects(adapter.startSession({
        agentId: 'fixture', workingDirectory: root,
        ...(resumeSessionKey ? { resumeSessionKey } : {}),
      }), (error: unknown) => error instanceof EngineStartError && /OAR Pi route is blocked/.test(error.message));
    }
    assert.equal(spawns, 0);
    assert.equal(readFileSync(join(root, '.pi', 'settings.json'), 'utf8'), 'invalid JSON');
    assert.equal(existsSync(join(root, '.pi', '.sprout-oar-policy')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The route resolves one replaceable provider and pins that same host directory for OAR.
test('Pi host configuration provider follows Pi agent-directory semantics and can be replaced', () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-config-'));
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    assert.equal(hostPiConfigurationProvider.resolve().agentDir, root);
    const replacement = { resolve: () => ({ agentDir: join(root, 'replacement') }) };
    const lease = prepareOarRuntimePolicy('pi', root, { agentDir: replacement.resolve().agentDir })!;
    try {
      assert.equal(lease.descriptor.agentDir, join(root, 'replacement'));
      assert.equal(existsSync(join(lease.descriptor.agentDir, 'settings.json')), true);
    } finally { lease.close(); }
    assert.equal(existsSync(join(lease.descriptor.agentDir, 'settings.json')), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// Risk: session overlays lose host/project settings, race a second session, or follow symlinks.
test('Pi policy empties built-in tools, preserves host configuration, and restores project bytes and permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-settings-'));
  const pi = join(root, '.pi');
  const settings = join(pi, 'settings.json');
  const agentDir = join(root, 'host-agent');
  mkdirSync(pi);
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  const original = '{ "defaultTools": ["bash", "edit", "write", "read", "codemode"], "extensions": ["./custom.ts"], "theme": "dark" }\n';
  const hostSettings = '{ "defaultTools": ["bash", "edit", "write", "read", "codemode"], "theme": "host" }\n';
  writeFileSync(settings, original, { mode: 0o640 });
  writeFileSync(join(agentDir, 'settings.json'), hostSettings, { mode: 0o600 });
  writeFileSync(join(agentDir, 'models.json'), '{"providers":{"host-extension":{"models":[]}}}', { mode: 0o600 });
  writeFileSync(join(agentDir, 'extensions', 'installed-extension.ts'), 'export default function() {}');
  try {
    const lease = prepareOarRuntimePolicy('pi', root, { agentDir })!;
    assertOarRuntimePolicy('pi', { cwd: lease.descriptor.cwd, disallowedTools: lease.descriptor.disallowedTools }, lease.descriptor);
    assert.throws(() => prepareOarRuntimePolicy('pi', root, { agentDir }), /route is blocked/);
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).defaultTools, []);
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).theme, 'dark');
    assert.equal(statSync(settings).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).defaultTools, []);
    assert.equal(statSync(join(agentDir, 'settings.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(agentDir, '.sprout-oar-policy', 'settings.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, '.pi', '.sprout-oar-policy', 'settings.json')).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).theme, 'host');
    assert.equal(existsSync(join(agentDir, 'extensions', 'installed-extension.ts')), true);
    assert.equal(existsSync(join(agentDir, 'models.json')), true);
    lease.close(); lease.close();
    assert.equal(readFileSync(settings, 'utf8'), original);
    assert.equal(statSync(settings).mode & 0o777, 0o640);
    assert.equal(readFileSync(join(agentDir, 'settings.json'), 'utf8'), hostSettings);
    assert.equal(existsSync(join(root, '.pi', '.sprout-oar-policy')), false);
    assert.equal(existsSync(join(agentDir, '.sprout-oar-policy')), false);
    assert.equal(readFileSync(join(agentDir, 'settings.json'), 'utf8'), hostSettings);
    rmSync(settings);
    symlinkSync(join(root, 'outside'), settings);
    assert.throws(() => prepareOarRuntimePolicy('pi', root, { agentDir }), /route is blocked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Risk: a stale lock must never be treated as permission to reuse uncontrolled settings.
test('Pi policy refuses stale host and project leases without changing either settings file', () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-stale-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'host-agent');
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  mkdirSync(agentDir);
  const projectSettings = join(cwd, '.pi', 'settings.json');
  const agentSettings = join(agentDir, 'settings.json');
  const originalProject = '{ "theme": "project" }\n';
  const originalAgent = '{ "extensions": ["host-extension"] }\n';
  writeFileSync(projectSettings, originalProject);
  writeFileSync(agentSettings, originalAgent);
  try {
    mkdirSync(join(agentDir, '.sprout-oar-policy'));
    assert.throws(() => prepareOarRuntimePolicy('pi', cwd, { agentDir }), /route is blocked/);
    assert.equal(readFileSync(projectSettings, 'utf8'), originalProject);
    assert.equal(readFileSync(agentSettings, 'utf8'), originalAgent);
    rmSync(join(agentDir, '.sprout-oar-policy'), { recursive: true, force: true });
    mkdirSync(join(cwd, '.pi', '.sprout-oar-policy'));
    assert.throws(() => prepareOarRuntimePolicy('pi', cwd, { agentDir }), /route is blocked/);
    assert.equal(readFileSync(projectSettings, 'utf8'), originalProject);
    assert.equal(readFileSync(agentSettings, 'utf8'), originalAgent);
    assert.equal(existsSync(join(agentDir, '.sprout-oar-policy')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Risk: spawn failure leaks the temporary project policy or a modified policy reaches OAR.
test('Pi policy fails closed on tampering and restores after runner spawn failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-cleanup-'));
  const agentDir = join(root, 'host-agent');
  mkdirSync(agentDir);
  try {
    const lease = prepareOarRuntimePolicy('pi', root, { agentDir })!;
    writeFileSync(join(root, '.pi', 'settings.json'), '{}');
    assert.throws(() => assertOarRuntimePolicy('pi', { cwd: root, disallowedTools: lease.descriptor.disallowedTools }, lease.descriptor), /route is blocked/);
    lease.close();
    assert.equal(existsSync(join(root, '.pi')), false);
    const adapter = new OarEngineAdapter({
      runtimeId: 'pi',
      piConfigurationProvider: { resolve: () => ({ agentDir }) },
      spawnProcess: () => { throw new Error('spawn failure'); },
    });
    await assert.rejects(adapter.startSession({ agentId: 'fixture', workingDirectory: root }), /spawn failure/);
    assert.equal(existsSync(join(root, '.pi')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Pi host policy restores exact settings only after forced runner termination is proved', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows process-tree proof remains an explicit acceptance prerequisite');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-process-fence-'));
  const agentDir = join(root, 'host-agent');
  mkdirSync(agentDir);
  mkdirSync(join(root, '.pi'));
  const originalProject = '{ "theme": "project" }\n';
  const originalAgent = '{ "extensions": ["host-extension"] }\n';
  writeFileSync(join(root, '.pi', 'settings.json'), originalProject);
  writeFileSync(join(agentDir, 'settings.json'), originalAgent);
  const runnerScript = join(root, 'runner.mjs');
  const descendantPidFile = join(root, 'descendant.pid');
  const heartbeatFile = join(root, 'descendant.heartbeat');
  writeFileSync(runnerScript, `
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
let descendant;
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.op === 'start') {
    descendant = spawn(process.execPath, ['-e', \`
      const fs = require('node:fs');
      process.on('SIGINT', () => {});
      process.on('SIGTERM', () => {});
      fs.writeFileSync(${JSON.stringify(heartbeatFile)}, String(Date.now()));
      setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeatFile)}, String(Date.now())), 50);
    \`], { stdio: ['ignore', 'ignore', 'ignore'] });
    writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
    process.stdout.write(JSON.stringify({ kind: 'ready', sessionId: 'pi-policy-session', engineSessionKey: 'pi-policy-session' }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`);
  let child: ReturnType<typeof spawn> | undefined;
  let session: Awaited<ReturnType<OarEngineAdapter['startSession']>> | undefined;
  let descendantPid: number | undefined;
  try {
    const adapter = new OarEngineAdapter({
      runtimeId: 'pi', runnerScriptPath: runnerScript,
      piConfigurationProvider: { resolve: () => ({ agentDir }) },
      spawnProcess: (command, args, options) => {
        child = spawn(command, [...args], options as unknown as SpawnOptions);
        return child as unknown as OarRunnerProcess;
      },
    });
    session = await adapter.startSession({ agentId: 'fixture', workingDirectory: root });
    assert.equal(existsSync(join(agentDir, '.sprout-oar-policy')), true, 'the exclusive host policy lease remains held while the runner is live');
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).defaultTools, []);

    const runner = child;
    assert.ok(runner);
    descendantPid = Number(readFileSync(descendantPidFile, 'utf8'));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    const heartbeatDeadline = Date.now() + 2_000;
    while (!existsSync(heartbeatFile) && Date.now() < heartbeatDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(heartbeatFile), true, 'the descendant started its execution heartbeat');
    const initialHeartbeat = readFileSync(heartbeatFile, 'utf8');
    const runnerExited = new Promise<void>((resolve) => runner.once('exit', () => resolve()));
    runner.kill('SIGKILL');
    await runnerExited;
    await new Promise((resolve) => setTimeout(resolve, 2_200));

    assert.notEqual(readFileSync(heartbeatFile, 'utf8'), initialHeartbeat, 'the descendant continues executing after its runner parent dies');
    assert.equal(existsSync(join(agentDir, '.sprout-oar-policy')), true, 'parent death does not release the exclusive host policy lease');
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).defaultTools, [], 'settings remain overlaid while the descendant lives');

    await session.close();

    assert.equal(session.terminationEvidence, 'proved');
    assert.equal(runner.signalCode, 'SIGKILL', 'the runner parent was forcibly terminated');
    assert.equal(readFileSync(join(root, '.pi', 'settings.json'), 'utf8'), originalProject);
    assert.equal(readFileSync(join(agentDir, 'settings.json'), 'utf8'), originalAgent);
    assert.equal(existsSync(join(agentDir, '.sprout-oar-policy')), false);
    assert.equal(existsSync(join(root, '.pi', '.sprout-oar-policy')), false);
  } finally {
    if (session !== undefined && session.terminationEvidence === undefined) await session.close();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
    if (descendantPid !== undefined) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// Risk: a direct start command enters the vendor loader despite a missing policy.
test('real OAR runner rejects Pi before configuration and trust-store creation', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-blocked-'));
  const agentDir = join(root, 'host-agent');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./oar-runner-entry.ts', import.meta.url))], {
    env: { ...process.env, OAR_PI_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  let buffer = '';
  try {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const message = new Promise<any>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('runner did not refuse within 55 seconds')), 55000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('runner exited before refusal')));
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
      });
    });
    child.stdin.write(`${JSON.stringify({ op: 'start', runtimeId: 'pi', options: { cwd: root } })}\n`);
    const response = await message.finally(() => clearTimeout(deadline));
    assert.equal(response.kind, 'error');
    assert.equal(response.stage, 'start');
    assert.match(response.message, /OAR Pi route is blocked/);
    assert.equal(existsSync(agentDir), false);
  } finally {
    child.kill('SIGKILL');
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});

// Source-level ordering is a regression guard; the live probes exercise the successful path.
test('OAR runner asserts policy and pins Pi agent dir before lazy vendor import', () => {
  const source = readFileSync(fileURLToPath(new URL('./oar-runner-entry.ts', import.meta.url)), 'utf8');
  const assertion = source.indexOf('assertOarRuntimePolicy(command.runtimeId, command.options, command.hostPolicy?.pi)');
  const pin = source.indexOf('process.env.OAR_PI_AGENT_DIR = command.hostPolicy!.pi!.agentDir');
  const vendorImport = source.indexOf("await import('@botiverse/oar')");
  assert.ok(assertion >= 0 && pin > assertion && vendorImport > pin);
  assert.match(source, /import type \{ Session \} from '@botiverse\/oar'/);
  assert.doesNotMatch(source, /^import\s+(?!type\b).*from\s+['"]@botiverse\/oar['"]/m);
});
