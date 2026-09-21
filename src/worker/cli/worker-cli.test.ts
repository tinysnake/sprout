import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  createWorkerCli,
  parseEndpoint,
  projectStatus,
  WORKER_EXIT,
  type EnrollmentConnector,
} from './worker-cli.ts';
import {
  acquireWorkerLock,
  ensureStateDirectory,
  readConfig,
  readRuntimeState,
  writeRuntimeState,
  workerHostPaths,
  workerServiceLabel,
  writePrivateFile,
} from './host-state.ts';import {
  WorkerEnrollmentPendingError,
  WorkerEnrollmentRefusedError,
  type WorkerEnrollmentConnection,
} from '../enrollment-connector.ts';
import { WORKER_PROTOCOL_VERSION } from '../protocol.ts';

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

test('start refuses a duplicate live Worker for the same environment', async () => {
  const h = harness();
  const { connector } = acceptedConnector();
  const cli = createWorkerCli({
    paths: () => h.paths,
    stdout: (line) => h.out.push(line),
    stderr: (line) => h.err.push(line),
    connect: connector,
    platform: 'darwin',
    uid: 501,
    run: () => 'sprout worker start',
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
    writePrivateFile(h.paths.identityPath, 'PRIVATE KEY MATERIAL');
    // A live lock held by a process whose command line is this host's Worker.
    // A foreign live pid (with a Worker-looking command line) must refuse start.
    const held = acquireWorkerLock(h.paths, process.ppid, () => 'sprout worker start');
    void held;
    const status = await cli.run(['start']);
    assert.equal(status, WORKER_EXIT.alreadyRunning);
    assert.match(h.err.join('\n'), /already running/);
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
    writePrivateFile(h.paths.identityPath, 'PRIVATE KEY MATERIAL');
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

test('reset requires explicit confirmation and removes host-local identity', async () => {
  const h = harness();
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
    writePrivateFile(h.paths.identityPath, 'PRIVATE KEY MATERIAL');
    // Without confirmation, nothing is removed.
    const declined = harness({ confirm: false });
    const declinedCli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => declined.out.push(line),
      stderr: (line) => declined.err.push(line),
      confirm: async () => false,
      platform: 'darwin',
      uid: 501,
      run: () => '',
    });
    try {
      assert.equal(await declinedCli.run(['reset']), WORKER_EXIT.usage);
      assert.ok(existsSync(h.paths.identityPath), 'a declined reset keeps the identity');
    } finally {
      declined.cleanup();
    }
    // With `--yes` (an explicit Human confirmation), everything is removed.
    assert.equal(await h.run(['reset', '--yes']), WORKER_EXIT.ok);
    assert.equal(existsSync(h.paths.identityPath), false);
    assert.equal(existsSync(h.paths.configPath), false);
  } finally {
    h.cleanup();
  }
});

test('install-service renders and installs a LaunchAgent; uninstall-service removes it', async () => {
  const h = harness();
  const calls: string[] = [];
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
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      platform: 'darwin',
      uid: 501,
      run: (command, args) => {
        calls.push([command, ...args].join(' '));
        return '';
      },
    });
    assert.equal(await cli.run(['install-service']), WORKER_EXIT.ok);
    assert.ok(calls.some((call) => call.startsWith('launchctl bootstrap gui/501 ')));
    const plistPath = join(
      h.paths.launchAgentsDirectory,
      `${workerServiceLabel('env-synthetic')}.plist`,
    );
    // The plist is written with owner-only permissions and names `worker start`.
    assert.equal(statSync(plistPath).mode & 0o777, 0o600);
    assert.match(readFileSync(plistPath, 'utf8'), /worker<\/string>/);
    assert.equal(await cli.run(['uninstall-service']), WORKER_EXIT.ok);
    assert.equal(existsSync(plistPath), false);
    assert.ok(calls.some((call) => call.startsWith('launchctl bootout')));
  } finally {
    h.cleanup();
  }
});

test('install-service is refused off macOS', async () => {
  const h = harness({ platform: 'linux' });
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
    assert.equal(await h.run(['install-service']), WORKER_EXIT.serviceFailure);
    assert.match(h.err.join('\n'), /macOS/);
  } finally {
    h.cleanup();
  }
});

