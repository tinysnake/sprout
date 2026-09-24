import { test } from 'node:test';

import assert from 'node:assert/strict';import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';

import { InMemoryEnrollmentStore } from '../environment/enrollment-store.ts';

import { InMemoryEnvironmentReadinessStore } from '../environment/readiness-store.ts';

import { WorkerGateway } from './gateway.ts';

import { EnrollmentWorkerPort } from './enrollment-port.ts';

import { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } from './enrollment-connector.ts';

import { EnvironmentWorker } from './server.ts';

import { ScriptedEngineAdapter } from '../engine/scripted.ts';

import { createRunApi } from '../web/api.ts';

import { WORKER_PROTOCOL_VERSION } from './protocol.ts';

import { signWorkerChallenge } from '../environment/worker-proof.ts';

import type { WorkerEnrollmentTarget } from '../host-config.ts';


/**
 * The enrollment-backed outbound Worker gateway (#115, ADR-0012).
 *
 * These tests cross the machine-authentication boundary the way production does:
 * a Worker claims its pending enrollment with the one-use secret, proves
 * possession of its host-local key, and then the existing neutral Worker
 * JSON-RPC crosses the same authenticated channel. Transport rules and epoch
 * authority are asserted at the same seam.
 */

interface Harness {
  readonly base: string;
  readonly port: number;
  readonly enrollments: EnvironmentEnrollmentService;
  readonly enrollmentStore: InMemoryEnrollmentStore;
  readonly gateway: WorkerGateway;
  readonly port_: EnrollmentWorkerPort;
  close(): Promise<void>;
}


async function harness(): Promise<Harness> {
  return harnessWithStore(new InMemoryEnrollmentStore());
}


/**
 * A harness whose enrollment store is supplied by the caller.
 *
 * A gated store lets a test suspend the gateway's pre-epoch lifecycle re-read so
 * a revoke can be interleaved into an exact acceptance window deterministically.
 */
async function harnessWithStore(enrollmentStore: InMemoryEnrollmentStore): Promise<Harness> {
  const enrollments = new EnvironmentEnrollmentService({
    enrollments: enrollmentStore,
    readiness: new InMemoryEnvironmentReadinessStore(),
    currentConnectionEpoch: () => undefined,
    onAuthorityLost: (enrollmentId) => invalidateAuthority(enrollmentId),
    idFactory: () => 'enroll-1',
  });
  const gateway = new WorkerGateway({ enrollments, handshakeTimeoutMs: 5_000 });
  let invalidateAuthority: (enrollmentId: string) => void = () => undefined;
  invalidateAuthority = (enrollmentId) => gateway.invalidateEnrollment(enrollmentId);
  const port_ = new EnrollmentWorkerPort({ gateway });
  const api = createRunApi({
    orchestrator: { subscribe: () => () => undefined, load: async () => undefined } as never,
    agents: { list: () => [], get: () => undefined } as never,
    workerGateway: gateway,
  });
  const { port } = await api.listen(0, '127.0.0.1');
  return {
    base: `127.0.0.1:${port}`,
    port,
    enrollments,
    enrollmentStore,
    gateway,
    port_,
    close: async () => {
      await api.close();
      await port_.close();
    },
  };
}


