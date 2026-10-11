#!/usr/bin/env node
/**
 * Project-owned test selection.
 *
 * Computes tier membership from explicit rules, verifies that the planned
 * full-suite inventory has no missing, extra, or duplicate files, and runs a
 * selected set through the bounded test wrapper (`scripts/test-summary.ts`),
 * so every agent-facing invocation stays within the command timeout.
 *
 * Membership rules, reasons, and triggers: docs/test-selection.md.
 *
 * Usage:
 *   node scripts/test-select.ts --set quick|affected|extended|full   # print files
 *   node scripts/test-select.ts --run quick|affected|extended        # execute
 *   node scripts/test-select.ts --audit                              # coverage check
 *   node scripts/test-select.ts --run affected [--base <ref>]        # tier by change
 */
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_GLOBS = ['src/**/*.test.ts', 'web/src/**/*.test.ts'];
const allFiles = DEFAULT_GLOBS.flatMap((pattern) => globSync(pattern)).sort();

// Extended tier: full DOM matrices (real rendering paths, heavy harnesses) and
// platform-specific startup checks. Long fault-stress matrices belong here too
// when they are introduced.
const EXTENDED_PLATFORM = ['src/worker/cli/worker-cli.macos.test.ts'];
const isExtended = (file: string): boolean =>
  file.endsWith('.dom.test.ts') || EXTENDED_PLATFORM.includes(file);

const extended = allFiles.filter(isExtended);
// Quick core: cheap logic, parsing, state machines, database contracts, and the
// compact critical authority/recovery regressions that are not DOM or platform
// checks. worker-cli-recovery stays here despite its cost: it protects channel-
// lost recovery evidence, which is high-impact and cheap to keep honest.
const quick = allFiles.filter((file) => !isExtended(file));

// Shared surfaces whose change invalidates path-based independence: they feed
// every page, every module boundary, or the whole build. A change under these
// widens an affected selection to the full inventory.
const WIDENING_PATHS = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
  'src/store/', 'src/web/views.ts',
  'web/src/app/main.ts', 'web/src/router/', 'web/src/shell/', 'web/src/transport/',
];

const git = (args: string[]): string[] =>
  spawnSync('git', args, { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

const changedFiles = (base: string): string[] => {
  const tracked = git(['diff', '--name-only', `${base}...HEAD`]);
  const working = git(['diff', '--name-only', 'HEAD']);
  const staged = git(['diff', '--name-only', '--cached']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked, ...working, ...staged, ...untracked])];
};

const affected = (base: string): string[] => {
  const changed = changedFiles(base);
  if (changed.some((file) => WIDENING_PATHS.some((path) => file === path || file.startsWith(path)))) {
    return allFiles;
  }
  const selected = new Set(quick);
  for (const file of changed) {
    const dir = file.slice(0, file.lastIndexOf('/') + 1);
    if (dir === '') continue;
    for (const test of allFiles) {
      // The changed module's subtree: its unit tests and, under web/, its DOM
      // suites. Task DOM also joins any web change because it guards
      // permissions, stop confirmation, and recovery behavior.
      if (test.startsWith(dir)) selected.add(test);
    }
    if (file.startsWith('web/')) selected.add('web/src/modules/tasks/tasks.dom.test.ts');
  }
  return [...selected].sort();
};

const audit = (): number => {
  const union = new Set([...quick, ...extended]);
  const duplicates = quick.filter((file) => extended.includes(file));
  const missing = allFiles.filter((file) => !union.has(file));
  const extra = [...union].filter((file) => !allFiles.includes(file));
  process.stdout.write(
    `Full-suite inventory: ${allFiles.length} files (quick ${quick.length}, extended ${extended.length})\n` +
    `missing ${missing.length}${missing.length ? `: ${missing.join(', ')}` : ''}\n` +
    `extra ${extra.length}${extra.length ? `: ${extra.join(', ')}` : ''}\n` +
    `duplicate ${duplicates.length}${duplicates.length ? `: ${duplicates.join(', ')}` : ''}\n`,
  );
  return missing.length + extra.length + duplicates.length === 0 ? 0 : 1;
};

const args = process.argv.slice(2);
const valueOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const set = valueOf('--set') ?? valueOf('--run') ?? 'quick';
const base = valueOf('--base') ?? 'HEAD';

const files = set === 'full' ? allFiles
  : set === 'quick' ? quick
  : set === 'extended' ? extended
  : set === 'affected' ? affected(base)
  : (() => { throw new Error(`unknown set: ${set}`); })();

if (args.includes('--audit')) {
  process.exit(audit());
}
if (args.includes('--set')) {
  process.stdout.write(`${files.join('\n')}\n`);
  process.exit(0);
}
if (args.includes('--run')) {
  process.stdout.write(`${set}: ${files.length} files\n`);
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'test-summary.ts'), ...files],
    { stdio: 'inherit', env: process.env });
  process.exit(result.status ?? 1);
}
process.stdout.write(`${files.join('\n')}\n`);
