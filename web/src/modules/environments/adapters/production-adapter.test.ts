import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProductionEnvironmentService } from './production-adapter.ts';
import type {
  EnvironmentEnrollmentBrowserAdapter,
  EnvironmentFactsView,
} from '../../../adapters/environment-api.ts';

/**
 * Unit tests for the production bridge: every fact the page renders must come
 * from the wire adapter's read-only composition, and every mutation must be a
 * wire command. The bridge never invents a fact and never keeps a fixture.
 */

function enrollmentFacts(overrides: Partial<EnvironmentFactsView> = {}): EnvironmentFactsView {
  return {
    enrollment: {
      id: 'enroll-1',
      environmentInstanceId: 'inst-1',
      displayName: 'Local Mac',
      status: 'approved',
      platform: 'macos',
      identityDigest: 'digest',
      capabilityPermissions: { 'agent-run': true, 'fileReadWrite': false },
      createdAt: 1,
      updatedAt: 2,
      decisions: [],
    },
    readiness: {
      environmentInstanceId: 'inst-1',
      summary: { level: 'green', reason: 'Enrollment is approved and the Worker is online.' },
      enrollmentStatus: 'approved',
      connection: { state: 'online', lastConfirmedAt: 1000 },
      compatibility: { state: 'compatible', workerProtocolVersion: 'v2.1' },
      capabilities: [{ name: 'agent-run', permission: 'allowed', required: true }],
      engines: [{ engine: 'codex', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['m1'] } }],
      workSafety: { state: 'held' },
    },
    probes: [{ at: 900, latencyMs: 12, protocolOk: true, enginesOk: true, summary: 'ok', source: 'worker', version: '0.154.0' }],
    recovery: [],
    forceReleases: [],
    ...overrides,
  };
}

function adapter(facts: EnvironmentFactsView, calls: string[] = []): EnvironmentEnrollmentBrowserAdapter {
  return {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    setCsrfToken: () => undefined,
    async listEnrollments() {
      calls.push('listEnrollments');
      return [facts.enrollment];
    },
    async getEnvironmentFacts(id: string) {
      calls.push(`environmentFacts:${id}`);
      return facts;
    },
    async environmentFacts(id: string) {
      calls.push(`environmentFacts:${id}`);
      return facts;
    },
  } as unknown as EnvironmentEnrollmentBrowserAdapter;
}

test('the bridge projects the backend summary as the traffic-light authority', async () => {
  const service = new ProductionEnvironmentService(adapter(enrollmentFacts()));
  const env = await service.getEnvironment('enroll-1');
  assert.ok(env);
  assert.equal(env.trafficLight, 'green');
  assert.equal(env.trafficLightReason, 'Enrollment is approved and the Worker is online.');
  assert.equal(env.workSafety, 'held');
  assert.equal(env.connectionState, 'online');
  assert.equal(env.protocolCompatibility, 'compatible');
  assert.equal(env.engineReadiness['codex'], 'ready');
  assert.equal(env.capabilityPermissions['agent-run'], true);
  assert.equal(env.capabilityPermissions['fileReadWrite'], false);
});

test('a refused connection attempt is displayed separately from current compatibility', async () => {
  const facts = enrollmentFacts({ connectionAttempt: {
    outcome: 'incompatible', reason: 'the Worker protocol is incompatible with this Sprout build', at: 1200,
  } });
  facts.readiness = { ...facts.readiness, compatibility: { state: 'unknown' },
    connection: { state: 'never-connected' } };
  const env = await new ProductionEnvironmentService(adapter(facts)).getEnvironment('enroll-1');
  assert.equal(env?.protocolCompatibility, 'unknown');
  assert.deepEqual(env?.connectionAttempt, facts.connectionAttempt);
});

