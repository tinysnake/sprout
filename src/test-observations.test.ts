/**
 * The observation aggregator's contract for experiment legibility: a run whose
 * run_started record carries an `experiment` mark is a deliberate mutation or
 * probe run whose failures are expected, and is excluded from every genuine-run
 * statistic. An unmarked run — like every historical record, which predates
 * the field — is genuine history and is never reclassified.
 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const aggregator = new URL('../scripts/test-observations.ts', import.meta.url).pathname;

const record = (fields: Record<string, unknown>): string =>
  JSON.stringify({ at: '2026-01-01T00:00:00.000Z', ...fields });

test('experiment runs are excluded from flake statistics; unmarked legacy records stay genuine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprout-obs-aggregate-'));
  try {
    const obsDir = join(dir, 'obs');
    const result = (runId: string, name: string, outcome: string, classification: string | null): string =>
      record({ record: 'test_result', runId, file: 'src/example.test.ts', name, outcome, durationMs: 12, classification });
    const started = (runId: string, experiment?: string): string =>
      record({ record: 'run_started', runId, commit: 'abc123', dirtyFingerprint: null, inventoryDigest: 'd',
        targets: ['src/example.test.ts'], node: 'v24.0.0', concurrency: 4, timeoutMs: 175000,
        ...(experiment === undefined ? {} : { experiment }) });
    const summary = (runId: string, disposition: string): string =>
      record({ record: 'run_summary', runId, disposition, exitCode: disposition === 'passed' ? 0 : 1 });

    // Genuine history, legacy shape (no experiment field): pass, pass, pass.
    await mkdir(obsDir, { recursive: true });
    await writeFile(join(obsDir, '2026-01-01T00-00-00-000Z-1.jsonl'),
      [started('run-1'), result('run-1', 'F1', 'pass', null), result('run-1', 'F2', 'pass', null), summary('run-1', 'passed')].join('\n') + '\n');
    // Mutation experiment: F1 fails because the behaviour it protects was broken.
    await writeFile(join(obsDir, '2026-01-02T00-00-00-000Z-2.jsonl'),
      [started('run-2', 'mutation'), result('run-2', 'F1', 'fail', 'testCodeFailure'), result('run-2', 'F2', 'pass', null), summary('run-2', 'failed')].join('\n') + '\n');
    // Genuine history again: both pass.
    await writeFile(join(obsDir, '2026-01-03T00-00-00-000Z-3.jsonl'),
      [started('run-3'), result('run-3', 'F1', 'pass', null), result('run-3', 'F2', 'pass', null), summary('run-3', 'passed')].join('\n') + '\n');
    // An externally killed experiment: incomplete, reported under experiments only.
    await writeFile(join(obsDir, '2026-01-04T00-00-00-000Z-4.jsonl'),
      [started('run-4', 'probe'), result('run-4', 'F1', 'fail', 'testCodeFailure')].join('\n') + '\n');

    const { stdout } = await exec(process.execPath, [aggregator, '--json'], {
      timeout: 30_000,
      env: { ...process.env, SPROUT_TEST_OBS_DIR: obsDir },
    });
    const report = JSON.parse(stdout);
    assert.deepEqual(report.runs, { total: 4, completed: 2, incomplete: 0, timedOut: 0 },
      'only unmarked completed runs count as completed; the killed experiment is not a genuine incomplete run');
    assert.equal(report.tests.fail, 0, 'the mutation failure is not a genuine failure');
    assert.equal(report.tests.firstAttemptFailureRate, '0.00% (0/2)', 'the mutation failure is not a first-attempt failure');
    assert.equal(report.tests.failThenPassRate, 'n/a', 'no genuine failure exists, so no flake candidate');
    assert.deepEqual(report.experiments, {
      total: 2, completed: 1, incomplete: 1, kinds: { mutation: 1, probe: 1 }, failuresExcluded: 2,
      note: 'Deliberate mutation/probe runs; excluded from every genuine-run statistic above.',
    });
    assert.deepEqual(report.incompleteRuns, [], 'experiment incompletes are reported under experiments, not here');

    const human = await exec(process.execPath, [aggregator], {
      timeout: 30_000,
      env: { ...process.env, SPROUT_TEST_OBS_DIR: obsDir },
    });
    assert.match(human.stdout, /Experiment runs \(expected failures; excluded from the statistics above\): 2/);
    assert.match(human.stdout, /kinds: mutation 1, probe 1; 2 failing results excluded/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a dataset with no experiment marks reports none and counts every completed run as genuine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprout-obs-aggregate-plain-'));
  try {
    const obsDir = join(dir, 'obs');
    await mkdir(obsDir, { recursive: true });
    await writeFile(join(obsDir, '2026-01-01T00-00-00-000Z-1.jsonl'), [
      record({ record: 'run_started', runId: 'run-1', commit: null, dirtyFingerprint: null, inventoryDigest: 'd',
        targets: [], node: 'v24.0.0', concurrency: 4, timeoutMs: 175000 }),
      record({ record: 'test_result', runId: 'run-1', file: 'src/example.test.ts', name: 'F1', outcome: 'fail',
        durationMs: 12, classification: 'testCodeFailure' }),
      record({ record: 'run_summary', runId: 'run-1', disposition: 'failed', exitCode: 1 }),
    ].join('\n') + '\n');
    const { stdout } = await exec(process.execPath, [aggregator, '--json'], {
      timeout: 30_000,
      env: { ...process.env, SPROUT_TEST_OBS_DIR: obsDir },
    });
    const report = JSON.parse(stdout);
    assert.deepEqual(report.runs, { total: 1, completed: 1, incomplete: 0, timedOut: 0 },
      'legacy records without any mark stay in the genuine statistics');
    assert.equal(report.tests.fail, 1);
    assert.equal(report.tests.firstAttemptFailureRate, '100.00% (1/1)');
    assert.deepEqual(report.experiments, { total: 0, completed: 0, incomplete: 0, kinds: {}, failuresExcluded: 0,
      note: 'Deliberate mutation/probe runs; excluded from every genuine-run statistic above.' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
