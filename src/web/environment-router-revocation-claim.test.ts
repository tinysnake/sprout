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


test('M89-AUTHORITY-001: revoke → archive → restore → approve can never resurrect a revoked identity', async () => {
  const runtime = await enrollmentApi();
  try {
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
    await command(runtime.base, '/api/environments/enrollments/enroll-1/revoke', runtime, {
      reason: 'worker host left the fleet',
    });

    // Archive over a revoked enrollment is refused: revocation is sticky, so
    // the record cannot be parked in `archived` to later restore an approvable
    // status. No status transition or decision is written.
    const archiveRefused = await command(
      runtime.base,
      '/api/environments/enrollments/enroll-1/archive',
      runtime,
      { reason: 'host retired' },
    );
    assert.equal(archiveRefused.status, 409, 'a revoked enrollment refuses archive');
    const refusedBody = (await archiveRefused.json()) as { readonly code?: string };
    assert.equal(refusedBody.code, 'revoked-enrollment', 'the refusal names the authority rule');

    // The refused archive changed nothing: the record is still revoked.
    const stillRevoked = await fetch(`${runtime.base}/api/environments/enrollments/enroll-1`, {
      headers: { cookie: runtime.cookie },
    });
    assert.equal(stillRevoked.status, 200);
    const revokedView = (await stillRevoked.json()) as {
      readonly enrollment: { readonly status: string };
    };
    assert.equal(revokedView.enrollment.status, 'revoked');

    // Restore of a non-archived record stays refused: the archive refusal means
    // there is no archived row a restore could resurrect an approvable status
    // from. The revoke → archive → restore → approve chain ends here, closed.
    const restoreRefused = await command(
      runtime.base,
      '/api/environments/enrollments/enroll-1/restore',
      runtime,
      {},
    );
    assert.equal(restoreRefused.status, 409, 'restore is refused for a record that was never archived');
    const restoreBody = (await restoreRefused.json()) as { readonly code?: string };
    assert.equal(restoreBody.code, 'not-archived');

    // Approval is still the #87 refusal: only a fresh reset can reopen the
    // enrollment, invalidating the old digest first.
    const approveRefused = await command(
      runtime.base,
      '/api/environments/enrollments/enroll-1/approve',
      runtime,
      { capabilityPermissions: { 'agent-run': true } },
    );
    assert.equal(approveRefused.status, 409, 'a revoked enrollment refuses approval');
    const approveBody = (await approveRefused.json()) as { readonly code?: string };
    assert.equal(approveBody.code, 'revoked-enrollment');
  } finally {
    await runtime.api.close();
  }
});


test('M89-AUTHORITY-002: a revoked record archived by any prior writer restores as revoked and stays barred', async () => {
  const runtime = await enrollmentApi();
  try {
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
    await command(runtime.base, '/api/environments/enrollments/enroll-1/revoke', runtime, {
      reason: 'worker host left the fleet',
    });

    // A legacy writer that parked a revoked record in `archived` (the defect
    // this rework closes) must still not yield an approvable enrollment: the
    // restore derives the status from the last real authority decision.
    const stored = await runtime.enrollmentsStore.get('enroll-1');
    assert.ok(stored);
    await runtime.enrollmentsStore.save({ ...stored, status: 'archived' });
    const restored = await command(
      runtime.base,
      '/api/environments/enrollments/enroll-1/restore',
      runtime,
      {},
    );
    assert.equal(restored.status, 200);
    const restoredBody = (await restored.json()) as {
      readonly enrollment: { readonly status: string };
    };
    assert.equal(
      restoredBody.enrollment.status,
      'revoked',
      'restore of a revoked record returns it to revoked, never pending or approved',
    );

    // The restored record still refuses approval: the #87 fresh reset (which
    // invalidates the old identity digest) remains the only path back.
    const approveRefused = await command(
      runtime.base,
      '/api/environments/enrollments/enroll-1/approve',
      runtime,
      { capabilityPermissions: { 'agent-run': true } },
    );
    assert.equal(approveRefused.status, 409);
    const approveBody = (await approveRefused.json()) as { readonly code?: string };
    assert.equal(approveBody.code, 'revoked-enrollment');
  } finally {
    await runtime.api.close();
  }
});


/**
 * Identity-free pending enrollment and one-use claim separation (#115, ADR-0012).
 *
 * Web authority creates the pending enrollment without a Worker public key, host
 * address, or engine credential. The response separates the public bootstrap
 * input from a short-lived one-use secret, which is returned exactly once and
 * never echoed by a later read.
 */
test('Web creates an identity-free pending enrollment with a one-use claim', async () => {
  const runtime = await enrollmentApi();
  try {
    const requested = await command(runtime.base, '/api/environments/enrollments', runtime, {
      environmentInstanceId: 'mac-mini-1',
      displayName: 'Local Mac',
      platform: 'macos',
      protocolVersion: '2.1',
      capabilityRequests: ['agent-run'],
      engines: [],
    });
    assert.equal(requested.status, 201);
    const body = (await requested.json()) as {
      readonly enrollment: { readonly status: string; readonly identityDigest: string };
      readonly bootstrap: { readonly instructions: readonly string[] };
      readonly claim: { readonly secret: string; readonly expiresAt: number };
    };
    assert.equal(body.enrollment.status, 'pending');
    // No Worker key is bound by Web: the identity digest is empty until proof.
    assert.equal(body.enrollment.identityDigest, '');
    assert.ok(body.bootstrap.instructions.length > 0);
    assert.ok(body.claim.secret.length > 0);
    assert.equal(typeof body.claim.expiresAt, 'number');

    // A later read never echoes the secret or its digest.
    const readBack = await read(runtime.base, '/api/environments/enrollments/enroll-1', runtime);
    assert.equal(readBack.status, 200);
    const readBody = await readBack.text();
    assert.equal(readBody.includes(body.claim.secret), false, 'the one-use secret is never echoed');
  } finally {
    await runtime.api.close();
  }
});
