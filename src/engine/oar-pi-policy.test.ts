import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OarEngineAdapter } from './oar.ts';
import { EngineStartError } from './port.ts';

// Risk: future #232 composition bypasses the blocked loader by constructing the adapter directly.
test('OAR Pi refuses fresh and resumed remote sessions before any runner or bridge effect', async () => {
  let spawns = 0;
  let bridgeCalls = 0;
  const adapter = new OarEngineAdapter({ runtimeId: 'pi', spawnProcess: () => {
    spawns++;
    throw new Error('uncontrolled runner reached');
  } });
  for (const resumeSessionKey of [undefined, 'prior-session']) {
    await assert.rejects(adapter.startSession({
      agentId: 'fixture', workingDirectory: tmpdir(),
      ...(resumeSessionKey ? { resumeSessionKey } : {}),
      get remoteProjectMcp(): never {
        bridgeCalls++;
        throw new Error('uncontrolled bridge reached');
      },
    }), (error: unknown) => error instanceof EngineStartError && /OAR Pi route is blocked/.test(error.message));
  }
  assert.equal(spawns, 0);
  assert.equal(bridgeCalls, 0);
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
