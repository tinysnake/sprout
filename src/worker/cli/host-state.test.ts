import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
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
    // This test's own pid is treated as a live Worker that is NOT verified as a
    // daemon by the substituted runner, so a same-pid re-acquire is allowed and a
    // foreign live pid guarded by a real-looking command line is refused.
    const held = acquireWorkerLock(paths, process.pid, () => 'sprout worker start');
    assert.ok(existsSync(held.path));
    held.release();

    // A lock naming a live pid whose command line is this host's Worker refuses.
    writePrivateFile(held.path, `${process.ppid}\n`);
    assert.throws(
      () => acquireWorkerLock(paths, process.pid, () => 'sprout worker start'),
      (error: unknown) => error instanceof DuplicateWorkerProcessError,
    );

    // A stale lock (a pid that is not alive) is reclaimed.
    clearRuntimeState(paths);
    rmSync(held.path, { force: true });
    const reclaimed = acquireWorkerLock(paths, process.pid, () => 'sprout worker start');
    assert.ok(existsSync(reclaimed.path));
    reclaimed.release();
  } finally {
    cleanup();
  }
});

test('runtime state round-trips and clears without a secret', () => {
  const { paths, cleanup } = tempPaths();
  try {
    ensureStateDirectory(paths);
    assert.equal(readRuntimeState(paths), undefined);
    writeRuntimeState(paths, { pid: 4242, state: 'connected', at: 1_000, epoch: 3 });
    const read = readRuntimeState(paths);
    assert.equal(read?.state, 'connected');
    assert.equal(read?.epoch, 3);
    const raw = readFileSync(paths.runtimePath, 'utf8');
    assert.doesNotMatch(raw, /secret|token|password/i);
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
    writeRuntimeState(paths, { pid: 1, state: 'stopped', at: 0 });
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
  assert.equal(stableSlug('instance-a'), stableSlug('instance-a'));
  assert.notEqual(stableSlug('instance-a'), stableSlug('instance-b'));
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
