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
import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import { createPendingEnrollment } from './environment/enrollment.ts';
import { workerIdentityDigest } from './environment/enrollment-identity.ts';
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
import { InMemoryEnvironmentCatalogStore } from './environment/catalog-store.ts';
import { InMemoryEnvironmentReadinessStore } from './environment/readiness-store.ts';
import { InMemoryWorkerConnectionEpochStore } from './environment/worker-epoch-store.ts';
import { InMemoryRecoveryStore } from './environment/recovery-store.ts';
import { InMemoryAgentStore } from './agent/store.ts';
import { InMemoryProjectAuthorityStore } from './project/authority-store.ts';
import { InMemoryProjectAccessStore } from './project/access-store.ts';
import { resolveEnvironmentInstance } from './project/resolve.ts';
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

function readinessAuthority(runtime: SproutRuntime, enrollmentId: string, connectionEpoch: number) {
  return {
    enrollmentId,
    connectionEpoch,
    isCurrent: () => runtime.workerEpochs.current(enrollmentId)?.epoch === connectionEpoch,
  };
}

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
    environmentSource: 'configured',
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
    environmentCatalog: new InMemoryEnvironmentCatalogStore(),
    environmentReadiness: new InMemoryEnvironmentReadinessStore(),
    workerConnectionEpochs: new InMemoryWorkerConnectionEpochStore(),
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

  assert.equal(runtime.instance?.id, INSTANCE_ID);
  assert.equal(runtime.definition?.platform, 'macos');
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
    environmentCatalog: new InMemoryEnvironmentCatalogStore(),
    environmentReadiness: new InMemoryEnvironmentReadinessStore(),
    workerConnectionEpochs: new InMemoryWorkerConnectionEpochStore(),
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
  database.exec('PRAGMA user_version = 15; CREATE TABLE retained_data (id TEXT PRIMARY KEY);');
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
    const epoch = runtime.workerEpochs.accept(requested.enrollment.id);
    // Only the engine this build's configured Agents actually run on is required,
    // so a single ready engine is a complete Environment.
    await runtime.enrollments.observeReadiness(requested.enrollment.id, {
      connection: { state: 'online', lastConfirmedAt: now },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
      ],
    }, readinessAuthority(runtime, requested.enrollment.id, epoch.epoch), {
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

test('the runtime refuses to observe readiness without an accepted Worker epoch (#87)', async (t) => {
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
    assert.equal(infoReads, 0, 'approval alone cannot mint Worker observation authority');

    const assembled = await runtime.enrollments.readiness(enrollmentId);
    assert.equal(assembled.readiness.connection.state, 'never-connected');
    assert.equal(assembled.readiness.compatibility.state, 'unknown');
    const engine = assembled.readiness.engines[0];
    assert.equal(engine?.engine, 'scripted');
    assert.equal(engine?.installed, false, 'no accepted epoch means no executable fact');
    assert.equal(engine?.readiness, 'unknown');
    assert.equal(engine?.models.state, 'unknown');
    assert.equal(assembled.summary.level, 'red', 'an unknown required engine blocks work honestly');

    // A revoked enrollment stops being observed; the last approved observation
    // is never overwritten by an unapproved Worker.
    await runtime.enrollments.revoke(enrollmentId, 'rotated');
    await runtime.observeWorkerReadiness(enrollmentId);
    assert.equal(infoReads, 0, 'no Worker info is read after revocation');
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

  // A corrupt legacy durable access document bypasses the ordinary access
  // service. Runtime admission must still reject its traversal location before
  // it becomes a new AgentRun record or reaches the Worker request.
  assert.ok(after?.current);
  await runtime.stores.projectAccess.save({
    ...after,
    current: { ...after.current, path: '../corrupt-binding' },
    history: after.history.map((binding) =>
      binding.bindingId === after.current?.bindingId
        ? { ...binding, path: '../corrupt-binding' }
        : binding,
    ),
  });
  const corruptSubmission = await runtime.orchestrator.submit({
    agentId: 'scout', prompt: 'do not leak the corrupt workspace', projectId: 'project-bound',
  });
  const corruptRun = await runtime.orchestrator.waitFor(corruptSubmission.id);
  assert.equal(corruptRun.status, 'completed');
  assert.equal(corruptRun.workspaceBinding, undefined);
  assert.equal(
    JSON.stringify(await runtime.stores.runs.get(corruptSubmission.id)).includes('../corrupt-binding'),
    false,
    'the raw durable corruption is neither run history nor a Worker-bound fact',
  );

  await runtime.close();
});

/**
 * The composed runtime mounts the enrollment-backed outbound Worker gateway
 * (#115, ADR-0012).
 *
 * The pending enrollment, its one-use claim, the machine claim route, and the
 * epoch registry are all present on the one runtime object, so a host Worker can
 * connect without the core ever dialing it.
 */
test('the composed runtime exposes the outbound Worker gateway and its epoch registry (#115)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-gateway-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = scriptedEnvironment({
    adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
  });
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({ databasePath: join(directory, 'sprout.db') }),
    projectRoot: '/synthetic/project-root',
    environment,
  });
  try {
    assert.notEqual(runtime.workerGateway, undefined);
    assert.equal(runtime.workerEpochs, runtime.workerGateway.epochs);
    assert.notEqual(runtime.enrollmentEnvironment, undefined);

    // A Web-created pending enrollment carries a one-use claim, and the machine
    // claim route consumes it without a browser cookie.
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID,
      displayName: 'Outbound Environment',
      platform: 'macos',
      capabilityRequests: ['agent-run'],
      engineFacts: [],
    });
    const secret = requested.claim?.secret ?? '';
    assert.notEqual(secret, '');
    const { port } = await runtime.api.listen(0);
    const claimed = await fetch(
      `http://127.0.0.1:${port}/api/worker/enrollments/${encodeURIComponent(requested.enrollment.id)}/claim`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimSecret: secret }),
      },
    );
    assert.equal(claimed.status, 200);
    assert.equal(claimed.headers.get('set-cookie'), null, 'the machine route sets no Human cookie');
  } finally {
    await runtime.close();
  }
});

