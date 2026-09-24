import { test } from 'node:test';

import assert from 'node:assert/strict';import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';import { acquireWorkerLock, clearRuntimeState, DuplicateWorkerProcessError, ensureStateDirectory, isEnrolled, isRestrictive, readConfig, readIdentityKey, readRuntimeState, removeHostState, stableSlug, writeConfig, writePrivateFile, writeRuntimeState, workerHostPaths, workerServiceLabel, WorkerHostStateError, type WorkerHostConfig, type WorkerProcessIdentity, type WorkerProcessProbe } from './host-state.ts';import { renderLaunchAgent } from './launch-agent.ts';


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
