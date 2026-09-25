import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const runner = new URL('../scripts/test-summary.ts', import.meta.url).pathname;
const { NODE_TEST_CONTEXT: _testContext, ...standaloneEnv } = process.env;

test('bench prints leaf test durations without file or suite totals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprout-bench-'));
  try {
    const fixture = join(dir, 'fixture.test.mjs');
    await writeFile(fixture, `import { test, describe } from 'node:test';
describe('group', () => { test('inside', () => {}); });
test('outside', () => {});
`);
    const { stdout } = await exec(process.execPath, [runner, '--bench', fixture], { timeout: 10_000, env: standaloneEnv });
    assert.match(stdout, /Test durations \(slowest first, 2 results\):/);
    assert.match(stdout, /ms  .*group > inside/);
    assert.match(stdout, /ms  .*outside/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('suite deadline ends a hung test with a nonzero exit and a timeout message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprout-timeout-'));
  try {
    const fixture = join(dir, 'fixture.test.mjs');
    const logPath = join(dir, 'timeouts.jsonl');
    await writeFile(logPath, '{"previous":"timeout"}\n');
    await writeFile(fixture, `import { test } from 'node:test';
test('never resolves', () => new Promise(() => { setInterval(() => {}, 1000); }));
`);
    await assert.rejects(
      exec(process.execPath, [runner, fixture], {
        timeout: 10_000,
        env: { ...standaloneEnv, SPROUT_TEST_TIMEOUT_MS: '800', SPROUT_TEST_TIMEOUT_LOG: logPath },
      }),
      (error: unknown) => {
        const result = error as { code: number; stderr: string };
        assert.equal(result.code, 124);
        assert.match(result.stderr, /Test suite timed out after 800 ms/);
        assert.doesNotMatch(result.stderr, /never resolves/);
        const records = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(records[0], { previous: 'timeout' });
        const record = records[1];
        assert.match(record.candidates[0].file, /fixture\.test\.mjs/);
        assert.equal(record.candidates[0].name, 'never resolves');
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('timeout reports each concurrently active test, not the last completed one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprout-timeout-parallel-'));
  try {
    const logPath = join(dir, 'test-timeout.jsonl');
    const fixtures = await Promise.all(['stuck a', 'stuck b'].map(async (name, index) => {
      const fixture = join(dir, `parallel-${index}.test.mjs`);
      await writeFile(fixture, `import { test } from 'node:test';
test('finished', () => {});
test(${JSON.stringify(name)}, () => new Promise(() => { setInterval(() => {}, 1000); }));
`);
      return fixture;
    }));
    await assert.rejects(
      exec(process.execPath, [runner, ...fixtures], {
        timeout: 10_000,
        cwd: dir,
        env: { ...standaloneEnv, SPROUT_TEST_TIMEOUT_MS: '900' },
      }),
      (error: unknown) => {
        const result = error as { code: number; stderr: string };
        assert.equal(result.code, 124);
        assert.doesNotMatch(result.stderr, /stuck a|stuck b|finished/);
        const record = JSON.parse(readFileSync(logPath, 'utf8').trim());
        assert.deepEqual(record.candidates.map((candidate: { name: string }) => candidate.name).sort(), ['stuck a', 'stuck b']);
        assert.ok(record.candidates.every((candidate: { file: string }) => !candidate.file.startsWith('/')));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
