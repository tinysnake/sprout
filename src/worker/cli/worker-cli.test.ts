import { test } from 'node:test';

import assert from 'node:assert/strict';import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { PassThrough } from 'node:stream';import { createWorkerCli, WORKER_EXIT, type EnrollmentConnector } from './worker-cli.ts';import { acquireWorkerLock, ensureStateDirectory, readConfig, readRuntimeState, writeRuntimeState, workerHostPaths, workerLockPath, writePrivateFile, type WorkerProcessIdentity, type WorkerProcessProbe } from './host-state.ts';

import {
  WorkerEnrollmentPendingError,
  WorkerEnrollmentRefusedError,
  type WorkerEnrollmentConnection,
} from '../enrollment-connector.ts';

import { WORKER_PROTOCOL_VERSION } from '../protocol.ts';

import { WORKER_DIAGNOSTICS, staticRefusalReason } from '../diagnostics.ts';

import { generateWorkerIdentity } from '../../environment/worker-proof.ts';
import { WORKER_TRANSPORT_REFUSAL_REASON } from '../../environment/worker-transport.ts';


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


test('a refused enrollment surfaces the static transport-rule reason to the operator', async () => {
  const h = harness({
    connect: async () => {
      throw new WorkerEnrollmentRefusedError(WORKER_TRANSPORT_REFUSAL_REASON, 'refused');
    },
  });
  try {
    assert.equal(await h.run(['enroll', '127.0.0.1:5174', 'enroll-synthetic']), WORKER_EXIT.refused);
    // The operator can now tell a transport refusal from an unreachable
    // endpoint: the exact, static rule text is printed.
    assert.ok(
      h.err.join('\n').includes(WORKER_TRANSPORT_REFUSAL_REASON),
      'the static transport refusal reason must reach stderr',
    );
  } finally {
    h.cleanup();
  }
});


test('a refusal with unrecognized server text keeps only the sanitized category', async () => {
  const secret = 'sk-live-SPROUT-CLI-SENTINEL-4f2a9c8e';
  const privatePath = '/Users/synthetic-private/worker-identity.pem';
  const tokenUrl = 'wss://token-abc123@private.invalid:7443/api/worker/connect';
  const hostile = `${secret} at ${privatePath} via ${tokenUrl}`;
  const h = harness({
    connect: async () => {
      throw new WorkerEnrollmentRefusedError(hostile, 'refused');
    },
  });
  try {
    assert.equal(await h.run(['enroll', '127.0.0.1:5174', 'enroll-synthetic']), WORKER_EXIT.refused);
    const printed = h.err.join('\n') + h.out.join('\n');
    assert.match(printed, /enrollment could not be completed/);
    for (const sentinel of [secret, privatePath, tokenUrl, hostile]) {
      assert.equal(printed.includes(sentinel), false, `untrusted refusal text escaped: ${sentinel}`);
    }
    // No secret-shaped substring of any kind may appear, even a fragment.
    assert.doesNotMatch(printed, /sk-live-|BEGIN [A-Z ]*PRIVATE KEY|token-abc123/);
  } finally {
    h.cleanup();
  }
});


test('every enrollment failure path stays free of secret-shaped and path material', async () => {
  const secret = 'sk-live-SPROUT-CLI-SENTINEL-4f2a9c8e';
  const privatePath = '/Users/synthetic-private/worker-identity.pem';
  const tokenUrl = 'wss://token-abc123@private.invalid:7443/api/worker/connect';
  const hostile = `${secret} at ${privatePath} via ${tokenUrl}`;
  const connectors: EnrollmentConnector[] = [
    async () => { throw new WorkerEnrollmentRefusedError(hostile, 'refused'); },
    async () => { throw new WorkerEnrollmentRefusedError(hostile, 'incompatible'); },
    async () => { throw new WorkerEnrollmentRefusedError(hostile, 'revoked'); },
    async () => { throw new Error(hostile); },
    async () => { throw new WorkerEnrollmentPendingError(hostile, hostile); },
  ];
  for (const connect of connectors) {
    const h = harness({ connect });
    try {
      const status = await h.run(['enroll', '127.0.0.1:5174', 'enroll-synthetic']);
      assert.notEqual(status, WORKER_EXIT.ok);
      const printed = h.err.join('\n') + h.out.join('\n');
      for (const sentinel of [secret, privatePath, tokenUrl, hostile]) {
        assert.equal(printed.includes(sentinel), false, `failure path leaked: ${sentinel}`);
      }
      assert.doesNotMatch(printed, /sk-live-|BEGIN [A-Z ]*PRIVATE KEY|token-abc123/);
    } finally {
      h.cleanup();
    }
  }
});


