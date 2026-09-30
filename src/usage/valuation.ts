/**
 * Usage valuation and pricing engine (ADR-0010, #105).
 *
 * Implements engine-specific valuation policy:
 * 1. Attributable billed cost is separate from API-equivalent cost estimates.
 * 2. Codex prefers provider-estimated USD if available; otherwise calculates
 *    from a versioned price snapshot ONLY if model and dimensions are known.
 *    Sprout never guesses through model-family matching or generic fallback rates.
 * 3. Pi uses harness-calculated cost from Pi's own model catalogue.
 * 4. Valuations are frozen at run time and normalized to integer USD micros.
 * 5. Subscription-inclusive access retains subscription billing basis but does
 *    NOT turn attributable billed cost or API-equivalent estimates into zero.
 */

import type {
  ApiEquivalentCostEstimate,
  AttributableBilledCost,
  DetailedTokenDimensions,
} from './model.ts';

export interface ModelPricingRates {
  readonly inputMicrosPerToken: number;
  readonly cachedInputMicrosPerToken: number;
  readonly outputMicrosPerToken: number;
}

/**
 * Frozen Codex/OpenAI pricing snapshot from 2026-09-15 (#45 research report).
 * All rates are in USD micros per single token.
 */
export const CODEX_PRICE_SNAPSHOT_VERSION = '2026-09-15';

export const CODEX_PRICE_SNAPSHOT: Record<string, ModelPricingRates> = {
  // $2.50 / 1M input, $1.25 / 1M cached, $10.00 / 1M output
  'gpt-4o': {
    inputMicrosPerToken: 2.5,
    cachedInputMicrosPerToken: 1.25,
    outputMicrosPerToken: 10.0,
  },
  'gpt-4o-2024-08-06': {
    inputMicrosPerToken: 2.5,
    cachedInputMicrosPerToken: 1.25,
    outputMicrosPerToken: 10.0,
  },
  'gpt-4o-2024-05-13': {
    inputMicrosPerToken: 5.0,
    cachedInputMicrosPerToken: 2.5,
    outputMicrosPerToken: 15.0,
  },
  // $0.15 / 1M input, $0.075 / 1M cached, $0.60 / 1M output
  'gpt-4o-mini': {
    inputMicrosPerToken: 0.15,
    cachedInputMicrosPerToken: 0.075,
    outputMicrosPerToken: 0.6,
  },
  'gpt-4o-mini-2024-07-18': {
    inputMicrosPerToken: 0.15,
    cachedInputMicrosPerToken: 0.075,
    outputMicrosPerToken: 0.6,
  },
  // $15.00 / 1M input, $7.50 / 1M cached, $60.00 / 1M output
  'o1': {
    inputMicrosPerToken: 15.0,
    cachedInputMicrosPerToken: 7.5,
    outputMicrosPerToken: 60.0,
  },
  'o1-2024-12-17': {
    inputMicrosPerToken: 15.0,
    cachedInputMicrosPerToken: 7.5,
    outputMicrosPerToken: 60.0,
  },
  // $1.10 / 1M input, $0.55 / 1M cached, $4.40 / 1M output
  'o3-mini': {
    inputMicrosPerToken: 1.1,
    cachedInputMicrosPerToken: 0.55,
    outputMicrosPerToken: 4.4,
  },
  'o3-mini-2025-01-31': {
    inputMicrosPerToken: 1.1,
    cachedInputMicrosPerToken: 0.55,
    outputMicrosPerToken: 4.4,
  },
};

/**
 * Standard default attributable billed cost for M2 per-run interfaces.
 * Both Codex and Pi per-run interfaces do not expose an attributable bill.
 */
export function defaultUnavailableBilledCost(reason?: string): AttributableBilledCost {
  return {
    status: 'unavailable',
    currency: 'USD',
    reason: reason ?? 'provider does not supply per-run invoice facts',
  };
}

/**
 * Default unavailable cost estimate when telemetry or pricing is absent.
 */
export function defaultUnavailableCostEstimate(reason?: string): ApiEquivalentCostEstimate {
  return {
    status: 'unavailable',
    currency: 'USD',
    reason: reason ?? 'telemetry or price unavailable',
  };
}

