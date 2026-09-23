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
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { workerReadinessProbeFixture } from './worker/readiness-fixture.ts';

import type { AgentDefinition } from './agent/registry.ts';
import { InMemoryCollaborationStore } from './collaboration/store.ts';
import type { EngineAdapter, EngineSession, StartSessionRequest } from './engine/port.ts';
import { ScriptedEngineAdapter, type ScriptedTurn } from './engine/scripted.ts';
import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import { createPendingEnrollment } from './environment/enrollment.ts';
import { EnvironmentArchiveService } from './environment/archive.ts';
import { workerIdentityDigest } from './environment/enrollment-identity.ts';
import { InMemoryLeaseStore } from './environment/pool.ts';
import type { HostConfiguration } from './host-config.ts';
import type { Project } from './project/model.ts';
import type { WorkerInfo } from './worker/protocol.ts';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerReadinessFacts,
  type WorkerReadinessProbeParams,
  type WorkerReadinessProbeResult,
} from './worker/protocol.ts';
import { EnvironmentWorker } from './worker/server.ts';
import {
  connectWorkerEnrollment,
  loadOrCreateWorkerIdentity,
  workerPublicKey,
  type WorkerEnrollmentConnection,
} from './worker/enrollment-connector.ts';
import { InMemoryProjectStore } from './project/store.ts';
import { InMemorySessionKeyStore } from './run/session-key-store.ts';
import { InMemoryRunStore } from './run/store.ts';
import { InMemoryTaskStore } from './task/store.ts';
import { InMemoryOperatorSessionStore } from './auth/store.ts';
import { InMemoryEnrollmentStore } from './environment/enrollment-store.ts';
import { InMemoryEnvironmentCatalogStore } from './environment/catalog-store.ts';
import { InMemoryEnvironmentReadinessStore } from './environment/readiness-store.ts';
import { createReadinessAuthorityTestSeam } from './environment/readiness-authority.test-support.ts';
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

const runtimeWorkerResources = new WeakMap<
  SproutRuntime,
  Array<{ readonly worker: EnvironmentWorker; readonly connection: WorkerEnrollmentConnection }>
>();

async function createRuntime(options: Parameters<typeof createSproutRuntime>[0]) {
  const runtime = await createSproutRuntime(options);
  const productionClose = runtime.close.bind(runtime);
  Object.defineProperty(runtime, 'close', {
    value: async () => {
      for (const resource of runtimeWorkerResources.get(runtime) ?? []) {
        await resource.worker.shutdown().catch(() => undefined);
        resource.connection.close();
      }
      runtimeWorkerResources.delete(runtime);
      await productionClose();
    },
  });
  return runtime;
}

/** The environment instance this composition test serves. */
const INSTANCE_ID = 'composition-instance';
const PROJECT_ID = 'composition-project';

function readinessAuthority(
  runtime: SproutRuntime,
  enrollmentId: string,
  connectionEpoch: number,
  environmentInstanceId?: string,
) {
  const instanceId =
    environmentInstanceId ??
    runtime.environmentCatalog.entries().find((e) => e.enrollmentId === enrollmentId)?.instanceId ??
    INSTANCE_ID;
  const authority = runtime.workerGateway.authorizeObservation(instanceId);
  assert.ok(authority, 'an authenticated accepted Worker owns observation authority');
  assert.equal(authority.enrollmentId, enrollmentId);
  assert.equal(authority.connectionEpoch, connectionEpoch);
  return authority;
}

const runtimePorts = new WeakMap<SproutRuntime, Promise<number>>();

async function runtimePort(runtime: SproutRuntime): Promise<number> {
  let port = runtimePorts.get(runtime);
  if (port === undefined) {
    port = runtime.api.listen(0, '127.0.0.1').then((listening) => listening.port);
    runtimePorts.set(runtime, port);
  }
  return port;
}

