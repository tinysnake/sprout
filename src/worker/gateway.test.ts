import { test } from 'node:test';

import assert from 'node:assert/strict';

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';

import { InMemoryEnrollmentStore } from '../environment/enrollment-store.ts';

import { InMemoryEnvironmentReadinessStore } from '../environment/readiness-store.ts';

import type { EnvironmentEnrollment } from '../environment/enrollment.ts';

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


test('a revoke landing during the acceptance window refuses the connection instead of accepting a stale epoch (R118-EPOCH-001)', async () => {
  // Deterministically suspend the gateway's pre-epoch lifecycle re-read of the
  // enrollment, so the revoke lands exactly inside the acceptance window.
  class GatedStore extends InMemoryEnrollmentStore {
    #remaining = -1;
    #signalGate: (() => void) | undefined;
    readonly gateReached = new Promise<void>((resolve) => { this.#signalGate = resolve; });
    #release: (() => void) | undefined;
    readonly gateReleased = new Promise<void>((resolve) => { this.#release = resolve; });
    blockNthGetFromNow(count: number): void { this.#remaining = count; }
    releaseGet(): void { this.#release?.(); }
    override async get(enrollmentId: string): Promise<EnvironmentEnrollment | undefined> {
      if (this.#remaining > 0) {
        this.#remaining -= 1;
        if (this.#remaining === 0) {
          this.#signalGate?.();
          await this.gateReleased;
        }
      }
      return super.get(enrollmentId);
    }
  }
  const store = new GatedStore();
  const h = await harnessWithStore(store);
  const key = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, key.path, secret);
    // `connectWorkerEnrollment` performs its own reads; block the gateway-side
    // re-read that happens after reconciliation, which is the acceptance fence.
    store.blockNthGetFromNow(3);
    const connecting = connect(h, '', key.path).catch((error: unknown) => error);
    await store.gateReached;
    await h.enrollments.revoke('enroll-1', 'retired during acceptance');
    store.releaseGet();
    const result = await connecting;
    assert.ok(result instanceof Error, 'the connection is refused');
    assert.equal(h.gateway.liveFor('mac-mini-1'), undefined);
    assert.equal(h.gateway.currentConnectionEpoch('enroll-1'), undefined);
    const durable = await h.enrollments.get('enroll-1');
    assert.equal(durable?.status, 'revoked', 'the revoke is the durable authority');
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
    assert.equal(h.gateway.isCurrentConnection('enroll-1', connection.connectionId), true);
    // The port exposes the accepted channel as the environment's engines seam.
    const live = h.gateway.liveFor('mac-mini-1');
    assert.notEqual(live, undefined);
    connection.close();
  } finally {
    key.cleanup();
    await h.close();
  }
});


test('revocation synchronously closes the accepted channel and invalidates its epoch', async () => {
  const h = await harness();
  const key = tmpKey();
  try {
    const claim = await requestPending(h);
    await claimProveApprove(h, key.path, claim);
    const connection = await connect(h, '', key.path);
    assert.ok(h.gateway.liveFor('mac-mini-1'));
    assert.equal(h.gateway.currentConnectionEpoch('enroll-1'), connection.epoch);

    await h.enrollments.revoke('enroll-1', 'retired');

    assert.equal(h.gateway.liveFor('mac-mini-1'), undefined);
    assert.equal(h.gateway.currentConnectionEpoch('enroll-1'), undefined);
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
    assert.equal(h.gateway.isCurrentConnection('enroll-1', first.connectionId), false);
    assert.equal(h.gateway.isCurrentConnection('enroll-1', second.connectionId), true);
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
    assert.equal(connection.epoch, h.gateway.currentConnectionEpoch('enroll-1'));
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
