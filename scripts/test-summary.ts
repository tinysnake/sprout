#!/usr/bin/env node
/**
 * Run the test suite with a compact, failure-only report.
 *
 * Passing tests are not listed. The run prints the summary counters and, only
 * when something fails, the failure reason. This keeps `npm test` output small
 * enough that a full run does not dominate an agent's context window.
 *
 * Usage:  node scripts/test-summary.ts [--bench] [glob ...]
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendObservation,
  displayPath,
  gitOutput,
  observationDir,
  pruneObservationRuns,
  type ObservationRecord,
} from './test-observation-store.ts';

const DEFAULT_GLOBS = ['src/**/*.test.ts', 'web/src/**/*.test.ts'];
const bench = process.argv.includes('--bench');
const globs = process.argv.slice(2).filter((arg) => arg !== '--bench');
const patterns = globs.length > 0 ? globs : DEFAULT_GLOBS;
const targets = patterns.flatMap((pattern) => {
  if (!pattern.includes('*')) return [pattern];
  const matches = globSync(pattern);
  if (matches.length === 0) throw new Error(`test pattern matched no files: ${pattern}`);
  return matches;
});
// Every agent-facing command is capped at 180 s. Keep the internal deadline
// below that outer limit so the wrapper — not the harness — ends a hung suite
// and still has measured room to write its final records.
const timeoutMs = Number(process.env.SPROUT_TEST_TIMEOUT_MS ?? 175_000);
const TEST_CONCURRENCY = 4;
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
  throw new Error('SPROUT_TEST_TIMEOUT_MS must be a positive integer');
}

const dir = mkdtempSync(join(tmpdir(), 'sprout-test-'));
const reportPath = join(dir, 'report.tap');
const progressPath = join(dir, 'progress.jsonl');

// Durable observation dataset: one JSONL file per run, streamed so an external
// kill cannot erase completed-result evidence; storage, schema, and retention
// live in test-observation-store.ts. A run file without a closing run_summary
// record is incomplete.
const obsDir = observationDir();
const OBS_RETENTION = 500;
mkdirSync(obsDir, { recursive: true, mode: 0o700 });
pruneObservationRuns(obsDir, OBS_RETENTION);
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const runPath = join(obsDir, `${runId}.jsonl`);
// Deliberate experiment (mutation, probe): stamp the run so a later reader can
// never mistake its expected failures for a genuine flake. Convention
// (docs/test-selection.md): such runs also redirect with SPROUT_TEST_OBS_DIR;
// the mark is the belt-and-braces for records that land in a shared dataset
// anyway. Only run_started carries it; test_result records are unchanged.
const experiment = (() => {
  const raw = (process.env.SPROUT_TEST_OBS_EXPERIMENT ?? '').trim();
  if (raw === '') return undefined;
  const token = raw.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64);
  return token === '' ? undefined : token;
})();
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const appendRun = (record: ObservationRecord): void => appendObservation(runPath, record);
appendRun({
  record: 'run_started',
  runId,
  at: new Date().toISOString(),
  commit: gitOutput(['rev-parse', 'HEAD'])?.trim() ?? null,
  dirtyFingerprint: (() => {
    const status = gitOutput(['status', '--porcelain']);
    return status === null || status.trim() === '' ? null : sha256(status + (gitOutput(['diff', 'HEAD']) ?? ''));
  })(),
  inventoryDigest: sha256([...targets].sort().join('\n')),
  targets: targets.map(displayPath),
  node: process.version,
  concurrency: TEST_CONCURRENCY,
  timeoutMs,
  ...(experiment === undefined ? {} : { experiment }),
});

const child = spawn(
  process.execPath,
  [
    '--test',
    `--test-concurrency=${TEST_CONCURRENCY}`,
    '--test-reporter=tap',
    `--test-reporter-destination=${reportPath}`,
    `--test-reporter=${new URL('./test-progress-reporter.mjs', import.meta.url).pathname}`,
    `--test-reporter-destination=${progressPath}`,
    ...targets,
  ],
  { stdio: 'inherit', detached: process.platform !== 'win32',
    env: { ...process.env, SPROUT_TEST_OBS_FILE: runPath, SPROUT_TEST_OBS_RUN_ID: runId } },
);

// Node's test runner spawns workers. Kill its process group, not just the
// runner, so a stuck worker cannot outlive the timeout.
const killTree = (signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref();
  } else {
    try { process.kill(-child.pid, signal); } catch (error) {
      // Best-effort cleanup: the group may already be gone (ESRCH) or its
      // recycled pid no longer ours (EPERM). Neither may fail the wrapper.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    }
  }
};