/** Establish authority through the real authenticated WorkerGateway handshake. */
async function connectRuntimeWorker(
  runtime: SproutRuntime,
  enrollmentId: string,
  identityKeyPath: string,
): Promise<WorkerEnrollmentConnection> {
  const port = await runtimePort(runtime);
  const connection = await connectWorkerEnrollment({
    target: { enrollmentId, host: '127.0.0.1', port, claimSecret: undefined, identityKeyPath },
    protocolVersion: WORKER_PROTOCOL_VERSION,
    engineFacts: [{ engine: 'scripted', installed: true, authenticated: true, models: ['scripted-model'] }],
  });
  const enrollment = await runtime.enrollments.get(enrollmentId);
  assert.ok(enrollment);
  const worker = new EnvironmentWorker({
    environmentInstanceId: enrollment.environmentInstanceId,
    engines: new Map(),
    input: connection.stream,
    output: connection.stream,
  });
  const resources = runtimeWorkerResources.get(runtime) ?? [];
  resources.push({ worker, connection });
  runtimeWorkerResources.set(runtime, resources);
  await waitFor(
    () => runtime.workerGateway.liveFor(enrollment.environmentInstanceId) !== undefined,
    'authenticated WorkerGateway connection',
  );
  return connection;
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

function startupWorkerProbe() {
  return {
    at: 1_000,
    latencyMs: 1,
    protocolOk: true,
    enginesOk: true,
    source: 'worker' as const,
    version: '1.0.0',
    summary: 'Worker non-inference readiness probe completed.',
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
  const runtime = await createRuntime({
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
    createRuntime({
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
    createRuntime({
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
      createRuntime({
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
      createRuntime({
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
  database.exec('PRAGMA user_version = 17; CREATE TABLE retained_data (id TEXT PRIMARY KEY);');
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
      createRuntime({
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
  const runtime = await createRuntime({
    configuration: hostConfiguration({ databasePath }),
    projectRoot: '/synthetic/project-root',
    environment,
  });
  try {
    const keyPath = join(directory, 'worker-key.pem');
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID,
      displayName: 'Composed Environment',
      publicKey: workerPublicKey(identity.privateKey),
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
    await connectRuntimeWorker(runtime, requested.enrollment.id, keyPath);
    const epoch = runtime.workerGateway.currentConnectionEpoch(requested.enrollment.id)!;
    // Only the engine this build's configured Agents actually run on is required,
    // so a single ready engine is a complete Environment.
    await runtime.enrollments.observeReadiness(requested.enrollment.id, workerReadinessProbeFixture({
      observedAt: now,
      protocolVersion: '2',
      engines: [
        { engine: 'scripted', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] },
      ],
    }, {
      at: now,
      latencyMs: 5,
      protocolOk: true,
      enginesOk: true,
      summary: 'ready',
    }), readinessAuthority(runtime, requested.enrollment.id, epoch));

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
    const port = await runtimePort(runtime);
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
  const runtime = await createRuntime({
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
 * The pending enrollment, its one-use claim, and the machine claim route are
 * present on the one runtime object, while epoch issuance stays private to the
 * gateway so a host Worker can connect without the core ever dialing it.
 */
test('the composed runtime exposes the outbound Worker gateway without its epoch issuer (#115)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-gateway-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = scriptedEnvironment({
    adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
  });
  const runtime = await createRuntime({
    configuration: hostConfiguration({ databasePath: join(directory, 'sprout.db') }),
    projectRoot: '/synthetic/project-root',
    environment,
  });
  try {
    assert.notEqual(runtime.workerGateway, undefined);
    assert.equal('epochs' in runtime.workerGateway, false, 'the mutable epoch issuer is not application-facing');
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
    runtimePorts.set(runtime, Promise.resolve(port));
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

test('production Runtime rejects an isolated test verifier capability (R125-AUTH-001)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-authority-boundary-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
    stores: inMemoryStores(),
  });
  try {
    const keyPath = join(directory, 'worker-key.pem');
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const { enrollment } = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'authority-boundary-host',
      displayName: 'Authority Boundary Host',
      publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.id, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    await connectRuntimeWorker(runtime, enrollment.id, keyPath);
    const live = runtime.workerGateway.liveFor(enrollment.environmentInstanceId)!;
    const foreignAuthority = createReadinessAuthorityTestSeam().mint({
      environmentInstanceId: enrollment.environmentInstanceId,
      enrollmentId: enrollment.id,
      connectionId: live.epoch.connectionId,
      connectionEpoch: live.epoch.epoch,
      lifecycleGeneration: runtime.enrollments.lifecycleAuthority.generation(enrollment.id),
      isCurrent: () => true,
    });

    assert.equal(
      await runtime.enrollments.observeReadiness(enrollment.id, scriptedReadinessProbe(), foreignAuthority),
      false,
      'production composition verifies only capabilities minted by its authenticated Gateway',
    );
    assert.equal(await runtime.stores.environmentReadiness.getReadiness(enrollment.environmentInstanceId), undefined);
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
  const runtime = await createRuntime({
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
  const runtime = await createRuntime({
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
    runtimePorts.set(runtime, Promise.resolve(port));
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
    const keyPath = join(directory, 'worker-key.pem');
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'enrolled-host-1',
      displayName: 'Enrolled Host One',
      publicKey: workerPublicKey(identity.privateKey),
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
    await connectRuntimeWorker(runtime, enrollmentId, keyPath);
    const epoch = runtime.workerGateway.currentConnectionEpoch(enrollmentId)!;
    await runtime.enrollments.observeReadiness(enrollmentId, scriptedReadinessProbe(),
      readinessAuthority(runtime, enrollmentId, epoch));
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('enrolled-host-1')?.eligible, true);
    await runtime.refreshEnvironmentCatalog();
  } finally {
    await runtime.close();
  }
});

function scriptedReadinessProbe() {
  return workerReadinessProbeFixture({
    protocolVersion: '2',
    observedAt: Date.now(),
    engines: [{ engine: 'scripted', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] }],
  });
}

for (const backend of ['memory', 'sqlite'] as const) {
  test(`#127 ${backend}: delayed acceptance probe cannot overwrite later HTTP evidence`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-127-accept-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }] });
    let release: (() => void) | undefined;
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started: (() => void) | undefined;
      const start = new Promise<void>((resolve) => { started = resolve; });
      let calls = 0;
      await h.connect(id, join(directory, 'worker-key.pem'), { readinessProbe: async () => {
        const call = ++calls;
        if (call === 1) { started?.(); await gate; }
        const probe = { at: call === 1 ? 9000 : 1, latencyMs: 1, protocolOk: true,
          enginesOk: call === 1, source: 'worker' as const, version: '1.0.0', summary: 'acceptance order' };
        return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, probe,
          engines: [{ engine: 'codex', installed: call === 1, readiness: call === 1 ? 'ready' as const : 'login-required' as const,
            modelAvailability: 'unknown' as const, models: [] }] }, probe };
      } });
      await start;
      const response = await fetch(`${h.base}/api/environments/enrollments/${id}/probes`, {
        method: 'POST', headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 201);
      release?.();
      await waitFor(async () => (await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID)).length === 1,
        'later login-required commit');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const history = await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID);
      assert.equal(history.length, 1);
      assert.equal(history[0]!.probe.at, 1);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
    } finally { release?.(); await h.close(); }
  });
  test(`#127 ${backend}: issue order survives reverse Worker completion, skew, and negative evidence`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-127-order-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory });
    let release: (() => void) | undefined;
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started: (() => void) | undefined;
      const firstStarted = new Promise<void>((resolve) => { started = resolve; });
      let calls = 0;
      let replayId: string | undefined;
      let conflicting = false;
      const fact = (state: 'ready' | 'missing', at: number) => {
        const probe = { at, latencyMs: 1, protocolOk: true, enginesOk: state === 'ready',
          source: 'worker' as const, version: '1.0.0', summary: state };
        return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION,
          engines: [{ engine: 'scripted', version: '1.0.0', installed: state === 'ready', readiness: state,
            modelAvailability: state === 'ready' ? 'available' as const : 'none' as const,
            models: state === 'ready' ? ['scripted-model'] : [] }], probe }, probe };
      };
      await h.connect(id, join(directory, 'worker-key.pem'), {
        readiness: () => fact('ready', 100).readiness,
        readinessProbe: async (params) => {
          calls++;
          if (calls === 1) { started?.(); await gate; return fact('ready', 9_000_000); }
          if (calls === 2) replayId = params.attemptId;
          return { ...fact(conflicting ? 'ready' : 'missing', 2),
            ...(calls > 2 ? { attemptId: replayId } : {}) };
        },
      });
      await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'bootstrap');
      await h.runtime.observeWorkerReadiness(id);
      assert.equal((await h.runtime.enrollments.listProbes(id)).length, 1, 'worker/info reread is inspection only');
      const post = () => fetch(`${h.base}/api/environments/enrollments/${id}/probes`, {
        method: 'POST', headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' }, body: '{}',
      });
      const older = post();
      await firstStarted;
      const newer = await post();
      assert.equal(newer.status, 201);
      const originalReceipt = ((await newer.json()) as { receipt: { observationId: string; sequence: number } }).receipt;
      await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === false, 'negative admission');
      release?.();
      const stale = await older;
      assert.equal(stale.status, 409, 'superseded attempt is neutral, not a successful probe');
      assert.equal(((await stale.json()) as { code?: string }).code, 'superseded-observation');
      const observations = await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID);
      assert.equal(observations.length, 2, 'bootstrap and later negative only');
      assert.ok(observations[0]!.sequence < observations[1]!.sequence);
      assert.equal(observations[1]!.probe.at, 2, 'Worker clock is not ordering authority');
      assert.equal((await h.runtime.enrollments.listProbes(id)).length, 2);
      assert.equal((await h.runtime.stores.environmentReadiness.getCurrentObservation(INSTANCE_ID))?.observationId,
        observations[1]!.observationId);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
      await h.runtime.observeWorkerReadiness(id);
      assert.equal((await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID)).length, 2,
        'bootstrap reread cannot supersede a later targeted negative');
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
      const repeat = await post();
      assert.equal(repeat.status, 201);
      assert.deepEqual(((await repeat.json()) as { receipt: { observationId: string; sequence: number } }).receipt,
        originalReceipt, 'exact redelivery returns the original receipt');
      assert.equal((await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID)).length, 2,
        'same authenticated identity and content has one history entry');
      conflicting = true;
      const conflict = await post();
      assert.equal(conflict.status, 409, 'changed content under committed identity is refused');
      assert.equal(((await conflict.json()) as { code?: string }).code, 'conflicting-observation');
      assert.equal((await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID)).length, 2);
    } finally { release?.(); await h.close(); }
  });
  for (const missing of ['omitted', 'undefined'] as const) {
    test(`exposed ${backend} readiness store refuses ${missing} probe without admitting work (R118-API-002)`, async (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'sprout-store-ingress-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const runtime = await createRuntime({
        configuration: hostConfiguration({
          databasePath: join(directory, 'sprout.db'), environmentSource: 'enrollment',
        }),
        projectRoot: '/synthetic/project-root',
        ...(backend === 'memory' ? { stores: inMemoryStores() } : {}),
      });
      try {
        const keyPath = join(directory, 'worker-key.pem');
        const identity = loadOrCreateWorkerIdentity(keyPath);
        const { enrollment } = await runtime.enrollments.requestEnrollment({
          environmentInstanceId: 'host-store-ingress', displayName: 'Store ingress',
          publicKey: workerPublicKey(identity.privateKey), platform: 'macos',
          capabilityRequests: [ADMISSION_CAPABILITY], engineFacts: [],
        });
        await runtime.enrollments.approve(enrollment.id, {
          capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
        });
        await connectRuntimeWorker(runtime, enrollment.id, keyPath);
        const epoch = runtime.workerGateway.currentConnectionEpoch(enrollment.id)!;
        const authority = readinessAuthority(runtime, enrollment.id, epoch);
        assert.equal(authority.isCurrent(), true);
        const raw = {
          readiness: {
            enrollmentId: enrollment.id, connectionEpoch: epoch,
            connection: { state: 'online', lastConfirmedAt: Date.now() },
            compatibility: { state: 'compatible', workerProtocolVersion: '2' },
            engines: [{ engine: 'scripted', installed: true, readiness: 'ready', required: true,
              models: { state: 'available', models: ['scripted-model'] } }],
          },
          ...(missing === 'undefined' ? { probe: undefined } : {}),
        };
        const store = runtime.stores.environmentReadiness;
        const recorded = await store.commitObservation(enrollment.environmentInstanceId, raw as never, authority);
        await runtime.refreshEnvironmentCatalog();
        assert.equal(recorded, false);
        assert.equal(await store.getReadiness(enrollment.environmentInstanceId), undefined);
        assert.deepEqual(await store.listProbes(enrollment.environmentInstanceId), []);
        assert.equal(runtime.environmentCatalog.entry(enrollment.environmentInstanceId)?.eligible, false);

        // Read methods are not a raw write seam either. Mutating a returned
        // unknown observation must not silently turn the instance admissible.
        const unknown = scriptedReadinessProbe();
        Reflect.set(unknown.readiness.engines[0]!, 'modelAvailability', 'unknown');
        assert.equal(await runtime.enrollments.observeReadiness(enrollment.id, unknown, authority), true);
        const readback = await store.getReadiness(enrollment.environmentInstanceId);
        assert.ok(readback);
        Reflect.set(readback.engines[0]!.models, 'state', 'available');
        const history = await store.listProbes(enrollment.environmentInstanceId);
        Reflect.set(history[0]!, 'source', 'unknown');
        await runtime.refreshEnvironmentCatalog();
        assert.equal(runtime.environmentCatalog.entry(enrollment.environmentInstanceId)?.eligible, false);
        assert.equal((await store.getReadiness(enrollment.environmentInstanceId))?.engines[0]?.models.state, 'unknown');
        assert.equal((await store.listProbes(enrollment.environmentInstanceId))[0]?.source, 'worker');

        // The refusal is input validation, not a broken authority/admission path.
        assert.equal(await runtime.enrollments.observeReadiness(enrollment.id, scriptedReadinessProbe(), authority), true);
        await runtime.refreshEnvironmentCatalog();
        assert.equal(runtime.environmentCatalog.entry(enrollment.environmentInstanceId)?.eligible, true);
        assert.equal((await store.listProbes(enrollment.environmentInstanceId)).length, 2);
      } finally {
        await runtime.close();
      }
    });
  }
}

