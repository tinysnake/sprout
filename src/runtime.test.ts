/**
 * Composition-level acceptance for the testable Sprout runtime (#82).
 *
 * The point of `createSproutRuntime` is that the **complete** production object
 * graph — the same shape `src/main.ts` runs — is constructible in-process over
 * in-memory stores and a scripted engine port, with no host entrypoint, no
 * worker process, and no real engine. This file crosses exactly that caller-facing
 * seam and asserts the graph works end to end, not that a helper function was
 * called.
 *
 * Acceptance covered here:
 *
 * - The runtime graph is constructible with in-memory collaborators and scripted
 *   engine adapters.
 * - Reconciliation runs orphaned runs, then Task environment lifecycle, then the
 *   collaboration write path, and it is idempotent across a clean restart.
 * - A Message delivered through the real coordinator wakes the addressed Agent,
 *   a scripted run settles through the real orchestrator, and the final text is
 *   projected back as an Agent-authored reply — proving the graph is wired, not
 *   merely enumerated.
 * - Shutdown ends the Web surface, the environment port, and the store in the
 *   order the entry point used, and a scripted engine source needs no process.
 *
 * A `MissingEnvironmentEngineError` is also asserted: a misconfigured engine must
 * be refused at construction, before durable state is used, so the entry point
 * keeps its `exit(2)` startup behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AgentDefinition } from './agent/registry.ts';
import { InMemoryCollaborationStore } from './collaboration/store.ts';
import type { EngineAdapter, EngineSession, StartSessionRequest } from './engine/port.ts';
import { ScriptedEngineAdapter, type ScriptedTurn } from './engine/scripted.ts';
import { InMemoryLeaseStore } from './environment/pool.ts';
import type { HostConfiguration } from './host-config.ts';
import type { Project } from './project/model.ts';
import type { WorkerInfo } from './worker/protocol.ts';
import { InMemoryProjectStore } from './project/store.ts';
import { InMemorySessionKeyStore } from './run/session-key-store.ts';
import { InMemoryRunStore } from './run/store.ts';
import { InMemoryTaskStore } from './task/store.ts';
import { InMemoryOperatorSessionStore } from './auth/store.ts';
import { InMemoryEnrollmentStore } from './environment/enrollment-store.ts';
import { InMemoryEnvironmentReadinessStore } from './environment/readiness-store.ts';
import { InMemoryRecoveryStore } from './environment/recovery-store.ts';
import { InMemoryAgentStore } from './agent/store.ts';
import { InMemoryProjectAuthorityStore } from './project/authority-store.ts';
import { InMemoryProjectAccessStore } from './project/access-store.ts';
import { GENERAL_COLLABORATION_TEMPLATE as GENERAL_TEMPLATE } from './project/template.ts';
import { SchemaTooNewError } from './store/schema.ts';
import {
  createSproutRuntime,
  MissingEnvironmentEngineError,
  type RuntimeEnvironment,
  type RuntimeStores,
  type SproutRuntime,
  type TaskContextWorker,
} from './runtime.ts';

/** The environment instance this composition test serves. */
const INSTANCE_ID = 'composition-instance';
const PROJECT_ID = 'composition-project';

/** A complete typed host configuration for one synthetic local environment. */
function hostConfiguration(overrides: Partial<HostConfiguration> = {}): HostConfiguration {
  const configuration: HostConfiguration = {
    databasePath: ':memory:',
    workingDirectory: '/synthetic/work',
    port: 0,
    environmentInstanceId: INSTANCE_ID,
    engineId: 'scripted',
    runtimeConfiguration: {
      agents: [agent('scout'), agent('scribe')],
      project: project(),
    },
    environmentKind: 'local',
    containerName: 'synthetic-container',
    windowsTarget: undefined,
    windowsReadyFile: 'C:/synthetic/ready.json',
    containerMountRoot: '/synthetic/mount',
    containerCodexHome: '/synthetic/codex',
    containerProxy: {},
    windowsTunnelPort: 12741,
    windowsWorkDirectory: 'C:/synthetic/work',
    projectId: PROJECT_ID,
    leaseTtlMs: 900_000,
    operatorCredential: undefined,
  };
  return { ...configuration, ...overrides, operatorCredential: overrides.operatorCredential ?? configuration.operatorCredential };
}

function agent(id: string): AgentDefinition {
  return { id, name: id, engine: 'scripted', capability: 'agent-run' };
}

function project(): Project {
  return {
    id: PROJECT_ID,
    goal: 'Prove the runtime composition is reachable.',
    rules: [],
    availableEnvironmentInstanceIds: [INSTANCE_ID],
    memberships: [
      { agentId: 'scout', responsibilities: [], collaborationInstructions: '' },
      { agentId: 'scribe', responsibilities: [], collaborationInstructions: '' },
    ],
  };
}

/** All six per-domain in-memory stores behind one closable handle. */
interface MemoryStores extends RuntimeStores {
  readonly runsStore: InMemoryRunStore;
  readonly closes: () => number;
}

function inMemoryStores(): MemoryStores {
  const runs = new InMemoryRunStore();
  let closes = 0;
  return {
    runs,
    leases: new InMemoryLeaseStore(),
    projects: new InMemoryProjectStore(),
    sessionKeys: new InMemorySessionKeyStore(),
    collaboration: new InMemoryCollaborationStore(),
    tasks: new InMemoryTaskStore(),
    operatorSessions: new InMemoryOperatorSessionStore(),
    enrollments: new InMemoryEnrollmentStore(),
    environmentReadiness: new InMemoryEnvironmentReadinessStore(),
    recovery: new InMemoryRecoveryStore(),
    agentIdentities: new InMemoryAgentStore(),
    projectAuthorities: new InMemoryProjectAuthorityStore(),
    projectAccess: new InMemoryProjectAccessStore(),
    runsStore: runs,
    close: () => {
      closes += 1;
    },
    closes: () => closes,
  };
}

