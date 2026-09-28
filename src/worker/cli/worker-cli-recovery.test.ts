import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';

import { LineJsonRpcTransport } from '../../engine/jsonrpc.ts';
import { WORKER_METHODS, WORKER_PROTOCOL_VERSION } from '../protocol.ts';
import { generateWorkerIdentity } from '../../environment/worker-proof.ts';
import { createWorkerCli } from './worker-cli.ts';
import { ensureStateDirectory, workerHostPaths, workerRecoveryJournalPath, writePrivateFile } from './host-state.ts';
import type { WorkerEnrollmentConnection } from '../enrollment-connector.ts';
import { ScriptedEngineAdapter } from '../../engine/scripted.ts';
import {
  INSTANCE_ID,
  readinessWorkflowHarness,
  scriptedStartupReadiness,
  testComposition,
  waitFor,
} from '../../runtime-test-harness.ts';
import { WorkerRecoveryJournal, type JournalSnapshot } from '../recovery-journal.ts';

import type { ReadinessCommandRunner } from '../readiness.ts';

function mockCommandRunner(): {
  readonly runner: ReadinessCommandRunner;
} {
  const runner: ReadinessCommandRunner = {
    async run(binary, args) {
      if (args[0] === '--version') {
        return {
          stdout: binary.includes('codex') ? 'codex-cli 0.154.0' : 'pi 0.86.1',
          exitCode: 0,
        };
      }
      if (args[0] === 'auth' && args[1] === 'check') {
        return {
          stdout: JSON.stringify({ status: 'ready', provider: 'openai-codex', authType: 'oauth' }),
          exitCode: 0,
        };
      }
      return { stdout: '{}', exitCode: 0 };
    },
    async accountRead() {
      return {
        stdout: JSON.stringify({
          account: { type: 'chatgpt', email: 'must-not-survive@example.com', planType: 'plus' },
          requiresOpenaiAuth: true,
        }),
        exitCode: 0,
      };
    },
    async bundledModels() {
      return {
        stdout: JSON.stringify({ models: [{ slug: 'gpt-6-astra' }] }),
        exitCode: 0,
      };
    },
  };
  return { runner };
}

test('regression: product path (worker start --foreground) wires WorkerRecoveryJournal for recovery/snapshot', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-recovery-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const paths = workerHostPaths({
    HOME: root,
    SPROUT_WORKER_HOME: join(root, 'state'),
    SPROUT_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents'),
    SPROUT_CLI_PATH: '/synthetic/bin/sprout',
  });

  ensureStateDirectory(paths);
  writePrivateFile(paths.configPath, JSON.stringify({
    version: 1,
    enrollmentId: 'enroll-synth-1',
    environmentInstanceId: 'env-synth-1',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    endpoint: { host: '127.0.0.1', port: 5174 },
    identityFileName: 'identity.pem',
  }));
  writePrivateFile(paths.identityPath, generateWorkerIdentity().privateKey);

  const toWorker = new PassThrough();
  const toClient = new PassThrough();
  const connectionStream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      toClient.write(chunk);
      callback();
    },
    destroy(error, callback) {
      toWorker.destroy(error ?? undefined);
      toClient.destroy(error ?? undefined);
      callback(error);
    },
  });
  toWorker.on('data', (chunk) => connectionStream.push(chunk));
  toWorker.on('end', () => connectionStream.push(null));

  const clientTransport = new LineJsonRpcTransport({
    input: toClient,
    output: toWorker,
  });

  const connection: WorkerEnrollmentConnection = {
    stream: connectionStream,
    enrollmentId: 'enroll-synth-1',
    environmentInstanceId: 'env-synth-1',
    epoch: 7,
    connectionId: 'c-1',
    close: () => {
      connectionStream.destroy();
    },
  };

  const { runner } = mockCommandRunner();
  const abortController = new AbortController();
  const cli = createWorkerCli({
    paths: () => paths,
    stdout: () => undefined,
    stderr: () => undefined,
    connect: async () => connection,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    readinessProbeOptions: {
      commandRunner: runner,
      clock: () => 40_000,
    },
    signal: abortController.signal,
    sleep: async () => {},
  });

  const startPromise = cli.run(['start', '--foreground'], {
    PATH: '',
    SPROUT_CODEX_BIN: '/synthetic/codex',
    SPROUT_WORKER_RECONNECT_MAX_MS: '300',
  });

  try {
    // Acceptance criterion 1: On the product path, recovery/snapshot returns
    // a non-null journal snapshot whose epoch equals the accepted connection epoch.
    const snapshot = await clientTransport.request<JournalSnapshot | null>(WORKER_METHODS.recoverySnapshot, {});
    assert.notEqual(snapshot, null, 'recovery/snapshot must return a non-null journal snapshot on the product path');
    assert.equal(snapshot?.epoch, 7, 'recovery/snapshot epoch must equal the accepted connection epoch');

    // Retained journal file must exist at identity-bound path
    const journalPath = workerRecoveryJournalPath(paths.identityPath);
    assert.ok(existsSync(journalPath), 'recovery journal file must exist on disk');
  } finally {
    abortController.abort();
    connection.close();
    clientTransport.close();
    await startPromise.catch(() => undefined);
  }
});

