import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const runner = new URL('../scripts/test-summary.ts', import.meta.url).pathname;
const { NODE_TEST_CONTEXT: _testContext, ...standaloneEnv } = process.env;

const readRun = (obsDir: string): Record<string, unknown>[] => {
  const files = readdirSync(obsDir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1, 'exactly one run file per invocation');
  return readFileSync(join(obsDir, files[0]!), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
};

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
        env: { ...standaloneEnv, SPROUT_TEST_TIMEOUT_MS: '800', SPROUT_TEST_TIMEOUT_LOG: logPath, SPROUT_TEST_OBS_DIR: join(dir, 'obs') },
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
        const run = readRun(join(dir, 'obs'));
        assert.equal(run[0]!.record, 'run_started');
        const summary = run.at(-1)!;
        assert.equal(summary.record, 'run_summary');
        assert.equal(summary.disposition, 'timed_out');
        assert.deepEqual((summary.candidates as { name: string }[]).map((candidate) => candidate.name), ['never resolves']);
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

test('ordinary failure and completed slow success both leave durable records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprout-obs-failure-'));
  try {
    const fixture = join(dir, 'fixture.test.mjs');
    await writeFile(fixture, `import { test } from 'node:test';
import { strict as assert } from 'node:assert';
test('slow success', async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
test('ordinary failure', () => assert.equal(1, 2, 'boom'));
test('skipped case', { skip: true }, () => {});
`);
    await assert.rejects(
      exec(process.execPath, [runner, fixture], {
        timeout: 15_000,
        env: { ...standaloneEnv, SPROUT_TEST_OBS_DIR: join(dir, 'obs') },
      }),
      (error: unknown) => {
        assert.equal((error as { code: number }).code, 1);
        return true;
      },
    );
    const run = readRun(join(dir, 'obs'));
    const started = run[0]!;
    assert.equal(started.record, 'run_started');
    assert.equal(typeof started.commit, 'string');
    assert.equal(typeof started.inventoryDigest, 'string');
    assert.equal(started.concurrency, 4);
    const results = run.filter((record) => record.record === 'test_result');
    const byName = new Map(results.map((record) => [record.name as string, record]));
    const slow = byName.get('slow success')!;
    assert.equal(slow.outcome, 'pass');
    assert.ok((slow.durationMs as number) >= 100, 'completed duration is recorded');
    const failed = byName.get('ordinary failure')!;
    assert.equal(failed.outcome, 'fail');
    assert.equal(failed.classification, 'testCodeFailure');
    assert.equal(byName.get('skipped case')!.outcome, 'skip');
    const summary = run.at(-1)!;
    assert.equal(summary.record, 'run_summary');
    assert.equal(summary.disposition, 'failed');
    assert.deepEqual(summary.counts, { tests: 3, pass: 1, fail: 1, cancelled: 0, skipped: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('per-test deadline with suite deadline unspent records a timeout classification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprout-obs-deadline-'));
  try {
    const fixture = join(dir, 'fixture.test.mjs');
    await writeFile(fixture, `import { test } from 'node:test';
test('per-test deadline', { timeout: 100 }, () => new Promise((resolve) => setTimeout(resolve, 5000)));
`);
    await assert.rejects(
      exec(process.execPath, [runner, fixture], {
        timeout: 15_000,
        env: { ...standaloneEnv, SPROUT_TEST_TIMEOUT_MS: '30000', SPROUT_TEST_OBS_DIR: join(dir, 'obs') },
      }),
      (error: unknown) => {
        assert.equal((error as { code: number }).code, 1);
        return true;
      },
    );
    const run = readRun(join(dir, 'obs'));
    const result = run.find((record) => record.record === 'test_result')!;
    assert.equal(result.outcome, 'fail');
    assert.equal(result.classification, 'testTimeoutFailure');
    const summary = run.at(-1)!;
    assert.equal(summary.disposition, 'failed', 'suite deadline was not reached');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an externally killed wrapper leaves run_started without a closing summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprout-obs-crash-'));
  try {
    const fixture = join(dir, 'fixture.test.mjs');
    await writeFile(fixture, `import { test } from 'node:test';
test('quick pass', () => {});
test('long tail', async () => { await new Promise((resolve) => setTimeout(resolve, 2000)); });
`);
    const obsDir = join(dir, 'obs');
    const child = spawn(process.execPath, [runner, fixture], {
      env: { ...standaloneEnv, SPROUT_TEST_OBS_DIR: obsDir },
      stdio: 'ignore',
    });
    // Simulate the outer command limit: kill the wrapper before it can finish.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const run = readRun(obsDir);
    assert.equal(run[0]!.record, 'run_started', 'start was streamed before execution');
    assert.ok(run.some((record) => record.record === 'test_result'), 'completed results streamed before the kill survive');
    assert.equal(run.some((record) => record.record === 'run_summary'), false, 'a run lacking its ending record is incomplete');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('observation records sanitize paths outside the working directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprout-obs-privacy-'));
  try {
    const fixture = join(dir, 'fixture.test.mjs');
    await writeFile(fixture, `import { test } from 'node:test';
test('external path case', () => {});
`);
    await exec(process.execPath, [runner, fixture], {
      timeout: 15_000,
      cwd: new URL('.', import.meta.url).pathname,
      env: { ...standaloneEnv, SPROUT_TEST_OBS_DIR: join(dir, 'obs') },
    });
    const run = readRun(join(dir, 'obs'));
    const raw = JSON.stringify(run);
    assert.equal(raw.includes(dir), false, 'no absolute temp paths in records');
    const result = run.find((record) => record.record === 'test_result')!;
    assert.equal(result.file, `<external>/fixture.test.mjs`);
    const started = run[0]!;
    assert.equal((started.targets as string[])[0], `<external>/fixture.test.mjs`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('experiment tag marks run_started only; ordinary runs carry no experiment field', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprout-obs-experiment-'));
  try {
    const fixture = join(dir, 'fixture.test.mjs');
    await writeFile(fixture, `import { test } from 'node:test';
test('ordinary case', () => {});
`);
    // Ordinary run: no experiment mark anywhere — the historical record shape.
    await exec(process.execPath, [runner, fixture], {
      timeout: 15_000,
      env: { ...standaloneEnv, SPROUT_TEST_OBS_DIR: join(dir, 'obs-plain') },
    });
    const plain = readRun(join(dir, 'obs-plain'));
    assert.equal('experiment' in plain[0]!, false, 'ordinary run_started carries no experiment field');
    assert.ok(plain.every((record) => !('experiment' in record)), 'no record of an ordinary run carries the mark');

    // Experiment run: marked on run_started only; test_result shape unchanged.
    await exec(process.execPath, [runner, fixture], {
      timeout: 15_000,
      env: { ...standaloneEnv, SPROUT_TEST_OBS_DIR: join(dir, 'obs-tag'), SPROUT_TEST_OBS_EXPERIMENT: '  probe run  ' },
    });
    const tagged = readRun(join(dir, 'obs-tag'));
    assert.equal((tagged[0] as { experiment?: string }).experiment, 'probe-run', 'tag is sanitized to a token');
    const result = tagged.find((record) => record.record === 'test_result')!;
    assert.equal('experiment' in result, false, 'test_result records are unchanged');
    const summary = tagged.at(-1)!;
    assert.equal(summary.record, 'run_summary');
    assert.equal('experiment' in summary, false, 'run_summary records are unchanged');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repeated invocations keep every attempt without overwriting the first failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprout-obs-retry-'));
  try {
    const fixture = join(dir, 'fixture.test.mjs');
    const obsDir = join(dir, 'obs');
    const runOnce = async (body: string): Promise<void> => {
      await writeFile(fixture, `import { test } from 'node:test';\n${body}\n`);
      await exec(process.execPath, [runner, fixture], {
        timeout: 15_000,
        env: { ...standaloneEnv, SPROUT_TEST_OBS_DIR: obsDir },
      }).catch((error: unknown) => {
        assert.equal((error as { code: number }).code, 1);
      });
    };
    await runOnce(`test('flaky case', () => { throw new Error('first attempt fails'); });`);
    await runOnce(`test('flaky case', () => {});`);
    const files = readdirSync(obsDir).filter((name) => name.endsWith('.jsonl'));
    assert.equal(files.length, 2, 'one file per attempt');
    const attempts = files.map((name) => {
      const records = readFileSync(join(obsDir, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const result = records.find((record) => record.record === 'test_result')!;
      return { outcome: result.outcome as string, summary: records.at(-1)!.disposition as string };
    }).sort((a, b) => (a.outcome === 'fail' ? -1 : b.outcome === 'fail' ? 1 : 0));
    assert.deepEqual(attempts, [
      { outcome: 'fail', summary: 'failed' },
      { outcome: 'pass', summary: 'passed' },
    ], 'the initial failure survives alongside the later pass');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