/** A scripted environment port that records its own lifecycle calls. */
interface ScriptedEnvironment extends RuntimeEnvironment {
  readonly closes: () => number;
}

function scriptedEnvironment(options: {
  readonly adapters: ReadonlyMap<string, EngineAdapter>;
  readonly contexts?: TaskContextWorker;
  /** When set, `adapters` rejects, modelling an unreachable worker. */
  readonly failAdapters?: string;
  /** A scripted workspace validator; defaults to an opaque acceptance. */
  readonly validateWorkspace?: RuntimeEnvironment['validateWorkspace'];
}): ScriptedEnvironment {
  let closes = 0;
  const contexts: TaskContextWorker = options.contexts ?? {
    async prepare() {
      return { bootstrapInstructions: '' };
    },
    async recycle() {
      return undefined;
    },
  };
  return {
    async adapters() {
      if (options.failAdapters !== undefined) throw new Error(options.failAdapters);
      return options.adapters;
    },
    async contexts() {
      return contexts;
    },
    async validateWorkspace(instanceId, input) {
      if (options.validateWorkspace !== undefined) return options.validateWorkspace(instanceId, input);
      // A stable hex digest-shaped opaque identity, as a real Worker returns.
      return {
        workspaceId: createHash('sha256')
          .update(`${instanceId}\u0000${input.projectId}\u0000${input.kind}\u0000${input.path ?? ''}`)
          .digest('hex')
          .slice(0, 24),
        kind: input.kind,
        ...(input.path !== undefined ? { path: input.path } : {}),
      };
    },
    async close() {
      closes += 1;
    },
    closes: () => closes,
  };
}

function scriptedTurn(text: string): ScriptedTurn {
  return {
    events: [{ type: 'message', text, final: true }],
    result: { status: 'completed', text },
  };
}

interface Built {
  readonly runtime: SproutRuntime;
  readonly stores: MemoryStores;
  readonly environment: ScriptedEnvironment;
}

async function build(
  options: {
    readonly turns?: readonly ScriptedTurn[];
    readonly configuration?: Partial<HostConfiguration>;
    readonly environment?: RuntimeEnvironment;
    /** Start the Web surface, as the host entrypoint does before reconciling. */
    readonly listen?: boolean;
  } = {},
): Promise<Built> {
  const stores = inMemoryStores();
  const environment =
    options.environment ??
    scriptedEnvironment({
      adapters: new Map([
        ['scripted', new ScriptedEngineAdapter({ turns: options.turns ?? [scriptedTurn('ok')] })],
      ]),
    });
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration(options.configuration),
    projectRoot: '/synthetic/project-root',
    environment,
    stores,
  });
  // The host entrypoint listens before reconciling and before installing
  // signals, so the composition is exercised in its started shape; the first
  // test opts out to observe the pre-listen boundary.
  if (options.listen !== false) await runtime.api.listen(0);
  return { runtime, stores, environment: environment as ScriptedEnvironment };
}

test('the complete runtime graph is constructible over in-memory collaborators and scripted engines', async () => {
  const { runtime, stores, environment } = await build({ listen: false });

  assert.equal(runtime.instance.id, INSTANCE_ID);
  assert.equal(runtime.definition.platform, 'macos');
  assert.deepEqual(runtime.agents.list().map((definition) => definition.id).sort(), ['scout', 'scribe']);
  assert.deepEqual(runtime.projects.list().map((registered) => registered.id), [PROJECT_ID]);
  assert.deepEqual([...runtime.engines.keys()], ['scripted']);
  assert.equal(runtime.stores, stores);

  // The Web transport is created but not listening until the caller asks, which
  // is the boundary the host entrypoint crosses with `listen`.
  assert.ok(runtime.api.server);
  assert.equal(runtime.api.server.listening, false);
  const { port } = await runtime.api.listen(0);
  assert.ok(port > 0);
  assert.equal(runtime.api.server.listening, true);

  // Construction started no worker and no engine process.
  assert.equal(environment.closes(), 0);

  await runtime.close();
  assert.equal(environment.closes(), 1);
  assert.equal(stores.closes(), 1);
});

test('a Message delivered to the graph wakes its Agent, runs the scripted engine, and projects a reply', async () => {
  const { runtime } = await build({ turns: [scriptedTurn('composition reply')] });

  const delivered = await runtime.collaboration.deliver({
    projectId: PROJECT_ID,
    channel: 'project',
    author: { id: 'human', kind: 'human' },
    body: '@scout please answer',
    deliveryKey: 'composition-delivery-1',
    awaitReply: true,
  });

  assert.equal(delivered.duplicate, false);
  assert.equal(delivered.admittedRunIds.length, 1);

  const run = await runtime.orchestrator.waitFor(delivered.admittedRunIds[0]!);
  assert.equal(run.status, 'completed');
  assert.equal(run.result?.status === 'completed' ? run.result.text : undefined, 'composition reply');

  // The final text was projected back as an Agent-authored Message, proving the
  // run layer, the persistence seam, and the coordinator are genuinely wired.
  const messages = await runtime.collaboration.listMessages();
  const projected = messages.filter(
    (message) => message.author.kind === 'agent' && message.body === 'composition reply',
  );
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.author.id, 'scout');

  await runtime.close();
});

test('reconciliation settles orphaned runs first and is idempotent across a clean restart', async () => {
  const { runtime } = await build({ turns: [scriptedTurn('first')] });

  // A prior process left a run mid-flight and durable; the composition must
  // settle it as failed before serving and must not fabricate a reply for it.
  await runtime.stores.runs.save({
    id: 'orphan-run',
    agentId: 'scout',
    prompt: 'left behind by a restart',
    environmentInstanceId: INSTANCE_ID,
    status: 'running',
    events: [],
    createdAt: 1,
  });

  const first = await runtime.reconcile();
  assert.deepEqual(
    first.recoveredRuns.map((run) => run.id),
    ['orphan-run'],
  );
  assert.equal(first.recoveredRuns[0]?.status, 'failed');
  assert.equal(first.recoveredRuns[0]?.result?.status, 'failed');
  assert.deepEqual(first.admittedRunIds, []);
  assert.deepEqual(first.projectedMessageIds, []);

  // No reply was fabricated for the orphaned run.
  assert.deepEqual(await runtime.collaboration.listMessages(), []);

  // A second clean pass changes nothing: reconciliation is idempotent.
  const second = await runtime.reconcile();
  assert.deepEqual(second.recoveredRuns, []);
  assert.deepEqual(second.admittedRunIds, []);
  assert.deepEqual(second.projectedMessageIds, []);

  await runtime.close();
});

