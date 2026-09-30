import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SqliteUsageStore } from './sqlite-store.ts';
import { UsageService } from './service.ts';
import { InMemoryUsageStore } from './store.ts';
import type { AgentRun } from '../run/model.ts';
import type { RoutingAttempt } from '../collaboration/routing.ts';

function withService(run: (service: UsageService, store: SqliteUsageStore) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-usage-service-test-'));
  const db = new DatabaseSync(join(dir, 'usage.db'));
  const store = new SqliteUsageStore({ db });
  let clockTime = 1000;
  const clock = { now: () => clockTime };
  const service = new UsageService({ store, clock });

  return Promise.resolve()
    .then(() => run(service, store))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

test('record completed run with detailed token dimensions, Sprout wall duration, and local pricing', async () => {
  await withService(async (service) => {
    const run: AgentRun = {
      id: 'run-101',
      agentId: 'agent-dev',
      environmentInstanceId: 'env-1',
      projectId: 'proj-sprout',
      taskId: 'task-auth',
      prompt: 'implement login',
      status: 'completed',
      events: [],
      createdAt: 1000,
      completedAt: 2500,
      workOption: {
        id: 'opt-1',
        engine: 'codex',
        workModel: 'gpt-4o',
        effort: 'high',
      },
      result: { status: 'completed', text: 'done', pricingContext: { route: 'openai', serviceTier: 'standard' } },
      detailedTokens: {
        inputTokens: 1000,
        uncachedInputTokens: 800,
        cachedInputTokens: 200,
        cacheWriteInputTokens: 0,
        outputTokens: 300,
        reasoningOutputTokens: 50,
        totalTokens: 1300,
      },
    };

    const activity = await service.recordRunActivity(run);
    assert.equal(activity.id, 'ua_run_run-101');
    assert.equal(activity.status, 'completed');
    assert.equal(activity.wallDurationMs, 1500);

    const detail = await service.getActivity('ua_run_run-101');
    assert.ok(detail);
    assert.equal(detail.activity.correlation.runId, 'run-101');
    assert.equal(detail.activity.correlation.taskId, 'task-auth');
    assert.equal(detail.activity.correlation.projectId, 'proj-sprout');
    assert.equal(detail.activity.correlation.agentId, 'agent-dev');

    const obs = detail.effectiveObservation;
    assert.ok(obs);
    assert.equal(obs.completeness, 'complete');
    assert.equal(obs.durations.sproutWallDurationMs, 1500);

    // Detailed token dimensions preserved
    assert.deepEqual(obs.tokens, {
      inputTokens: 1000,
      uncachedInputTokens: 800,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 0,
      outputTokens: 300,
      reasoningOutputTokens: 50,
      totalTokens: 1300,
    });

    // Attributable billed cost is separate fact and unavailable
    assert.equal(obs.billedCost.status, 'unavailable');
    assert.equal(obs.billedCost.billedUsdMicros, undefined);

    // API-equivalent estimate calculated from frozen snapshot:
    // uncached 800 * 2.5 + cached 200 * 1.25 + output 300 * 10 = 2000 + 250 + 3000 = 5250 micros
    assert.equal(obs.costEstimate.status, 'available');
    assert.equal(obs.costEstimate.apiEquivalentUsdMicros, 5250);
    assert.equal(obs.costEstimate.valuationProvenance, 'locally_estimated');
    assert.equal(obs.costEstimate.priceSource, 'codex-price-snapshot');
    assert.equal(obs.costEstimate.priceSourceVersion, '2026-09-15');
    assert.equal(obs.billingBasis, 'unknown');
  });
});

test('failed and interrupted runs retain trustworthy partial usage; absent telemetry is unavailable rather than zero', async () => {
  await withService(async (service) => {
    // 1. Failed run with observed tokens retains partial completeness
    const failedRun: AgentRun = {
      id: 'run-fail',
      agentId: 'agent-dev',
      environmentInstanceId: 'env-1',
      prompt: 'do work',
      status: 'failed',
      events: [],
      createdAt: 1000,
      completedAt: 1800,
      workOption: { id: 'opt-2', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'medium' },
      detailedTokens: {
        inputTokens: 400,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 50,
        totalTokens: 450,
      },
    };

    await service.recordRunActivity(failedRun);
    const failDetail = await service.getActivity('ua_run_run-fail');
    assert.equal(failDetail?.activity.status, 'failed');
    assert.equal(failDetail?.effectiveObservation?.completeness, 'partial');
    assert.equal(failDetail?.effectiveObservation?.tokens?.totalTokens, 450);

    // 2. Interrupted run without any tokens has completeness unavailable, NOT zeros
    const interruptedRun: AgentRun = {
      id: 'run-int',
      agentId: 'agent-dev',
      environmentInstanceId: 'env-1',
      prompt: 'do work',
      status: 'interrupted',
      events: [],
      createdAt: 2000,
      completedAt: 2200,
      workOption: { id: 'opt-3', engine: 'codex', workModel: 'unknown-model', effort: 'low' },
      // No tokenUsage, no detailedTokens
    };

    await service.recordRunActivity(interruptedRun);
    const intDetail = await service.getActivity('ua_run_run-int');
    assert.equal(intDetail?.activity.status, 'interrupted');
    assert.equal(intDetail?.effectiveObservation?.completeness, 'unavailable');
    // Absent tokens: undefined, NOT zero-filled!
    assert.equal(intDetail?.effectiveObservation?.tokens, undefined);
    assert.equal(intDetail?.effectiveObservation?.costEstimate.status, 'unavailable');
  });
});

test('Pi harness-calculated cost and subscription-included basis preserve separate facts', async () => {
  await withService(async (service) => {
    const run: AgentRun = {
      id: 'run-pi-sub',
      agentId: 'agent-scout',
      environmentInstanceId: 'env-1',
      prompt: 'scout repo',
      status: 'completed',
      events: [],
      createdAt: 1000,
      completedAt: 2000,
      workOption: { id: 'opt-4', engine: 'pi', workModel: 'claude-3-5-haiku', effort: 'low' },
      result: {
        status: 'completed',
        text: 'done',
        detailedTokens: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
        costEstimate: {
          status: 'available',
          currency: 'USD',
          apiEquivalentUsdMicros: 850,
          valuationProvenance: 'harness_calculated',
          priceSource: 'pi-catalog',
          priceSourceVersion: '0.85.1',
        },
        billingBasis: 'subscription_included',
      },
    };

    await service.recordRunActivity(run);
    const detail = await service.getActivity('ua_run_run-pi-sub');
    const obs = detail?.effectiveObservation;
    assert.ok(obs);

    // Billed cost is UNAVAILABLE, not 0 USD!
    assert.equal(obs.billedCost.status, 'unavailable');
    assert.equal(obs.billedCost.billedUsdMicros, undefined);

    // API-equivalent estimate is available from Pi harness
    assert.equal(obs.costEstimate.status, 'available');
    assert.equal(obs.costEstimate.apiEquivalentUsdMicros, 850);
    assert.equal(obs.costEstimate.valuationProvenance, 'harness_calculated');

    // Billing basis is subscription_included
    assert.equal(obs.billingBasis, 'subscription_included');
  });
});

test('delayed observations and corrections append with source, reason, and supersession history', async () => {
  await withService(async (service) => {
    const run: AgentRun = {
      id: 'run-delayed',
      agentId: 'agent-dev',
      environmentInstanceId: 'env-1',
      prompt: 'task',
      status: 'completed',
      events: [],
      createdAt: 1000,
      completedAt: 2000,
      workOption: { id: 'opt-5', engine: 'codex', workModel: 'gpt-4o', effort: 'high' },
      detailedTokens: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    };

    await service.recordRunActivity(run);
    const initialDetail = await service.getActivity('ua_run_run-delayed');
    const initialObsId = initialDetail?.effectiveObservation?.id;
    assert.ok(initialObsId);
    assert.equal(initialDetail?.effectiveObservation?.costEstimate.status, 'unavailable');

    // 1. Delayed provider estimate arrives
    const delayed = await service.recordDelayedObservation({
      activityId: 'ua_run_run-delayed',
      supersedesObservationId: initialObsId,
      source: 'codex.turn_cost',
      sourceVersion: '0.154.0',
      reason: 'Delayed provider backend cost estimate arrived via OTLP',
      costEstimate: {
        status: 'available',
        currency: 'USD',
        apiEquivalentUsdMicros: 600,
        valuationProvenance: 'provider_estimated',
        priceSource: 'codex.turn_cost',
        priceSourceVersion: '0.154.0',
      },
    });

    const afterDelayed = await service.getActivity('ua_run_run-delayed');
    assert.equal(afterDelayed?.effectiveObservation?.id, delayed.id);
    assert.equal(afterDelayed?.effectiveObservation?.costEstimate.valuationProvenance, 'provider_estimated');
    assert.equal(afterDelayed?.effectiveObservation?.costEstimate.apiEquivalentUsdMicros, 600);

    // 2. Later audit correction appends
    const correction = await service.recordCorrection({
      activityId: 'ua_run_run-delayed',
      supersedesObservationId: delayed.id,
      source: 'adapter-reconciliation',
      reason: 'Reconciliation adjustment after provider token discrepancy audit',
      tokens: { inputTokens: 110, outputTokens: 20, totalTokens: 130 },
      costEstimate: {
        status: 'available',
        currency: 'USD',
        apiEquivalentUsdMicros: 625,
        valuationProvenance: 'provider_estimated',
        priceSource: 'codex.turn_cost',
        priceSourceVersion: '0.154.0',
      },
    });

    const afterCorrection = await service.getActivity('ua_run_run-delayed');
    assert.equal(afterCorrection?.effectiveObservation?.id, correction.id);
    assert.equal(afterCorrection?.effectiveObservation?.tokens?.totalTokens, 130);
    assert.equal(afterCorrection?.effectiveObservation?.costEstimate.apiEquivalentUsdMicros, 625);

    // Full supersession history has all 3 observations
    assert.equal(afterCorrection?.observations.length, 3);
    assert.equal(afterCorrection?.supersessionHistory.length, 3);
    assert.equal(afterCorrection?.supersessionHistory[0]?.observationId, initialObsId);
    assert.equal(afterCorrection?.supersessionHistory[1]?.observationId, delayed.id);
    assert.equal(afterCorrection?.supersessionHistory[1]?.supersedesObservationId, initialObsId);
    assert.equal(afterCorrection?.supersessionHistory[2]?.observationId, correction.id);
    assert.equal(afterCorrection?.supersessionHistory[2]?.supersedesObservationId, delayed.id);
  });
});

test('routing attempt records as usage activity belonging to Project but not Agent or Task', async () => {
  await withService(async (service) => {
    const attempt: RoutingAttempt = {
      id: 'att-99',
      batchId: 'batch-77',
      attemptNumber: 1,
      modelId: 'wake-model-alpha',
      startedAt: 5000,
      finishedAt: 5350,
      status: 'succeeded',
    };

    const activity = await service.recordRoutingAttemptActivity(attempt, {
      batchId: 'batch-77',
      projectId: 'proj-alpha',
      durationMs: 350,
    });

    assert.equal(activity.kind, 'routing_attempt');
    assert.equal(activity.correlation.attemptId, 'att-99');
    assert.equal(activity.correlation.batchId, 'batch-77');
    assert.equal(activity.correlation.projectId, 'proj-alpha');
    // Crucial: never belongs to Agent or Task
    assert.equal(activity.correlation.agentId, undefined);
    assert.equal(activity.correlation.taskId, undefined);

    const detail = await service.getActivity('ua_att_att-99');
    assert.ok(detail);
    assert.equal(detail.activity.wallDurationMs, 350);

    // Absent telemetry is explicitly unavailable rather than zero
    const obs = detail.effectiveObservation;
    assert.ok(obs);
    assert.equal(obs.completeness, 'unavailable');
    assert.equal(obs.tokens, undefined);
    assert.equal(obs.costEstimate.status, 'unavailable');
    assert.equal(obs.billedCost.status, 'unavailable');
    assert.equal(obs.durations.sproutWallDurationMs, 350);
  });
});

test('Human stops retain stopped outcome and observed partial tokens', async () => {
  await withService(async (service) => {
    await service.recordRunActivity({
      id: 'stopped-run', agentId: 'agent-1', environmentInstanceId: 'env-1', prompt: 'work',
      status: 'interrupted', recoverySettlement: { status: 'stopped', eventCount: 1 },
      events: [], createdAt: 1000, completedAt: 1100,
      detailedTokens: { inputTokens: 100 },
    });
    const detail = await service.getActivityByRunId('stopped-run');
    assert.equal(detail?.activity.status, 'stopped');
    assert.equal(detail?.effectiveObservation?.completeness, 'partial');
    assert.equal(detail?.effectiveObservation?.tokens?.inputTokens, 100);
  });
});

test('two corrections against the same initial observation retain exactly one effective head', async () => {
  await withService(async (sqliteService) => {
    for (const service of [sqliteService, new UsageService({ store: new InMemoryUsageStore() })]) {
    const activity = await service.recordRunActivity({
      id: 'correction-run', agentId: 'agent-1', environmentInstanceId: 'env-1', prompt: 'work',
      status: 'completed', events: [], createdAt: 1000, completedAt: 1100,
    });
    const initial = (await service.getActivity(activity.id))!.effectiveObservation!;
    const input = { activityId: activity.id, supersedesObservationId: initial.id,
      source: 'adapter-reconciliation', reason: 'Delayed provider estimate' };
    // A failed insert must not deactivate the predecessor (transaction rollback).
    await assert.rejects(service.store.recordObservation({ ...initial, supersedesObservationId: initial.id }));
    assert.equal((await service.getActivity(activity.id))?.effectiveObservation?.id, initial.id);
    await assert.rejects(service.recordCorrection({ ...input, reason: ' ' }), /source and reason/);
    const results = await Promise.allSettled([service.recordCorrection(input), service.recordCorrection(input)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const detail = (await service.getActivity(activity.id))!;
    assert.equal(detail.observations.length, 2);
    assert.equal(detail.observations.filter((obs) => obs.isEffective).length, 1);
    await assert.rejects(service.recordCorrection(input), /effective|stale/);
    }
  });
});

test('views: getTaskUsage, getProjectUsage, getAgentUsage, getModelUsage', async () => {
  await withService(async (service) => {
    // 2 runs in Task T1, Project P1
    await service.recordRunActivity({
      id: 'run-t1-a1',
      agentId: 'agent-1',
      environmentInstanceId: 'env-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      prompt: 'part 1',
      status: 'completed',
      events: [],
      createdAt: 1000,
      completedAt: 2000,
      workOption: { id: 'opt-6', engine: 'codex', workModel: 'gpt-4o', effort: 'high' },
      detailedTokens: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
    });
    await service.recordRunActivity({
      id: 'run-t1-a2',
      agentId: 'agent-2',
      environmentInstanceId: 'env-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      prompt: 'part 2',
      status: 'completed',
      events: [],
      createdAt: 2000,
      completedAt: 2500,
      workOption: { id: 'opt-7', engine: 'codex', workModel: 'gpt-4o-mini', effort: 'low' },
      detailedTokens: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
    });

    // 1 routing attempt in Project P1
    await service.recordRoutingAttemptActivity({
      id: 'att-p1',
      batchId: 'batch-1',
      attemptNumber: 1,
      modelId: 'wake-model-1',
      startedAt: 3000,
      finishedAt: 3200,
      status: 'succeeded',
    }, {
      batchId: 'batch-1',
      projectId: 'proj-1',
      durationMs: 200,
    });

    // 1. Task usage includes only its runs, not routing attempts
    const taskUsage = await service.getTaskUsage('task-1');
    assert.equal(taskUsage.totalActivities, 2);
    assert.equal(taskUsage.totalSproutWallDurationMs, 1500);
    assert.equal(taskUsage.tokens.totalTokens, 850);
    assert.ok(taskUsage.groups?.['agent-1']);
    assert.ok(taskUsage.groups?.['agent-2']);

    // 2. Project usage includes runs and routing attempt with separate subtotals
    const projectUsage = await service.getProjectUsage('proj-1');
    assert.equal(projectUsage.totalActivities, 3);
    assert.equal(projectUsage.workModelSubtotal?.totalActivities, 2);
    assert.equal(projectUsage.workModelSubtotal?.tokens.totalTokens, 850);
    assert.equal(projectUsage.routingModelSubtotal?.totalActivities, 1);
    assert.equal(projectUsage.routingModelSubtotal?.totalSproutWallDurationMs, 200);

    // 3. Agent usage does NOT absorb routing attempts
    const agentUsage = await service.getAgentUsage('agent-1');
    assert.equal(agentUsage.totalActivities, 1);
    assert.equal(agentUsage.tokens.totalTokens, 600);

    // 4. Model usage attributes to model
    const modelUsage = await service.getModelUsage('gpt-4o');
    assert.equal(modelUsage.totalActivities, 1);
    assert.equal(modelUsage.tokens.totalTokens, 600);
  });
});
