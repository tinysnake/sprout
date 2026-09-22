import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EnvironmentEnrollmentService } from './enrollment-service.ts';
import {
  InMemoryEnvironmentReadinessStore,
  type ReadinessObservation,
  type ReadinessWriteAuthority,
} from './readiness-store.ts';
import { InMemoryEnrollmentStore } from './enrollment-store.ts';

class DelayedReadinessStore extends InMemoryEnvironmentReadinessStore {
  #signalStarted: (() => void) | undefined;
  readonly commitStarted = new Promise<void>((resolve) => { this.#signalStarted = resolve; });
  #continueCommit: (() => void) | undefined;
  readonly waitForCommit = new Promise<void>((resolve) => { this.#continueCommit = resolve; });

  override async commitObservation(
    environmentInstanceId: string,
    observation: ReadinessObservation,
    authority: ReadinessWriteAuthority,
  ): Promise<boolean> {
    this.#signalStarted?.();
    await this.waitForCommit;
    return super.commitObservation(environmentInstanceId, observation, authority);
  }

  continueCommit(): void { this.#continueCommit?.(); }
}

class PostCommitDelayedReadinessStore extends InMemoryEnvironmentReadinessStore {
  #signalCommitted: (() => void) | undefined;
  readonly committed = new Promise<void>((resolve) => { this.#signalCommitted = resolve; });
  #continueReturn: (() => void) | undefined;
  readonly waitForReturn = new Promise<void>((resolve) => { this.#continueReturn = resolve; });

  override async commitObservation(
    environmentInstanceId: string,
    observation: ReadinessObservation,
    authority: ReadinessWriteAuthority,
  ): Promise<boolean> {
    const committed = await super.commitObservation(environmentInstanceId, observation, authority);
    this.#signalCommitted?.();
    await this.waitForReturn;
    return committed;
  }

  continueReturn(): void { this.#continueReturn?.(); }
}

async function enrolled(
  readiness = new InMemoryEnvironmentReadinessStore(),
  currentConnectionEpoch: () => number | undefined = () => 7,
) {
  const service = new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness,
    currentConnectionEpoch,
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

test('startup Worker readiness persists one epoch-bound probe and its independent provenance facts', async () => {
  const { service } = await enrolled();
  const recorded = await service.observeWorkerReadiness('enroll-1', startupReadiness(), {
    enrollmentId: 'enroll-1',
    connectionEpoch: 7,
    isCurrent: () => true,
  });
  assert.equal(recorded, true);

  const assembled = await service.readiness('enroll-1');
  const engine = assembled.readiness.engines[0]!;
  assert.deepEqual(
    {
      version: engine.version, authenticated: engine.authenticated, authType: engine.authType,
      probedAt: engine.probedAt, source: engine.source, modelIdPresent: engine.modelIdPresent,
    },
    { version: '0.86.1', authenticated: true, authType: 'oauth', probedAt: 1_234, source: 'pi-auth-check', modelIdPresent: false },
  );
  assert.deepEqual(await service.listProbes('enroll-1'), [{
    enrollmentId: 'enroll-1', connectionEpoch: 7,
    at: 1_234, latencyMs: 12, protocolOk: true, enginesOk: true,
    source: 'worker', version: '0.86.1', summary: 'startup probe',
  }]);
});

test('a pending enrollment cannot write readiness even when an epoch resolver returns one', async () => {
  const store = new InMemoryEnvironmentReadinessStore();
  const service = new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness: store,
    currentConnectionEpoch: () => 7,
    idFactory: () => 'enroll-pending',
  });
  await service.requestEnrollment({
    environmentInstanceId: 'env-pending',
    displayName: 'Pending Environment',
    publicKey: 'worker-public-key',
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  const recorded = await service.observeWorkerReadiness('enroll-pending', startupReadiness(), {
    enrollmentId: 'enroll-pending',
    connectionEpoch: 7,
    isCurrent: () => true,
  });
  assert.equal(recorded, false);
  assert.equal(await store.getReadiness('env-pending'), undefined);
  assert.deepEqual(await store.listProbes('env-pending'), []);
  assert.equal((await service.readiness('enroll-pending')).readiness.connection.state, 'never-connected');
  assert.deepEqual(await service.listProbes('enroll-pending'), []);
});

test('a stale epoch is rejected before either readiness or probe persistence', async () => {
  const { service } = await enrolled();
  const recorded = await service.observeWorkerReadiness('enroll-1', startupReadiness(), {
    enrollmentId: 'enroll-1',
    connectionEpoch: 7,
    isCurrent: () => false,
  });
  assert.equal(recorded, false);
  assert.equal((await service.readiness('enroll-1')).readiness.probe, undefined);
  assert.deepEqual(await service.listProbes('enroll-1'), []);
});

test('the store rejects mixed-epoch readiness and probe as one unit', async () => {
  const store = new InMemoryEnvironmentReadinessStore();
  const committed = await store.commitObservation('env-1', {
    readiness: {
      enrollmentId: 'enroll-1',
      connectionEpoch: 7,
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [],
    },
    probe: {
      enrollmentId: 'enroll-1',
      connectionEpoch: 6,
      at: 1_234,
      latencyMs: 12,
      protocolOk: true,
      enginesOk: true,
      summary: 'mixed authority must fail',
    },
  }, {
    enrollmentId: 'enroll-1',
    connectionEpoch: 7,
    isCurrent: () => true,
  });
  assert.equal(committed, false);
  assert.equal(await store.getReadiness('env-1'), undefined);
  assert.deepEqual(await store.listProbes('env-1'), []);
});

test('disconnect while an atomic readiness/probe commit is waiting leaves neither document', async () => {
  const store = new DelayedReadinessStore();
  let current = true;
  const { service } = await enrolled(store, () => current ? 7 : undefined);
  const recording = service.observeWorkerReadiness('enroll-1', startupReadiness(), {
    enrollmentId: 'enroll-1',
    connectionEpoch: 7,
    isCurrent: () => current,
  });
  await store.commitStarted;
  current = false;
  store.continueCommit();
  assert.equal(await recording, false);
  assert.equal(await store.getReadiness('env-1'), undefined);
  assert.deepEqual(await service.listProbes('enroll-1'), []);
});

test('revoke fences a delayed accepted-epoch commit before durable lifecycle save', async () => {
  const store = new DelayedReadinessStore();
  let current = true;
  const { service } = await enrolled(store, () => current ? 7 : undefined);
  const recording = service.observeWorkerReadiness('enroll-1', startupReadiness(), {
    enrollmentId: 'enroll-1',
    connectionEpoch: 7,
    isCurrent: () => current,
  });
  await store.commitStarted;
  await service.revoke('enroll-1', 'retired');
  current = false;
  store.continueCommit();
  assert.equal(await recording, false);
  assert.equal(await store.getReadiness('env-1'), undefined);
  assert.deepEqual(await store.listProbes('env-1'), []);
  const projected = await service.readiness('enroll-1');
  assert.equal(projected.enrollment.status, 'revoked');
  assert.equal(projected.readiness.connection.state, 'never-connected');
  assert.deepEqual(await service.listProbes('enroll-1'), []);
});

test('disconnect after the atomic commit cannot project the prior epoch as current', async () => {
  const store = new PostCommitDelayedReadinessStore();
  let current = true;
  const { service } = await enrolled(store, () => current ? 7 : undefined);
  const recording = service.observeWorkerReadiness('enroll-1', startupReadiness(), {
    enrollmentId: 'enroll-1',
    connectionEpoch: 7,
    isCurrent: () => current,
  });
  await store.committed;
  current = false;
  store.continueReturn();

  assert.equal(await recording, true, 'the observation was valid at its atomic commit point');
  assert.equal((await store.getReadiness('env-1'))?.connectionEpoch, 7);
  assert.equal((await service.readiness('enroll-1')).readiness.connection.state, 'never-connected');
  assert.equal((await service.readiness('enroll-1')).readiness.probe, undefined);
  assert.equal((await service.listProbes('enroll-1')).length, 1, 'accepted history remains auditable');
});
