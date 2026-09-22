import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireWorkerLock,
  clearRuntimeState,
  DuplicateWorkerProcessError,
  ensureStateDirectory,
  isEnrolled,
  isRestrictive,
  readConfig,
  readIdentityKey,
  readRuntimeState,
  removeHostState,
  stableSlug,
  writeConfig,
  writePrivateFile,
  writeRuntimeState,
  workerHostPaths,
  workerServiceLabel,
  WorkerHostStateError,
  type WorkerHostConfig,
  type WorkerProcessIdentity,
  type WorkerProcessProbe,
} from './host-state.ts';
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

test('state and configuration files are owner-only and the directory is restrictive', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    assert.equal(statSync(paths.stateDirectory).mode & 0o777, 0o700, 'state directory is 0700');
    writeConfig(paths, config());
    writePrivateFile(paths.identityPath, 'PRIVATE KEY MATERIAL');
    assert.equal(statSync(paths.configPath).mode & 0o777, 0o600, 'config is 0600');
    assert.equal(statSync(paths.identityPath).mode & 0o777, 0o600, 'identity key is 0600');
    assert.ok(isRestrictive(paths.configPath));
    assert.ok(isRestrictive(paths.identityPath));
  } finally {
    cleanup();
  }
});

test('a group- or world-readable identity key is refused rather than trusted', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    writePrivateFile(paths.identityPath, 'PRIVATE KEY MATERIAL');
    chmodSync(paths.identityPath, 0o644);
    assert.throws(
      () => readIdentityKey(paths),
      (error: unknown) => error instanceof WorkerHostStateError && error.reason === 'invalid',
    );
  } finally {
    cleanup();
  }
});

test('a missing configuration is a not-enrolled state, not a corrupt one', () => {
  const { paths, cleanup } = tempPaths();
  try {
    assert.equal(isEnrolled(paths), false);
    assert.throws(
      () => readConfig(paths),
      (error: unknown) => error instanceof WorkerHostStateError && error.reason === 'not-enrolled',
    );
  } finally {
    cleanup();
  }
});

test('a corrupt configuration is refused without echoing its content', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    writePrivateFile(paths.configPath, '{ not valid json with a secret sk-live-sentinel }');
    try {
      readConfig(paths);
      assert.fail('a corrupt configuration must be refused');
    } catch (error) {
      assert.ok(error instanceof WorkerHostStateError);
      assert.equal(error.reason, 'invalid');
      assert.doesNotMatch(error.message, /sk-live-sentinel/);
    }
  } finally {
    cleanup();
  }
});

test('a persisted configuration carries no secret or engine-credential field', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    writeConfig(paths, config());
    const raw = readFileSync(paths.configPath, 'utf8');
    assert.doesNotMatch(raw, /secret|token|password|credential|BEGIN .*KEY/i);
    // The private key file is the only place key material exists, and it is a
    // separate, owner-only file.
    assert.equal(existsSync(paths.identityPath), false);
  } finally {
    cleanup();
  }
});

test('the single-instance lock refuses a live holder and reclaims a stale one', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    const holderIdentity = processIdentity(51_001, 'b');
    const requesterIdentity = processIdentity(51_002, 'c');
    const held = acquireWorkerLock(paths, requesterIdentity, probe(requesterIdentity));
    assert.ok(existsSync(held.path));
    held.release();

    // Exact token/start identity, rather than command words, decides ownership.
    const foreign = acquireWorkerLock(paths, holderIdentity, probe(holderIdentity));
    assert.throws(
      () => acquireWorkerLock(paths, requesterIdentity, probe(holderIdentity)),
      (error: unknown) => error instanceof DuplicateWorkerProcessError,
    );
    foreign.release();

    // A stale lock with a positively dead owner is reclaimed.
    clearRuntimeState(paths);
    const stale = acquireWorkerLock(paths, holderIdentity, probe(holderIdentity));
    const reclaimed = acquireWorkerLock(paths, requesterIdentity, () => ({ state: 'dead' }));
    assert.ok(existsSync(reclaimed.path));
    reclaimed.release();
    stale.release();
  } finally {
    cleanup();
  }
});