/**
 * The enrollment source is the production execution seam (ADR-0012, #115 review
 * finding 5).
 *
 * Under `SPROUT_ENV_SOURCE=enrollment` the runtime does not construct or dial the
 * M1 configured carrier at all: production execution enters through the accepted
 * enrollment-backed port. The configured source stays available for tests and the
 * container carrier, and the two are mutually exclusive so a deployment cannot
 * silently retain a second production path.
 */
test('the enrollment environment source composes without a configured carrier', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-enrollment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
    stores: inMemoryStores(),
  });
  try {
    assert.equal(runtime.environmentSource, 'enrollment');
    assert.equal(runtime.engines.size, 0, 'no configured Worker is started or dialed');
    assert.notEqual(runtime.enrollmentEnvironment, undefined);
    assert.equal(runtime.definition, undefined, 'no static configured definition exists under enrollment');
    assert.equal(runtime.instance, undefined, 'no static configured instance exists under enrollment');
    assert.equal(runtime.environmentCatalog.entries().length, 0, 'production starts with zero Environments');
    // A run cannot resolve a Worker before an instance is enrolled and eligible:
    // the catalog gate fails closed rather than dialing the Sprout host.
    const submitted = await runtime.orchestrator.submit({ agentId: 'scout', prompt: 'go' });
    const run = await runtime.orchestrator.waitFor(submitted.id);
    assert.equal(run.status, 'failed');
    assert.match(run.failure ?? '', /no available environment for capability/);
  } finally {
    await runtime.close();
  }
});

/**
 * E2 (#116): enrolled Environments are the dynamic execution catalog.
 *
 * These composition tests cross the real `createSproutRuntime` graph under the
 * production `enrollment` source. They prove the catalog is durable and dynamic,
 * that only eligible instances admit work, that an authenticated inbound
 * connection never causes production Worker dialing, and that the Project access,
 * execution, and lease seams resolve the same catalog instance.
 */
test('production starts with zero Environments and admits an enrolled instance without restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credential = 'e2-catalog-credential';
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
      operatorCredential: credential,
    }),
    projectRoot: '/synthetic/project-root',
  });

  try {
    // Production starts and serves authenticated Web with zero Environment
    // instances.
    assert.equal(runtime.environmentCatalog.entries().length, 0);
    assert.deepEqual(runtime.pool.leases(), []);
    const { port } = await runtime.api.listen(0);
    assert.ok(port > 0);
    const base = `http://127.0.0.1:${port}`;
    const signIn = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(signIn.status, 201, 'authenticated Web serves with zero Environments');
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const listing = await fetch(`${base}/api/environments/enrollments`, { headers: { cookie } });
    assert.equal(listing.status, 200);
    assert.deepEqual(((await listing.json()) as { enrollments: unknown[] }).enrollments, []);

    // A Human creates and approves a pending enrollment with a pre-proven
    // identity; no Worker is dialed by the core.
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'enrolled-host-1',
      displayName: 'Enrolled Host One',
      publicKey: 'host-public-key-1',
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;
    await runtime.enrollments.approve(enrollmentId, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    // The instance is a durable catalog entry even before any connection, and
    // the write API cannot mint unscoped readiness to make it eligible.
    await runtime.refreshEnvironmentCatalog();
    const entry = runtime.environmentCatalog.entry('enrolled-host-1');
    assert.ok(entry !== undefined);
    assert.equal(entry.eligible, false, 'no accepted epoch yet admits nothing');
    assert.equal(
      (await runtime.stores.environmentCatalog.get('enrolled-host-1'))?.enrollmentId,
      enrollmentId,
    );

    // A current, authenticated connection and facts from that exact epoch are
    // required; production admits it without a restart.
    const epoch = runtime.workerEpochs.accept(enrollmentId);
    await runtime.enrollments.observeReadiness(enrollmentId, {
      connectionEpoch: epoch.epoch,
      connection: { state: 'online', lastConfirmedAt: Date.now() },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
      ],
    }, readinessAuthority(runtime, enrollmentId, epoch.epoch));
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('enrolled-host-1')?.eligible, true);
    await runtime.refreshEnvironmentCatalog();
  } finally {
    await runtime.close();
  }
});