let timedOut = false;
const deadline = setTimeout(() => {
  timedOut = true;
  killTree('SIGKILL');
}, timeoutMs);

// A wrapper death must not orphan the detached test group. SIGTERM/SIGINT are
// the common harness signals and get an explicit closing record; plain exits
// get a best-effort sweep. SIGKILL is uncatchable — a run without its closing
// run_summary record is then reported as incomplete by aggregation.
const shutDown = (signal: NodeJS.Signals): void => {
  clearTimeout(deadline);
  killTree('SIGKILL');
  appendRun({ record: 'run_summary', runId, at: new Date().toISOString(), disposition: 'interrupted', signal });
  process.exit(130);
};
process.on('SIGTERM', () => shutDown('SIGTERM'));
process.on('SIGINT', () => shutDown('SIGINT'));
process.on('exit', () => killTree('SIGKILL'));

const code = await new Promise<number>((resolve, reject) => {
  child.on('error', reject);
  child.on('close', (exitCode, signal) => resolve(signal ? 1 : (exitCode ?? 1)));
});
clearTimeout(deadline);

let report = '';
let progress = '';
try {
  if (existsSync(reportPath)) report = readFileSync(reportPath, 'utf8');
  if (existsSync(progressPath)) progress = readFileSync(progressPath, 'utf8');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const lines = report.split('\n');
const indentOf = (line: string): number => line.length - line.trimStart().length;

if (timedOut) {
  type Event = { event: string; entryFile?: string; file?: string; line?: number;
    name: string; nesting: number; parentId?: number; testId: number; type?: string };
  const running = new Map<string, Event>();
  const known = new Map<string, Event>();
  const key = (event: Event): string => `${event.entryFile ?? event.file ?? ''}:${event.testId}`;
  for (const record of progress.split('\n')) {
    if (!record) continue;
    try {
      const event = JSON.parse(record) as Event;
      if (event.event === 'test:dequeue') {
        running.set(key(event), event);
        known.set(key(event), event);
      } else if (event.event === 'test:complete') running.delete(key(event));
    } catch { /* Ignore a partial final line caused by a forced kill. */ }
  }
  const leaves = [...running.values()].filter((event) =>
    ![...running.values()].some((child) =>
      child.entryFile === event.entryFile && child.parentId === event.testId));
  const candidates: { file: string; line?: number; name: string }[] = [];
  if (leaves.length > 0) {
    for (const event of leaves) {
      const path = [event.name];
      let parent = event.parentId;
      while (parent !== undefined) {
        const ancestor = known.get(`${event.entryFile ?? event.file ?? ''}:${parent}`);
        if (!ancestor) break;
        path.unshift(ancestor.name);
        parent = ancestor.parentId;
      }
      const entryLine = event.line;
      candidates.push({ file: displayPath(event.file ?? event.entryFile ?? '(unknown file)'), ...(entryLine === undefined ? {} : { line: entryLine }), name: path.join(' > ') });
    }
  }
  const logPath = process.env.SPROUT_TEST_TIMEOUT_LOG ?? join(process.cwd(), 'test-timeout.jsonl');
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), timeoutMs, targets: targets.map(displayPath),
      candidates, note: candidates.length ? 'Candidates, not proven causes.' : 'No active test observed; worker may have stalled before execution or progress was not delivered.' })}\n`, { mode: 0o600 });
    process.stderr.write(`Test suite timed out after ${timeoutMs} ms; diagnostic appended to ${logPath}.\n`);
  } catch (error) {
    process.stderr.write(`Test suite timed out after ${timeoutMs} ms; could not save diagnostic: ${error}\n`);
  }
  appendRun({ record: 'run_summary', runId, at: new Date().toISOString(), disposition: 'timed_out',
    timeoutMs, candidates, note: candidates.length ? 'Candidates, not proven causes.' : null });
  process.exit(124);
}

if (bench) {
  const entries: { name: string; ms: number }[] = [];
  const parents: string[] = [];
  const hasChildren: boolean[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const subtest = line.match(/^( *)# Subtest: (.*)$/);
    if (subtest) {
      const depth = subtest[1]!.length / 4;
      if (depth > 0) hasChildren[depth - 1] = true;
      parents[depth] = subtest[2]!;
      hasChildren[depth] = false;
      parents.length = depth + 1;
      continue;
    }
    const result = line.match(/^( *)(?:not )?ok \d+ - (.*)$/);
    if (!result) continue;
    const depth = result[1]!.length / 4;
    // Omit file and suite aggregates; retain only leaf test results.
    if (hasChildren[depth] && parents[depth] === result[2]) continue;
    const duration = lines.slice(i + 1, i + 12).find((next) =>
      next.startsWith(`${result[1]}  duration_ms: `));
    if (!duration) continue;
    entries.push({ name: [...parents.slice(0, depth), result[2]!].join(' > '), ms: Number(duration.trim().slice('duration_ms: '.length)) });
  }
  entries.sort((a, b) => b.ms - a.ms);
  process.stdout.write(`\nTest durations (slowest first, ${entries.length} results):\n`);
  for (const entry of entries) process.stdout.write(`${entry.ms.toFixed(2)} ms  ${entry.name}\n`);
}

const SUMMARY = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /;
process.stdout.write(
  lines
    .filter((line) => SUMMARY.test(line))
    .map((line) => line.replace(/^# /, 'ℹ '))
    .join('\n') + '\n',
);

/**
 * Read the YAML-ish fields of one `not ok` block. A block-scalar field such as
 * `error: |-` owns every following line that is indented deeper than it.
 */
const readBlock = (start: number, headerIndent: number): Map<string, string> => {
  const fields = new Map<string, string>();
  const fieldIndent = headerIndent + 2;
  let field: string | null = null;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const indent = indentOf(line);
    if (line.trim() === '') continue;
    if (line.trim() === '...' && indent <= fieldIndent) break;
    if (/^ *(not )?ok \d+ - /.test(line) || line.startsWith('#')) break;
    if (indent <= headerIndent) break;

    const named = line.match(new RegExp(`^ {${fieldIndent}}([A-Za-z_]+): ?(.*)$`));
    if (named) {
      field = named[1] ?? '';
      fields.set(field, named[2] ?? '');
      continue;
    }
    if (field !== null) {
      const body = line.slice(fieldIndent + 2);
      fields.set(field, `${fields.get(field) ?? ''}\n${body}`);
    }
  }
  return fields;
};

const failures: string[] = [];
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i] ?? '';
  const header = line.match(/^( *)not ok \d+ - (.*)$/);
  if (!header) continue;

  const fields = readBlock(i, (header[1] ?? '').length);
  const reason = (fields.get('error') ?? '').replace(/^\|-\s*\n?/, '').trimEnd();
  failures.push(
    [
      `FAIL ${header[2] ?? ''}`,
      fields.has('location') ? `  at ${fields.get('location')}` : '',
      reason === ''
        ? "  'test failed' (reason below)"
        : reason
            .split('\n')
            .map((part) => `  ${part}`.trimEnd())
            .join('\n'),
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

// A test file that dies before its tests run reports only `'test failed'`, or
// nothing at all when the runner itself never reached a test. Its real reason is
// the diagnostic captured as a comment block, which the TAP stream interleaves
// between test results.
if (code !== 0 && (failures.length === 0 || failures.some((failure) => /'test failed'/.test(failure)))) {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('# ')) {
      current.push(line.slice(2));
      continue;
    }
    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);

  const crash = blocks
    .filter((block) => block.some((line) => /\bERR_[A-Z_]+\b|^Error\b/.test(line)))
    .sort((a, b) => b.length - a.length)[0];
  if (crash) {
    const text = crash
      .join('\n')
      .replace(/^Subtest:.*$/m, '')
      .replace(/\\#/g, '#')
      .trimEnd();
    failures.push(`FAIL (uncaught)\n${text}`);
  }
}

if (failures.length > 0) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
} else if (code !== 0 && !timedOut) {
  // The runner died without any diagnostic the extractor recognizes.
  process.stdout.write(`\nThe test run exited ${code} without a reported failure.\n`);
}

const counter = (name: string): number | null => {
  const line = lines.find((entry) => entry.startsWith(`# ${name} `));
  if (line === undefined) return null;
  const value = Number(line.slice(name.length + 3).trim());
  return Number.isFinite(value) ? value : null;
};
appendRun({
  record: 'run_summary',
  runId,
  at: new Date().toISOString(),
  disposition: code === 0 ? 'passed' : 'failed',
  exitCode: code,
  counts: { tests: counter('tests'), pass: counter('pass'), fail: counter('fail'),
    cancelled: counter('cancelled'), skipped: counter('skipped') },
});

process.exit(timedOut ? 124 : code);
