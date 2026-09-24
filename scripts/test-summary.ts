#!/usr/bin/env node
/**
 * Run the test suite with a compact, failure-only report.
 *
 * Passing tests are not listed. The run prints the summary counters and, only
 * when something fails, the failure reason. This keeps `npm test` output small
 * enough that a full run does not dominate an agent's context window.
 *
 * Usage:  node scripts/test-summary.ts [glob ...]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_GLOBS = ['src/**/*.test.ts', 'web/src/**/*.test.ts'];
const globs = process.argv.slice(2);
const targets = globs.length > 0 ? globs : DEFAULT_GLOBS;

const dir = mkdtempSync(join(tmpdir(), 'sprout-test-'));
const reportPath = join(dir, 'report.tap');

const child = spawn(
  process.execPath,
  [
    '--test',
    '--test-concurrency=4',
    '--test-reporter=tap',
    `--test-reporter-destination=${reportPath}`,
    ...targets,
  ],
  { stdio: 'inherit' },
);

const code = await new Promise<number>((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', (exitCode, signal) => resolve(signal ? 1 : (exitCode ?? 1)));
});

let report = '';
try {
  report = readFileSync(reportPath, 'utf8');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const lines = report.split('\n');
const indentOf = (line: string): number => line.length - line.trimStart().length;

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
} else if (code !== 0) {
  // The runner died without any diagnostic the extractor recognizes.
  process.stdout.write(`\nThe test run exited ${code} without a reported failure.\n`);
}

process.exit(code);
