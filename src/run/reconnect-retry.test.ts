import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../agent/registry.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { InMemoryLeaseStore, EnvironmentPool } from '../environment/pool.ts';
import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';
import { RunOrchestrator } from './orchestrator.ts';
import {
  isEnvironmentDisconnectedFailure,
  RunReconnectRetry,
} from './reconnect-retry.ts';
import {
  InMemoryRunReconnectRetryStore,
  type RunReconnectRetryStore,
} from './reconnect-retry-store.ts';
import { InMemoryRunStore } from './store.ts';
import { SqliteStore } from '../store/db.ts';

const ENVIRONMENT_FAILURE = 'no available environment for capability: agent-run';

const definition: EnvironmentDefinition = {
  id: 'synthetic-def',
  platform: 'macos',
  capabilities: [
    { name: 'agent-run', requiresLease: true },
    { name: 'read-only-investigation', requiresLease: false },
  ],
};
const instanceIds = ['env-a', 'env-b'] as const;
const instances: readonly EnvironmentInstance[] = instanceIds.map((id) => ({
  id,
  definitionId: definition.id,
  workingDirectory: '/synthetic/work',
}));

function project(id: string, granted: readonly string[]): Project {
  return {
    id,
    goal: 'Bounded reconnect retry.',
    rules: [],
    availableEnvironmentInstanceIds: [...granted],
    memberships: [
      { agentId: 'scout', responsibilities: [], collaborationInstructions: '' },
    ],
  };
}