test('reconciliation crosses every subsystem: runs, then Task lifecycle, then collaboration', async () => {
  const { runtime } = await build({ turns: [scriptedTurn('reply')] });
  const calls: string[] = [];

  // The three passes are separately owned; record that each one ran, in order,
  // by wrapping the delegation points with passthrough recorders.
  const runReconcile = runtime.orchestrator.reconcileOrphanedRuns.bind(runtime.orchestrator);
  runtime.orchestrator.reconcileOrphanedRuns = async () => {
    calls.push('runs');
    return runReconcile();
  };
  const taskReconcile = runtime.tasks.reconcileEnvironmentLifecycle.bind(runtime.tasks);
  runtime.tasks.reconcileEnvironmentLifecycle = async () => {
    calls.push('tasks');
    return taskReconcile();
  };
  const collaborationReconcile = runtime.collaboration.reconcile.bind(runtime.collaboration);
  runtime.collaboration.reconcile = async () => {
    calls.push('collaboration');
    return collaborationReconcile();
  };

  await runtime.reconcile();
  assert.deepEqual(calls, ['runs', 'tasks', 'collaboration']);

  await runtime.close();
});

test('close ends the Web surface, the environment port, and the store in that order', async () => {
  const { runtime, stores, environment } = await build();
  const order: string[] = [];

  const apiClose = runtime.api.close.bind(runtime.api);
  runtime.api.close = async () => {
    order.push('api');
    await apiClose();
  };
  const storeClose = stores.close;
  stores.close = () => {
    order.push('stores');
    storeClose();
  };
  const environmentClose = environment.close;
  environment.close = async () => {
    order.push('environment');
    return environmentClose();
  };

  await runtime.close();
  assert.deepEqual(order, ['api', 'environment', 'stores']);
  assert.equal(environment.closes(), 1);
  assert.equal(stores.closes(), 1);
});

test('a misconfigured engine is refused at construction, before durable state is used', async () => {
  const stores = inMemoryStores();
  const environment = scriptedEnvironment({
    adapters: new Map([['other-engine', new ScriptedEngineAdapter({ turns: [] })]]),
  });

  await assert.rejects(
    createSproutRuntime({
      configuration: hostConfiguration({ engineId: 'missing-engine' }),
      projectRoot: '/synthetic/project-root',
      environment,
      stores,
    }),
    (error: unknown) => {
      assert.ok(error instanceof MissingEnvironmentEngineError);
      assert.equal(error.engineId, 'missing-engine');
      assert.deepEqual(error.hostedEngineIds, ['other-engine']);
      assert.match(error.message, /does not host engine "missing-engine"/);
      return true;
    },
  );

  // The port was closed on the refused build; the injected store was never used.
  assert.equal(environment.closes(), 1);
  assert.equal(stores.closes(), 0);
});

test('an unreachable environment port is closed and rethrown rather than left running', async () => {
  const stores = inMemoryStores();
  const environment = scriptedEnvironment({
    adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
    failAdapters: 'worker unavailable',
  });

  await assert.rejects(
    createSproutRuntime({
      configuration: hostConfiguration(),
      projectRoot: '/synthetic/project-root',
      environment,
      stores,
    }),
    /worker unavailable/,
  );
  assert.equal(environment.closes(), 1);
});

test('a Task run is admitted through the composed graph and its context port', async () => {
  const prepared: string[] = [];
  const contexts: TaskContextWorker = {
    async prepare(input) {
      prepared.push(input.taskId);
      return { bootstrapInstructions: 'from the composed environment port' };
    },
    async recycle() {
      return undefined;
    },
  };
  const { runtime } = await build({
    turns: [scriptedTurn('task reply')],
    environment: scriptedEnvironment({
      adapters: new Map([
        ['scripted', new ScriptedEngineAdapter({ turns: [scriptedTurn('task reply')] })],
      ]),
      contexts,
    }),
  });

  const task = await runtime.tasks.create({
    projectId: PROJECT_ID,
    title: 'Composition Task',
    goal: 'Advance through the composed graph.',
    assignedAgentId: 'scout',
  });
  const begun = await runtime.tasks.begin(task.id, { agentId: 'scout' });
  // `begin` acquires the Task lease and materializes context, then leaves the
  // Task idle and ready for its first run.
  assert.equal(begun.environmentLifecycleState, 'idle');
  assert.ok(prepared.includes(task.id));

  const advanced = await runtime.tasks.advance(task.id, { agentId: 'scout' });
  assert.equal(advanced.task.environmentLifecycleState, 'running');
  const runs = await runtime.tasks.getWithRuns(task.id);
  assert.ok(runs);
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0]?.runId, advanced.runId);

  await runtime.close();
});

test('the startup report preserves the operator log contract, including conditional lines', async () => {
  const { runtime } = await build();

  // Before reconciliation the conditional lines are absent, exactly as before.
  const report = runtime.startupReport(41030);
  assert.equal(
    report,
    'Sprout listening on http://127.0.0.1:41030\n' +
      '  agent:      scout, scribe\n' +
      '  engine:     scripted (via environment worker)\n' +
      '  environment: composition-instance (macos, cwd /synthetic/work)\n' +
      '  database:   :memory:\n',
  );

  // A recovered run and a recovering lease add their lines, in the same order.
  await runtime.stores.runs.save({
    id: 'orphan-run',
    agentId: 'scout',
    prompt: 'left behind',
    environmentInstanceId: INSTANCE_ID,
    status: 'running',
    events: [],
    leaseId: 'lease-orphan',
    createdAt: 1,
  });
  await runtime.reconcile();
  const after = runtime.startupReport(41030);
  assert.match(after, /^ {2}recovered: {2}1 run\(s\) marked failed after restart: orphan-run$/m);

  await runtime.close();
});

