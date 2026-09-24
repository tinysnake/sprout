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


test('an anonymous caller cannot reach any Environment enrollment route', async () => {
  const runtime = await enrollmentApi();
  try {
    assert.equal((await fetch(`${runtime.base}/api/environments/enrollments`)).status, 401);
    assert.equal(
      (await fetch(`${runtime.base}/api/environments/enrollments`, { method: 'POST' })).status,
      401,
    );
    // The proof challenge is authority-adjacent, so it must not be mintable
    // anonymously even though it grants nothing by itself.
    assert.equal(
      (
        await fetch(`${runtime.base}/api/environments/enrollments/enroll-1/challenge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
  } finally {
    await runtime.api.close();
  }
});


test('the enrollment lifecycle proves identity, then requires Human approval', async () => {
  const runtime = await enrollmentApi();
  try {
    const identity = workerIdentityFixture();
    const requested = await command(runtime.base, '/api/environments/enrollments', runtime, {
      environmentInstanceId: 'mac-mini-1',
      displayName: 'Local Mac',
      publicKey: identity.publicKey,
      platform: 'macos',
      protocolVersion: '2.1',
      capabilityRequests: ['agent-run'],
      engines: [{ engine: 'codex', installed: true, authenticated: true, models: ['gpt-5-codex'] }],
    });
    assert.equal(requested.status, 201);
    const requestedBody = (await requested.json()) as {
      readonly enrollment: { readonly status: string };
      readonly bootstrap: { readonly instructions: readonly string[] };
    };
    assert.equal(requestedBody.enrollment.status, 'pending');
    assert.ok(requestedBody.bootstrap.instructions.length > 0);
    assert.equal(JSON.stringify(requestedBody).includes(identity.publicKey), false, 'the public key is never echoed');

    // A bare public key with no proof is refused: presenting a key is not proof.
    const bare = await command(runtime.base, '/api/environments/enrollments/enroll-1/connect', runtime, {
      publicKey: identity.publicKey,
      connection: { state: 'online', lastConfirmedAt: 10_000 },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
    assert.equal(bare.status, 400, 'a connect without a proof is refused');

    // A signed challenge response is a verified proof and keeps it pending.
    const connect = await command(runtime.base, '/api/environments/enrollments/enroll-1/connect', runtime, {
      proof: await proveWorker(runtime, identity),
      connection: { state: 'online', lastConfirmedAt: 10_000 },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [
        { engine: 'codex', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['gpt-5-codex'] } },
      ],
    });
    assert.equal(connect.status, 200);
    assert.equal(((await connect.json()) as { outcome: string }).outcome, 'duplicate-same-key');

    // Human approval grants the requested capability.
    const approved = await command(runtime.base, '/api/environments/enrollments/enroll-1/approve', runtime, {
      capabilityPermissions: { 'agent-run': true },
    });
    assert.equal(approved.status, 200);
    assert.equal(
      ((await approved.json()) as { enrollment: { status: string } }).enrollment.status,
      'approved',
    );

    // Even a proof-bearing legacy browser connect request cannot impersonate
    // the Gateway's protocol negotiation and publish its refusal diagnostic.
    const browserSkew = await command(runtime.base, '/api/environments/enrollments/enroll-1/connect', runtime, {
      proof: await proveWorker(runtime, identity),
      connection: { state: 'reconnecting' },
      compatibility: { state: 'incompatible', workerProtocolVersion: '99' },
      engines: [],
      gatewayProtocolNegotiation: 'incompatible',
    });
    assert.equal(browserSkew.status, 200);
    assert.equal(((await browserSkew.json()) as { outcome: string }).outcome, 'reconnected');

    const readiness = await read(
      runtime.base,
      '/api/environments/enrollments/enroll-1/readiness',
      runtime,
    );
    assert.equal(readiness.status, 200);
    const readinessBody = (await readiness.json()) as {
      readonly readiness: { readonly summary: { readonly level: string; readonly reason: string } };
    };
    assert.equal(readinessBody.readiness.summary.reason.length > 0, true);
    assert.equal(['green', 'yellow', 'red'].includes(readinessBody.readiness.summary.level), true);
    assert.equal((readinessBody as { connectionAttempt?: unknown }).connectionAttempt, undefined);
  } finally {
    await runtime.api.close();
  }
});


test('a forged signature cannot reconnect, and a real one can', async () => {
  const runtime = await enrollmentApi();
  try {
    const identity = workerIdentityFixture();
    await command(runtime.base, '/api/environments/enrollments', runtime, {
      environmentInstanceId: 'mac-mini-1',
      displayName: 'Local Mac',
      publicKey: identity.publicKey,
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engines: [],
    });

    // The signature is over the wrong nonce, so it must be refused before any
    // identity is reconciled.
    const challengeResponse = await command(
      runtime.base,
      '/api/environments/enrollments/enroll-1/challenge',
      runtime,
      {},
    );
    const { challenge } = (await challengeResponse.json()) as {
      readonly challenge: { readonly id: string; readonly enrollmentId: string; readonly nonce: string };
    };
    const forged = identity.sign({ ...challenge, nonce: `${challenge.nonce}-tampered` });
    const refused = await command(runtime.base, '/api/environments/enrollments/enroll-1/connect', runtime, {
      proof: forged,
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
    assert.equal(refused.status, 401, 'an invalid signature is unauthorized');

    const accepted = await command(runtime.base, '/api/environments/enrollments/enroll-1/connect', runtime, {
      proof: await proveWorker(runtime, identity),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [],
    });
    assert.equal(accepted.status, 200);
  } finally {
    await runtime.api.close();
  }
});
