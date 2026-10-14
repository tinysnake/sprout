import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OarEngineAdapter, type OarRunnerProcess } from './engine/oar.ts';
import type { EngineAdapter } from './engine/port.ts';
import type { RunnerCommand } from './engine/oar-runner-protocol.ts';
import { readinessWorkflowHarness, scriptedStartupReadiness, testComposition, INSTANCE_ID } from './runtime-test-harness.ts';
import { WorkerRecoveryJournal } from './worker/recovery-journal.ts';
import type { WorkerReadinessFacts, WorkerReadinessProbeParams } from './worker/protocol.ts';

async function waitFor(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function waitForOarPrompt(
  getRunner: () => RuntimeOarRunner | undefined,
  runtime: import('./runtime.ts').SproutRuntime,
  runId: string,
  description: string,
): Promise<void> {
  await waitFor(async () => getRunner()?.commands.some(command => command.op === 'prompt') === true ||
    ['completed', 'failed', 'interrupted', 'stopped', 'cancelled'].includes((await runtime.orchestrator.load(runId))?.status ?? ''), description);
  const runner = getRunner();
  if (!runner?.commands.some(command => command.op === 'prompt')) {
    const run = await runtime.orchestrator.load(runId);
    const lease = run?.leaseId === undefined ? undefined : runtime.pool.getLease(run.leaseId);
    const detail = `${description}; run=${run?.status}; result=${run?.result?.status}; message=${run?.result?.status === 'failed' ? run.result.message : ''}; lease=${lease?.state}; eligible=${runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible}; commands=${runner?.commands.map(command => command.op).join(',')}`;
    throw new Error(detail);
  }
}

class RuntimeOarRunner implements OarRunnerProcess {
  readonly #process: ChildProcess;
  readonly pid: number;
  readonly stdin = new PassThrough();
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly commands: RunnerCommand[] = [];
  #input = '';

  constructor(child: ChildProcess) {
    this.#process = child;
    if (child.pid === undefined) throw new Error('OAR runner child was not spawned');
    this.pid = child.pid;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.stdin.pipe(child.stdin!);
    this.stdin.on('data', (chunk: Buffer) => {
      this.#input += chunk.toString('utf8');
      let newline = this.#input.indexOf('\n');
      while (newline !== -1) {
        const line = this.#input.slice(0, newline).trim();
        this.#input = this.#input.slice(newline + 1);
        if (line) this.commands.push(JSON.parse(line) as RunnerCommand);
        newline = this.#input.indexOf('\n');
      }
    });
  }

  get exitCode(): number | null { return this.#process.exitCode; }
  get signalCode(): NodeJS.Signals | null { return this.#process.signalCode; }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { return this.#process.kill(signal); }

  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((err: Error) => void),
  ): this {
    if (event === 'exit') this.#process.on('exit', listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    else this.#process.on('error', listener as (err: Error) => void);
    return this;
  }
}

function engineReadiness(engine: string, requirements?: import('./environment/readiness.ts').ReadinessRequirementScope): () => WorkerReadinessFacts {
  return () => {
    const base = scriptedStartupReadiness();
    const requirementRevision = requirements?.revisionsByEngine?.[engine];
    const targetModels = requirements?.modelsByEngine?.[engine] ?? [];
    return {
      ...base,
      engines: [{
        engine, installed: true, readiness: 'ready', modelAvailability: 'available',
        models: targetModels.length > 0 ? [...targetModels] : [`${engine}-test-model`],
        authenticated: true, modelIdPresent: true, targetModels,
        ...(requirementRevision !== undefined ? { requirementRevision } : {}),
      }],
      ...(base.probe !== undefined ? { probe: { ...base.probe, enginesOk: true } } : {}),
    };
  };
}

function adapterFor(runtimeId: string, plans: readonly {
  readonly abortMode?: 'aborted' | 'no-terminal' | 'rejected-completed';
  readonly completionDelayMs?: number;
}[], directory: string) {
  const runnerPath = join(directory, `${runtimeId}-runner.mjs`);
  writeFileSync(runnerPath, `
import { createInterface } from 'node:readline';
const sessionId = process.env.OAR_TEST_SESSION_ID;
const abortMode = process.env.OAR_TEST_ABORT_MODE;
const completionDelayMs = Number(process.env.OAR_TEST_COMPLETION_DELAY_MS || 0);
let activationId;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const complete = () => {
  send({ kind: 'event', event: { kind: 'text_delta', text: 'completed answer', sessionId, agentPath: [], seq: 2, receivedAt: Date.now(), activationId } });
  send({ kind: 'turn_ended', activationId, seq: 3, outcome: { kind: 'completed' } });
};
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.op === 'start') send({ kind: 'ready', sessionId, engineSessionKey: sessionId });
  else if (command.op === 'prompt') {
    activationId = command.activationId;
    send({ kind: 'prompt_accepted', activationId, seq: 1 });
    send({ kind: 'event', event: { kind: 'text_delta', text: 'working', sessionId, agentPath: [], seq: 2, receivedAt: Date.now(), activationId } });
    if (completionDelayMs > 0) setTimeout(complete, completionDelayMs);
  } else if (command.op === 'abort') {
    const accepted = abortMode !== 'rejected-completed';
    send({ kind: 'abort_result', activationId: command.activationId, accepted });
    if (abortMode === 'aborted') send({ kind: 'turn_ended', activationId, seq: 3, outcome: { kind: 'aborted' } });
    else if (abortMode === 'rejected-completed') setTimeout(complete, 25);
  } else if (command.op === 'dispose') {
    send({ kind: 'disposed' });
    setTimeout(() => process.exit(0), 10);
  }
});
`);
  const runners: RuntimeOarRunner[] = [];
  let next = 0;
  const adapter = new OarEngineAdapter({
    runtimeId,
    runnerScriptPath: runnerPath,
    ...(runtimeId === 'pi' ? { piConfigurationProvider: { resolve: () => ({ agentDir: join(directory, 'pi-agent') }) } } : {}),
    spawnProcess: (command, args, options) => {
      const plan = plans[next++] ?? {};
      const child = spawn(command, [...args], {
        ...(options as unknown as SpawnOptions),
        env: {
          ...process.env, ...(options.env ?? {}),
          OAR_TEST_SESSION_ID: `${runtimeId}-native-${next}`,
          OAR_TEST_ABORT_MODE: plan.abortMode ?? 'aborted',
          OAR_TEST_COMPLETION_DELAY_MS: String(plan.completionDelayMs ?? 0),
        },
      });
      const runner = new RuntimeOarRunner(child);
      runners.push(runner);
      return runner;
    },
  });
  return { adapter, runners };
}

async function setup(runtimeId: string, directory: string, adapter: EngineAdapter, journalPath: string, epoch = 1) {
  const h = await readinessWorkflowHarness({
    backend: 'sqlite', directory, engineId: runtimeId,
    agents: [{ id: 'scout', name: 'Scout', engine: runtimeId, capability: 'agent-run',
      workOptions: [{ id: `${runtimeId}-option`, engine: runtimeId, workModel: `${runtimeId}-test-model`, effort: '' }] }],
  });
  const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
  const connection = await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
    engines: new Map([[runtimeId, adapter]]),
    readinessProbe: async (params: WorkerReadinessProbeParams) => {
      const readiness = engineReadiness(runtimeId, params.requirements)();
      return {
        ...(params.attemptId !== undefined ? { attemptId: params.attemptId } : {}),
        readiness,
        probe: readiness.probe!,
      };
    },
    recoveryJournal: new WorkerRecoveryJournal(journalPath, epoch),
  });
  await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'OAR Worker eligible');
  const project = await h.runtime.projectService.create({
    id: `${runtimeId}-project`, displayName: 'OAR Project', goal: 'Exercise OAR lifecycle behavior',
    agentMemberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }],
  });
  await h.runtime.projectAccess.grant({ projectId: project.id, environmentInstanceId: INSTANCE_ID, selection: { kind: 'default' } });
  return { h, connection, enrollmentId, project };
}

