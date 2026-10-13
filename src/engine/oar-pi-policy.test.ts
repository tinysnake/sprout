import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRuntimes } from '@botiverse/oar';
import { OarEngineAdapter, type OarRunnerProcess } from './oar.ts';
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

// Risk: absence of an explicit approval silently falls back to an ambient provider.
test('Pi provider is unavailable without explicit approved models', { timeout: 60000 }, async (t) => {
  const installation = await defaultRuntimes.require('pi').installation?.();
  if (installation?.kind !== 'available') {
    t.skip('Pi runtime is not available on this host');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-no-provider-'));
  let runner: OarRunnerProcess | undefined;
  let runnerClosed: Promise<void> | undefined;
  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: (command, args, options) => {
      const child = spawn(command, [...args], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.detached !== undefined ? { detached: options.detached } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      runner = child as unknown as OarRunnerProcess;
      runnerClosed = new Promise((resolve) => child.once('close', () => resolve()));
      return runner;
    },
  });
  let session: Awaited<ReturnType<typeof adapter.startSession>> | undefined;
  let startError: unknown;
  try {
    try {
      session = await adapter.startSession({
        agentId: 'fixture',
        workingDirectory: root,
        model: 'sprout-unapproved-fixture/model',
      });
    } catch (error) {
      startError = error;
    }
    await session?.close();
    if (runnerClosed) await runnerClosed;

    assert.ok(startError instanceof EngineStartError, 'The adapter refuses provider resolution during session start');
    assert.match(startError.message, /model sprout-unapproved-fixture\/model is not registered/i);
    if (runnerClosed) await runnerClosed;
  } finally {
    await session?.close();
    if (runner && runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    if (runnerClosed) await runnerClosed;
    rmSync(root, { recursive: true, force: true });
  }
});

// Risk: implicit host discovery turns ambient provider configuration into approval.
test('Pi models are written only from explicit approval; ambient configuration is ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-pi-model-approval-'));
  const ambient = join(root, 'ambient');
  mkdirSync(ambient);
  const ambientModels = { providers: { ambient: { baseUrl: 'https://ambient.invalid', api: 'openai-completions', models: [{ id: 'ambient-model' }] } } };
  writeFileSync(join(ambient, 'models.json'), JSON.stringify(ambientModels));
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  const explicitModels = {
    providers: {
      approved: {
        baseUrl: 'https://approved.invalid',
        api: 'openai-completions',
        models: [{ id: 'approved-model', name: 'Approved fixture', reasoning: false, contextWindow: 4096, maxTokens: 512 }],
      },
    },
  };
  try {
    process.env.PI_CODING_AGENT_DIR = ambient;
    const withoutApproval = prepareOarRuntimePolicy('pi', root)!;
    assert.equal(existsSync(join(withoutApproval.descriptor.agentDir, 'models.json')), false);
    withoutApproval.close();

    const withApproval = prepareOarRuntimePolicy('pi', root, { models: explicitModels })!;
    const modelsPath = join(withApproval.descriptor.agentDir, 'models.json');
    assert.deepEqual(JSON.parse(readFileSync(modelsPath, 'utf8')), explicitModels);
    assert.equal(statSync(modelsPath).mode & 0o777, 0o600);
    withApproval.close();
  } finally {
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    rmSync(root, { recursive: true, force: true });
  }
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
