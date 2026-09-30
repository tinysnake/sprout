import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SqliteUsageStore } from './sqlite-store.ts';
import type { UsageActivity, UsageObservation } from './model.ts';
import { SqliteStore } from '../store/db.ts';

function withTempStore(run: (store: SqliteUsageStore, db: DatabaseSync, dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-usage-store-test-'));
  const dbPath = join(dir, 'usage.db');
  const db = new DatabaseSync(dbPath);
  const store = new SqliteUsageStore({ db });
  return Promise.resolve()
    .then(() => run(store, db, dir))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

test('record and retrieve usage activity with correlation links', async () => {
  await withTempStore(async (store) => {
    const activity: UsageActivity = {
      id: 'act-run-1',
      kind: 'agent_run',
      correlation: {
        runId: 'run-1',
        taskId: 'task-1',
        projectId: 'project-sprout',
        agentId: 'agent-codex',
        environmentInstanceId: 'env-1',
      },
      engine: 'codex',
      model: 'gpt-4o',
      status: 'completed',
      createdAt: 1000,
      settledAt: 2500,
      wallDurationMs: 1500,
    };

    await store.recordActivity(activity);

    const fetched = await store.getActivity('act-run-1');
    assert.deepEqual(fetched, activity);

    const byRun = await store.getActivityByRunId('run-1');
    assert.deepEqual(byRun, activity);

    const routingActivity: UsageActivity = {
      id: 'act-att-1',
      kind: 'routing_attempt',
      correlation: {
        attemptId: 'att-1',
        batchId: 'batch-1',
        projectId: 'project-sprout',
      },
      engine: 'routing-model',
      model: 'wake-model-1',
      status: 'completed',
      createdAt: 3000,
      settledAt: 3200,
      wallDurationMs: 200,
    };

    await store.recordActivity(routingActivity);

    const byAttempt = await store.getActivityByAttemptId('att-1');
    assert.deepEqual(byAttempt, routingActivity);

    // Routing attempt does NOT have agentId or taskId
    assert.equal(byAttempt?.correlation.agentId, undefined);
    assert.equal(byAttempt?.correlation.taskId, undefined);
  });
});

test('list activities with multi-dimensional filtering', async () => {
  await withTempStore(async (store) => {
    await store.recordActivity({
      id: 'act-1',
      kind: 'agent_run',
      correlation: { runId: 'run-1', projectId: 'p1', taskId: 't1', agentId: 'a1' },
      engine: 'codex',
      model: 'gpt-4o',
      status: 'completed',
      createdAt: 1000,
      settledAt: 1500,
      wallDurationMs: 500,
    });
    await store.recordActivity({
      id: 'act-2',
      kind: 'agent_run',
      correlation: { runId: 'run-2', projectId: 'p1', taskId: 't2', agentId: 'a2' },
      engine: 'pi',
      model: 'claude-3-5-sonnet',
      status: 'active',
      createdAt: 2000,
    });
    await store.recordActivity({
      id: 'act-3',
      kind: 'routing_attempt',
      correlation: { attemptId: 'att-1', batchId: 'b1', projectId: 'p1' },
      engine: 'routing',
      model: 'wake-1',
      status: 'completed',
      createdAt: 3000,
      settledAt: 3100,
      wallDurationMs: 100,
    });

    const byKind = await store.listActivities({ kind: 'routing_attempt' });
    assert.equal(byKind.length, 1);
    assert.equal(byKind[0]?.id, 'act-3');

    const finalized = await store.listActivities({ provisional: false });
    assert.equal(finalized.length, 2);
    assert.deepEqual(finalized.map((a) => a.id), ['act-1', 'act-3']);

    const provisional = await store.listActivities({ provisional: true });
    assert.equal(provisional.length, 1);
    assert.equal(provisional[0]?.id, 'act-2');

    const byProject = await store.listActivities({ projectId: 'p1' });
    assert.equal(byProject.length, 3);

    const byAgent = await store.listActivities({ agentId: 'a1' });
    assert.equal(byAgent.length, 1);
    assert.equal(byAgent[0]?.id, 'act-1');
  });
});

test('record observation and append delayed observation with supersession history', async () => {
  await withTempStore(async (store) => {
    const activity: UsageActivity = {
      id: 'act-1',
      kind: 'agent_run',
      correlation: { runId: 'run-1', projectId: 'p1', agentId: 'a1' },
      engine: 'codex',
      model: 'gpt-4o',
      status: 'completed',
      createdAt: 1000,
      settledAt: 2000,
      wallDurationMs: 1000,
    };
    await store.recordActivity(activity);

    const obs1: UsageObservation = {
      id: 'obs-1',
      activityId: 'act-1',
      observedAt: 2000,
      source: 'codex-protocol:thread/tokenUsage/updated',
      sourceVersion: 'codex-cli 0.154.0',
      completeness: 'complete',
      tokens: {
        inputTokens: 100,
        uncachedInputTokens: 80,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 0,
        outputTokens: 40,
        reasoningOutputTokens: 10,
        totalTokens: 140,
      },
      durations: {
        sproutWallDurationMs: 1000,
        engineTurnDurationMs: 950,
      },
      billedCost: {
        status: 'unavailable',
        currency: 'USD',
        reason: 'provider does not supply per-run invoice facts',
      },
      costEstimate: {
        status: 'available',
        currency: 'USD',
        apiEquivalentUsdMicros: 600,
        valuationProvenance: 'locally_estimated',
        priceSource: 'codex-price-snapshot',
        priceSourceVersion: '2026-09-15',
        valuedAt: 2000,
      },
      billingBasis: 'metered_api',
      isEffective: true,
    };

    await store.recordObservation(obs1);

    const effective1 = await store.getEffectiveObservation('act-1');
    assert.deepEqual(effective1, obs1);

    // Delayed observation arrives with provider cost estimate superseding obs1
    const obs2: UsageObservation = {
      id: 'obs-2',
      activityId: 'act-1',
      observedAt: 2500,
      source: 'codex.turn_cost',
      sourceVersion: 'codex-cli 0.154.0',
      completeness: 'complete',
      tokens: obs1.tokens,
      durations: obs1.durations,
      billedCost: obs1.billedCost,
      costEstimate: {
        status: 'available',
        currency: 'USD',
        apiEquivalentUsdMicros: 650,
        valuationProvenance: 'provider_estimated',
        priceSource: 'codex.turn_cost',
        priceSourceVersion: 'codex-cli 0.154.0',
        valuedAt: 2500,
      },
      billingBasis: 'metered_api',
      supersedesObservationId: 'obs-1',
      supersessionReason: 'Delayed provider backend cost estimate received via OTLP',
      isEffective: true,
    };

    await store.recordObservation(obs2);

    // Effective observation is now obs2
    const effective2 = await store.getEffectiveObservation('act-1');
    assert.equal(effective2?.id, 'obs-2');
    assert.equal(effective2?.costEstimate.valuationProvenance, 'provider_estimated');
    assert.equal(effective2?.costEstimate.apiEquivalentUsdMicros, 650);

    // Prior observation obs1 remains durable and is marked superseded (not overwritten!)
    const prior = await store.getObservation('obs-1');
    assert.equal(prior?.id, 'obs-1');
    assert.equal(prior?.isEffective, false);
    assert.equal(prior?.supersededAt, 2500);
    assert.equal(prior?.costEstimate.apiEquivalentUsdMicros, 600);

    // List observations returns both in chronological order
    const history = await store.listObservations('act-1');
    assert.equal(history.length, 2);
    assert.equal(history[0]?.id, 'obs-1');
    assert.equal(history[0]?.isEffective, false);
    assert.equal(history[1]?.id, 'obs-2');
    assert.equal(history[1]?.isEffective, true);
    assert.equal(history[1]?.supersedesObservationId, 'obs-1');
    assert.equal(history[1]?.supersessionReason, 'Delayed provider backend cost estimate received via OTLP');
  });
});

test('coverage-aware aggregation separates work-model and routing-model and detects mixed provenance', async () => {
  await withTempStore(async (store) => {
    // 1. Work-model run: complete tokens, locally estimated cost
    await store.recordActivity({
      id: 'act-1',
      kind: 'agent_run',
      correlation: { runId: 'run-1', projectId: 'p1', taskId: 't1', agentId: 'a1' },
      engine: 'codex',
      model: 'gpt-4o',
      status: 'completed',
      createdAt: 1000,
      settledAt: 2000,
      wallDurationMs: 1000,
    });
    await store.recordObservation({
      id: 'obs-1',
      activityId: 'act-1',
      observedAt: 2000,
      source: 'codex',
      sourceVersion: '1.0',
      completeness: 'complete',
      tokens: { inputTokens: 100, uncachedInputTokens: 80, cachedInputTokens: 20, outputTokens: 50, totalTokens: 150 },
      durations: { sproutWallDurationMs: 1000 },
      billedCost: { status: 'unavailable', currency: 'USD' },
      costEstimate: { status: 'available', currency: 'USD', apiEquivalentUsdMicros: 700, valuationProvenance: 'locally_estimated' },
      billingBasis: 'metered_api',
      isEffective: true,
    });

    // 2. Work-model run: partial tokens on failure, harness calculated cost
    await store.recordActivity({
      id: 'act-2',
      kind: 'agent_run',
      correlation: { runId: 'run-2', projectId: 'p1', taskId: 't1', agentId: 'a2' },
      engine: 'pi',
      model: 'claude-3-5-sonnet',
      status: 'failed',
      createdAt: 2000,
      settledAt: 2500,
      wallDurationMs: 500,
    });
    await store.recordObservation({
      id: 'obs-2',
      activityId: 'act-2',
      observedAt: 2500,
      source: 'pi',
      sourceVersion: '1.0',
      completeness: 'partial',
      tokens: { inputTokens: 50, uncachedInputTokens: 50, cachedInputTokens: 0, outputTokens: 10, totalTokens: 60 },
      durations: { sproutWallDurationMs: 500 },
      billedCost: { status: 'unavailable', currency: 'USD' },
      costEstimate: { status: 'available', currency: 'USD', apiEquivalentUsdMicros: 300, valuationProvenance: 'harness_calculated' },
      billingBasis: 'subscription_included',
      isEffective: true,
    });

    // 3. Routing attempt: telemetry unavailable, duration measured
    await store.recordActivity({
      id: 'act-3',
      kind: 'routing_attempt',
      correlation: { attemptId: 'att-1', batchId: 'b1', projectId: 'p1' },
      engine: 'routing',
      model: 'wake-1',
      status: 'completed',
      createdAt: 3000,
      settledAt: 3100,
      wallDurationMs: 100,
    });
    await store.recordObservation({
      id: 'obs-3',
      activityId: 'act-3',
      observedAt: 3100,
      source: 'routing-model',
      sourceVersion: '1.0',
      completeness: 'unavailable',
      durations: { sproutWallDurationMs: 100 },
      billedCost: { status: 'unavailable', currency: 'USD' },
      costEstimate: { status: 'unavailable', currency: 'USD', reason: 'telemetry unavailable' },
      billingBasis: 'unknown',
      isEffective: true,
    });

    const aggregate = await store.getAggregate({ projectId: 'p1', groupBy: 'task' });

    assert.equal(aggregate.totalActivities, 3);
    assert.equal(aggregate.totalSproutWallDurationMs, 1600);

    // Token coverage has 1 complete, 1 partial, 1 unavailable -> observed_incomplete
    assert.deepEqual(aggregate.tokenCoverage, { complete: 1, partial: 1, unavailable: 1 });
    assert.equal(aggregate.tokens.status, 'observed_incomplete');
    assert.equal(aggregate.tokens.inputTokens, 150);
    assert.equal(aggregate.tokens.outputTokens, 60);
    assert.equal(aggregate.tokens.totalTokens, 210);

    // Cost coverage has 2 available, 0 pending, 1 unavailable
    assert.deepEqual(aggregate.costCoverage, { available: 2, pending: 0, unavailable: 1 });
    assert.equal(aggregate.cost.apiEquivalentUsdMicros, 1000);
    // Two different provenances -> mixed_provenance
    assert.equal(aggregate.cost.status, 'mixed_provenance');
    assert.equal(aggregate.cost.byProvenance.locally_estimated, 700);
    assert.equal(aggregate.cost.byProvenance.harness_calculated, 300);

    // Work-model subtotal has only act-1 and act-2
    assert.equal(aggregate.workModelSubtotal?.totalActivities, 2);
    assert.equal(aggregate.workModelSubtotal?.cost.apiEquivalentUsdMicros, 1000);
    assert.equal(aggregate.workModelSubtotal?.totalSproutWallDurationMs, 1500);

    // Routing-model subtotal has only act-3
    assert.equal(aggregate.routingModelSubtotal?.totalActivities, 1);
    assert.equal(aggregate.routingModelSubtotal?.tokenCoverage.unavailable, 1);
    assert.equal(aggregate.routingModelSubtotal?.cost.apiEquivalentUsdMicros, 0);
    assert.equal(aggregate.routingModelSubtotal?.cost.status, 'unavailable');
    assert.equal(aggregate.routingModelSubtotal?.totalSproutWallDurationMs, 100);

    // Grouping by task: t1 contains act-1 and act-2
    assert.ok(aggregate.groups?.['t1']);
    assert.equal(aggregate.groups?.['t1']?.totalActivities, 2);
  });
});

test('survives close and reopen on SqliteStore handle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-usage-reopen-test-'));
  const dbPath = join(dir, 'sprout.db');

  const store1 = new SqliteStore({ filename: dbPath });
  await store1.usage.recordActivity({
    id: 'act-perm-1',
    kind: 'agent_run',
    correlation: { runId: 'run-p1', projectId: 'sprout' },
    engine: 'codex',
    model: 'gpt-4o',
    status: 'completed',
    createdAt: 1000,
    settledAt: 2000,
    wallDurationMs: 1000,
  });
  await store1.usage.recordObservation({
    id: 'obs-perm-1',
    activityId: 'act-perm-1',
    observedAt: 2000,
    source: 'codex',
    sourceVersion: '0.154.0',
    completeness: 'complete',
    tokens: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
    durations: { sproutWallDurationMs: 1000 },
    billedCost: { status: 'unavailable', currency: 'USD' },
    costEstimate: { status: 'available', currency: 'USD', apiEquivalentUsdMicros: 2500, valuationProvenance: 'locally_estimated' },
    billingBasis: 'metered_api',
    isEffective: true,
  });
  store1.close();

  const store2 = new SqliteStore({ filename: dbPath });
  const restoredActivity = await store2.usage.getActivity('act-perm-1');
  assert.equal(restoredActivity?.id, 'act-perm-1');
  assert.equal(restoredActivity?.model, 'gpt-4o');

  const restoredObs = await store2.usage.getEffectiveObservation('act-perm-1');
  assert.equal(restoredObs?.id, 'obs-perm-1');
  assert.equal(restoredObs?.tokens?.totalTokens, 700);
  assert.equal(restoredObs?.costEstimate.apiEquivalentUsdMicros, 2500);

  store2.close();
  rmSync(dir, { recursive: true, force: true });
});
