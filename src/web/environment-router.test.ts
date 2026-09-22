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
import { InMemoryEnrollmentStore } from '../environment/enrollment-store.ts';
import { InMemoryEnvironmentReadinessStore } from '../environment/readiness-store.ts';
import { EnvironmentRecoveryService } from '../environment/recovery-service.ts';
import { InMemoryRecoveryStore } from '../environment/recovery-store.ts';
import { EnvironmentArchiveService } from '../environment/archive.ts';
import { FORCE_RELEASE_CONFIRMATION } from '../environment/recovery.ts';
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
      requestProbe: async (enrollmentId) => enrollments.recordProbe(enrollmentId, {
        at: workerProbeAt++,
        latencyMs: 7,
        protocolOk: true,
        enginesOk: false,
        source: 'worker' as const,
        version: '0.154.0',
        summary: 'Worker non-inference readiness probe completed.',
      }),
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

test('a probe route ignores browser facts and returns only Worker-sourced observations', async () => {
  const runtime = await enrollmentApi();
  try {
    await command(runtime.base, '/api/environments/enrollments', runtime, {
      environmentInstanceId: 'mac-mini-1',
      displayName: 'Local Mac',
      publicKey: 'public-key-a',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engines: [],
    });
    const first = await command(runtime.base, '/api/environments/enrollments/enroll-1/probes', runtime, {
      at: 'forged',
      latencyMs: 0,
      protocolOk: false,
      enginesOk: true,
      summary: 'forged browser result',
    });
    assert.equal(first.status, 201);
    const second = await command(runtime.base, '/api/environments/enrollments/enroll-1/probes', runtime, {
      at: 999_999,
      latencyMs: 0,
      protocolOk: false,
      enginesOk: true,
      summary: 'forged local path and private network address',
    });
    assert.equal(second.status, 201);
    const secondBody = (await second.json()) as {
      readonly probe: { readonly summary: string; readonly latencyMs: number; readonly enginesOk: boolean };
    };
    assert.equal(secondBody.probe.latencyMs, 7, 'the browser latency was ignored');
    assert.equal(secondBody.probe.enginesOk, false, 'the browser engine result was ignored');
    assert.equal(secondBody.probe.summary, 'Worker non-inference readiness probe completed.');

    const readiness = await read(runtime.base, '/api/environments/enrollments/enroll-1/readiness', runtime);
    const body = (await readiness.json()) as {
      readonly probes: readonly { readonly at: number; readonly summary: string }[];
    };
    assert.deepEqual(body.probes.map((probe) => probe.at), [1_000, 1_001]);
  } finally {
    await runtime.api.close();
  }
});

test('an empty engine configuration does not fabricate a dual-engine requirement', async () => {
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
    await command(runtime.base, '/api/environments/enrollments/enroll-1/approve', runtime, {
      capabilityPermissions: { 'agent-run': true },
    });
    // The Worker declares only Codex; Pi is genuinely absent. With no explicit
    // requirement, the missing Pi must be Yellow (attention), never a fabricated
    // Red that claims the Environment is unusable.
    await command(runtime.base, '/api/environments/enrollments/enroll-1/connect', runtime, {
      proof: await proveWorker(runtime, identity),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [
        { engine: 'codex', installed: true, readiness: 'ready', required: false, models: { state: 'available', models: ['gpt-5-codex'] } },
      ],
    });
    const readiness = await read(runtime.base, '/api/environments/enrollments/enroll-1/readiness', runtime);
    const body = (await readiness.json()) as {
      readonly readiness: {
        readonly engines: readonly { readonly engine: string; readonly required: boolean }[];
        readonly summary: { readonly level: string; readonly reason: string };
      };
    };
    assert.deepEqual(
      body.readiness.engines.map((engine) => engine.engine),
      ['codex'],
      'only the engine the Worker declared is reported; no unconfigured engine is invented',
    );
    assert.equal(
      body.readiness.engines.every((engine) => engine.required === false),
      true,
      'nothing is required without an explicit configuration',
    );
    assert.notEqual(body.readiness.summary.level, 'red', body.readiness.summary.reason);
  } finally {
    await runtime.api.close();
  }
});

test('an explicitly required engine is Red when unavailable, and only that one', async () => {
  const runtime = await enrollmentApi({ requiredEngines: ['pi'] });
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
    await command(runtime.base, '/api/environments/enrollments/enroll-1/approve', runtime, {
      capabilityPermissions: { 'agent-run': true },
    });
    await command(runtime.base, '/api/environments/enrollments/enroll-1/connect', runtime, {
      proof: await proveWorker(runtime, identity),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [
        { engine: 'codex', installed: true, readiness: 'ready', required: false, models: { state: 'available', models: ['gpt-5-codex'] } },
      ],
    });
    const readiness = await read(runtime.base, '/api/environments/enrollments/enroll-1/readiness', runtime);
    const body = (await readiness.json()) as {
      readonly readiness: {
        readonly engines: readonly { readonly engine: string; readonly required: boolean }[];
        readonly summary: { readonly level: string; readonly reason: string };
      };
    };
    assert.equal(
      body.readiness.engines.find((engine) => engine.engine === 'pi')?.required,
      true,
      'the explicitly configured engine is required',
    );
    assert.equal(
      body.readiness.engines.find((engine) => engine.engine === 'codex')?.required,
      false,
      'an unconfigured engine is not required',
    );
    assert.equal(body.readiness.summary.level, 'red');
    assert.match(body.readiness.summary.reason, /pi/i);
  } finally {
    await runtime.api.close();
  }
});

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

