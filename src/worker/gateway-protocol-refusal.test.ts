import { test } from 'node:test';

import assert from 'node:assert/strict';import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';

import { InMemoryEnrollmentStore } from '../environment/enrollment-store.ts';

import { InMemoryEnvironmentReadinessStore } from '../environment/readiness-store.ts';

import { WorkerGateway } from './gateway.ts';

import { EnrollmentWorkerPort } from './enrollment-port.ts';

import { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } from './enrollment-connector.ts';

import { EnvironmentWorker } from './server.ts';

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


/**
 * Rework 1 (#115 review findings 1, 3, 4, 5 and evidence gap 5).
 *
 * These tests pin the exactly-once claim boundary under concurrency, the
 * readiness-barrier race, channel-loss invalidation of the cached port, and the
 * full neutral Worker JSON-RPC surface over the new authenticated WS path.
 */

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


test('a real gateway refusal never echoes malformed protocol evidence to the stream or diagnostics', async () => {
  const h = await harness();
  const key = tmpKey();
  const privacyMarker = 'SPROUT_SYNTHETIC_PROTOCOL_SENTINEL_7d6c0d34c9174db09f9cd0c860fc92a1';
  const privatePath = `/synthetic-private/${privacyMarker}/worker.sock`;
  const networkEndpoint = `${privacyMarker.toLowerCase()}.invalid:61947`;
  const hostileProtocol = `1;marker=${privacyMarker};path=${privatePath};endpoint=${networkEndpoint}`;
  const fixedReason = 'the Worker protocol is incompatible with this Sprout build';
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);

    const raw = await openRawWorker(h, key.path, '', hostileProtocol);
    assert.deepEqual(raw.frame, {
      type: 'worker/refused',
      reason: fixedReason,
      code: 'incompatible',
    });
    raw.close();

    const logs: string[] = [];
    let refusalMessage = '';
    await assert.rejects(
      () => connectWorkerEnrollment({
        target: target(h.port, '', key.path),
        protocolVersion: hostileProtocol,
        engineFacts: [],
        log: (line) => logs.push(line),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        refusalMessage = error.message;
        assert.equal(refusalMessage, fixedReason);
        return true;
      },
    );

    const durable = await h.enrollments.readiness('enroll-1');
    assert.deepEqual(
      durable.readiness.compatibility,
      { state: 'unknown' },
      'a pre-acceptance refusal has no epoch authority to persist readiness',
    );
    const exposed = JSON.stringify({ refusal: raw.frame, reason: refusalMessage, connectorLogs: logs, readiness: durable });
    for (const sentinel of [privacyMarker, privatePath, networkEndpoint, hostileProtocol]) {
      assert.equal(exposed.includes(sentinel), false, `protocol evidence escaped through an exposed surface: ${sentinel}`);
    }
  } finally {
    key.cleanup();
    await h.close();
  }
});


test('a real gateway refuses every present non-string protocol version without retaining its value', async () => {
  const h = await harness();
  const key = tmpKey();
  const privacyMarker = 'SPROUT_SYNTHETIC_NONSTRING_SENTINEL_2d606e03b65a4f95a839063bbd8179bd';
  const fixedRefusal = {
    type: 'worker/refused',
    reason: 'the Worker protocol is incompatible with this Sprout build',
    code: 'incompatible',
  };
  const malformedVersions: readonly { readonly kind: string; readonly value: unknown }[] = [
    { kind: 'number', value: 2 },
    { kind: 'object', value: { marker: privacyMarker, path: `/synthetic-private/${privacyMarker}/worker.sock` } },
    { kind: 'array', value: [privacyMarker, `${privacyMarker.toLowerCase()}.invalid:61947`] },
    { kind: 'null', value: null },
  ];
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);

    for (const malformed of malformedVersions) {
      const raw = await openRawWorker(h, key.path, '', malformed.value);
      assert.deepEqual(raw.frame, fixedRefusal, `${malformed.kind} protocolVersion must fail closed`);
      raw.close();

      const readiness = await h.enrollments.readiness('enroll-1');
      assert.deepEqual(
        readiness.readiness.compatibility,
        { state: 'unknown' },
        'a pre-acceptance refusal has no epoch authority to persist readiness',
      );
      const exposed = JSON.stringify({ refusal: raw.frame, reason: fixedRefusal.reason, readiness });
      assert.equal(exposed.includes(privacyMarker), false, `${malformed.kind} protocolVersion entered diagnostics`);
      assert.equal(h.gateway.liveFor('mac-mini-1'), undefined, `${malformed.kind} protocolVersion was accepted`);
    }
  } finally {
    key.cleanup();
    await h.close();
  }
});


