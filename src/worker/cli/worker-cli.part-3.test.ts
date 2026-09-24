import { test } from 'node:test';

import assert from 'node:assert/strict';import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';import { createWorkerCli, WORKER_EXIT, type EnrollmentConnector } from './worker-cli.ts';import { acquireWorkerLock, ensureStateDirectory, writeRuntimeState, workerHostPaths, writePrivateFile, type WorkerProcessIdentity, type WorkerProcessProbe } from './host-state.ts';

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


test('status preserves the recorded terminal refusal after the refused process exits', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    writeRuntimeState(h.paths, {
      pid: 424_242, process: processIdentity(424_242), state: 'revoked',
      at: 1,
      detail: 'the Sprout instance refused the connection',
    });
    // The recorded pid is dead (nobody alive there), but the refusal fact is
    // durable: status must report revoked, not a healthy stopped.
    assert.equal(await h.run(['status']), WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), /state: revoked/);
    assert.doesNotMatch(h.out.join('\n'), /state: stopped/);
  } finally {
    h.cleanup();
  }
});


test('status preserves pending-approval and incompatible refusals after exit', async () => {
  for (const terminal of ['pending-approval', 'incompatible'] as const) {
    const h = harness();
    try {
      seedEnrolledHost(h.paths);
      writeRuntimeState(h.paths, { pid: 424_242, process: processIdentity(424_242), state: terminal, at: 1 });
      assert.equal(await h.run(['status']), WORKER_EXIT.ok);
      assert.match(h.out.join('\n'), new RegExp(`state: ${terminal}`));
    } finally {
      h.cleanup();
    }
  }
});


test('status reports a live connected Worker only when the pid is a verified Worker daemon', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    // The live PID is trusted only when its token and OS start marker match.
    const liveIdentity = processIdentity(process.pid, 'f');
    writeRuntimeState(h.paths, { pid: process.pid, process: liveIdentity, state: 'connected', at: 1, epoch: 2 });
    const liveCli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      platform: 'darwin',
      uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      run: () => '',
      processProbe: probe(liveIdentity),
    });
    assert.equal(await liveCli.run(['status']), WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), /state: connected/);

    // A reused PID with a different token is not trusted.
    const h2 = harness();
    try {
      seedEnrolledHost(h2.paths);
      const oldIdentity = processIdentity(process.pid, 'g');
      const replacementIdentity = processIdentity(process.pid, 'h');
      writeRuntimeState(h2.paths, { pid: process.pid, process: oldIdentity, state: 'connected', at: 1, epoch: 2 });
      const cli = createWorkerCli({
        paths: () => h2.paths,
        stdout: (line) => h2.out.push(line),
        stderr: (line) => h2.err.push(line),
        platform: 'darwin',
        uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
        run: () => '',
        processProbe: probe(replacementIdentity),
      });
      assert.equal(await cli.run(['status']), WORKER_EXIT.ok);
      assert.match(h2.out.join('\n'), /state: stopped/, 'a same-PID replacement is never reported connected');
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});


test('status reports a local configuration failure when the identity key is missing', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths, { identity: false });
    // Config present, identity key absent.
    assert.equal(existsSync(h.paths.identityPath), false);
    const status = await h.run(['status']);
    assert.equal(status, WORKER_EXIT.failure);
    assert.match(h.out.join('\n'), /state: local-configuration-failure/);
  } finally {
    h.cleanup();
  }
});


test('status reports a local configuration failure when the identity key is over-permissive', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    chmodSync(h.paths.identityPath, 0o644);
    const status = await h.run(['status']);
    assert.equal(status, WORKER_EXIT.failure);
    assert.match(h.out.join('\n'), /state: local-configuration-failure/);
  } finally {
    h.cleanup();
  }
});


test('status reports a local configuration failure when the identity key content is malformed', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    writePrivateFile(h.paths.identityPath, 'not a private key');
    const status = await h.run(['status']);
    assert.equal(status, WORKER_EXIT.failure);
    assert.match(h.out.join('\n'), /state: local-configuration-failure/);
    assert.doesNotMatch(h.out.join('\n') + h.err.join('\n'), /not a private key|identity\.pem|sprout-worker-cli/);
  } finally {
    h.cleanup();
  }
});


