/**
 * Durable test-observation dataset: the single record schema plus storage
 * plumbing shared by the runner, the progress reporter, and aggregation.
 *
 * One JSONL file per run, streamed so an external kill cannot erase
 * completed-result evidence. Storage defaults to the Git common directory so
 * records survive worktree reclamation; SPROUT_TEST_OBS_DIR overrides it. A
 * run file without a closing run_summary record is incomplete.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';

export type RunStartedRecord = {
  record: 'run_started';
  runId: string;
  at: string;
  commit: string | null;
  dirtyFingerprint: string | null;
  inventoryDigest: string;
  targets: string[];
  node: string;
  concurrency: number;
  timeoutMs: number;
};

export type TestResultRecord = {
  record: 'test_result';
  runId: string;
  at: string;
  file: string;
  name: string;
  outcome: 'pass' | 'fail' | 'skip' | 'todo' | 'cancelled';
  durationMs: number | null;
  classification: string | null;
};

export type RunSummaryRecord = {
  record: 'run_summary';
  runId: string;
  at: string;
  disposition: 'passed' | 'failed' | 'timed_out' | 'interrupted';
  signal?: NodeJS.Signals;
  timeoutMs?: number;
  candidates?: readonly { file: string; line?: number; name: string }[];
  note?: string | null;
  exitCode?: number;
  counts?: Record<string, number | null> | null;
};

export type ObservationRecord = RunStartedRecord | TestResultRecord | RunSummaryRecord;

export const gitOutput = (args: string[]): string | null => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
};

// Diagnostics live in the repository but must not record local home paths.
export const displayPath = (file: string | null | undefined): string => {
  if (!file) return '(unknown file)';
  if (!isAbsolute(file)) return file;
  const local = relative(process.cwd(), file);
  return local !== '..' && !local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(local)
    ? local : `<external>/${basename(file)}`;
};

export const observationDir = (): string => {
  const override = process.env.SPROUT_TEST_OBS_DIR;
  if (override !== undefined && override !== '') return override;
  const common = gitOutput(['rev-parse', '--git-common-dir'])?.trim() ?? null;
  return common === null || common === ''
    ? join(tmpdir(), 'sprout-test-observations')
    : join(isAbsolute(common) ? common : join(process.cwd(), common), 'observations', 'test-runs');
};

/** Never let observation failure change the test exit status. */
export const appendObservation = (path: string, record: ObservationRecord): void => {
  try { appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 }); } catch { /* best-effort */ }
};

/** Stamp the fixed test_result fields so the schema lives in one place. */
export const testResultRecord = (fields: Omit<TestResultRecord, 'record' | 'at'>): TestResultRecord => ({
  record: 'test_result',
  at: new Date().toISOString(),
  ...fields,
});

/** Bounded retention: keep the most recent runs, prune the rest. */
export const pruneObservationRuns = (dir: string, keep: number): void => {
  try {
    const runs = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
    for (const stale of runs.slice(0, Math.max(0, runs.length - keep))) {
      rmSync(join(dir, stale), { force: true });
    }
  } catch { /* Retention is best-effort. */ }
};

export const listRunFiles = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();

/** A forced kill can leave a partial final line; it is skipped, not fatal. */
export const readRunRecords = (path: string): ObservationRecord[] =>
  readFileSync(path, 'utf8').split('\n')
    .filter(Boolean)
    .flatMap((line): ObservationRecord[] => {
      try { return [JSON.parse(line) as ObservationRecord]; } catch { return []; }
    });
