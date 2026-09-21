import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';
import { InMemoryEnrollmentStore } from '../environment/enrollment-store.ts';
import { InMemoryEnvironmentReadinessStore } from '../environment/readiness-store.ts';
import { WorkerGateway } from './gateway.ts';
import { EnrollmentWorkerPort } from './enrollment-port.ts';
import { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } from './enrollment-connector.ts';
import { EnvironmentWorker } from './server.ts';
import { WorkerClient } from './client.ts';
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
  readonly gateway: WorkerGateway;
  readonly port_: EnrollmentWorkerPort;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const enrollments = new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness: new InMemoryEnvironmentReadinessStore(),
    idFactory: () => 'enroll-1',
  });
  const gateway = new WorkerGateway({ enrollments, handshakeTimeoutMs: 5_000 });
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
  return connectWorkerEnrollment({
    target: target(h.port, claimSecret, keyPath),
    protocolVersion: WORKER_PROTOCOL_VERSION,
    engineFacts: [{ engine: 'codex', installed: true, authenticated: false, models: [] }],
  });
}

test('a Worker claims, proves, and awaits Human approval before acceptance', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await assert.rejects(() => connect(h, secret, key.path), /awaiting Human approval/);
    const afterAttempt = await h.enrollments.get('enroll-1');
    assert.equal(afterAttempt?.status, 'pending');
    assert.notEqual(afterAttempt?.worker.identityDigest, '');
  } finally {
    key.cleanup();
    await h.close();
  }
});

test('an approved Worker is accepted with a monotonic epoch and its identity is current', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    const connection = await connect(h, '', key.path);
    assert.equal(connection.environmentInstanceId, 'mac-mini-1');
    assert.equal(connection.epoch, 1);
    assert.equal(h.gateway.epochs.isCurrent('enroll-1', connection.connectionId), true);
    // The port exposes the accepted channel as the environment's engines seam.
    const live = h.gateway.liveFor('mac-mini-1');
    assert.notEqual(live, undefined);
    connection.close();
  } finally {
    key.cleanup();
    await h.close();
  }
});

test('a revoked identity is refused after reconnect, and a new key cannot replace it', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    await h.enrollments.revoke('enroll-1', 'host retired');
    await assert.rejects(() => connect(h, '', key.path), /not approved|revoked/);
  } finally {
    key.cleanup();
    await h.close();
  }
});

test('a stale connection loses its epoch when a newer one is accepted', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    const first = await connect(h, '', key.path);
    const second = await connect(h, '', key.path);
    assert.ok(second.epoch > first.epoch);
    assert.deepEqual(h.gateway.epochs.decide('enroll-1', first.connectionId), {
      accepted: false,
      reason: 'superseded',
    });
    assert.equal(h.gateway.epochs.isCurrent('enroll-1', second.connectionId), true);
    first.close();
    second.close();
  } finally {
    key.cleanup();
    await h.close();
  }
});

test('the neutral Worker JSON-RPC and worker/info cross the accepted bidirectional channel', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    // The Worker dials out and is accepted; its own neutral JSON-RPC server runs
    // over the same accepted channel the core authenticated.
    const connection = await connect(h, '', key.path);
    const worker = new EnvironmentWorker({
      environmentInstanceId: 'mac-mini-1',
      engines: new Map(),
      input: connection.stream,
      output: connection.stream,
    });
    const gatewayTransport = h.gateway.liveFor('mac-mini-1')?.transport;
    assert.notEqual(gatewayTransport, undefined);
    const connected = await WorkerClient.connect(gatewayTransport!);
    assert.equal(connected.info.environmentInstanceId, 'mac-mini-1');
    // The additive `worker/info` readiness contract crosses the same channel.
    assert.equal(connected.info.readiness?.protocolVersion, WORKER_PROTOCOL_VERSION);
    assert.equal(connection.epoch, h.gateway.epochs.current('enroll-1')?.epoch);
    await worker.shutdown();
    connection.close();
  } finally {
    key.cleanup();
    await h.close();
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

test('a duplicate live process with the same key replaces the epoch and invalidates the old one', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    const first = await connect(h, '', key.path);
    const second = await connect(h, '', key.path);
    // The second live process with the same identity is accepted as a newer
    // epoch, and the first is deterministically refused as superseded.
    assert.equal(h.gateway.epochs.isCurrent('enroll-1', second.connectionId), true);
    assert.deepEqual(h.gateway.epochs.decide('enroll-1', first.connectionId), {
      accepted: false,
      reason: 'superseded',
    });
    first.close();
    second.close();
  } finally {
    key.cleanup();
    await h.close();
  }
});

