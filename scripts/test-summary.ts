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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

const DEFAULT_GLOBS = ['src/**/*.test.ts', 'web/src/**/*.test.ts'];
const bench = process.argv.includes('--bench');
const globs = process.argv.slice(2).filter((arg) => arg !== '--bench');
const targets = globs.length > 0 ? globs : DEFAULT_GLOBS;
const timeoutMs = Number(process.env.SPROUT_TEST_TIMEOUT_MS ?? 180_000);
// Diagnostics live in the repository but must not record local home paths.
const displayPath = (file: string): string => {
  if (!isAbsolute(file)) return file;
  const local = relative(process.cwd(), file);
  return local !== '..' && !local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(local)
    ? local : `<external>/${basename(file)}`;
};
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
  throw new Error('SPROUT_TEST_TIMEOUT_MS must be a positive integer');
}

const dir = mkdtempSync(join(tmpdir(), 'sprout-test-'));
const reportPath = join(dir, 'report.tap');
const progressPath = join(dir, 'progress.jsonl');

const child = spawn(
  process.execPath,
  [
    '--test',
    '--test-concurrency=4',
    '--test-reporter=tap',
    `--test-reporter-destination=${reportPath}`,
    `--test-reporter=${new URL('./test-progress-reporter.mjs', import.meta.url).pathname}`,
    `--test-reporter-destination=${progressPath}`,
    ...targets,
  ],
  { stdio: 'inherit', detached: process.platform !== 'win32' },
);

// Node's test runner spawns workers. Kill its process group, not just the
// runner, so a stuck worker cannot outlive the timeout.
const killTree = (signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref();
  } else {
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
};

let timedOut = false;
const deadline = setTimeout(() => {
  timedOut = true;
  killTree('SIGKILL');
}, timeoutMs);

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
      candidates.push({ file: displayPath(event.file ?? event.entryFile ?? '(unknown file)'), line: event.line, name: path.join(' > ') });
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

process.exit(timedOut ? 124 : code);