/** A helper that enrolls, approves, and makes eligible one instance. */
async function enrollEligibleInstance(
  runtime: SproutRuntime,
  instanceId: string,
  identityKeyPath: string,
): Promise<string> {
  const identity = loadOrCreateWorkerIdentity(identityKeyPath);
  const requested = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: instanceId,
    displayName: instanceId,
    publicKey: workerPublicKey(identity.privateKey),
    platform: 'macos',
    capabilityRequests: [ADMISSION_CAPABILITY],
    engineFacts: [],
  });
  const enrollmentId = requested.enrollment.id;
  await runtime.enrollments.approve(enrollmentId, {
    capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
  });
  await connectRuntimeWorker(runtime, enrollmentId, identityKeyPath);
  const epoch = runtime.workerGateway.currentConnectionEpoch(enrollmentId)!;
  await runtime.enrollments.observeReadiness(enrollmentId, scriptedReadinessProbe(),
    readinessAuthority(runtime, enrollmentId, epoch));
  await runtime.refreshEnvironmentCatalog();
  return enrollmentId;
}

test('E2: a durable enrollment alone does not admit work; a current epoch and required facts do', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-eligibility-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const keyPath = join(directory, 'host-a-key.pem');
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'host-a',
      displayName: 'Host A',
      publicKey: workerPublicKey(identity.privateKey),
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
    await connectRuntimeWorker(runtime, enrollmentId, keyPath);
    const emptyEpoch = runtime.workerGateway.currentConnectionEpoch(enrollmentId)!;
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);

    // Establishing the required readiness fact makes it eligible dynamically.
    await runtime.enrollments.observeReadiness(enrollmentId, scriptedReadinessProbe(),
      readinessAuthority(runtime, enrollmentId, emptyEpoch));
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, true);
  } finally {
    await runtime.close();
  }
});