test('concurrent claims with the same secret over HTTP yield exactly one success', async () => {
  const h = await harness();
  try {
    const secret = await requestPending(h);
    const attempt = () =>
      fetch(`http://${h.base}/api/worker/enrollments/enroll-1/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimSecret: secret }),
      });
    const responses = await Promise.all([attempt(), attempt(), attempt()]);
    const statuses = responses.map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409, 409], 'exactly one concurrent HTTP claim may win');
  } finally {
    await h.close();
  }
});


test('a delayed older epoch cannot become live after a newer epoch wins the barrier', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);

    // Open epoch 1 and hold it before its `worker/ready` barrier.
    const first = await openRawWorker(h, key.path, '');
    assert.equal(first.frame.type, 'worker/accepted');
    const firstEpoch = first.frame.epoch as number;

    // A second connection completes the barrier and wins epoch 2.
    const second = await openRawWorker(h, key.path, '');
    assert.equal(second.frame.type, 'worker/accepted');
    const secondEpoch = second.frame.epoch as number;
    assert.ok(secondEpoch > firstEpoch);
    second.write({ type: 'worker/ready' });
    const secondListening = await second.next();
    assert.equal(secondListening.type, 'worker/listening');
    assert.equal(h.gateway.liveFor('mac-mini-1')?.epoch.epoch, secondEpoch);

    // Now the delayed older connection finishes its barrier. It must be refused
    // and must never overwrite the newer live/routable epoch.
    first.write({ type: 'worker/ready' });
    const afterFirst = await first.next();
    assert.equal(afterFirst.type, 'worker/refused', 'the older epoch is refused after the barrier');
    assert.equal(h.gateway.currentConnectionEpoch('enroll-1'), secondEpoch);
    assert.equal(h.gateway.liveFor('mac-mini-1')?.epoch.epoch, secondEpoch, 'the newer epoch stays live');
    first.close();
    second.close();
  } finally {
    key.cleanup();
    await h.close();
  }
});


test('channel loss invalidates the cached enrollment port facts and commands', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    const connection = await connect(h, '', key.path);
    const worker = new EnvironmentWorker({
      environmentInstanceId: 'mac-mini-1',
      engines: new Map(),
      input: connection.stream,
      output: connection.stream,
    });
    // Identify the channel through the port, so a `WorkerConnection` is cached.
    const info = await h.port_.info('mac-mini-1');
    assert.equal(info?.environmentInstanceId, 'mac-mini-1');
    assert.equal((await h.port_.adapters('mac-mini-1')).size, 0);

    // Channel loss: the socket drops and the gateway port must observe offline.
    connection.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(h.gateway.liveFor('mac-mini-1'), undefined);
    assert.equal(await h.port_.info('mac-mini-1'), undefined, 'channel loss must invalidate cached facts');
    await assert.rejects(
      () => h.port_.adapters('mac-mini-1'),
      /no accepted enrollment-backed Worker connection/,
      'commands must fail after channel loss',
    );
    await worker.shutdown().catch(() => undefined);
  } finally {
    key.cleanup();
    await h.close();
  }
});

test('reusing a Worker identity requires exact owner-only mode and valid key content', () => {
  const key = tmpKey();
  try {
    writeFileSync(key.path, 'not a private key', { mode: 0o600 });
    assert.throws(() => loadOrCreateWorkerIdentity(key.path), /valid Ed25519 private key/);
    writeFileSync(key.path, 'not a private key', { mode: 0o600 });
    chmodSync(key.path, 0o644);
    assert.throws(() => loadOrCreateWorkerIdentity(key.path), /invalid permissions/);
  } finally {
    key.cleanup();
  }
});


test('an unauthenticated request cannot reach the machine boundary', async () => {
  const h = await harness();
  try {
    const response = await fetch(`http://${h.base}/api/worker/enrollments/enroll-1/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimSecret: 'not-the-secret' }),
    });
    assert.equal(response.status, 404, 'an unknown enrollment is a machine 404');
  } finally {
    await h.close();
  }
});


test('the machine claim route consumes the secret, and replay is refused', async () => {
  const h = await harness();
  try {
    const secret = await requestPending(h);
    const first = await fetch(`http://${h.base}/api/worker/enrollments/enroll-1/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimSecret: secret }),
    });
    assert.equal(first.status, 200);
    const replay = await fetch(`http://${h.base}/api/worker/enrollments/enroll-1/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimSecret: secret }),
    });
    assert.equal(replay.status, 409, 'a replayed claim is refused');
  } finally {
    await h.close();
  }
});

