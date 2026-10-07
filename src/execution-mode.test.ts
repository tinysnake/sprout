import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createExecutionStrategy, parseExecutionModeArguments } from './execution-mode.ts';

const timeout = 15_000;

test('execution mode defaults on every parse and accepts only the two immutable process modes', () => {
  assert.equal(parseExecutionModeArguments([]), 'environment-hosted');
  assert.equal(parseExecutionModeArguments(['--execution-mode', 'host-run']), 'host-run');
  assert.equal(parseExecutionModeArguments(['--execution-mode=host-run']), 'host-run');
  assert.equal(parseExecutionModeArguments([]), 'environment-hosted', 'a previous process choice is never persisted');
  assert.equal(parseExecutionModeArguments(['--execution-mode', 'environment-hosted']), 'environment-hosted');

  for (const args of [
    ['--execution-mode'],
    ['--execution-mode', '--execution-mode', 'host-run'],
    ['--execution-mode', 'environment-hosted', '--execution-mode', 'host-run'],
    ['--execution-mode', 'Host-run'],
    ['--execution-mode', 'host-run-extra'],
    ['--execution-mode='],
    ['--execution-mode=host-run', '--execution-mode', 'environment-hosted'],
    ['--unknown'],
  ]) {
    assert.throws(() => parseExecutionModeArguments(args), /execution-mode|startup argument/);
  }
});

test('execution strategy and admission facts are immutable and Host-run refuses admission', () => {
  const environmentHosted = createExecutionStrategy('environment-hosted');
  const hostRun = createExecutionStrategy('host-run');
  assert.ok(Object.isFrozen(environmentHosted));
  assert.ok(Object.isFrozen(environmentHosted.admission));
  assert.ok(Object.isFrozen(hostRun));
  assert.ok(Object.isFrozen(hostRun.admission));
  assert.deepEqual(environmentHosted.admission, { available: true });
  assert.equal(hostRun.admission.available, false);
  assert.match(hostRun.admission.refusal ?? '', /Host-run execution is unavailable/);
});

test('invalid service arguments exit before host configuration, database, or listener setup', { timeout }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sprout-invalid-execution-mode-'));
  try {
    for (const args of [
      ['--execution-mode', 'unsupported'],
      ['--execution-mode'],
      ['--execution-mode', 'host-run', '--execution-mode', 'environment-hosted'],
    ]) {
      const databasePath = join(directory, `db-${args.length}-${args.at(-1) ?? 'missing'}.sqlite`);
      const result = await runMain(args, {
        SPROUT_DATABASE: databasePath,
        SPROUT_RUNTIME_CONFIG: '{malformed-json',
      });
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Usage: npm start/);
      assert.doesNotMatch(result.stderr, /SPROUT_RUNTIME_CONFIG/,
        'argv validation precedes host configuration parsing');
      await assert.rejects(access(databasePath), { code: 'ENOENT' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runMain(args: readonly string[], variables: Record<string, string>): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/main.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...variables },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(killTimer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr });
    });
  });
}
