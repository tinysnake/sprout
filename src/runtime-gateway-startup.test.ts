import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import {
  agent,
  createRuntime,
  hostConfiguration,
  project,
  waitFor,
} from './runtime-test-harness.ts';

test('real Gateway startup rejects invalid target probes and empty-target worker/info probes before durable commit (R118-API-002, R118-BOUNDARY-003)', async () => {
  const { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } = await import(
    './worker/enrollment-connector.ts'
  );
  const { EnvironmentWorker } = await import('./worker/server.ts');
  const { WORKER_PROTOCOL_VERSION } = await import('./worker/protocol.ts');
  const { signWorkerChallenge } = await import('./environment/worker-proof.ts');
  const validProbe = {
    at: 5_000, latencyMs: 9, protocolOk: true, enginesOk: true,
    source: 'worker', version: '0.154.0', summary: 'safe startup probe',
  };
  const invalidResults: readonly { readonly name: string; readonly source: 'probe-result' | 'worker-info'; readonly value: unknown }[] = [
    {
      name: 'missing returned probe',
      source: 'probe-result',
      value: {
        readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe: validProbe },
      },
    },
    {
      name: 'mismatched embedded and returned probes',
      source: 'probe-result',
      value: {
        readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe: validProbe },
        probe: { ...validProbe, summary: 'different returned probe' },
      },
    },
    {
      name: 'provider/account probe source',
      source: 'probe-result',
      value: {
        readiness: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          engines: [],
          probe: { ...validProbe, source: 'provider-account' },
        },
        probe: { ...validProbe, source: 'provider-account' },
      },
    },
    {
      name: 'empty-target worker/info missing embedded probe',
      source: 'worker-info',
      value: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [] },
    },
    {
      name: 'empty-target worker/info malformed embedded probe',
      source: 'worker-info',
      value: {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engines: [],
        probe: { ...validProbe, unexpected: 'not part of the closed shape' },
      },
    },
  ];

  for (const fixture of invalidResults) {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-118-startup-ingress-'));
    const keyDirectory = mkdtempSync(join(tmpdir(), 'sprout-118-startup-key-'));
    const keyPath = join(keyDirectory, 'worker-key.pem');
    const runtime = await createRuntime({
      configuration: hostConfiguration({
        databasePath: join(directory, 'sprout.db'),
        environmentSource: 'enrollment',
        ...(fixture.source === 'probe-result' ? { runtimeConfiguration: {
          agents: [
            { ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' },
            agent('scribe'),
          ],
          project: project(),
        } } : {}),
      }),
      projectRoot: '/synthetic/project-root',
    });
    let connection: Awaited<ReturnType<typeof connectWorkerEnrollment>> | undefined;
    let worker: InstanceType<typeof EnvironmentWorker> | undefined;
    try {
      const requested = await runtime.enrollments.requestEnrollment({
        environmentInstanceId: 'startup-invalid-host',
        displayName: 'Startup Invalid Host',
        platform: 'macos',
        capabilityRequests: [ADMISSION_CAPABILITY],
        engineFacts: [],
      });
      const enrollmentId = requested.enrollment.id;
      const host = loadOrCreateWorkerIdentity(keyPath);
      await runtime.enrollments.claimEnrollment(enrollmentId, requested.claim?.secret ?? '');
      const challenge = await runtime.enrollments.issueChallenge(enrollmentId);
      await runtime.enrollments.connectWorker({
        enrollmentId,
        proof: {
          challengeId: challenge.id,
          publicKey: workerPublicKey(host.privateKey),
          signature: signWorkerChallenge(host.privateKey, challenge),
        },
        connection: { state: 'online' },
        compatibility: { state: 'compatible', workerProtocolVersion: WORKER_PROTOCOL_VERSION },
        engines: [],
      });
      await runtime.enrollments.approve(enrollmentId, {
        capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
      });
      const { port } = await runtime.api.listen(0, '127.0.0.1');
      connection = await connectWorkerEnrollment({
        target: {
          enrollmentId,
          host: '127.0.0.1',
          port,
          claimSecret: undefined,
          identityKeyPath: keyPath,
        },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engineFacts: [{ engine: 'codex', installed: true, authenticated: true, models: [] }],
      });
      let calls = 0;
      worker = new EnvironmentWorker({
        environmentInstanceId: 'startup-invalid-host',
        engines: new Map(),
        input: connection.stream,
        output: connection.stream,
        ...(fixture.source === 'probe-result'
          ? {
              readinessProbe: async () => {
                calls += 1;
                return fixture.value as never;
              },
            }
          : {
              readiness: () => {
                calls += 1;
                return fixture.value as never;
              },
            }),
      });

      // Invoke the same automatic observer that acceptance schedules, but await
      // it so absence from the store is deterministic rather than timer-based.
      await waitFor(() => calls > 0, 'accepted Worker automatic collection');
      assert.ok(calls > 0, `${fixture.name}: the real Worker JSON-RPC probe was exercised`);
      assert.equal(
        await runtime.stores.environmentReadiness.getReadiness('startup-invalid-host'),
        undefined,
        `${fixture.name}: no readiness document may cross the shared ingress guard`,
      );
      assert.deepEqual(
        await runtime.stores.environmentReadiness.listProbes('startup-invalid-host'),
        [],
        `${fixture.name}: no durable startup probe may cross the shared ingress guard`,
      );
    } finally {
      await worker?.shutdown().catch(() => undefined);
      connection?.close();
      await runtime.close();
      rmSync(keyDirectory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
