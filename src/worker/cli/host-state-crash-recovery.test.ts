import { test } from 'node:test';

import assert from 'node:assert/strict';

import { spawn, type ChildProcess } from 'node:child_process';import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';import { acquireWorkerLock, DuplicateWorkerProcessError, ensureStateDirectory, removeHostState, writeConfig, writePrivateFile, workerHostPaths, type WorkerHostConfig, type WorkerProcessIdentity, type WorkerProcessProbe, type WorkerLockTransition } from './host-state.ts';


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


function config(overrides: Partial<WorkerHostConfig> = {}): WorkerHostConfig {
  return {
    version: 1,
    enrollmentId: 'enroll-synthetic',
    environmentInstanceId: 'env-synthetic',
    protocolVersion: '2',
    endpoint: { host: '127.0.0.1', port: 5174 },
    identityFileName: 'identity.pem',
    ...overrides,
  };
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


function spawnCrashTransitionRunner(
  paths: ReturnType<typeof workerHostPaths>,
  transition: WorkerLockTransition,
): ChildProcess {
  return spawn(
    process.execPath,
    ['--input-type=module', '-e', crashTransitionRunnerScript()],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        SPROUT_WORKER_HOME: paths.stateDirectory,
        SPROUT_LAUNCH_AGENTS_DIR: paths.launchAgentsDirectory,
        SPROUT_CLI_PATH: paths.executablePath,
        SPROUT_TEST_REPO_ROOT: new URL('../../..', import.meta.url).pathname,
        SPROUT_TEST_TRANSITION: transition,
      },
    },
  );
}


function crashTransitionRunnerScript(): string {
  return [
    "const { acquireWorkerLock, workerHostPaths } = await import('file://' + process.env.SPROUT_TEST_REPO_ROOT + '/src/worker/cli/host-state.ts');",
    "const token = 'k'.repeat(43);",
    "const identity = { pid: process.pid, startIdentity: 'crash-test-process', ownerToken: token };",
    'const paths = workerHostPaths();',
    'const transition = process.env.SPROUT_TEST_TRANSITION;',
    'const lock = acquireWorkerLock(paths, identity, () => ({ state: \'alive\', process: identity }), \'worker\', {',
    '  onTransition: (observed) => { if (observed === transition) process.exit(86); },',
    '});',
    'lock.release();',
    'process.exit(0);',
  ].join('\n');
}


function onceExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', reject);
  });
}


test('a malformed atomically published pending record remains unknown evidence', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    const identity = processIdentity(50_012, 'o');
    const lockPath = join(paths.stateDirectory, 'worker.lock');
    const marker = `${lockPath}.pending-${identity.ownerToken}-0000000000000004`;
    writeFileSync(marker, '{malformed after atomic publication}', { mode: 0o600 });
    assert.throws(
      () => acquireWorkerLock(paths, processIdentity(50_013, 'b'), () => ({ state: 'dead' })),
      DuplicateWorkerProcessError,
    );
    assert.ok(existsSync(marker), 'malformed published evidence is not reclassified as staging');
  } finally {
    cleanup();
  }
});


test('the lock recovers from a hard crash after every durable ownership transition', { skip: process.platform === 'win32' }, async () => {
  const transitions: readonly WorkerLockTransition[] = [
    'pending-stage-created',
    'pending-stage-synced',
    'pending-published',
    'canonical-created',
    'owner-published',
    'owner-retired',
    'canonical-removed',
    'release-complete',
  ];
  for (const transition of transitions) {
    const { paths, cleanup } = tempPaths();
    try {
      ensureStateDirectory(paths);
      const child = spawnCrashTransitionRunner(paths, transition);
      assert.equal(await onceExit(child), 86, `child crashed at ${transition}`);
      const recovered = acquireWorkerLock(
        paths,
        processIdentity(50_100 + transitions.indexOf(transition), 'z'),
        () => ({ state: 'dead' }),
      );
      assert.ok(existsSync(recovered.path), `${transition} does not wedge the next start/reset fence`);
      recovered.release();
    } finally {
      cleanup();
    }
  }
});


test('an owner release cannot unlink a replacement created after it observed the old lock', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    const firstIdentity = processIdentity(50_001, 'd');
    const secondIdentity = processIdentity(50_001, 'e');
    let second: ReturnType<typeof acquireWorkerLock> | undefined;
    const first = acquireWorkerLock(
      paths,
      firstIdentity,
      probe(firstIdentity),
      'worker',
      {
        // The first owner observes its own lock, then a same-PID replacement
        // proves the old binding stale and recreates the canonical pathname.
        // When the first owner resumes, it must not unlink that replacement.
        onReleaseObserved: () => {
          second = acquireWorkerLock(paths, secondIdentity, probe(secondIdentity));
        },
      },
    );
    first.release();
    if (second === undefined) assert.fail('the replacement reclaimed and recreated the lock during stale release');
    const replacement = second;
    assert.ok(existsSync(replacement.path), 'an atomic ownership-bound release preserves the newer lock');
    replacement.release();
    assert.equal(existsSync(replacement.path), false);
  } finally {
    cleanup();
  }
});


test('removeHostState fails closed when a file cannot be removed', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    writeConfig(paths, config());
    writePrivateFile(paths.identityPath, 'PRIVATE KEY MATERIAL');
    // Make the identity directory immutable-by-simulation: replace the file with
    // a directory so unlink fails with EISDIR/EPERM rather than ENOENT.
    rmSync(paths.identityPath, { force: true });
    mkdirSync(paths.identityPath);
    assert.throws(() => removeHostState(paths));
    // The config must survive the failed reset: fail closed means nothing is
    // silently half-removed and reported as success.
    assert.ok(existsSync(paths.configPath));
  } finally {
    cleanup();
  }
});