/**
 * Calculate a local estimate from a frozen price snapshot.
 *
 * Fails closed with unavailable if model or pricing dimensions are unknown.
 * Never guesses via model-family matching or generic fallback rates.
 */
export function calculateLocalEstimate(options: {
  readonly engine: string;
  readonly model: string;
  readonly tokens?: DetailedTokenDimensions | undefined;
  readonly valuedAt: number;
}): ApiEquivalentCostEstimate {
  const { model, tokens, valuedAt } = options;
  if (!tokens) {
    return {
      status: 'unavailable',
      currency: 'USD',
      reason: 'no token dimensions available for valuation',
    };
  }

  const rates = CODEX_PRICE_SNAPSHOT[model];
  if (!rates) {
    return {
      status: 'unavailable',
      currency: 'USD',
      reason: `model '${model}' not found in frozen price snapshot ${CODEX_PRICE_SNAPSHOT_VERSION}`,
    };
  }

  const cachedInput = tokens.cachedInputTokens ?? 0;
  const uncachedInput = tokens.uncachedInputTokens ?? (
    tokens.inputTokens !== undefined ? Math.max(0, tokens.inputTokens - cachedInput) : 0
  );
  const output = tokens.outputTokens ?? 0;

  const uncachedMicros = uncachedInput * rates.inputMicrosPerToken;
  const cachedMicros = cachedInput * rates.cachedInputMicrosPerToken;
  const outputMicros = output * rates.outputMicrosPerToken;

  const totalMicros = Math.round(uncachedMicros + cachedMicros + outputMicros);

  return {
    status: 'available',
    currency: 'USD',
    apiEquivalentUsdMicros: totalMicros,
    valuationProvenance: 'locally_estimated',
    priceSource: 'codex-price-snapshot',
    priceSourceVersion: CODEX_PRICE_SNAPSHOT_VERSION,
    priceDimensions: {
      model,
      rates,
      uncachedInputTokens: uncachedInput,
      cachedInputTokens: cachedInput,
      outputTokens: output,
    },
    valuedAt,
  };
}

/**
 * Extract Pi's harness-calculated cost breakdown.
 */
export function extractPiCostEstimate(options: {
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
  readonly piVersion?: string;
  readonly valuedAt: number;
}): ApiEquivalentCostEstimate {
  const { cost, piVersion = '0.85.1', valuedAt } = options;
  if (!cost || typeof cost.total !== 'number' || !Number.isFinite(cost.total) || cost.total < 0) {
    return {
      status: 'unavailable',
      currency: 'USD',
      reason: 'Pi engine did not emit usage cost breakdown',
    };
  }

  return {
    status: 'available',
    currency: 'USD',
    apiEquivalentUsdMicros: Math.round(cost.total * 1_000_000),
    valuationProvenance: 'harness_calculated',
    priceSource: 'pi-catalog',
    priceSourceVersion: piVersion,
    priceDimensions: { ...cost },
    valuedAt,
  };
}

/**
 * Extract a provider-backend estimate (e.g. from Codex turn_cost or account/usage/read).
 */
export function extractProviderCostEstimate(options: {
  readonly estimatedUsd?: number;
  readonly estimatedUsdMicros?: number;
  readonly source: string;
  readonly sourceVersion?: string;
  readonly valuedAt: number;
}): ApiEquivalentCostEstimate {
  const { estimatedUsd, estimatedUsdMicros, source, sourceVersion = '1.0', valuedAt } = options;

  let micros: number | undefined;
  if (typeof estimatedUsdMicros === 'number' && Number.isSafeInteger(estimatedUsdMicros) && estimatedUsdMicros >= 0) {
    micros = estimatedUsdMicros;
  } else if (typeof estimatedUsd === 'number' && Number.isFinite(estimatedUsd) && estimatedUsd >= 0) {
    micros = Math.round(estimatedUsd * 1_000_000);
  }

  if (micros === undefined) {
    return {
      status: 'pending',
      currency: 'USD',
      reason: 'provider cost estimate pending',
    };
  }

  return {
    status: 'available',
    currency: 'USD',
    apiEquivalentUsdMicros: micros,
    valuationProvenance: 'provider_estimated',
    priceSource: source,
    priceSourceVersion: sourceVersion,
    valuedAt,
  };
}
