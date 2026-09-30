/**
 * Usage and cost observability domain model (ADR-0010, #105).
 *
 * Sprout coordinates persistent agents, collaborative projects, and heterogeneous
 * work environments while observing model consumption truthfully:
 *
 * 1. An Agent run is a work-model activity. A wake-model Routing attempt is a
 *    routing-model activity. Routing attempts belong to their Project, never to an
 *    Agent or Task.
 * 2. Token dimensions are preserved at the engine's finest trustworthy granularity
 *    (input, uncached, cached, cache-write, output, reasoning detail, total).
 * 3. Wall duration is cross-engine Sprout wall elapsed time, distinct from engine-native
 *    timing or Task calendar elapsed time.
 * 4. Attributable billed cost and API-equivalent cost estimate are separate facts.
 *    Settled bills remain unavailable for measured per-run interfaces in M2.
 * 5. Billing basis (metered API, subscription included, unknown) is independent
 *    of valuation provenance (provider estimated, harness calculated, locally estimated).
 *    Subscription-inclusive access does not mean zero billed cost.
 * 6. Delayed observations and corrections append with source, reason, and
 *    supersession history; prior observations are never overwritten.
 * 7. Coverage-aware aggregates expose complete, partial, pending, and unavailable
 *    states so missing telemetry is never silently treated as zero.
 */

export type UsageActivityKind = 'agent_run' | 'routing_attempt';

export type UsageActivityStatus = 'active' | 'completed' | 'failed' | 'interrupted' | 'stopped';

export type MeasurementCompleteness = 'complete' | 'partial' | 'unavailable';

export type BilledCostStatus = 'available' | 'unavailable';

export type ApiEquivalentCostStatus = 'pending' | 'available' | 'unavailable';

export type ValuationProvenance = 'provider_estimated' | 'harness_calculated' | 'locally_estimated';

export type BillingBasis = 'metered_api' | 'subscription_included' | 'unknown';

/**
 * Detailed trustworthy token dimensions (ADR-0010 §"Durable run usage facts").
 *
 * Preserves the finest breakdown an engine or provider supplies.
 * Uncached input is recorded only when unambiguously available; reasoning output
 * is detail within output unless a versioned provider contract states otherwise.
 */
export interface DetailedTokenDimensions {
  readonly inputTokens?: number | undefined;
  readonly uncachedInputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly cacheWriteInputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningOutputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
}

/**
 * Authoritative cross-engine Sprout wall duration alongside optional native timing.
 */
export interface DurationDimensions {
  readonly sproutWallDurationMs: number;
  readonly engineTurnDurationMs?: number | undefined;
}

/**
 * Settled provider invoice or ledger fact.
 *
 * For measured per-run interfaces in M2 (Codex, Pi), this remains unavailable
 * because neither measured interface exposes an attributable bill.
 */
export interface AttributableBilledCost {
  readonly status: BilledCostStatus;
  readonly currency: 'USD';
  readonly billedUsdMicros?: number | undefined;
  readonly reason?: string | undefined;
}

/**
 * USD valuation of observed model usage, explicitly separate from billed cost.
 *
 * Values are normalized to integer USD micros (1 USD = 1,000,000 micros).
 */
export interface ApiEquivalentCostEstimate {
  readonly status: ApiEquivalentCostStatus;
  readonly currency: 'USD';
  readonly apiEquivalentUsdMicros?: number | undefined;
  readonly valuationProvenance?: ValuationProvenance | undefined;
  readonly priceSource?: string | undefined;
  readonly priceSourceVersion?: string | undefined;
  readonly priceDimensions?: Record<string, unknown> | undefined;
  readonly valuedAt?: number | undefined;
  readonly reason?: string | undefined;
}

/**
 * Domain correlation links for an activity.
 *
 * An Agent run may link to run, Task, Project, Agent, and Environment.
 * A Routing attempt links to attempt, batch, Project, and wake model,
 * but never to an Agent or Task (ADR-0010 §"Usage activities and attribution").
 */
export interface UsageActivityCorrelation {
  readonly runId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly batchId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly environmentInstanceId?: string | undefined;
}

/**
 * One model-consuming activity observed by Sprout.
 */