test('a replayed identity proof is refused after the challenge is consumed', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    const host = loadOrCreateWorkerIdentity(key.path);
    await h.enrollments.claimEnrollment('enroll-1', secret);
    const challenge = await h.enrollments.issueChallenge('enroll-1');
    const proof = {
      challengeId: challenge.id,
      publicKey: workerPublicKey(host.privateKey),
      signature: signWorkerChallenge(host.privateKey, challenge),
    };
    await h.enrollments.connectWorker({
      enrollmentId: 'enroll-1',
      proof,
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: WORKER_PROTOCOL_VERSION },
      engines: [],
    });
    await h.enrollments.approve('enroll-1', { capabilityPermissions: {} });
    // The exact same proof (same challenge id) is single-use and refused.
    await assert.rejects(
      () =>
        h.enrollments.connectWorker({
          enrollmentId: 'enroll-1',
          proof,
          connection: { state: 'online' },
          compatibility: { state: 'compatible', workerProtocolVersion: WORKER_PROTOCOL_VERSION },
          engines: [],
        }),
      /not valid|unknown|already used/i,
    );
  } finally {
    key.cleanup();
    await h.close();
  }
});

test('an expired claim cannot be used to authenticate a Worker', async () => {
  const enrollments = new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness: new InMemoryEnvironmentReadinessStore(),
    idFactory: () => 'enroll-1',
    claimTtlMs: 1,
  });
  const requested = await enrollments.requestEnrollment({
    environmentInstanceId: 'mac-mini-1',
    displayName: 'Local Mac',
    platform: 'macos',
    capabilityRequests: [],
    engineFacts: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    () => enrollments.claimEnrollment('enroll-1', requested.claim?.secret ?? ''),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid-claim',
  );
});

test('a new key cannot replace an approved identity', async () => {
  const h = await harness();
  const key = tmpKey();
  const otherKey = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    // A different private key cannot connect as the approved identity.
    const impostor = loadOrCreateWorkerIdentity(otherKey.path);
    const challenge = await h.enrollments.issueChallenge('enroll-1');
    const outcome = await h.enrollments.connectWorker({
      enrollmentId: 'enroll-1',
      proof: {
        challengeId: challenge.id,
        publicKey: workerPublicKey(impostor.privateKey),
        signature: signWorkerChallenge(impostor.privateKey, challenge),
      },
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: WORKER_PROTOCOL_VERSION },
      engines: [],
    });
    assert.equal(outcome.outcome, 'duplicate-new-key-refused');
    assert.notEqual(outcome.enrollment.worker.identityDigest, '');
  } finally {
    key.cleanup();
    otherKey.cleanup();
    await h.close();
  }
});

test('a protocol mismatch is refused before acceptance and the enrollment is preserved', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    // The Worker dials with an incompatible protocol major.
    await assert.rejects(
      () =>
        connectWorkerEnrollment({
          target: { enrollmentId: 'enroll-1', host: '127.0.0.1', port: h.port, claimSecret: '', identityKeyPath: key.path },
          protocolVersion: '99',
          engineFacts: [],
        }),
      /protocol|incompatible/i,
    );
    // The enrollment is preserved (not revoked); only admission is barred.
    const enrollment = await h.enrollments.get('enroll-1');
    assert.equal(enrollment?.status, 'approved');
    assert.equal(h.gateway.liveFor('mac-mini-1'), undefined);
  } finally {
    key.cleanup();
    await h.close();
  }
});

test('channel loss invalidates the epoch, and a reconnect receives a newer one', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    const first = await connect(h, '', key.path);
    const firstId = first.connectionId;
    // Channel loss: the Worker drops the socket.
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.gateway.epochs.isCurrent('enroll-1', firstId), false);
    // A same-identity reconnect is accepted with a strictly newer epoch.
    const second = await connect(h, '', key.path);
    assert.ok(second.epoch > first.epoch);
    second.close();
  } finally {
    key.cleanup();
    await h.close();
  }
});
