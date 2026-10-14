import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { JsonRpcError } from './jsonrpc.ts';
import { formatNodeUpgradeGuidance, isSupportedNodeVersion, parseNodeMajor } from './oar-node-support.ts';
import { createRuntime, hostConfiguration, inMemoryStores, INSTANCE_ID, PROJECT_ID, project, testComposition, waitFor } from '../runtime-test-harness.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from '../worker/enrollment-connector.ts';
import type { WorkerInfo, WorkerReadinessFacts } from '../worker/protocol.ts';

// Discovery is host-local and read-only. No production configuration can supply a fake version.
function unsupportedNode(): { executable: string; version: string } | undefined {
  const candidates = new Set([
    process.execPath,
    ...(process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, 'node')),
    ...['/opt/homebrew/opt', '/usr/local/opt'].flatMap((root) =>
      ['node@22', 'node@23'].map((name) => join(root, name, 'bin/node'))),
  ]);
  for (const root of [join(homedir(), '.nvm/versions/node'), join(homedir(), '.local/share/fnm/node-versions')]) {
    try {
      for (const version of readdirSync(root)) {
        candidates.add(join(root, version, 'bin/node'));
        candidates.add(join(root, version, 'installation/bin/node'));
      }
    } catch { /* An absent version manager is not a failed acceptance run. */ }
  }
  for (const executable of candidates) {
    try {
      const version = execFileSync(executable, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 2_000 }).trim();
      if (/^(22|23)\.\d+\.\d+$/.test(version)) return { executable, version };
    } catch { /* Continue discovery; never substitute a claimed version. */ }
  }
  return undefined;
}

test('F2: explicit version inputs are strictly validated before guidance is formatted', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  assert.equal(pkg.engines.node, '>=24.0.0');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  for (const value of ['24garbage', '24.0.0\n', '24.0.0\nARBITRARY_OVERRIDE_TEXT', 'ARBITRARY_OVERRIDE_TEXT', '24.0.0/secret']) {
    assert.equal(isSupportedNodeVersion(value), false);
    assert.equal(parseNodeMajor(value), 0);
    assert.ok(!formatNodeUpgradeGuidance(value).includes(value));
    assert.match(formatNodeUpgradeGuidance(value), /detected Node\.js unknown/);
  }
  assert.equal(isSupportedNodeVersion('v24.0.0'), true);
  assert.match(formatNodeUpgradeGuidance('v23.4.0'), /detected Node\.js 23\.4\.0/);
});

