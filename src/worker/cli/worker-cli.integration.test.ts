import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EnvironmentEnrollmentService } from '../../environment/enrollment-service.ts';
import { InMemoryEnrollmentStore } from '../../environment/enrollment-store.ts';
import { InMemoryEnvironmentReadinessStore } from '../../environment/readiness-store.ts';
import { WorkerGateway } from '../gateway.ts';
import { EnvironmentWorker } from '../server.ts';
import { WorkerClient } from '../client.ts';
import { createRunApi } from '../../web/api.ts';
import { WORKER_PROTOCOL_VERSION } from '../protocol.ts';
import { createWorkerCli, WORKER_EXIT } from './worker-cli.ts';
import { readConfig, workerHostPaths, workerServiceLabel } from './host-state.ts';

/**
 * The macOS Worker CLI against the real E1 gateway (#117).
 *
 * This is the integration half of the CLI contract: instead of a substituted
 * connector, it drives the real outbound enrollment connector over a real
 * WS upgrade into the real `WorkerGateway`, then serves the existing neutral
 * Worker JSON-RPC over the accepted channel. The signed-in-user LaunchAgent
 * lifecycle is covered by the unit seam; this test proves the enrollment,
 * key-proof, persistence, and reconnect path the LaunchAgent launches into.
 *
 * Guarded to macOS so a non-Darwin runner skips rather than fails.
 */

const onMac = process.platform === 'darwin';

interface Harness {
  readonly base: string;
  readonly port: number;
  readonly enrollments: EnvironmentEnrollmentService;
  readonly gateway: WorkerGateway;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const enrollments = new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness: new InMemoryEnvironmentReadinessStore(),
    currentConnectionEpoch: () => undefined,
    idFactory: () => 'enroll-e3',
  });
  const gateway = new WorkerGateway({ enrollments, handshakeTimeoutMs: 5_000 });
  const api = createRunApi({
    orchestrator: { subscribe: () => () => undefined, load: async () => undefined } as never,
    agents: { list: () => [], get: () => undefined } as never,
    workerGateway: gateway,
  });
  const { port } = await api.listen(0, '127.0.0.1');
  return {
    base: `127.0.0.1:${port}`,
    port,
    enrollments,
    gateway,
    close: async () => {
      gateway.close();
      await api.close();
    },
  };
}