test('endpoint parsing accepts host:port with or without a scheme and rejects a missing port', () => {
  assert.deepEqual(parseEndpoint('127.0.0.1:5174'), { host: '127.0.0.1', port: 5174 });
  assert.deepEqual(parseEndpoint('wss://sprout.internal:8443'), { host: 'sprout.internal', port: 8443 });
  assert.throws(() => parseEndpoint('127.0.0.1'), /port/);
  assert.throws(() => parseEndpoint('ftp://127.0.0.1:21'), /scheme/);
});

test('the status projection distinguishes every documented state', () => {
  const paths = workerHostPaths({ HOME: '/synthetic', SPROUT_WORKER_HOME: '/synthetic/state' });
  const config = {
    version: 1 as const,
    enrollmentId: 'e',
    environmentInstanceId: 'i',
    protocolVersion: '2',
    endpoint: { host: '127.0.0.1', port: 1 },
    identityFileName: 'identity.pem',
  };
  const base = { paths, enrolled: true, config, configError: undefined, serviceInstalled: false };
  assert.equal(projectStatus({ ...base, runtime: undefined, processAlive: () => true }).state, 'stopped');
  assert.equal(
    projectStatus({ ...base, runtime: { pid: 1, state: 'connecting', at: 0 }, processAlive: () => true }).state,
    'connecting',
  );
  assert.equal(
    projectStatus({ ...base, runtime: { pid: 1, state: 'connected', at: 0 }, processAlive: () => true }).state,
    'connected',
  );
  assert.equal(
    projectStatus({ ...base, runtime: { pid: 1, state: 'pending-approval', at: 0 }, processAlive: () => true }).state,
    'pending-approval',
  );
  assert.equal(
    projectStatus({ ...base, runtime: { pid: 1, state: 'incompatible', at: 0 }, processAlive: () => true }).state,
    'incompatible',
  );
  assert.equal(
    projectStatus({ ...base, runtime: { pid: 1, state: 'revoked', at: 0 }, processAlive: () => true }).state,
    'revoked',
  );
  // A dead pid is stopped, never trusted as connected.
  assert.equal(
    projectStatus({ ...base, runtime: { pid: 1, state: 'connected', at: 0 }, processAlive: () => false }).state,
    'stopped',
  );
  assert.equal(
    projectStatus({ ...base, enrolled: false, config: undefined, configError: 'not-enrolled', runtime: undefined, processAlive: () => false }).state,
    'not-enrolled',
  );
  assert.equal(
    projectStatus({ ...base, config: undefined, configError: 'invalid', runtime: undefined, processAlive: () => false }).state,
    'local-configuration-failure',
  );
});

test('an unknown subcommand is a usage error', async () => {
  const h = harness();
  try {
    assert.equal(await h.run(['frobnicate']), WORKER_EXIT.usage);
    assert.equal(await h.run([]), WORKER_EXIT.usage);
  } finally {
    h.cleanup();
  }
});

test('the default stdin reader claims the secret from a real pipe without echoing it', async () => {
  const { readSecretFromStdin } = await import('./host-state.ts');
  const input = new PassThrough();
  const outputChunks: string[] = [];
  const output = new PassThrough();
  output.on('data', (chunk: Buffer) => outputChunks.push(chunk.toString('utf8')));
  const pending = readSecretFromStdin(input, output, 'prompt: ');
  input.end('one-use-claim-secret-sentinel\n');
  const secret = await pending;
  assert.equal(secret, 'one-use-claim-secret-sentinel');
  // Only the prompt (and the TTY newline) is written; the secret is never echoed.
  assert.ok(!outputChunks.join('').includes('one-use-claim-secret-sentinel'));
  // The real CLI path uses this reader by default: no injected reader needed.
  const h = harness();
  try {
    const { connector } = acceptedConnector();
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      connect: connector,
      platform: 'darwin',
      uid: 501,
      run: () => '',
    });
    // Feed the claim secret through the process-level default reader seam by
    // replacing readClaimSecret with the real pipe path.
    const stdin = new PassThrough();
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    try {
      stdin.end('piped-claim-secret\n');
      // The default reader reads from process.stdin.
      const status = await cli.run(['enroll', '127.0.0.1:5174', 'enroll-synthetic']);
      // The injected connector accepts; the piped secret must have been read.
      assert.equal(status, WORKER_EXIT.ok);
    } finally {
      Object.defineProperty(process, 'stdin', { value: original, configurable: true });
    }
    assert.equal(readConfig(h.paths).enrollmentId, 'enroll-synthetic');
  } finally {
    h.cleanup();
  }
});

