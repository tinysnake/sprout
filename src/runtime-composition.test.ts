import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteUsageStore } from './usage/sqlite-store.ts';
import { InMemoryUsageStore, type UsageStore } from './usage/store.ts';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { SchemaTooNewError, CURRENT_SCHEMA_VERSION } from './store/schema.ts';
import {
  MissingEnvironmentEngineError,
  type RuntimeEnvironment,
  type RuntimeStores,
} from './runtime.ts';
import { InMemoryRunStore } from './run/store.ts';
import { InMemoryRunReconnectRetryStore } from './run/reconnect-retry-store.ts';
import { InMemoryLeaseStore } from './environment/pool.ts';
import { InMemorySessionKeyStore } from './run/session-key-store.ts';
import { InMemoryCollaborationStore } from './collaboration/store.ts';
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
import { InMemoryTaskProposalStore } from './task/proposal-store.ts';
import { InMemoryConversationScopeStore } from './conversation/store.ts';
import {
  build,
  createRuntime,
  hostConfiguration,
  inMemoryStores,
  INSTANCE_ID,
  PROJECT_ID,
  scriptedEnvironment,
  scriptedTurn,
} from './runtime-test-harness.ts';

test('run settles and core writes stay loud when usage telemetry fails', async () => {
  const stores = inMemoryStores();
  const usage = new Proxy(new InMemoryUsageStore(), {
    get(target, property) {
      if (property === 'recordActivity') {
        return async () => {
          throw Object.assign(new Error('injected database contention'), { code: 'SQLITE_BUSY' });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as UsageStore;
  const coreTasks = new Proxy(stores.tasks, {
    get(target, property) {
      if (property === 'create') return async () => { throw new Error('core task write failed'); };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const environment = scriptedEnvironment({
    adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [scriptedTurn('settled despite telemetry')] })]]),
  });
  const runtime = await createRuntime({
    configuration: hostConfiguration(),
    projectRoot: '/synthetic/project-root',
    environment,
    stores: { ...stores, tasks: coreTasks, usage },
  });
  const originalWrite = process.stderr.write;
  let logged = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logged += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const { id } = await runtime.orchestrator.submit({ agentId: 'scout', prompt: 'complete the run' });
    const settled = await runtime.orchestrator.waitFor(id);
    assert.equal(settled.status, 'completed');
    assert.equal((await runtime.orchestrator.load(id))?.status, 'completed');
    await new Promise((resolve) => setImmediate(resolve));
    const logLines = logged.trim().split('\n');
    assert.ok(logLines.length >= 1);
    assert.ok(logLines.every((line) => line === 'Usage telemetry write failed; record dropped.'));
    assert.doesNotMatch(logged, /injected|SQLITE_BUSY|run-|host|synthetic/);

    await assert.rejects(
      runtime.stores.tasks.create({} as never),
      /core task write failed/,
      'core task persistence errors must remain observable',
    );
  } finally {
    process.stderr.write = originalWrite;
    await runtime.close();
  }
});

test('runtime refuses Task lead override when durable run state is still active despite terminal memory', async () => {
  await assertRuntimeAuthorityOverrideRefusesDurableState('active', 'run-still-active');
});

test('runtime refuses Task lead override when durable run state is missing despite terminal memory', async () => {
  await assertRuntimeAuthorityOverrideRefusesDurableState('missing', 'run-state-unavailable');
});

test('runtime refuses Task lead override when durable run state cannot be read despite terminal memory', async () => {
  await assertRuntimeAuthorityOverrideRefusesDurableState('error', 'run-state-unavailable');
});

test('runtime refuses Task lead override when durable run status is unqueryable despite terminal memory', async () => {
  await assertRuntimeAuthorityOverrideRefusesDurableState('unknown', 'run-state-unavailable');
});

async function assertRuntimeAuthorityOverrideRefusesDurableState(
  durableState: 'active' | 'missing' | 'error' | 'unknown',
  expectedCode: 'run-still-active' | 'run-state-unavailable',
): Promise<void> {
  const stores = inMemoryStores();
  let durableRead: 'normal' | 'active' | 'missing' | 'error' | 'unknown' = 'normal';
  const runs = new Proxy(stores.runs, {
    get(target, property) {
      if (property === 'get') {
        return async (runId: string) => {
          if (durableRead === 'missing') return undefined;
          if (durableRead === 'error') throw new Error('durable run store read failed');
          const stored = await target.get(runId);
          if (durableRead === 'unknown' && stored !== undefined) return { ...stored, status: 'unqueryable' as never };
          return durableRead === 'active' && stored !== undefined
            ? { ...stored, status: 'running' as const }
            : stored;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as RuntimeStores['runs'];
  const runtime = await createRuntime({
    configuration: hostConfiguration(),
    projectRoot: '/synthetic/project-root',
    environment: scriptedEnvironment({
      adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [scriptedTurn('settled')] })]]),
    }),
    stores: { ...stores, runs },
  });
  try {
    const { id: runId } = await runtime.orchestrator.submit({ agentId: 'scout', prompt: 'settle before recovery' });
    assert.equal((await runtime.orchestrator.waitFor(runId)).status, 'completed');
    assert.equal(runtime.orchestrator.get(runId)?.status, 'completed', 'the in-memory orchestrator reports terminal state');
    assert.equal((await stores.runs.get(runId))?.status, 'completed', 'the durable record starts terminal');

    const acquired = runtime.pool.acquireLease({
      instanceId: INSTANCE_ID, capability: 'agent-run', mode: 'read-write', holderId: 'scout', runId, ttlMs: 60_000,
    });
    assert.equal(acquired.ok, true);
    if (!acquired.ok) throw new Error('run lease was not admitted');
    await runtime.recovery.open({ leaseId: acquired.lease.id, cause: 'worker-channel-lost', hadActiveRun: true, runId });
    assert.equal(runtime.pool.getLease(acquired.lease.id)?.state, 'recovering');

    durableRead = durableState;
    await assert.rejects(runtime.recovery.authorityOverrideRelease(acquired.lease.id, {
      authorityTaskId: 'task-lead-authority',
      environmentInstanceId: INSTANCE_ID,
      actorId: 'task-lead-agent',
      actorKind: 'agent',
      acknowledgedRisks: true,
      reason: 'The durable run state must control settlement.',
    }), (error: unknown) => (error as { code?: string }).code === expectedCode);
    assert.equal(runtime.pool.getLease(acquired.lease.id)?.state, 'recovering',
      'a durable active or missing record cannot release the recovering lease');
  } finally {
    await runtime.close();
  }
}

test('runtime composition opens its configured database through the WAL-enabled SqliteStore path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-runtime-wal-'));
  const filename = join(directory, 'runtime.sqlite');
  const runtime = await createRuntime({
    configuration: hostConfiguration({ databasePath: filename }),
    projectRoot: '/synthetic/project-root',
    environment: scriptedEnvironment({
      adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
    }),
  });
  try {
    const probe = new DatabaseSync(filename);
    try {
      assert.equal((probe.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    } finally {
      probe.close();
    }
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the complete runtime graph is constructible over in-memory collaborators and scripted engines', async () => {
  const { runtime, stores, environment } = await build({ listen: false });

  assert.equal(runtime.instance?.id, INSTANCE_ID);
  assert.equal(runtime.definition?.platform, 'macos');
  assert.deepEqual(runtime.agents.list().map((definition) => definition.id).sort(), ['scout', 'scribe']);
  assert.deepEqual(runtime.projects.list().map((registered) => registered.id), [PROJECT_ID]);
  assert.deepEqual([...runtime.engines.keys()], ['scripted']);
  assert.notEqual(runtime.stores, stores, 'application view does not expose injected store writers');
  assert.equal('commitObservation' in runtime.stores.environmentReadiness, false);
  assert.equal('issueAttempt' in runtime.stores.environmentReadiness, false);
  assert.equal('authorizeObservation' in runtime.workerGateway, false);
  assert.equal('authorizeObservation' in (runtime.workerGateway.liveFor(INSTANCE_ID) ?? {}), false);
  assert.equal('recordReadinessObservation' in runtime.enrollments, false);
  assert.equal('observeWorkerReadiness' in runtime, false);

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

test('runtime coordinator persists every real routing attempt with exact correlation and unavailable telemetry', async () => {
  for (const configured of [false, true]) {
    const model = { id: 'composition-wake-model', telemetryForAttempt: () => ({ tokens: { inputTokens: 10, outputTokens: 2 } }),
      async judge(request: { attempt: number; context: string }) {
        if (request.attempt === 1) return 'invalid output';
        const ids = [...request.context.matchAll(/\[input \d+ \| id=([^ |]+) \|/g)].map((match) => match[1]!);
        return JSON.stringify({ selections: [], suppressions: ids.map((inputId) => ({ inputId, rationale: 'No wake needed' })) });
      } };
    const directory = mkdtempSync(join(tmpdir(), 'sprout-usage-composition-'));
    const filename = join(directory, 'usage.db');
    const db = new DatabaseSync(filename);
    const usage = new SqliteUsageStore({ db });
    const runtime = await createRuntime({ configuration: hostConfiguration(), projectRoot: '/synthetic/project-root',
      environment: scriptedEnvironment({ adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]) }),
      stores: { ...inMemoryStores(), usage },
      ...(configured ? { routingModel: model } : {}),
    });
    try {
      const project = await runtime.projectService.create({ id: 'usage-routing-project', displayName: 'Usage routing',
        agentMemberships: [{ agentId: 'scout' }], wakePolicy: 'wake-model-assisted', routingIntervalMs: 1000 });
      const scope = await runtime.conversationScopes.ensureProjectChannel(project.id);
      await runtime.collaboration.deliver({ scopeId: scope.id, author: { id: 'operator', kind: 'human' },
        body: 'unaddressed work', deliveryKey: 'usage-routing-composition' });
      await new Promise((resolve) => setTimeout(resolve, 1050));
      await runtime.collaboration.sweepRouting();
      const batches = await runtime.stores.collaboration.listRoutingBatches(project.id);
      assert.equal(batches.length, 1);
      const attempts = await runtime.stores.collaboration.listRoutingAttempts(batches[0]!.id);
      assert.equal(attempts.length, 2);
      const activities = await runtime.usage.listActivities({ kind: 'routing_attempt' });
      assert.equal(activities.length, attempts.length);
      for (const attempt of attempts) {
        const detail = await runtime.usage.getActivityByAttemptId(attempt.id);
        assert.equal(detail?.activity.correlation.batchId, attempt.batchId);
        assert.equal(detail?.activity.correlation.projectId, project.id);
        assert.equal(detail?.activity.correlation.agentId, undefined);
        assert.equal(detail?.activity.correlation.taskId, undefined);
        assert.equal(detail?.activity.status, configured && attempt.attemptNumber === 2 ? 'completed' : 'failed');
        assert.equal(detail?.effectiveObservation?.completeness, configured ? (attempt.attemptNumber === 2 ? 'complete' : 'partial') : 'unavailable');
        assert.equal(detail?.effectiveObservation?.tokens?.inputTokens, configured ? 10 : undefined);
      }
      await runtime.collaboration.reconcile();
      assert.equal((await runtime.usage.listActivities({ kind: 'routing_attempt' })).length, 2);
      // Simulate a crash after attempt persistence but before usage persistence.
      db.exec('DELETE FROM usage_observations; DELETE FROM usage_activities');
      await runtime.collaboration.reconcile();
      assert.equal((await runtime.usage.listActivities({ kind: 'routing_attempt' })).length, 2);
      for (const attempt of attempts) {
        assert.equal((await runtime.usage.getActivityByAttemptId(attempt.id))?.effectiveObservation?.completeness, 'unavailable');
      }
      // Independent SQLite connection sees the durable rows, not an in-memory view.
      const reopened = new DatabaseSync(filename);
      try {
        assert.equal((await new SqliteUsageStore({ db: reopened }).listActivities()).length, 2);
      } finally { reopened.close(); }
    } finally { await runtime.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('the configured bind host is honored by the Web listener', async () => {
  const configuration = hostConfiguration({ bindHost: '0.0.0.0' });
  const { runtime } = await build({ configuration, listen: false });
  try {
    await runtime.api.listen(configuration.port, configuration.bindHost);
    const address = runtime.api.server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '0.0.0.0');
  } finally {
    await runtime.close();
  }
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

test('the startup report preserves the operator log contract, including conditional lines', async () => {
  const { runtime } = await build();

  // Before reconciliation the conditional lines are absent, exactly as before.
  const report = runtime.startupReport(41030);
  assert.equal(
    report,
    'Sprout listening on http://127.0.0.1:41030\n' +
      '  execution:  environment-hosted\n' +
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
    runReconnectRetries: new InMemoryRunReconnectRetryStore(),
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
    conversationScopes: new InMemoryConversationScopeStore(),
    taskProposals: new InMemoryTaskProposalStore(),
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
  database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}; CREATE TABLE retained_data (id TEXT PRIMARY KEY);`);
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