export interface UsageActivity {
  readonly id: string;
  readonly kind: UsageActivityKind;
  readonly correlation: UsageActivityCorrelation;
  readonly engine: string;
  readonly model: string;
  readonly status: UsageActivityStatus;
  readonly createdAt: number;
  readonly settledAt?: number | undefined;
  readonly wallDurationMs?: number | undefined;
}

/**
 * One durable, source- and version-identified observation for an activity.
 *
 * Delayed observations and corrections append with supersession history
 * and reasons rather than overwriting prior observations.
 */
export interface UsageObservation {
  readonly id: string;
  readonly activityId: string;
  readonly observedAt: number;
  readonly source: string;
  readonly sourceVersion: string;
  readonly completeness: MeasurementCompleteness;
  readonly tokens?: DetailedTokenDimensions | undefined;
  readonly durations: DurationDimensions;
  readonly billedCost: AttributableBilledCost;
  readonly costEstimate: ApiEquivalentCostEstimate;
  readonly billingBasis: BillingBasis;
  readonly supersedesObservationId?: string | undefined;
  readonly supersededAt?: number | undefined;
  readonly supersessionReason?: string | undefined;
  readonly isEffective: boolean;
}

export interface TokenCoverageCounts {
  readonly complete: number;
  readonly partial: number;
  readonly unavailable: number;
}

export interface CostCoverageCounts {
  readonly available: number;
  readonly pending: number;
  readonly unavailable: number;
}

export type TokenCoverageStatus = 'complete' | 'observed_incomplete' | 'unavailable';

export interface TokenTotals {
  readonly inputTokens: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly status: TokenCoverageStatus;
}

export type CostCoverageStatus = 'single_provenance' | 'mixed_provenance' | 'unavailable';

export interface CostTotals {
  readonly apiEquivalentUsdMicros: number;
  readonly status: CostCoverageStatus;
  readonly byProvenance: Record<ValuationProvenance, number>;
}

export interface UsageAggregate {
  readonly totalActivities: number;
  readonly tokenCoverage: TokenCoverageCounts;
  readonly costCoverage: CostCoverageCounts;
  readonly tokens: TokenTotals;
  readonly cost: CostTotals;
  readonly billedCost: AttributableBilledCost;
  readonly totalSproutWallDurationMs: number;
  readonly workModelSubtotal?: UsageAggregate | undefined;
  readonly routingModelSubtotal?: UsageAggregate | undefined;
  readonly groups?: Record<string, UsageAggregate> | undefined;
  readonly provisionalTotals?: UsageAggregate | undefined;
}

export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function emptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    status: 'unavailable',
  };
}

export function emptyCostTotals(): CostTotals {
  return {
    apiEquivalentUsdMicros: 0,
    status: 'unavailable',
    byProvenance: {
      provider_estimated: 0,
      harness_calculated: 0,
      locally_estimated: 0,
    },
  };
}

export function emptyUsageAggregate(): UsageAggregate {
  return {
    totalActivities: 0,
    tokenCoverage: { complete: 0, partial: 0, unavailable: 0 },
    costCoverage: { available: 0, pending: 0, unavailable: 0 },
    tokens: emptyTokenTotals(),
    cost: emptyCostTotals(),
    billedCost: { status: 'unavailable', currency: 'USD', reason: 'no activity observed' },
    totalSproutWallDurationMs: 0,
  };
}

/**
 * Aggregate a collection of activities and their effective observations.
 *
 * Implements the coverage-aware aggregation rules of ADR-0010:
 * - Aggregates sum available observations and never substitute zero for missing data.
 * - Missing telemetry is counted in coverage as partial or unavailable.
 * - If any activity has partial or unavailable token coverage, token total is
 *   labelled 'observed_incomplete'.
 * - If estimates with different provenance are summed, cost total is labelled
 *   'mixed_provenance' and provenance breakdowns are provided.
 * - Pending and unavailable costs do not enter USD arithmetic but enter coverage counts.
 */