test('a run executed on the product path journals turn events and settlement into the journal (#167)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-product-journal-'));
  const workerRoot = mkdtempSync(join(tmpdir(), 'sprout-product-worker-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(workerRoot, { recursive: true, force: true });
  });

  const h = await readinessWorkflowHarness({ backend: 'sqlite', directory: dir, engineId: 'scripted' });
  const id = (await h.runtime.enrollments.list())[0]!.id;
  const keyPath = join(dir, 'worker-key.pem');
  const port = Number(new URL(h.base).port);

  const paths = workerHostPaths({
    HOME: workerRoot,
    SPROUT_WORKER_HOME: join(workerRoot, 'state'),
    SPROUT_LAUNCH_AGENTS_DIR: join(workerRoot, 'LaunchAgents'),
    SPROUT_CLI_PATH: '/synthetic/bin/sprout',
  });

  ensureStateDirectory(paths);
  writePrivateFile(paths.configPath, JSON.stringify({
    version: 1,
    enrollmentId: id,
    environmentInstanceId: INSTANCE_ID,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    endpoint: { host: '127.0.0.1', port },
    identityFileName: 'identity.pem',
  }));
  writePrivateFile(paths.identityPath, readFileSync(keyPath, 'utf8'));

  const slow = new ScriptedEngineAdapter({
    turns: [{
      events: [{ type: 'notice', text: 'product path turn event' }],
      result: { status: 'completed', text: 'turn finished' },
      settleAfterMs: 60_000,
    }],
  });

  const abortController = new AbortController();
  const cli = createWorkerCli({
    paths: () => paths,
    stdout: () => undefined,
    stderr: () => undefined,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    engines: new Map([['scripted', slow]]),
    readiness: scriptedStartupReadiness,
    signal: abortController.signal,
    sleep: () => new Promise<void>(() => {}),
  });

  const startPromise = cli.run(['start', '--foreground'], {
    SPROUT_WORKSPACE_ROOT: join(workerRoot, 'workspaces'),
    SPROUT_WORKER_RECONNECT_MAX_MS: '60000',
  });

  try {
    await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'eligible Worker');
    const project = await h.runtime.projectService.create({
      id: 'p-journal',
      displayName: 'Project',
      goal: 'Test',
      agentMemberships: [{ agentId: 'scout' }],
    });
    await h.runtime.projectAccess.grant({
      projectId: project.id,
      environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'default' },
    });
    const task = await h.runtime.tasks.create({
      projectId: project.id,
      title: 'Task',
      goal: 'Test',
      assignedAgentId: 'scout',
    });
    const begun = await h.runtime.tasks.begin(task.id);
    const { runId } = await h.runtime.tasks.advance(task.id, { prompt: 'advance on product path' });

    await waitFor(() => slow.sessions[0]?.prompts.length === 1, 'scripted turn started');

    // Retained journal file exists while connected and running
    const journalPath = workerRecoveryJournalPath(paths.identityPath);
    assert.ok(existsSync(journalPath), 'recovery journal exists during run');

    // Wait for the in-flight turn event to be journaled before channel loss
    await waitFor(() => {
      if (!existsSync(journalPath)) return false;
      const snap = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalSnapshot;
      return (snap?.turns[0]?.events.length ?? 0) >= 1;
    }, 'turn event journaled');

    // Simulate channel loss
    const stale = testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID)!;
    stale.close();

    await waitFor(
      async () => (await h.runtime.recovery.forLease(begun.environmentLeaseId!)) !== undefined,
      'core opened recovery record',
    );

    // Acceptance criterion 2: After channel loss, retained evidence exists in the recovery journal
    await waitFor(() => {
      if (!existsSync(journalPath)) return false;
      const snap = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalSnapshot;
      return snap.engineStopped === true;
    }, 'journal captured engineStopped fence');

    const snap = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalSnapshot;
    assert.equal(snap.turns.length, 1, 'turn is retained in journal');
    assert.equal(snap.turns[0]?.runId, runId, 'retained turn matches runId');
    assert.equal(snap.turns[0]?.events.length, 1, 'turn event was journaled');
    assert.equal(snap.turns[0]?.events[0]?.event.type, 'notice');
    assert.equal(snap.turns[0]?.settlement?.status, 'interrupted', 'settlement was journaled');
    assert.equal(snap.engineStopped, true, 'engine stop was journaled on channel loss fence');
  } finally {
    abortController.abort();
    await startPromise.catch(() => undefined);
    await h.close();
  }
});