test('the bridge renders Worker source, version, observation time, auth, and model facts without inventing them', async () => {
  const facts = enrollmentFacts();
  facts.readiness = {
    ...facts.readiness,
    engines: [{
      engine: 'pi', version: '0.86.1', installed: true, readiness: 'ready', required: true,
      models: { state: 'unknown', models: [] }, authenticated: true, authType: 'oauth',
      modelIdPresent: false, probedAt: 1_234, probeExitCode: 0, source: 'pi-auth-check',
    }],
  };
  const environment = await new ProductionEnvironmentService(adapter(facts)).getEnvironment('enroll-1');
  assert.deepEqual(environment?.engineDetails?.pi, {
    version: '0.86.1', installed: true, readiness: 'ready', authStatus: 'authenticated',
    authenticated: true, authType: 'oauth', modelAvailability: 'unknown', models: [],
    modelIdPresent: false, observedAt: 1_234, probeExitCode: 0, source: 'pi-auth-check',
  });
  assert.deepEqual(environment?.probeHistory[0], {
    timestamp: '1970-01-01T00:00:00.900Z', observedAt: 900,
    latencyMs: 12, protocolOk: true, enginesOk: true, summary: 'ok',
    source: 'worker', version: '0.154.0',
  });
});

test('an explicit probe result keeps the Worker record time and provenance instead of browser-relative time', async () => {
  const facts = enrollmentFacts();
  const wire = adapter(facts);
  wire.requestProbe = async () => ({
    at: 1_700_000_000_123,
    latencyMs: 17,
    protocolOk: true,
    enginesOk: false,
    summary: 'Worker observation',
    source: 'worker',
    version: '0.154.0, 0.86.1',
  });
  const probe = await new ProductionEnvironmentService(wire).triggerProbe('enroll-1');
  assert.deepEqual(probe, {
    timestamp: '2023-11-14T22:13:20.123Z',
    observedAt: 1_700_000_000_123,
    latencyMs: 17,
    protocolOk: true,
    enginesOk: false,
    summary: 'Worker observation',
    source: 'worker',
    version: '0.154.0, 0.86.1',
  });
  assert.notEqual(probe.timestamp, 'just now');
});

test('an unknown environment returns undefined instead of an invented row', async () => {
  const failing = adapter(enrollmentFacts());
  failing.environmentFacts = async () => {
    throw new Error('unreachable');
  };
  const service = new ProductionEnvironmentService(failing);
  assert.equal(await service.getEnvironment('enroll-1'), undefined);
});

test('an unreachable readiness read degrades to its authority facts, never hides the row', async () => {
  const facts = enrollmentFacts();
  const flaky = adapter(facts);
  let failures = 0;
  flaky.environmentFacts = async (id: string) => {
    if (failures++ === 0) throw new Error('readiness unreachable');
    return facts;
  };
  const service = new ProductionEnvironmentService(flaky);
  const rows = await service.listEnvironments();
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.trafficLightReason, /not reachable/);
  assert.equal(rows[0]!.enrollmentStatus, 'approved', 'the enrollment authority is preserved');
});

test('approve grants every declared permission through the wire command', async () => {
  const facts = enrollmentFacts();
  const calls: string[] = [];
  const wire = adapter(facts, calls);
  const permissions: Record<string, boolean>[] = [];
  (wire as { approveEnrollment: unknown }).approveEnrollment = async (
    _id: string,
    granted: Record<string, boolean>,
  ) => {
    calls.push('approveEnrollment');
    permissions.push(granted);
    return facts.enrollment;
  };
  const service = new ProductionEnvironmentService(wire);
  await service.approveEnrollment('enroll-1');
  assert.deepEqual(permissions[0], { 'agent-run': true, fileReadWrite: true });
});

test('recovery decisions target the open record lease id from the wire facts', async () => {
  const facts = enrollmentFacts({
    readiness: enrollmentFacts().readiness,
    recovery: [
      {
        id: 'rec-1',
        environmentInstanceId: 'inst-1',
        leaseId: 'lease-9',
        holderKind: 'task',
        taskId: 'task-104',
        cause: 'worker-channel-lost',
        phase: 'recovery',
        startedAt: 10,
        updatedAt: 20,
        unresolvedFacts: ['The Worker channel is lost; no retained evidence has been synchronized.'],
        evidenceSynchronized: false,
        decisions: [],
      },
    ],
  });
  facts.readiness = { ...facts.readiness, workSafety: { state: 'recovery' } };
  const wire = adapter(facts);
  const targets: string[] = [];
  (wire as { resumeRecovery: unknown }).resumeRecovery = async (leaseId: string) => {
    targets.push(leaseId);
    return facts.recovery[0]!;
  };
  const service = new ProductionEnvironmentService(wire);
  await service.resumeRecovery('task-104');

  const env = await service.getEnvironment('enroll-1');
  assert.ok(env);
  assert.equal(env.workSafety, 'recovery');
  assert.equal(env.leaseRecovery?.leaseId, 'lease-9');
  assert.equal(env.activeLeaseHolder?.holderId, 'task-104');
  assert.deepEqual(targets, ['lease-9']);
});