test('scripted engine sessions are started per run, never by construction', async () => {
  const adapter = new ScriptedEngineAdapter({ turns: [scriptedTurn('counted')] });
  const requests: StartSessionRequest[] = [];
  const recording: EngineAdapter = {
    id: adapter.id,
    capabilities: adapter.capabilities,
    startSession(request: StartSessionRequest): Promise<EngineSession> {
      requests.push(request);
      return adapter.startSession(request);
    },
  };

  const { runtime } = await build({
    environment: scriptedEnvironment({ adapters: new Map([['scripted', recording]]) }),
  });

  assert.equal(requests.length, 0);
  const submitted = await runtime.orchestrator.submit({ agentId: 'scout', prompt: 'go' });
  await runtime.orchestrator.waitFor(submitted.id);
  assert.equal(requests.length, 1);

  await runtime.close();
});

test('runtime construction failure closes environment and worker resources without leaking', async () => {
  let environmentClosed = 0;
  const env: RuntimeEnvironment = {
    async adapters() {
      return new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]);
    },
    async contexts() {
      throw new Error('unused');
    },
    async close() {
      environmentClosed++;
    },
  };

  // 1. Missing engine closes environment
  await assert.rejects(
    () =>
      createSproutRuntime({
        configuration: hostConfiguration({ engineId: 'nonexistent-engine' }),
        projectRoot: '/synthetic/root',
        environment: env,
      }),
    (err: unknown) => err instanceof MissingEnvironmentEngineError,
  );
  assert.equal(environmentClosed, 1, 'environment must be closed on missing engine failure');

  // 2. Failure during store/project setup closes environment
  let storesClosed = 0;
  const failingStores: RuntimeStores = {
    runs: new InMemoryRunStore(),
    leases: new InMemoryLeaseStore(),
    projects: {
      async save() {},
      async get() {
        return undefined;
      },
      async list() {
        throw new Error('simulated store load failure');
      },
    },
    sessionKeys: new InMemorySessionKeyStore(),
    collaboration: new InMemoryCollaborationStore(),
    tasks: new InMemoryTaskStore(),
    operatorSessions: new InMemoryOperatorSessionStore(),
    enrollments: new InMemoryEnrollmentStore(),
    environmentReadiness: new InMemoryEnvironmentReadinessStore(),
    recovery: new InMemoryRecoveryStore(),
    agentIdentities: new InMemoryAgentStore(),
    projectAuthorities: new InMemoryProjectAuthorityStore(),
    projectAccess: new InMemoryProjectAccessStore(),
    close() {
      storesClosed++;
    },
  };

  await assert.rejects(
    () =>
      createSproutRuntime({
        configuration: hostConfiguration(),
        projectRoot: '/synthetic/root',
        environment: env,
        stores: failingStores,
      }),
    (err: unknown) => err instanceof Error && err.message.includes('simulated store load failure'),
  );
  assert.equal(environmentClosed, 2, 'environment must be closed on store/project setup failure');
  assert.equal(storesClosed, 1, 'the acquired store must be closed on setup failure');
});

test('a schema refusal after environment acquisition closes the worker before propagating', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-schema-refusal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'future-schema.db');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA user_version = 10; CREATE TABLE retained_data (id TEXT PRIMARY KEY);');
  database.close();

  let environmentClosed = 0;
  const environment: RuntimeEnvironment = {
    async adapters() {
      return new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]);
    },
    async contexts() {
      throw new Error('unused');
    },
    async close() {
      environmentClosed++;
    },
  };

  await assert.rejects(
    () =>
      createSproutRuntime({
        configuration: hostConfiguration({ databasePath }),
        projectRoot: '/synthetic/root',
        environment,
      }),
    (error: unknown) => error instanceof SchemaTooNewError,
  );
  assert.equal(environmentClosed, 1, 'the acquired worker is closed before a schema refusal escapes');
});

test('the composed runtime exposes durable enrollment and readiness through its router and SQLite store (#87)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-enrollment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'sprout.db');

  const environment = scriptedEnvironment({
    adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
  });
  // A real SQLite store, so this proves the enrollment domain is mounted on the
  // same durable handle as every other M2 domain rather than a test double.
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({ databasePath }),
    projectRoot: '/synthetic/project-root',
    environment,
  });
  try {
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID,
      displayName: 'Composed Environment',
      publicKey: 'composed-public-key',
      platform: 'macos',
      protocolVersion: '2.1',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    assert.equal(requested.enrollment.environmentInstanceId, INSTANCE_ID);

    await runtime.enrollments.approve(requested.enrollment.id, {
      capabilityPermissions: { 'agent-run': true },
    });
    const now = Date.now();
    // Only the engine this build's configured Agents actually run on is required,
    // so a single ready engine is a complete Environment.
    await runtime.enrollments.observeReadiness(requested.enrollment.id, {
      connection: { state: 'online', lastConfirmedAt: now },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
      ],
    });
    await runtime.enrollments.recordProbe(requested.enrollment.id, {
      at: now,
      latencyMs: 5,
      protocolOk: true,
      enginesOk: true,
      summary: 'ready',
    });

    const assembled = await runtime.enrollments.readiness(requested.enrollment.id);
    assert.equal(assembled.summary.level, 'green');
    assert.ok(assembled.summary.reason.length > 0);
    // The configured engine is the one required engine; no second engine is
    // fabricated as required by an empty configuration.
    assert.equal(
      assembled.readiness.engines.find((engine) => engine.engine === 'scripted')?.required,
      true,
    );
    assert.equal(
      assembled.readiness.engines.some((engine) => engine.engine === 'pi'),
      false,
      'no unconfigured engine is invented',
    );

    // The same composition serves the router over HTTP.
    const { port } = await runtime.api.listen(0);
    const listing = await fetch(`http://127.0.0.1:${port}/api/environments/enrollments`);
    assert.equal(listing.status, 401, 'the enrollment route stays behind the #84 auth boundary');
  } finally {
    await runtime.close();
  }
});

