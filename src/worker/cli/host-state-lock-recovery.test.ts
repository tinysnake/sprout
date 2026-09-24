import { test } from 'node:test';

import assert from 'node:assert/strict';

import { spawn, type ChildProcess } from 'node:child_process';import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';import { acquireWorkerLock, DuplicateWorkerProcessError, ensureStateDirectory, readRuntimeState, writePrivateFile, writeRuntimeState, workerHostPaths, workerServiceLabel, WorkerHostStateError, type WorkerProcessIdentity, type WorkerProcessProbe } from './host-state.ts';

import {
  launchAgentPlistPath,
  renderLaunchAgent,
  installLaunchAgent,
  uninstallLaunchAgent,
  restartLaunchAgent,
} from './launch-agent.ts';


/**
 * Host-local storage, the single-instance lock, and the LaunchAgent renderer
 * (#117).
 *
 * These are the filesystem and platform seams the CLI depends on, so they are
 * asserted directly: restrictive permissions, atomic private writes, corrupt
 * configuration refusals, the lock's stale-pid reclamation, and a plist that
 * restarts on unexpected exit but not on a clean stop.
 *
 * No test records a real home directory: every state root is a temporary
 * directory, and every configured path is synthetic.
 */

function tempPaths(): { paths: ReturnType<typeof workerHostPaths>; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-state-'));
  const paths = workerHostPaths({
    HOME: root,
    SPROUT_WORKER_HOME: join(root, 'state'),
    SPROUT_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents'),
    SPROUT_CLI_PATH: '/synthetic/bin/sprout',
  });
  return { paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}


function processIdentity(pid: number, tokenCharacter = 'a'): WorkerProcessIdentity {
  return { pid, startIdentity: `test-start-${pid}-${tokenCharacter}`, ownerToken: tokenCharacter.repeat(43) };
}


function probe(...identities: readonly WorkerProcessIdentity[]): WorkerProcessProbe {
  return (pid) => {
    const identity = identities.find((candidate) => candidate.pid === pid);
    return identity === undefined ? { state: 'dead' } : { state: 'alive', process: identity };
  };
}


/** A tiny helper module inlined: spawn a child process that races the lock. */
function spawnChildLockRunner(
  paths: ReturnType<typeof workerHostPaths>,
  args: readonly string[],
): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', childLockRunnerScript()],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SPROUT_WORKER_HOME: paths.stateDirectory,
        SPROUT_LAUNCH_AGENTS_DIR: paths.launchAgentsDirectory,
        SPROUT_CLI_PATH: paths.executablePath,
        SPROUT_TEST_REPO_ROOT: new URL('../../..', import.meta.url).pathname,
        SPROUT_WORKER_OWNER_TOKEN: (args.includes('hold') ? 'h' : 'i').repeat(43),
      },
    },
  );
  void args;
  return child;
}


function childLockRunnerScript(): string {
  return [
    "const { acquireWorkerLock, currentWorkerProcess, workerHostPaths, ensureStateDirectory } = await import('file://' + process.env.SPROUT_TEST_REPO_ROOT + '/src/worker/cli/host-state.ts');",
    'const paths = workerHostPaths();',
    'ensureStateDirectory(paths);',
    'try {',
    '  const lock = acquireWorkerLock(paths, currentWorkerProcess(process.env.SPROUT_WORKER_OWNER_TOKEN));',
    "  process.stdout.write('acquired\\n');",
    '  setTimeout(() => {',
    '    lock.release();',
    '    process.exit(0);',
    '  }, 300);',
    '} catch (error) {',
    "  process.stdout.write(JSON.stringify({ outcome: error.name, message: error.message }) + '\\n');",
    '  process.exit(0);',
    '}',
  ].join('\n');
}


