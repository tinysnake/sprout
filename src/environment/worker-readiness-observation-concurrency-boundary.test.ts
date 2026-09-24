import assert from 'node:assert/strict';

import { test } from 'node:test';


import { EnvironmentEnrollmentService } from './enrollment-service.ts';import { InMemoryEnvironmentReadinessStore, type EnvironmentReadinessStore } from './readiness-store.ts';

import { InMemoryEnrollmentStore } from './enrollment-store.ts';

import type { EnvironmentEnrollment } from './enrollment.ts';

import { workerIdentityFixture } from './worker-identity-fixture.ts';

import { createReadinessAuthorityTestSeam } from './readiness-authority.test-support.ts';


const readinessAuthorityTestSeam = createReadinessAuthorityTestSeam();


function testAuthority(overrides: {
  readonly environmentInstanceId?: string;
  readonly enrollmentId?: string;
  readonly connectionEpoch?: number;
  readonly lifecycleGeneration?: number;
  readonly isCurrent?: () => boolean;
} = {}) {
  return readinessAuthorityTestSeam.mint({
    environmentInstanceId: overrides.environmentInstanceId ?? 'env-1',
    enrollmentId: overrides.enrollmentId ?? 'enroll-1',
    connectionEpoch: overrides.connectionEpoch ?? 7,
    lifecycleGeneration: overrides.lifecycleGeneration ?? 0,
    isCurrent: overrides.isCurrent ?? (() => true),
  });
}


