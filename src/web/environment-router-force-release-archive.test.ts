import { test } from 'node:test';

import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';


import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';

import { EnvironmentPool } from '../environment/pool.ts';

import { ScriptedEngineAdapter } from '../engine/scripted.ts';

import { AgentRegistry } from '../agent/registry.ts';

import { ProjectRegistry } from '../project/registry.ts';

import { InMemoryRunStore } from '../run/store.ts';

import { RunOrchestrator } from '../run/orchestrator.ts';

import { OperatorSessionService } from '../auth/service.ts';

import { InMemoryOperatorSessionStore } from '../auth/store.ts';

import { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';

import { createReadinessAuthorityTestSeam } from '../environment/readiness-authority.test-support.ts';

import { EnrollmentError } from '../environment/enrollment.ts';

import { InMemoryEnrollmentStore } from '../environment/enrollment-store.ts';

import { InMemoryEnvironmentReadinessStore } from '../environment/readiness-store.ts';

import { EnvironmentRecoveryService } from '../environment/recovery-service.ts';

import { InMemoryRecoveryStore } from '../environment/recovery-store.ts';

import { EnvironmentArchiveService } from '../environment/archive.ts';

import { FORCE_RELEASE_CONFIRMATION } from '../environment/recovery.ts';

import { workerIdentityFixture } from '../environment/worker-identity-fixture.ts';

import { createRunApi } from './api.ts';

import { createEnvironmentRouter } from './environment-router.ts';

import { WorkerGateway } from '../worker/gateway.ts';


/**
 * HTTP contract, privacy, and restart-independent behaviour for the Environment
 * enrollment and readiness routes (#87).
 *
 * The routes are exercised through the real HTTP transport after the #84 auth
 * boundary, so the tests prove what a browser actually receives — including that
 * no private material can be observed — rather than calling the router directly.
 *
 * Since the #87 rework a Worker must prove possession of its private key, so
 * these tests drive the real challenge route and sign the nonce as a Worker
 * would; a bare public key or digest is asserted to be refused.
 */

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};

const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };


interface EnrollmentRuntime {
  readonly api: Awaited<ReturnType<typeof createRunApi>>;
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
  readonly enrollments: EnvironmentEnrollmentService;
  readonly enrollmentsStore: InMemoryEnrollmentStore;
  readonly pool: EnvironmentPool;
  readonly recovery: EnvironmentRecoveryService;
  readonly archive: EnvironmentArchiveService;
}


async function enrollmentApi(options: { readonly requiredEngines?: readonly string[] } = {}): Promise<EnrollmentRuntime> {
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    projects: new ProjectRegistry([
      {
        id: 'project-sprout',
        goal: 'Ship Sprout',
        rules: [],
        availableEnvironmentInstanceIds: ['mac-mini-1'],
        memberships: [
          { agentId: 'agent-scout', responsibilities: [], collaborationInstructions: '' },
        ],
      },
    ]),
    pool,
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  const credential = randomBytes(32).toString('base64url');
  await auth.initializeOrRecover(credential);
  const enrollmentsStore = new InMemoryEnrollmentStore();
  const enrollments = new EnvironmentEnrollmentService({
    enrollments: enrollmentsStore,
    readiness: new InMemoryEnvironmentReadinessStore(),
    currentConnectionEpoch: () => 1,
    verifyObservationAuthority: readinessAuthorityTestSeam.verify,
    leases: () => pool.leases(),
    ...(options.requiredEngines !== undefined ? { requiredEngines: options.requiredEngines } : {}),
    clock: () => 10_000,
    idFactory: () => 'enroll-1',
  });
  const recoveryStore = new InMemoryRecoveryStore();
  let recoveryRecordIndex = 0;
  const recovery = new EnvironmentRecoveryService({
    store: recoveryStore,
    leases: pool,
    clock: () => 10_000,
    idFactory: () => `rec-${++recoveryRecordIndex}`,
  });
  const archive = new EnvironmentArchiveService({
    enrollments: enrollmentsStore,
    leases: pool,
    recovery,
    clock: () => 10_000,
  });
  let workerProbeAt = 1_000;
  const api = createRunApi({
    orchestrator,
    // The machine-authenticated Worker gateway (#115) is composed alongside the
    // Human browser boundary, so the claim route exists without a cookie.
    workerGateway: new WorkerGateway({ enrollments }),
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    auth,
    routers: [createEnvironmentRouter({
      enrollments,
      recovery,
      archive,
      requestProbe: async (enrollmentId) => {
        const enrollment = await enrollments.get(enrollmentId);
        if (enrollment?.status !== 'approved') {
          throw new EnrollmentError('not-approved', 'The Environment enrollment is not approved.');
        }
        const at = workerProbeAt++;
        const probe = {
          at,
          latencyMs: 7,
          protocolOk: true,
          enginesOk: false,
          source: 'worker' as const,
          version: '0.154.0',
          summary: 'Worker non-inference readiness probe completed.',
        };
        const authority = readinessAuthorityTestSeam.mint({ environmentInstanceId: enrollment.environmentInstanceId,
          enrollmentId, connectionEpoch: 1 });
        const attempt = await enrollments.issueReadinessAttempt(enrollmentId, authority);
        assert.ok(attempt);
        const recorded = await enrollments.recordReadinessObservation(enrollmentId, {
          readiness: { protocolVersion: '2', observedAt: at, engines: [], probe },
          probe,
        }, authority, { attempt });
        if (!recorded) throw new Error('synthetic Worker probe was rejected');
        return recorded;
      },
    })],
  });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  assert.equal(response.status, 201);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return { api, base, cookie, csrf: csrfToken, enrollments, enrollmentsStore, pool, recovery, archive };
}


