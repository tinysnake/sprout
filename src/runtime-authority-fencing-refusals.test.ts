import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import { EnvironmentArchiveService } from './environment/archive.ts';
import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';
import {
  agent,
  INSTANCE_ID,
  readinessWorkflowHarness,
  waitFor,
} from './runtime-test-harness.ts';

for (const backend of ['memory', 'sqlite'] as const) {
  test(`#125 ${backend}: authority substitution, forged capabilities, and caller callbacks are refused without mutation (Scenario 12)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-125-substitution-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const validProbe = {
        at: Date.now(), latencyMs: 6, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '0.154.0', summary: 'real probe',
      };
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            engines: [
              { engine: 'scripted', version: '1.0.0', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] },
            ],
            probe: validProbe,
          },
          probe: validProbe,
        }),
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');
      const liveAuth = h.runtime.workerGateway.authorizeObservation(INSTANCE_ID);
      assert.ok(liveAuth !== undefined, 'owner issues scoped capability for live connection');
      assert.equal(liveAuth.isCurrent(), true);

      // Attempt authority substitution and forged capabilities:
      // 1. Plain object literal imitating authority
      const forgedLiteral = {
        environmentInstanceId: INSTANCE_ID,
        enrollmentId,
        connectionId: liveAuth.connectionId,
        connectionEpoch: liveAuth.connectionEpoch,
        lifecycleGeneration: liveAuth.lifecycleGeneration,
        isCurrent: () => true,
      };
      // 2. Copied capability via object spread
      const spreadCopy = { ...liveAuth };
      // 3. Copied capability via Object.assign
      const assignedCopy = Object.assign({}, liveAuth);
      const observationResult = {
        readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe: validProbe },
        probe: validProbe,
      };

      for (const [label, forged] of [
        ['forged object literal', forgedLiteral],
        ['spread-copied capability', spreadCopy],
        ['Object.assign copied capability', assignedCopy],
      ] as const) {
        assert.equal(
          await h.runtime.enrollments.observeReadiness(enrollmentId, observationResult, forged as never),
          false,
          `${label} must be refused by observeReadiness`,
        );
      }

      // Scope substitution: using authentic authority for another enrollment/instance
      assert.equal(
        await h.runtime.enrollments.observeReadiness('other-enrollment', observationResult, liveAuth),
        false,
        'scope substitution across enrollments must fail',
      );

      // Verify no mutation occurred
      assert.equal(await h.runtime.stores.environmentReadiness.getReadiness(INSTANCE_ID), undefined);
      assert.deepEqual(await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID), []);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
    } finally {
      await h.close();
    }
  });

  test(`#125 ${backend}: post-commit-before-response loss preserves history while refusing current probe success and replacement does not inherit (Scenarios 4, 11)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-125-postcommit-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const validProbe = {
        at: Date.now(), latencyMs: 6, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '0.154.0', summary: 'post-commit probe',
      };
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            engines: [
              { engine: 'scripted', version: '1.0.0', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] },
            ],
            probe: validProbe,
          },
          probe: validProbe,
        }),
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');

      // Intercept store commit: capture when commit succeeds, hold before returning to caller,
      // and disconnect the worker in that window.
      const store = h.runtime.stores.environmentReadiness;
      const origCommit = store.commitObservation.bind(store);
      let committedSignal: (() => void) | undefined;
      const committedPromise = new Promise<void>((resolve) => { committedSignal = resolve; });
      let continueReturn: (() => void) | undefined;
      const returnGate = new Promise<void>((resolve) => { continueReturn = resolve; });

      store.commitObservation = async (...args) => {
        const result = await origCommit(...args);
        committedSignal?.();
        await returnGate;
        return result;
      };

      const pendingRequest = fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });

      await committedPromise;
      // Close the channel (disconnect) after atomic commit but before response completion
      h.runtime.workerGateway.liveFor(INSTANCE_ID)!.close();
      continueReturn?.();

      const response = await pendingRequest;
      // Refuses current probe success!
      assert.notEqual(response.status, 201, 'post-commit authority loss must refuse current probe success');

      // But history is preserved: the atomic commit succeeded while live
      const probes = await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID);
      assert.equal(probes.length, 1, 'observation is preserved as durable history');
      assert.equal(probes[0]?.summary, 'post-commit probe');

      // Current query reports offline and no current probe facts
      const currentReadiness = await h.runtime.enrollments.readiness(enrollmentId);
      assert.notEqual(currentReadiness.readiness.connection.state, 'online');
      assert.equal(currentReadiness.readiness.probe, undefined);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);

      // Replacement connection connects (epoch 2) using the same approved host key
      const keyPath = join(directory, 'worker-key.pem');
      await h.connect(enrollmentId, keyPath, {
        readiness: () => ({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          engines: [],
          probe: { at: Date.now(), latencyMs: 5, protocolOk: true, enginesOk: false, source: 'worker', version: '2.0.0', summary: 'worker 2' },
        }),
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'replacement channel');
      await h.runtime.refreshEnvironmentCatalog();

      // Replacement connection cannot inherit current authority from predecessor
      const afterReplacement = await h.runtime.enrollments.readiness(enrollmentId);
      assert.equal(afterReplacement.readiness.probe?.summary, undefined, 'replacement cannot inherit predecessor probe as current');
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false, 'replacement is not eligible from old facts');
    } finally {
      await h.close();
    }
  });

  test(`#125 ${backend}: pending and archived sessions cannot authorize observations or change identity (Scenarios 4, 12)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-125-pending-archive-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      // 1. Pending enrollment
      const requestedPending = await h.runtime.enrollments.requestEnrollment({
        environmentInstanceId: 'env-pending-test',
        displayName: 'Pending Test',
        publicKey: 'pending-key',
        platform: 'macos',
        capabilityRequests: [ADMISSION_CAPABILITY],
        engineFacts: [],
      });
      const pendingId = requestedPending.enrollment.id;

      // Pending session has no owner authority
      assert.equal(
        h.runtime.workerGateway.authorizeObservation('env-pending-test'),
        undefined,
        'pending instance cannot obtain observation authority',
      );

      // Attempting probe on pending enrollment fails
      const probePendingRes = await fetch(`${h.base}/api/environments/enrollments/${pendingId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.notEqual(probePendingRes.status, 201);

      // Pending identity is unchanged
      const pendingEnrollment = await h.runtime.enrollments.get(pendingId);
      assert.equal(pendingEnrollment?.status, 'pending');
      assert.equal(await h.runtime.stores.environmentReadiness.getReadiness('env-pending-test'), undefined);
      assert.deepEqual(await h.runtime.stores.environmentReadiness.listProbes('env-pending-test'), []);

      // 2. Archived enrollment
      const approvedId = (await h.runtime.enrollments.list())[0]!.id;
      const validProbe = {
        at: Date.now(), latencyMs: 5, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '1.0.0', summary: 'pre-archive probe',
      };
      await h.connect(approvedId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe: validProbe },
          probe: validProbe,
        }),
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');

      // Archive the environment
      const archiveService = new EnvironmentArchiveService({
        enrollments: h.runtime.stores.enrollments,
        leases: h.runtime.pool,
        lifecycleAuthority: h.runtime.enrollments.lifecycleAuthority,
        onAuthorityLost: (id) => h.runtime.workerGateway.invalidateEnrollment(id),
      });
      await archiveService.archive(approvedId, 'operator archiving');

      // Live authority lost immediately
      assert.equal(h.runtime.workerGateway.authorizeObservation(INSTANCE_ID), undefined);
      assert.equal(h.runtime.workerGateway.liveFor(INSTANCE_ID), undefined);

      // Probe request on archived enrollment fails
      const probeArchivedRes = await fetch(`${h.base}/api/environments/enrollments/${approvedId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.notEqual(probeArchivedRes.status, 201);

      // Archived identity is preserved
      const archivedEnrollment = await h.runtime.enrollments.get(approvedId);
      assert.equal(archivedEnrollment?.status, 'archived');
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
    } finally {
      await h.close();
    }
  });
}