/** A helper that enrolls, approves, and makes eligible one instance. */
async function enrollEligibleInstance(
  runtime: SproutRuntime,
  instanceId: string,
  publicKey: string,
): Promise<string> {
  const requested = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: instanceId,
    displayName: instanceId,
    publicKey,
    platform: 'macos',
    capabilityRequests: [ADMISSION_CAPABILITY],
    engineFacts: [],
  });
  const enrollmentId = requested.enrollment.id;
  await runtime.enrollments.approve(enrollmentId, {
    capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
  });
  const epoch = runtime.workerEpochs.accept(enrollmentId);
  await runtime.enrollments.observeReadiness(enrollmentId, {
    connectionEpoch: epoch.epoch,
    connection: { state: 'online', lastConfirmedAt: Date.now() },
    compatibility: { state: 'compatible', workerProtocolVersion: '2' },
    engines: [
      { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
    ],
  }, readinessAuthority(runtime, enrollmentId, epoch.epoch));
  await runtime.refreshEnvironmentCatalog();
  return enrollmentId;
}

test('E2: a durable enrollment alone does not admit work; a current epoch and required facts do', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-eligibility-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'host-a',
      displayName: 'Host A',
      publicKey: 'host-a-key',
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;
    await runtime.enrollments.approve(enrollmentId, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    await runtime.refreshEnvironmentCatalog();
    // Approved, but no connection and no required readiness facts: catalog
    // entry present, not eligible.
    assert.ok(runtime.environmentCatalog.entry('host-a') !== undefined);
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);

    // A current epoch with no required readiness is still ineligible.
    const emptyEpoch = runtime.workerEpochs.accept(enrollmentId);
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);

    // Establishing the required readiness fact makes it eligible dynamically.
    await runtime.enrollments.observeReadiness(enrollmentId, {
      connectionEpoch: emptyEpoch.epoch,
      connection: { state: 'online', lastConfirmedAt: Date.now() },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
      ],
    }, readinessAuthority(runtime, enrollmentId, emptyEpoch.epoch));
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, true);
  } finally {
    await runtime.close();
  }
});

test('E2: two eligible instances stay independent and a lease conflict is observable', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-multi-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
    // Deterministic lease identity so the conflict is asserted precisely.
  });
  try {
    await enrollEligibleInstance(runtime, 'host-a', 'key-a');
    await enrollEligibleInstance(runtime, 'host-b', 'key-b');
    assert.deepEqual(
      [...runtime.environmentCatalog.eligibleInstanceIds()].sort(),
      ['host-a', 'host-b'],
    );

    const first = runtime.pool.acquireLease({
      instanceId: 'host-a',
      capability: ADMISSION_CAPABILITY,
      holderId: 'scout',
      runId: 'run-a',
      ttlMs: 60_000,
    });
    assert.equal(first.ok, true);
    const conflict = runtime.pool.acquireLease({
      instanceId: 'host-a',
      capability: ADMISSION_CAPABILITY,
      holderId: 'scribe',
      runId: 'run-b',
      ttlMs: 60_000,
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.reason, 'conflict');
    // The second instance is untouched by the first lease.
    const other = runtime.pool.acquireLease({
      instanceId: 'host-b',
      capability: ADMISSION_CAPABILITY,
      holderId: 'scribe',
      runId: 'run-c',
      ttlMs: 60_000,
    });
    assert.equal(other.ok, true);
  } finally {
    await runtime.close();
  }
});

