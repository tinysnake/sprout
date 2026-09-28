/**
 * #162 regression: a probe observation commit republishes the catalog
 * eligibility projection.
 *
 * The stale-projection symptom from the live enrollment-to-run verification: a
 * green instance whose durable catalog row was never republished stayed
 * unpublishable, so the next `begin` refused with `no available environment`
 * until a connection/acceptance event happened to re-project the catalog. The
 * invariant under test lives at the durable probe-commit point itself: after
 * the sole accepted-authority readiness write commits a green observation, the
 * next `begin` resolves the instance with no further connection or acceptance
 * event and no hand-driven refresh.
 *
 * No personal, host, network, or credential details appear here. Instance ids,
 * keys, and probes are synthetic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';
import {
  INSTANCE_ID,
  PROJECT_ID,
  readinessWorkflowHarness,
  scriptedScope,
  targetBoundScriptedProbe,
  testComposition,
  waitFor,
} from './runtime-test-harness.ts';

test('#162: a green probe observation commit republishes eligibility so the next begin resolves it without connection events', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-162-projection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = await readinessWorkflowHarness({
    backend: 'sqlite',
    directory,
    engineId: 'scripted',
  });
  try {
    const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;

    // The connected Worker's startup observation is deliberately not green, so
    // the instance stays ineligible and no acceptance-time bootstrap refresh can
    // mask a missing probe-commit republish. The single acceptance event has
    // already happened by the time the observation below commits.
    await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
      readiness: () => ({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engines: [
          { engine: 'scripted', installed: true, readiness: 'missing', modelAvailability: 'unknown', models: [] },
        ],
        probe: {
          at: 1_000,
          latencyMs: 1,
          protocolOk: true,
          enginesOk: true,
          source: 'worker',
          version: '1.0.0',
          summary: 'Synthetic startup probe, deliberately not green.',
        },
      }),
    });
    await waitFor(
      () => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined,
      'accepted channel',
    );
    await waitFor(
      async () => (await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID)).length >= 1,
      'accepted Worker startup observation',
    );

    // Settle the pre-commit projection: the instance is ineligible, and its
    // durable catalog row exists exactly as its first post-enrollment save
    // wrote it (the row is identity-only and is never republished).
    await h.runtime.refreshEnvironmentCatalog();
    assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
    const rowBefore = await h.runtime.stores.environmentCatalog.get(INSTANCE_ID);
    assert.ok(rowBefore, 'the durable catalog row exists');

    // Project, access, and one Task ready to begin — all before the probe
    // commit, so `begin` itself is the very next action after the commit.
    const project = await h.runtime.projectService.create({
      id: PROJECT_ID,
      displayName: 'Projection Project',
      goal: 'Prove the probe commit republishes the catalog.',
      agentMemberships: [{ agentId: 'scout' }],
    });
    await h.runtime.projectAccess.grant({
      projectId: project.id,
      environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'default' },
    });
    const task = await h.runtime.tasks.create({
      projectId: project.id,
      title: 'Begin after the probe commit',
      goal: 'Resolve the green instance.',
      assignedAgentId: 'scout',
    });

    // The probe observation commit: the sole accepted-authority readiness
    // write, green for the currently accepted epoch, scoped to this build's
    // requirements.
    const authority = testComposition(h.runtime).workerGateway.authorizeObservation(INSTANCE_ID);
    assert.ok(authority, 'the accepted connection owns observation authority');
    const ticket = await testComposition(h.runtime).enrollments.issueReadinessAttempt(
      enrollmentId, authority, false, [], scriptedScope,
    );
    assert.ok(ticket);
    const receipt = await testComposition(h.runtime).enrollments.recordReadinessObservation(
      enrollmentId, targetBoundScriptedProbe(), authority, { attempt: ticket },
    );
    assert.ok(receipt, 'the probe observation commits');

    // No connection or acceptance event follows the commit and no caller
    // re-projects the catalog by hand: the commit itself must republish the
    // eligibility projection for the next begin.
    const begun = await h.runtime.tasks.begin(task.id);
    assert.equal(begun.environmentInstanceId, INSTANCE_ID, 'the next begin resolves the green instance');
    assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, true);
    // The identity-only durable row is untouched: eligibility never lived in
    // the row, so "row never republished" and "begin resolves" hold together.
    assert.equal(
      (await h.runtime.stores.environmentCatalog.get(INSTANCE_ID))?.updatedAt,
      rowBefore.updatedAt,
      'the durable catalog row itself is never republished',
    );
  } finally {
    await h.close();
  }
});
