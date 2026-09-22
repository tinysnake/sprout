import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectLaunchAgent, installLaunchAgent, launchAgentPlistPath, renderLaunchAgent, restartLaunchAgent, uninstallLaunchAgent } from './launch-agent.ts';
import { workerServiceLabel } from './host-state.ts';
import { generateWorkerIdentity } from '../../environment/worker-proof.ts';

/**
 * macOS process-level integration for the `sprout worker` executable and the
 * LaunchAgent rendering (#117).
 *
 * These run only on Darwin: they execute the packaged `bin/sprout` entry point
 * as a real process (so its exit statuses and executable permissions are real,
 * not in-process), and they validate the rendered plist with Apple's own
 * `plutil` so the LaunchAgent is proven to be a well-formed property list rather
 * than merely well-shaped text.
 *
 * They deliberately do not bootstrap a job into the caller's `gui/<uid>` domain:
 * loading a persistent login agent from a test would mutate the operator's
 * session. The `launchctl` verb sequence is asserted at the unit seam instead.
 */

const onMac = process.platform === 'darwin';
const repositoryRoot = new URL('../../..', import.meta.url).pathname;
const sproutExecutable = join(repositoryRoot, 'bin', 'sprout');

test('the packaged sprout executable exists, is executable, and reports a usage exit', { skip: !onMac }, () => {
  const result = spawnSync(sproutExecutable, ['worker', 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sprout worker <command>/);
  assert.match(result.stdout, /enroll/);
  assert.match(result.stdout, /install-service/);
});

test('sprout worker status on an unconfigured host exits not-enrolled', { skip: !onMac }, () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-exec-'));
  try {
    const result = spawnSync(sproutExecutable, ['worker', 'status'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        SPROUT_WORKER_HOME: join(root, 'state'),
        SPROUT_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents'),
      },
    });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /state: not-enrolled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the packaged start re-execs with an inspectable host-local process binding', { skip: !onMac }, () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-exec-binding-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const config = {
      version: 1,
      enrollmentId: 'enroll-synthetic',
      environmentInstanceId: 'env-synthetic',
      protocolVersion: '2',
      endpoint: { host: '127.0.0.1', port: 1 },
      identityFileName: 'identity.pem',
    };
    writeFileSync(join(state, 'config.json'), JSON.stringify(config));
    writeFileSync(join(state, 'identity.pem'), generateWorkerIdentity().privateKey);
    chmodSync(join(state, 'config.json'), 0o600);
    chmodSync(join(state, 'identity.pem'), 0o600);
    const result = spawnSync(sproutExecutable, ['worker', 'start'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, SPROUT_WORKER_HOME: state, SPROUT_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents') },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /could not establish a host-local Worker process identity/);
    const runtime = JSON.parse(readFileSync(join(state, 'runtime.json'), 'utf8')) as { process?: { startIdentity?: unknown; ownerToken?: unknown } };
    assert.equal(typeof runtime.process?.startIdentity, 'string');
    assert.match(runtime.process?.ownerToken as string, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!result.stdout.includes(runtime.process?.ownerToken as string) && !result.stderr.includes(runtime.process?.ownerToken as string));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sprout worker enroll refuses to take the secret from argv', { skip: !onMac }, () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-exec-argv-'));
  try {
    const result = spawnSync(
      sproutExecutable,
      ['worker', 'enroll', '127.0.0.1:5174', 'enroll-e3', 'claim-secret-on-argv'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, SPROUT_WORKER_HOME: join(root, 'state') } },
    );
    assert.equal(result.status, 2, 'a third argument is a usage error');
    assert.match(result.stderr, /one-use claim secret is read from stdin/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the packaged enroll command rejects credential-bearing endpoint arguments without echoing them', { skip: !onMac }, () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-exec-endpoint-'));
  try {
    const privateEndpoint = 'wss://operator:credential@private.example:7443/path?secret=value#network';
    const result = spawnSync(
      sproutExecutable,
      ['worker', 'enroll', privateEndpoint, 'enroll-e3'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, SPROUT_WORKER_HOME: join(root, 'state') } },
    );
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /operator|credential|private\.example|secret=value|network/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live packaged enrollment process keeps the one-use secret out of process arguments', { skip: !onMac }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-exec-process-privacy-'));
  const child = spawn(
    sproutExecutable,
    ['worker', 'enroll', '127.0.0.1:5174', 'enroll-e3-process-privacy'],
    {
      env: { ...process.env, HOME: root, SPROUT_WORKER_HOME: join(root, 'state') },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const command = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' });
    assert.match(command, /worker enroll 127\.0\.0\.1:5174 enroll-e3-process-privacy/);
    assert.doesNotMatch(command, /one-use-process-secret|@|\?|#/);
    child.stdin.end('one-use-process-secret\n');
  } finally {
    child.kill('SIGKILL');
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test('the rendered LaunchAgent is a valid property list according to plutil', { skip: !onMac }, () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-plist-'));
  try {
    const plistPath = join(root, `${workerServiceLabel('env-synthetic')}.plist`);
    writeFileSync(
      plistPath,
      renderLaunchAgent({
        label: workerServiceLabel('env-synthetic'),
        executablePath: sproutExecutable,
        arguments: ['worker', 'start'],
        logPath: join(root, 'worker.log'),
        environment: { HOME: root, PATH: '/usr/bin:/bin' },
      }),
      'utf8',
    );
    // `plutil -lint` is Apple's own parser; a clean run proves the plist is
    // structurally valid macOS property-list syntax.
    const root_ = execFileSync('/usr/bin/plutil', ['-lint', plistPath], { encoding: 'utf8' });
    assert.match(root_, /OK/);
    // `plutil -convert json -o -` proves the exact typed shape launchd reads.
    const json = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' }),
    ) as Record<string, unknown>;
    assert.equal(json['RunAtLoad'], true);
    assert.deepEqual(json['KeepAlive'], { SuccessfulExit: false });
    assert.equal(json['ThrottleInterval'], 10);
    assert.deepEqual(json['ProgramArguments'], [sproutExecutable, 'worker', 'start']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sprout worker enroll reads a real piped claim secret over the default stdin reader', { skip: !onMac }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-exec-pipe-'));
  const { EnvironmentEnrollmentService } = await import('../../environment/enrollment-service.ts');
  const { InMemoryEnrollmentStore } = await import('../../environment/enrollment-store.ts');
  const { InMemoryEnvironmentReadinessStore } = await import('../../environment/readiness-store.ts');
  const { WorkerGateway } = await import('../gateway.ts');
  const { createRunApi } = await import('../../web/api.ts');
  const enrollments = new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness: new InMemoryEnvironmentReadinessStore(),
    idFactory: () => 'enroll-e3-pipe',
  });
  const gateway = new WorkerGateway({ enrollments, handshakeTimeoutMs: 5_000 });
  const api = createRunApi({
    orchestrator: { subscribe: () => () => undefined, load: async () => undefined } as never,
    agents: { list: () => [], get: () => undefined } as never,
    workerGateway: gateway,
  });
  const { port } = await api.listen(0, '127.0.0.1');
  const requested = await enrollments.requestEnrollment({
    environmentInstanceId: 'mac-mini-e3-pipe',
    displayName: 'Local Mac',
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  const secret = requested.claim?.secret ?? '';
  assert.notEqual(secret, '');
  // The gateway lives in this process, so the child must be spawned
  // asynchronously: a synchronous spawn would block this event loop and
  // deadlock the very server the child dials.
  const child = spawn(
    sproutExecutable,
    ['worker', 'enroll', `127.0.0.1:${port}`, 'enroll-e3-pipe'],
    {
      env: {
        ...process.env,
        HOME: root,
        SPROUT_WORKER_HOME: join(root, 'state'),
        SPROUT_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const collected: { out: string; err: string; code: number | null } = { out: '', err: '', code: null };
  const exited = new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => { collected.out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { collected.err += chunk.toString('utf8'); });
    child.on('exit', (code) => {
      collected.code = code;
      resolve();
    });
  });
  // Pipe the one-use claim secret into the child's real stdin; the default
  // reader (not a test seam) must claim it non-echoingly.
  child.stdin.end(`${secret}\n`);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  await exited;
  clearTimeout(timeout);
  try {
    // A proven-but-unapproved claim is success-with-a-wait (exit 5): the real
    // piped secret crossed the real default stdin reader into the real gateway.
    assert.equal(collected.code, 5, `stderr: ${collected.err}`);
    assert.match(collected.out, /Waiting for Human approval/);
    assert.ok(!collected.out.includes(secret) && !collected.err.includes(secret), 'the secret is never echoed');
    const stateRoot = join(root, 'state');
    assert.ok(existsSync(join(stateRoot, 'identity.pem')), 'the host key was generated');
    assert.ok(existsSync(join(stateRoot, 'config.json')), 'the reconnect facts were persisted');
  } finally {
    rmSync(root, { recursive: true, force: true });
    gateway.close();
    await api.close();
  }
});

test('the default enrollment reader suppresses echo on a real macOS PTY', { skip: !onMac }, async () => {
  // Python's `pty.openpty()` allocates a kernel PTY. This is deliberately not a mocked
  // PassThrough/isTTY pair: the child sees the OS terminal mode that an
  // operator sees. The child reports only the length, so the assertion can
  // prove the submitted input was not echoed without writing it to evidence.
  const secret = 'pty-claim-secret-sentinel';
  const readerModule = new URL('./host-state.ts', import.meta.url).href;
  const program = [
    `import { readSecretFromStdin } from ${JSON.stringify(readerModule)};`,
    "const value = await readSecretFromStdin(process.stdin, process.stdout, 'hidden: ');",
    "process.stdout.write(`received:${value.length}\\n`); process.exit(0);",
  ].join(' ');
  const ptyBridge = [
    'import os, pty, select, subprocess, sys, time',
    'master, slave = pty.openpty()',
    'child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)',
    'os.close(slave)',
    'stdout = sys.stdout.buffer',
    "secret = os.environ['SPROUT_TEST_PTY_INPUT'].encode('utf-8') + b'\\r'",
    'sent = False',
    'while child.poll() is None:',
    '  readable, _, _ = select.select([master], [], [])',
    '  if master in readable:',
    '    data = os.read(master, 4096)',
    '    if data: stdout.write(data); stdout.flush()',
    "    if not sent and b'hidden: ' in data: time.sleep(0.05); os.write(master, secret); sent = True",
    'sys.exit(child.wait())',
  ].join('\n');
  const child = spawn('python3', ['-c', ptyBridge, process.execPath, '--input-type=module', '-e', program], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SPROUT_TEST_PTY_INPUT: secret },
  });
  let output = '';
  let error = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString('utf8'); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('PTY reader did not finish'));
    }, 10_000);
    child.once('exit', (status) => {
      clearTimeout(timeout);
      resolve(status);
    });
    child.once('error', reject);
  });
  assert.equal(code, 0, error);
  assert.match(output, new RegExp(`received:${secret.length}`));
  assert.ok(!output.includes(secret) && !error.includes(secret), 'a real terminal must not echo the claim');
});