test('the runtime records the live Worker\'s declared readiness onto an approved enrollment without inventing facts (#87)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-worker-readiness-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'sprout.db');

  // The Worker reports what it verified: installed engines with honestly
  // unknown login and model state, exactly what `worker/info` now declares.
  const workerInfo: WorkerInfo = {
    pid: 4242,
    environmentInstanceId: INSTANCE_ID,
    engines: [],
    readiness: {
      protocolVersion: '2.1',
      engines: [
        { engine: 'scripted', installed: true, readiness: 'unknown', modelAvailability: 'unknown', models: [] },
      ],
    },
  };
  let infoReads = 0;
  const environment = {
    ...scriptedEnvironment({
      adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
    }),
    async info() {
      infoReads += 1;
      return workerInfo;
    },
  };
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({ databasePath }),
    projectRoot: '/synthetic/project-root',
    environment,
  });
  try {
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID,
      displayName: 'Composed Environment',
      publicKey: 'composed-public-key',
      platform: 'macos',
      protocolVersion: '2.1',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;

    // A pending enrollment is not observed: authority comes first.
    await runtime.observeWorkerReadiness(enrollmentId);
    assert.equal(infoReads, 0, 'no Worker info is read before approval');

    await runtime.enrollments.approve(enrollmentId, { capabilityPermissions: { 'agent-run': true } });
    await runtime.observeWorkerReadiness(enrollmentId);
    assert.equal(infoReads, 1);

    const assembled = await runtime.enrollments.readiness(enrollmentId);
    assert.equal(assembled.readiness.connection.state, 'online', 'a live Worker is an online connection fact');
    assert.equal(assembled.readiness.compatibility.state, 'compatible');
    const engine = assembled.readiness.engines[0];
    assert.equal(engine?.engine, 'scripted');
    assert.equal(engine?.installed, true, 'the Worker declared the engine installed');
    // The engine stayed honest: login and model availability were not verified,
    // so they remain unknown rather than being assumed ready.
    assert.equal(engine?.readiness, 'unknown');
    assert.equal(engine?.models.state, 'unknown');
    assert.equal(assembled.summary.level, 'red', 'an unknown required engine blocks work honestly');

    // A revoked enrollment stops being observed; the last approved observation
    // is never overwritten by an unapproved Worker.
    await runtime.enrollments.revoke(enrollmentId, 'rotated');
    await runtime.observeWorkerReadiness(enrollmentId);
    assert.equal(infoReads, 1, 'no Worker info is read after revocation');
  } finally {
    await runtime.close();
  }
});

test('a Message run records its admitted work option and configuration version (#90)', async () => {
  const { runtime } = await build({ turns: [scriptedTurn('option reply')] });

  const delivered = await runtime.collaboration.deliver({
    projectId: PROJECT_ID,
    channel: 'project',
    author: { id: 'human', kind: 'human' },
    body: '@scout please answer',
    deliveryKey: 'option-delivery-1',
    awaitReply: true,
  });
  assert.equal(delivered.admittedRunIds.length, 1);

  const run = await runtime.orchestrator.waitFor(delivered.admittedRunIds[0]!);
  assert.equal(run.status, 'completed', run.failure ?? 'run failed');
  // The run names the option it was admitted under: the definition-era agent
  // projects its single engine as one option, at configuration version 1.
  assert.deepEqual(run.workOption, {
    id: 'primary',
    engine: 'scripted',
    workModel: '',
    effort: '',
  });
  assert.equal(run.configurationVersion, 1);

  // The attribution is durable: the same facts come back from the store.
  const stored = await runtime.stores.runs.get(run.id);
  assert.equal(stored?.workOption?.engine, 'scripted');
  assert.equal(stored?.configurationVersion, 1);

  await runtime.close();
});

test('the Agent service composes over the shared durable store and archives safely (#90)', async () => {
  const { runtime, stores } = await build({ listen: false });

  // Create a portable Agent identity through the composed service.
  const agent = await runtime.agentService.create({
    id: 'programmer',
    displayName: 'Programmer',
    instructions: 'Check pure functions.',
    workOptions: [
      { id: 'opt-1', engine: 'scripted', workModel: 'glm-5', effort: 'medium' },
    ],
  });
  assert.equal(agent.status, 'active');
  assert.equal(agent.configuration.currentVersion, 1);
  assert.equal((await stores.agentIdentities.get('programmer'))?.displayName, 'Programmer');

  // Reconfigure: the version history appends, never rewrites.
  const updated = await runtime.agentService.reconfigure('programmer', {
    workOptions: [{ id: 'opt-1', engine: 'scripted', workModel: 'glm-5', effort: 'high' }],
    reason: 'raise effort',
  });
  assert.equal(updated.configuration.currentVersion, 2);
  assert.equal(updated.configuration.versions.length, 2);

  // Archive with no active work succeeds; restore brings the identity back.
  const archived = await runtime.agentService.archive('programmer');
  assert.equal(archived.status, 'archived');
  assert.equal((await runtime.agentService.get('programmer'))?.configuration.versions.length, 2);
  const restored = await runtime.agentService.restore('programmer');
  assert.equal(restored.status, 'active');

  await runtime.close();
});

