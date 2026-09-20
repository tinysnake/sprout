import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  observedFactsFromWorkerReadiness,
  protocolCompatibility,
  protocolMajor,
  summarizeEnvironmentReadiness,
  workSafetyFromLeases,
  type EnvironmentReadiness,
} from './readiness.ts';
import { assembleEnvironmentReadiness } from './readiness-service.ts';
import { createPendingEnrollment, approveEnrollment, type CreatePendingEnrollmentInput } from './enrollment.ts';
import { workerIdentityDigest } from './enrollment-identity.ts';

function ready(overrides: Partial<EnvironmentReadiness> = {}): EnvironmentReadiness {
  return {
    enrollmentStatus: 'approved',
    connection: { state: 'online', lastConfirmedAt: 1_000 },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    capabilities: [{ name: 'agent-run', permission: 'allowed', required: true }],
    engines: [
      {
        engine: 'codex',
        installed: true,
        readiness: 'ready',
        required: true,
        models: { state: 'available', models: ['gpt-5-codex'] },
      },
    ],
    probe: { at: 1_000, latencyMs: 12, protocolOk: true, enginesOk: true, summary: 'ok' },
    workSafety: { state: 'clear' },
    ...overrides,
  };
}

test('a fully ready Environment is Green with a decisive textual reason', () => {
  const summary = summarizeEnvironmentReadiness(ready(), { now: 1_100 });
  assert.equal(summary.level, 'green');
  assert.ok(summary.reason.length > 0);
});

test('the summary always carries the decisive reason and never replaces the facts', () => {
  const facts = ready({ connection: { state: 'offline' } });
  const summary = summarizeEnvironmentReadiness(facts, { now: 1_100 });
  assert.equal(summary.level, 'red');
  assert.match(summary.reason, /offline/i);
  // The facts are unchanged: the summary is a projection, not a mutation.
  assert.equal(facts.connection.state, 'offline');
  assert.equal(facts.enrollmentStatus, 'approved');
});

test('revocation, incompatibility, denial, missing engine, and recovery are Red', () => {
  assert.equal(
    summarizeEnvironmentReadiness(ready({ enrollmentStatus: 'revoked' }), { now: 1_100 }).level,
    'red',
  );
  assert.equal(
    summarizeEnvironmentReadiness(
      ready({ compatibility: { state: 'incompatible', detail: 'too old' } }),
      { now: 1_100 },
    ).level,
    'red',
  );
  assert.equal(
    summarizeEnvironmentReadiness(
      ready({ capabilities: [{ name: 'agent-run', permission: 'denied', required: true }] }),
      { now: 1_100 },
    ).level,
    'red',
  );
  assert.equal(
    summarizeEnvironmentReadiness(
      ready({
        engines: [
          {
            engine: 'codex',
            installed: false,
            readiness: 'missing',
            required: true,
            models: { state: 'none', models: [] },
          },
        ],
      }),
      { now: 1_100 },
    ).level,
    'red',
  );
  assert.equal(
    summarizeEnvironmentReadiness(ready({ workSafety: { state: 'recovery' } }), { now: 1_100 }).level,
    'red',
  );
});

test('pending enrollment, first connection, reconnect, unknown compatibility, login-required, and stale probe are Yellow', () => {
  assert.equal(
    summarizeEnvironmentReadiness(ready({ enrollmentStatus: 'pending' }), { now: 1_100 }).level,
    'yellow',
  );
  assert.equal(
    summarizeEnvironmentReadiness(ready({ connection: { state: 'never-connected' } }), { now: 1_100 })
      .level,
    'yellow',
  );
  assert.equal(
    summarizeEnvironmentReadiness(ready({ connection: { state: 'reconnecting' } }), { now: 1_100 })
      .level,
    'yellow',
  );
  assert.equal(
    summarizeEnvironmentReadiness(ready({ compatibility: { state: 'unknown' } }), { now: 1_100 }).level,
    'yellow',
  );
  assert.equal(
    summarizeEnvironmentReadiness(
      ready({
        engines: [
          {
            engine: 'codex',
            installed: true,
            readiness: 'login-required',
            required: true,
            models: { state: 'unknown', models: [] },
          },
        ],
      }),
      { now: 1_100 },
    ).level,
    'yellow',
  );
  const stale = summarizeEnvironmentReadiness(
    ready({ probe: { at: 1_000, latencyMs: 12, protocolOk: true, enginesOk: true, summary: 'old' } }),
    { now: 1_000 + 600_000 },
  );
  assert.equal(stale.level, 'yellow');
  assert.match(stale.reason, /stale/i);
});

test('a Red decisive fact is preferred over a merely pending one', () => {
  const summary = summarizeEnvironmentReadiness(
    ready({ enrollmentStatus: 'pending', workSafety: { state: 'recovery' } }),
    { now: 1_100 },
  );
  assert.equal(summary.level, 'red');
  assert.match(summary.reason, /recovery/i);
});

