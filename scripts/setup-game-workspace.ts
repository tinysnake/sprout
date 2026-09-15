/**
 * Initialize the ignored local Three.js repository used by the O7 game slice.
 *
 * The committed template and runtime configuration stay portable. This script
 * materializes their environment-local repository under a Worker root, where
 * the Project's `workspaces` registration can refer to it with a relative path.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = join(projectRoot, 'templates', 'o7-minesweeper');
const workspaceRoot = resolve(process.env.SPROUT_GAME_WORKSPACE_ROOT ?? join(projectRoot, '.sprout-game-workspaces'));
const repository = join(workspaceRoot, 'minesweeper');

await mkdir(workspaceRoot, { recursive: true });
await copyTemplate(template, repository);
installDependencies(repository);
initializeGitRepository(repository);

process.stdout.write(`O7 game workspace ready: ${relative(projectRoot, repository)}\n`);
process.stdout.write('Dependencies are installed; run npm --prefix <workspace> test.\n');

async function copyTemplate(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTemplate(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile()) throw new Error(`template contains an unsupported entry: ${entry.name}`);
    if (await exists(destinationPath)) {
      const [expected, actual] = await Promise.all([readFile(sourcePath), readFile(destinationPath)]);
      if (!expected.equals(actual)) throw new Error(`refusing to overwrite local workspace file: ${relative(repository, destinationPath)}`);
      continue;
    }
    await cp(sourcePath, destinationPath, { errorOnExist: true });
  }
}

function initializeGitRepository(directory: string): void {
  if (!isGitRepository(directory)) {
    runGit(directory, ['init', '--initial-branch=main']);
  }
  if (hasHead(directory)) return;
  runGit(directory, ['add', '.']);
  runGit(directory, ['commit', '-m', 'chore: initialize Three.js Minesweeper game']);
}

/** The template lockfile makes the disposable workspace runnable from a clean checkout. */
function installDependencies(directory: string): void {
  if (existsSync(join(directory, 'node_modules', 'three'))) return;
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: directory,
    stdio: 'inherit',
  });
}

function runGit(directory: string, args: readonly string[]): void {
  execFileSync('git', [
    '-C', directory,
    '-c', 'user.name=Sprout Agent',
    '-c', 'user.email=sprout-agent@localhost',
    ...args,
  ], { stdio: 'ignore' });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isGitRepository(path: string): boolean {
  try {
    const topLevel = execFileSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return resolve(topLevel) === resolve(path);
  } catch {
    return false;
  }
}

function hasHead(directory: string): boolean {
  try {
    execFileSync('git', ['-C', directory, 'rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