export function aggregateObservations(
  items: readonly { readonly activity: UsageActivity; readonly observation?: UsageObservation | undefined }[],
): UsageAggregate {
  if (items.length === 0) return emptyUsageAggregate();

  let completeTokensCount = 0;
  let partialTokensCount = 0;
  let unavailableTokensCount = 0;

  let availableCostCount = 0;
  let pendingCostCount = 0;
  let unavailableCostCount = 0;

  let inputTokens = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let totalTokens = 0;
  let hasAnyTokens = false;

  let apiEquivalentUsdMicros = 0;
  let hasAnyCost = false;
  const byProvenance: Record<ValuationProvenance, number> = {
    provider_estimated: 0,
    harness_calculated: 0,
    locally_estimated: 0,
  };
  const seenProvenances = new Set<ValuationProvenance>();

  let totalWallDurationMs = 0;
  let anyBilledAvailable = false;
  let totalBilledUsdMicros = 0;

  for (const { activity, observation } of items) {
    totalWallDurationMs += observation?.durations.sproutWallDurationMs ?? activity.wallDurationMs ?? 0;

    if (!observation || observation.completeness === 'unavailable') {
      unavailableTokensCount += 1;
    } else if (observation.completeness === 'complete') {
      completeTokensCount += 1;
    } else {
      partialTokensCount += 1;
    }

    if (observation?.tokens) {
      hasAnyTokens = true;
      inputTokens += observation.tokens.inputTokens ?? 0;
      uncachedInputTokens += observation.tokens.uncachedInputTokens ?? 0;
      cachedInputTokens += observation.tokens.cachedInputTokens ?? 0;
      cacheWriteInputTokens += observation.tokens.cacheWriteInputTokens ?? 0;
      outputTokens += observation.tokens.outputTokens ?? 0;
      reasoningOutputTokens += observation.tokens.reasoningOutputTokens ?? 0;
      totalTokens += observation.tokens.totalTokens ?? 0;
    }

    if (!observation || observation.costEstimate.status === 'unavailable') {
      unavailableCostCount += 1;
    } else if (observation.costEstimate.status === 'pending') {
      pendingCostCount += 1;
    } else if (observation.costEstimate.status === 'available') {
      availableCostCount += 1;
      const micros = observation.costEstimate.apiEquivalentUsdMicros ?? 0;
      apiEquivalentUsdMicros += micros;
      hasAnyCost = true;
      const prov = observation.costEstimate.valuationProvenance ?? 'locally_estimated';
      byProvenance[prov] = (byProvenance[prov] ?? 0) + micros;
      seenProvenances.add(prov);
    }

    if (observation?.billedCost.status === 'available' && observation.billedCost.billedUsdMicros !== undefined) {
      anyBilledAvailable = true;
      totalBilledUsdMicros += observation.billedCost.billedUsdMicros;
    }
  }

  let tokenStatus: TokenCoverageStatus;
  if (!hasAnyTokens && completeTokensCount === 0 && partialTokensCount === 0) {
    tokenStatus = 'unavailable';
  } else if (partialTokensCount > 0 || unavailableTokensCount > 0) {
    tokenStatus = 'observed_incomplete';
  } else {
    tokenStatus = 'complete';
  }

  let costStatus: CostCoverageStatus;
  if (!hasAnyCost) {
    costStatus = 'unavailable';
  } else if (seenProvenances.size > 1) {
    costStatus = 'mixed_provenance';
  } else {
    costStatus = 'single_provenance';
  }

  return {
    totalActivities: items.length,
    tokenCoverage: {
      complete: completeTokensCount,
      partial: partialTokensCount,
      unavailable: unavailableTokensCount,
    },
    costCoverage: {
      available: availableCostCount,
      pending: pendingCostCount,
      unavailable: unavailableCostCount,
    },
    tokens: {
      inputTokens,
      uncachedInputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,
      status: tokenStatus,
    },
    cost: {
      apiEquivalentUsdMicros,
      status: costStatus,
      byProvenance,
    },
    billedCost: anyBilledAvailable
      ? { status: 'available', currency: 'USD', billedUsdMicros: totalBilledUsdMicros }
      : { status: 'unavailable', currency: 'USD', reason: 'provider does not supply per-run invoice facts' },
    totalSproutWallDurationMs: totalWallDurationMs,
  };
}
