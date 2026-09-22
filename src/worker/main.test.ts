import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { WORKER_READY_PREFIX } from './carrier.ts';
import { WORKER_DIAGNOSTICS } from './diagnostics.ts';

test('the Worker entry point logs product categories rather than host or network facts', async () => {
  const child = spawn(process.execPath, [new URL('./main.ts', import.meta.url).pathname], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SPROUT_CODEX_BIN: '/synthetic/private/engine/path',
      SPROUT_ENV_INSTANCE: 'private-host-label',
      SPROUT_WORKER_HOST: '127.0.0.1',
      SPROUT_WORKER_PORT: '0',
      SPROUT_WORKSPACE_ROOT: '/synthetic/private/workspace/path',
    },
  });
  let stdout = '';
  let stderr = '';
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  try {
    await waitFor(() => stdout.includes(WORKER_READY_PREFIX) && stderr.includes(WORKER_DIAGNOSTICS.transportReady));
    assert.equal(stderr.trim(), `[sprout-worker] ${WORKER_DIAGNOSTICS.transportReady}`);
    assert.doesNotMatch(stderr, /private-host-label|127\.0\.0\.1|synthetic\/private|codex/i);
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Worker entry point did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