test('E2: a disconnected instance loses eligibility but keeps its catalog record and lease', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-disconnect-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const enrollmentId = await enrollEligibleInstance(runtime, 'host-a', 'key-a');
    const lease = runtime.pool.acquireLease({
      instanceId: 'host-a',
      capability: ADMISSION_CAPABILITY,
      holderId: 'scout',
      runId: 'run-a',
      ttlMs: 60_000,
    });
    assert.equal(lease.ok, true);

    // The accepted connection ends: the epoch is invalidated and the catalog is
    // re-projected. The record and the active lease survive; the instance stops
    // admitting new work.
    runtime.workerEpochs.invalidate(enrollmentId, runtime.workerEpochs.current(enrollmentId)!.connectionId);
    await runtime.refreshEnvironmentCatalog();
    assert.ok(runtime.environmentCatalog.entry('host-a') !== undefined, 'offline never deletes');
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    assert.equal(runtime.pool.requiresLease('host-a', ADMISSION_CAPABILITY), undefined);
    if (lease.ok) assert.equal(runtime.pool.getLease(lease.lease.id)?.state, 'active');

    // A newer epoch cannot reuse old readiness. It becomes eligible only after
    // fresh facts for that replacement epoch are stored; the lease is intact.
    const replacement = runtime.workerEpochs.accept(enrollmentId);
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    await runtime.enrollments.observeReadiness(enrollmentId, {
      connectionEpoch: replacement.epoch,
      connection: { state: 'online', lastConfirmedAt: Date.now() },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
      ],
    }, readinessAuthority(runtime, enrollmentId, replacement.epoch));
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, true);
    if (lease.ok) assert.equal(runtime.pool.getLease(lease.lease.id)?.state, 'active');
  } finally {
    await runtime.close();
  }
});

test('E2: replacement and stale readiness ordering never re-admit a prior epoch in a multi-instance pool', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-epoch-order-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const enrollmentA = await enrollEligibleInstance(runtime, 'host-a', 'key-a');
    await enrollEligibleInstance(runtime, 'host-b', 'key-b');
    const lease = runtime.pool.acquireLease({
      instanceId: 'host-a', capability: ADMISSION_CAPABILITY, holderId: 'scout', runId: 'run-a', ttlMs: 60_000,
    });
    assert.equal(lease.ok, true);
    const first = runtime.workerEpochs.current(enrollmentA)!;

    // Loss followed by a replacement leaves host-b independently eligible but
    // removes host-a until the replacement itself supplies readiness.
    runtime.workerEpochs.invalidate(enrollmentA, first.connectionId);
    const replacement = runtime.workerEpochs.accept(enrollmentA);
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    assert.equal(runtime.environmentCatalog.entry('host-b')?.eligible, true);
    if (lease.ok) assert.equal(runtime.pool.getLease(lease.lease.id)?.state, 'active');

    // A delayed old-epoch observation is persisted as non-authoritative and
    // cannot make the new connection eligible or release/conflict-bypass lease.
    await runtime.enrollments.observeReadiness(enrollmentA, {
      connectionEpoch: first.epoch,
      connection: { state: 'online', lastConfirmedAt: Date.now() },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [{ engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } }],
    }, readinessAuthority(runtime, enrollmentA, first.epoch));
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    const blocked = runtime.pool.acquireLease({
      instanceId: 'host-a', capability: ADMISSION_CAPABILITY, holderId: 'scribe', runId: 'run-stale', ttlMs: 60_000,
    });
    assert.equal(blocked.ok, false);

    await runtime.enrollments.observeReadiness(enrollmentA, {
      connectionEpoch: replacement.epoch,
      connection: { state: 'online', lastConfirmedAt: Date.now() },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [{ engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } }],
    }, readinessAuthority(runtime, enrollmentA, replacement.epoch));
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, true);
    const conflict = runtime.pool.acquireLease({
      instanceId: 'host-a', capability: ADMISSION_CAPABILITY, holderId: 'scribe', runId: 'run-conflict', ttlMs: 60_000,
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.reason, 'conflict');
  } finally {
    await runtime.close();
  }
});