/** Poll a predicate so an async observer can settle, with a bounded deadline. */
async function until(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${description}`);
}

interface RetryHarness {
  readonly orchestrator: RunOrchestrator;
  readonly retryStore: RunReconnectRetryStore;
  readonly settlements: { originalRunId: string; retryRunId: string }[];
  readonly pool: EnvironmentPool;
  /** Construct (once) the service over this durable state. */
  service(): RunReconnectRetry;
  /** Publish the current connection/admission facts to the service. */
  note(): Promise<void>;
  setAvailable(available: boolean): void;
  connectOnly(instanceId: string): void;
  disconnect(instanceId: string): void;
}

function harness(options: {
  readonly adapter?: ScriptedEngineAdapter;
} = {}): RetryHarness {
  const connected = new Set<string>();
  const admissible = new Set<string>();
  const runsStore = new InMemoryRunStore();
  const retryStore = new InMemoryRunReconnectRetryStore();
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances,
    store: new InMemoryLeaseStore(),
    eligibleInstanceIds: [],
  });
  const projects = new ProjectRegistry([project('p1', [...instanceIds])]);
  const adapter = options.adapter ?? new ScriptedEngineAdapter({ turns: [] });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: new AgentRegistry([
      { id: 'scout', name: 'Scout', engine: 'scripted', capability: 'agent-run' },
    ]),
    projects,
    pool,
    store: runsStore,
  });
  const settlements: { originalRunId: string; retryRunId: string }[] = [];
  let current: RunReconnectRetry | undefined;
  const build = (): RunReconnectRetry =>
    new RunReconnectRetry({
      store: retryStore,
      runs: orchestrator,
      projects: () =>
        projects.list().map((entry) => ({
          projectId: entry.id,
          instanceIds: entry.availableEnvironmentInstanceIds,
        })),
      isConnected: (instanceId) => connected.has(instanceId),
      canAdmitWork: (instanceId) => admissible.has(instanceId),
      onRetrySettled: async (input) => {
        settlements.push(input);
      },
    });
  return {
    orchestrator,
    retryStore,
    settlements,
    pool,
    service: () => (current ??= build()),
    note: async () => {
      await (current ??= build()).noteEnvironmentState();
    },
    setAvailable(available: boolean): void {
      connected.clear();
      admissible.clear();
      if (available) {
        for (const id of instanceIds) connected.add(id);
        for (const id of instanceIds) admissible.add(id);
      }
      pool.synchronize({
        definitions: [definition],
        instances,
        eligibleInstanceIds: available ? [...instanceIds] : [],
      });
    },
    connectOnly(instanceId: string): void {
      connected.add(instanceId);
      admissible.add(instanceId);
      pool.synchronize({
        definitions: [definition],
        instances,
        eligibleInstanceIds: [...connected],
      });
    },
    disconnect(instanceId: string): void {
      connected.delete(instanceId);
      admissible.delete(instanceId);
      pool.synchronize({
        definitions: [definition],
        instances,
        eligibleInstanceIds: [...connected],
      });
    },
  };
}

/** Submit one run that fails before any environment resolves. */
async function submitDisconnectedRun(h: RetryHarness): Promise<string> {
  const { id } = await h.orchestrator.submit({
    agentId: 'scout',
    prompt: 'please answer',
    projectId: 'p1',
  });
  const run = await h.orchestrator.load(id);
  assert.equal(run?.status, 'failed');
  assert.equal(run?.failure, ENVIRONMENT_FAILURE);
  return id;
}

test('full disconnect then the first qualifying reconnect retries the failed run once', async () => {
  const h = harness({
    adapter: new ScriptedEngineAdapter({
      turns: [{ events: [], result: { status: 'completed', text: 'reconnected reply' } }],
    }),
  });
  h.setAvailable(false);
  const service = h.service();
  await service.reconcile();
  assert.equal((await h.retryStore.getGate('p1'))?.armed, true, 'all-disconnected arms the gate');

  const originalId = await submitDisconnectedRun(h);

  // The reconnect: connected and able to admit work again.
  h.setAvailable(true);
  const triggered = await service.noteEnvironmentState();
  assert.deepEqual(triggered.triggeredProjects, ['p1']);
  assert.deepEqual(triggered.queuedRunIds, [originalId]);
  assert.equal(triggered.dispatchedRetryRunIds.length, 1);

  const retryRunId = triggered.dispatchedRetryRunIds[0]!;
  const retry = await h.orchestrator.waitFor(retryRunId);
  assert.equal(retry.status, 'completed');
  assert.equal(retry.retryOfRunId, originalId, 'the retry is a linked run');
  assert.equal(
    retry.result?.status === 'completed' ? retry.result.text : undefined,
    'reconnected reply',
  );

  // The original terminal failure stays recorded exactly as it was.
  const original = await h.orchestrator.load(originalId);
  assert.equal(original?.status, 'failed');
  assert.equal(original?.failure, ENVIRONMENT_FAILURE);
  assert.equal(original?.retryOfRunId, undefined);

  // Completion persists: the row settles and the reply port is told once.
  await until(
    async () => (await h.retryStore.getRetry(originalId))?.state === 'settled',
    'retry row settled',
  );
  assert.deepEqual(h.settlements, [{ originalRunId: originalId, retryRunId }]);
  assert.deepEqual(await h.retryStore.listUnsettledTriggers(), []);
});

test('a reconnect while another Environment stayed connected never triggers', async () => {
  const h = harness();
  // env-a stays connected and admissible the whole time; env-b comes and goes.
  h.connectOnly('env-a');
  const service = h.service();

  // env-b "reconnects" while env-a remained connected: no trigger, no rows.
  h.connectOnly('env-b');
  const partial = await service.noteEnvironmentState();
  assert.deepEqual(partial.triggeredProjects, []);
  assert.deepEqual(partial.armedProjects, []);
  assert.deepEqual(await h.retryStore.listUnsettledTriggers(), []);
  assert.deepEqual(await h.retryStore.listRetries(), []);

  // env-b drops again — still not a full disconnect, so still no arm.
  h.disconnect('env-b');
  const stillPartial = await service.noteEnvironmentState();
  assert.deepEqual(stillPartial.armedProjects, []);
  assert.notEqual((await h.retryStore.getGate('p1'))?.armed, true);

  // Only the loss of the last connected Environment arms the gate.
  h.disconnect('env-a');
  const full = await service.noteEnvironmentState();
  assert.deepEqual(full.armedProjects, ['p1']);
});

test('only the environment-absence failure class is eligible for retry', async () => {
  const h = harness({
    adapter: new ScriptedEngineAdapter({
      turns: [
        { events: [], result: { status: 'failed', message: 'engine turn failed' } },
        { events: [], result: { status: 'completed', text: 'retried reply' } },
      ],
    }),
  });

  // Environments available: create the two ineligible failure classes.
  h.setAvailable(true);
  const service = h.service();
  await service.reconcile();

  // (1) A lease conflict: an instance resolved, so this is not absence.
  const lease = h.pool.acquireLease({
    instanceId: 'env-a',
    capability: 'agent-run',
    holderId: 'other-agent',
    ttlMs: 60_000,
  });
  assert.equal(lease.ok, true);
  const busyId = (
    await h.orchestrator.submit({ agentId: 'scout', prompt: 'x', projectId: 'p1' })
  ).id;
  await h.orchestrator.waitFor(busyId);
  assert.match((await h.orchestrator.load(busyId))?.failure ?? '', /environment busy/);
  if (lease.ok) h.pool.releaseLease(lease.lease.id);

  // (2) An engine-phase failure: the engine accepted the work first.
  const engineId = (
    await h.orchestrator.submit({ agentId: 'scout', prompt: 'y', projectId: 'p1' })
  ).id;
  await h.orchestrator.waitFor(engineId);
  assert.equal((await h.orchestrator.load(engineId))?.failure, 'engine turn failed');
  assert.notEqual((await h.orchestrator.load(engineId))?.environmentInstanceId, '');

  // Environments unavailable: the eligible environment-absence failure.
  h.setAvailable(false);
  await service.noteEnvironmentState();
  const eligibleId = await submitDisconnectedRun(h);

  // First qualifying reconnect: exactly the eligible run is retried.
  h.setAvailable(true);
  const triggered = await service.noteEnvironmentState();
  assert.deepEqual(triggered.queuedRunIds, [eligibleId]);
  const rows = await h.retryStore.listRetries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.originalRunId, eligibleId);
  assert.equal((await h.orchestrator.load(busyId))?.retryOfRunId, undefined);
  assert.equal((await h.orchestrator.load(engineId))?.retryOfRunId, undefined);
});

test('a run is retried at most once across reconnect episodes', async () => {
  const h = harness();
  h.setAvailable(false);
  const service = h.service();
  await service.reconcile();

  const originalId = await submitDisconnectedRun(h);

  // A reconnect whose admission projection still refuses: the retry dispatches
  // but fails with the same class — it still consumed the one bounded retry.
  h.connectOnly('env-a');
  h.pool.synchronize({ definitions: [definition], instances, eligibleInstanceIds: [] });
  const first = await service.noteEnvironmentState();
  assert.equal(first.dispatchedRetryRunIds.length, 1);
  const retryRunId = first.dispatchedRetryRunIds[0]!;
  await h.orchestrator.waitFor(retryRunId);
  const retry = await h.orchestrator.load(retryRunId);
  assert.equal(retry?.status, 'failed');
  assert.equal(retry?.failure, ENVIRONMENT_FAILURE);
  assert.equal(retry?.retryOfRunId, originalId);

  // A second full-disconnect episode and reconnect must not queue anything:
  // the original already used its one retry, and the retry can never be
  // eligible itself.
  h.setAvailable(false);
  await service.noteEnvironmentState();
  h.setAvailable(true);
  const second = await service.noteEnvironmentState();
  assert.deepEqual(second.queuedRunIds, []);
  assert.equal((await h.retryStore.listRetries()).length, 1);
  const runs = await h.orchestrator.list();
  assert.equal(runs.filter((run) => run.agentId === 'scout').length, 2);
});

test('a retry that fails again keeps the sanitized failure class and the original stays recorded', async () => {
  const h = harness();
  h.setAvailable(false);
  const service = h.service();
  await service.reconcile();
  const originalId = await submitDisconnectedRun(h);
  const originalBefore = await h.orchestrator.load(originalId);

  h.connectOnly('env-a');
  h.pool.synchronize({ definitions: [definition], instances, eligibleInstanceIds: [] });
  const triggered = await service.noteEnvironmentState();
  const retry = await h.orchestrator.load(triggered.dispatchedRetryRunIds[0]!);
  assert.equal(retry?.status, 'failed');
  // The exact class — capability name only, no path, host, prompt, or event
  // content — is what the retry reports, same as the original.
  assert.match(
    retry?.failure ?? '',
    /^no available environment for capability: [A-Za-z0-9_-]+$/,
  );
  assert.equal(retry?.failure, originalBefore?.failure);

  const originalAfter = await h.orchestrator.load(originalId);
  assert.deepEqual(originalAfter, originalBefore, 'the original terminal failure is never rewritten');
  await until(
    async () => (await h.retryStore.getRetry(originalId))?.state === 'settled',
    'a failed retry still settles its durable bookkeeping',
  );
});

test('restart reconciliation dispatches queued retries exactly once', async () => {
  const h = harness({
    adapter: new ScriptedEngineAdapter({
      turns: [{ events: [], result: { status: 'completed', text: 'after restart' } }],
    }),
  });
  h.setAvailable(false);
  const originalId = await submitDisconnectedRun(h);

  // The crash window: gate, trigger, and eligibility persisted; dispatch never
  // ran because the previous process died right there.
  await h.retryStore.armGate('p1', 1_000);
  const trigger = await h.retryStore.createTriggerIfArmed({
    id: 'trigger-crash',
    projectId: 'p1',
    at: 1_001,
    eligibilitySettled: false,
  });
  assert.ok(trigger);
  assert.equal(
    await h.retryStore.queueRetry({
      originalRunId: originalId,
      triggerId: 'trigger-crash',
      projectId: 'p1',
      now: 1_002,
    }),
    true,
  );
  await h.retryStore.settleTrigger('trigger-crash');

  // A fresh process over the same durable state. Any pass — the constructor's
  // initial evaluation or this reconcile — may be the one that dispatches, so
  // the assertions are about durable effect: exactly one retry, exactly once.
  const service = h.service();
  h.setAvailable(true);
  await service.reconcile();
  const rows = await h.retryStore.listRetries();
  assert.equal(rows.length, 1);
  const retry = await h.orchestrator.waitFor(rows[0]!.retryRunId!);
  assert.equal(retry.retryOfRunId, originalId);

  const second = await service.reconcile();
  assert.deepEqual(second.dispatchedRetryRunIds, []);
  assert.equal((await h.orchestrator.list()).length, 2, 'no duplicate retry run');
  await until(
    async () => (await h.retryStore.getRetry(originalId))?.state === 'settled',
    'retry settled after reconciliation',
  );
});

test('restart reconciliation re-submits a missing retry run under the same durable id', async () => {
  const h = harness({
    adapter: new ScriptedEngineAdapter({
      turns: [{ events: [], result: { status: 'completed', text: 'resumed dispatch' } }],
    }),
  });
  h.setAvailable(false);
  const originalId = await submitDisconnectedRun(h);

  // The crash window: the row durably names the retry run, but the process
  // died before the orchestrator recorded it.
  await h.retryStore.armGate('p1', 1_000);
  const trigger = await h.retryStore.createTriggerIfArmed({
    id: 'trigger-mid-dispatch',
    projectId: 'p1',
    at: 1_001,
    eligibilitySettled: false,
  });
  assert.ok(trigger);
  await h.retryStore.queueRetry({
    originalRunId: originalId,
    triggerId: 'trigger-mid-dispatch',
    projectId: 'p1',
    now: 1_002,
  });
  await h.retryStore.settleTrigger('trigger-mid-dispatch');
  assert.equal(
    await h.retryStore.markDispatched(originalId, 'run-fixed-retry-id', 1_003),
    true,
  );

  const service = h.service();
  h.setAvailable(true);
  await service.reconcile();
  // The missing run is submitted under exactly the durable id — never a new one.
  const retry = await h.orchestrator.waitFor('run-fixed-retry-id');
  assert.equal(retry.retryOfRunId, originalId);
  assert.equal((await h.retryStore.getRetry(originalId))?.retryRunId, 'run-fixed-retry-id');

  // Reconciling again never creates a second linked run.
  await service.reconcile();
  assert.equal((await h.orchestrator.list()).length, 2);
  await until(
    async () => (await h.retryStore.getRetry(originalId))?.state === 'settled',
    'retry settled after reconciliation',
  );
});

test('restart reconciliation settles a finished retry once and never twice', async () => {
  const h = harness({
    adapter: new ScriptedEngineAdapter({
      turns: [{ events: [], result: { status: 'completed', text: 'finished before crash' } }],
    }),
  });
  h.setAvailable(false);
  const originalId = await submitDisconnectedRun(h);

  // The crash window: the retry run completed, but its completion was never
  // recorded (the reply port was never told).
  h.setAvailable(true);
  const { id: retryRunId } = await h.orchestrator.submit({
    runId: 'run-finished-retry',
    agentId: 'scout',
    prompt: 'please answer',
    projectId: 'p1',
    retryOfRunId: originalId,
  });
  await h.orchestrator.waitFor(retryRunId);
  await h.retryStore.armGate('p1', 1_000);
  const trigger = await h.retryStore.createTriggerIfArmed({
    id: 'trigger-before-settle',
    projectId: 'p1',
    at: 1_001,
    eligibilitySettled: false,
  });
  assert.ok(trigger);
  await h.retryStore.queueRetry({
    originalRunId: originalId,
    triggerId: 'trigger-before-settle',
    projectId: 'p1',
    now: 1_002,
  });
  await h.retryStore.settleTrigger('trigger-before-settle');
  await h.retryStore.markDispatched(originalId, retryRunId, 1_003);

  const service = h.service();
  await service.reconcile();
  assert.deepEqual(h.settlements, [{ originalRunId: originalId, retryRunId }]);

  // Further passes see the settled row and never repeat the completion.
  await service.reconcile();
  await service.noteEnvironmentState();
  assert.equal(h.settlements.length, 1);
  assert.equal((await h.orchestrator.list()).length, 2);
});

test('the SQLite adapter persists gates, triggers, and retry rows across reopen', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-reconnect-retry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'sprout.db');
  const first = new SqliteStore({ filename: path });
  await first.runReconnectRetries.armGate('p1', 10);
  const trigger = await first.runReconnectRetries.createTriggerIfArmed({
    id: 'trigger-1',
    projectId: 'p1',
    at: 20,
    eligibilitySettled: false,
  });
  assert.ok(trigger);
  assert.equal(
    await first.runReconnectRetries.queueRetry({
      originalRunId: 'run-original',
      triggerId: 'trigger-1',
      projectId: 'p1',
      now: 30,
    }),
    true,
  );
  assert.equal(
    await first.runReconnectRetries.queueRetry({
      originalRunId: 'run-original',
      triggerId: 'trigger-1',
      projectId: 'p1',
      now: 31,
    }),
    false,
    'the primary key is the single-retry bound',
  );
  await first.runReconnectRetries.settleTrigger('trigger-1');
  assert.equal(
    await first.runReconnectRetries.markDispatched('run-original', 'run-retry', 40),
    true,
  );
  assert.equal(
    await first.runReconnectRetries.markDispatched('run-original', 'run-other', 41),
    false,
    'a dispatched row is never re-dispatched under another id',
  );
  first.close();

  const reopened = new SqliteStore({ filename: path });
  assert.equal((await reopened.runReconnectRetries.getGate('p1'))?.armed, false);
  assert.deepEqual(await reopened.runReconnectRetries.listUnsettledTriggers(), []);
  const row = await reopened.runReconnectRetries.getRetry('run-original');
  assert.equal(row?.state, 'dispatched');
  assert.equal(row?.retryRunId, 'run-retry');
  await reopened.runReconnectRetries.markSettled('run-original', 50);
  reopened.close();

  const again = new SqliteStore({ filename: path });
  assert.equal((await again.runReconnectRetries.getRetry('run-original'))?.state, 'settled');
  assert.equal(
    await again.runReconnectRetries.createTriggerIfArmed({
      id: 'trigger-2',
      projectId: 'p1',
      at: 60,
      eligibilitySettled: false,
    }),
    undefined,
    'a consumed gate cannot fire again without re-arming',
  );
  again.close();
});

test('the eligibility predicate rejects every non-absence failure shape', () => {
  const base = {
    id: 'run-1',
    agentId: 'scout',
    prompt: 'p',
    environmentInstanceId: '',
    status: 'failed' as const,
    events: [],
    failure: ENVIRONMENT_FAILURE,
    createdAt: 1,
  };
  const scoped = { ...base, projectId: 'p1' };
  assert.equal(isEnvironmentDisconnectedFailure(scoped), true);
  assert.equal(
    isEnvironmentDisconnectedFailure({
      ...scoped,
      failure:
        'no project grants agent scout access to an environment for capability: agent-run',
    }),
    false,
    'permission failures stay fail-fast',
  );
  assert.equal(
    isEnvironmentDisconnectedFailure({
      ...scoped,
      failure: 'no compatible work option for agent scout',
    }),
    false,
    'compatibility failures stay fail-fast',
  );
  assert.equal(
    isEnvironmentDisconnectedFailure({ ...scoped, environmentInstanceId: 'env-a' }),
    false,
    'an engine-accepted run is never retried here',
  );
  assert.equal(
    isEnvironmentDisconnectedFailure(base),
    false,
    'a run with no Project scope cannot be retried',
  );
  assert.equal(
    isEnvironmentDisconnectedFailure({ ...scoped, retryOfRunId: 'run-0' }),
    false,
    'a retry run can never re-enter the set',
  );
  assert.equal(
    isEnvironmentDisconnectedFailure({ ...scoped, taskId: 'task-1' }),
    false,
    'Task-nested runs keep their own lifecycle',
  );
  assert.equal(
    isEnvironmentDisconnectedFailure({ ...scoped, status: 'interrupted' }),
    false,
    'interrupted runs stay under recovery semantics',
  );
  assert.equal(
    isEnvironmentDisconnectedFailure({ ...scoped, failure: 'environment busy: env-a is leased by other' }),
    false,
    'lease conflicts stay fail-fast',
  );
});