test('with channel-lost recovery open, Worker reconnect on product path drives core evidence sync (#167)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-product-sync-'));
  const workerRoot = mkdtempSync(join(tmpdir(), 'sprout-product-worker-sync-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(workerRoot, { recursive: true, force: true });
  });

  const h = await readinessWorkflowHarness({ backend: 'sqlite', directory: dir, engineId: 'scripted' });
  const id = (await h.runtime.enrollments.list())[0]!.id;
  const keyPath = join(dir, 'worker-key.pem');
  const port = Number(new URL(h.base).port);

  const paths = workerHostPaths({
    HOME: workerRoot,
    SPROUT_WORKER_HOME: join(workerRoot, 'state'),
    SPROUT_LAUNCH_AGENTS_DIR: join(workerRoot, 'LaunchAgents'),
    SPROUT_CLI_PATH: '/synthetic/bin/sprout',
  });

  ensureStateDirectory(paths);
  writePrivateFile(paths.configPath, JSON.stringify({
    version: 1,
    enrollmentId: id,
    environmentInstanceId: INSTANCE_ID,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    endpoint: { host: '127.0.0.1', port },
    identityFileName: 'identity.pem',
  }));
  writePrivateFile(paths.identityPath, readFileSync(keyPath, 'utf8'));

  const slow = new ScriptedEngineAdapter({
    turns: [
      {
        events: [{ type: 'notice', text: 'turn notice on product path' }],
        result: { status: 'completed', text: 'not replayed' },
        settleAfterMs: 60_000,
      },
      {
        events: [],
        result: { status: 'completed', text: 'must not execute' },
      },
    ],
  });

  const abortController = new AbortController();
  const cli = createWorkerCli({
    paths: () => paths,
    stdout: () => undefined,
    stderr: () => undefined,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    engines: new Map([['scripted', slow]]),
    readiness: scriptedStartupReadiness,
    signal: abortController.signal,
    sleep: async () => {},
  });

  const startPromise = cli.run(['start', '--foreground'], {
    SPROUT_WORKSPACE_ROOT: join(workerRoot, 'workspaces'),
    SPROUT_WORKER_RECONNECT_MAX_MS: '60000',
  });

  try {
    await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'eligible Worker');
    const project = await h.runtime.projectService.create({
      id: 'p-sync',
      displayName: 'Project',
      goal: 'Test',
      agentMemberships: [{ agentId: 'scout' }],
    });
    await h.runtime.projectAccess.grant({
      projectId: project.id,
      environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'default' },
    });
    const task = await h.runtime.tasks.create({
      projectId: project.id,
      title: 'Task',
      goal: 'Test',
      assignedAgentId: 'scout',
    });
    const begun = await h.runtime.tasks.begin(task.id);
    const { runId } = await h.runtime.tasks.advance(task.id, { prompt: 'one turn' });

    await waitFor(() => slow.sessions[0]?.prompts.length === 1, 'scripted turn started');

    // Simulate channel loss
    const stale = testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID)!;
    stale.close();

    await waitFor(
      async () => (await h.runtime.recovery.forLease(begun.environmentLeaseId!)) !== undefined,
      'protected Task recovery opened',
    );

    // Acceptance criterion 3: With a channel-lost recovery open, Worker reconnect drives core sync:
    // evidence synchronizes and the record reaches human-decision phase with retained evidence and decision recorded.
    await waitFor(async () => {
      const rec = await h.runtime.recovery.forLease(begun.environmentLeaseId!);
      return rec?.evidence?.turnSettlementObserved === true &&
        rec?.decisions.some((d) => d.kind === 'evidence-synchronized');
    }, 'retained Worker settlement and evidence synchronized on reconnect');

    const recovered = (await h.runtime.recovery.forLease(begun.environmentLeaseId!))!;
    assert.equal(recovered.enrollmentId, id);
    assert.equal(recovered.runId, runId);
    assert.equal(recovered.evidence?.terminalStatus, 'interrupted');
    assert.equal(recovered.evidence?.engineSessionStopped, true);
    assert.equal(recovered.evidence?.turnSettlementObserved, true);
    assert.ok(
      recovered.decisions.some((d) => d.kind === 'evidence-synchronized'),
      'decision evidence-synchronized recorded',
    );
    assert.ok(
      !recovered.unresolvedFacts.includes('The Worker channel is lost; no retained evidence has been synchronized.'),
      'unresolved channel-loss fact cleared after sync',
    );

    // The human decision to resume works cleanly on the synchronized record
    await h.runtime.recovery.resume(begun.environmentLeaseId!);
    assert.equal((await h.runtime.tasks.get(task.id))?.environmentLifecycleState, 'blocked');
    assert.equal(h.runtime.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
  } finally {
    abortController.abort();
    await startPromise.catch(() => undefined);
    await h.close();
  }
});