test('static refusal classification is an allowlist, not a trust in server text', () => {
  assert.equal(staticRefusalReason(WORKER_TRANSPORT_REFUSAL_REASON), WORKER_TRANSPORT_REFUSAL_REASON);
  assert.equal(staticRefusalReason(WORKER_DIAGNOSTICS.enrollmentClaimRefused), WORKER_DIAGNOSTICS.enrollmentClaimRefused);
  assert.equal(staticRefusalReason('sk-live-not-a-known-reason'), undefined);
  assert.equal(staticRefusalReason('/Users/private/worker.sock'), undefined);
  assert.equal(staticRefusalReason('wss://token@host/api/worker/connect'), undefined);
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
    const status = await cli.run(['start', '--foreground']);
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
    assert.equal(await h.run(['start', '--foreground']), WORKER_EXIT.refused);
    const runtime = readRuntimeState(h.paths);
    assert.equal(runtime?.detail, WORKER_DIAGNOSTICS.protocolIncompatible);
    assert.match(h.err.join('\n'), new RegExp(WORKER_DIAGNOSTICS.connectionRefused));
    // The recognized incompatibility is surfaced as its static category; the
    // hostile message text stays out entirely.
    assert.ok(h.err.join('\n').includes(WORKER_DIAGNOSTICS.protocolIncompatible));
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
    assert.equal(await cli.run(['start', '--foreground']), WORKER_EXIT.ok);
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


test('start reconnects after the channel closes and stops on the operator signal', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    // Connect succeeds, the channel closes, the CLI re-connects: two accepted
    // connections total. The loop's sleep is injected so this runs instantly.
    const sleeps: number[] = [];
    let connectCount = 0;
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

    // The first serve session ends with a lost channel (a core restart is a
    // transient outage); the second ends with a deliberate operator stop. The
    // loop must reconnect once and then exit cleanly.
    const cli2 = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      connect: async (input) => {
        connectCount += 1;
        const stream = new PassThrough();
        return {
          stream,
          enrollmentId: input.enrollmentId,
          environmentInstanceId: 'env-synthetic',
          epoch: connectCount,
          connectionId: `c-${String(connectCount)}`,
          close: () => stream.end(),
        };
      },
      sleep: async (ms) => { sleeps.push(ms); },
      platform: 'darwin',
      uid: 501,
      currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      run: () => '',
      serve: async () => (connectCount === 1 ? 'channel-closed' : 'shutdown'),
    });
    const status = await cli2.run(['start', '--foreground']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.equal(connectCount, 2, 'the daemon reconnected once after the channel closed');
    assert.ok(sleeps.length >= 1, 'the reconnect loop slept before retrying');
    assert.match(h.err.join('\n'), /reconnect/);
    assert.match(h.out.join('\n'), /epoch 2/);
  } finally {
    h.cleanup();
  }
});


test('stop during the reconnect backoff ends the loop, records stopped, and releases the lock', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    let connects = 0;
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      connect: async () => {
        connects += 1;
        throw new Error('the core is unreachable');
      },
      // The backoff never resolves on its own: only a stop may wake it. A
      // regression that ignores the signal fails the bounded wait below
      // instead of hanging the suite.
      sleep: () => new Promise<void>(() => {}),
      platform: 'darwin',
      uid: 501,
      currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      run: () => '',
    });
    const runPromise = cli.run(['start', '--foreground']);
    // `retrying in` is printed immediately before the loop parks in its
    // backoff, so waiting for it removes the race between the first attempt
    // and the stop below.
    const waitForBackoff = Date.now() + 2_000;
    while (!h.err.some((line) => /retrying in/.test(line)) && Date.now() < waitForBackoff) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(connects, 1, 'the loop attempted a connection before the stop');
    assert.match(h.err.join('\n'), /retrying in/, 'the loop reached its backoff');
    process.emit('SIGTERM');
    const status = await Promise.race([
      runPromise,
      new Promise<string>((resolve) => { setTimeout(() => resolve('timeout'), 2_000); }),
    ]);
    assert.equal(status, WORKER_EXIT.ok);
    assert.match(h.err.join('\n'), /stopped by the operator/);
    assert.equal(readRuntimeState(h.paths)?.state, 'stopped');
    assert.equal(existsSync(workerLockPath(h.paths)), false, 'the lock is free for the next start');
  } finally {
    h.cleanup();
  }
});


test('start daemonizes by default: it spawns a detached foreground child and returns', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    const spawned: { args: readonly string[]; detached: boolean }[] = [];
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      platform: 'darwin',
      uid: 501,
      currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      run: () => '',
      // Intercept the daemon spawn: the real spawnDetachedWorker is a module
      // function, so assert via the child-process seam instead. The CLI must
      // return without serving (no connect call) and report the log path.
      serve: async () => { throw new Error('the daemon parent must not serve'); },
    });
    // The daemon path spawns a real detached child; in tests that child would
    // run the real CLI. Assert the observable parent-side contract instead:
    // the parent does not serve and does not connect (the injected connect is
    // absent, so a connect attempt would hit the network and fail the test
    // loudly). The parent exits ok with the daemon message.
    const status = await cli.run(['start']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), /daemon started/);
    assert.match(h.out.join('\n'), /Logs:/);
    void spawned;
  } finally {
    h.cleanup();
  }
});

test('stop signals the recorded running daemon and reports a quiet host', async () => {
  const h = harness();
  try {
    // No runtime record: stop is a clean no-op ok.
    ensureStateDirectory(h.paths);
    assert.equal(await h.run(['stop']), WORKER_EXIT.ok);
    assert.match(h.err.join('\n') + h.out.join('\n'), /no running Worker|not running/);

    // A recorded live daemon (this process, so isProcessAlive passes) is
    // signalled with SIGTERM.
    writePrivateFile(h.paths.configPath, JSON.stringify({
      version: 1,
      enrollmentId: 'enroll-synthetic',
      environmentInstanceId: 'env-synthetic',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      endpoint: { host: '127.0.0.1', port: 5174 },
      identityFileName: 'identity.pem',
    }));
    const killed: number[] = [];
    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal !== undefined && signal !== 0) killed.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      writeRuntimeState(h.paths, {
        pid: process.pid,
        process: { pid: process.pid, startIdentity: 'test-start-stop', ownerToken: 'a'.repeat(43) },
        state: 'connected',
        at: 1_000,
      });
      const status = await h.run(['stop']);
      assert.equal(status, WORKER_EXIT.ok);
      assert.deepEqual(killed, [process.pid]);
      assert.match(h.out.join('\n'), /Stop signalled/);
    } finally {
      process.kill = originalKill;
    }
  } finally {
    h.cleanup();
  }
});