test('E2: the catalog, its records, and Project access survive a SQLite reopen', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'sprout.db');

  const first = await createSproutRuntime({
    configuration: hostConfiguration({ databasePath, environmentSource: 'enrollment' }),
    projectRoot: '/synthetic/project-root',
  });
  const enrollmentId = await enrollEligibleInstance(first, 'host-a', 'key-a');
  const firstEpoch = first.workerEpochs.current(enrollmentId)!;
  await first.close();

  // Reopen exactly as a restart would: no in-memory epoch survives, but the
  // enrolled instance and its durable catalog record remain inspectable.
  const second = await createSproutRuntime({
    configuration: hostConfiguration({ databasePath, environmentSource: 'enrollment' }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const record = await second.stores.environmentCatalog.get('host-a');
    assert.equal(record?.definition.platform, 'macos');
    assert.ok(second.environmentCatalog.entry('host-a') !== undefined, 'entry survives reopen');
    assert.equal(second.environmentCatalog.entry('host-a')?.eligible, false, 'no epoch after a restart');

    // A restart must not restart the authority namespace at epoch 1. The new
    // authenticated connection receives a durable, strictly newer generation,
    // and the old persisted readiness cannot make that connection eligible.
    const replacement = second.workerEpochs.accept(enrollmentId);
    assert.ok(replacement.epoch > firstEpoch.epoch, 'restart keeps the epoch high-water mark');
    await second.refreshEnvironmentCatalog();
    assert.equal(
      second.environmentCatalog.entry('host-a')?.eligible,
      false,
      'the replacement cannot inherit readiness from the pre-restart connection',
    );

    // Delayed old facts remain non-authoritative; only readiness produced by
    // the replacement epoch restores admission.
    await second.enrollments.observeReadiness(enrollmentId, {
      connectionEpoch: firstEpoch.epoch,
      connection: { state: 'online', lastConfirmedAt: Date.now() },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
      ],
    }, readinessAuthority(second, enrollmentId, firstEpoch.epoch));
    await second.refreshEnvironmentCatalog();
    assert.equal(second.environmentCatalog.entry('host-a')?.eligible, false);
    await second.enrollments.observeReadiness(enrollmentId, {
      connectionEpoch: replacement.epoch,
      connection: { state: 'online', lastConfirmedAt: Date.now() },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
      ],
    }, readinessAuthority(second, enrollmentId, replacement.epoch));
    await second.refreshEnvironmentCatalog();
    assert.equal(second.environmentCatalog.entry('host-a')?.eligible, true);
  } finally {
    await second.close();
  }
});

test('E2: production composition exposes no configured path and no leaked host fact', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-privacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    // No static configured Environment path is retained as a fallback.
    assert.equal(runtime.definition, undefined);
    assert.equal(runtime.instance, undefined);
    assert.equal(runtime.engines.size, 0);

    await enrollEligibleInstance(runtime, 'host-a', 'key-a');
    const report = runtime.startupReport(41000);
    assert.match(report, /environment: enrollment catalog \(1 enrolled, 1 eligible\)/);
    assert.equal(report.includes('key-a'), false, 'no identity material leaks into the report');
    assert.equal(report.includes('host-a-key'), false);

    // The durable catalog record carries only portable identity.
    const record = await runtime.stores.environmentCatalog.get('host-a');
    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes('key-a'), false);
    assert.equal(serialized.includes('private'), false);
  } finally {
    await runtime.close();
  }
});

/**
 * E2 (#116) end-to-end: an authenticated inbound Worker connection is the
 * execution catalog's admission fact, and a Project/run uses exactly that
 * enrolled instance without the production path ever dialing a Worker.
 */
