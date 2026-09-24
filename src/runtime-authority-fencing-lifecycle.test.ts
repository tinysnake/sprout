import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';
import {
  agent,
  INSTANCE_ID,
  readinessWorkflowHarness,
  waitFor,
} from './runtime-test-harness.ts';

for (const backend of ['memory', 'sqlite'] as const) {
  test(`#125 ${backend}: reset raced before mutation leaves no observation mutation (Scenario 4)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-125-reset-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started: (() => void) | undefined;
      const startedProbe = new Promise<void>((resolve) => { started = resolve; });

      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => {
          started?.();
          await gate;
          const probe = {
            at: Date.now(), latencyMs: 7, protocolOk: true, enginesOk: true,
            source: 'worker' as const, version: '0.154.0', summary: 'reset probe',
          };
          return {
            readiness: {
              protocolVersion: WORKER_PROTOCOL_VERSION,
              engines: [],
              probe,
            },
            probe,
          };
        },
      });
      await startedProbe;
      const pending = fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      // Reset lands before mutation while probe collection is in flight
      await h.runtime.enrollments.reset(enrollmentId, 'reset mid-collection');
      release?.();
      const response = await pending;
      assert.notEqual(response.status, 201);
      assert.equal(await h.runtime.stores.environmentReadiness.getReadiness(INSTANCE_ID), undefined);
      assert.deepEqual(await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID), []);
    } finally {
      await h.close();
    }
  });

  test(`#125 ${backend}: accepted Worker permission loss fences collection, mutation, current query, and response completion`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-125-permission-races-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const headers = (h: { readonly cookie: string; readonly csrf: string }) => ({
      cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json',
    });
    const result = (summary: string) => {
      const probe = { at: Date.now(), latencyMs: 5, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '2.0.0', summary };
      return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe }, probe };
    };

    mkdirSync(join(directory, 'mutation'));
    mkdirSync(join(directory, 'response'));

    // Collection: the real Worker JSON-RPC response is held before canonical
    // validation; permission loss means no observation can reach storage.
    {
      const h = await readinessWorkflowHarness({ backend, directory });
      try {
        const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let started!: () => void;
        const startedProbe = new Promise<void>((resolve) => { started = resolve; });
        await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
          readinessProbe: async () => { started(); await gate; return result('permission collection'); },
        });
        await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'collection accepted Worker');
        const pending = fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
          method: 'POST', headers: headers(h), body: '{}',
        });
        await startedProbe;
        await h.runtime.enrollments.setCapabilityPermission(enrollmentId, ADMISSION_CAPABILITY, false);
        release();
        assert.notEqual((await pending).status, 201);
        assert.equal(await h.runtime.stores.environmentReadiness.getReadiness(INSTANCE_ID), undefined);
        assert.deepEqual(await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID), []);
      } finally { await h.close(); }
    }

    // Mutation: hold the storage adapter immediately before its atomic commit.
    {
      const h = await readinessWorkflowHarness({ backend, directory: join(directory, 'mutation') });
      try {
        const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
        await h.connect(enrollmentId, join(directory, 'mutation', 'worker-key.pem'), {
          readinessProbe: async () => result('permission mutation'),
        });
        await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'mutation accepted Worker');
        const store = h.runtime.stores.environmentReadiness;
        const original = store.commitObservation.bind(store);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const enteredCommit = new Promise<void>((resolve) => { entered = resolve; });
        store.commitObservation = async (...args) => { entered(); await gate; return original(...args); };
        const pending = fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
          method: 'POST', headers: headers(h), body: '{}',
        });
        await enteredCommit;
        await h.runtime.enrollments.setCapabilityPermission(enrollmentId, ADMISSION_CAPABILITY, false);
        release();
        assert.notEqual((await pending).status, 201);
        assert.equal(await store.getReadiness(INSTANCE_ID), undefined, 'authority loss before commit mutates nothing');
        assert.deepEqual(await store.listProbes(INSTANCE_ID), []);
      } finally { await h.close(); }
    }

    // Response/current-query: a valid atomic commit stays historical, but
    // permission loss before response completion refuses success and GET cannot
    // project the old probe as current.
    {
      const h = await readinessWorkflowHarness({ backend, directory: join(directory, 'response') });
      try {
        const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
        await h.connect(enrollmentId, join(directory, 'response', 'worker-key.pem'), {
          readinessProbe: async () => result('permission response'),
        });
        await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'response accepted Worker');
        const store = h.runtime.stores.environmentReadiness;
        const original = store.commitObservation.bind(store);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let committed!: () => void;
        const committedCommit = new Promise<void>((resolve) => { committed = resolve; });
        store.commitObservation = async (...args) => {
          const saved = await original(...args); committed(); await gate; return saved;
        };
        const pending = fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
          method: 'POST', headers: headers(h), body: '{}',
        });
        await committedCommit;
        await h.runtime.enrollments.setCapabilityPermission(enrollmentId, ADMISSION_CAPABILITY, false);
        release();
        assert.notEqual((await pending).status, 201, 'post-commit authority loss refuses current success');
        assert.equal((await store.listProbes(INSTANCE_ID)).length, 1, 'the valid commit remains history');
        const current = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}`, { headers: { cookie: h.cookie } });
        assert.equal(current.status, 200);
        const body = await current.json() as { readiness?: { probe?: unknown } };
        assert.equal(body.readiness?.probe, undefined, 'HTTP current query suppresses the invalidated probe');
      } finally { await h.close(); }
    }
  });

  test(`#125 ${backend}: Scenario 5 keeps accepted WorkerGateway authority fenced during a pre-epoch permission CAS race`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-125-cas-race-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      // Establish the real approval -> Gateway -> authenticated JSON-RPC
      // authority before racing a replacement handshake's pre-epoch durable CAS.
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => {
          const probe = { at: Date.now(), latencyMs: 4, protocolOk: true, enginesOk: true,
            source: 'worker' as const, version: '2.0.0', summary: 'accepted Worker evidence' };
          return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe }, probe };
        },
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'initial accepted WorkerGateway authority');

      const store = h.runtime.stores.enrollments;
      const originalSave = store.saveIfRevision.bind(store);
      let capturedRevision = 0;
      let permissionCompleted = false;
      store.saveIfRevision = async (enrollment, expectedRevision) => {
        if (!permissionCompleted && enrollment.id === enrollmentId && enrollment.status === 'approved') {
          capturedRevision = expectedRevision;
          // Mark before the nested CAS: permission loss itself also saves an
          // enrollment revision and must not re-enter this interception.
          permissionCompleted = true;
          // This invocation is reached by the replacement's authenticated
          // Gateway handshake, before it receives an epoch.
          await h.runtime.enrollments.setCapabilityPermission(enrollmentId, ADMISSION_CAPABILITY, false);
        }
        return originalSave(enrollment, expectedRevision);
      };

      // The replacement also crosses the real connector/Gateway handshake. It
      // is refused after the permission transition; the connector's rejection
      // is the expected machine-boundary result, not a substitute for the CAS
      // assertions below.
      await h.connect(enrollmentId, join(directory, 'worker-key.pem')).catch(() => undefined);
      assert.equal(permissionCompleted, true, 'the replacement reached the pre-epoch reconciliation CAS');
      const finalEnrollment = await h.runtime.enrollments.get(enrollmentId);
      assert.equal(finalEnrollment?.capabilityPermissions[ADMISSION_CAPABILITY], false);
      assert.ok(finalEnrollment?.revision !== undefined && finalEnrollment.revision > capturedRevision);
      assert.equal(h.runtime.workerGateway.liveFor(INSTANCE_ID), undefined, 'permission loss fences the accepted authority');

      const response = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}`, {
        headers: { cookie: h.cookie },
      });
      assert.equal(response.status, 200, 'the Human HTTP inspection seam remains available');
      const body = await response.json() as { readiness?: { probe?: unknown } };
      assert.equal(body.readiness?.probe, undefined, 'a pre-epoch race cannot leave current Worker facts');
    } finally {
      await h.close();
    }
  });
}