test('E2: two eligible instances stay independent and a lease conflict is observable', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-multi-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
    // Deterministic lease identity so the conflict is asserted precisely.
  });
  try {
    await enrollEligibleInstance(runtime, 'host-a', join(directory, 'host-a-key.pem'));
    await enrollEligibleInstance(runtime, 'host-b', join(directory, 'host-b-key.pem'));
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
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const enrollmentId = await enrollEligibleInstance(runtime, 'host-a', join(directory, 'host-a-key.pem'));
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
    runtime.workerGateway.liveFor('host-a')!.close();
    await waitFor(() => runtime.workerGateway.liveFor('host-a') === undefined, 'disconnected Worker removal');
    await runtime.refreshEnvironmentCatalog();
    assert.ok(runtime.environmentCatalog.entry('host-a') !== undefined, 'offline never deletes');
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    assert.equal(runtime.pool.requiresLease('host-a', ADMISSION_CAPABILITY), undefined);
    if (lease.ok) assert.equal(runtime.pool.getLease(lease.lease.id)?.state, 'active');

    // A newer epoch cannot reuse old readiness. It becomes eligible only after
    // fresh facts for that replacement epoch are stored; the lease is intact.
    await connectRuntimeWorker(runtime, enrollmentId, join(directory, 'host-a-key.pem'));
    const replacement = runtime.workerGateway.currentConnectionEpoch(enrollmentId)!;
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    await runtime.enrollments.observeReadiness(enrollmentId, scriptedReadinessProbe(),
      readinessAuthority(runtime, enrollmentId, replacement));
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
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const enrollmentA = await enrollEligibleInstance(runtime, 'host-a', join(directory, 'host-a-key.pem'));
    await enrollEligibleInstance(runtime, 'host-b', join(directory, 'host-b-key.pem'));
    const lease = runtime.pool.acquireLease({
      instanceId: 'host-a', capability: ADMISSION_CAPABILITY, holderId: 'scout', runId: 'run-a', ttlMs: 60_000,
    });
    assert.equal(lease.ok, true);
    const firstAuthority = runtime.workerGateway.authorizeObservation('host-a')!;

    // Loss followed by a replacement leaves host-b independently eligible but
    // removes host-a until the replacement itself supplies readiness.
    runtime.workerGateway.liveFor('host-a')!.close();
    await waitFor(() => runtime.workerGateway.liveFor('host-a') === undefined, 'prior Worker removal');
    await connectRuntimeWorker(runtime, enrollmentA, join(directory, 'host-a-key.pem'));
    const replacement = runtime.workerGateway.currentConnectionEpoch(enrollmentA)!;
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    assert.equal(runtime.environmentCatalog.entry('host-b')?.eligible, true);
    if (lease.ok) assert.equal(runtime.pool.getLease(lease.lease.id)?.state, 'active');

    // A delayed old-epoch observation is refused as non-authoritative and
    // cannot make the new connection eligible or release/conflict-bypass lease.
    await runtime.enrollments.observeReadiness(enrollmentA, scriptedReadinessProbe(), firstAuthority);
    await runtime.refreshEnvironmentCatalog();
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible, false);
    const blocked = runtime.pool.acquireLease({
      instanceId: 'host-a', capability: ADMISSION_CAPABILITY, holderId: 'scribe', runId: 'run-stale', ttlMs: 60_000,
    });
    assert.equal(blocked.ok, false);

    await runtime.enrollments.observeReadiness(enrollmentA, scriptedReadinessProbe(),
      readinessAuthority(runtime, enrollmentA, replacement));
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

  const first = await createRuntime({
    configuration: hostConfiguration({ databasePath, environmentSource: 'enrollment' }),
    projectRoot: '/synthetic/project-root',
  });
  const keyPath = join(directory, 'host-a-key.pem');
  const enrollmentId = await enrollEligibleInstance(first, 'host-a', keyPath);
  const firstEpoch = first.workerGateway.currentConnectionEpoch(enrollmentId)!;
  const firstAuthority = first.workerGateway.authorizeObservation('host-a')!;
  await first.close();

  // Reopen exactly as a restart would: no in-memory epoch survives, but the
  // enrolled instance and its durable catalog record remain inspectable.
  const second = await createRuntime({
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
    await connectRuntimeWorker(second, enrollmentId, keyPath);
    const replacement = second.workerGateway.currentConnectionEpoch(enrollmentId)!;
    assert.ok(replacement > firstEpoch, 'restart keeps the epoch high-water mark');
    await second.refreshEnvironmentCatalog();
    assert.equal(
      second.environmentCatalog.entry('host-a')?.eligible,
      false,
      'the replacement cannot inherit readiness from the pre-restart connection',
    );

    // Delayed old facts remain non-authoritative; only readiness produced by
    // the replacement epoch restores admission.
    await second.enrollments.observeReadiness(enrollmentId, scriptedReadinessProbe(), firstAuthority);
    await second.refreshEnvironmentCatalog();
    assert.equal(second.environmentCatalog.entry('host-a')?.eligible, false);
    await second.enrollments.observeReadiness(enrollmentId, scriptedReadinessProbe(),
      readinessAuthority(second, enrollmentId, replacement));
    await second.refreshEnvironmentCatalog();
    assert.equal(second.environmentCatalog.entry('host-a')?.eligible, true);
  } finally {
    await second.close();
  }
});