test('E2: an authenticated inbound connection admits a run on the enrolled instance', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-e2e-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
      engineId: 'scripted',
      // The default Project (scout member, no static instance) is used; access
      // arrives through the catalog below.
      runtimeConfiguration: {},
    }),
    projectRoot: '/synthetic/project-root',
  });

  const { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } = await import(
    './worker/enrollment-connector.ts'
  );
  const { EnvironmentWorker } = await import('./worker/server.ts');
  const { WORKER_PROTOCOL_VERSION } = await import('./worker/protocol.ts');
  const { signWorkerChallenge } = await import('./environment/worker-proof.ts');

  const keyDirectory = mkdtempSync(join(tmpdir(), 'sprout-e2-key-'));
  t.after(() => rmSync(keyDirectory, { recursive: true, force: true }));
  const keyPath = join(keyDirectory, 'worker-key.pem');

  const connections: { close(): void }[] = [];
  let worker: InstanceType<typeof EnvironmentWorker> | undefined;
  try {
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'enrolled-host-1',
      displayName: 'Enrolled Host One',
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;
    const claimSecret = requested.claim?.secret ?? '';
    // Claim the one-use secret with the host key, prove possession, then approve.
    const host = loadOrCreateWorkerIdentity(keyPath);
    await runtime.enrollments.claimEnrollment(enrollmentId, claimSecret);
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
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
      ],
    });
    await runtime.enrollments.approve(enrollmentId, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });

    assert.equal(runtime.environmentCatalog.entry('enrolled-host-1')?.eligible, false, 'no connection yet');

    // The Worker initiates the outbound connection to the Sprout instance; the
    // production path never dials it.
    const { port } = await runtime.api.listen(0, '127.0.0.1');
    const connection = await connectWorkerEnrollment({
      target: {
        enrollmentId,
        host: '127.0.0.1',
        port,
        claimSecret: undefined,
        identityKeyPath: keyPath,
      },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engineFacts: [{ engine: 'scripted', installed: true, authenticated: true, models: ['scripted-model'] }],
    });
    connections.push(connection);

    // Start the Worker's neutral JSON-RPC server over the accepted channel.
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'sprout-e2-ws-'));
    t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    worker = new EnvironmentWorker({
      environmentInstanceId: 'enrolled-host-1',
      engines: new Map([
        ['scripted', new ScriptedEngineAdapter({ turns: [scriptedTurn('enrolled reply')] })],
      ]),
      input: connection.stream,
      output: connection.stream,
      workspaceRoot,
      // The Worker declares its own neutral, non-inference readiness facts
      // (ADR-0013). A real probe implementation is E4 (#118); here the Worker
      // states what it verified so the catalog can reach eligibility.
      readiness: () => ({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engines: [
          {
            engine: 'scripted',
            installed: true,
            readiness: 'ready',
            modelAvailability: 'available',
            models: ['scripted-model'],
          },
        ],
      }),
    });

    // The acceptance observer records the delegated readiness; wait for the
    // catalog to admit the instance without any restart.
    await waitFor(
      () => runtime.environmentCatalog.entry('enrolled-host-1')?.eligible === true,
      'the catalog admits the connected instance',
    );

    // A Human grants the Project access to exactly the catalog instance (#93);
    // the Worker validates the workspace over the same accepted connection, so
    // Project access, execution, and leases resolve the same instance.
    const authorityProject = await runtime.projectService.create({
      id: 'enrolled-project',
      displayName: 'Enrolled Project',
      goal: 'Execute on the enrolled instance.',
      agentMemberships: [{ agentId: 'scout' }],
    });
    await runtime.projectAccess.grant({
      projectId: authorityProject.id,
      environmentInstanceId: 'enrolled-host-1',
      selection: { kind: 'default' },
    });

    const run = await runtime.orchestrator.submit({
      agentId: 'scout',
      prompt: 'run on the enrolled instance',
      projectId: authorityProject.id,
    });
    const settled = await runtime.orchestrator.waitFor(run.id);
    assert.equal(settled.failure ?? 'no-failure', 'no-failure');
    assert.equal(settled.environmentInstanceId, 'enrolled-host-1');
    assert.equal(settled.status, 'completed');
    assert.equal(settled.result?.status === 'completed' ? settled.result.text : undefined, 'enrolled reply');

    // Transport close synchronously fences the already-published catalog and
    // pool before the store-backed refresh can cross its first await. Resolution
    // in that exact window must fail closed while the durable entry remains.
    const accepted = runtime.workerGateway.liveFor('enrolled-host-1');
    assert.ok(accepted !== undefined);
    accepted.close();
    assert.equal(runtime.environmentCatalog.entry('enrolled-host-1')?.eligible, false);
    assert.ok(runtime.environmentCatalog.entry('enrolled-host-1') !== undefined, 'offline stays inspectable');
    assert.equal(runtime.pool.requiresLease('enrolled-host-1', ADMISSION_CAPABILITY), undefined);
    assert.deepEqual(
      resolveEnvironmentInstance([runtime.projects.get(authorityProject.id)!], ADMISSION_CAPABILITY, runtime.pool),
      { ok: false, reason: 'no-available-environment' },
    );

    // Reconnect receives the next authority generation and can restore
    // eligibility only after this connection reports its own readiness.
    await worker.shutdown().catch(() => undefined);
    worker = undefined;
    const replacement = await connectWorkerEnrollment({
      target: {
        enrollmentId,
        host: '127.0.0.1',
        port,
        claimSecret: undefined,
        identityKeyPath: keyPath,
      },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engineFacts: [{ engine: 'scripted', installed: true, authenticated: true, models: ['scripted-model'] }],
    });
    connections.push(replacement);
    assert.ok(replacement.epoch > connection.epoch);
    worker = new EnvironmentWorker({
      environmentInstanceId: 'enrolled-host-1',
      engines: new Map([
        ['scripted', new ScriptedEngineAdapter({ turns: [scriptedTurn('replacement reply')] })],
      ]),
      input: replacement.stream,
      output: replacement.stream,
      workspaceRoot,
      readiness: () => ({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engines: [{
          engine: 'scripted', installed: true, readiness: 'ready',
          modelAvailability: 'available', models: ['scripted-model'],
        }],
      }),
    });
    await waitFor(
      () => runtime.environmentCatalog.entry('enrolled-host-1')?.eligible === true,
      'the replacement connection to restore current-epoch eligibility',
    );
  } finally {
    await worker?.shutdown().catch(() => undefined);
    for (const connection of connections) connection.close();
    await runtime.close();
  }
});