test('the service label is a pure digest and never carries an instance-name fragment', { skip: !onMac }, () => {
  const hostile = 'host-chosen-instance-name-with-host-text';
  const label = workerServiceLabel(hostile);
  assert.ok(!label.includes('host-chosen'), 'no instance-name fragment may survive into the label');
  assert.match(label, /^dev\.sprout\.worker\.[0-9a-f]{16}$/);
  assert.equal(
    launchAgentPlistPath({ launchAgentsDirectory: '/synthetic/LaunchAgents' } as never, hostile),
    `/synthetic/LaunchAgents/${label}.plist`,
  );
});

test('a unique temporary LaunchAgent loads, restarts, and uninstalls without touching other user agents', { skip: !onMac }, async (t) => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    t.skip('requires a signed-in macOS user launchd domain');
    return;
  }
  try {
    // Safe preflight: without read access to the current user's domain the
    // test cannot prove it will address only its exact generated label.
    execFileSync('/bin/launchctl', ['print', `gui/${uid}`], { stdio: 'ignore' });
  } catch {
    t.skip('launchctl cannot safely inspect the current signed-in-user domain');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-launchd-test-'));
  const label = `dev.sprout.worker.test.${randomBytes(8).toString('hex')}`;
  const plistPath = join(root, `${label}.plist`);
  const scriptPath = join(root, 'hold.sh');
  const markerPath = join(root, 'starts');
  try {
    // The only loaded job is a random, test-owned label and a script in this
    // temporary directory. It has no Worker identity, config, or access to any
    // persistent LaunchAgents directory.
    writeFileSync(scriptPath, `#!/bin/sh\necho "$$" >> "$1"\nwhile :; do sleep 1; done\n`);
    chmodSync(scriptPath, 0o700);
    const plist = renderLaunchAgent({
      label,
      executablePath: scriptPath,
      arguments: [markerPath],
      logPath: join(root, 'agent.log'),
      environment: { HOME: root, PATH: '/usr/bin:/bin' },
    });
    const paths = { launchAgentsDirectory: root } as never;
    installLaunchAgent({ paths, label, plistPath, plistContent: plist, uid });
    assert.ok(inspectLaunchAgent({ label, uid }) !== undefined, 'the exact temporary label is loaded');
    await waitFor(() => existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() !== '');
    const beforeRestart = readFileSync(markerPath, 'utf8').trim().split('\n').length;
    restartLaunchAgent({ label, uid });
    await waitFor(() => readFileSync(markerPath, 'utf8').trim().split('\n').length > beforeRestart);
    const removed = uninstallLaunchAgent({ label, plistPath, uid });
    assert.equal(removed.removed, true);
    assert.equal(inspectLaunchAgent({ label, uid }), undefined, 'only the generated test job was booted out');
    assert.equal(existsSync(plistPath), false);
  } finally {
    // Idempotent exact-label cleanup protects the signed-in user if an
    // assertion fails. It never enumerates, unloads, or edits another agent.
    try { execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for isolated LaunchAgent lifecycle event');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