test('F2: a discovered unsupported Node refuses Runtime Message admission before creating a run or OAR runner', { timeout: 60_000 }, async (t) => {
  const node = unsupportedNode();
  if (!node) {
    t.skip('Unproved acceptance gate: no real Node 22/23 executable found on PATH, Homebrew, nvm or fnm. Install Node 22 and add its bin directory to PATH.');
    return;
  }
  t.diagnostic(`Real unsupported runtime discovered: Node ${node.version}`);

  const directory = mkdtempSync(join(tmpdir(), 'oar-node-gate-'));
  const stores = inMemoryStores();
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      environmentSource: 'enrollment', engineId: 'codex',
      runtimeConfiguration: { agents: [{ id: 'scout', name: 'scout', engine: 'codex', capability: 'agent-run' }], project: project() },
    }),
    projectRoot: '/synthetic/project-root', stores,
  });
  const { port } = await runtime.api.listen(0, '127.0.0.1');
  const keyPath = join(directory, 'identity.pem');
  const identity = loadOrCreateWorkerIdentity(keyPath);
  const { enrollment } = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: INSTANCE_ID, displayName: 'Node gate fixture', platform: 'macos',
    publicKey: workerPublicKey(identity.privateKey), capabilityRequests: ['agent-run'], engineFacts: [],
  });
  await runtime.enrollments.approve(enrollment.id, { capabilityPermissions: { 'agent-run': true } });

  // Test-only CLI preload observes real side effects without replacing the adapter or spawn.
  const observations = join(directory, 'observations.jsonl');
  writeFileSync(observations, '');
  const preload = join(directory, 'observe.mjs');
  writeFileSync(preload, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { OarEngineAdapter } from ${JSON.stringify(new URL('./oar.ts', import.meta.url).href)};
const record = (kind) => appendFileSync(${JSON.stringify(observations)}, JSON.stringify({kind}) + '\\n');
const spawn = cp.spawn;
cp.spawn = function (...args) {
  if (args[1]?.some((arg) => String(arg).includes('oar-runner-entry'))) record('runner-spawn');
  return spawn.apply(this, args);
};
syncBuiltinESMExports();
const start = OarEngineAdapter.prototype.startSession;
OarEngineAdapter.prototype.startSession = async function (...args) {
  record('session-attempt');
  const session = await start.apply(this, args);
  record('session-created');
  return session;
};
`);
  // Node 22 needs its V8 regexp-modifiers flag to load the existing privacy module.
  // This enables syntax only; the Worker still reports the discovered runtime version.
  const child = spawn(node.executable, ['--experimental-strip-types', '--js-regexp-modifiers', '--import', pathToFileURL(preload).href, new URL('../worker/main.ts', import.meta.url).pathname], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SPROUT_CODEX_BIN: '/synthetic/bin/codex', SPROUT_ENV_INSTANCE: INSTANCE_ID,
      SPROUT_ENROLLMENT_ID: enrollment.id, SPROUT_CORE_HOST: '127.0.0.1', SPROUT_CORE_PORT: String(port),
      SPROUT_WORKER_KEY: keyPath, SPROUT_WORKSPACE_ROOT: directory,
    },
  });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await waitFor(() => runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined || child.exitCode !== null, 'real unsupported Worker connection');
    assert.equal(child.exitCode, null, 'Worker must survive startup and serve guidance');
    assert.ok(!diagnostics.includes('startupFailed'));
    const accepted = testComposition(runtime).workerGateway.liveFor(INSTANCE_ID);
    assert.ok(accepted, 'actual Worker completed the authenticated enrollment handshake');
    const info = await accepted.transport.request<WorkerInfo>('worker/info');
    const probe = await accepted.transport.request<WorkerReadinessFacts>('worker/readiness-probe');
    const expected = `Node.js 24+ is required by OAR (detected Node.js ${node.version}). Please upgrade Node.js to version 24.0.0 or later before admitting work.`;
    assert.equal(info.readiness?.probe?.summary, expected);
    assert.ok(probe.probe);
    assert.equal(probe.probe.summary, expected);
    assert.equal(probe.probe.enginesOk, false);
    assert.equal(probe.engines.find((fact) => fact.engine === 'codex')?.readiness, 'unknown');
    await waitFor(async () => (await runtime.enrollments.readiness(enrollment.id)).receipt !== undefined, 'Worker readiness receipt');
    await runtime.refreshEnvironmentCatalog();
    const delivered = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`, author: { id: 'operator', kind: 'human' },
      body: '@scout reply with PONG', deliveryKey: 'unsupported-node-message', awaitReply: true,
    });
    assert.equal(delivered.duplicate, false);
    assert.ok(delivered.message.id, 'the real Runtime persisted the Human Message');
    assert.deepEqual(delivered.admittedRunIds, []);
    assert.equal(delivered.wakes.length, 1, 'the addressed Agent has a real durable wake');
    assert.equal(delivered.wakes[0]?.status, 'failed', 'unsupported readiness is a terminal pre-run failure');
    const refusal = 'Check that Codex is installed at a supported version and signed in on this Environment, then run a fresh readiness probe. The option stays unavailable until readiness is established.';
    assert.equal(delivered.wakes[0]?.detail, refusal);
    const failureEvents = (await runtime.collaboration.listEvents(PROJECT_ID))
      .filter((event) => event.kind === 'wake-admission-failure');
    assert.equal(failureEvents.length, 1, 'the Project projection exposes the refusal');
    assert.equal(failureEvents[0]?.disposition, 'informational');
    assert.equal(failureEvents[0]?.detail, refusal);
    await runtime.collaboration.reconcile();
    assert.equal((await runtime.collaboration.listEvents(PROJECT_ID))
      .filter((event) => event.kind === 'wake-admission-failure').length, 1);
    assert.deepEqual(await stores.runs.list(), []);
    assert.equal(stores.runsStore.writes.length, 0, 'no transient run was created');
    assert.deepEqual(await stores.sessionKeys.list(), []);
    assert.equal(readFileSync(observations, 'utf8'), '', 'Message admission never attempted any engine session or runner spawn');
    await assert.rejects(accepted.transport.request('session/start', {
      engine: 'codex', agentId: 'scout', workingDirectory: directory,
    }), (error: unknown) => {
      assert.ok(error instanceof JsonRpcError);
      assert.equal(error.code, -32603);
      assert.equal(error.message, `session/start: ${expected}`);
      return true;
    });
    assert.deepEqual(readFileSync(observations, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [{ kind: 'session-attempt' }],
      'direct RPC reached the real adapter but created no session and spawned no runner');
  } finally {
    child.kill('SIGTERM');
    await runtime.close();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000).unref())]);
    rmSync(directory, { recursive: true, force: true });
  }
});