test('E2: a legacy same-instance enrollment cannot inherit stale readiness through gateway acceptance', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-instance-authority-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
      engineId: 'scripted',
      runtimeConfiguration: {},
    }),
    projectRoot: '/synthetic/project-root',
  });
  const { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } = await import(
    './worker/enrollment-connector.ts'
  );
  const { EnvironmentWorker } = await import('./worker/server.ts');
  const { WORKER_PROTOCOL_VERSION } = await import('./worker/protocol.ts');
  const keyDirectory = mkdtempSync(join(tmpdir(), 'sprout-e2-instance-authority-key-'));
  t.after(() => rmSync(keyDirectory, { recursive: true, force: true }));
  const firstKeyPath = join(keyDirectory, 'first-worker-key.pem');
  const secondKeyPath = join(keyDirectory, 'second-worker-key.pem');
  const instanceId = 'one-instance';
  const connections: { close(): void }[] = [];
  let firstWorker: InstanceType<typeof EnvironmentWorker> | undefined;
  let secondWorker: InstanceType<typeof EnvironmentWorker> | undefined;
  try {
    const firstIdentity = loadOrCreateWorkerIdentity(firstKeyPath);
    const first = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: instanceId,
      displayName: 'First authority',
      publicKey: workerPublicKey(firstIdentity.privateKey),
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    await runtime.enrollments.approve(first.enrollment.id, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    const { port } = await runtime.api.listen(0, '127.0.0.1');
    const firstConnection = await connectWorkerEnrollment({
      target: {
        enrollmentId: first.enrollment.id,
        host: '127.0.0.1',
        port,
        claimSecret: undefined,
        identityKeyPath: firstKeyPath,
      },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engineFacts: [],
    });
    connections.push(firstConnection);
    firstWorker = new EnvironmentWorker({
      environmentInstanceId: instanceId,
      engines: new Map(),
      input: firstConnection.stream,
      output: firstConnection.stream,
      readiness: () => ({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engines: [{ engine: 'scripted', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] }],
      }),
    });
    await waitFor(
      () => runtime.environmentCatalog.entry(instanceId)?.eligible === true,
      'the first enrollment to establish readiness',
    );
    assert.equal((await runtime.stores.environmentReadiness.getReadiness(instanceId))?.enrollmentId, first.enrollment.id);

    // Public creation now refuses another authority for this instance. Insert a
    // historical sibling directly to prove the runtime and real gateway still
    // fail closed when reopening legacy data with that invalid shape.
    const secondIdentity = loadOrCreateWorkerIdentity(secondKeyPath);
    const legacySibling = createPendingEnrollment({
      id: 'legacy-second-enrollment',
      environmentInstanceId: instanceId,
      displayName: 'Historical sibling',
      identityDigest: workerIdentityDigest(workerPublicKey(secondIdentity.privateKey)),
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
      at: Date.now() + 1,
    });
    await runtime.stores.enrollments.save(legacySibling);
    await runtime.enrollments.approve(legacySibling.id, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    await runtime.refreshEnvironmentCatalog();

    const secondConnection = await connectWorkerEnrollment({
      target: {
        enrollmentId: legacySibling.id,
        host: '127.0.0.1',
        port,
        claimSecret: undefined,
        identityKeyPath: secondKeyPath,
      },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engineFacts: [],
    });
    connections.push(secondConnection);
    assert.equal(secondConnection.epoch, 1, 'the sibling has a fresh per-enrollment epoch');
    assert.equal(runtime.workerGateway.liveFor(instanceId)?.enrollment.id, legacySibling.id);
    assert.equal(runtime.workerEpochs.isCurrent(first.enrollment.id, firstConnection.connectionId), false);
    assert.equal(runtime.environmentCatalog.entry(instanceId)?.eligible, false, 'acceptance clears stale facts before publishing epoch one');
    assert.equal(runtime.pool.requiresLease(instanceId, ADMISSION_CAPABILITY), undefined);

    // Fresh readiness from the second accepted transport is the only fact that
    // can restore admission. This proves both exact readiness ownership and the
    // one-live-transport gateway fence in the production composition.
    secondWorker = new EnvironmentWorker({
      environmentInstanceId: instanceId,
      engines: new Map(),
      input: secondConnection.stream,
      output: secondConnection.stream,
      readiness: () => ({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engines: [{ engine: 'scripted', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] }],
      }),
    });
    await waitFor(
      () => runtime.environmentCatalog.entry(instanceId)?.eligible === true,
      'fresh second-enrollment readiness',
    );
    assert.equal((await runtime.stores.environmentReadiness.getReadiness(instanceId))?.enrollmentId, legacySibling.id);
  } finally {
    await firstWorker?.shutdown().catch(() => undefined);
    await secondWorker?.shutdown().catch(() => undefined);
    for (const connection of connections) connection.close();
    await runtime.close();
  }
});