for (const runtimeId of ['codex', 'pi']) {
  test(`${runtimeId} OAR Runtime Message and Task paths preserve interruption, pause, stop, and lease authority`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), `runtime-oar-${runtimeId}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const fixture = adapterFor(runtimeId, [
      { abortMode: 'aborted' },
      { abortMode: 'aborted' },
      { completionDelayMs: 400 },
    ], directory);
    const journalPath = join(directory, 'worker-recovery.json');
    let app = await setup(runtimeId, directory, fixture.adapter, journalPath);
    try {
      const { h, project } = app;
      await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'OAR readiness');

      const delivered = await h.runtime.collaboration.deliver({
        scopeId: `channel-${project.id}`, author: { id: 'operator', kind: 'human' },
        body: '@scout complete a bounded message', deliveryKey: `${runtimeId}-chat-stop`, awaitReply: false,
      });
      assert.equal(delivered.admittedRunIds.length, 1, JSON.stringify(delivered));
      const chatRunId = delivered.admittedRunIds[0]!;
      await waitForOarPrompt(() => fixture.runners[0], h.runtime, chatRunId, 'OAR Chat prompt admitted');
      const chatStopped = await h.runtime.orchestrator.interrupt(chatRunId);
      assert.equal(chatStopped.status, 'interrupted');
      assert.equal(chatStopped.interruptionReason, 'human-stop');
      assert.equal(chatStopped.result?.status, 'interrupted');
      assert.equal(chatStopped.result?.outcomeCertainty, undefined);
      assert.equal(h.runtime.pool.getLease(chatStopped.leaseId!)?.state, 'released', 'certain Chat interruption releases its run lease');
      assert.equal((await h.runtime.collaboration.listMessages()).filter(message =>
        message.author.kind === 'agent' && message.inReplyTo === delivered.message.id).length, 0,
      'a stopped one-round run does not project a reply');

      const task = await h.runtime.tasks.create({
        projectId: project.id, title: 'Stop Task run', goal: 'Preserve the Task lease', assignedAgentId: 'scout',
      });
      const begun = await h.runtime.tasks.begin(task.id);
      const stoppedAdvance = await h.runtime.tasks.advance(task.id, { prompt: 'Task run to stop' });
      await waitForOarPrompt(() => fixture.runners[1], h.runtime, stoppedAdvance.runId, 'Task OAR prompt admitted');
      await h.runtime.taskControls.pauseForHuman(task.id, { reason: 'hold Task admission' });
      const pausedStop = await h.runtime.taskControls.interruptForHuman(task.id, { reason: 'stop the active Task run' });
      const stoppedRun = await h.runtime.orchestrator.load(stoppedAdvance.runId);
      assert.equal(stoppedRun?.status, 'stopped');
      assert.equal(pausedStop.pauseState, 'paused');
      assert.equal(pausedStop.environmentLifecycleState, 'idle');
      assert.equal(h.runtime.pool.getLease(begun.environmentLeaseId!)?.state, 'active', 'Task stop keeps the outer Task lease');
      assert.equal(stoppedRun?.leaseId, begun.environmentLeaseId, 'the nested OAR run records the same Task lease');
      assert.equal(h.runtime.pool.leases().filter(lease => lease.state === 'active' && lease.capability === 'agent-run').length, 1,
        'nested OAR execution does not acquire a second lease');

      await h.runtime.taskControls.resumeForHuman(task.id, { reason: 'continue the stopped Task under its held lease' });
      const pauseAdvance = await h.runtime.tasks.advance(task.id, { prompt: 'Task run that completes during pause' });
      await waitForOarPrompt(() => fixture.runners[2], h.runtime, pauseAdvance.runId, 'second Task OAR prompt admitted');
      await h.runtime.taskControls.pauseForHuman(task.id, { reason: 'pause after the current step' });
      const completedRun = await h.runtime.orchestrator.waitFor(pauseAdvance.runId);
      const pausedTask = await h.runtime.tasks.get(task.id);
      assert.equal(completedRun.status, 'completed');
      assert.equal(pausedTask?.pauseState, 'paused');
      assert.equal(pausedTask?.environmentLifecycleState, 'idle');
      assert.equal(h.runtime.pool.getLease(begun.environmentLeaseId!)?.state, 'active', 'natural settlement during pause keeps the Task lease');
      assert.equal((await h.runtime.tasks.getWithRuns(task.id))?.runs.at(-1)?.runId, pauseAdvance.runId,
        'pause records the existing run without creating a replacement');
    } finally {
      await app.h.close();
    }
  });

  test(`${runtimeId} OAR Worker reconnect preserves settlement evidence and never replays a Task prompt`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), `runtime-oar-reconnect-${runtimeId}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const journalPath = join(directory, 'worker-recovery.json');
    const firstFixture = adapterFor(runtimeId, [{ abortMode: 'aborted' }], directory);
    const app = await setup(runtimeId, directory, firstFixture.adapter, journalPath);
    let h = app.h;
    try {
      const { enrollmentId, connection, project } = app;
      const task = await h.runtime.tasks.create({
        projectId: project.id, title: 'Reconnect Task', goal: 'Retain its interrupted run', assignedAgentId: 'scout',
      });
      const begun = await h.runtime.tasks.begin(task.id);
      const advance = await h.runtime.tasks.advance(task.id, { prompt: 'run exactly once before reconnect' });
      await waitForOarPrompt(() => firstFixture.runners[0], h.runtime, advance.runId, 'reconnect OAR prompt admitted');
      const stale = testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID)!;
      stale.close();
      await waitFor(async () => (await h.runtime.recovery.forLease(begun.environmentLeaseId!)) !== undefined, 'Task recovery opened on disconnect');
      await waitFor(() => (JSON.parse(readFileSync(journalPath, 'utf8')) as { engineStopped: boolean }).engineStopped,
        'OAR process tree stopped and journaled');

      await h.close();
      h = await readinessWorkflowHarness({
        backend: 'sqlite', directory, engineId: runtimeId, reopen: true,
        agents: [{ id: 'scout', name: 'Scout', engine: runtimeId, capability: 'agent-run',
          workOptions: [{ id: `${runtimeId}-option`, engine: runtimeId, workModel: `${runtimeId}-test-model`, effort: '' }] }],
      });
      const secondFixture = adapterFor(runtimeId, [], directory);
      const replacement = await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        engines: new Map([[runtimeId, secondFixture.adapter]]),
        readinessProbe: async (params: WorkerReadinessProbeParams) => {
          const readiness = engineReadiness(runtimeId, params.requirements)();
          return {
            ...(params.attemptId !== undefined ? { attemptId: params.attemptId } : {}),
            readiness,
            probe: readiness.probe!,
          };
        },
        recoveryJournal: new WorkerRecoveryJournal(journalPath, connection.epoch + 1),
      });
      assert.ok(replacement.epoch > connection.epoch, 'the replacement uses a newer accepted connection epoch');
      await waitFor(async () => {
        const recovery = await h.runtime.recovery.forLease(begun.environmentLeaseId!);
        return recovery?.evidence?.turnSettlementObserved === true && recovery.evidence.engineSessionStopped === true;
      }, 'OAR journal and terminal settlement synchronized');
      const recovery = (await h.runtime.recovery.forLease(begun.environmentLeaseId!))!;
      assert.equal(recovery.evidence?.terminalStatus, 'interrupted');
      assert.equal(recovery.runId, advance.runId);
      assert.equal((await h.runtime.orchestrator.load(advance.runId))?.status, 'interrupted');
      assert.equal((await h.runtime.stores.recovery.workerRunReceipt?.(enrollmentId, advance.runId))?.terminal, true);
      assert.equal(h.runtime.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
      assert.equal(firstFixture.runners[0]?.commands.filter(command => command.op === 'prompt').length, 1);
      assert.equal(secondFixture.runners.length, 0, 'reconnect synchronizes old evidence without admitting a replacement prompt');
      const journal = readFileSync(journalPath, 'utf8');
      assert.doesNotMatch(journal, /run exactly once before reconnect|native payload|provider record/,
        'the operational journal stores only bounded Worker facts, not prompts or OAR native records');
    } finally {
      await h.close();
    }
  });

  test(`${runtimeId} OAR accepted abort without terminal evidence preserves the run-held lease`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), `runtime-oar-uncertain-${runtimeId}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const fixture = adapterFor(runtimeId, [{ abortMode: 'no-terminal' }], directory);
    const journalPath = join(directory, 'worker-recovery.json');
    const app = await setup(runtimeId, directory, fixture.adapter, journalPath);
    try {
      const { h, project } = app;
      const delivered = await h.runtime.collaboration.deliver({
        scopeId: `channel-${project.id}`, author: { id: 'operator', kind: 'human' },
        body: '@scout preserve this uncertain execution', deliveryKey: `${runtimeId}-uncertain`, awaitReply: false,
      });
      assert.equal(delivered.admittedRunIds.length, 1, JSON.stringify(delivered));
      const runId = delivered.admittedRunIds[0]!;
      await waitForOarPrompt(() => fixture.runners[0], h.runtime, runId, 'uncertain OAR prompt admitted');
      const stopped = await h.runtime.orchestrator.interrupt(runId);
      assert.equal(stopped.status, 'interrupted');
      assert.equal(stopped.result?.outcomeCertainty, 'uncertain');
      assert.equal(h.runtime.pool.getLease(stopped.leaseId!)?.state, 'recovering');
      const recovery = await h.runtime.recovery.forLease(stopped.leaseId!);
      assert.equal(recovery?.runId, runId);
      assert.equal(fixture.runners[0]?.commands.filter(command => command.op === 'prompt').length, 1);
      assert.equal((await h.runtime.collaboration.listMessages()).filter(message =>
        message.author.kind === 'agent' && message.inReplyTo === delivered.message.id).length, 0);
    } finally {
      await app.h.close();
    }
  });

  test(`${runtimeId} OAR revocation protects an uncertain Task run without replay`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), `runtime-oar-revocation-${runtimeId}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const fixture = adapterFor(runtimeId, [{ abortMode: 'no-terminal' }], directory);
    const journalPath = join(directory, 'worker-recovery.json');
    const app = await setup(runtimeId, directory, fixture.adapter, journalPath);
    try {
      const { h, enrollmentId, project } = app;
      const task = await h.runtime.tasks.create({
        projectId: project.id, title: 'Revoked OAR Task', goal: 'Keep uncertain execution protected', assignedAgentId: 'scout',
      });
      const begun = await h.runtime.tasks.begin(task.id);
      const advance = await h.runtime.tasks.advance(task.id, { prompt: 'preserve this one OAR prompt' });
      await waitForOarPrompt(() => fixture.runners[0], h.runtime, advance.runId, 'revoked OAR Task prompt admitted');
      const originalIdentity = (await h.runtime.enrollments.get(enrollmentId))?.worker.identityDigest;
      assert.ok(originalIdentity);

      await h.runtime.enrollments.revoke(enrollmentId, 'synthetic OAR revocation');
      await waitFor(async () => (await h.runtime.recovery.forLease(begun.environmentLeaseId!)) !== undefined,
        'revocation recovery protects Task lease');
      await waitFor(async () => (await h.runtime.tasks.get(task.id))?.environmentLifecycleState === 'recovery',
        'revoked OAR Task enters recovery');
      await waitFor(() => (JSON.parse(readFileSync(journalPath, 'utf8')) as { engineStopped: boolean }).engineStopped,
        'revoked OAR process tree stop is journaled');

      const recovery = (await h.runtime.recovery.forLease(begun.environmentLeaseId!))!;
      const run = await h.runtime.orchestrator.load(advance.runId);
      assert.equal(recovery.workerIdentityDigest, originalIdentity);
      assert.equal(recovery.runId, advance.runId);
      assert.equal(run?.result?.outcomeCertainty, 'uncertain', 'revocation and process stop do not invent a native terminal event');
      assert.equal(h.runtime.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
      assert.equal(fixture.runners[0]?.commands.filter(command => command.op === 'prompt').length, 1);
      assert.equal(testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID), undefined);
    } finally {
      await app.h.close();
    }
  });
}