function tmpKey(): { readonly path: string; readonly cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-worker-key-'));
  return {
    path: join(directory, 'worker-key.pem'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}


function target(port: number, claimSecret: string, keyPath: string): WorkerEnrollmentTarget {
  return { enrollmentId: 'enroll-1', host: '127.0.0.1', port, claimSecret, identityKeyPath: keyPath };
}


async function requestPending(h: Harness): Promise<string> {
  const requested = await h.enrollments.requestEnrollment({
    environmentInstanceId: 'mac-mini-1',
    displayName: 'Local Mac',
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  return requested.claim?.secret ?? '';
}


/** Claim with the host key, prove possession, then approve — same key the connector uses. */
async function claimProveApprove(h: Harness, keyPath: string, secret: string): Promise<void> {
  const host = loadOrCreateWorkerIdentity(keyPath);
  await h.enrollments.claimEnrollment('enroll-1', secret);
  const challenge = await h.enrollments.issueChallenge('enroll-1');
  await h.enrollments.connectWorker({
    enrollmentId: 'enroll-1',
    proof: {
      challengeId: challenge.id,
      publicKey: workerPublicKey(host.privateKey),
      signature: signWorkerChallenge(host.privateKey, challenge),
    },
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: WORKER_PROTOCOL_VERSION },
    engines: [],
  });
  await h.enrollments.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
}


async function connect(h: Harness, claimSecret: string, keyPath: string) {
  return connectEnrollment(h, 'enroll-1', claimSecret, keyPath);
}


async function connectEnrollment(h: Harness, enrollmentId: string, claimSecret: string, keyPath: string) {
  return connectWorkerEnrollment({
    target: { ...target(h.port, claimSecret, keyPath), enrollmentId },
    protocolVersion: WORKER_PROTOCOL_VERSION,
    engineFacts: [{ engine: 'codex', installed: true, authenticated: false, models: [] }],
  });
}


test('the accepted WS channel carries requests, notifications, interrupts, close, and neutral errors', async (t) => {
  const h = await harness();
  const key = tmpKey();
  const cleanup: (() => void)[] = [key.cleanup];
  t.after(async () => {
    for (const fn of cleanup) fn();
    await h.close();
  });
  const secret = await requestPending(h);
  await claimProveApprove(h, key.path, secret);
  const connection = await connect(h, '', key.path);
  cleanup.push(() => connection.close());
  const adapter = new ScriptedEngineAdapter({
    turns: [{ events: [{ type: 'message', text: 'live', final: true }], result: { status: 'completed', text: 'live' } }],
  });
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'sprout-inbound-workspace-'));
  cleanup.push(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const worker = new EnvironmentWorker({
    environmentInstanceId: 'mac-mini-1',
    engines: new Map([['scripted', adapter]]),
    input: connection.stream,
    output: connection.stream,
    workspaceRoot,
  });
  cleanup.push(() => void worker.shutdown());

  // The port identifies the accepted channel and exposes the real adapters.
  const adapters = await h.port_.adapters('mac-mini-1');
  const codex = adapters.get('scripted');
  assert.notEqual(codex, undefined);

  // A request (`session/start` + `session/run`) crosses the WS channel.
  const session = await codex!.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('go');
  const events = [];
  for await (const event of turn.events) events.push(event);
  const result = await turn.completion;
  assert.deepEqual(events, [{ type: 'message', text: 'live', final: true }], 'turn events arrive as notifications');
  assert.equal(result.status === 'completed' ? result.text : undefined, 'live');

  // Worker-owned Task context semantics cross the same channel.
  const contexts = await h.port_.contexts('mac-mini-1');
  const prepared = await contexts.prepare({
    projectId: 'p1',
    projectGoal: 'Goal',
    projectRules: [],
    taskId: 't1',
    taskTitle: 'Task',
    taskGoal: 'Do it',
    taskConstraints: [],
    taskStatus: 'running',
    priorRunSummaries: '',
    agentId: 'scout',
    responsibilities: [],
    collaborationInstructions: '',
    environmentInstanceId: 'mac-mini-1',
    environmentLeaseId: 'lease-1',
  });
  assert.match(prepared.bootstrapInstructions, /TASK\.md/);
  const validated = await contexts.validateWorkspace({
    projectId: 'p1',
    environmentInstanceId: 'mac-mini-1',
    kind: 'default',
  });
  assert.equal(validated.kind, 'default');
  await contexts.recycle({
    projectId: 'p1',
    taskId: 't1',
    environmentInstanceId: 'mac-mini-1',
    environmentLeaseId: 'lease-1',
  });

  // A request the Worker does not implement returns a neutral JSON-RPC error
  // (`-32601`), not an engine-specific shape, over the same authenticated
  // channel the gateway accepted.
  const gatewayTransport = h.gateway.liveFor('mac-mini-1')?.transport;
  assert.notEqual(gatewayTransport, undefined);
  await assert.rejects(
    () => gatewayTransport!.request('not/a-worker-method'),
    (error: unknown) => (error as { code?: number }).code === -32601,
  );

  // interrupt and close cross the channel too.
  const second = await codex!.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const interruptedTurn = second.run('long');
  assert.equal(await second.interrupt(), true);
  assert.equal((await interruptedTurn.completion).status, 'interrupted');
  await second.close();
});


/**
 * E2 (#116): the enrollment-backed registry accepts authenticated inbound
 * connections by instance id and never starts or dials a production Worker in
 * response to an adapter, context, or readiness lookup.
 */
test('adapter, context, and readiness lookups never dial or start a production Worker', async () => {
  const h = await harness();
  try {
    // No connection has ever been accepted. Every lookup fails closed or returns
    // undefined rather than opening a Worker process or dialing a host.
    assert.equal(await h.port_.info('mac-mini-1'), undefined);
    await assert.rejects(
      () => h.port_.adapters('mac-mini-1'),
      /no accepted enrollment-backed Worker connection/,
    );
    await assert.rejects(
      () => h.port_.contexts('mac-mini-1'),
      /no accepted enrollment-backed Worker connection/,
    );

    // A lookup for an instance the catalog never enrolled is equally closed: the
    // port holds no dialer and cannot invent a connection.
    assert.equal(await h.port_.info('never-enrolled'), undefined);
    await assert.rejects(() => h.port_.adapters('never-enrolled'));
  } finally {
    await h.close();
  }
});

/** A raw WS handshake whose readiness barrier the test drives frame by frame. */
async function openRawWorker(
  h: Harness,
  keyPath: string,
  claimSecret: string,
  protocolVersion: unknown = WORKER_PROTOCOL_VERSION,
) {
  const { WebSocket, createWebSocketStream } = await import('ws');
  const identity = loadOrCreateWorkerIdentity(keyPath);
  const publicKey = workerPublicKey(identity.privateKey);
  const socket = new WebSocket(`ws://${h.base}/api/worker/connect`);
  const stream = await new Promise<import('node:stream').Duplex>((resolve, reject) => {
    socket.on('open', () => resolve(createWebSocketStream(socket) as unknown as import('node:stream').Duplex));
    socket.on('error', reject);
  });
  let buffer = '';
  const frames: { type: string; [key: string]: unknown }[] = [];
  const waiters: ((frame: { type: string; [key: string]: unknown }) => void)[] = [];
  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') {
        const frame = JSON.parse(line) as { type: string; [key: string]: unknown };
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter(frame);
        else frames.push(frame);
      }
      newline = buffer.indexOf('\n');
    }
  });
  const next = (): Promise<{ type: string; [key: string]: unknown }> => {
    const queued = frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => waiters.push(resolve));
  };
  const write = (frame: Record<string, unknown>) => stream.write(`${JSON.stringify(frame)}\n`);
  write({ type: 'worker/hello', enrollmentId: 'enroll-1', ...(claimSecret !== '' ? { claimSecret } : {}) });
  for (;;) {
    const frame = await next();
    if (frame.type === 'worker/challenged') {
      const challenge = frame.challenge as { id: string; enrollmentId: string; nonce: string };
      write({
        type: 'worker/prove',
        proof: {
          challengeId: challenge.id,
          publicKey,
          signature: signWorkerChallenge(identity.privateKey, challenge),
        },
        platform: 'macos',
        protocolVersion,
        engineFacts: [],
      });
      continue;
    }
    return { socket, stream, frame, next, write, close: () => socket.close() };
  }
}
test('gateway handoff preserves a pipelined JSON-RPC notification across a partial line', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    let received!: (method: string) => void;
    const notification = new Promise<string>((resolve) => { received = resolve; });
    const remove = h.gateway.onAccept((acceptance) => {
      if (acceptance.accepted) acceptance.transport.onNotification((message) => received(message.method));
    });
    const raw = await openRawWorker(h, key.path, '');
    assert.equal(raw.frame.type, 'worker/accepted');
    const rpc = JSON.stringify({ jsonrpc: '2.0', method: 'handoff/check', params: null }) + '\n';
    raw.stream.write(JSON.stringify({ type: 'worker/ready' }) + '\n' + rpc.slice(0, 17));
    assert.equal((await raw.next()).type, 'worker/listening');
    raw.stream.write(rpc.slice(17));
    assert.equal(await Promise.race([notification, new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 500))]), 'handoff/check');
    remove();
    raw.close();
  } finally {
    key.cleanup();
    await h.close();
  }
});

test('gateway handoff preserves a pipelined JSON-RPC notification across a partial line', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    let received!: (method: string) => void;
    const notification = new Promise<string>((resolve) => { received = resolve; });
    const remove = h.gateway.onAccept((acceptance) => {
      if (acceptance.accepted) acceptance.transport.onNotification((message) => received(message.method));
    });
    const raw = await openRawWorker(h, key.path, '');
    assert.equal(raw.frame.type, 'worker/accepted');
    const rpc = JSON.stringify({ jsonrpc: '2.0', method: 'handoff/check', params: null }) + '\n';
    raw.stream.write(JSON.stringify({ type: 'worker/ready' }) + '\n' + rpc.slice(0, 17));
    assert.equal((await raw.next()).type, 'worker/listening');
    raw.stream.write(rpc.slice(17));
    assert.equal(await Promise.race([notification, new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 500))]), 'handoff/check');
    remove();
    raw.close();
  } finally {
    key.cleanup();
    await h.close();
  }
});