test('real Gateway startup rejects missing, mismatched, and non-worker probe records before durable commit (R118-API-002, R118-BOUNDARY-003)', async () => {
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
  const invalidResults: readonly { readonly name: string; readonly value: unknown }[] = [
    {
      name: 'missing returned probe',
      value: {
        readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe: validProbe },
      },
    },
    {
      name: 'mismatched embedded and returned probes',
      value: {
        readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe: validProbe },
        probe: { ...validProbe, summary: 'different returned probe' },
      },
    },
    {
      name: 'provider/account probe source',
      value: {
        readiness: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          engines: [],
          probe: { ...validProbe, source: 'provider-account' },
        },
        probe: { ...validProbe, source: 'provider-account' },
      },
    },
  ];

  for (const fixture of invalidResults) {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-118-startup-ingress-'));
    const keyDirectory = mkdtempSync(join(tmpdir(), 'sprout-118-startup-key-'));
    const keyPath = join(keyDirectory, 'worker-key.pem');
    const runtime = await createSproutRuntime({
      configuration: hostConfiguration({
        databasePath: join(directory, 'sprout.db'),
        environmentSource: 'enrollment',
        runtimeConfiguration: {
          agents: [
            { ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' },
            agent('scribe'),
          ],
          project: project(),
        },
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
        readinessProbe: async () => {
          calls += 1;
          return fixture.value as never;
        },
      });

      // Invoke the same automatic observer that acceptance schedules, but await
      // it so absence from the store is deterministic rather than timer-based.
      await runtime.observeWorkerReadiness(enrollmentId);
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

/** Poll a predicate with a bounded deadline, so an async observer can settle. */
async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  // The complete suite exercises browser builds alongside this real WS
  // composition. Keep the assertion bounded, but leave enough scheduler room
  // for the Worker to install its JSON-RPC server after the accepted transport.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/**
 * E2 (#116): authority mutations re-project the catalog without a restart.
 *
 * Approval, revocation, archive, and restore are durable enrollment decisions.
 * The catalog observes each through the domain mutation seam, so eligibility
 * follows the decision on the running process rather than after a manual refresh
 * or a runtime JSON edit.
 */
test('E2: approval and revocation re-project eligibility without a restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-mutation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createSproutRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'host-a',
      displayName: 'Host A',
      publicKey: 'key-a',
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;
    const epoch = runtime.workerEpochs.accept(enrollmentId);
    // A pending enrollment may have an accepted-looking resolver epoch, but it
    // has no fact-write authority until Human approval.
    await runtime.enrollments.observeReadiness(enrollmentId, {
      connectionEpoch: epoch.epoch,
      connection: { state: 'online', lastConfirmedAt: Date.now() },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
      ],
    }, readinessAuthority(runtime, enrollmentId, epoch.epoch));
    // Still pending: no admission.
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible ?? false, false);
    assert.equal(await runtime.stores.environmentReadiness.getReadiness('host-a'), undefined);

    // Approval is necessary but not sufficient; only a post-approval Worker
    // observation can restore readiness authority.
    await runtime.enrollments.approve(enrollmentId, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    await runtime.enrollments.observeReadiness(enrollmentId, {
      connectionEpoch: epoch.epoch,
      connection: { state: 'online', lastConfirmedAt: Date.now() },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['scripted-model'] } },
      ],
    }, readinessAuthority(runtime, enrollmentId, epoch.epoch));
    await runtime.refreshEnvironmentCatalog();
    await waitFor(
      () => runtime.environmentCatalog.entry('host-a')?.eligible === true,
      'approval to re-project eligibility',
    );

    // Revocation alone makes it ineligible again, while the record stays.
    await runtime.enrollments.revoke(enrollmentId, 'host retired');
    await waitFor(
      () => runtime.environmentCatalog.entry('host-a')?.eligible === false,
      'revocation to re-project ineligibility',
    );
    assert.ok(runtime.environmentCatalog.entry('host-a') !== undefined, 'revoked stays inspectable');
    assert.equal(runtime.pool.requiresLease('host-a', ADMISSION_CAPABILITY), undefined);
  } finally {
    await runtime.close();
  }
});
