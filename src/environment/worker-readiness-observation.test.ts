import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EnvironmentEnrollmentService } from './enrollment-service.ts';
import {
  InMemoryEnvironmentReadinessStore,
  type ReadinessWriteGuard,
} from './readiness-store.ts';
import { InMemoryEnrollmentStore } from './enrollment-store.ts';
import type { ObservedReadiness } from './readiness-store.ts';
import type { ProbeResultFact } from './readiness.ts';

class DelayedReadinessStore extends InMemoryEnvironmentReadinessStore {
  #releaseSave: (() => void) | undefined;
  #releaseAppend: (() => void) | undefined;
  readonly saveStarted = new Promise<void>((resolve) => { this.#releaseSave = resolve; });
  readonly appendStarted = new Promise<void>((resolve) => { this.#releaseAppend = resolve; });
  #continueSave: (() => void) | undefined;
  #continueAppend: (() => void) | undefined;
  readonly waitForSave = new Promise<void>((resolve) => { this.#continueSave = resolve; });
  readonly waitForAppend = new Promise<void>((resolve) => { this.#continueAppend = resolve; });

  override async saveReadiness(
    environmentInstanceId: string,
    observed: ObservedReadiness,
    guard?: ReadinessWriteGuard,
  ): Promise<boolean> {
    this.#releaseSave?.();
    await this.waitForSave;
    return super.saveReadiness(environmentInstanceId, observed, guard);
  }

  override async appendProbe(
    environmentInstanceId: string,
    probe: ProbeResultFact,
    guard?: ReadinessWriteGuard,
  ): Promise<boolean> {
    this.#releaseAppend?.();
    await this.waitForAppend;
    return super.appendProbe(environmentInstanceId, probe, guard);
  }

  continueSave(): void { this.#continueSave?.(); }
  continueAppend(): void { this.#continueAppend?.(); }
}

async function enrolled(readiness = new InMemoryEnvironmentReadinessStore()) {
  const service = new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness,
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

test('a stale epoch is rejected before either readiness or probe persistence', async () => {
  const { service } = await enrolled();
  const recorded = await service.observeWorkerReadiness('enroll-1', startupReadiness(), {
    connectionEpoch: 7,
    isCurrent: () => false,
  });
  assert.equal(recorded, false);
  assert.equal((await service.readiness('enroll-1')).readiness.probe, undefined);
  assert.deepEqual(await service.listProbes('enroll-1'), []);
});

test('disconnect during an asynchronous readiness/probe write cannot append a superseded epoch', async () => {
  const store = new DelayedReadinessStore();
  const { service } = await enrolled(store);
  let current = true;
  const recording = service.observeWorkerReadiness('enroll-1', startupReadiness(), {
    connectionEpoch: 7,
    isCurrent: () => current,
  });
  await store.saveStarted;
  current = false;
  store.continueSave();
  assert.equal(await recording, false);
  assert.equal(await store.getReadiness('env-1'), undefined);
  assert.deepEqual(await service.listProbes('enroll-1'), []);
});

test('disconnect between readiness save and probe append rejects the old probe record', async () => {
  const store = new DelayedReadinessStore();
  const { service } = await enrolled(store);
  let current = true;
  const recording = service.observeWorkerReadiness('enroll-1', startupReadiness(), {
    connectionEpoch: 7,
    isCurrent: () => current,
  });
  await store.saveStarted;
  store.continueSave();
  await store.appendStarted;
  current = false;
  store.continueAppend();

  assert.equal(await recording, false);
  assert.equal((await store.getReadiness('env-1'))?.connectionEpoch, 7);
  assert.deepEqual(await service.listProbes('enroll-1'), []);
});
