import { test } from 'node:test';

import assert from 'node:assert/strict';import { existsSync, mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';import { createWorkerCli, WORKER_EXIT, type EnrollmentConnector } from './worker-cli.ts';import { acquireWorkerResetLock, ensureStateDirectory, workerHostPaths, workerServiceLabel, writePrivateFile, type WorkerProcessIdentity, type WorkerProcessProbe } from './host-state.ts';

import { WORKER_PROTOCOL_VERSION } from '../protocol.ts';

import { generateWorkerIdentity } from '../../environment/worker-proof.ts';


/**
 * The `sprout worker` macOS CLI (#117).
 *
 * These tests drive the real command control flow over temporary host-local
 * state and a substituted outbound connector, so they assert the observable
 * contract: exit statuses, non-echoing stdin secret handling, restrictive
 * storage, duplicate-process refusal, reset semantics, and a `status`
 * projection that never prints a secret.
 */

function harness(overrides: {
  readonly connect?: EnrollmentConnector;
  readonly secret?: string;
  readonly confirm?: boolean;
  readonly platform?: NodeJS.Platform;
} = {}): {
  paths: ReturnType<typeof workerHostPaths>;
  run: (argv: readonly string[]) => Promise<number>;
  out: string[];
  err: string[];
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-cli-'));
  const paths = workerHostPaths({
    HOME: root,
    SPROUT_WORKER_HOME: join(root, 'state'),
    SPROUT_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents'),
    SPROUT_CLI_PATH: '/synthetic/bin/sprout',
  });
  const out: string[] = [];
  const err: string[] = [];
  const cli = createWorkerCli({
    paths: () => paths,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    readClaimSecret: async () => overrides.secret ?? 'one-use-claim-secret-sentinel',
    confirm: async () => overrides.confirm ?? true,
    platform: overrides.platform ?? 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    now: () => 1_000,
    run: (command, args) => {
      // A real `command -v` probe is not part of the CLI's unit contract; the
      // substituted runner answers every launchctl verb with an empty success.
      void command;
      void args;
      return '';
    },
    ...(overrides.connect !== undefined ? { connect: overrides.connect } : {}),
    serve: async () => undefined,
  });
  return {
    paths,
    run: (argv) => cli.run(argv),
    out,
    err,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
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


/** Seed an enrolled host: restrictive config plus (by default) identity key. */
function seedEnrolledHost(
  paths: ReturnType<typeof workerHostPaths>,
  options: { readonly identity?: boolean } = {},
): void {
  ensureStateDirectory(paths);
  writePrivateFile(paths.configPath, JSON.stringify({
    version: 1,
    enrollmentId: 'enroll-synthetic',
    environmentInstanceId: 'env-synthetic',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    endpoint: { host: '127.0.0.1', port: 5174 },
    identityFileName: 'identity.pem',
  }));
  if (options.identity !== false) {
    writePrivateFile(paths.identityPath, generateWorkerIdentity().privateKey);
  }
}


test('a reset maintenance fence prevents a concurrent start from racing destructive removal', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    const resetIdentity = processIdentity(77_003, 'd');
    const resetLock = acquireWorkerResetLock(h.paths, resetIdentity, probe(resetIdentity));
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      platform: 'darwin',
      uid: 501,
      run: () => '',
      processProbe: probe(resetIdentity),
      currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      serve: async () => undefined,
    });
    assert.equal(await cli.run(['start']), WORKER_EXIT.alreadyRunning);
    assert.ok(existsSync(h.paths.configPath), 'the start lost the exclusive fence before any state changed');
    resetLock.release();
  } finally {
    h.cleanup();
  }
});


test('reset fails closed when the LaunchAgent cannot be booted out', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    const plistPath = join(h.paths.launchAgentsDirectory, `${workerServiceLabel('env-synthetic')}.plist`);
    writePrivateFile(plistPath, '<plist/>');
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      confirm: async () => true,
      platform: 'darwin',
      uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      run: (command, args) => {
        if (command === 'launchctl' && args[0] === 'bootout') {
          throw new Error('launchctl: bootout failed: 36: Operation not permitted');
        }
        if (command === 'launchctl' && args[0] === 'print') {
          return `service = ${workerServiceLabel('env-synthetic')}`;
        }
        return '';
      },
    });
    const status = await cli.run(['reset', '--yes']);
    assert.equal(status, WORKER_EXIT.serviceFailure);
    assert.match(h.err.join('\n') + h.out.join('\n'), /could not be removed/);
    // Fail closed: nothing was destroyed while the service is still loaded.
    assert.ok(existsSync(h.paths.identityPath));
    assert.ok(existsSync(h.paths.configPath));
    assert.ok(existsSync(plistPath), 'the plist of the loaded service is left in place');
  } finally {
    h.cleanup();
  }
});


test('reset succeeds when the service is not loaded and the plist is present', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    const plistPath = join(h.paths.launchAgentsDirectory, `${workerServiceLabel('env-synthetic')}.plist`);
    writePrivateFile(plistPath, '<plist/>');
    const status = await h.run(['reset', '--yes']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.equal(existsSync(plistPath), false, 'a proven-unloaded service plist is removed');
    assert.equal(existsSync(h.paths.identityPath), false);
    assert.equal(existsSync(h.paths.configPath), false);
  } finally {
    h.cleanup();
  }
});


test('reset removes only the LaunchAgent bound to the current environment state', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    const current = join(h.paths.launchAgentsDirectory, `${workerServiceLabel('env-synthetic')}.plist`);
    const unrelated = join(h.paths.launchAgentsDirectory, `${workerServiceLabel('other-environment')}.plist`);
    writePrivateFile(current, '<plist/>');
    writePrivateFile(unrelated, '<plist/>');
    assert.equal(await h.run(['reset', '--yes']), WORKER_EXIT.ok);
    assert.equal(existsSync(current), false);
    assert.equal(existsSync(unrelated), true, 'reset must not enumerate or remove another environment label');
  } finally {
    h.cleanup();
  }
});


test('uninstall-service fails closed when bootout fails and keeps the plist', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    const plistPath = join(h.paths.launchAgentsDirectory, `${workerServiceLabel('env-synthetic')}.plist`);
    writePrivateFile(plistPath, '<plist/>');
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      platform: 'darwin',
      uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      run: (command, args) => {
        if (command === 'launchctl' && args[0] === 'bootout') {
          throw new Error('launchctl: bootout failed: 36: Operation not permitted');
        }
        if (command === 'launchctl' && args[0] === 'print') {
          return `service = ${workerServiceLabel('env-synthetic')}`;
        }
        return '';
      },
    });
    const status = await cli.run(['uninstall-service']);
    assert.equal(status, WORKER_EXIT.serviceFailure);
    assert.ok(existsSync(plistPath), 'a loaded service plist is never silently deleted');
  } finally {
    h.cleanup();
  }
});


test('uninstall-service treats a not-loaded bootout as removable and succeeds', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    const plistPath = join(h.paths.launchAgentsDirectory, `${workerServiceLabel('env-synthetic')}.plist`);
    writePrivateFile(plistPath, '<plist/>');
    const status = await h.run(['uninstall-service']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.equal(existsSync(plistPath), false);
  } finally {
    h.cleanup();
  }
});