test('E2: production composition exposes no configured path and no leaked host fact', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-e2-privacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({
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

    await enrollEligibleInstance(runtime, 'host-a', join(directory, 'host-a-key.pem'));
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

  const runtime = await createRuntime({
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
        probe: startupWorkerProbe(),
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
        probe: startupWorkerProbe(),
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
  const runtime = await createRuntime({
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
        probe: startupWorkerProbe(),
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
    assert.equal(runtime.workerGateway.isCurrentConnection(first.enrollment.id, firstConnection.connectionId), false);
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
        probe: startupWorkerProbe(),
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
async function waitFor(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  // The complete suite exercises browser builds alongside this real WS
  // composition. Keep the assertion bounded, but leave enough scheduler room
  // for the Worker to install its JSON-RPC server after the accepted transport.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
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
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
    }),
    projectRoot: '/synthetic/project-root',
  });
  try {
    const keyPath = join(directory, 'host-a-key.pem');
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: 'host-a',
      displayName: 'Host A',
      publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;
    // Application composition has no raw epoch issuer, and a pending enrollment
    // cannot obtain Gateway observation authority.
    assert.equal(runtime.workerGateway.authorizeObservation('host-a'), undefined);
    assert.equal(
      await runtime.enrollments.observeReadiness(enrollmentId, scriptedReadinessProbe(), {} as never),
      false,
    );
    // Still pending: no admission.
    assert.equal(runtime.environmentCatalog.entry('host-a')?.eligible ?? false, false);
    assert.equal(await runtime.stores.environmentReadiness.getReadiness('host-a'), undefined);

    // Approval is necessary but not sufficient; only a post-approval Worker
    // observation can restore readiness authority.
    await runtime.enrollments.approve(enrollmentId, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
    await connectRuntimeWorker(runtime, enrollmentId, keyPath);
    const epoch = runtime.workerGateway.currentConnectionEpoch(enrollmentId)!;
    await runtime.enrollments.observeReadiness(enrollmentId, scriptedReadinessProbe(),
      readinessAuthority(runtime, enrollmentId, epoch));
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

/**
 * #124 acceptance: one application-level readiness workflow across triggers.
 *
 * These scenarios cross the composed Runtime with real enrollment approval, the
 * real WorkerGateway, an authenticated Worker JSON-RPC channel, and the real HTTP
 * router. The same contract runs against memory and SQLite. Authority is the
 * actual accepted connection: no fabricated epoch callback or raw current-
 * readiness seeding stands in for it.
 */

/** Compose one accepted enrollment + Worker for the #124 acceptance scenarios. */
async function readinessWorkflowHarness(options: {
  readonly backend: 'memory' | 'sqlite';
  readonly directory: string;
  readonly agents?: readonly AgentDefinition[];
}): Promise<{
  readonly runtime: SproutRuntime;
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
  connect(
    enrollmentId: string,
    keyPath: string,
    worker?: {
      readonly readiness?: () => WorkerReadinessFacts;
      readonly readinessProbe?: (params: WorkerReadinessProbeParams) => Promise<WorkerReadinessProbeResult>;
    },
  ): Promise<WorkerEnrollmentConnection>;
  close(): Promise<void>;
}> {
  const { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } = await import(
    './worker/enrollment-connector.ts'
  );
  const { EnvironmentWorker } = await import('./worker/server.ts');
  const { WORKER_PROTOCOL_VERSION } = await import('./worker/protocol.ts');
  const { signWorkerChallenge } = await import('./environment/worker-proof.ts');
  const credential = randomBytes(16).toString('base64url');
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(options.directory, 'sprout.db'),
      environmentSource: 'enrollment',
      operatorCredential: credential,
      ...(options.agents !== undefined
        ? { runtimeConfiguration: { agents: [...options.agents] } }
        : {}),
    }),
    projectRoot: '/synthetic/project-root',
    ...(options.backend === 'memory' ? { stores: inMemoryStores() } : {}),
  });
  const { port } = await runtime.api.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const session = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  assert.equal(session.status, 201);
  const cookie = (session.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  const { csrfToken } = (await session.json()) as { csrfToken: string };

  // Claim with the host key, prove possession, approve, then accept the Worker.
  const workers: EnvironmentWorker[] = [];
  const connections: WorkerEnrollmentConnection[] = [];

  const requested = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: INSTANCE_ID,
    displayName: 'Workflow Host',
    platform: 'macos',
    capabilityRequests: [ADMISSION_CAPABILITY],
    engineFacts: [],
  });
  const enrollmentId = requested.enrollment.id;
  const keyPath = join(options.directory, 'worker-key.pem');
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

  return {
    runtime,
    base,
    cookie,
    csrf: csrfToken,
    async connect(id, key, worker = {}) {
      const connection = await connectWorkerEnrollment({
        target: { enrollmentId: id, host: '127.0.0.1', port, claimSecret: undefined, identityKeyPath: key },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engineFacts: [{ engine: 'codex', installed: true, authenticated: true, models: [] }],
      });
      connections.push(connection);
      const declaration = worker.readiness;
      workers.push(new EnvironmentWorker({
        environmentInstanceId: INSTANCE_ID,
        engines: new Map(),
        input: connection.stream,
        output: connection.stream,
        ...(declaration !== undefined ? { readiness: declaration } : {}),
        ...(worker.readinessProbe !== undefined ? { readinessProbe: worker.readinessProbe } : {}),
      }));
      return connection;
    },
    async close() {
      for (const worker of workers) await worker.shutdown().catch(() => undefined);
      for (const connection of connections) connection.close();
      await runtime.close();
    },
  };
}

for (const backend of ['memory', 'sqlite'] as const) {
  test(`#124 ${backend}: startup and automatic target probes cross one workflow and commit canonical facts`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-target-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      let received: WorkerReadinessProbeParams | undefined;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async (params) => {
          received = params;
          const probe = {
            at: Date.now(), latencyMs: 8, protocolOk: true, enginesOk: true,
            source: 'worker' as const, version: '0.154.0', summary: 'target probe',
          };
          return {
            readiness: {
              protocolVersion: WORKER_PROTOCOL_VERSION,
              engines: [
                { engine: 'scripted', version: '1.0.0', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] },
                { engine: 'codex', version: '0.154.0', installed: true, readiness: 'ready', modelAvailability: 'unknown', models: [], authenticated: true, authMode: 'chatgpt', probedAt: 2, probeExitCode: 0, source: 'codex-account-read', targetModels: params.requirements?.modelsByEngine?.codex ?? [], requirementRevision: params.requirements?.revision },
              ],
              probe,
            },
            probe,
          };
        },
      });
      await waitFor(() => received !== undefined, 'the target probe to reach the Worker');
      assert.deepEqual(received?.requiredModels, ['gpt-6-astra'], 'targets are core-owned');
      assert.match(received?.attemptId ?? '', /^obs-/);
      await waitFor(async () => (await h.runtime.enrollments.listProbes(enrollmentId)).length > 0, 'target-probe receipt');
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false, 'unknown entitlement is not admissible');
      const readiness = await h.runtime.enrollments.readiness(enrollmentId);
      assert.equal(readiness.readiness.probe?.latencyMs, 8);
      const codex = readiness.readiness.engines.find((engine) => engine.engine === 'codex');
      assert.equal(codex?.version, '0.154.0');
      assert.equal(codex?.source, 'codex-account-read');
    } finally {
      await h.close();
    }
  });

  test(`#124 ${backend}: empty-target bootstrap commits one canonical observation`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-bootstrap-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readiness: () => ({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          engines: [
            { engine: 'scripted', version: '1.0.0', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] },
          ],
          probe: { at: Date.now(), latencyMs: 4, protocolOk: true, enginesOk: true, source: 'worker', version: '1.0.0', summary: 'bootstrap probe' },
        }),
      });
      await waitFor(async () => (await h.runtime.enrollments.listProbes(enrollmentId)).length > 0, 'bootstrap receipt');
      const probes = await h.runtime.enrollments.listProbes(enrollmentId);
      assert.ok(probes.length >= 1, 'the bootstrap observation is durable');
      assert.equal(probes.at(-1)?.source, 'worker');
      const readiness = await h.runtime.enrollments.readiness(enrollmentId);
      assert.equal(readiness.readiness.connection.state, 'online');
      assert.equal(readiness.readiness.probe?.version, '1.0.0');
      assert.equal(readiness.summary.level, 'green', readiness.summary.reason);
    } finally {
      await h.close();
    }
  });

  test(`#124 ${backend}: a browser POST is request-only and cannot supply facts`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-request-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => {
          const probe = {
            at: Date.now(), latencyMs: 9, protocolOk: true, enginesOk: true,
            source: 'worker' as const, version: '0.154.0', summary: 'requested probe',
          };
          return {
            readiness: {
              protocolVersion: WORKER_PROTOCOL_VERSION,
              engines: [
                { engine: 'scripted', version: '1.0.0', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] },
                { engine: 'codex', version: '0.154.0', installed: true, readiness: 'ready', modelAvailability: 'unknown', models: [], authenticated: true, probedAt: 5, probeExitCode: 0, source: 'codex-account-read' },
              ],
              probe,
            },
            probe,
          };
        },
      });
      await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'startup eligibility');
      const response = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({
          readiness: { engines: [{ engine: 'forged', readiness: 'ready' }] },
          probe: { source: 'browser', version: 'forged', summary: 'browser fact' },
          connectionEpoch: 999,
          requiredModels: ['browser-forgery'],
        }),
      });
      const text = await response.text();
      assert.equal(response.status, 201, text);
      assert.equal(text.includes('browser fact'), false);
      const returned = JSON.parse(text) as { probe: { source?: string } };
      assert.equal(returned.probe.source, 'worker');
    } finally {
      await h.close();
    }
  });

  test(`#124 ${backend}: contradictory Worker probe copies never mutate observation state`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-malformed-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const valid = { at: Date.now(), latencyMs: 9, protocolOk: true, enginesOk: true, source: 'worker' as const, version: '0.154.0', summary: 'probe' };
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe: valid },
          probe: { ...valid, summary: 'contradictory returned copy' },
        }),
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');
      const response = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.notEqual(response.status, 201);
      const readiness = await h.runtime.enrollments.readiness(enrollmentId);
      assert.equal(readiness.readiness.probe, undefined, 'no committed probe from a contradictory result');
      assert.deepEqual(await h.runtime.enrollments.listProbes(enrollmentId), []);
    } finally {
      await h.close();
    }
  });

  test(`#124 ${backend}: revoke inside the probe window reports no current facts`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-revoke-'));
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
      let calls = 0;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => {
          calls += 1;
          started?.();
          await gate;
          const probe = {
            at: Date.now(), latencyMs: 9, protocolOk: true, enginesOk: true,
            source: 'worker' as const, version: '0.154.0', summary: 'delayed probe',
          };
          return {
            readiness: {
              protocolVersion: WORKER_PROTOCOL_VERSION,
              engines: [
                { engine: 'scripted', version: '1.0.0', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] },
                { engine: 'codex', version: '0.154.0', installed: true, readiness: 'ready', modelAvailability: 'unknown', models: [], authenticated: true, probedAt: 5, probeExitCode: 0, source: 'codex-account-read' },
              ],
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
      await h.runtime.enrollments.revoke(enrollmentId, 'retired mid-probe');
      release?.();
      const response = await pending;
      assert.notEqual(response.status, 201, 'a superseded response is never a successful probe');
      assert.equal(((await response.json()) as { probe?: unknown }).probe, undefined);
      const readiness = await h.runtime.enrollments.readiness(enrollmentId);
      assert.equal(readiness.readiness.connection.state, 'never-connected');
      assert.equal(readiness.readiness.probe, undefined);
      assert.deepEqual(await h.runtime.enrollments.listProbes(enrollmentId), []);
      assert.ok(calls >= 1, 'the real Worker probe was exercised before the revoke');
    } finally {
      await h.close();
    }
  });

  test(`#124 ${backend}: malformed readiness/engine facts are refused over the accepted Worker without mutation`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-124-engine-facts-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      // A configured target model selects the explicit target-probe collection
      // mode, so the same malformed result also crosses the automatic path.
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const probe = {
        at: Date.now(), latencyMs: 7, protocolOk: true, enginesOk: false,
        source: 'worker' as const, version: '0.154.0', summary: 'malformed engine facts probe',
      };
      // Every engine below is invalid for a distinct reason: unknown readiness
      // enum, non-boolean installed, unknown model-availability enum, non-array
      // models, and an extra disallowed field. The result envelope and probe
      // record are valid, so a refusal can only come from the engine-fact guard.
      const malformedEngines = [
        { engine: 'codex', installed: true, readiness: 'certainly-ready', modelAvailability: 'available', models: [] },
        { engine: 'pi', installed: 'yes', readiness: 'ready', modelAvailability: 'available', models: [] },
        { engine: 'opencode', installed: true, readiness: 'ready', modelAvailability: 'plenty', models: [] },
        { engine: 'agy', installed: true, readiness: 'ready', modelAvailability: 'available', models: 'a-model' },
        { engine: 'cursor', installed: true, readiness: 'ready', modelAvailability: 'available', models: [], accountEmail: 'worker@invalid' },
      ];
      let calls = 0;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => {
          calls += 1;
          return {
            readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: malformedEngines, probe },
            probe,
          } as never;
        },
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');
      // Automatic trigger: the transitional entry point delegates to the one
      // composed workflow. Await it so the refusal is deterministic rather than
      // inferred from an absent store row.
      await h.runtime.observeWorkerReadiness(enrollmentId);
      assert.ok(calls >= 1, 'the real Worker JSON-RPC probe was exercised');
      assert.equal(
        await h.runtime.stores.environmentReadiness.getReadiness(INSTANCE_ID),
        undefined,
        'a malformed engine fact must not commit a readiness document',
      );
      assert.deepEqual(
        await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID),
        [],
        'a malformed engine fact must not append probe history',
      );
      // Explicit trigger: the Human-requested probe crosses the same workflow.
      const response = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.notEqual(response.status, 201, 'a malformed engine fact is never a successful probe');
      assert.equal(((await response.json()) as { probe?: unknown }).probe, undefined);
      assert.equal(
        await h.runtime.stores.environmentReadiness.getReadiness(INSTANCE_ID),
        undefined,
        'the explicit path must also leave no readiness document',
      );
      assert.deepEqual(
        await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID),
        [],
        'the explicit path must also append no probe history',
      );
      const assembled = await h.runtime.enrollments.readiness(enrollmentId);
      assert.equal(assembled.readiness.connection.state, 'never-connected');
      assert.deepEqual(assembled.probes, []);
    } finally {
      await h.close();
    }
  });

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

  test(`#126 ${backend}: malformed requirement scope refuses through accepted Runtime authority without mutation`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-126-scope-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const probe = { at: Date.now(), latencyMs: 5, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '1.0.0', summary: 'scope probe' };
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe }, probe,
        }),
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');
      const authority = h.runtime.workerGateway.authorizeObservation(INSTANCE_ID);
      assert.ok(authority);
      const result = { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe }, probe };
      const store = h.runtime.stores.environmentReadiness;
      const before = await store.getCurrentObservation(INSTANCE_ID);
      const history = await store.listObservations(INSTANCE_ID);
      const probes = await store.listProbes(INSTANCE_ID);
      for (const requirements of [null, [], 1, 'bad', { unknown: true },
        { revision: 'bad/revision' }, { requiredModels: [null] }, { requiredModels: ['bad/model'] }]) {
        assert.equal(await h.runtime.enrollments.recordReadinessObservation(
          enrollmentId, result, authority, { requirements } as never,
        ), undefined);
        assert.deepEqual(await store.getCurrentObservation(INSTANCE_ID), before);
        assert.deepEqual(await store.listObservations(INSTANCE_ID), history);
        assert.deepEqual(await store.listProbes(INSTANCE_ID), probes);
      }
      const receipt = await h.runtime.enrollments.recordReadinessObservation(
        enrollmentId, result, authority, { requirements: { revision: 'r1', requiredModels: ['safe-model'] } },
      );
      assert.ok(receipt);
      assert.deepEqual(receipt.requirements, { revision: 'r1', requiredModels: ['safe-model'] });
    } finally {
      await h.close();
    }
  });

  test(`#126 ${backend}: concurrent read during an in-flight commit returns facts and probe from the same observation (Scenario 8)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-126-concurrent-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const initialProbe = {
        at: 10_000, latencyMs: 5, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '1.0.0', summary: 'initial probe',
      };
      const secondProbe = {
        at: 20_000, latencyMs: 7, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '1.0.0', summary: 'second probe',
      };

      let currentProbeResult = initialProbe;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            engines: [
              { engine: 'codex', version: '1.0.0', installed: true, authenticated: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-6-astra'] },
            ],
            probe: currentProbeResult,
          },
          probe: currentProbeResult,
        }),
      });
      await waitFor(
        async () => (await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID)).length >= 1,
        'startup observation',
      );

      // Intercept store commit to hold during the second probe commit
      const store = h.runtime.stores.environmentReadiness;
      const origCommit = store.commitObservation.bind(store);
      let commitStartedSignal!: () => void;
      const commitStartedPromise = new Promise<void>((r) => { commitStartedSignal = r; });
      let releaseCommit!: () => void;
      const releasePromise = new Promise<void>((r) => { releaseCommit = r; });

      store.commitObservation = async (...args) => {
        commitStartedSignal();
        await releasePromise;
        return origCommit(...args);
      };

      currentProbeResult = secondProbe;
      const pendingPost = fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });

      await commitStartedPromise;

      // Concurrent read during the in-flight commit window
      const concurrentGet = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/readiness`, {
        headers: { cookie: h.cookie },
      });
      assert.equal(concurrentGet.status, 200);
      const concurrentBody = (await concurrentGet.json()) as {
        readonly readiness: { readonly observationId?: string; readonly probe?: { readonly at: number } };
        readonly receipt?: { readonly observationId: string };
      };
      // Before commit finishes, current readiness has not advanced
      if (concurrentBody.readiness.probe !== undefined) {
        assert.equal(concurrentBody.readiness.probe.at, initialProbe.at);
      }

      // Complete commit
      releaseCommit();
      const postResponse = await pendingPost;
      assert.equal(postResponse.status, 201);
      const postBody = (await postResponse.json()) as {
        readonly probe: { readonly at: number };
        readonly receipt: { readonly observationId: string; readonly sequence: number };
      };
      assert.equal(postBody.probe.at, secondProbe.at);
      assert.ok(postBody.receipt.observationId.length > 0);

      // Post-commit read: both facts and probe metadata come from the second observation
      const postGet = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/readiness`, {
        headers: { cookie: h.cookie },
      });
      assert.equal(postGet.status, 200);
      const postGetBody = (await postGet.json()) as {
        readonly readiness: { readonly observationId?: string; readonly probe?: { readonly at: number } };
        readonly receipt?: { readonly observationId: string };
      };
      assert.equal(postGetBody.readiness.observationId, postBody.receipt.observationId);
      assert.equal(postGetBody.readiness.probe?.at, secondProbe.at);
      assert.equal(postGetBody.receipt?.observationId, postBody.receipt.observationId);
    } finally {
      await h.close();
    }
  });

  test(`#126 ${backend}: committed receipts identify exact observation and support direct retrieval with multi-engine provenance (Scenario 11)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-126-receipt-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const multiProbe = {
        at: 50_000, latencyMs: 8, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: 'multi-v1-custom/unpinned', summary: 'multi engine probe',
      };
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            engines: [
              { engine: 'codex', version: 'raw-unsupported-version-build', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-6-astra'] },
              { engine: 'pi', version: '0.86.1', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['pi-model'] },
            ],
            probe: multiProbe,
          },
          probe: multiProbe,
        }),
      });
      await waitFor(
        async () => (await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID)).length >= 1,
        'startup probe',
      );

      // 1. POST probe returns receipt identifying exact canonical observation
      const postRes = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(postRes.status, 201);
      const postBody = (await postRes.json()) as {
        readonly probe: { readonly at: number; readonly source?: string };
        readonly receipt: { readonly observationId: string; readonly sequence: number; readonly committedAt: number };
      };
      assert.equal(postBody.probe.source, 'worker');
      const observationId = postBody.receipt.observationId;
      assert.ok(observationId.startsWith('obs-'));

      // 2. Subsequent GET /readiness identifies the same observation directly
      const getRes = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/readiness`, {
        headers: { cookie: h.cookie },
      });
      assert.equal(getRes.status, 200);
      const getBody = (await getRes.json()) as {
        readonly readiness: {
          readonly observationId?: string;
          readonly engines: readonly { readonly engine: string; readonly version?: string }[];
        };
        readonly receipt?: { readonly observationId: string; readonly sequence: number };
      };
      assert.equal(getBody.readiness.observationId, observationId);
      assert.equal(getBody.receipt?.observationId, observationId);
      assert.equal(getBody.receipt?.sequence, postBody.receipt.sequence);

      // Canonical unknown-version and multi-engine provenance
      const codexEngine = getBody.readiness.engines.find((e) => e.engine === 'codex');
      const piEngine = getBody.readiness.engines.find((e) => e.engine === 'pi');
      assert.equal(codexEngine?.version, 'unknown-version', 'unsupported version format is sanitized to unknown-version');
      assert.equal(piEngine?.version, '0.86.1');

      // 3. Direct retrieval via GET /receipts/:observationId without history scan
      const directReceiptRes = await fetch(
        `${h.base}/api/environments/enrollments/${enrollmentId}/receipts/${observationId}`,
        { headers: { cookie: h.cookie } },
      );
      assert.equal(directReceiptRes.status, 200);
      const directReceiptBody = (await directReceiptRes.json()) as { readonly receipt: { readonly observationId: string } };
      assert.equal(directReceiptBody.receipt.observationId, observationId);
      assert.deepEqual((directReceiptBody.receipt as unknown as { readiness: unknown }).readiness,
        (postBody.receipt as unknown as { readiness: unknown }).readiness);

      // Unknown observation id returns 404
      const notFoundReceipt = await fetch(
        `${h.base}/api/environments/enrollments/${enrollmentId}/receipts/obs-non-existent`,
        { headers: { cookie: h.cookie } },
      );
      assert.equal(notFoundReceipt.status, 404);
    } finally {
      await h.close();
    }
  });

  test(`#126 ${backend}: defensive copies on API responses cannot affect stored state or admission (Scenario 12)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-126-defensive-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
    });
    try {
      const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
      const probeFact = {
        at: 60_000, latencyMs: 5, protocolOk: true, enginesOk: true,
        source: 'worker' as const, version: '1.0.0', summary: 'probe for defensive test',
      };
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async () => ({
          readiness: {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            engines: [
              { engine: 'codex', version: '1.0.0', installed: true, readiness: 'unknown', modelAvailability: 'unknown', models: [] },
            ],
            probe: probeFact,
          },
          probe: probeFact,
        }),
      });
      await waitFor(
        async () => (await h.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID)).length >= 1,
        'startup observation',
      );

      const postRes = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(postRes.status, 201);
      const postBody = (await postRes.json()) as Record<string, any>;
      // Attempt mutation of response payload
      postBody.receipt.observationId = 'forged-obs-id';
      postBody.probe.protocolOk = false;

      const getRes = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/readiness`, {
        headers: { cookie: h.cookie },
      });
      assert.equal(getRes.status, 200);
      const getBody = (await getRes.json()) as Record<string, any>;
      // Attempt mutation of GET payload
      getBody.readiness.engines[0].readiness = 'ready';
      getBody.readiness.engines[0].models = { state: 'available', models: ['gpt-6-astra'] };

      // Verify stored state in runtime and admission eligibility are untouched
      const currentObs = await h.runtime.stores.environmentReadiness.getCurrentObservation(INSTANCE_ID);
      assert.ok(currentObs);
      assert.notEqual(currentObs.observationId, 'forged-obs-id');
      assert.equal(currentObs.readiness.engines[0]?.readiness, 'unknown');
      assert.equal(currentObs.probe.protocolOk, true);

      // Admission still refuses because engine readiness is unknown
      await h.runtime.refreshEnvironmentCatalog();
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
    } finally {
      await h.close();
    }
  });
}

test('#126 sqlite: SQLite reopen preserves historical receipts while requiring fresh accepted Worker evidence for current state (Scenario 13)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-126-reopen-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  // First session: connect real worker, approve, probe, record receipt R1
  const h1 = await readinessWorkflowHarness({
    backend: 'sqlite',
    directory,
    agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }],
  });
  const enrollmentId = (await h1.runtime.enrollments.list())[0]!.id;
  const keyPath = join(directory, 'worker-key.pem');
  const probeFact1 = {
    at: 70_000, latencyMs: 5, protocolOk: true, enginesOk: true,
    source: 'worker' as const, version: '1.0.0', summary: 'first session probe',
  };
  await h1.connect(enrollmentId, keyPath, {
    readinessProbe: async () => ({
      readiness: {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engines: [
          { engine: 'codex', version: '1.0.0', installed: true, authenticated: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-6-astra'] },
        ],
        probe: probeFact1,
      },
      probe: probeFact1,
    }),
  });
  await waitFor(
    async () => (await h1.runtime.stores.environmentReadiness.listProbes(INSTANCE_ID)).length >= 1,
    'first startup',
  );
  const postRes1 = await fetch(`${h1.base}/api/environments/enrollments/${enrollmentId}/probes`, {
    method: 'POST',
    headers: { cookie: h1.cookie, 'x-sprout-csrf': h1.csrf, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(postRes1.status, 201);
  const postBody1 = (await postRes1.json()) as { readonly receipt: { readonly observationId: string; readonly sequence: number; readonly connectionEpoch: number } };
  const receipt1Id = postBody1.receipt.observationId;
  await h1.close();

  // Second session (reopen): before worker reconnects, old receipt is inspectable as history
  // but cannot establish current success
  const credential = randomBytes(16).toString('base64url');
  const second = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(directory, 'sprout.db'),
      environmentSource: 'enrollment',
      operatorCredential: credential,
      runtimeConfiguration: { agents: [{ ...agent('scout'), engine: 'codex', model: 'gpt-6-astra' }] },
    }),
    projectRoot: '/synthetic/project-root',
  });
  const { port: port2 } = await second.api.listen(0, '127.0.0.1');
  const base2 = `http://127.0.0.1:${port2}`;
  const session2 = await fetch(`${base2}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  const cookie2 = (session2.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  const { csrfToken: csrf2 } = (await session2.json()) as { csrfToken: string };

  const connections: WorkerEnrollmentConnection[] = [];
  const workers: InstanceType<typeof import('./worker/server.ts').EnvironmentWorker>[] = [];
  try {
    const reopenedGet = await fetch(`${base2}/api/environments/enrollments/${enrollmentId}/readiness`, {
      headers: { cookie: cookie2 },
    });
    assert.equal(reopenedGet.status, 200);
    const reopenedBody = (await reopenedGet.json()) as {
      readonly readiness: { readonly connection: { readonly state: string }; readonly probe?: unknown };
      readonly receipt?: unknown;
    };
    // Reopened database has no live worker connection: cannot establish current success
    assert.equal(reopenedBody.readiness.probe, undefined);
    assert.equal(reopenedBody.receipt, undefined);
    assert.equal(second.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);

    // Old receipt R1 remains directly inspectable as history
    const histReceiptRes = await fetch(`${base2}/api/environments/enrollments/${enrollmentId}/receipts/${receipt1Id}`, {
      headers: { cookie: cookie2 },
    });
    assert.equal(histReceiptRes.status, 200);
    const histReceiptBody = (await histReceiptRes.json()) as { readonly receipt: { readonly observationId: string } };
    assert.equal(histReceiptBody.receipt.observationId, receipt1Id);

    // Fresh accepted Worker evidence is required to establish current success
    const probeFact2 = {
      at: 80_000, latencyMs: 6, protocolOk: true, enginesOk: true,
      source: 'worker' as const, version: '1.0.0', summary: 'second session probe',
    };
    const { connectWorkerEnrollment } = await import('./worker/enrollment-connector.ts');
    const { EnvironmentWorker } = await import('./worker/server.ts');
    const conn2 = await connectWorkerEnrollment({
      target: { enrollmentId, host: '127.0.0.1', port: port2, claimSecret: undefined, identityKeyPath: keyPath },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engineFacts: [{ engine: 'codex', installed: true, authenticated: true, models: [] }],
    });
    connections.push(conn2);
    workers.push(new EnvironmentWorker({
      environmentInstanceId: INSTANCE_ID,
      engines: new Map(),
      input: conn2.stream,
      output: conn2.stream,
      readinessProbe: async () => ({
        readiness: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          engines: [
            { engine: 'codex', version: '1.0.0', installed: true, authenticated: true, readiness: 'ready', modelAvailability: 'available', models: ['gpt-6-astra'] },
          ],
          probe: probeFact2,
        },
        probe: probeFact2,
      }),
    }));
    await waitFor(
      () => second.workerGateway.liveFor(INSTANCE_ID) !== undefined,
      'reconnected channel',
    );

    const postRes2 = await fetch(`${base2}/api/environments/enrollments/${enrollmentId}/probes`, {
      method: 'POST',
      headers: { cookie: cookie2, 'x-sprout-csrf': csrf2, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(postRes2.status, 201);
    const postBody2 = (await postRes2.json()) as { readonly receipt: { readonly observationId: string; readonly sequence: number; readonly connectionEpoch: number } };
    assert.notEqual(postBody2.receipt.observationId, receipt1Id);
    assert.ok(postBody2.receipt.sequence > postBody1.receipt.sequence);

    // Verify durable internal store receipts track monotonic epochs
    const internal1 = await second.stores.environmentReadiness.getReceipt(INSTANCE_ID, receipt1Id);
    const internal2 = await second.stores.environmentReadiness.getReceipt(INSTANCE_ID, postBody2.receipt.observationId);
    assert.ok(internal1 && internal2);
    assert.ok(internal2.connectionEpoch > internal1.connectionEpoch);

    // Now current readiness has the fresh receipt
    const freshGet = await fetch(`${base2}/api/environments/enrollments/${enrollmentId}/readiness`, {
      headers: { cookie: cookie2 },
    });
    const freshBody = (await freshGet.json()) as { readonly receipt?: { readonly observationId: string } };
    assert.equal(freshBody.receipt?.observationId, postBody2.receipt.observationId);
  } finally {
    for (const w of workers) await w.shutdown().catch(() => undefined);
    for (const c of connections) c.close();
    await second.close();
  }
});
