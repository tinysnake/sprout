import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductionUsageService } from './adapters/production-adapter.ts';
import { FixtureUsageService } from './adapters/fixture-adapter.ts';
import type { UsageBrowserAdapter } from '../../adapters/usage-api.ts';
import type { UsageActivity, UsageAggregate } from '../../../../src/usage/model.ts';
import type { ActivityDetailView } from '../../../../src/usage/service.ts';

function mockAdapter(options: {
  activities?: UsageActivity[];
  aggregate?: UsageAggregate;
  detail?: ActivityDetailView;
}): UsageBrowserAdapter {
  return {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    listActivities: async () => options.activities ?? [],
    getAggregate: async () => options.aggregate ?? ({} as UsageAggregate),
    getActivity: async (id) => options.detail ?? ({
      activity: {
        id,
        kind: 'agent_run',
        engine: 'pi',
        model: 'claude-3-5-sonnet',
        status: 'completed',
        createdAt: 1000,
        settledAt: 2000,
        wallDurationMs: 1000,
        correlation: { runId: 'run-1', agentId: 'agent-1', projectId: 'proj-1' },
      },
      observations: [],
      supersessionHistory: [],
    } as unknown as ActivityDetailView),
    getRunUsage: async (runId) => options.detail ?? ({} as ActivityDetailView),
    getRoutingAttemptUsage: async (attemptId) => options.detail ?? ({} as ActivityDetailView),
    getTaskUsage: async () => options.aggregate ?? ({} as UsageAggregate),
    getProjectUsage: async () => options.aggregate ?? ({} as UsageAggregate),
    getAgentUsage: async () => options.aggregate ?? ({} as UsageAggregate),
    getModelUsage: async () => options.aggregate ?? ({} as UsageAggregate),
  };
}

test('ProductionUsageService: maps backend activities and observations to truthful UI items', async () => {
  const backendActivity: UsageActivity = {
    id: 'act-test-1',
    kind: 'agent_run',
    engine: 'codex',
    model: 'gpt-4o',
    status: 'completed',
    createdAt: 1000,
    settledAt: 2000,
    wallDurationMs: 65000,
    correlation: { runId: 'run-101', agentId: 'reviewer', projectId: 'proj-sprout' },
  };

  const detail: ActivityDetailView = {
    activity: backendActivity,
    effectiveObservation: {
      id: 'obs-1',
      activityId: 'act-test-1',
      observedAt: 2100,
      source: 'Codex telemetry',
      sourceVersion: '1.0',
      completeness: 'complete',
      tokens: {
        inputTokens: 15000,
        uncachedInputTokens: 5000,
        cachedInputTokens: 10000,
        outputTokens: 2000,
        totalTokens: 17000,
      },
      durations: { sproutWallDurationMs: 65000 },
      billedCost: { status: 'unavailable', currency: 'USD' },
      costEstimate: {
        status: 'available',
        currency: 'USD',
        apiEquivalentUsdMicros: 45000,
        valuationProvenance: 'provider_estimated',
        priceSource: 'OpenAI',
      },
      billingBasis: 'subscription_included',
      isEffective: true,
    },
    observations: [],
    supersessionHistory: [],
  };

  const adapter = mockAdapter({ activities: [backendActivity], detail });
  const service = new ProductionUsageService(adapter);

  const items = await service.listActivities();
  assert.equal(items.length, 1);
  const item = items[0]!;

  assert.equal(item.id, 'act-test-1');
  assert.equal(item.kind, 'agent_run');
  assert.equal(item.agentId, 'reviewer');
  assert.equal(item.projectId, 'proj-sprout');
  assert.equal(item.outcome, 'completed');
  assert.equal(item.wallDurationMs, 65000);
  assert.equal(item.tokenDimensions.total, 17000);
  assert.equal(item.costValuation.estimatedUsdMicros, 45000);
  assert.equal(item.costValuation.provenance, 'provider_estimated');
  assert.equal(item.costValuation.billingBasis, 'subscription_included');
  assert.equal(item.costValuation.attributableBilledCostStatus, 'unavailable');
});

test('ProductionUsageService: preserves unavailable facts and does not substitute numeric zero', async () => {
  const backendActivity: UsageActivity = {
    id: 'act-unavailable-test',
    kind: 'routing_attempt',
    engine: 'wake-model',
    model: 'gpt-4o-mini',
    status: 'failed',
    createdAt: 1000,
    settledAt: 2000,
    correlation: { attemptId: 'att-1', batchId: 'batch-1', projectId: 'proj-sprout' },
  };

  const detail: ActivityDetailView = {
    activity: backendActivity,
    effectiveObservation: {
      id: 'obs-unav',
      activityId: 'act-unavailable-test',
      observedAt: 2000,
      source: 'Wake model',
      sourceVersion: '1.0',
      completeness: 'unavailable',
      durations: { sproutWallDurationMs: 0 },
      billedCost: { status: 'unavailable', currency: 'USD' },
      costEstimate: {
        status: 'unavailable',
        currency: 'USD',
      },
      billingBasis: 'unknown',
      isEffective: true,
    },
    observations: [],
    supersessionHistory: [],
  };

  const adapter = mockAdapter({ activities: [backendActivity], detail });
  const service = new ProductionUsageService(adapter);

  const items = await service.listActivities();
  const item = items[0]!;

  assert.equal(item.tokenDimensions.status, 'unavailable');
  assert.equal(item.tokenDimensions.total, undefined);
  assert.equal(item.costValuation.apiEquivalentStatus, 'unavailable');
  assert.equal(item.costValuation.estimatedUsdMicros, undefined);
  assert.equal(item.costValuation.attributableBilledCostStatus, 'unavailable');
});

test('FixtureUsageService: returns accurate aggregates and scoped options', async () => {
  const fixture = new FixtureUsageService();

  const acts = await fixture.listActivities();
  assert.equal(acts.length, 10);

  const aggregate = await fixture.getAggregate();
  assert.equal(aggregate.totalActivities, 10);
  assert.ok(aggregate.workModelSubtotal);
  assert.ok(aggregate.routingModelSubtotal);
  assert.equal(aggregate.billedCost.status, 'unavailable');

  const projects = await fixture.listProjects();
  assert.equal(projects.length, 2);

  const agents = await fixture.listAgents();
  assert.equal(agents.length, 4);

  const models = await fixture.listModels();
  assert.ok(models.includes('claude-3-5-sonnet'));
  assert.ok(models.includes('gpt-4o'));
  assert.ok(models.includes('gpt-4o-mini'));
});

test('ProductionUsageService F9: settlement buckets bound the previous 30 days at exact instants', async (t) => {
  const now = 100 * 86400000;
  t.mock.method(Date, 'now', () => now);
  const day = 86400000;
  for (const [age, expected] of [[day, 'today'], [day + 1, '7d'], [7 * day, '7d'], [7 * day + 1, '30d'], [30 * day - 1, '30d'], [30 * day, '30d'], [30 * day + 1, 'older']] as const) {
    const a: UsageActivity = {
      id: 'boundary-activity', kind: 'agent_run', engine: 'pi', model: 'claude-3-5-sonnet', status: 'completed',
      createdAt: now - age - 1000, settledAt: now - age, correlation: { runId: 'boundary-run', agentId: 'agent', projectId: 'project' },
    };
    const service = new ProductionUsageService(mockAdapter({ activities: [a] }));
    assert.equal((await service.listActivities())[0]!.settlementRange, expected, `age ${age}ms`);
  }
});
