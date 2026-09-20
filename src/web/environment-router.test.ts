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
import { createRunApi } from './api.ts';
import { createEnvironmentRouter } from './environment-router.ts';

/**
 * HTTP contract, privacy, and restart-independent behaviour for the Environment
 * enrollment and readiness routes (#87).
 *
 * The routes are exercised through the real HTTP transport after the #84 auth
 * boundary, so the tests prove what a browser actually receives — including that
 * no private material can be observed — rather than calling the router directly.
 */

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

async function enrollmentApi() {
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

test('an anonymous caller cannot reach any Environment enrollment route', async () => {
  const runtime = await enrollmentApi();
  try {
    assert.equal((await fetch(`${runtime.base}/api/environments/enrollments`)).status, 401);
    assert.equal(
      (await fetch(`${runtime.base}/api/environments/enrollments`, { method: 'POST' })).status,
      401,
    );
  } finally {
    await runtime.api.close();
  }
});

test('the enrollment lifecycle is observable end-to-end over HTTP', async () => {
  const runtime = await enrollmentApi();
  try {
    const requested = await command(runtime.base, '/api/environments/enrollments', runtime, {
      environmentInstanceId: 'mac-mini-1',
      displayName: 'Local Mac',
      publicKey: 'public-key-a',
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

    // A Worker proof of the same key keeps it pending but records the attempt.
    const connect = await command(runtime.base, '/api/environments/enrollments/enroll-1/connect', runtime, {
      publicKey: 'public-key-a',
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

test('revocation, reset, and duplicate-identity outcomes are exposed and refuse a new key', async () => {
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
    await command(runtime.base, '/api/environments/enrollments/enroll-1/approve', runtime, {
      capabilityPermissions: { 'agent-run': true },
    });

    const duplicate = await command(
      runtime.base,
      '/api/environments/enrollments/enroll-1/connect',
      runtime,
      {
        publicKey: 'public-key-b',
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
      reason: '',
    });
    assert.equal(revoked.status, 200);
    assert.equal(
      ((await revoked.json()) as { enrollment: { status: string } }).enrollment.status,
      'revoked',
    );

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
    assert.equal(
      ((await reset.json()) as { enrollment: { status: string } }).enrollment.status,
      'pending',
    );
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
    const response = await read(runtime.base, '/api/environments/enrollments/enroll-1/readiness', runtime);
    const body = await response.text();

    assert.equal(body.includes('PUBLIC_KEY_MATERIAL_MUST_NOT_LEAK'), false, 'the public key is never echoed');
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
      summary: 'all ready again',
    });
    assert.equal(second.status, 201);

    const readiness = await read(runtime.base, '/api/environments/enrollments/enroll-1/readiness', runtime);
    const body = (await readiness.json()) as { readonly probes: readonly { readonly at: number }[] };
    assert.deepEqual(body.probes.map((probe) => probe.at), [1_000, 2_000]);
  } finally {
    await runtime.api.close();
  }
});