test('protocol compatibility is derived from the reported major version, not guessed', () => {
  const supported = { minMajor: 2, maxMajor: 2 };
  assert.equal(protocolCompatibility('2.1', supported).state, 'compatible');
  assert.equal(protocolCompatibility('v2.0', supported).state, 'compatible');
  assert.equal(protocolCompatibility('1.8', supported).state, 'incompatible');
  assert.equal(protocolCompatibility('3.0', supported).state, 'incompatible');
  assert.equal(protocolCompatibility(undefined, supported).state, 'unknown');
  assert.equal(protocolMajor('v2.1'), 2);
  assert.equal(protocolMajor('nonsense'), undefined);
});

test('work safety is projected from the lease registry without collapsing other facts', () => {
  assert.equal(
    workSafetyFromLeases([{ instanceId: 'env-1', state: 'active' }], 'env-1'),
    'held',
  );
  assert.equal(
    workSafetyFromLeases([{ instanceId: 'env-1', state: 'recovering' }], 'env-1'),
    'recovery',
  );
  assert.equal(workSafetyFromLeases([], 'env-1'), 'clear');
  assert.equal(
    workSafetyFromLeases([{ instanceId: 'env-2', state: 'active' }], 'env-1'),
    'clear',
    'another environment lease does not affect this one',
  );
});

test('a Worker readiness declaration maps to independent observed facts without assuming unverified values', () => {
  const observed = observedFactsFromWorkerReadiness({
    protocolVersion: '2',
    engines: [
      { engine: 'codex', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-5-codex'] },
      { engine: 'pi', installed: true, readiness: 'weird-value', modelAvailability: 'whatever', models: [] },
    ],
    at: 5_000,
    supported: { minMajor: 2, maxMajor: 2 },
  });
  assert.equal(observed.connection.state, 'online');
  assert.equal(observed.compatibility.state, 'compatible');
  assert.equal(observed.compatibility.workerProtocolVersion, '2');
  assert.equal(observed.engines[0]?.readiness, 'ready');
  assert.equal(observed.engines[0]?.models.state, 'available');
  // An unrecognized value becomes `unknown` rather than being trusted.
  assert.equal(observed.engines[1]?.readiness, 'unknown');
  assert.equal(observed.engines[1]?.models.state, 'unknown');
});

function enrollmentWith(platform: string, capabilityRequests: readonly string[]) {
  const input: CreatePendingEnrollmentInput = {
    id: 'enroll-1',
    environmentInstanceId: 'env-1',
    displayName: 'Env',
    identityDigest: workerIdentityDigest('public-key-a'),
    platform,
    capabilityRequests,
    engineFacts: [],
    at: 1_000,
  };
  return approveEnrollment(createPendingEnrollment(input), {
    capabilityPermissions: Object.fromEntries(capabilityRequests.map((capability) => [capability, true])),
    at: 2_000,
  });
}

test('only explicitly required engines block work: an unrequired unavailable engine is Yellow', () => {
  const enrollment = enrollmentWith('macos', ['agent-run']);
  const observed = {
    connection: { state: 'online' as const, lastConfirmedAt: 3_000 },
    compatibility: { state: 'compatible' as const, workerProtocolVersion: '2' },
    engines: [
      { engine: 'codex', installed: true, readiness: 'ready' as const, required: false, models: { state: 'available' as const, models: ['gpt-5-codex'] } },
    ],
  };

  // Empty configuration: Pi is genuinely absent but nobody requires it, so the
  // Environment is Yellow (attention), never a fabricated Red dual-engine block.
  const noRequirements = assembleEnvironmentReadiness({
    enrollment,
    observed,
    leases: [],
    requiredEngines: [],
    probe: { at: 3_000, latencyMs: 1, protocolOk: true, enginesOk: true, summary: 'ok' },
    supportedProtocol: { minMajor: 2, maxMajor: 2 },
    now: 3_100,
  });
  assert.equal(noRequirements.readiness.engines.every((engine) => engine.required === false), true);
  assert.notEqual(noRequirements.summary.level, 'red', noRequirements.summary.reason);

  // An explicit requirement makes the absence a Red block.
  const requiresPi = assembleEnvironmentReadiness({
    enrollment,
    observed,
    leases: [],
    requiredEngines: ['pi'],
    probe: { at: 3_000, latencyMs: 1, protocolOk: true, enginesOk: true, summary: 'ok' },
    supportedProtocol: { minMajor: 2, maxMajor: 2 },
    now: 3_100,
  });
  assert.equal(requiresPi.readiness.engines.find((engine) => engine.engine === 'pi')?.required, true);
  assert.equal(requiresPi.summary.level, 'red');
  assert.match(requiresPi.summary.reason, /pi/i);
});
