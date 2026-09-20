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
import { workerIdentityFixture } from '../environment/worker-identity-fixture.ts';
import type { WorkerIdentityProof } from '../environment/worker-proof.ts';
import { createRunApi } from './api.ts';
import { createEnvironmentRouter } from './environment-router.ts';

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
  const enrollments = new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness: new InMemoryEnvironmentReadinessStore(),
    leases: () => pool.leases(),
    ...(options.requiredEngines !== undefined ? { requiredEngines: options.requiredEngines } : {}),
    clock: () => 10_000,
    idFactory: () => 'enroll-1',
  });
  const api = createRunApi({
    orchestrator,
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    auth,
    routers: [createEnvironmentRouter({ enrollments })],
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
  return { api, base, cookie, csrf: csrfToken, enrollments };
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

test('a malformed probe body is refused and a valid probe is recorded append-only', async () => {
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
    const invalid = await command(runtime.base, '/api/environments/enrollments/enroll-1/probes', runtime, {
      at: 'not-a-number',
    });
    assert.equal(invalid.status, 400);

    const first = await command(runtime.base, '/api/environments/enrollments/enroll-1/probes', runtime, {
      at: 1_000,
      latencyMs: 10,
      protocolOk: true,
      enginesOk: true,
      summary: 'all ready',
    });
    assert.equal(first.status, 201);
    const second = await command(runtime.base, '/api/environments/enrollments/enroll-1/probes', runtime, {
      at: 2_000,
      latencyMs: 12,
      protocolOk: true,
      enginesOk: true,
      summary: 'touched /Users/example/private at 192.168.5.9',
    });
    assert.equal(second.status, 201);
    const secondBody = (await second.json()) as { readonly probe: { readonly summary: string } };
    assert.equal(/\/Users\//.test(secondBody.probe.summary), false, 'the probe response drops the absolute path');
    assert.equal(/192\.168/.test(secondBody.probe.summary), false, 'the probe response drops the private address');

    const readiness = await read(runtime.base, '/api/environments/enrollments/enroll-1/readiness', runtime);
    const body = (await readiness.json()) as {
      readonly probes: readonly { readonly at: number; readonly summary: string }[];
    };
    assert.deepEqual(body.probes.map((probe) => probe.at), [1_000, 2_000]);
    assert.equal(/\/Users\//.test(JSON.stringify(body.probes)), false, 'persisted probe history stays sanitized');
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
