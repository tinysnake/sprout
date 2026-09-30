import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UsageAwareRoutingModelPort } from './routing-adapter.ts';
import type { RoutingModelPort } from '../collaboration/routing.ts';

test('measures Sprout wall duration and captures absent telemetry truthfully', async () => {
  let currentTime = 1000;
  const clock = { now: () => currentTime };

  const innerPort: RoutingModelPort = {
    id: 'test-wake-model',
    async judge(_request) {
      currentTime += 250;
      return JSON.stringify({ selections: [], suppressions: [] });
    },
  };

  const adapter = new UsageAwareRoutingModelPort({
    inner: innerPort,
    clock,
  });

  const response = await adapter.judge({
    attemptId: 'attempt-1', batchId: 'batch-1',
    projectId: 'proj-1',
    attempt: 1,
    context: 'context-body',
  });

  assert.equal(typeof response, 'string');
  assert.ok(adapter.lastTelemetry);
  assert.equal(adapter.lastTelemetry.durationMs, 250);
  assert.equal(adapter.lastTelemetry.source, 'routing-model:test-wake-model');
  assert.equal(adapter.lastTelemetry.billingBasis, 'unknown');
  // Absent tokens: undefined, NOT zero
  assert.equal(adapter.lastTelemetry.tokens, undefined);
  assert.equal(adapter.lastTelemetry.cost, undefined);
});

test('captures telemetry from inner port when provided', async () => {
  let currentTime = 1000;
  const clock = { now: () => currentTime };

  const innerPort: RoutingModelPort = {
    id: 'telemetry-model',
    telemetryForAttempt: (attemptId) => attemptId === 'attempt-2' ? {
      tokens: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      billingBasis: 'metered_api',
    } : undefined,
    async judge(_request) {
      currentTime += 100;
      return JSON.stringify({ selections: [], suppressions: [] });
    },
  };

  const adapter = new UsageAwareRoutingModelPort({
    inner: innerPort,
    clock,
  });

  await adapter.judge({
    attemptId: 'attempt-2', batchId: 'batch-2',
    projectId: 'proj-2',
    attempt: 1,
    context: 'ctx',
  });

  assert.ok(adapter.lastTelemetry);
  assert.equal(adapter.lastTelemetry.durationMs, 100);
  assert.equal(adapter.lastTelemetry.tokens?.totalTokens, 60);
  assert.equal(adapter.lastTelemetry.billingBasis, 'metered_api');
  assert.equal(adapter.takeTelemetry('attempt-2')?.tokens?.totalTokens, 60);
  assert.equal(adapter.takeTelemetry('attempt-2'), undefined, 'settlement consumes telemetry once');
});

test('late timed-out routing responses cannot replace settled usage or another attempt telemetry', async () => {
  let finish: (value: string) => void = () => undefined;
  const adapter = new UsageAwareRoutingModelPort({ inner: {
    id: 'delayed-model',
    telemetryForAttempt: (id) => ({ tokens: { inputTokens: id === 'late' ? 99 : 10 } }),
    judge: async (request) => request.attemptId === 'late'
      ? new Promise<string>((resolve) => { finish = resolve; }) : 'valid output',
  } });
  const request = { batchId: 'batch', projectId: 'project', attempt: 1, context: 'context' };
  const late = adapter.judge({ ...request, attemptId: 'late' });
  assert.equal(adapter.takeTelemetry('late'), undefined); // coordinator timeout
  await adapter.judge({ ...request, attemptId: 'retry', attempt: 2 });
  finish('late output');
  await late;
  assert.equal(adapter.takeTelemetry('late'), undefined);
  assert.equal(adapter.takeTelemetry('retry')?.tokens?.inputTokens, 10);
});