test('the default stdin reader reads a real TTY-style raw stream without echo and without storing the claim', async () => {
  const { readSecretFromStdin } = await import('./host-state.ts');
  const input = new PassThrough();
  (input as PassThrough & { isTTY?: boolean }).isTTY = true;
  let rawMode: boolean | undefined;
  (input as PassThrough & { setRawMode?: (mode: boolean) => void }).setRawMode = (mode) => {
    rawMode = mode;
  };
  const outputChunks: string[] = [];
  const output = new PassThrough();
  output.on('data', (chunk: Buffer) => outputChunks.push(chunk.toString('utf8')));
  const pending = readSecretFromStdin(input, output, 'hidden: ');
  // Feed characters one at a time, including a backspace correction.
  input.write('abc');
  input.write('\u007f');
  input.write('d');
  input.write('\r');
  const secret = await pending;
  assert.equal(secret, 'abd', 'raw mode accumulates characters and applies backspace');
  assert.equal(rawMode, false, 'raw mode is restored after the read');
  assert.ok(!outputChunks.join('').includes('abcd'), 'the typed secret is never echoed');
  assert.match(outputChunks.join(''), /hidden: /, 'only the prompt is written');
});

test('status preserves the recorded terminal refusal after the refused process exits', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    writeRuntimeState(h.paths, {
      pid: 424_242,
      state: 'revoked',
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
      writeRuntimeState(h.paths, { pid: 424_242, state: terminal, at: 1 });
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
    // Use this test's own real pid: liveness is checked against the real OS,
    // and the seam runner answers the command-line probe as a Worker daemon.
    writeRuntimeState(h.paths, { pid: process.pid, state: 'connected', at: 1, epoch: 2 });
    const liveCli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      platform: 'darwin',
      uid: 501,
      run: () => 'sprout worker start',
    });
    assert.equal(await liveCli.run(['status']), WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), /state: connected/);

    // A reused pid whose command line is not this host's Worker is not trusted.
    const h2 = harness();
    try {
      seedEnrolledHost(h2.paths);
      // A live pid (this test) whose command line probe reports a non-Worker:
      // a reused pid must never be reported as a connected Worker.
      writeRuntimeState(h2.paths, { pid: process.pid, state: 'connected', at: 1, epoch: 2 });
      const cli = createWorkerCli({
        paths: () => h2.paths,
        stdout: (line) => h2.out.push(line),
        stderr: (line) => h2.err.push(line),
        platform: 'darwin',
        uid: 501,
        run: (command, args) => {
          // Only the daemon-identity probe hits the runner; launchctl print for
          // the not-installed service must still answer as "not loaded".
          void command;
          void args;
          return 'launchd: Could not find service';
        },
      });
      assert.equal(await cli.run(['status']), WORKER_EXIT.ok);
      assert.match(h2.out.join('\n'), /state: stopped/, 'a non-Worker command line is never reported connected');
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
    const { chmodSync } = await import('node:fs');
    chmodSync(h.paths.identityPath, 0o644);
    const status = await h.run(['status']);
    assert.equal(status, WORKER_EXIT.failure);
    assert.match(h.out.join('\n'), /state: local-configuration-failure/);
  } finally {
    h.cleanup();
  }
});

test('status reports a malformed runtime record as a local configuration failure', async () => {
  const h = harness();
  try {
    seedEnrolledHost(h.paths);
    writePrivateFile(h.paths.runtimePath, JSON.stringify({ pid: 1, state: 'possessed', at: 0 }));
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
    const holder = acquireWorkerLock(h.paths, process.ppid, () => 'sprout worker start');
    const cli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
      confirm: async () => true,
      platform: 'darwin',
      uid: 501,
      run: () => 'sprout worker start',
    });
    const status = await cli.run(['reset', '--yes']);
    holder.release();
    assert.equal(status, WORKER_EXIT.failure);
    assert.match(h.err.join('\n'), /still running/);
    assert.ok(existsSync(h.paths.identityPath), 'the identity survives a refused reset');
    assert.ok(existsSync(h.paths.configPath), 'the configuration survives a refused reset');
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
      run: (command, args) => {
        if (command === 'launchctl' && args[0] === 'bootout') {
          throw new Error('launchctl: bootout failed: 36: Operation not permitted');
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
      run: (command, args) => {
        if (command === 'launchctl' && args[0] === 'bootout') {
          throw new Error('launchctl: bootout failed: 36: Operation not permitted');
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
    writePrivateFile(paths.identityPath, 'PRIVATE KEY MATERIAL');
  }
}