test('the Project authority service composes over the shared durable store with active-work safety (#92)', async () => {
  const { runtime, stores } = await build({ listen: false });

  // Create a durable Project: only a name is required, the Human membership
  // and template snapshot are implicit, and missing resources do not
  // invalidate identity. A membership must name a real Agent authority: the
  // definition-era seed ('scout') or a durable #90 identity (F5). An invented
  // member id is refused.
  await assert.rejects(
    () =>
      runtime.projectService.create({
        id: 'project-ghost',
        displayName: 'Ghost member',
        agentMemberships: [{ agentId: 'agent-ghost' }],
      }),
    (error: unknown) => error instanceof Error && error.message.includes('agent-ghost'),
  );
  const project = await runtime.projectService.create({
    id: 'project-graph',
    displayName: 'Composed Project',
    goal: 'Prove the graph',
    agentMemberships: [{ agentId: 'scout', responsibilities: ['Investigate'] }],
  });
  assert.equal(project.status, 'active');
  assert.equal(project.template.templateVersion, 1);
  assert.equal((await stores.projectAuthorities.get('project-graph'))?.displayName, 'Composed Project');

  // Membership ending and archive go through the same composed safety port
  // the runs and Tasks own, so a quiet member can end but the composed record
  // keeps every version.
  const ended = await runtime.projectService.endMembership('project-graph', 'scout', {
    reason: 'test end',
  });
  assert.ok(ended.content.versions.at(-1)?.memberships.find((m) => m.memberId === 'scout')?.endedAt);
  const archived = await runtime.projectService.archive('project-graph', { reason: 'test archive' });
  assert.equal(archived.status, 'archived');
  await assert.rejects(
    () => runtime.projectService.updateContent('project-graph', { goal: 'x' }),
    (error: unknown) =>
      error instanceof Error && error.message.includes('read-only'),
  );
  const restored = await runtime.projectService.restore('project-graph');
  assert.equal(restored.status, 'active');

  // A durable archived lifecycle record wins over a same-id configured seed:
  // legacy existence cannot make an inactive Agent eligible for membership.
  await runtime.agentService.create({
    id: 'scout',
    displayName: 'Scout authority',
    workOptions: [{ engine: 'scripted', workModel: 'test-model', effort: 'medium' }],
  });
  await runtime.agentService.archive('scout');
  await assert.rejects(
    () => runtime.projectService.addMembership('project-graph', { agentId: 'scout' }),
    (error: unknown) => error instanceof Error && error.message.includes('active portable Agent'),
  );

  await runtime.close();
});

test('the composed Project router serves the authority contract after the auth boundary (#92)', async () => {
  const credential = 'composed-runtime-test-credential';
  const { runtime } = await build({ configuration: { operatorCredential: credential }, listen: false });
  const { port } = await runtime.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    // Sign in as the Operator: the one Human authority.
    const signIn = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(signIn.status, 201);
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = (await signIn.json()) as { csrfToken: string };

    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-sprout-csrf': csrfToken },
      body: JSON.stringify({ id: 'project-http', displayName: 'Over HTTP' }),
    });
    assert.equal(created.status, 201);
    const listed = (await (
      await fetch(`${base}/api/projects/authorities`, { headers: { cookie } })
    ).json()) as { projects: { id: string; memberIds: string[] }[] };
    assert.ok(listed.projects.some((entry) => entry.id === 'project-http'));
  } finally {
    await runtime.api.close();
    await runtime.close();
  }
});

test('the authority bridge keeps GET compatibility without inventing execution access and archive removes routing (#92, F1)', async () => {
  const credential = 'composed-runtime-test-credential';
  const { runtime } = await build({
    turns: [scriptedTurn('bridged reply')],
    configuration: { operatorCredential: credential },
    listen: false,
  });
  const { port } = await runtime.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const signIn = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(signIn.status, 201);
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = (await signIn.json()) as { csrfToken: string };
    const headers = { cookie, 'content-type': 'application/json', 'x-sprout-csrf': csrfToken };

    // The configured legacy Project does not disappear behind the authority
    // route: the merged listing still carries it with its composer fields.
    const legacyListed = (await (
      await fetch(`${base}/api/projects`, { headers: { cookie } })
    ).json()) as { projects: { id: string; goal: string; memberIds: string[] }[] };
    assert.ok(
      legacyListed.projects.some((entry) => entry.id === PROJECT_ID && entry.goal.length > 0),
      'the configured legacy Project must stay visible on GET /api/projects',
    );

    // A durable authority Project with the same id as the configured one wins
    // the shared identity: one stable Project, never a fork.
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: PROJECT_ID, displayName: 'Authority version' }),
    });
    assert.equal(created.status, 201);
    const afterCreate = (await (
      await fetch(`${base}/api/projects`, { headers: { cookie } })
    ).json()) as { projects: { id: string; goal: string }[] };
    const sameId = afterCreate.projects.filter((entry) => entry.id === PROJECT_ID);
    assert.equal(sameId.length, 1, 'a shared id resolves to one Project, not two');
    assert.equal(sameId[0]?.goal, GENERAL_TEMPLATE.goalGuidance);

    // The new authority Project's channel routes exact mentions after creation,
    // but no durable Environment access exists yet. The bridge must not invent
    // the configured runtime Environment as an execution grant.
    const configuredAgent = runtime.agents.list().some((agent) => agent.id === 'scout');
    assert.ok(configuredAgent);
    const authorityProject = await runtime.projectService.create({
      id: 'project-channel-live',
      displayName: 'Channel live',
    });
    // Mirror-on-change already ran; the registry resolves it.
    assert.ok(runtime.projects.get('project-channel-live'));
    // An Agent membership on the authority Project must name a real Agent
    // authority: the definition-era seed or a durable #90 identity (F5).
    await assert.rejects(
      () => runtime.projectService.addMembership('project-channel-live', { agentId: 'agent-ghost' }),
    );
    await runtime.projectService.addMembership('project-channel-live', { agentId: 'scout' });
    assert.deepEqual(
      runtime.projects.get('project-channel-live')?.availableEnvironmentInstanceIds,
      [],
      'an authority Project with no durable Environment grant is not executable',
    );
    const delivered = await runtime.collaboration.deliver({
      projectId: authorityProject.id,
      channel: 'project',
      author: { id: 'human', kind: 'human' },
      body: '@scout answer on the new channel',
      deliveryKey: 'bridge-delivery-1',
      awaitReply: true,
    });
    assert.equal(delivered.admittedRunIds.length, 1, 'the new Project channel must wake its member');
    const run = await runtime.orchestrator.waitFor(delivered.admittedRunIds[0]!);
    assert.equal(run.status, 'failed');
    assert.match(run.failure ?? '', /available environment/i);

    await runtime.projectService.archive('project-channel-live');
    assert.equal(runtime.projects.get('project-channel-live'), undefined);
    const afterArchive = (await (
      await fetch(`${base}/api/projects`, { headers: { cookie } })
    ).json()) as { projects: { id: string }[] };
    assert.equal(
      afterArchive.projects.some((entry) => entry.id === 'project-channel-live'),
      false,
      'the preserved #85 GET route must not expose archived authority Projects',
    );
    const archivedStatusList = (await (
      await fetch(`${base}/api/projects?status=archived`, { headers: { cookie } })
    ).json()) as { projects: { id: string }[] };
    assert.equal(archivedStatusList.projects.some((entry) => entry.id === 'project-channel-live'), false);
    const archivedDelivery = await runtime.collaboration.deliver({
      projectId: authorityProject.id,
      channel: 'project',
      author: { id: 'human', kind: 'human' },
      body: '@scout must not wake after archive',
      deliveryKey: 'bridge-delivery-archived',
      awaitReply: true,
    });
    assert.deepEqual(archivedDelivery.admittedRunIds, []);
  } finally {
    await runtime.api.close();
    await runtime.close();
  }
});

