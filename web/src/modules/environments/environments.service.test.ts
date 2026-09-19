import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureEnvironmentService } from './adapters/fixture-adapter.ts';

test('EnvironmentService: listEnvironments returns structured health facts and state coverage', async () => {
  const service = new FixtureEnvironmentService();
  const envs = await service.listEnvironments();

  assert.ok(envs.length >= 6, 'Contains at least 6 representative environment instances');

  // Verify state coverage matrix exists
  const ready = envs.find((e) => e.id === 'env-ready');
  assert.ok(ready, 'Ready environment exists');
  assert.equal(ready.trafficLight, 'green');
  assert.equal(ready.enrollmentStatus, 'approved');
  assert.equal(ready.connectionState, 'online');
  assert.equal(ready.workSafety, 'held');
  assert.ok(ready.activeLeaseHolder, 'Active lease holder present');
  assert.equal(ready.activeLeaseHolder.holderId, '101');

  const recovery = envs.find((e) => e.id === 'env-recovery');
  assert.ok(recovery, 'Recovery environment exists');
  assert.equal(recovery.trafficLight, 'red');
  assert.equal(recovery.workSafety, 'recovery');
  assert.ok(recovery.leaseRecovery, 'Lease recovery info present');
  assert.ok(recovery.leaseRecovery.unresolvedFacts.length > 0);

  const pending = envs.find((e) => e.id === 'env-pending');
  assert.ok(pending, 'Pending environment exists');
  assert.equal(pending.enrollmentStatus, 'pending');
  assert.equal(pending.trafficLight, 'yellow');

  const degraded = envs.find((e) => e.id === 'env-degraded');
  assert.ok(degraded, 'Degraded environment exists');
  assert.equal(degraded.trafficLight, 'yellow');
  assert.equal(degraded.engineReadiness.codex, 'login-required');

  const incompatible = envs.find((e) => e.id === 'env-incompatible');
  assert.ok(incompatible, 'Incompatible environment exists');
  assert.equal(incompatible.trafficLight, 'red');
  assert.equal(incompatible.protocolCompatibility, 'incompatible');
  assert.ok(incompatible.protocolMismatchDetail);

  const archived = envs.find((e) => e.id === 'env-archived');
  assert.ok(archived, 'Archived environment exists');
  assert.equal(archived.enrollmentStatus, 'archived');
});

test('EnvironmentService: approveEnrollment approves pending host and updates traffic light', async () => {
  const service = new FixtureEnvironmentService();
  await service.approveEnrollment('env-pending');

  const env = await service.getEnvironment('env-pending');
  assert.ok(env);
  assert.equal(env.enrollmentStatus, 'approved');
  assert.equal(env.connectionState, 'online');
  assert.equal(env.trafficLight, 'green');
});

test('EnvironmentService: triggerProbe records probe history with latency and protocol facts', async () => {
  const service = new FixtureEnvironmentService();
  const probe = await service.triggerProbe('env-ready');

  assert.ok(probe.latencyMs > 0);
  assert.equal(probe.protocolOk, true);
  assert.equal(probe.enginesOk, true);

  const env = await service.getEnvironment('env-ready');
  assert.ok(env);
  assert.equal(env.probeHistory[0]?.summary, probe.summary);
});

test('EnvironmentService: togglePermission toggles capability permission cleanly', async () => {
  const service = new FixtureEnvironmentService();
  const before = await service.getEnvironment('env-ready');
  assert.equal(before?.capabilityPermissions.guiAutomation, true);

  await service.togglePermission('env-ready', 'guiAutomation');

  const after = await service.getEnvironment('env-ready');
  assert.equal(after?.capabilityPermissions.guiAutomation, false);
});

test('EnvironmentService: unbindWorkspace removes bound workspace safely', async () => {
  const service = new FixtureEnvironmentService();
  const before = await service.getEnvironment('env-ready');
  assert.equal(before?.boundWorkspaces.length, 1);

  await service.unbindWorkspace('sprout-m2', 'env-ready');

  const after = await service.getEnvironment('env-ready');
  assert.equal(after?.boundWorkspaces.length, 0);
});

test('EnvironmentService: reconcileEvidence synchronizes evidence and updates recovery state', async () => {
  const service = new FixtureEnvironmentService();
  await service.reconcileEvidence('env-recovery');

  const env = await service.getEnvironment('env-recovery');
  assert.ok(env?.leaseRecovery?.reconciledEvidence);
  assert.equal(env.leaseRecovery.reconciledEvidence.retainedEventsCount, 4);
  assert.equal(env.leaseRecovery.reconciledEvidence.engineStoppedProof, true);
});

test('EnvironmentService: resumeRecovery and discardRecovery resolve lease cleanly', async () => {
  const service = new FixtureEnvironmentService();

  // Test resume
  await service.resumeRecovery('104');
  let env = await service.getEnvironment('env-recovery');
  assert.equal(env?.workSafety, 'held');
  assert.equal(env?.trafficLight, 'green');

  // Test discard on fresh service
  const service2 = new FixtureEnvironmentService();
  await service2.discardRecovery('104');
  env = await service2.getEnvironment('env-recovery');
  assert.equal(env?.workSafety, 'clear');
  assert.equal(env?.activeLeaseHolder, undefined);
  assert.equal(env?.trafficLight, 'green');
});

test('EnvironmentService: forceRelease requires risk acknowledgement and creates audit record', async () => {
  const service = new FixtureEnvironmentService();

  // Refuses without ack
  await assert.rejects(
    async () => {
      await service.forceRelease({
        environmentId: 'env-recovery',
        taskId: '104',
        reason: 'Host kernel panic',
        acknowledgedRisks: false,
      });
    },
    /requires risk acknowledgement/
  );

  // Succeeds with ack and reason
  await service.forceRelease({
    environmentId: 'env-recovery',
    taskId: '104',
    reason: 'Host machine hard rebooted without clean worker exit',
    acknowledgedRisks: true,
  });

  const env = await service.getEnvironment('env-recovery');
  assert.ok(env);
  assert.equal(env.workSafety, 'clear');
  assert.equal(env.trafficLight, 'green');
  assert.ok(env.forcedReleaseRecord);
  assert.equal(env.forcedReleaseRecord.reason, 'Host machine hard rebooted without clean worker exit');
  assert.match(env.forcedReleaseRecord.actor, /Operator/);
});

test('EnvironmentService: archive, restore, and unenroll transitions', async () => {
  const service = new FixtureEnvironmentService();

  // Archive
  await service.archiveEnvironment('env-ready');
  let env = await service.getEnvironment('env-ready');
  assert.equal(env?.enrollmentStatus, 'archived');
  assert.equal(env?.trafficLight, 'yellow');

  // Restore
  await service.restoreEnvironment('env-ready');
  env = await service.getEnvironment('env-ready');
  assert.equal(env?.enrollmentStatus, 'approved');
  assert.equal(env?.trafficLight, 'green');

  // Unenroll
  await service.unenrollEnvironment('env-ready');
  env = await service.getEnvironment('env-ready');
  assert.equal(env?.enrollmentStatus, 'revoked');
  assert.equal(env?.trafficLight, 'red');
});