test('status reports unavailable live process evidence instead of stopped', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    writeRuntimeState(h.paths, { pid: process.pid, process: processIdentity(process.pid, 'z'), state: 'connected', at: 1 });
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      platform: 'darwin',
      uid: 501,
      run: () => '',
      processProbe: () => ({ state: 'unknown' }),
    });
    const status = await cli.run(['status']);
    assert.equal(status, WORKER_EXIT.failure);
    assert.match(h.out.join('\n'), /state: local-configuration-failure/);
    assert.doesNotMatch(h.out.join('\n'), /state: stopped/);
  } finally {
    h.cleanup();
  }
});


test('status command gives live unavailable evidence precedence over missing config', async () => {
  const h = harness();
  try {
    ensureStateDirectory(h.paths);
    writeRuntimeState(h.paths, {
      pid: process.pid,
      process: processIdentity(process.pid, 'm'),
      state: 'stopped',
      at: 1,
    });
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      platform: 'darwin',
      uid: 501,
      run: () => '',
      processProbe: () => ({ state: 'unknown' }),
    });
    assert.equal(await cli.run(['status']), WORKER_EXIT.failure);
    assert.match(h.out.join('\n'), /state: local-configuration-failure/);
    assert.doesNotMatch(h.out.join('\n'), /state: not-enrolled|state: stopped/);
  } finally {
    h.cleanup();
  }
});


test('status command gives live unavailable evidence precedence over a recorded stopped label', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    writeRuntimeState(h.paths, {
      pid: process.pid,
      process: processIdentity(process.pid, 'n'),
      state: 'stopped',
      at: 1,
    });
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      platform: 'darwin',
      uid: 501,
      run: () => '',
      processProbe: () => ({ state: 'unknown' }),
    });
    assert.equal(await cli.run(['status']), WORKER_EXIT.failure);
    assert.match(h.out.join('\n'), /state: local-configuration-failure/);
    assert.doesNotMatch(h.out.join('\n'), /state: stopped/);
  } finally {
    h.cleanup();
  }
});


test('status reports a malformed runtime record as a local configuration failure', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    writePrivateFile(h.paths.runtimePath, JSON.stringify({ pid: 1, process: processIdentity(1), state: 'possessed', at: 0 }));
    const status = await h.run(['status']);
    assert.equal(status, WORKER_EXIT.failure);
    assert.match(h.out.join('\n'), /state: local-configuration-failure/);
  } finally {
    h.cleanup();
  }
});


test('reset refuses while a live foreground Worker holds the lock', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    const holderIdentity = processIdentity(77_002, 'c');
    const holder = acquireWorkerLock(h.paths, holderIdentity, probe(holderIdentity));
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      confirm: async () => true,
      platform: 'darwin',
      uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      run: () => '',
      processProbe: probe(holderIdentity),
    });
    const status = await cli.run(['reset', '--yes']);
    holder.release();
    assert.equal(status, WORKER_EXIT.failure);
    assert.match(h.err.join('\n'), /still owns/);
    assert.ok(existsSync(h.paths.identityPath), 'the identity survives a refused reset');
    assert.ok(existsSync(h.paths.configPath), 'the configuration survives a refused reset');
  } finally {
    h.cleanup();
  }
});


test('reset refuses its maintenance fence when a live Worker binding is unavailable', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    const holderIdentity = processIdentity(77_004, 'u');
    const resetIdentity = processIdentity(process.pid, 'v');
    const holder = acquireWorkerLock(h.paths, holderIdentity, probe(holderIdentity));
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      confirm: async () => true,
      platform: 'darwin',
      uid: 501,
      run: () => '',
      currentProcess: () => resetIdentity,
      // This models a live process whose environment/start marker cannot be
      // read (or a platform that cannot provide it), not a proven-dead pid.
      processProbe: () => ({ state: 'unknown' }),
    });
    const status = await cli.run(['reset', '--yes']);
    assert.equal(status, WORKER_EXIT.failure);
    assert.match(h.err.join('\n'), /still owns/);
    assert.ok(existsSync(h.paths.identityPath), 'the destructive reset is fenced by unavailable evidence');
    assert.ok(existsSync(h.paths.configPath), 'the configuration survives the refused reset');
    holder.release();
  } finally {
    h.cleanup();
  }
});