test('archive refuses while recovery still owns the Environment behind a recovering lease (#92, F3)', async () => {
  const { runtime } = await build({ listen: false });

  // A prior process left a run mid-flight holding a lease; a restart marks
  // the run failed but the lease stays `recovering` until recovery resolves
  // it (the orchestrator marks a stored lease recovering on reconciliation).
  runtime.stores.leases.save({
    id: 'lease-orphan-1',
    instanceId: INSTANCE_ID,
    capability: 'agent-run',
    holderId: 'orphan-lease-run',
    runId: 'orphan-lease-run',
    acquiredAt: 1,
    expiresAt: 10_000_000,
    state: 'active',
  });
  await runtime.stores.runs.save({
    id: 'orphan-lease-run',
    agentId: 'scout',
    prompt: 'left behind by a restart',
    environmentInstanceId: INSTANCE_ID,
    projectId: PROJECT_ID,
    status: 'running',
    leaseId: 'lease-orphan-1',
    events: [],
    createdAt: 1,
  });
  const recovered = await runtime.reconcile();
  assert.deepEqual(recovered.recoveredRuns.map((run) => run.id), ['orphan-lease-run']);

  // The lease is held in recovery after reconciliation.
  const recovering = runtime.pool.leases().filter((lease) => lease.state === 'recovering');
  assert.equal(recovering.length, 1);

  // A durable authority Project over the same id must refuse archive: the
  // lease check sees the orphaned run's recovering lease, even though no
  // queued/running run row and no unfinished Task row remain (F3).
  await runtime.projectService.create({ id: PROJECT_ID, displayName: 'Lease gated' });
  await assert.rejects(
    () => runtime.projectService.archive(PROJECT_ID),
    (error: unknown) => error instanceof Error && error.message.includes('Environment lease'),
  );

  await runtime.close();
});

test('the composed Project access capability grants a validated workspace and gates change on active work (#93)', async () => {
  const { runtime } = await build({ listen: false });

  // Access names a durable authority Project and only an approved enrollment: a
  // bare instance id is never a grant, exactly like membership never names an
  // invented Agent.
  await runtime.projectService.create({ id: 'project-access-graph', displayName: 'Access graph' });
  await assert.rejects(
    () =>
      runtime.projectAccess.grant({
        projectId: 'project-access-graph',
        environmentInstanceId: INSTANCE_ID,
        selection: { kind: 'default' },
      }),
    (error: unknown) =>
      error instanceof Error && error.message.includes('approved Environment enrollment'),
  );

  const requested = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: INSTANCE_ID,
    displayName: 'Composed Environment',
    publicKey: 'composed-public-key',
    platform: 'macos',
    protocolVersion: '2.1',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  await runtime.enrollments.approve(requested.enrollment.id, {
    capabilityPermissions: { 'agent-run': true },
  });

  const granted = await runtime.projectAccess.grant({
    projectId: 'project-access-graph',
    environmentInstanceId: INSTANCE_ID,
    selection: { kind: 'relative', path: 'repos/sprout' },
    reason: 'initial repository',
  });
  assert.equal(granted.status, 'active');
  assert.equal(granted.current?.path, 'repos/sprout');
  // The Worker validated before anything durable; the absolute location never
  // crosses the boundary.
  assert.ok(!JSON.stringify(granted).includes('/Users/'));

  // The grant republishes the M1 projection, so the Project becomes executable.
  assert.deepEqual(runtime.projects.get('project-access-graph')?.availableEnvironmentInstanceIds, [INSTANCE_ID]);
  assert.deepEqual(runtime.projects.get('project-access-graph')?.workspaces, [
    { environmentInstanceId: INSTANCE_ID, path: 'repos/sprout' },
  ]);

  // An active run on the Environment blocks both the workspace change and the
  // access end, and a refused change records nothing.
  runtime.pool.adoptLease({
    id: 'lease-active-work',
    instanceId: INSTANCE_ID,
    capability: 'agent-run',
    holderId: 'scout',
    holderKind: 'run',
    runId: 'missing-run',
    acquiredAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    state: 'active',
  });
  await assert.rejects(
    () =>
      runtime.projectAccess.changeWorkspace({
        projectId: 'project-access-graph',
        environmentInstanceId: INSTANCE_ID,
        selection: { kind: 'relative', path: 'repos/other' },
      }),
    (error: unknown) => error instanceof Error && error.message.includes('active work'),
  );
  await assert.rejects(
    () =>
      runtime.projectAccess.end({
        projectId: 'project-access-graph',
        environmentInstanceId: INSTANCE_ID,
      }),
    (error: unknown) => error instanceof Error && error.message.includes('active work'),
  );
  assert.equal(
    (await runtime.projectAccess.get('project-access-graph', INSTANCE_ID))?.current?.path,
    'repos/sprout',
    'a refused change leaves the binding untouched',
  );

  // Once the work settles, the change appends a binding and the old binding is
  // retained unbound; the projection follows the current binding.
  runtime.pool.releaseLease('lease-active-work');
  const changed = await runtime.projectAccess.changeWorkspace({
    projectId: 'project-access-graph',
    environmentInstanceId: INSTANCE_ID,
    selection: { kind: 'relative', path: 'repos/other' },
    reason: 'moved',
  });
  assert.equal(changed.history.length, 2);
  assert.equal(changed.history.filter((binding) => binding.unboundAt === undefined).length, 1);
  assert.deepEqual(runtime.projects.get('project-access-graph')?.workspaces, [
    { environmentInstanceId: INSTANCE_ID, path: 'repos/other' },
  ]);

  // Ending access removes the Environment from the projection but keeps the
  // relationship and its binding history.
  const ended = await runtime.projectAccess.end({
    projectId: 'project-access-graph',
    environmentInstanceId: INSTANCE_ID,
    reason: 'retired',
  });
  assert.equal(ended.status, 'ended');
  assert.equal(ended.current, undefined);
  assert.equal(ended.history.length, 2);
  assert.deepEqual(
    runtime.projects.get('project-access-graph')?.availableEnvironmentInstanceIds,
    [],
    'an ended access is no longer an execution grant',
  );

  await runtime.close();
});

