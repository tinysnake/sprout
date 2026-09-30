import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { createRunApi } from './api.ts';
import { createUsageRouter } from './usage-router.ts';
import { InMemoryUsageStore } from '../usage/store.ts';
import { UsageService } from '../usage/service.ts';
import type { UsageActivity, UsageObservation } from '../usage/model.ts';

interface UsageTestHarness {
  readonly api: Awaited<ReturnType<typeof createRunApi>>;
  readonly base: string;
  readonly usage: UsageService;
  readonly store: InMemoryUsageStore;
}

async function openUsageHarness(): Promise<UsageTestHarness> {
  const store = new InMemoryUsageStore();
  const usage = new UsageService({ store, clock: { now: () => 10_000 } });
  const pool = new EnvironmentPool({ definitions: [], instances: [] });
  const orchestrator = new RunOrchestrator({
    engines: new Map(),
    agents: new AgentRegistry([]),
    store: new InMemoryRunStore(),
    pool,
  });

  const api = createRunApi({
    orchestrator,
    agents: new AgentRegistry([]),
    routers: [createUsageRouter({ usage })],
  });

  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;

  return { api, base, usage, store };
}

test('GET /api/usage/activities lists activities with filters', async () => {
  const h = await openUsageHarness();
  try {
    await h.store.recordActivity({
      id: 'act-1',
      kind: 'agent_run',
      correlation: { runId: 'run-1', projectId: 'proj-1', taskId: 'task-1', agentId: 'agent-1' },
      engine: 'codex',
      model: 'gpt-4o',
      status: 'completed',
      createdAt: 1000,
      settledAt: 2000,
      wallDurationMs: 1000,
    });
    await h.store.recordActivity({
      id: 'act-2',
      kind: 'routing_attempt',
      correlation: { attemptId: 'att-1', batchId: 'b1', projectId: 'proj-1' },
      engine: 'routing',
      model: 'wake-1',
      status: 'completed',
      createdAt: 2000,
      settledAt: 2200,
      wallDurationMs: 200,
    });

    const res = await fetch(`${h.base}/api/usage/activities?projectId=proj-1`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { activities: UsageActivity[] };
    assert.equal(data.activities.length, 2);

    const resKind = await fetch(`${h.base}/api/usage/activities?kind=routing_attempt`);
    assert.equal(resKind.status, 200);
    const dataKind = (await resKind.json()) as { activities: UsageActivity[] };
    assert.equal(dataKind.activities.length, 1);
    assert.equal(dataKind.activities[0]?.id, 'act-2');
  } finally {
    await h.api.close();
  }
});

test('GET /api/usage/activities/:id returns activity detail with observations and history', async () => {
  const h = await openUsageHarness();
  try {
    await h.store.recordActivity({
      id: 'act-run-1',
      kind: 'agent_run',
      correlation: { runId: 'run-1', projectId: 'proj-1' },
      engine: 'codex',
      model: 'gpt-4o',
      status: 'completed',
      createdAt: 1000,
      settledAt: 2000,
      wallDurationMs: 1000,
    });
    await h.store.recordObservation({
      id: 'obs-1',
      activityId: 'act-run-1',
      observedAt: 2000,
      source: 'codex',
      sourceVersion: '0.154.0',
      completeness: 'complete',
      tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      durations: { sproutWallDurationMs: 1000 },
      billedCost: { status: 'unavailable', currency: 'USD' },
      costEstimate: { status: 'available', currency: 'USD', apiEquivalentUsdMicros: 750, valuationProvenance: 'locally_estimated' },
      billingBasis: 'metered_api',
      isEffective: true,
    });

    const res = await fetch(`${h.base}/api/usage/activities/act-run-1`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      activity: UsageActivity;
      effectiveObservation?: UsageObservation;
      observations: UsageObservation[];
    };
    assert.equal(data.activity.id, 'act-run-1');
    assert.equal(data.effectiveObservation?.id, 'obs-1');
    assert.equal(data.effectiveObservation?.costEstimate.apiEquivalentUsdMicros, 750);
    assert.equal(data.observations.length, 1);

    const resNotFound = await fetch(`${h.base}/api/usage/activities/nonexistent`);
    assert.equal(resNotFound.status, 404);
  } finally {
    await h.api.close();
  }
});

test('Human HTTP cannot append provider or billed facts even with a correction-shaped payload', async () => {
  const h = await openUsageHarness();
  try {
    await h.store.recordActivity({
      id: 'act-1',
      kind: 'agent_run',
      correlation: { runId: 'run-1' },
      engine: 'codex',
      model: 'gpt-4o',
      status: 'completed',
      createdAt: 1000,
      settledAt: 2000,
      wallDurationMs: 1000,
    });
    await h.store.recordObservation({
      id: 'obs-initial',
      activityId: 'act-1',
      observedAt: 2000,
      source: 'codex',
      sourceVersion: '1.0',
      completeness: 'complete',
      tokens: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      durations: { sproutWallDurationMs: 1000 },
      billedCost: { status: 'unavailable', currency: 'USD' },
      costEstimate: { status: 'available', currency: 'USD', apiEquivalentUsdMicros: 500, valuationProvenance: 'locally_estimated' },
      billingBasis: 'metered_api',
      isEffective: true,
    });

    const res = await fetch(`${h.base}/api/usage/activities/act-1/observations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        supersedesObservationId: 'obs-initial',
        source: 'codex.turn_cost',
        reason: 'Delayed provider estimate arrived via OTLP',
        tokens: { inputTokens: 999 },
        completeness: 'complete',
        billingBasis: 'metered_api',
        billedCost: { status: 'available', currency: 'USD', billedUsdMicros: 999 },
        costEstimate: {
          status: 'available',
          currency: 'USD',
          apiEquivalentUsdMicros: 550,
          valuationProvenance: 'provider_estimated',
          priceSource: 'codex.turn_cost',
        },
      }),
    });

    assert.equal(res.status, 405);
    const detail = await h.usage.getActivity('act-1');
    assert.equal(detail?.effectiveObservation?.id, 'obs-initial');
    assert.equal(detail?.observations.length, 1);
    assert.equal(detail?.effectiveObservation?.billedCost.status, 'unavailable');
  } finally {
    await h.api.close();
  }
});

test('POST /api/usage/activities/:id/observations rejects invalid payload', async () => {
  const h = await openUsageHarness();
  try {
    const res = await fetch(`${h.base}/api/usage/activities/act-1/observations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ missingRequiredFields: true }),
    });
    assert.equal(res.status, 405);
  } finally {
    await h.api.close();
  }
});

