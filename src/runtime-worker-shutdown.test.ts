import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntime, hostConfiguration, scriptedStartupReadiness, waitFor } from './runtime-test-harness.ts';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { createWorkerCli } from './worker/cli/worker-cli.ts';
import { ensureStateDirectory, workerHostPaths, writePrivateFile } from './worker/cli/host-state.ts';
import { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey,
  type WorkerEnrollmentConnection } from './worker/enrollment-connector.ts';
import { createConnection } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { WORKER_CONNECTION_SHUTDOWN_DEADLINE_MS } from './web/api.ts';
import { WORKER_DIAGNOSTICS } from './worker/diagnostics.ts';
import { SqliteStore } from './store/db.ts';
import { toRunView } from './web/views.ts';
import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';

const SHUTDOWN_GUARD_MS = 6_500;

async function listenWithoutHost(server: HttpServer, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

test('Core shutdown releases an accepted foreground Worker without an operator stop', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-core-worker-shutdown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = workerHostPaths({ SPROUT_WORKER_HOME: join(root, 'worker-state') });
  ensureStateDirectory(paths);
  const identity = loadOrCreateWorkerIdentity(paths.identityPath);
  const runtime = await createRuntime({
    configuration: hostConfiguration({ environmentSource: 'enrollment',
      databasePath: join(root, 'core.db'), engineId: 'scripted' }),
    projectRoot: root,
  });
  const port = await listenWithoutHost(runtime.api.server, Number(process.env['PORT'] ?? 0));
  const requested = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: 'shutdown-host', displayName: 'Shutdown test host', platform: 'macos',
    publicKey: workerPublicKey(identity.privateKey), capabilityRequests: ['agent-run'], engineFacts: [],
  });
  await runtime.enrollments.approve(requested.enrollment.id, { capabilityPermissions: { 'agent-run': true } });
  writePrivateFile(paths.configPath, JSON.stringify({ version: 1, enrollmentId: requested.enrollment.id,
    environmentInstanceId: 'shutdown-host', protocolVersion: WORKER_PROTOCOL_VERSION,
    endpoint: { host: 'localhost', port }, identityFileName: 'identity.pem' }));
  const stop = new AbortController();
  const logs: string[] = [];
  let connection: WorkerEnrollmentConnection | undefined;
  let workerStopped = false;
  const engine = new ScriptedEngineAdapter({ turns: [{ events: [{ type: 'notice', text: 'turn started' }],
    result: { status: 'completed', text: 'must not complete' }, settleAfterMs: 60_000 }] });
  const cli = createWorkerCli({
    paths: () => paths, stdout: () => undefined, stderr: (line) => logs.push(line),
    signal: stop.signal,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-shutdown-process', ownerToken }),
    connect: async (input) => {
      connection = await connectWorkerEnrollment({ target: input,
        protocolVersion: WORKER_PROTOCOL_VERSION, engineFacts: input.engineFacts, log: input.log });
      return connection;
    },
    engines: new Map([['scripted', engine]]),
    readiness: scriptedStartupReadiness,
  });
  const worker = cli.run(['start', '--foreground'], {
    SPROUT_CODEX_BIN: '/synthetic/codex', SPROUT_WORKSPACE_ROOT: join(root, 'workspace'),
    SPROUT_WORKER_RECONNECT_MAX_MS: '60000',
  }).then((code) => { workerStopped = true; return code; });
  let closing: Promise<void> | undefined;
  try {
    await waitFor(() => {
      assert.equal(workerStopped, false, `Worker exited before acceptance: ${logs.join('; ')}`);
      return runtime.workerGateway.liveFor('shutdown-host') !== undefined;
    }, 'accepted foreground Worker');
    await waitFor(() => runtime.environmentCatalog.entry('shutdown-host')?.eligible === true, 'eligible Worker');
    const project = await runtime.projectService.create({ id: 'shutdown-project', displayName: 'Shutdown project',
      goal: 'Shutdown test', agentMemberships: [{ agentId: 'scout' }] });
    await runtime.projectAccess.grant({ projectId: project.id, environmentInstanceId: 'shutdown-host',
      selection: { kind: 'default' } });
    const task = await runtime.tasks.create({ projectId: project.id, title: 'Shutdown task', goal: 'Shutdown test',
      assignedAgentId: 'scout' });
    await runtime.tasks.begin(task.id);
    const { runId } = await runtime.tasks.advance(task.id, { prompt: 'wait for channel loss' });
    await waitFor(() => engine.sessions[0]?.prompts.length === 1, 'active Worker turn');
    assert.equal(workerStopped, false);
    const started = performance.now();
    closing = runtime.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([closing.then(() => true), new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), SHUTDOWN_GUARD_MS);
    })]);
    if (timer !== undefined) clearTimeout(timer);
    t.diagnostic(`shutdown completed=${completed}; elapsed=${Math.round(performance.now() - started)}ms; operator stop=${stop.signal.aborted}`);
    assert.equal(completed, true, 'Core shutdown must complete while the foreground Worker is still running');
    await waitFor(() => logs.some((line) => line.includes('channel closed; reconnecting')), 'Worker observed connection close');
    assert.equal(workerStopped, false, 'the foreground Worker stays alive to reconnect');
    assert.ok(logs.some((line) => line.includes(WORKER_DIAGNOSTICS.coreGoingAway)),
      'Worker receives the allowlisted diagnostic for a clean 1001 going-away close');
    assert.equal(runtime.workerGateway.liveFor('shutdown-host'), undefined,
      'the disconnected Worker cannot accept new work');
    t.diagnostic(`Worker diagnostic=${WORKER_DIAGNOSTICS.coreGoingAway}; reconnect loop alive=${!workerStopped}`);
    const reopened = new SqliteStore({ filename: join(root, 'core.db') });
    try {
      const run = await reopened.runs.get(runId);
      assert.ok(run);
      assert.equal(toRunView(run).status, 'interrupted', 'Web run diagnostics honestly report the interrupted turn');
      assert.equal((await reopened.tasks.get(task.id))?.environmentLifecycleState, 'recovery',
        'Core shutdown retains the Task recovery boundary');
      t.diagnostic('SQLite reopen: Web run status=interrupted; Task state=recovery');
    } finally { reopened.close(); }
  } finally {
    const released = performance.now();
    stop.abort();
    connection?.close();
    await worker;
    await (closing ?? runtime.close());
    t.diagnostic(`cleanup after Worker stop=${Math.round(performance.now() - released)}ms`);
  }
});