test('archive and restore fail closed for live leases whose run or Task owner row is missing (#92, F3)', async () => {
  const { runtime } = await build({ listen: false });
  await runtime.projectService.create({ id: 'project-orphan-guard', displayName: 'Orphan guard' });

  runtime.pool.adoptLease({
    id: 'lease-missing-run',
    instanceId: INSTANCE_ID,
    capability: 'agent-run',
    holderId: 'missing-run',
    holderKind: 'run',
    runId: 'missing-run',
    acquiredAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    state: 'active',
  });
  await assert.rejects(
    () => runtime.projectService.archive('project-orphan-guard'),
    (error: unknown) => error instanceof Error && error.message.includes('Environment lease'),
  );

  runtime.pool.releaseLease('lease-missing-run');
  await runtime.projectService.archive('project-orphan-guard');
  runtime.pool.adoptLease({
    id: 'lease-missing-task',
    instanceId: INSTANCE_ID,
    capability: 'agent-run',
    holderId: 'missing-task',
    holderKind: 'task',
    taskId: 'missing-task',
    acquiredAt: 2,
    expiresAt: Number.MAX_SAFE_INTEGER,
    state: 'recovering',
  });
  await assert.rejects(
    () => runtime.projectService.restore('project-orphan-guard'),
    (error: unknown) => error instanceof Error && error.message.includes('Environment lease'),
  );

  await runtime.close();
});

/**
 * The durable binding composition (ADR-0008): a run admitted over the composed
 * graph persists the exact binding facts its access record held at admission,
 * and a later workspace change cannot rewrite that history.
 */
test('a composed run records the durable workspace binding it was admitted under (#93)', async () => {
  const { runtime } = await build({
    turns: [scriptedTurn('composition reply')],
  });
  await runtime.projectService.create({ id: 'project-bound', displayName: 'Bound' });
  const requested = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: INSTANCE_ID,
    displayName: 'Bound Environment',
    publicKey: 'bound-public-key',
    platform: 'macos',
    protocolVersion: '2.1',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  await runtime.enrollments.approve(requested.enrollment.id, {
    capabilityPermissions: { 'agent-run': true },
  });
  await runtime.projectAccess.grant({
    projectId: 'project-bound',
    environmentInstanceId: INSTANCE_ID,
    selection: { kind: 'relative', path: 'repos/sprout' },
  });
  await runtime.projectService.addMembership('project-bound', { agentId: 'scout' });

  const { id } = await runtime.orchestrator.submit({
    agentId: 'scout',
    prompt: 'inspect the bound workspace',
    projectId: 'project-bound',
  });
  const run = await runtime.orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  const durable = await runtime.stores.projectAccess.get('project-bound', INSTANCE_ID);
  assert.deepEqual(
    run.workspaceBinding,
    {
      bindingId: durable?.current?.bindingId,
      workspaceId: durable?.current?.workspaceId,
      kind: 'relative',
      path: 'repos/sprout',
    },
    'the run carries the durable binding facts, not a re-derivation',
  );
  const stored = await runtime.stores.runs.get(id);
  assert.deepEqual(stored?.workspaceBinding, run.workspaceBinding, 'the binding survives a restart');

  // A later change appends a new binding for future runs; the historical run
  // still names the binding it used.
  await runtime.projectAccess.changeWorkspace({
    projectId: 'project-bound',
    environmentInstanceId: INSTANCE_ID,
    selection: { kind: 'relative', path: 'repos/moved' },
  });
  const after = await runtime.stores.projectAccess.get('project-bound', INSTANCE_ID);
  assert.equal(after?.history.length, 2);
  assert.equal(after?.current?.path, 'repos/moved');
  const historical = (await runtime.stores.runs.get(id))?.workspaceBinding;
  assert.equal(historical?.path, 'repos/sprout', 'history is not rewritten by the change');
  assert.equal(historical?.bindingId, durable?.current?.bindingId);

  await runtime.close();
});