test('GET /api/usage/aggregate and drill-down routes', async () => {
  const h = await openUsageHarness();
  try {
    await h.store.recordActivity({
      id: 'act-run-1',
      kind: 'agent_run',
      correlation: { runId: 'run-1', projectId: 'p1', taskId: 't1', agentId: 'a1' },
      engine: 'codex',
      model: 'gpt-4o',
      status: 'completed',
      createdAt: 1000,
      settledAt: 2000,
      wallDurationMs: 1000,
    });
    await h.store.recordObservation({
      id: 'obs-1',
      activityId: 'act-run-1',
      observedAt: 2000,
      source: 'codex',
      sourceVersion: '1.0',
      completeness: 'complete',
      tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      durations: { sproutWallDurationMs: 1000 },
      billedCost: { status: 'unavailable', currency: 'USD' },
      costEstimate: { status: 'available', currency: 'USD', apiEquivalentUsdMicros: 750, valuationProvenance: 'locally_estimated' },
      billingBasis: 'metered_api',
      isEffective: true,
    });

    // 1. GET /api/usage/aggregate
    const resAgg = await fetch(`${h.base}/api/usage/aggregate?projectId=p1`);
    assert.equal(resAgg.status, 200);
    const agg = (await resAgg.json()) as { totalActivities: number; tokens: { totalTokens: number } };
    assert.equal(agg.totalActivities, 1);
    assert.equal(agg.tokens.totalTokens, 150);

    // 2. GET /api/usage/runs/:runId
    const resRun = await fetch(`${h.base}/api/usage/runs/run-1`);
    assert.equal(resRun.status, 200);

    // 3. GET /api/usage/tasks/:taskId
    const resTask = await fetch(`${h.base}/api/usage/tasks/t1`);
    assert.equal(resTask.status, 200);

    // 4. GET /api/usage/projects/:projectId
    const resProj = await fetch(`${h.base}/api/usage/projects/p1`);
    assert.equal(resProj.status, 200);

    // 5. GET /api/usage/agents/:agentId
    const resAgent = await fetch(`${h.base}/api/usage/agents/a1`);
    assert.equal(resAgent.status, 200);

    // 6. GET /api/usage/models/:model
    const resModel = await fetch(`${h.base}/api/usage/models/gpt-4o`);
    assert.equal(resModel.status, 200);
  } finally {
    await h.api.close();
  }
});