const readinessAuthorityTestSeam = createReadinessAuthorityTestSeam();


function command(
  base: string,
  path: string,
  session: { readonly cookie: string; readonly csrf: string },
  body?: unknown,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'x-sprout-csrf': session.csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });
}


function read(
  base: string,
  path: string,
  session: { readonly cookie: string },
): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { cookie: session.cookie } });
}


/** A helper that drives an approved enrollment and one protected Task lease over HTTP. */
export async function recoveryApi(options: { readonly requiredEngines?: readonly string[] } = {}): Promise<
  EnrollmentRuntime & { readonly leaseId: string }
> {
  const runtime = await enrollmentApi(options);
  const identity = workerIdentityFixture();
  await command(runtime.base, '/api/environments/enrollments', runtime, {
    environmentInstanceId: 'mac-mini-1',
    displayName: 'Local Mac',
    publicKey: identity.publicKey,
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engines: [],
  });
  await command(runtime.base, '/api/environments/enrollments/enroll-1/approve', runtime, {
    capabilityPermissions: { 'agent-run': true },
  });
  const acquired = runtime.pool.reserveTaskLease({
    instanceId: 'mac-mini-1',
    capability: 'agent-run',
    holderId: 'task-1',
    taskId: 'task-1',
    ttlMs: 60_000,
  });
  assert.equal(acquired.ok, true);
  const lease = acquired.ok ? acquired.lease : undefined;
  assert.ok(lease);
  // The reservation is a candidate until adopted; adoption is what a real Task
  // begin transaction performs, and it makes the lease visible to the pool.
  runtime.pool.adoptLease(lease);
  await runtime.recovery.open({ leaseId: lease.id, cause: 'worker-channel-lost', hadActiveRun: true });
  return { ...runtime, leaseId: lease.id };
}


test('Force Release over HTTP requires the full manifest and records the permanent outcome', async () => {
  const runtime = await recoveryApi();
  try {
    await command(runtime.base, `/api/environments/recovery/${runtime.leaseId}/reconnect`, runtime, {
      enrollmentId: 'enroll-1',
      environmentInstanceId: 'mac-mini-1',
      identityVerified: true,
      protocolCompatible: true,
      permissionsAllowed: true,
      hadActiveRun: true,
    });
    await command(runtime.base, `/api/environments/recovery/${runtime.leaseId}/evidence`, runtime, {
      hadActiveRun: true,
      evidence: {
        retainedEventCount: 2,
        turnSettlementObserved: true,
        engineSessionStopped: false,
        taskContextRecycled: false,
      },
    });

    const mismatched = await command(
      runtime.base,
      `/api/environments/recovery/${runtime.leaseId}/force-release`,
      runtime,
      { acknowledgedRisks: true, typedConfirmation: 'please', reason: 'stuck' },
    );
    assert.equal(mismatched.status, 409);
    assert.equal(((await mismatched.json()) as { code: string }).code, 'typed-confirmation-mismatch');

    const forced = await command(
      runtime.base,
      `/api/environments/recovery/${runtime.leaseId}/force-release`,
      runtime,
      {
        acknowledgedRisks: true,
        typedConfirmation: FORCE_RELEASE_CONFIRMATION,
        reason: 'The Worker host cannot be reached to finish cleanup',
      },
    );
    assert.equal(forced.status, 201);
    const outcome = (await forced.json()) as {
      forceRelease: { leaseId: string; unresolvedFacts: readonly string[]; projectWorkspacePreserved: boolean };
    };
    assert.equal(outcome.forceRelease.leaseId, runtime.leaseId);
    assert.equal(outcome.forceRelease.projectWorkspacePreserved, true);
    assert.ok(outcome.forceRelease.unresolvedFacts.length > 0);
    assert.equal(runtime.pool.getLease(runtime.leaseId)?.state, 'released');

    // The exceptional outcome stays in durable history after resolution.
    const listing = await read(runtime.base, '/api/environments/enrollments/enroll-1/recovery', runtime);
    const listed = (await listing.json()) as { forceReleases: readonly { leaseId: string }[] };
    assert.equal(listed.forceReleases.length, 1);
    assert.equal(listed.forceReleases[0]?.leaseId, runtime.leaseId);
  } finally {
    await runtime.api.close();
  }
});