test('unavailable process evidence refuses a duplicate Worker start instead of reclaiming its lock', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    const holderIdentity = processIdentity(51_003, 'u');
    const requesterIdentity = processIdentity(51_004, 'v');
    const holder = acquireWorkerLock(paths, holderIdentity, probe(holderIdentity));
    assert.throws(
      () => acquireWorkerLock(paths, requesterIdentity, () => ({ state: 'unknown' })),
      (error: unknown) => error instanceof DuplicateWorkerProcessError,
      'a live process whose environment/start evidence is unavailable is not stale',
    );
    assert.ok(existsSync(holder.path), 'the possibly live holder remains protected');
    holder.release();
  } finally {
    cleanup();
  }
});

test('runtime state round-trips and clears without a secret', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    assert.equal(readRuntimeState(paths), undefined);
    writeRuntimeState(paths, { pid: 4242, process: processIdentity(4242), state: 'connected', at: 1_000, epoch: 3 });
    const read = readRuntimeState(paths);
    assert.equal(read?.state, 'connected');
    assert.equal(read?.epoch, 3);
    const raw = readFileSync(paths.runtimePath, 'utf8');
    assert.doesNotMatch(raw, /secret|password/i);
    assert.match(raw, /ownerToken/, 'the opaque owner token is required only for local process ownership');
    clearRuntimeState(paths);
    assert.equal(readRuntimeState(paths), undefined);
  } finally {
    cleanup();
  }
});

test('reset removes identity, configuration, and runtime state', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    writeConfig(paths, config());
    writePrivateFile(paths.identityPath, 'PRIVATE KEY MATERIAL');
    writeRuntimeState(paths, { pid: 1, process: processIdentity(1), state: 'stopped', at: 0 });
    removeHostState(paths);
    assert.equal(isEnrolled(paths), false);
    assert.equal(existsSync(paths.identityPath), false);
    assert.equal(existsSync(paths.runtimePath), false);
    assert.equal(existsSync(paths.stateDirectory), false);
  } finally {
    cleanup();
  }
});

test('service labels and slugs are stable and never name a host verbatim', () => {
  const label = workerServiceLabel('Mac Mini of <operator>');
  assert.match(label, /^dev\.sprout\.worker\./);
  assert.ok(!label.includes('<'), 'a label must not contain raw host text');
  // No fragment of the caller-chosen instance name may survive into the label:
  // the slug is a pure one-way digest, not a sanitized prefix.
  assert.ok(!label.includes('Mac'), 'no instance-name fragment survives into the label');
  assert.ok(!label.includes('operator'), 'no instance-name fragment survives into the label');
  assert.equal(stableSlug('instance-a'), stableSlug('instance-a'));
  assert.notEqual(stableSlug('instance-a'), stableSlug('instance-b'));
  // The slug is pure hex: it is safe in a label, a file name, and a plist.
  assert.match(stableSlug('any instance name / with punctuation!'), /^[0-9a-f]+$/);
});

test('the LaunchAgent restarts on unexpected exit but not on a clean stop', () => {
  const plist = renderLaunchAgent({
    label: 'dev.sprout.worker.env.00000000',
    executablePath: '/synthetic/bin/sprout',
    arguments: ['worker', 'start'],
    logPath: '/synthetic/state/worker.log',
    environment: { HOME: '/synthetic/home', PATH: '/usr/bin' },
  });
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, /<string>worker<\/string>\s*<string>start<\/string>/);
  assert.doesNotMatch(plist, /--enrollment|claimSecret|secret|token/i);
});

test('the LaunchAgent XML escapes a path that would otherwise break the plist', () => {
  const plist = renderLaunchAgent({
    label: 'dev.sprout.worker.x',
    executablePath: '/synthetic/a&b/<bin>',
    arguments: ['worker', 'start'],
    logPath: '/synthetic/log',
    environment: {},
  });
  assert.match(plist, /a&amp;b/);
  assert.match(plist, /&lt;bin&gt;/);
  assert.doesNotMatch(plist, /<bin>/);
});

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
    const marker = `${held.path}.releasing-${identity.ownerToken}-crash`;
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