test('Core shutdown bounds a Worker socket that never acknowledges the going-away frame', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-core-unresponsive-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = await createRuntime({ configuration: hostConfiguration({ environmentSource: 'enrollment',
    databasePath: join(root, 'core.db'), engineId: 'scripted' }), projectRoot: root });
  const port = await listenWithoutHost(runtime.api.server,
    process.env['PORT'] === undefined ? 0 : Number(process.env['PORT']) + 1);
  // A real upgraded TCP peer, deliberately without a WebSocket client that
  // automatically acknowledges close. This also covers stalled enrollment.
  const peer = createConnection({ host: 'localhost', port });
  let received = Buffer.alloc(0);
  const upgraded = new Promise<void>((resolve, reject) => {
    peer.once('error', reject);
    peer.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.includes('\r\n\r\n')) resolve();
    });
    peer.once('connect', () => peer.write('GET /api/worker/connect HTTP/1.1\r\n' +
      'Host: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
  });
  let closing: Promise<void> | undefined;
  try {
    await upgraded;
    assert.match(received.toString(), /^HTTP\/1.1 101/);
    const started = performance.now();
    closing = runtime.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([closing.then(() => true), new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), SHUTDOWN_GUARD_MS);
    })]);
    if (timer !== undefined) clearTimeout(timer);
    const elapsed = performance.now() - started;
    t.diagnostic(`unresponsive peer: shutdown completed=${completed}; elapsed=${Math.round(elapsed)}ms`);
    assert.equal(completed, true, 'an unresponsive peer cannot extend Core shutdown beyond the deadline');
    assert.ok(elapsed >= WORKER_CONNECTION_SHUTDOWN_DEADLINE_MS - 100,
      'the peer gets the graceful close acknowledgement budget before forced termination');
    const frame = received.subarray(received.indexOf('\r\n\r\n') + 4);
    assert.equal(frame[0], 0x88, 'Core sends a WebSocket close frame before forced termination');
    assert.equal(frame.readUInt16BE(2), 1001, 'close code honestly reports going away');
    assert.equal(frame.subarray(4).toString(), WORKER_DIAGNOSTICS.coreGoingAway);
  } finally {
    peer.destroy();
    await (closing ?? runtime.close());
  }
});
