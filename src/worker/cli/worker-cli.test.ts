import { test } from 'node:test';

import assert from 'node:assert/strict';import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { PassThrough } from 'node:stream';import { createWorkerCli, WORKER_EXIT, type EnrollmentConnector } from './worker-cli.ts';import { acquireWorkerLock, ensureStateDirectory, readConfig, readRuntimeState, workerHostPaths, writePrivateFile, type WorkerProcessIdentity, type WorkerProcessProbe } from './host-state.ts';

import {
  WorkerEnrollmentPendingError,
  WorkerEnrollmentRefusedError,
  type WorkerEnrollmentConnection,
} from '../enrollment-connector.ts';

import { WORKER_PROTOCOL_VERSION } from '../protocol.ts';

import { WORKER_DIAGNOSTICS } from '../diagnostics.ts';

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


/** A connector that answers as an approved, accepted Worker would. */
function acceptedConnector(): { connector: EnrollmentConnector; seen: { host: string | undefined; port: number | undefined; enrollmentId: string | undefined; secret: string | undefined; keyPath: string | undefined; log: string[] } } {
  const seen: { host: string | undefined; port: number | undefined; enrollmentId: string | undefined; secret: string | undefined; keyPath: string | undefined; log: string[] } = { host: undefined, port: undefined, enrollmentId: undefined, secret: undefined, keyPath: undefined, log: [] };
  const connector: EnrollmentConnector = async (input) => {
    seen.host = input.host;
    seen.port = input.port;
    seen.enrollmentId = input.enrollmentId;
    seen.secret = input.claimSecret;
    seen.keyPath = input.identityKeyPath;
    // Mirror the real connector's host-local key generation so the CLI's
    // storage and permission behaviour is exercised, not mocked away.
    writePrivateFile(input.identityKeyPath, 'PRIVATE KEY MATERIAL');
    const stream = new PassThrough();
    const connection: WorkerEnrollmentConnection = {
      stream,
      enrollmentId: input.enrollmentId,
      environmentInstanceId: 'env-synthetic',
      epoch: 1,
      connectionId: 'c-1',
      close: () => stream.end(),
    };
    return connection;
  };
  return { connector, seen };
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


test('enroll reads the claim secret from stdin, generates the key, and persists only reconnect facts', async () => {
  const h = harness({ secret: 'one-use-claim-secret-sentinel' });
  const { connector, seen } = acceptedConnector();
  const cli = createWorkerCli({
    paths: () => h.paths,
    stdout: (line) => h.out.push(line),
    stderr: (line) => h.err.push(line),
    readClaimSecret: async () => 'one-use-claim-secret-sentinel',
    connect: connector,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    run: (command, args) => {
      void command;
      void args;
      return '';
    },
  });
  try {
    const status = await cli.run(['enroll', '127.0.0.1:5174', 'enroll-synthetic']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.equal(seen.host, '127.0.0.1');
    assert.equal(seen.port, 5174);
    assert.equal(seen.secret, 'one-use-claim-secret-sentinel');
    assert.ok(seen.keyPath !== undefined);
    assert.equal(statSync(seen.keyPath!).mode & 0o777, 0o600, 'the private key is owner-only');
    const config = readConfig(h.paths);
    assert.equal(config.enrollmentId, 'enroll-synthetic');
    assert.equal(config.environmentInstanceId, 'env-synthetic');
    // The persisted configuration has no secret, no credential, no hostname, and
    // no absolute workspace path.
    const raw = readFileSync(h.paths.configPath, 'utf8');
    assert.doesNotMatch(raw, /one-use-claim-secret-sentinel/);
    assert.doesNotMatch(raw, /secret|token|password|credential/i);
    // The secret appears in no printed output either.
    assert.doesNotMatch(h.out.join('\n') + h.err.join('\n'), /one-use-claim-secret-sentinel/);
  } finally {
    h.cleanup();
  }
});


test('an interrupted enrollment leaves no reusable host-local identity', async () => {
  const h = harness();
  const connector: EnrollmentConnector = async () => {
    throw new Error('connection interrupted before the handshake completed');
  };
  const cli = createWorkerCli({
    paths: () => h.paths,
    stdout: (line) => h.out.push(line),
    stderr: (line) => h.err.push(line),
    readClaimSecret: async () => 'one-use-claim-secret-sentinel',
    connect: connector,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    run: () => '',
  });
  try {
    const status = await cli.run(['enroll', '127.0.0.1:5174', 'enroll-synthetic']);
    assert.equal(status, WORKER_EXIT.failure);
    assert.equal(existsSync(h.paths.configPath), false, 'no configuration was persisted');
    assert.equal(existsSync(h.paths.identityPath), false, 'the freshly generated key was removed');
  } finally {
    h.cleanup();
  }
});


test('a proven-but-unapproved identity persists configuration and reports awaiting approval', async () => {
  const h = harness();
  const connector: EnrollmentConnector = async () => {
    throw new WorkerEnrollmentPendingError('identity-claimed', 'env-synthetic');
  };
  const cli = createWorkerCli({
    paths: () => h.paths,
    stdout: (line) => h.out.push(line),
    stderr: (line) => h.err.push(line),
    readClaimSecret: async () => 'one-use-claim-secret-sentinel',
    connect: connector,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    run: () => '',
  });
  try {
    const status = await cli.run(['enroll', '127.0.0.1:5174', 'enroll-synthetic']);
    assert.equal(status, WORKER_EXIT.awaitingApproval);
    const config = readConfig(h.paths);
    assert.equal(config.environmentInstanceId, 'env-synthetic');
    assert.equal(config.enrollmentId, 'enroll-synthetic');
  } finally {
    h.cleanup();
  }
});


test('a refused enrollment reports a refusal and leaves no configuration', async () => {
  const h = harness();
  const connector: EnrollmentConnector = async () => {
    throw new WorkerEnrollmentRefusedError('the Worker identity is not approved for work', 'revoked');
  };
  const cli = createWorkerCli({
    paths: () => h.paths,
    stdout: (line) => h.out.push(line),
    stderr: (line) => h.err.push(line),
    readClaimSecret: async () => 'one-use-claim-secret-sentinel',
    connect: connector,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    run: () => '',
  });
  try {
    const status = await cli.run(['enroll', '127.0.0.1:5174', 'enroll-synthetic']);
    assert.equal(status, WORKER_EXIT.refused);
    assert.equal(existsSync(h.paths.configPath), false);
  } finally {
    h.cleanup();
  }
});


test('enroll rejects a malformed endpoint and never accepts the secret as an argument', async () => {
  const h = harness();
  try {
    const status = await h.run(['enroll', 'not-a-host', 'enroll-synthetic']);
    assert.equal(status, WORKER_EXIT.usage);
    // Passing a third argument (a would-be secret on argv) is a usage error.
    const extra = await h.run(['enroll', '127.0.0.1:5174', 'enroll-synthetic', 'secret-on-argv']);
    assert.equal(extra, WORKER_EXIT.usage);
  } finally {
    h.cleanup();
  }
});


test('enroll rejects private URL components before reading a secret or connecting', async () => {
  let connected = false;
  let readSecret = false;
  const h = harness();
  const cli = createWorkerCli({
    paths: () => h.paths,
    stdout: (line) => h.out.push(line),
    stderr: (line) => h.err.push(line),
    readClaimSecret: async () => {
      readSecret = true;
      return 'must-not-be-read';
    },
    connect: async () => {
      connected = true;
      throw new Error('must not connect');
    },
  });
  try {
    const privateEndpoint = 'wss://operator:credential@private.example:7443/path?secret=value#network';
    assert.equal(await cli.run(['enroll', privateEndpoint, 'enroll-synthetic']), WORKER_EXIT.usage);
    assert.equal(readSecret, false);
    assert.equal(connected, false);
    assert.doesNotMatch(h.out.join('\n') + h.err.join('\n'), /operator|credential|private\.example|secret=value|network/);
  } finally {
    h.cleanup();
  }
});


test('start refuses a duplicate live Worker for the same environment', async () => {
  const h = harness();
  const { connector } = acceptedConnector();
  const holderIdentity = processIdentity(77_001, 'b');
  const cli = createWorkerCli({
    paths: () => h.paths,
    stdout: (line) => h.out.push(line),
    stderr: (line) => h.err.push(line),
    connect: connector,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    run: () => '',
    processProbe: probe(holderIdentity),
  });
  try {
    ensureStateDirectory(h.paths);
    writePrivateFile(h.paths.configPath, JSON.stringify({
      version: 1,
      enrollmentId: 'enroll-synthetic',
      environmentInstanceId: 'env-synthetic',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      endpoint: { host: '127.0.0.1', port: 5174 },
      identityFileName: 'identity.pem',
    }));
    writePrivateFile(h.paths.identityPath, generateWorkerIdentity().privateKey);
    // A live lock held by a distinct opaque owner binding refuses start.
    const held = acquireWorkerLock(h.paths, holderIdentity, probe(holderIdentity));
    void held;
    const status = await cli.run(['start']);
    assert.equal(status, WORKER_EXIT.alreadyRunning);
    assert.match(h.err.join('\n'), /already running/);
  } finally {
    h.cleanup();
  }
});


test('start keeps a hostile protocol refusal out of CLI and persisted diagnostics', async () => {
  const privacyMarker = 'SPROUT_SYNTHETIC_CLI_SENTINEL_94e8c84957f242ec8a7a763b136c5c95';
  const privatePath = `/synthetic-private/${privacyMarker}/worker.sock`;
  const networkEndpoint = `${privacyMarker.toLowerCase()}.invalid:61947`;
  const hostileProtocol = `1;marker=${privacyMarker};path=${privatePath};endpoint=${networkEndpoint}`;
  const h = harness({
    connect: async () => {
      throw new WorkerEnrollmentRefusedError(hostileProtocol, 'incompatible');
    },
  });
  try {
    seedEnrolledHost(h.paths);
    assert.equal(await h.run(['start']), WORKER_EXIT.refused);
    const runtime = readRuntimeState(h.paths);
    assert.equal(runtime?.detail, WORKER_DIAGNOSTICS.protocolIncompatible);
    assert.match(h.err.join('\n'), new RegExp(WORKER_DIAGNOSTICS.connectionRefused));
    const exposed = JSON.stringify({ stdout: h.out, stderr: h.err, runtime });
    for (const sentinel of [privacyMarker, privatePath, networkEndpoint, hostileProtocol]) {
      assert.equal(exposed.includes(sentinel), false, `protocol evidence escaped through the CLI: ${sentinel}`);
    }
  } finally {
    h.cleanup();
  }
});


test('status reports not-enrolled before and stopped/connected after start', async () => {
  const h = harness();
  try {
    assert.equal(await h.run(['status']), WORKER_EXIT.notEnrolled);
    const { connector } = acceptedConnector();
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      connect: connector,
      platform: 'darwin',
      uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      run: () => '',
      serve: async () => undefined,
    });
    ensureStateDirectory(h.paths);
    writePrivateFile(h.paths.configPath, JSON.stringify({
      version: 1,
      enrollmentId: 'enroll-synthetic',
      environmentInstanceId: 'env-synthetic',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      endpoint: { host: '127.0.0.1', port: 5174 },
      identityFileName: 'identity.pem',
    }));
    writePrivateFile(h.paths.identityPath, generateWorkerIdentity().privateKey);
    assert.equal(await cli.run(['start']), WORKER_EXIT.ok);
    const runtime = readRuntimeState(h.paths);
    // After `serve` returns, the recorded state is `stopped`, so status is a
    // clean stopped state rather than a false connected one.
    assert.equal(runtime?.state, 'stopped');
    const statusOutput = h.out.join('\n');
    assert.doesNotMatch(statusOutput, /secret|token|password/i);
  } finally {
    h.cleanup();
  }
});


test('status reports a local configuration failure for a corrupt config', async () => {
  const h = harness();
  try {
    ensureStateDirectory(h.paths);
    writePrivateFile(h.paths.configPath, '{ not valid json with a sentinel sk-live-sentinel }');
    const status = await h.run(['status']);
    assert.equal(status, WORKER_EXIT.failure);
    const printed = h.out.join('\n');
    assert.match(printed, /local-configuration-failure/);
    assert.doesNotMatch(printed, /sk-live-sentinel/);
  } finally {
    h.cleanup();
  }
});
