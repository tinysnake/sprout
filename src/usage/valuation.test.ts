import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateLocalEstimate } from './valuation.ts';

test('local valuation refuses unknown dimensions, routes, and tiers rather than pricing partial usage', () => {
  const complete = { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10 };
  for (const input of [
    { tokens: { inputTokens: 100 }, pricingContext: { route: 'openai', serviceTier: 'standard' } },
    { tokens: complete },
    { tokens: complete, pricingContext: { route: 'openai', serviceTier: 'priority' } },
    { tokens: complete, pricingContext: { route: 'unknown', serviceTier: 'standard' } },
    { tokens: { ...complete, cachedInputTokens: undefined }, pricingContext: { route: 'openai', serviceTier: 'standard' } },
  ]) {
    const estimate = calculateLocalEstimate({ engine: 'codex', model: 'gpt-4o', valuedAt: 1, ...input });
    assert.equal(estimate.status, 'unavailable');
    assert.equal(estimate.apiEquivalentUsdMicros, undefined);
  }
});

test('complete standard-route dimensions produce a frozen cache-aware estimate including known zero', () => {
  for (const [tokens, expected] of [
    [{ inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10 }, 325],
    [{ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 }, 0],
  ] as const) {
    const estimate = calculateLocalEstimate({ engine: 'codex', model: 'gpt-4o', tokens,
      pricingContext: { route: 'openai', serviceTier: 'standard' }, valuedAt: 1 });
    assert.equal(estimate.status, 'available');
    assert.equal(estimate.apiEquivalentUsdMicros, expected);
  }
});
