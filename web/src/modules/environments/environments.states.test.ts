/**
 * The state matrix: every state the Manage Environments page can present is
 * reachable through the typed service port and renders a distinct combination
 * of traffic light, boxes, and controls.
 *
 * The states are the product's settled vocabulary (ADR-0008/0009):
 * ready, loading, empty, pending, degraded, offline, incompatible,
 * reconciling, recovery, forced-release-audit, archived, risk-confirmation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureEnvironmentService } from './adapters/fixture-adapter.ts';
import type { EnvironmentInstance } from './types.ts';

const service = new FixtureEnvironmentService();
const envs = await service.listEnvironments();

function env(id: string): EnvironmentInstance {
  const found = envs.find((e) => e.id === id);
  assert.ok(found, `${id} exists in the coverage matrix`);
  return found;
}

test('ready, pending, degraded, incompatible, archived, and offline rows exist and are distinct', () => {
  const ready = env('env-ready');
  assert.equal(ready.trafficLight, 'green');
  assert.equal(ready.enrollmentStatus, 'approved');
  assert.equal(ready.workSafety, 'held');

  const pending = env('env-pending');
  assert.equal(pending.enrollmentStatus, 'pending');
  assert.equal(pending.trafficLight, 'yellow');

  const degraded = env('env-degraded');
  assert.equal(degraded.trafficLight, 'yellow');
  assert.equal(degraded.engineReadiness['codex'], 'login-required');
  assert.notEqual(degraded.trafficLightReason, pending.trafficLightReason);

  const incompatible = env('env-incompatible');
  assert.equal(incompatible.protocolCompatibility, 'incompatible');
  assert.equal(incompatible.trafficLight, 'red');
  assert.ok(incompatible.protocolMismatchDetail);

  const archived = env('env-archived');
  assert.equal(archived.enrollmentStatus, 'archived');
  assert.equal(archived.trafficLight, 'yellow');

  const offline = env('env-recovery');
  assert.equal(offline.connectionState, 'offline');
  assert.equal(offline.workSafety, 'recovery');
});

test('reconciling and recovery remain distinct, and each names its decisive facts', () => {
  const reconciling = env('env-reconciling');
  const recovery = env('env-recovery');
  assert.equal(reconciling.workSafety, 'reconciling');
  assert.equal(recovery.workSafety, 'recovery');
  assert.equal(reconciling.trafficLight, 'yellow');
  assert.equal(recovery.trafficLight, 'red');
  assert.ok(recovery.leaseRecovery?.unresolvedFacts.length);
  assert.notEqual(reconciling.trafficLightReason, recovery.trafficLightReason);
});

test('the forced-release-audit state is reachable and distinct from recovery', async () => {
  const service = new FixtureEnvironmentService();
  // Force Release on the recovery row: recovery resolves and the audit remains.
  await service.forceRelease({
    environmentId: 'env-recovery',
    taskId: '104',
    reason: 'Host kernel panic; worker cannot reconnect',
    acknowledgedRisks: true,
  });
  const audited = await service.getEnvironment('env-recovery');
  assert.ok(audited);
  assert.equal(audited.workSafety, 'clear');
  assert.ok(audited.forcedReleaseRecord, 'the audit record remains after recovery resolves');
  assert.equal(audited.leaseRecovery, undefined);
  assert.match(audited.forcedReleaseRecord!.reason, /kernel panic/);
});

test('risk-confirmation gates the Force Release authorize action', async () => {
  const service = new FixtureEnvironmentService();
  await assert.rejects(
    service.forceRelease({
      environmentId: 'env-recovery',
      taskId: '104',
      reason: 'Host kernel panic',
      acknowledgedRisks: false,
    }),
    /requires risk acknowledgement/,
  );
  const untouched = await service.getEnvironment('env-recovery');
  assert.equal(untouched?.workSafety, 'recovery', 'a refused override leaves recovery intact');
});

test('loading and empty are bootstrap states, not environment rows', async () => {
  // Loading is the pending list promise; empty is a zero-row list. Neither is a
  // fixture row, so both stay reachable only through the service contract.
  const empty = new FixtureEnvironmentService([]);
  assert.deepEqual(await empty.listEnvironments(), []);
  assert.equal(await empty.getEnvironment('env-ready'), undefined);
});