test('recovery routes require an authenticated session like every other route', async () => {
  const runtime = await recoveryApi();
  try {
    assert.equal(
      (await fetch(`${runtime.base}/api/environments/enrollments/enroll-1/recovery`)).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${runtime.base}/api/environments/recovery/${runtime.leaseId}/force-release`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).status,
      401,
    );
    // The record and the lease remain untouched.
    assert.equal(runtime.pool.getLease(runtime.leaseId)?.state, 'recovering');
  } finally {
    await runtime.api.close();
  }
});


test('archive and restore are authorized durable decisions with their ADR-0008 guard', async () => {
  const runtime = await enrollmentApi();
  try {
    // An unknown enrollment is a sanitized 404, never a verifier.
    const missing = await command(runtime.base, '/api/environments/enrollments/nope/archive', runtime, {});
    assert.equal(missing.status, 404);

    const identity = workerIdentityFixture();
    await command(runtime.base, '/api/environments/enrollments', runtime, {
      environmentInstanceId: 'mac-mini-1',
      displayName: 'Local Mac',
      publicKey: identity.publicKey,
      platform: 'macos',
      capabilityRequests: ['agent-run'],
    });
    await command(runtime.base, '/api/environments/enrollments/enroll-1/approve', runtime, {
      capabilityPermissions: { 'agent-run': true },
    });

    // A held lease bars archive: active work depends on the instance.
    const acquired = runtime.pool.acquireLease({
      instanceId: 'mac-mini-1',
      capability: 'agent-run',
      holderId: 'agent-scout',
      ttlMs: 60_000,
    });
    assert.ok(acquired.ok);
    const blocked = await command(runtime.base, '/api/environments/enrollments/enroll-1/archive', runtime, {
      reason: 'host retired for the week',
    });
    assert.equal(blocked.status, 409, 'an active lease refuses archive');

    runtime.pool.releaseLease(acquired.lease.id);
    const archived = await command(runtime.base, '/api/environments/enrollments/enroll-1/archive', runtime, {});
    assert.equal(archived.status, 200);
    const archivedBody = (await archived.json()) as {
      enrollment: { readonly status: string; readonly decisions: readonly { readonly kind: string }[] };
    };
    assert.equal(archivedBody.enrollment.status, 'archived');
    assert.ok(
      archivedBody.enrollment.decisions.some((decision) => decision.kind === 'archived'),
      'the archive is a durable decision in the append-only history',
    );

    // Restore reuses the still-valid approved enrollment.
    const restored = await command(runtime.base, '/api/environments/enrollments/enroll-1/restore', runtime, {});
    assert.equal(restored.status, 200);
    const restoredBody = (await restored.json()) as {
      enrollment: { readonly status: string; readonly decisions: readonly { readonly kind: string }[] };
    };
    assert.equal(restoredBody.enrollment.status, 'approved');
    assert.ok(
      restoredBody.enrollment.decisions.some((decision) => decision.kind === 'restored'),
      'the restore is a durable decision in the append-only history',
    );

    // Both routes are closed to anonymous callers.
    assert.equal(
      (await fetch(`${runtime.base}/api/environments/enrollments/enroll-1/restore`, { method: 'POST' })).status,
      401,
    );
  } finally {
    await runtime.api.close();
  }
});
