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
 * Runs whose run_started record carries an `experiment` mark are deliberate
 * mutation/probe runs whose failures are expected: they are excluded from every
 * statistic below and reported separately. An unmarked run is genuine history —
 * every historical record predates the mark and stays valid.
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

/**
 * A run marked as a deliberate experiment (mutation, probe) on its run_started
 * record. Unmarked — like every historical record, which predates the field —
 * means genuine: legacy history stays readable and is never reclassified.
 */
const experimentKind = (records: ObservationRecord[]): string | null => {
  const started = records.find((record) => record.record === 'run_started');
  return started !== undefined && started.record === 'run_started' &&
    typeof started.experiment === 'string' && started.experiment !== ''
    ? started.experiment : null;
};

const completed = [...runs.values()].filter((records) => records.some((record) => record.record === 'run_summary'));
const incomplete = [...runs.entries()].filter(([, records]) => !records.some((record) => record.record === 'run_summary'));

// Experiments exist to fail; their failures are evidence of a good test, not a
// regression. They are excluded from every genuine-run statistic below and
// reported separately, so flake attribution never sees them.
const genuineCompleted = completed.filter((records) => experimentKind(records) === null);
const experimentRuns = [...runs.values()].filter((records) => experimentKind(records) !== null);
const experimentKinds = new Map<string, number>();
let experimentFailuresExcluded = 0;
for (const records of experimentRuns) {
  const kind = experimentKind(records) ?? 'unknown';
  experimentKinds.set(kind, (experimentKinds.get(kind) ?? 0) + 1);
  experimentFailuresExcluded += records.filter((record) =>
    record.record === 'test_result' && (record.outcome === 'fail' || record.outcome === 'cancelled')).length;
}

const outcomes = new Map<string, number>();
const durations: number[] = [];
let totalTests = 0;
for (const records of genuineCompleted) {
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
for (const records of genuineCompleted) {
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

const timedOutRuns = genuineCompleted.filter((records) =>
  records.some((record) => record.record === 'run_summary' && record.disposition === 'timed_out')).length;

const outcomeCount = (outcome: string): number => outcomes.get(outcome) ?? 0;
const report = {
  obsDir,
  runs: { total: runs.size, completed: genuineCompleted.length,
    incomplete: incomplete.filter(([, records]) => experimentKind(records) === null).length, timedOut: timedOutRuns },
  experiments: { total: experimentRuns.length,
    completed: experimentRuns.filter((records) => records.some((record) => record.record === 'run_summary')).length,
    incomplete: experimentRuns.filter((records) => !records.some((record) => record.record === 'run_summary')).length,
    kinds: Object.fromEntries([...experimentKinds].sort()), failuresExcluded: experimentFailuresExcluded,
    note: 'Deliberate mutation/probe runs; excluded from every genuine-run statistic above.' },
  tests: { total: totalTests, pass: outcomeCount('pass'), fail: outcomeCount('fail'), skip: outcomeCount('skip'),
    todo: outcomeCount('todo'), cancelled: outcomeCount('cancelled'),
    firstAttemptFailureRate: rate(firstAttemptFailures, firstOutcome.size),
    timeoutRate: rate(timedOutRuns, genuineCompleted.length),
    failThenPassRate: rate(retriedToPass.size, firstAttemptFailures) },
  durationsMs: { median: quantile(durations, 0.5), p95: quantile(durations, 0.95), samples: durations.length },
  incompleteRuns: incomplete.filter(([, records]) => experimentKind(records) === null).map(([name, records]) => {
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
    `Experiment runs (expected failures; excluded from the statistics above): ${report.experiments.total}` +
    ` (${report.experiments.completed} completed, ${report.experiments.incomplete} incomplete;` +
    ` kinds: ${Object.entries(report.experiments.kinds).map(([kind, count]) => `${kind} ${count}`).join(', ') || 'none'};` +
    ` ${report.experiments.failuresExcluded} failing results excluded)\n` +
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