test('a force release outcome is rendered as the durable audit record', async () => {
  const facts = enrollmentFacts({
    recovery: [],
    forceReleases: [
      {
        id: 'fr-1',
        environmentInstanceId: 'inst-1',
        leaseId: 'lease-9',
        holderKind: 'task',
        taskId: 'task-104',
        actor: 'operator',
        at: 5_000,
        reason: 'Host kernel panic; worker cannot reconnect',
        risksAcknowledged: true,
        unresolvedFacts: ['Engine process stop unconfirmed'],
        affectedRunIds: ['run-206'],
        projectWorkspacePreserved: true,
        unrecycledTaskContext: true,
      },
    ],
  });
  // After the override the Environment is reassignable again; the audit record
  // is what distinguishes this state from an ordinary held lease.
  facts.readiness = { ...facts.readiness, workSafety: { state: 'clear' } };
  const service = new ProductionEnvironmentService(adapter(facts));
  const env = await service.getEnvironment('enroll-1');
  assert.ok(env);
  assert.ok(env.forcedReleaseRecord);
  assert.equal(env.forcedReleaseRecord.actor, 'operator');
  assert.equal(env.forcedReleaseRecord.reason, 'Host kernel panic; worker cannot reconnect');
  assert.equal(env.workSafety, 'clear');
});

test('archive and restore forward to the wire archive routes', async () => {
  const facts = enrollmentFacts();
  const calls: string[] = [];
  const wire = adapter(facts, calls);
  wire.archiveEnvironment = async () => {
    calls.push('archive');
    return { ...facts.enrollment, status: 'archived' } as typeof facts.enrollment;
  };
  wire.restoreEnvironment = async () => {
    calls.push('restore');
    return facts.enrollment;
  };
  const service = new ProductionEnvironmentService(wire);
  await service.archiveEnvironment('enroll-1');
  await service.restoreEnvironment('enroll-1');
  // Archive and restore are direct authority commands: they need no prior read.
  assert.deepEqual(calls, ['archive', 'restore']);
});

test('M89-EVIDENCE-001: the production bridge never fabricates Worker-synchronized evidence', async () => {
  const facts = enrollmentFacts({
    readiness: {
      ...enrollmentFacts().readiness,
      workSafety: { state: 'reconciling' },
    },
    recovery: [
      {
        id: 'rec-1',
        environmentInstanceId: 'inst-1',
        leaseId: 'lease-9',
        holderKind: 'task',
        taskId: 'task-104',
        cause: 'worker-channel-lost',
        phase: 'reconciling',
        startedAt: 10,
        updatedAt: 20,
        unresolvedFacts: ['The Worker channel is lost; no retained evidence has been synchronized.'],
        evidenceSynchronized: false,
        decisions: [],
      },
    ],
  });
  const calls: string[] = [];
  const wire = adapter(facts, calls);
  // Every path that could carry a fabricated payload is instrumented: if the
  // bridge ever posts placeholder evidence, the spy records it.
  (wire as { synchronizeEvidence: unknown }).synchronizeEvidence = async (
    _leaseId: string,
    payload: unknown,
  ) => {
    calls.push(`synchronizeEvidence:${JSON.stringify(payload)}`);
    return facts.recovery[0]!;
  };
  const service = new ProductionEnvironmentService(wire);

  // The capability is declared absent: production has no Worker evidence port.
  assert.equal(service.supportsEvidenceReconciliation, false);

  // The reconcile action is a typed refusal, and nothing reaches the wire.
  await assert.rejects(
    () => service.reconcileEvidence('enroll-1'),
    /no Worker evidence port/i,
  );
  assert.deepEqual(calls, [], 'no synchronizeEvidence command was posted');

  // The refused action cannot have moved the record or manufactured the gate.
  const env = await service.getEnvironment('enroll-1');
  assert.equal(env?.workSafety, 'reconciling', 'the record stays reconciling');
  assert.equal(env?.leaseRecovery?.evidenceSynchronized, false, 'no evidence was fabricated');
});
