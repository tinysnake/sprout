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
import type { UsageActivity, UsageObservation, UsageAggregate } from '../usage/model.ts';

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
      correlation: { runId: 'run-1', projectId: 'proj-1', agentId: 'agent-1' },
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
      correlation: { runId: 'run-1', agentId: 'agent-1' },
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

test('scope and time-range queries return settlement-attributed run and attempt identities', async () => {
  const h = await openUsageHarness();
  try {
    await h.store.recordActivity({
      id: 'settled-in-range', kind: 'agent_run',
      correlation: { runId: 'run-in-range', projectId: 'p1', taskId: 't1', agentId: 'a1' },
      engine: 'pi', model: 'work-v1', status: 'completed', createdAt: 500, settledAt: 1500, wallDurationMs: 1000,
    });
    await h.store.recordActivity({
      id: 'routing-in-range', kind: 'routing_attempt',
      correlation: { attemptId: 'attempt-in-range', batchId: 'batch-1', projectId: 'p1' },
      engine: 'routing-model', model: 'wake-v1', status: 'completed', createdAt: 1600, settledAt: 1900, wallDurationMs: 300,
    });
    await h.store.recordActivity({
      id: 'settled-at-end', kind: 'agent_run',
      correlation: { runId: 'run-at-end', projectId: 'p1', taskId: 't1', agentId: 'a1' },
      engine: 'pi', model: 'work-v1', status: 'completed', createdAt: 1700, settledAt: 2000, wallDurationMs: 300,
    });

    const projectResponse = await fetch(`${h.base}/api/usage/projects/p1?from=1000&to=2000&timeZone=America%2FNew_York`);
    assert.equal(projectResponse.status, 200);
    const project = await projectResponse.json() as {
      totalActivities: number;
      workModelSubtotal: { activityIdentities: readonly { runId?: string }[] };
      routingModelSubtotal: { activityIdentities: readonly { attemptId?: string }[] };
      timeRange: { from: number; to: number; timeZone: string; bounds: string; attribution: string };
    };
    assert.equal(project.totalActivities, 2);
    assert.deepEqual(project.workModelSubtotal.activityIdentities.map((item) => item.runId), ['run-in-range']);
    assert.deepEqual(project.routingModelSubtotal.activityIdentities.map((item) => item.attemptId), ['attempt-in-range']);
    assert.deepEqual(project.timeRange, {
      from: 1000, to: 2000, timeZone: 'America/New_York', bounds: '[start, end)', attribution: 'settlement',
    });

    const attemptResponse = await fetch(`${h.base}/api/usage/attempts/attempt-in-range`);
    assert.equal(attemptResponse.status, 200);
    const attemptDetail = await attemptResponse.json() as { activity: { correlation: { attemptId?: string } } };
    assert.equal(attemptDetail.activity.correlation.attemptId, 'attempt-in-range');

    const taskResponse = await fetch(`${h.base}/api/usage/tasks/t1?from=1000&to=2000&timeZone=UTC`);
    const task = await taskResponse.json() as { totalActivities: number; activityIdentities: readonly { kind: string; runId?: string }[] };
    assert.equal(taskResponse.status, 200);
    assert.equal(task.totalActivities, 1);
    assert.deepEqual(task.activityIdentities.map((item) => [item.kind, item.runId]), [['agent_run', 'run-in-range']]);

    for (const query of ['from=invalid', 'from=2000&to=1000', 'timeZone=Not%2FAZone']) {
      const invalid = await fetch(`${h.base}/api/usage/aggregate?${query}`);
      assert.equal(invalid.status, 400, query);
    }
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


test('Usage aggregate HTTP serialization preserves the complete DTO for sparse, grouped, provisional, and empty results', async () => {
  const h = await openUsageHarness();
  try {
    await h.store.recordActivity({
      id: 'sparse-run', kind: 'agent_run',
      correlation: { runId: 'sparse-run-id', projectId: 'sparse-project', taskId: 'sparse-task', agentId: 'sparse-agent' },
      engine: 'engine', model: 'model', status: 'completed', createdAt: 1, settledAt: 2,
    });
    await h.store.recordActivity({
      id: 'sparse-routing', kind: 'routing_attempt',
      correlation: { attemptId: 'sparse-attempt-id', batchId: 'sparse-batch', projectId: 'sparse-project' },
      engine: 'routing', model: 'wake-model', status: 'active', createdAt: 3,
    });

    const assertAggregateDto = (value: unknown, path: string): void => {
      assert.ok(value && typeof value === 'object', `${path} is an aggregate object`);
      const aggregate = value as Record<string, unknown>;
      for (const field of ['totalActivities', 'tokenCoverage', 'costCoverage', 'tokens', 'cost', 'billedCost', 'activityIdentities']) {
        assert.ok(Object.hasOwn(aggregate, field), `${path}.${field} is present`);
      }
      if (aggregate.workModelSubtotal !== undefined) assertAggregateDto(aggregate.workModelSubtotal, `${path}.workModelSubtotal`);
      if (aggregate.routingModelSubtotal !== undefined) assertAggregateDto(aggregate.routingModelSubtotal, `${path}.routingModelSubtotal`);
      if (aggregate.provisionalTotals !== undefined) assertAggregateDto(aggregate.provisionalTotals, `${path}.provisionalTotals`);
      if (aggregate.groups && typeof aggregate.groups === 'object') {
        for (const [key, group] of Object.entries(aggregate.groups)) assertAggregateDto(group, `${path}.groups.${key}`);
      }
    };
    const readAggregate = async (query: string, expectedCount: number) => {
      const response = await fetch(`${h.base}/api/usage/aggregate${query}`);
      assert.equal(response.status, 200, query);
      const aggregate = await response.json() as Record<string, unknown>;
      assertAggregateDto(aggregate, query || 'empty query');
      assert.equal(aggregate.totalActivities, expectedCount, query);
    };

    await readAggregate('?projectId=absent&groupBy=model', 0);
    await readAggregate('?kind=agent_run&groupBy=run', 1);
    await readAggregate('?kind=routing_attempt&provisional=true&groupBy=project', 1);
    await readAggregate('', 1);

    const invalid = await fetch(`${h.base}/api/usage/aggregate?kind=unknown`);
    assert.equal(invalid.status, 400, 'invalid filters are HTTP errors, not successful error-envelope data');
    const errorBody = await invalid.json() as Record<string, unknown>;
    assert.ok(Object.hasOwn(errorBody, 'error'));
  } finally { await h.api.close(); }
});

test('HTTP serialization omits smuggled Routing ownership in aggregate identities and activity correlations', async () => {
  const h = await openUsageHarness();
  try {
    const identity = {
      activityId: 'routing', kind: 'routing_attempt', attemptId: 'attempt', batchId: 'batch',
      projectId: 'project', agentId: 'agent', taskId: 'task', runId: 'run', environmentInstanceId: 'environment',
      model: 'wake', status: 'completed', createdAt: 1,
    };
    const hostileCorrelation = { ...identity, apiToken: 'routing-correlation-token', prompt: 'routing correlation prompt' };
    const aggregate = await h.usage.getAggregate({});
    h.usage.getAggregate = async () => ({ ...aggregate, activityIdentities: [identity] } as unknown as UsageAggregate);
    h.usage.listActivities = async () => [{
      id: 'routing', kind: 'routing_attempt', correlation: hostileCorrelation,
      engine: 'routing', model: 'wake', status: 'completed', createdAt: 1,
    } as unknown as UsageActivity];
    for (const route of ['aggregate', 'activities']) {
      const response = await fetch(`${h.base}/api/usage/${route}`);
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        activityIdentities: Record<string, unknown>[];
        activities: { correlation: Record<string, unknown> }[];
      };
      const exported = route === 'aggregate' ? payload.activityIdentities[0]! : payload.activities[0]!.correlation;
      assert.equal(exported.attemptId, 'attempt');
      assert.equal(exported.batchId, 'batch');
      assert.equal(exported.projectId, 'project');
      for (const forbidden of ['agentId', 'taskId', 'runId', 'environmentInstanceId']) {
        assert.equal(Object.hasOwn(exported, forbidden), false, `Routing must not export ${forbidden}`);
      }
      if (route === 'activities') {
        assert.equal(Object.hasOwn(exported, 'apiToken'), false, 'Routing correlation must not forward unknown token fields');
        assert.equal(Object.hasOwn(exported, 'prompt'), false, 'Routing correlation must not forward unknown prompt fields');
      }
      assert.equal(identity.agentId, 'agent', 'serialization must not mutate service facts');
    }
  } finally { await h.api.close(); }
});

test('HTTP aggregate serialization keeps only documented coverage counters at every nesting level', async () => {
  const h = await openUsageHarness();
  try {
    const baseline = await h.usage.getAggregate({});
    const baseFields = Object.fromEntries(Object.entries(baseline).filter(([key]) =>
      !['workModelSubtotal', 'routingModelSubtotal', 'provisionalTotals', 'groups'].includes(key),
    )) as unknown as UsageAggregate;
    const expectedTokenCoverage = { complete: 2, partial: 3, unavailable: 4 };
    const expectedCostCoverage = { available: 5, pending: 6, unavailable: 7 };
    const expectedProvenance = { provider_estimated: 8, harness_calculated: 9, locally_estimated: 10 };
    const hostileMarkers: string[] = [];
    const withHostileCoverage = (label: string): UsageAggregate => {
      const markers = [
        `${label}-coverage-api-token`,
        `${label}-coverage-prompt`,
        `${label}-coverage-prompt-text`,
        `${label}-token-dimensions-api-token`,
        `${label}-token-dimensions-prompt`,
        `${label}-cost-api-token`,
        `${label}-cost-prompt`,
        `${label}-cost-prompt-text`,
        `${label}-provenance-api-token`,
        `${label}-provenance-prompt`,
      ];
      hostileMarkers.push(...markers);
      return {
        ...baseFields,
        tokenCoverage: { ...expectedTokenCoverage, apiToken: markers[0], prompt: markers[1], promptText: markers[2] },
        tokens: { ...baseFields.tokens, totalTokens: 12, apiToken: markers[3], prompt: markers[4] } as unknown as UsageAggregate['tokens'],
        costCoverage: { ...expectedCostCoverage, apiToken: markers[5], prompt: markers[6], promptText: markers[7] },
        cost: {
          ...baseFields.cost,
          byProvenance: {
            ...expectedProvenance,
            apiToken: markers[8],
            prompt: markers[9],
            unknownProvenance: 11,
          },
        },
      } as unknown as UsageAggregate;
    };

    const root = withHostileCoverage('root');
    const hostileAggregate = {
      ...root,
      workModelSubtotal: withHostileCoverage('work'),
      routingModelSubtotal: withHostileCoverage('routing'),
      provisionalTotals: withHostileCoverage('provisional'),
      groups: { sample: withHostileCoverage('group') },
    } as unknown as UsageAggregate;
    h.usage.getAggregate = async () => hostileAggregate;

    const response = await fetch(`${h.base}/api/usage/aggregate`);
    assert.equal(response.status, 200);
    const responseText = await response.text();
    assert.deepEqual(hostileMarkers.filter((marker) => responseText.includes(marker)), []);

    const payload = JSON.parse(responseText) as Record<string, unknown>;
    const assertWhitelistedCoverage = (value: unknown, path: string): void => {
      assert.ok(value && typeof value === 'object', `${path} is an aggregate object`);
      const aggregate = value as Record<string, unknown>;
      assert.deepEqual(aggregate.tokenCoverage, expectedTokenCoverage, `${path}.tokenCoverage`);
      assert.deepEqual(aggregate.tokens, { status: 'unavailable', totalTokens: 12 }, `${path}.tokens`);
      assert.deepEqual(aggregate.costCoverage, expectedCostCoverage, `${path}.costCoverage`);
      const cost = aggregate.cost as { byProvenance: unknown };
      assert.deepEqual(cost.byProvenance, expectedProvenance, `${path}.cost.byProvenance`);
      if (aggregate.workModelSubtotal !== undefined) assertWhitelistedCoverage(aggregate.workModelSubtotal, `${path}.workModelSubtotal`);
      if (aggregate.routingModelSubtotal !== undefined) assertWhitelistedCoverage(aggregate.routingModelSubtotal, `${path}.routingModelSubtotal`);
      if (aggregate.provisionalTotals !== undefined) assertWhitelistedCoverage(aggregate.provisionalTotals, `${path}.provisionalTotals`);
      if (aggregate.groups && typeof aggregate.groups === 'object') {
        for (const [key, group] of Object.entries(aggregate.groups)) assertWhitelistedCoverage(group, `${path}.groups.${key}`);
      }
    };
    assertWhitelistedCoverage(payload, 'root');
  } finally { await h.api.close(); }
});