test('idle Task channel-lost recovery auto-resolves on product path reconnect (#167)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-product-idle-'));
  const workerRoot = mkdtempSync(join(tmpdir(), 'sprout-product-worker-idle-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(workerRoot, { recursive: true, force: true });
  });

  const h = await readinessWorkflowHarness({ backend: 'sqlite', directory: dir, engineId: 'scripted' });
  const id = (await h.runtime.enrollments.list())[0]!.id;
  const keyPath = join(dir, 'worker-key.pem');
  const port = Number(new URL(h.base).port);

  const paths = workerHostPaths({
    HOME: workerRoot,
    SPROUT_WORKER_HOME: join(workerRoot, 'state'),
    SPROUT_LAUNCH_AGENTS_DIR: join(workerRoot, 'LaunchAgents'),
    SPROUT_CLI_PATH: '/synthetic/bin/sprout',
  });

  ensureStateDirectory(paths);
  writePrivateFile(paths.configPath, JSON.stringify({
    version: 1,
    enrollmentId: id,
    environmentInstanceId: INSTANCE_ID,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    endpoint: { host: '127.0.0.1', port },
    identityFileName: 'identity.pem',
  }));
  writePrivateFile(paths.identityPath, readFileSync(keyPath, 'utf8'));

  const adapter = new ScriptedEngineAdapter({ turns: [] });

  const abortController = new AbortController();
  const cli = createWorkerCli({
    paths: () => paths,
    stdout: () => undefined,
    stderr: () => undefined,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    engines: new Map([['scripted', adapter]]),
    readiness: scriptedStartupReadiness,
    signal: abortController.signal,
    sleep: async () => {},
  });

  const startPromise = cli.run(['start', '--foreground'], {
    SPROUT_WORKSPACE_ROOT: join(workerRoot, 'workspaces'),
    SPROUT_WORKER_RECONNECT_MAX_MS: '60000',
  });

  try {
    await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'eligible Worker');
    const project = await h.runtime.projectService.create({
      id: 'p-idle',
      displayName: 'Project',
      goal: 'Test',
      agentMemberships: [{ agentId: 'scout' }],
    });
    await h.runtime.projectAccess.grant({
      projectId: project.id,
      environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'default' },
    });
    const task = await h.runtime.tasks.create({
      projectId: project.id,
      title: 'Idle Task',
      goal: 'Test',
      assignedAgentId: 'scout',
    });
    const begun = await h.runtime.tasks.begin(task.id);

    // Channel loss during idle Task
    const live = testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID)!;
    live.close();

    await waitFor(
      async () => (await h.runtime.recovery.forLease(begun.environmentLeaseId!)) !== undefined,
      'recovery record opened for idle Task',
    );

    // On reconnect, evidence synchronizes and idle Task auto-resolves to 'resolved'
    await waitFor(async () => {
      const records = await h.runtime.recovery.listForEnvironment(INSTANCE_ID);
      return records.some((r) => r.leaseId === begun.environmentLeaseId! && r.phase === 'resolved');
    }, 'idle Task recovery reached resolved phase');

    const records = await h.runtime.recovery.listForEnvironment(INSTANCE_ID);
    const resolved = records.find((r) => r.leaseId === begun.environmentLeaseId!)!;
    assert.equal(resolved.phase, 'resolved');
    assert.equal(resolved.evidence !== undefined, true);
  } finally {
    abortController.abort();
    await startPromise.catch(() => undefined);
    await h.close();
  }
});

