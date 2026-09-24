import { test } from 'node:test';

import assert from 'node:assert/strict';import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';

import { InMemoryEnrollmentStore } from '../environment/enrollment-store.ts';

import { InMemoryEnvironmentReadinessStore } from '../environment/readiness-store.ts';

import { createPendingEnrollment } from '../environment/enrollment.ts';
import type { EnvironmentEnrollment } from '../environment/enrollment.ts';

import { workerIdentityDigest } from '../environment/enrollment-identity.ts';

import { WorkerGateway } from './gateway.ts';

import { EnrollmentWorkerPort } from './enrollment-port.ts';

import { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } from './enrollment-connector.ts';

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
    assert.equal(h.gateway.isCurrentConnection('enroll-1', second.connectionId), true);
    assert.equal(h.gateway.isCurrentConnection('enroll-1', first.connectionId), false);
    first.close();
    second.close();
  } finally {
    key.cleanup();
    await h.close();
  }
});


test('a legacy duplicate enrollment cannot retain a second live transport for one instance', async () => {
  const h = await harness();
  const firstKey = tmpKey();
  const secondKey = tmpKey();
  try {
    const secret = await requestPending(h);
    await claimProveApprove(h, firstKey.path, secret);
    const first = await connect(h, '', firstKey.path);

    // New enrollment creation now rejects this shape, but historical records may
    // contain it. Exercise the actual gateway acceptance path against such a
    // record rather than trusting a map-only unit seam.
    const secondIdentity = loadOrCreateWorkerIdentity(secondKey.path);
    const legacySibling = createPendingEnrollment({
      id: 'enroll-2',
      environmentInstanceId: 'mac-mini-1',
      displayName: 'Historical duplicate',
      identityDigest: workerIdentityDigest(workerPublicKey(secondIdentity.privateKey)),
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
      at: 1,
    });
    await h.enrollmentStore.save(legacySibling);
    await h.enrollments.approve('enroll-2', { capabilityPermissions: { 'agent-run': true } });

    const second = await connectEnrollment(h, 'enroll-2', '', secondKey.path);
    assert.equal(second.epoch, 1, 'a legacy sibling can have its own numeric epoch namespace');
    assert.equal(h.gateway.liveFor('mac-mini-1')?.enrollment.id, 'enroll-2');
    assert.equal(h.gateway.isCurrentConnection('enroll-1', first.connectionId), false);
    assert.equal(h.gateway.isCurrentConnection('enroll-2', second.connectionId), true);
    first.close();
    second.close();
  } finally {
    firstKey.cleanup();
    secondKey.cleanup();
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
    currentConnectionEpoch: () => undefined,
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
    assert.equal(h.gateway.isCurrentConnection('enroll-1', firstId), false);
    // A same-identity reconnect is accepted with a strictly newer epoch.
    const second = await connect(h, '', key.path);
    assert.ok(second.epoch > first.epoch);
    second.close();
  } finally {
    key.cleanup();
    await h.close();
  }
});

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