test('a reconnect route re-authenticates the checks and only reaches reconciling over HTTP', async () => {
  const runtime = await recoveryApi();
  try {
    // An unverified identity is refused before the record moves at all.
    const unverified = await command(
      runtime.base,
      `/api/environments/recovery/${runtime.leaseId}/reconnect`,
      runtime,
      {
        enrollmentId: 'enroll-1',
        environmentInstanceId: 'mac-mini-1',
        identityVerified: false,
        protocolCompatible: true,
        permissionsAllowed: true,
        hadActiveRun: true,
      },
    );
    assert.equal(unverified.status, 409);
    assert.equal(((await unverified.json()) as { code: string }).code, 'identity-not-verified');

    const reconnect = await command(
      runtime.base,
      `/api/environments/recovery/${runtime.leaseId}/reconnect`,
      runtime,
      {
        enrollmentId: 'enroll-1',
        environmentInstanceId: 'mac-mini-1',
        identityVerified: true,
        protocolCompatible: true,
        permissionsAllowed: true,
        hadActiveRun: true,
      },
    );
    assert.equal(reconnect.status, 200);
    const body = (await reconnect.json()) as { recovery: { phase: string; unresolvedFacts: readonly string[] } };
    assert.equal(body.recovery.phase, 'reconciling');
    assert.ok(body.recovery.unresolvedFacts.length > 0, 'a reconnect alone resolves nothing');

    // An ordinary decision before synchronized evidence is refused with 409.
    const early = await command(runtime.base, `/api/environments/recovery/${runtime.leaseId}/discard`, runtime, {});
    assert.equal(early.status, 409);
    assert.equal(((await early.json()) as { code: string }).code, 'evidence-not-synchronized');
  } finally {
    await runtime.api.close();
  }
});

test('an incompatible protocol or denied permission keeps the Environment in recovery over HTTP', async () => {
  const runtime = await recoveryApi();
  try {
    const incompatible = await command(
      runtime.base,
      `/api/environments/recovery/${runtime.leaseId}/reconnect`,
      runtime,
      {
        enrollmentId: 'enroll-1',
        environmentInstanceId: 'mac-mini-1',
        identityVerified: true,
        protocolCompatible: false,
        permissionsAllowed: true,
        hadActiveRun: true,
      },
    );
    assert.equal(incompatible.status, 409);
    assert.equal(((await incompatible.json()) as { code: string }).code, 'protocol-incompatible');

    const denied = await command(
      runtime.base,
      `/api/environments/recovery/${runtime.leaseId}/reconnect`,
      runtime,
      {
        enrollmentId: 'enroll-1',
        environmentInstanceId: 'mac-mini-1',
        identityVerified: true,
        protocolCompatible: true,
        permissionsAllowed: false,
        hadActiveRun: true,
      },
    );
    assert.equal(denied.status, 409);
    assert.equal(((await denied.json()) as { code: string }).code, 'permissions-denied');
    assert.equal(runtime.pool.getLease(runtime.leaseId)?.state, 'recovering');
  } finally {
    await runtime.api.close();
  }
});

test('the recovery read route returns records and Force Release history, and validates Force Release without mutating', async () => {
  const runtime = await recoveryApi();
  try {
    const listing = await read(
      runtime.base,
      `/api/environments/enrollments/enroll-1/recovery`,
      runtime,
    );
    assert.equal(listing.status, 200);
    const listed = (await listing.json()) as {
      recovery: readonly { phase: string; leaseId: string }[];
      forceReleases: readonly unknown[];
    };
    assert.equal(listed.recovery.length, 1);
    assert.equal(listed.recovery[0]?.phase, 'recovery');
    assert.equal(listed.forceReleases.length, 0);

    // A Force Release with the wrong typed confirmation is refused and leaves
    // the record and the lease exactly as they were.
    const mismatched = await command(
      runtime.base,
      `/api/environments/recovery/${runtime.leaseId}/force-release`,
      runtime,
      { acknowledgedRisks: true, typedConfirmation: 'release it', reason: 'emergency drill' },
    );
    assert.equal(mismatched.status, 409);
    assert.equal(((await mismatched.json()) as { code: string }).code, 'typed-confirmation-mismatch');
    assert.equal(runtime.pool.getLease(runtime.leaseId)?.state, 'recovering');
    const stillListed = (await (
      await read(runtime.base, '/api/environments/enrollments/enroll-1/recovery', runtime)
    ).json()) as { forceReleases: readonly unknown[] };
    assert.equal(stillListed.forceReleases.length, 0);
  } finally {
    await runtime.api.close();
  }
});

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

test('a machine claim route is separate from the Human browser session', async () => {
  const runtime = await enrollmentApi();
  try {
    const requested = await command(runtime.base, '/api/environments/enrollments', runtime, {
      environmentInstanceId: 'mac-mini-1',
      displayName: 'Local Mac',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engines: [],
    });
    const body = (await requested.json()) as { readonly claim: { readonly secret: string } };
    // The Worker claims without any browser cookie or CSRF token.
    const claimed = await fetch(
      `${runtime.base}/api/worker/enrollments/enroll-1/claim`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimSecret: body.claim.secret }),
      },
    );
    assert.equal(claimed.status, 200);
    // A browser session cannot manufacture a Worker claim, and the machine route
    // does not set or accept a Human cookie.
    assert.equal(claimed.headers.get('set-cookie'), null);
    const replay = await fetch(`${runtime.base}/api/worker/enrollments/enroll-1/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimSecret: body.claim.secret }),
    });
    assert.equal(replay.status, 409);
  } finally {
    await runtime.api.close();
  }
});
