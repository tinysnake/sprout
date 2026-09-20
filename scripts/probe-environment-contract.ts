/**
 * Independent HTTP contract probe for the Environment enrollment router (#87).
 *
 * `node scripts/probe-environment-contract.ts`
 *
 * This drives the *real* composed HTTP transport (`createRunApi`) behind the #84
 * auth boundary and asserts the observable contract a browser depends on:
 * authorization, status classes, additive-router composition, the worker-proof
 * and approval lifecycle, and the independence of the readiness facts.
 *
 * It is intentionally separate from the test suite so a green suite cannot make
 * it pass by construction. Output is sanitized; nothing host-identifying prints.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EnvironmentDefinition, EnvironmentInstance } from '../src/environment/model.ts';
import { EnvironmentPool } from '../src/environment/pool.ts';
import { ScriptedEngineAdapter } from '../src/engine/scripted.ts';
import { AgentRegistry } from '../src/agent/registry.ts';
import { ProjectRegistry } from '../src/project/registry.ts';
import { InMemoryRunStore } from '../src/run/store.ts';
import { RunOrchestrator } from '../src/run/orchestrator.ts';
import { OperatorSessionService } from '../src/auth/service.ts';
import { InMemoryOperatorSessionStore } from '../src/auth/store.ts';
import { EnvironmentEnrollmentService } from '../src/environment/enrollment-service.ts';
import { SqliteEnrollmentStore } from '../src/environment/sqlite-enrollment-store.ts';
import { SqliteEnvironmentReadinessStore } from '../src/environment/sqlite-readiness-store.ts';
import { createRunApi } from '../src/web/api.ts';
import { createEnvironmentRouter } from '../src/web/environment-router.ts';

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  process.stdout.write(`${status} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'probe-instance', definitionId: 'macos-workstation' };

const directory = mkdtempSync(join(tmpdir(), 'sprout-enrollment-contract-'));
try {
  const agents = new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
  ]);
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
    agents,
    projects: new ProjectRegistry([
      {
        id: 'probe-project',
        goal: 'Probe',
        rules: [],
        availableEnvironmentInstanceIds: [instance.id],
        memberships: [{ agentId: 'agent-scout', responsibilities: [], collaborationInstructions: '' }],
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
    enrollments: new SqliteEnrollmentStore({ filename: join(directory, 'sprout.db') }),
    readiness: new SqliteEnvironmentReadinessStore({ filename: join(directory, 'sprout.db') }),
    clock: () => 1_000,
    idFactory: () => 'enroll-probe',
  });
  const api = createRunApi({
    orchestrator,
    agents,
    auth,
    routers: [createEnvironmentRouter({ enrollments })],
  });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const unauthorized = await fetch(`${base}/api/environments/enrollments`);
  check('the enrollment route requires the operator session', unauthorized.status === 401, `status ${unauthorized.status}`);

  const signIn = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  const { csrfToken } = (await signIn.json()) as { csrfToken: string };
  const session = { cookie, 'x-sprout-csrf': csrfToken, 'content-type': 'application/json' };

  const missingCsrf = await fetch(`${base}/api/environments/enrollments`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('a mutating enrollment command requires request-forgery proof', missingCsrf.status === 403, `status ${missingCsrf.status}`);

  const requested = await fetch(`${base}/api/environments/enrollments`, {
    method: 'POST',
    headers: session,
    body: JSON.stringify({
      environmentInstanceId: instance.id,
      displayName: 'Probe Environment',
      publicKey: 'probe-public-key',
      platform: 'macos',
      protocolVersion: '2.1',
      capabilityRequests: ['agent-run'],
      engines: [{ engine: 'codex', installed: true, authenticated: true, models: [] }],
    }),
  });
  check('requesting an enrollment returns 201', requested.status === 201, `status ${requested.status}`);
  const requestedBody = (await requested.json()) as { readonly bootstrap?: { readonly instructions?: readonly string[] } };
  check('the response carries host bootstrap guidance', (requestedBody.bootstrap?.instructions?.length ?? 0) > 0);
  check('the response does not echo the public key', JSON.stringify(requestedBody).includes('probe-public-key') === false);

  const approved = await fetch(`${base}/api/environments/enrollments/enroll-probe/approve`, {
    method: 'POST',
    headers: session,
    body: JSON.stringify({ capabilityPermissions: { 'agent-run': true } }),
  });
  check('Human approval returns 200', approved.status === 200, `status ${approved.status}`);

  await fetch(`${base}/api/environments/enrollments/enroll-probe/connect`, {
    method: 'POST',
    headers: session,
    body: JSON.stringify({
      publicKey: 'probe-public-key',
      connection: { state: 'online', lastConfirmedAt: 1_000 },
      compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
      engines: [
        { engine: 'codex', installed: true, readiness: 'login-required', required: true, models: { state: 'unknown', models: [] } },
        { engine: 'pi', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['pi-probe'] } },
      ],
    }),
  });

  const readinessResponse = await fetch(`${base}/api/environments/enrollments/enroll-probe/readiness`, {
    headers: { cookie },
  });
  const body = (await readinessResponse.json()) as {
    readonly readiness: {
      readonly enrollmentStatus: string;
      readonly connection: { readonly state: string };
      readonly workSafety: { readonly state: string };
      readonly engines: readonly { readonly engine: string; readonly readiness: string }[];
      readonly summary: { readonly level: string; readonly reason: string };
    };
  };
  check('readiness returns 200 through the additive router', readinessResponse.status === 200, `status ${readinessResponse.status}`);
  check('allowed engine login does not change enrollment', body.readiness.enrollmentStatus === 'approved');
  check('connection remains an independent fact', body.readiness.connection.state === 'online');
  check('work safety remains an independent fact', body.readiness.workSafety.state === 'clear');
  check('the required engine login is visible', body.readiness.engines.find((e) => e.engine === 'codex')?.readiness === 'login-required');
  check('the summary is Yellow', body.readiness.summary.level === 'yellow');
  check('the summary carries the decisive reason', body.readiness.summary.reason.length > 0);

  const unknown = await fetch(`${base}/api/environments/enrollments/none/readiness`, { headers: { cookie } });
  check('an unknown enrollment is a sanitized 404', unknown.status === 404, `status ${unknown.status}`);

  // The preserved M1 route still composes after the additive domain router.
  const runs = await fetch(`${base}/api/runs`, { headers: { cookie } });
  check('the preserved M1 run route still answers', runs.status === 200, `status ${runs.status}`);

  const serialized = JSON.stringify(body);
  check('the readiness payload carries no public key', serialized.includes('probe-public-key') === false);
  check('the readiness payload carries no home path', /\/Users\/|\/home\/|[A-Za-z]:\\/.test(serialized) === false);
  check('the readiness payload carries no private address', /\b(10|192\.168)\.\d+\.\d+\.\d+\b/.test(serialized) === false);

  await api.close();

  process.stdout.write(
    failures === 0
      ? '\nPROBE RESULT: PASS — the enrollment HTTP contract is authorized, additive, and privacy-safe.\n'
      : `\nPROBE RESULT: FAIL — ${failures} check(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