test('regression: reset followed by re-enrollment cannot read or import prior identity recovery journal (#167)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-reset-re-enroll-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const paths = workerHostPaths({
    HOME: root,
    SPROUT_WORKER_HOME: join(root, 'state'),
    SPROUT_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents'),
    SPROUT_CLI_PATH: '/synthetic/bin/sprout',
  });

  ensureStateDirectory(paths);

  // 1. Initial enrollment with identity A
  const identityA = generateWorkerIdentity();
  writePrivateFile(paths.configPath, JSON.stringify({
    version: 1,
    enrollmentId: 'enroll-identity-a',
    environmentInstanceId: 'env-synth-1',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    endpoint: { host: '127.0.0.1', port: 5174 },
    identityFileName: 'identity.pem',
  }));
  writePrivateFile(paths.identityPath, identityA.privateKey);

  // Identity A journals turn events and context at epoch 5
  const journalPathA = workerRecoveryJournalPath(paths.identityPath, identityA.privateKey);
  const journalA = new WorkerRecoveryJournal(journalPathA, 5);
  journalA.begin('session-a', 'turn-a', 'run-a');
  journalA.event('turn-a', { type: 'notice', text: 'identity A evidence' });
  journalA.context('task-a', 'prepared');
  assert.ok(existsSync(journalPathA), 'Identity A journal must exist');
  assert.ok(existsSync(`${journalPathA}.lock.sqlite`), 'Identity A lock file must exist');

  // 2. Perform `reset --yes` through the CLI
  const cliA = createWorkerCli({
    paths: () => paths,
    stdout: () => undefined,
    stderr: () => undefined,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
  });
  const resetExit = await cliA.run(['reset', '--yes']);
  assert.equal(resetExit, 0, 'worker reset must succeed');
  assert.equal(existsSync(paths.identityPath), false, 'identity.pem must be removed by reset');
  assert.equal(existsSync(paths.configPath), false, 'config.json must be removed by reset');
  assert.equal(existsSync(journalPathA), false, 'identity A recovery journal must be removed by reset');
  assert.equal(existsSync(`${journalPathA}.lock.sqlite`), false, 'identity A recovery lock must be removed by reset');

  // 3. Re-enroll with a DIFFERENT identity B at the same state directory
  const identityB = generateWorkerIdentity();
  writePrivateFile(paths.configPath, JSON.stringify({
    version: 1,
    enrollmentId: 'enroll-identity-b',
    environmentInstanceId: 'env-synth-1',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    endpoint: { host: '127.0.0.1', port: 5174 },
    identityFileName: 'identity.pem',
  }));
  writePrivateFile(paths.identityPath, identityB.privateKey);

  // Even if an orphaned prior journal on disk exists with a higher epoch (epoch 10)
  // and sensitive turns from Identity A:
  const orphanedOldJournal = new WorkerRecoveryJournal(journalPathA, 10);
  orphanedOldJournal.begin('session-a-leak', 'turn-a-leak', 'run-a-leak');

  // 4. Start foreground worker with Identity B at epoch 1 (lower than epoch 10)
  const toWorker = new PassThrough();
  const toClient = new PassThrough();
  const connectionStream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      toClient.write(chunk);
      callback();
    },
    destroy(error, callback) {
      toWorker.destroy(error ?? undefined);
      toClient.destroy(error ?? undefined);
      callback(error);
    },
  });
  toWorker.on('data', (chunk) => connectionStream.push(chunk));
  toWorker.on('end', () => connectionStream.push(null));

  const clientTransport = new LineJsonRpcTransport({
    input: toClient,
    output: toWorker,
  });

  const connectionB: WorkerEnrollmentConnection = {
    stream: connectionStream,
    enrollmentId: 'enroll-identity-b',
    environmentInstanceId: 'env-synth-1',
    epoch: 1, // Epoch 1 is lower than the old journal's epoch (10)
    connectionId: 'c-b-1',
    close: () => {
      connectionStream.destroy();
    },
  };

  const { runner } = mockCommandRunner();
  const abortControllerB = new AbortController();
  const cliB = createWorkerCli({
    paths: () => paths,
    stdout: () => undefined,
    stderr: () => undefined,
    connect: async () => connectionB,
    platform: 'darwin',
    uid: 501,
    currentProcess: (ownerToken) => ({ pid: process.pid, startIdentity: 'test-current-process', ownerToken }),
    readinessProbeOptions: {
      commandRunner: runner,
      clock: () => 40_000,
    },
    signal: abortControllerB.signal,
    sleep: async () => {},
  });

  const startPromise = cliB.run(['start', '--foreground'], {
    PATH: '',
    SPROUT_CODEX_BIN: '/synthetic/codex',
    SPROUT_WORKER_RECONNECT_MAX_MS: '300',
  });

  try {
    // Identity B's recovery/snapshot must succeed cleanly at epoch 1 (not thrown as stale epoch 10)
    const snapshot = await clientTransport.request<JournalSnapshot | null>(WORKER_METHODS.recoverySnapshot, {});
    assert.notEqual(snapshot, null, 'recovery/snapshot must return a non-null journal snapshot');
    assert.equal(snapshot?.epoch, 1, 'snapshot epoch must match identity B epoch');
    assert.equal(snapshot?.turns.length, 0, 'snapshot must not import prior identity A turns');
    assert.deepEqual(snapshot?.taskContexts, {}, 'snapshot must not import prior identity A task contexts');

    // Identity B's journal is scoped to Identity B's public key
    const journalPathB = workerRecoveryJournalPath(paths.identityPath, identityB.privateKey);
    assert.notEqual(journalPathB, journalPathA, 'journal paths must differ across identities');
    assert.ok(existsSync(journalPathB), 'Identity B journal file must exist');
  } finally {
    abortControllerB.abort();
    connectionB.close();
    clientTransport.close();
    await startPromise.catch(() => undefined);
  }
});
