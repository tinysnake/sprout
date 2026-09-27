/**
 * Verification script for Ticket #159:
 * Web-created enrollments carry default capabilityRequests (['agent-run']),
 * support Human request amendment before approval, and reach catalog eligibility.
 *
 * Runs against an ephemeral HTTP server and real SQLite store.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

import { createRunApi } from '../src/web/api.ts';
import { createEnvironmentRouter } from '../src/web/environment-router.ts';
import { RunOrchestrator } from '../src/run/orchestrator.ts';
import { ScriptedEngineAdapter } from '../src/engine/scripted.ts';
import { AgentRegistry } from '../src/agent/registry.ts';
import { ProjectRegistry } from '../src/project/registry.ts';
import { InMemoryRunStore } from '../src/run/store.ts';
import { EnvironmentEnrollmentService } from '../src/environment/enrollment-service.ts';
import { SqliteEnrollmentStore } from '../src/environment/sqlite-enrollment-store.ts';
import { SqliteEnvironmentReadinessStore } from '../src/environment/sqlite-readiness-store.ts';
import { EnvironmentPool } from '../src/environment/pool.ts';
import { OperatorSessionService } from '../src/auth/service.ts';
import { SqliteOperatorSessionStore } from '../src/auth/sqlite-store.ts';
import { EnvironmentRecoveryService } from '../src/environment/recovery-service.ts';
import { InMemoryRecoveryStore } from '../src/environment/recovery-store.ts';
import { EnvironmentArchiveService } from '../src/environment/archive.ts';
import { workerIdentityFixture } from '../src/environment/worker-identity-fixture.ts';
import { projectCatalogEntry, admissionRefusal, ADMISSION_CAPABILITY } from '../src/environment/catalog.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../src/environment/model.ts';
import { createReadinessAuthorityTestSeam } from '../src/environment/readiness-authority.test-support.ts';

const readinessAuthorityTestSeam = createReadinessAuthorityTestSeam();

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};

const instance: EnvironmentInstance = {
  id: 'web-host-1',
  definitionId: 'macos-workstation',
};

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-verify-159-'));
  const dbPath = join(dir, 'sprout.db');
  let failures = 0;
  const check = (desc: string, ok: boolean, detail = '') => {
    if (ok) {
      console.log(`[local-synthetic] PASS: ${desc}`);
    } else {
      failures += 1;
      console.error(`[local-synthetic] FAIL: ${desc}${detail ? ` (${detail})` : ''}`);
    }
  };

  const db = new DatabaseSync(dbPath);
  const enrollmentsStore = new SqliteEnrollmentStore({ db });
  const readinessStore = new SqliteEnvironmentReadinessStore({ db });
  const sessionStore = new SqliteOperatorSessionStore({ db });
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });

  let epoch = 1;
  const enrollments = new EnvironmentEnrollmentService({
    enrollments: enrollmentsStore,
    readiness: readinessStore,
    currentConnectionEpoch: () => epoch,
    verifyObservationAuthority: readinessAuthorityTestSeam.verify,
    leases: () => pool.leases(),
    clock: () => Date.now(),
    idFactory: () => 'enroll-web-1',
  });

  const recovery = new EnvironmentRecoveryService({
    store: new InMemoryRecoveryStore(),
    leases: pool,
    clock: () => Date.now(),
  });

  const archive = new EnvironmentArchiveService({
    enrollments: enrollmentsStore,
    leases: { leases: () => pool.leases() },
    clock: () => Date.now(),
  });

  const auth = new OperatorSessionService({ store: sessionStore });
  const credential = randomBytes(32).toString('base64url');
  await auth.initializeOrRecover(credential);
  const session = await auth.signIn(credential);
  assert.ok(session);
  const cookie = `sprout_session=${session.bearerToken}`;
  const csrf = session.csrfToken;

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
        availableEnvironmentInstanceIds: ['web-host-1'],
        memberships: [
          { agentId: 'agent-scout', responsibilities: [], collaborationInstructions: '' },
        ],
      },
    ]),
    pool,
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });

  const api = createRunApi({
    orchestrator,
    agents: new AgentRegistry([]),
    auth,
    routers: [
      createEnvironmentRouter({
        enrollments,
        recovery,
        archive,
        requestProbe: async () => ({
          at: Date.now(),
          latencyMs: 15,
          protocolOk: true,
          enginesOk: true,
          source: 'worker' as const,
          version: '2.1',
          summary: 'Probe OK',
        }),
      }),
    ],
  });

  const { port } = await api.listen(0, '127.0.0.1');

  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Web Creation: Client posts to /api/environments/enrollments WITHOUT capabilityRequests
    const createRes = await fetch(`${base}/api/environments/enrollments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-sprout-csrf': csrf,
      },
      body: JSON.stringify({
        environmentInstanceId: 'web-host-1',
        displayName: 'Web Enrolled Host',
        platform: 'macos',
      }),
    });
    check('POST /api/environments/enrollments returns 201', createRes.status === 201);
    const createData = (await createRes.json()) as any;
    const created = createData.enrollment;
    check('Web enrollment defaults capabilityRequests to [agent-run]',
      Array.isArray(created.capabilityRequests) &&
      created.capabilityRequests.length === 1 &&
      created.capabilityRequests[0] === 'agent-run'
    );
    check('Created enrollment has agent-run denied (false) initially',
      created.capabilityPermissions['agent-run'] === false
    );
    check('Created enrollment includes one-use claim secret',
      typeof createData.claim?.secret === 'string' && createData.claim.secret.length > 0
    );

    // 2. Human Authority Route: Amend capability requests before approval
    const amendRes = await fetch(`${base}/api/environments/enrollments/${created.id}/capability-requests`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-sprout-csrf': csrf,
      },
      body: JSON.stringify({
        capabilityRequests: ['agent-run', 'file-inspection'],
        reason: 'Operator amended capability requests before approval',
      }),
    });
    check('POST /api/environments/enrollments/:id/capability-requests returns 200', amendRes.status === 200);
    const amendData = (await amendRes.json()) as any;
    const amended = amendData.enrollment;
    check('Amended capabilityRequests contains [agent-run, file-inspection]',
      JSON.stringify(amended.capabilityRequests) === JSON.stringify(['agent-run', 'file-inspection'])
    );
    check('Newly added capability starts denied (no auto-grant)',
      amended.capabilityPermissions['file-inspection'] === false &&
      amended.capabilityPermissions['agent-run'] === false
    );
    const lastDecision = amended.decisions.at(-1);
    check('Request amendment is a recorded authority decision (not silent mutation)',
      lastDecision?.kind === 'capability-requests-amended' &&
      lastDecision?.actor === 'operator' &&
      lastDecision?.reason.includes('amended')
    );

    // 3. Worker claims enrollment with secret and connects
    await enrollments.claimEnrollment(created.id, createData.claim.secret);
    const workerIdentity = workerIdentityFixture();

    const challengeRes = await fetch(`${base}/api/environments/enrollments/${created.id}/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-sprout-csrf': csrf },
      body: JSON.stringify({}),
    });
    const { challenge } = (await challengeRes.json()) as any;
    const proof = workerIdentity.sign(challenge);

    const connectRes = await fetch(`${base}/api/environments/enrollments/${created.id}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-sprout-csrf': csrf },
      body: JSON.stringify({
        proof,
        connection: { state: 'online' },
        compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
        engines: [
          { engine: 'codex', readiness: 'ready', installed: true, models: { state: 'available', models: ['gpt-5-codex'] } },
        ],
      }),
    });
    check('Worker connect returns 200 identity-claimed', connectRes.status === 200);

    // 5. Human Approval: approve only agent-run (explicit selection)
    const approveRes = await fetch(`${base}/api/environments/enrollments/${created.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-sprout-csrf': csrf },
      body: JSON.stringify({
        capabilityPermissions: { 'agent-run': true, 'file-inspection': false },
      }),
    });
    check('POST /api/environments/enrollments/:id/approve returns 200', approveRes.status === 200);
    const approvedData = (await approveRes.json()) as any;
    check('Approved enrollment has agent-run granted (true)',
      approvedData.enrollment.capabilityPermissions['agent-run'] === true
    );
    check('Approved enrollment keeps file-inspection denied (false)',
      approvedData.enrollment.capabilityPermissions['file-inspection'] === false
    );

    // Record authoritative readiness observation on the approved enrollment
    const approvedRecord = (await enrollments.get(created.id))!;
    const authority = readinessAuthorityTestSeam.mint({
      environmentInstanceId: created.environmentInstanceId,
      enrollmentId: created.id,
      connectionEpoch: epoch,
    });
    const attempt = await enrollments.issueReadinessAttempt(created.id, authority);
    assert.ok(attempt);
    const probe = {
      at: Date.now(),
      latencyMs: 10,
      protocolOk: true,
      enginesOk: true,
      source: 'worker' as const,
      version: '2.1',
      summary: 'OK',
    };
    const result = {
      attemptId: attempt.observationId,
      readiness: {
        protocolVersion: '2.1',
        observedAt: Date.now(),
        engines: [
          {
            engine: 'codex',
            installed: true,
            readiness: 'ready',
            modelAvailability: 'available',
            models: ['gpt-5-codex'],
          },
        ],
        probe,
      },
      probe,
    };
    const observationRecorded = await enrollments.recordReadinessObservation(
      created.id,
      result,
      authority,
      { attempt },
    );
    check('Authoritative readiness observation recorded', observationRecorded !== undefined);

    // 6. After approval: Verify catalog eligibility gate
    const currentObs = await readinessStore.getCurrentObservation(created.environmentInstanceId);
    const observed = currentObs ? currentObs.readiness : undefined;
    const approvedEntry = projectCatalogEntry({
      enrollment: approvedRecord,
      currentEpoch: epoch,
      observed,
      workSafety: 'clear',
      requiredEngines: ['codex'],
      supportedProtocol: { minMajor: 2, maxMajor: 3 },
      now: Date.now(),
    });
    check('Approved Web-created enrollment reaches catalog eligibility (eligible: true)',
      approvedEntry.eligible === true
    );
    check('Catalog permission gate satisfied for ADMISSION_CAPABILITY',
      approvedRecord.capabilityPermissions[ADMISSION_CAPABILITY] === true
    );
    const refusal = admissionRefusal(approvedEntry);
    check('Catalog entry admission refusal is ok: true',
      refusal.ok === true
    );

    // 7. Negative test: If Human approves but denies agent-run, catalog refuses
    const unapprovedCapEntry = projectCatalogEntry({
      enrollment: {
        ...approvedRecord,
        capabilityPermissions: { 'agent-run': false, 'file-inspection': true },
      },
      currentEpoch: epoch,
      observed,
      workSafety: 'clear',
      requiredEngines: ['codex'],
      supportedProtocol: { minMajor: 2, maxMajor: 3 },
      now: Date.now(),
    });
    check('Catalog refuses when agent-run is not explicitly approved', unapprovedCapEntry.eligible === false);
    const unapprovedRefusal = admissionRefusal(unapprovedCapEntry);
    check('Refusal reason is permission-incomplete',
      unapprovedRefusal.ok === false && unapprovedRefusal.reason === 'permission-incomplete'
    );

  } finally {
    await api.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`[local-synthetic] Verification completed with ${failures} failure(s).`);
    process.exit(1);
  } else {
    console.log('[local-synthetic] Verification completed successfully: all checks PASSED.');
  }
}

main().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
