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

import type { WorkerIdentityProof } from '../environment/worker-proof.ts';

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


/** Obtain a challenge over HTTP and answer it as the Worker would. */
async function proveWorker(
  runtime: EnrollmentRuntime,
  identity: ReturnType<typeof workerIdentityFixture>,
): Promise<WorkerIdentityProof> {
  const challengeResponse = await command(
    runtime.base,
    '/api/environments/enrollments/enroll-1/challenge',
    runtime,
    {},
  );
  assert.equal(challengeResponse.status, 200);
  const { challenge } = (await challengeResponse.json()) as {
    readonly challenge: { readonly id: string; readonly enrollmentId: string; readonly nonce: string };
  };
  return identity.sign(challenge);
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


test('revocation, reset, and duplicate-identity outcomes are exposed and refuse a new key', async () => {
  const runtime = await enrollmentApi();
  try {
    const enrolled = workerIdentityFixture();
    const rogue = workerIdentityFixture();
    await command(runtime.base, '/api/environments/enrollments', runtime, {
      environmentInstanceId: 'mac-mini-1',
      displayName: 'Local Mac',
      publicKey: enrolled.publicKey,
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engines: [],
    });
    await command(runtime.base, '/api/environments/enrollments/enroll-1/approve', runtime, {
      capabilityPermissions: { 'agent-run': true },
    });

    const duplicate = await command(
      runtime.base,
      '/api/environments/enrollments/enroll-1/connect',
      runtime,
      {
        proof: await proveWorker(runtime, rogue),
        connection: { state: 'online' },
        compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
        engines: [],
      },
    );
    assert.equal(duplicate.status, 200);
    const duplicateBody = (await duplicate.json()) as {
      readonly outcome: string;
      readonly requiresHumanApproval: boolean;
    };
    assert.equal(duplicateBody.outcome, 'duplicate-new-key-refused');
    assert.equal(duplicateBody.requiresHumanApproval, true);

    const revoked = await command(runtime.base, '/api/environments/enrollments/enroll-1/revoke', runtime, {
      reason: 'retired after /Users/example/secret and sk-live-abcdefghijklmnopqrst leaked',
    });
    assert.equal(revoked.status, 200);
    const revokedBody = (await revoked.json()) as {
      readonly enrollment: {
        readonly status: string;
        readonly decisions: readonly { readonly kind: string; readonly reason: string }[];
      };
    };
    assert.equal(revokedBody.enrollment.status, 'revoked');
    const revokeReason = revokedBody.enrollment.decisions.at(-1)!.reason;
    assert.equal(/\/Users\//.test(revokeReason), false, 'the response never carries the absolute path');
    assert.equal(/sk-live-/.test(revokeReason), false, 'the response never carries the credential-like text');
    assert.match(revokeReason, /retired/i);

    // A revoked enrollment cannot be approved; it must be reset first.
    const refusedApproval = await command(
      runtime.base,
      '/api/environments/enrollments/enroll-1/approve',
      runtime,
      { capabilityPermissions: {} },
    );
    assert.equal(refusedApproval.status, 409);

    const reset = await command(runtime.base, '/api/environments/enrollments/enroll-1/reset', runtime, {
      reason: 'identity rotated',
    });
    assert.equal(reset.status, 200);
    const resetBody = (await reset.json()) as {
      readonly enrollment: {
        readonly status: string;
        readonly identityDigest: string;
      };
    };
    assert.equal(resetBody.enrollment.status, 'pending');
    assert.equal(resetBody.enrollment.identityDigest, '', 'the wire contract does not expose an invalidated digest');

    // The old key cannot reconnect after the reset; a fresh key claims it.
    const stale = await command(runtime.base, '/api/environments/enrollments/enroll-1/connect', runtime, {
      proof: await proveWorker(runtime, enrolled),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
    assert.equal(((await stale.json()) as { outcome: string }).outcome, 'stale-identity-refused');

    const fresh = workerIdentityFixture();
    const claimed = await command(runtime.base, '/api/environments/enrollments/enroll-1/connect', runtime, {
      proof: await proveWorker(runtime, fresh),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
    assert.equal(((await claimed.json()) as { outcome: string }).outcome, 'identity-claimed');
  } finally {
    await runtime.api.close();
  }
});


test('an unknown enrollment is a sanitized 404 and malformed input is a 400', async () => {
  const runtime = await enrollmentApi();
  try {
    const missing = await read(runtime.base, '/api/environments/enrollments/nope/readiness', runtime);
    assert.equal(missing.status, 404);

    const malformed = await command(runtime.base, '/api/environments/enrollments', runtime, {
      environmentInstanceId: 'mac-mini-1',
    });
    assert.equal(malformed.status, 400);

    const badEngine = await command(runtime.base, '/api/environments/enrollments', runtime, {
      environmentInstanceId: 'mac-mini-1',
      displayName: 'Local Mac',
      publicKey: 'public-key-a',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engines: 'not-an-array',
    });
    assert.equal(badEngine.status, 400);
  } finally {
    await runtime.api.close();
  }
});


test('no route response exposes a public key, private key, credential, hostname, address, or absolute path', async () => {
  const runtime = await enrollmentApi();
  try {
    const identity = workerIdentityFixture();
    const payload = JSON.stringify({
      environmentInstanceId: 'mac-mini-1',
      displayName: 'Local Mac',
      publicKey: 'PUBLIC_KEY_MATERIAL_MUST_NOT_LEAK',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engines: [],
    });
    await fetch(`${runtime.base}/api/environments/enrollments`, {
      method: 'POST',
      headers: {
        cookie: runtime.cookie,
        'x-sprout-csrf': runtime.csrf,
        'content-type': 'application/json',
      },
      body: payload,
    });
    await command(runtime.base, '/api/environments/enrollments/enroll-1/approve', runtime, {
      capabilityPermissions: { 'agent-run': true },
    });
    await command(runtime.base, '/api/environments/enrollments/enroll-1/connect', runtime, {
      proof: await proveWorker(runtime, identity),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
    const response = await read(runtime.base, '/api/environments/enrollments/enroll-1/readiness', runtime);
    const body = await response.text();

    assert.equal(body.includes('PUBLIC_KEY_MATERIAL_MUST_NOT_LEAK'), false, 'the public key is never echoed');
    assert.equal(body.includes(identity.publicKey), false, 'a real public key is never echoed');
    assert.equal(/PRIVATE KEY/.test(body), false);
    assert.equal(/sk-[A-Za-z0-9]{20,}/.test(body), false);
    assert.equal(/\/Users\//.test(body), false);
    assert.equal(/\/home\//.test(body), false);
    assert.equal(/[A-Za-z]:\\/.test(body), false);
    assert.equal(/\b192\.168\.\d+\.\d+\b/.test(body), false);
    assert.equal(/\b10\.\d+\.\d+\.\d+\b/.test(body), false);
  } finally {
    await runtime.api.close();
  }
});
