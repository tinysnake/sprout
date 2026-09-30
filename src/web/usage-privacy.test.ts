import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { createRunApi } from './api.ts';
import { createUsageRouter, sanitizeUsagePayload } from './usage-router.ts';
import { InMemoryUsageStore } from '../usage/store.ts';
import { UsageService } from '../usage/service.ts';

test('privacy boundary: sanitizes host paths, private endpoints, and secrets from payloads', () => {
  const sentinelSecret = 'SYNTHETIC_API_KEY_SECRET_7a9f8b';
  const dirty = {
    activityId: 'act-1',
    source: 'provider at /synthetic-root/example/repo',
    reason: `Correction by operator with api_key=${sentinelSecret}`,
    secretToken: 'sensitive-token-xyz',
    password: 'supersecretpassword',
    authorization: 'Bearer jwt-abc',
    tokens: {
      inputTokens: 100,
      totalTokens: 100,
    },
  };

  const clean = sanitizeUsagePayload(dirty);
  const serialized = JSON.stringify(clean);

  // Path redacted
  assert.ok(!serialized.includes('/synthetic-root/example/repo'));

  // Credential redacted
  assert.ok(!serialized.includes(sentinelSecret));

  // Secret object keys stripped
  assert.equal('secretToken' in clean, false);
  assert.equal('password' in clean, false);
  assert.equal('authorization' in clean, false);

  // Normal usage facts preserved
  assert.equal(clean.tokens.totalTokens, 100);
});

test('HTTP routes enforce privacy on emitted JSON responses', async () => {
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

  try {
    const sentinelHost = 'sensitive-host.corp.internal';
    await store.recordActivity({
      id: 'act-leak-test',
      kind: 'agent_run',
      correlation: {
        runId: 'run-leak-1',
        projectId: 'proj-leak',
        agentId: 'agent-leak',
      },
      engine: 'codex',
      model: 'gpt-4o',
      status: 'completed',
      createdAt: 1000,
      settledAt: 2000,
      wallDurationMs: 1000,
    });

    await store.recordObservation({
      id: 'obs-leak-test',
      activityId: 'act-leak-test',
      observedAt: 2000,
      source: '/synthetic-dir/sprout/node_modules/engine',
      sourceVersion: '1.0',
      completeness: 'complete',
      tokens: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      durations: { sproutWallDurationMs: 1000 },
      billedCost: { status: 'unavailable', currency: 'USD' },
      costEstimate: {
        status: 'available',
        currency: 'USD',
        apiEquivalentUsdMicros: 350,
        valuationProvenance: 'locally_estimated',
      },
      billingBasis: 'metered_api',
      supersessionReason: `Checked on host ${sentinelHost}`,
      isEffective: true,
    });

    const res = await fetch(`${base}/api/usage/activities/act-leak-test`);
    assert.equal(res.status, 200);
    const text = await res.text();

    assert.ok(!text.includes('/synthetic-dir/sprout'));
    assert.ok(!text.includes(sentinelHost));

    const aggregateResponse = await fetch(`${base}/api/usage/aggregate?projectId=proj-leak`);
    assert.equal(aggregateResponse.status, 200);
    const aggregateText = await aggregateResponse.text();
    assert.ok(aggregateText.includes('run-leak-1'), 'aggregate exposes a safe run identity for drill-down');
    assert.ok(!aggregateText.includes('/synthetic-dir/sprout'));
    assert.ok(!aggregateText.includes(sentinelHost));
  } finally {
    await api.close();
  }
});