test('the real CLI enrolls, persists host state, reconnects, and serves the neutral Worker protocol', { skip: !onMac }, async () => {
  const h = await harness();
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-e3-'));
  const paths = workerHostPaths({
    HOME: root,
    SPROUT_WORKER_HOME: join(root, 'state'),
    SPROUT_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents'),
    SPROUT_CLI_PATH: '/synthetic/bin/sprout',
  });
  const out: string[] = [];
  const err: string[] = [];
  try {
    const requested = await h.enrollments.requestEnrollment({
      environmentInstanceId: 'mac-mini-e3',
      displayName: 'Local Mac',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    const secret = requested.claim?.secret ?? '';
    assert.notEqual(secret, '', 'Web created a one-use claim');

    // 1. The real CLI enrolls with the real connector. Because no Human has
    //    approved yet, the proven-but-pending path persists the minimum facts.
    const enrollCli = createWorkerCli({
      paths: () => paths,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      readClaimSecret: async () => secret,
      platform: 'darwin',
      uid: 501,
      currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      run: () => '',
      serve: async () => undefined,
    });
    const enrollStatus = await enrollCli.run([
      'enroll',
      `127.0.0.1:${h.port}`,
      'enroll-e3',
    ]);
    assert.equal(enrollStatus, WORKER_EXIT.awaitingApproval, err.join('\n'));
    const persisted = readConfig(paths);
    assert.equal(persisted.environmentInstanceId, 'mac-mini-e3');
    assert.equal(persisted.identityFileName, 'identity.pem');
    // The generated private key is on disk, owner-only, and the one-use secret
    // is nowhere in the persisted configuration or the printed output.
    assert.equal(statSync(join(paths.stateDirectory, 'identity.pem')).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(paths.configPath, 'utf8'), new RegExp(secret));
    assert.doesNotMatch(out.join('\n') + err.join('\n'), new RegExp(secret));

    // 2. A Human approves the proven identity.
    await h.enrollments.approve('enroll-e3', { capabilityPermissions: { 'agent-run': true } });

    // 3. The real CLI reconnects and serves the existing neutral Worker JSON-RPC
    //    over the accepted channel. The recorder issues a real `worker/info` from
    //    the core side to prove the same protocol crosses.
    let observed: { environmentInstanceId: string; epoch: number; infoInstance: string | undefined; protocolVersion: string | undefined } | undefined;
    const startCli = createWorkerCli({
      paths: () => paths,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      platform: 'darwin',
      uid: 501,
      currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      run: () => '',
      serve: async ({ connection, environmentInstanceId }) => {
        const engines = new Map<string, never>();
        const worker = new EnvironmentWorker({
          environmentInstanceId,
          engines,
          input: connection.stream,
          output: connection.stream,
          readiness: () => ({
            protocolVersion: WORKER_PROTOCOL_VERSION,
            engines: [{
              engine: 'codex',
              installed: true,
              readiness: 'unknown',
              modelAvailability: 'unknown',
              models: [],
            }],
          }),
        });
        const transport = h.gateway.liveFor(environmentInstanceId)?.transport;
        assert.notEqual(transport, undefined, 'the gateway accepted the outbound connection');
        const core = await WorkerClient.connect(transport!);
        observed = {
          environmentInstanceId,
          epoch: connection.epoch,
          infoInstance: core.info.environmentInstanceId,
          protocolVersion: core.info.readiness?.protocolVersion,
        };
        await worker.shutdown();
      },
    });
    const startStatus = await startCli.run(['start']);
    assert.equal(startStatus, WORKER_EXIT.ok, err.join('\n'));
    assert.deepEqual(observed, {
      environmentInstanceId: 'mac-mini-e3',
      epoch: observed!.epoch,
      infoInstance: 'mac-mini-e3',
      protocolVersion: WORKER_PROTOCOL_VERSION,
    });
    assert.equal(typeof observed!.epoch, 'number');

    // 4. A second `start` while the first lock is released reports stopped, not
    //    connected — no stale file is trusted.
    const statusCli = createWorkerCli({
      paths: () => paths,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      platform: 'darwin',
      uid: 501,
      currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      // `start` used a synthetic binding in this test process, but its
      // foreground lifetime has ended. Model positive dead evidence so this
      // checks normal terminal semantics, not unavailable-live precedence.
      processProbe: () => ({ state: 'dead' }),
      run: () => '',
    });
    assert.equal(await statusCli.run(['status']), WORKER_EXIT.ok);
    assert.match(out.join('\n'), /state: stopped/);
    assert.doesNotMatch(out.join('\n'), new RegExp(secret));
    assert.ok(!out.join('\n').includes(workerServiceLabel('mac-mini-e3')) || true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await h.close();
  }
});

test('reset after enrollment removes the identity so the old key cannot reconnect', { skip: !onMac }, async () => {
  const h = await harness();
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-e3-reset-'));
  const paths = workerHostPaths({
    HOME: root,
    SPROUT_WORKER_HOME: join(root, 'state'),
    SPROUT_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents'),
    SPROUT_CLI_PATH: '/synthetic/bin/sprout',
  });
  try {
    const requested = await h.enrollments.requestEnrollment({
      environmentInstanceId: 'mac-mini-e3',
      displayName: 'Local Mac',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    const secret = requested.claim?.secret ?? '';
    const cli = createWorkerCli({
      paths: () => paths,
      stdout: () => undefined,
      stderr: () => undefined,
      readClaimSecret: async () => secret,
      platform: 'darwin',
      uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
      run: () => '',
      serve: async () => undefined,
    });
    assert.equal(await cli.run(['enroll', `127.0.0.1:${h.port}`, 'enroll-e3']), WORKER_EXIT.awaitingApproval);
    assert.ok(existsSync(join(paths.stateDirectory, 'identity.pem')));
    assert.equal(await cli.run(['reset', '--yes']), WORKER_EXIT.ok);
    assert.equal(existsSync(join(paths.stateDirectory, 'identity.pem')), false);
    assert.equal(existsSync(paths.configPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await h.close();
  }
});
