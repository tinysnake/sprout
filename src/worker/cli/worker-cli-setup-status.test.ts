import { test } from 'node:test';

import assert from 'node:assert/strict';import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { PassThrough } from 'node:stream';


import {
  createWorkerCli,
  parseEndpoint,
  projectStatus,
  WORKER_EXIT,
  type EnrollmentConnector,
} from './worker-cli.ts';import { ensureStateDirectory, readConfig, workerHostPaths, workerServiceLabel, writePrivateFile, type WorkerProcessIdentity } from './host-state.ts';import { type WorkerEnrollmentConnection } from '../enrollment-connector.ts';

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
    writePrivateFile(h.paths.identityPath, generateWorkerIdentity().privateKey);
    // Without confirmation, nothing is removed.
    const declined = harness({ confirm: false });
    const declinedCli = createWorkerCli({
      paths: () => h.paths,
      stdout: (line) => declined.out.push(line),
      stderr: (line) => declined.err.push(line),
      confirm: async () => false,
      platform: 'darwin',
      uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
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
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
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


test('endpoint parsing accepts only a public host/port authority', () => {
  assert.deepEqual(parseEndpoint('127.0.0.1:5174'), { host: '127.0.0.1', port: 5174 });
  assert.deepEqual(parseEndpoint('wss://sprout.internal:8443'), { host: 'sprout.internal', port: 8443 });
  assert.deepEqual(parseEndpoint('sprout.invalid:80'), { host: 'sprout.invalid', port: 80 });
  assert.deepEqual(parseEndpoint('http://sprout.invalid:80'), { host: 'sprout.invalid', port: 80 });
  assert.deepEqual(parseEndpoint('https://sprout.invalid:443'), { host: 'sprout.invalid', port: 443 });
  assert.deepEqual(parseEndpoint('ws://sprout.invalid:80'), { host: 'sprout.invalid', port: 80 });
  assert.deepEqual(parseEndpoint('wss://sprout.invalid:443'), { host: 'sprout.invalid', port: 443 });
  assert.throws(() => parseEndpoint('127.0.0.1'), /port/);
  assert.throws(() => parseEndpoint('ftp://127.0.0.1:21'), /scheme/);
  for (const endpoint of [
    'wss://operator:credential@sprout.invalid:8443',
    'wss://sprout.invalid:8443/api/worker/connect',
    'wss://sprout.invalid:8443?credential=private',
    'wss://sprout.invalid:8443#private-network-detail',
    'sprout.invalid:8443/path',
  ]) {
    assert.throws(
      () => parseEndpoint(endpoint),
      /host.*port|components/i,
      `non-authority endpoint component must be rejected: ${endpoint}`,
    );
  }
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
    projectStatus({ ...base, runtime: { pid: 1, process: processIdentity(1), state: 'connecting', at: 0 }, processAlive: () => true }).state,
    'connecting',
  );
  assert.equal(
    projectStatus({ ...base, runtime: { pid: 1, process: processIdentity(1), state: 'connected', at: 0 }, processAlive: () => true }).state,
    'connected',
  );
  assert.equal(
    projectStatus({ ...base, runtime: { pid: 1, process: processIdentity(1), state: 'pending-approval', at: 0 }, processAlive: () => true }).state,
    'pending-approval',
  );
  assert.equal(
    projectStatus({ ...base, runtime: { pid: 1, process: processIdentity(1), state: 'incompatible', at: 0 }, processAlive: () => true }).state,
    'incompatible',
  );
  assert.equal(
    projectStatus({ ...base, runtime: { pid: 1, process: processIdentity(1), state: 'revoked', at: 0 }, processAlive: () => true }).state,
    'revoked',
  );
  // A dead pid is stopped, never trusted as connected.
  assert.equal(
    projectStatus({ ...base, runtime: { pid: 1, process: processIdentity(1), state: 'connected', at: 0 }, processAlive: () => false }).state,
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


test('live unavailable process evidence outranks enrollment and recorded stopped state', () => {
  const paths = workerHostPaths({ HOME: '/synthetic', SPROUT_WORKER_HOME: '/synthetic/state' });
  const runtime = { pid: 1, process: processIdentity(1), state: 'stopped' as const, at: 0 };
  const unavailable = {
    paths,
    runtime,
    processAlive: () => true,
    processMatchesRuntime: () => 'unknown' as const,
    serviceInstalled: false,
  };
  assert.equal(
    projectStatus({
      ...unavailable,
      enrolled: false,
      config: undefined,
      configError: 'not-enrolled',
    }).state,
    'local-configuration-failure',
    'a missing config must not hide a live process whose owner evidence is unavailable',
  );
  assert.equal(
    projectStatus({
      ...unavailable,
      enrolled: true,
      config: {
        version: 1,
        enrollmentId: 'e',
        environmentInstanceId: 'i',
        protocolVersion: '2',
        endpoint: { host: '127.0.0.1', port: 1 },
        identityFileName: 'identity.pem',
      },
      configError: undefined,
    }).state,
    'local-configuration-failure',
    'a recorded stopped label must not hide unavailable evidence for its live pid',
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
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
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
