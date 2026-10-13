import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OarEngineAdapter } from './oar.ts';
import { EngineStartError } from './port.ts';

import { assertOarRuntimePolicy, prepareOarRuntimePolicy } from './oar-runtime-policy.ts';

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

// Risk: session overlays lose project configuration, race another session, or follow symlinks.
test('Pi policy restores original bytes and permissions and refuses concurrent or symlinked settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-settings-'));
  const pi = join(root, '.pi');
  const settings = join(pi, 'settings.json');
  mkdirSync(pi);
  const original = '{ "defaultTools": ["bash"], "extensions": ["./custom.ts"], "theme": "dark" }\n';
  writeFileSync(settings, original, { mode: 0o640 });
  try {
    const lease = prepareOarRuntimePolicy('pi', root)!;
    assertOarRuntimePolicy('pi', { cwd: lease.descriptor.cwd }, lease.descriptor);
    assert.throws(() => prepareOarRuntimePolicy('pi', root), /route is blocked/);
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).theme, 'dark');
    lease.close(); lease.close();
    assert.equal(readFileSync(settings, 'utf8'), original);
    assert.equal(statSync(settings).mode & 0o777, 0o640);
    assert.equal(existsSync(lease.descriptor.agentDir), false);
    rmSync(settings);
    symlinkSync(join(root, 'outside'), settings);
    assert.throws(() => prepareOarRuntimePolicy('pi', root), /route is blocked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Risk: spawn failure leaks the temporary project policy or a modified policy reaches OAR.
test('Pi policy fails closed on tampering and restores after runner spawn failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-cleanup-'));
  try {
    const lease = prepareOarRuntimePolicy('pi', root)!;
    writeFileSync(join(root, '.pi', 'settings.json'), '{}');
    assert.throws(() => assertOarRuntimePolicy('pi', { cwd: root }, lease.descriptor), /route is blocked/);
    lease.close();
    assert.equal(existsSync(join(root, '.pi')), false);
    const adapter = new OarEngineAdapter({ runtimeId: 'pi', spawnProcess: () => { throw new Error('spawn failure'); } });
    await assert.rejects(adapter.startSession({ agentId: 'fixture', workingDirectory: root }), /spawn failure/);
    assert.equal(existsSync(join(root, '.pi')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Risk: a direct start command enters the vendor loader despite adapter refusal.
test('real OAR runner rejects Pi before configuration and trust-store creation', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-blocked-'));
  const agentDir = join(root, 'agent');
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
