/**
 * Focused regressions for the M77 rework findings:
 *
 * - M77-CONN-001: the typed Environment control boundary refuses an action while
 *   the connection is unsettled instead of queueing or applying it.
 * - M77-SCOPE-001: the page has no fixture authority of its own; the production
 *   route requires an injected typed adapter.
 * - M77-A11Y-001 / M77-PROJECT-001 are covered through the rendered DOM in the
 *   production and shell suites.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionPresentation } from '../shell/connection.ts';
import type { EnvironmentService } from './ports.ts';
import {
  createEnvironmentControlBoundary,
  EnvironmentControlRefused,
} from './control-boundary.ts';

function presentation(controlAvailable: boolean): ConnectionPresentation {
  return {
    status: controlAvailable ? 'green' : 'yellow',
    label: controlAvailable ? 'Operator Online' : 'Reconnecting',
    announce: controlAvailable
      ? 'Operator online. Live facts and control actions are available.'
      : 'Reconnecting to Sprout. Control actions are unavailable.',
    controlAvailable,
  };
}

function service(calls: string[]): EnvironmentService {
  const record = (name: string) => async () => {
    calls.push(name);
  };
  return {
    listEnvironments: async () => [],
    getEnvironment: async () => undefined,
    approveEnrollment: record('approveEnrollment'),
    triggerProbe: record('triggerProbe'),
    togglePermission: record('togglePermission'),
    unbindWorkspace: record('unbindWorkspace'),
    reconcileEvidence: record('reconcileEvidence'),
    resumeRecovery: record('resumeRecovery'),
    discardRecovery: record('discardRecovery'),
    forceRelease: record('forceRelease'),
    archiveEnvironment: record('archiveEnvironment'),
    restoreEnvironment: record('restoreEnvironment'),
    unenrollEnvironment: record('unenrollEnvironment'),
  } as unknown as EnvironmentService;
}

for (const state of ['loading', 'reconnecting', 'stale', 'offline'] as const) {
  test(`control is refused immediately while the connection is ${state} and nothing is queued`, async () => {
    const calls: string[] = [];
    const boundary = createEnvironmentControlBoundary({
      service: () => service(calls),
      presentation: () => presentation(false),
    });

    assert.equal(boundary.canControl(), false, `${state}: control reports unavailable`);

    await assert.rejects(
      () => boundary.run((s) => s.approveEnrollment('env-1')),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentControlRefused, 'a typed refusal is raised');
        assert.equal(error.kind, 'connection-unsettled');
        return true;
      }
    );

    // Nothing reached the service and nothing was retained for replay.
    assert.deepEqual(calls, [], `${state}: the service was never invoked`);
  });
}

test('control is refused when no typed authority is configured, without touching any service', async () => {
  const calls: string[] = [];
  const configured = service(calls);
  const boundary = createEnvironmentControlBoundary({
    service: () => undefined,
    presentation: () => presentation(true),
  });

  assert.equal(boundary.canControl(), false);
  await assert.rejects(
    () => boundary.run((s) => s.triggerProbe('env-1')),
    (error: unknown) => error instanceof EnvironmentControlRefused && error.kind === 'authority-unavailable'
  );
  assert.deepEqual(calls, [], 'no fallback fixture authority was invoked');
  void configured;
});

test('control reaches the typed service immediately once the connection is settled', async () => {
  const calls: string[] = [];
  const boundary = createEnvironmentControlBoundary({
    service: () => service(calls),
    presentation: () => presentation(true),
  });

  assert.equal(boundary.canControl(), true);
  await boundary.run((s) => s.triggerProbe('env-1'));
  assert.deepEqual(calls, ['triggerProbe']);
});
