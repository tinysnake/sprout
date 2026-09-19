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
import { InMemoryProjectStore } from './project/store.ts';
import { InMemorySessionKeyStore } from './run/session-key-store.ts';
import { InMemoryRunStore } from './run/store.ts';
import { InMemoryTaskStore } from './task/store.ts';
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
  return {
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
    ...overrides,
  };
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
  database.exec('PRAGMA user_version = 2; CREATE TABLE retained_data (id TEXT PRIMARY KEY);');
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
