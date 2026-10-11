#!/usr/bin/env node
/**
 * Aggregate the durable test-observation dataset produced by test-summary.
 *
 * Reads the per-run JSONL files (default: the Git common directory's
 * observations/test-runs, overridable with SPROUT_TEST_OBS_DIR) and reports
 * first-attempt failure rate, timeout rate, fail-then-pass retry rate,
 * median/P95 durations, and incomplete runs. A run lacking its closing
 * run_summary record is incomplete; its latest observed candidates are not
 * proven causes. A retry pass is a flake candidate, not proof of
 * nondeterminism when input or environment changed.
 *
 * Usage:  node scripts/test-observations.ts [--json]
 */
import { join } from 'node:path';
import {
  listRunFiles,
  observationDir,
  readRunRecords,
  type ObservationRecord,
} from './test-observation-store.ts';

const obsDir = observationDir();

const runs = new Map<string, ObservationRecord[]>();
for (const name of listRunFiles(obsDir)) {
  // A forced kill can leave a partial final line; readRunRecords skips it.
  const records = readRunRecords(join(obsDir, name));
  if (records.length > 0) runs.set(name.replace(/\.jsonl$/, ''), records);
}

const quantile = (values: number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
};
const rate = (numerator: number, denominator: number): string =>
  denominator === 0 ? 'n/a' : `${((100 * numerator) / denominator).toFixed(2)}% (${numerator}/${denominator})`;

const completed = [...runs.values()].filter((records) => records.some((record) => record.record === 'run_summary'));
const incomplete = [...runs.entries()].filter(([, records]) => !records.some((record) => record.record === 'run_summary'));

const outcomes = new Map<string, number>();
const durations: number[] = [];
let totalTests = 0;
for (const records of completed) {
  for (const record of records) {
    if (record.record !== 'test_result') continue;
    totalTests += 1;
    outcomes.set(record.outcome, (outcomes.get(record.outcome) ?? 0) + 1);
    if (record.durationMs !== null) durations.push(record.durationMs);
  }
}

// Fail-then-pass retries: the same file+name failing in one completed run and
// passing in a later completed run. Counted once per test. A flake candidate,
// not proven nondeterminism when input or environment changed.
const firstOutcome = new Map<string, string>();
const retriedToPass = new Set<string>();
let firstAttemptFailures = 0;
for (const records of completed) {
  for (const record of records) {
    if (record.record !== 'test_result') continue;
    const key = `${record.file}::${record.name}`;
    const previous = firstOutcome.get(key);
    if (previous === undefined) {
      firstOutcome.set(key, record.outcome);
      if (record.outcome === 'fail') firstAttemptFailures += 1;
    } else if (previous === 'fail' && record.outcome === 'pass') {
      retriedToPass.add(key);
    }
  }
}

const timedOutRuns = completed.filter((records) =>
  records.some((record) => record.record === 'run_summary' && record.disposition === 'timed_out')).length;

const outcomeCount = (outcome: string): number => outcomes.get(outcome) ?? 0;
const report = {
  obsDir,
  runs: { total: runs.size, completed: completed.length, incomplete: incomplete.length, timedOut: timedOutRuns },
  tests: { total: totalTests, pass: outcomeCount('pass'), fail: outcomeCount('fail'), skip: outcomeCount('skip'),
    todo: outcomeCount('todo'), cancelled: outcomeCount('cancelled'),
    firstAttemptFailureRate: rate(firstAttemptFailures, firstOutcome.size),
    timeoutRate: rate(timedOutRuns, completed.length),
    failThenPassRate: rate(retriedToPass.size, firstAttemptFailures) },
  durationsMs: { median: quantile(durations, 0.5), p95: quantile(durations, 0.95), samples: durations.length },
  incompleteRuns: incomplete.map(([name, records]) => {
    const last = records.at(-1) as Extract<ObservationRecord, { record: 'test_result' }> | undefined;
    return { run: name, lastObserved: last?.record === 'test_result' ? `${last.file} :: ${last.name}` : null, note: 'No closing record; latest observed tests are candidates, not proven causes.' };
  }),
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    `Observation dataset: ${obsDir}\n` +
    `Runs: ${report.runs.total} total, ${report.runs.completed} completed, ${report.runs.incomplete} incomplete, ${report.runs.timedOut} timed out\n` +
    `Tests recorded: ${report.tests.total} (pass ${report.tests.pass ?? 0}, fail ${report.tests.fail ?? 0}, skip ${report.tests.skip ?? 0}, todo ${report.tests.todo ?? 0}, cancelled ${report.tests.cancelled ?? 0})\n` +
    `First-attempt failure rate: ${report.tests.firstAttemptFailureRate}\n` +
    `Timeout rate (completed runs): ${report.tests.timeoutRate}\n` +
    `Fail-then-pass rate (flake candidates): ${report.tests.failThenPassRate}\n` +
    `Durations ms: median ${report.durationsMs.median ?? 'n/a'}, p95 ${report.durationsMs.p95 ?? 'n/a'} over ${report.durationsMs.samples} results\n` +
    (report.incompleteRuns.length > 0
      ? `Incomplete runs:\n${report.incompleteRuns.map((run) => `  ${run.run} — last observed: ${run.lastObserved ?? 'none'} (${run.note})`).join('\n')}\n`
      : 'Incomplete runs: none\n'),
  );
}