function waitForLine(child: ChildProcess, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child never printed ${text}`)), 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes(text)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}


function waitForReport(child: ChildProcess): Promise<{ outcome: string; message: string }> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('child never reported an outcome')), 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const line = buffered.split('\n').find((candidate) => candidate.startsWith('{'));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}


function onceExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', reject);
  });
}


test('installing the LaunchAgent bootstraps it in the gui domain and uninstall boots it out', () => {
  const { paths, cleanup } = tempPaths();
  const calls: string[] = [];
  const run = (command: string, args: readonly string[]): string => {
    calls.push([command, ...args].join(' '));
    return '';
  };
  try {
    const label = workerServiceLabel('env-synthetic');
    const plistPath = launchAgentPlistPath(paths, 'env-synthetic');
    const result = installLaunchAgent({
      paths,
      label,
      plistPath,
      plistContent: renderLaunchAgent({
        label,
        executablePath: '/synthetic/bin/sprout',
        arguments: ['worker', 'start'],
        logPath: paths.logPath,
        environment: {},
      }),
      uid: 501,
      run,
    });
    assert.equal(result.installed, true);
    assert.ok(calls.some((call) => call.startsWith('launchctl bootstrap gui/501 ')));
    assert.equal(statSync(plistPath).mode & 0o777, 0o600, 'the plist is owner-only');

    restartLaunchAgent({ label, uid: 501, run });
    assert.ok(calls.some((call) => call === `launchctl kickstart -k gui/501/${label}`));

    const removed = uninstallLaunchAgent({ label, plistPath, uid: 501, run });
    assert.equal(removed.removed, true);
    assert.ok(calls.some((call) => call.startsWith('launchctl bootout gui/501/')));
    assert.equal(existsSync(plistPath), false);
  } finally {
    cleanup();
  }
});


test('reinstalling boots the previous job out before bootstrapping the new plist', () => {
  const { paths, cleanup } = tempPaths();
  const calls: string[] = [];
  const run = (command: string, args: readonly string[]): string => {
    calls.push([command, ...args].join(' '));
    return '';
  };
  try {
    const label = workerServiceLabel('env-synthetic');
    const plistPath = launchAgentPlistPath(paths, 'env-synthetic');
    const content = renderLaunchAgent({
      label,
      executablePath: '/synthetic/bin/sprout',
      arguments: ['worker', 'start'],
      logPath: paths.logPath,
      environment: {},
    });
    installLaunchAgent({ paths, label, plistPath, plistContent: content, uid: 501, run });
    calls.length = 0;
    installLaunchAgent({ paths, label, plistPath, plistContent: content, uid: 501, run });
    const bootout = calls.findIndex((call) => call.startsWith('launchctl bootout'));
    const bootstrap = calls.findIndex((call) => call.startsWith('launchctl bootstrap'));
    assert.ok(bootout !== -1 && bootstrap !== -1 && bootout < bootstrap, 'bootout precedes bootstrap');
    assert.ok(readFileSync(plistPath, 'utf8').includes(label));
  } finally {
    cleanup();
  }
});


test('a malformed runtime state record is refused rather than read as healthy', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    writePrivateFile(paths.runtimePath, JSON.stringify({ pid: 1, process: processIdentity(1), state: 'possessed', at: 0 }));
    assert.throws(
      () => readRuntimeState(paths),
      (error: unknown) => error instanceof WorkerHostStateError && error.reason === 'invalid',
    );
    writePrivateFile(paths.runtimePath, JSON.stringify({ pid: 'many', state: 'connected', at: 0 }));
    assert.throws(() => readRuntimeState(paths), WorkerHostStateError);
    writePrivateFile(paths.runtimePath, 'not json at all');
    assert.throws(() => readRuntimeState(paths), WorkerHostStateError);
    // A valid record still round-trips.
    writeRuntimeState(paths, { pid: 42, process: processIdentity(42), state: 'connected', at: 1, epoch: 2 });
    assert.equal(readRuntimeState(paths)?.pid, 42);
  } finally {
    cleanup();
  }
});


test('concurrent lock acquisition lets exactly one starter win and maps the loser to the duplicate error', { skip: process.platform === 'win32' }, async () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    // A real cross-process race: holder and contender are separate node
    // processes. The contender is spawned only after the holder has verifiably
    // acquired the lock, so their attempts are guaranteed to overlap and the
    // exclusive create must decide a single winner.
    const holder = spawnChildLockRunner(paths, ['hold']);
    try {
      await waitForLine(holder, 'acquired');
      const contender = spawnChildLockRunner(paths, []);
      try {
        const [holderCode, contenderReport] = await Promise.all([
          onceExit(holder),
          waitForReport(contender),
        ]);
        assert.equal(holderCode, 0, 'the first starter must acquire and release cleanly');
        assert.equal(contenderReport.outcome, 'DuplicateWorkerProcessError');
        assert.match(contenderReport.message, /already running/);
      } finally {
        contender.kill();
      }
    } finally {
      holder.kill();
    }
  } finally {
    cleanup();
  }
});


test('a releasing marker recovers after a crash between owner retirement and directory cleanup', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    const identity = processIdentity(50_002, 'r');
    const held = acquireWorkerLock(paths, identity, probe(identity));
    const ownerPath = join(held.path, `owner-${identity.ownerToken}`);
    const marker = `${held.path}.releasing-${identity.ownerToken}-0000000000000001`;
    renameSync(ownerPath, marker);
    rmdirSync(held.path);
    const recovered = acquireWorkerLock(paths, processIdentity(50_003, 's'), () => ({ state: 'dead' }));
    assert.ok(existsSync(recovered.path));
    recovered.release();
    assert.equal(existsSync(marker), false);
  } finally {
    cleanup();
  }
});


test('a pending marker recovers after a crash before canonical lock creation', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    const identity = processIdentity(50_004, 'p');
    const lockPath = join(paths.stateDirectory, 'worker.lock');
    const marker = `${lockPath}.pending-${identity.ownerToken}`;
    writeFileSync(marker, `${JSON.stringify({ version: 1, kind: 'worker', process: identity })}\n`, { mode: 0o600 });
    const recovered = acquireWorkerLock(paths, processIdentity(50_005, 'q'), () => ({ state: 'dead' }));
    assert.ok(existsSync(recovered.path));
    recovered.release();
    assert.equal(existsSync(marker), false);
  } finally {
    cleanup();
  }
});


test('a truncated unpublished staging record cannot permanently wedge lock recovery', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    const interrupted = processIdentity(50_006, 't');
    const lockPath = join(paths.stateDirectory, 'worker.lock');
    // `.preparing` is the protocol's explicitly non-owning staging state. A
    // hard crash may leave any prefix of the record here; it must never be
    // confused with a published pending owner record.
    const staged = `${lockPath}.pending-${interrupted.ownerToken}-0000000000000002.preparing`;
    writeFileSync(staged, '{"version":1,"kind":"worker","proc', { mode: 0o600 });

    const recovered = acquireWorkerLock(
      paths,
      processIdentity(50_007, 'w'),
      // Unknown evidence remains fail-closed for an owned/published record;
      // this incomplete, unpublished transition has no ownership authority.
      () => ({ state: 'unknown' }),
    );
    assert.ok(existsSync(recovered.path));
    recovered.release();
    assert.equal(existsSync(staged), false, 'recovery cleans the incomplete transition');
  } finally {
    cleanup();
  }
});


test('a truncated pending marker from the pre-atomic protocol recovers without reclaiming owned evidence', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    const interrupted = processIdentity(50_010, 'j');
    const lockPath = join(paths.stateDirectory, 'worker.lock');
    const legacyPending = `${lockPath}.pending-${interrupted.ownerToken}`;
    // Commit 975754d wrote directly to this final name. A crash could leave a
    // JSON prefix here before any canonical owner entry existed.
    writeFileSync(legacyPending, '{"version":1,"kind":"worker","proc', { mode: 0o600 });

    const recovered = acquireWorkerLock(
      paths,
      processIdentity(50_011, 'l'),
      () => ({ state: 'unknown' }),
    );
    assert.ok(existsSync(recovered.path));
    recovered.release();
    assert.equal(existsSync(legacyPending), false);
  } finally {
    cleanup();
  }
});


test('a complete published pending record with unknown owner evidence remains fail-closed', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    const identity = processIdentity(50_008, 'x');
    const lockPath = join(paths.stateDirectory, 'worker.lock');
    const marker = `${lockPath}.pending-${identity.ownerToken}-0000000000000003`;
    writeFileSync(
      marker,
      `${JSON.stringify({ version: 1, kind: 'worker', process: identity })}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () => acquireWorkerLock(paths, processIdentity(50_009, 'y'), () => ({ state: 'unknown' })),
      DuplicateWorkerProcessError,
    );
    assert.ok(existsSync(marker), 'published unknown evidence is never reclaimed');
  } finally {
    cleanup();
  }
});