async function enrolled(
  readiness: EnvironmentReadinessStore = new InMemoryEnvironmentReadinessStore(),
  currentConnectionEpoch: () => number | undefined = () => 7,
) {
  const service = new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness,
    currentConnectionEpoch,
    verifyObservationAuthority: readinessAuthorityTestSeam.verify,
    idFactory: () => 'enroll-1',
    clock: () => 1_000,
  });
  const request = await service.requestEnrollment({
    environmentInstanceId: 'env-1',
    displayName: 'Environment',
    publicKey: 'worker-public-key',
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  await service.approve(request.enrollment.id, { capabilityPermissions: { 'agent-run': true } });
  return { service, store: readiness };
}


function startupReadiness() {
  return {
    protocolVersion: '2',
    observedAt: 1_234,
    engines: [{
      engine: 'pi', version: '0.86.1', installed: true, readiness: 'ready',
      modelAvailability: 'unknown', models: [], authenticated: true,
      authType: 'oauth', modelIdPresent: false, probedAt: 1_234,
      probeExitCode: 0, source: 'pi-auth-check',
    }],
    probe: {
      at: 1_234, latencyMs: 12, protocolOk: true, enginesOk: true,
      source: 'worker' as const, version: '0.86.1', summary: 'startup probe',
    },
  };
}


/**
 * An enrollment store whose Nth `get` blocks until released, so a lifecycle
 * decision can be interleaved into a specific suspension point of a slow
 * `connectWorker` reconciliation.
 */
class GatedEnrollmentStore extends InMemoryEnrollmentStore {
  #remainingUntilGate = -1;
  #signalGate: (() => void) | undefined;
  readonly gateReached = new Promise<void>((resolve) => { this.#signalGate = resolve; });
  #releaseGate: (() => void) | undefined;
  readonly gateReleased = new Promise<void>((resolve) => { this.#releaseGate = resolve; });

  /** Block the Nth `get` from now (1 = the very next call). */
  blockNthGetFromNow(count: number): void {
    this.#remainingUntilGate = count;
  }

  releaseGet(): void { this.#releaseGate?.(); }

  override async get(enrollmentId: string): Promise<EnvironmentEnrollment | undefined> {
    if (this.#remainingUntilGate > 0) {
      this.#remainingUntilGate -= 1;
      if (this.#remainingUntilGate === 0) {
        this.#signalGate?.();
        await this.gateReleased;
      }
    }
    return super.get(enrollmentId);
  }
}


/**
 * R118-EPOCH-001: a slow pre-epoch identity reconciliation must not overwrite a
 * revoke/reset that lands while its durable read is suspended.
 */
test('a pre-epoch reconciliation cannot overwrite a revoke that lands during its durable read', async () => {
  const store = new GatedEnrollmentStore();
  const service = new EnvironmentEnrollmentService({
    enrollments: store,
    readiness: new InMemoryEnvironmentReadinessStore(),
    currentConnectionEpoch: () => undefined,
    verifyObservationAuthority: readinessAuthorityTestSeam.verify,
    idFactory: () => 'enroll-1',
    clock: () => 1_000,
  });
  const identity = workerIdentityFixture();
  await service.requestEnrollment({
    environmentInstanceId: 'env-1',
    displayName: 'Environment',
    publicKey: identity.publicKey,
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  await service.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });

  const proof = await identity.prove(service, 'enroll-1');
  // connectWorker reads the enrollment, then re-reads it after the proof to CAS
  // its reconciliation. Block that second read.
  store.blockNthGetFromNow(2);
  const connecting = service.connectWorker({
    enrollmentId: 'enroll-1',
    proof,
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2' },
    engines: [],
  });
  await store.gateReached;
  // A Human revokes while the reconciliation is suspended mid-read.
  await service.revoke('enroll-1', 'retired');
  store.releaseGet();

  const outcome = await connecting;
  assert.equal(outcome.authoritySuperseded, true, 'the reconciliation is refused as superseded');
  const durable = await service.get('enroll-1');
  assert.equal(durable?.status, 'revoked', 'the newer revoke is the durable authority');
  assert.deepEqual(durable?.decisions.map((decision) => decision.kind), ['requested', 'approved', 'revoked'], 'the superseded reconciliation left no durable decision');
  // The readiness projection exposes no current facts after revoke.
  const projected = await service.readiness('enroll-1');
  assert.equal(projected.enrollment.status, 'revoked');
  assert.equal(projected.readiness.connection.state, 'never-connected');
  assert.deepEqual(projected.probes, []);
});


test('a pre-epoch reconciliation cannot overwrite a reset that lands during its durable read', async () => {
  const store = new GatedEnrollmentStore();
  const service = new EnvironmentEnrollmentService({
    enrollments: store,
    readiness: new InMemoryEnvironmentReadinessStore(),
    currentConnectionEpoch: () => undefined,
    verifyObservationAuthority: readinessAuthorityTestSeam.verify,
    idFactory: () => 'enroll-1',
    clock: () => 1_000,
  });
  const identity = workerIdentityFixture();
  await service.requestEnrollment({
    environmentInstanceId: 'env-1', displayName: 'Environment', publicKey: identity.publicKey,
    platform: 'macos', capabilityRequests: ['agent-run'], engineFacts: [],
  });
  await service.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
  const proof = await identity.prove(service, 'enroll-1');
  store.blockNthGetFromNow(2);
  const connecting = service.connectWorker({
    enrollmentId: 'enroll-1', proof, connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2' }, engines: [],
  });
  await store.gateReached;
  await service.reset('enroll-1', 'rotate');
  store.releaseGet();
  const outcome = await connecting;
  assert.equal(outcome.authoritySuperseded, true);
  const durable = await service.get('enroll-1');
  assert.equal(durable?.status, 'pending');
  assert.equal(durable?.requiresFreshIdentity, true);
  assert.deepEqual(durable?.decisions.map((decision) => decision.kind), ['requested', 'approved', 'reset']);
});


test('a pre-epoch reconciliation cannot overwrite a permission update that lands during its durable read', async () => {
  const store = new GatedEnrollmentStore();
  const service = new EnvironmentEnrollmentService({
    enrollments: store,
    readiness: new InMemoryEnvironmentReadinessStore(),
    currentConnectionEpoch: () => undefined,
    verifyObservationAuthority: readinessAuthorityTestSeam.verify,
    idFactory: () => 'enroll-1',
    clock: () => 1_000,
  });
  const identity = workerIdentityFixture();
  await service.requestEnrollment({
    environmentInstanceId: 'env-1', displayName: 'Environment', publicKey: identity.publicKey,
    platform: 'macos', capabilityRequests: ['agent-run'], engineFacts: [],
  });
  await service.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
  const proof = await identity.prove(service, 'enroll-1');
  store.blockNthGetFromNow(2);
  const connecting = service.connectWorker({
    enrollmentId: 'enroll-1', proof, connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2' }, engines: [],
  });
  await store.gateReached;
  await service.setCapabilityPermission('enroll-1', 'agent-run', false);
  store.releaseGet();

  const outcome = await connecting;
  assert.equal(outcome.authoritySuperseded, true);
  const durable = await service.get('enroll-1');
  assert.equal(durable?.capabilityPermissions['agent-run'], false, 'the later permission decision remains durable');
  assert.deepEqual(durable?.decisions.map((decision) => decision.kind), ['requested', 'approved']);
});


test('concurrent lifecycle decisions are serialized through the durable revision CAS', async () => {
  const store = new InMemoryEnrollmentStore();
  const service = new EnvironmentEnrollmentService({
    enrollments: store,
    readiness: new InMemoryEnvironmentReadinessStore(),
    currentConnectionEpoch: () => undefined,
    verifyObservationAuthority: readinessAuthorityTestSeam.verify,
    idFactory: () => 'enroll-1',
    clock: () => 1_000,
  });
  await service.requestEnrollment({
    environmentInstanceId: 'env-1', displayName: 'Environment', publicKey: 'worker-public-key',
    platform: 'macos', capabilityRequests: ['agent-run'], engineFacts: [],
  });
  await service.approve('enroll-1', { capabilityPermissions: { 'agent-run': true } });
  // Two revokes in flight: the CAS retries against the freshest document so no
  // decision is silently lost and the final document is one coherent lifecycle.
  await Promise.all([
    service.revoke('enroll-1', 'first'),
    service.revoke('enroll-1', 'second'),
  ]);
  const durable = await service.get('enroll-1');
  assert.equal(durable?.status, 'revoked');
  assert.equal(durable?.decisions.filter((decision) => decision.kind === 'revoked').length, 2);
});


test('a Worker-declared provider/account identity never reaches the durable readiness document (#114 C6, R118-BOUNDARY-003)', async () => {
  const { service, store } = await enrolled();
  // A Worker over the authenticated channel tries to smuggle provider identity
  // into the structured fields. The service sanitizes on the way in.
  const recorded = await service.observeWorkerReadiness('enroll-1', {
    ...startupReadiness(),
    engines: [{
      engine: 'pi', installed: true, readiness: 'ready', modelAvailability: 'unknown', models: [],
      authenticated: true, authMode: 'provider-account', authType: 'openai-codex', source: 'openai-codex',
    }],
  }, testAuthority());
  assert.equal(recorded, true);
  const stored = await store.getReadiness('env-1');
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes('openai-codex'), false, 'no provider identity is persisted');
  assert.equal(serialized.includes('provider-account'), false, 'no account-mode identity is persisted');
  assert.equal(stored?.engines[0]?.authType, undefined);
  assert.equal(stored?.engines[0]?.source, undefined);
});


for (const missing of ['omitted', 'undefined'] as const) {
  test(`direct service rejects ${missing} embedded probe before commit (R118-API-002)`, async (t) => {
    const { service, store } = await enrolled();
    const commit = t.mock.method(store, 'commitObservation');
    const { probe: _probe, ...facts } = startupReadiness();
    const readiness = missing === 'omitted' ? facts : { ...facts, probe: undefined };

    // Explicit undefined is untyped caller input under exactOptionalPropertyTypes.
    const recorded = await service.observeWorkerReadiness('enroll-1', readiness as never, testAuthority());

    assert.equal(recorded, false);
    assert.equal(commit.mock.callCount(), 0, 'incomplete observations never reach the mutation boundary');
    assert.equal(await store.getReadiness('env-1'), undefined);
    assert.deepEqual(await store.listProbes('env-1'), []);
    const projected = await service.readiness('enroll-1');
    assert.equal(projected.readiness.connection.state, 'never-connected');
    assert.deepEqual(projected.probes, []);
  });
}


test('direct service rejects malformed Worker readiness before commit (R118-API-002)', async (t) => {
  const { service, store } = await enrolled();
  const commit = t.mock.method(store, 'commitObservation');
  for (const readiness of [undefined, null, {}, 'invalid']) {
    assert.equal(await service.observeWorkerReadiness(
      'enroll-1', readiness as never,
      testAuthority(),
    ), false);
    assert.equal(commit.mock.callCount(), 0);
    assert.equal(await store.getReadiness('env-1'), undefined);
    assert.deepEqual(await store.listProbes('env-1'), []);
  }
});


test('direct service rejects malformed embedded probes before commit (R118-API-002)', async (t) => {
  for (const probe of [null, {}, { ...startupReadiness().probe, latencyMs: -1 }]) {
    const { service, store } = await enrolled();
    const commit = t.mock.method(store, 'commitObservation');
    const recorded = await service.observeWorkerReadiness(
      'enroll-1',
      { ...startupReadiness(), probe } as never,
      testAuthority(),
    );
    assert.equal(recorded, false);
    assert.equal(commit.mock.callCount(), 0);
    assert.equal(await store.getReadiness('env-1'), undefined);
    assert.deepEqual(await store.listProbes('env-1'), []);
  }
});


test('direct service observations reject every non-worker probe source before durable storage (R118-BOUNDARY-003)', async (t) => {
  for (const source of ['provider-account', 'openai-codex', 'unknown']) {
    const { service, store } = await enrolled();
    const commit = t.mock.method(store, 'commitObservation');
    const readiness = {
      ...startupReadiness(),
      probe: { ...startupReadiness().probe, source },
    };
    const recorded = await service.observeWorkerReadiness(
      'enroll-1',
      // Deliberately cross the runtime boundary with a value TypeScript's
      // `worker` literal cannot represent. The service, not the type system,
      // owns the durable privacy reduction.
      readiness as never,
      testAuthority(),
    );
    assert.equal(recorded, false);
    assert.equal(commit.mock.callCount(), 0);
    assert.equal(await store.getReadiness('env-1'), undefined);
    const durable = await store.listProbes('env-1');
    assert.equal(durable.length, 0, `${source} must not become durable provenance`);
    assert.equal((await service.readiness('enroll-1')).readiness.probe?.source, undefined);
    assert.deepEqual(await service.listProbes('enroll-1'), []);
  }
});
