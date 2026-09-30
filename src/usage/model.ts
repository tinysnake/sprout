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
export interface AgentRunUsageCorrelation {
  readonly runId: string;
  readonly attemptId?: never;
  readonly batchId?: never;
  readonly projectId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly agentId: string;
  readonly environmentInstanceId?: string | undefined;
}

/** Structural attribution boundary: Routing attempts have no Agent or Task fields. */
export interface RoutingAttemptUsageCorrelation {
  readonly runId?: never;
  readonly attemptId: string;
  readonly batchId: string;
  readonly projectId: string;
  readonly taskId?: never;
  readonly agentId?: never;
  readonly environmentInstanceId?: never;
}

export type UsageActivityCorrelation = AgentRunUsageCorrelation | RoutingAttemptUsageCorrelation;

interface UsageActivityFields {
  readonly id: string;
  readonly engine: string;
  readonly model: string;
  readonly status: UsageActivityStatus;
  readonly createdAt: number;
  readonly settledAt?: number | undefined;
  readonly wallDurationMs?: number | undefined;
}

/**
 * One model-consuming activity observed by Sprout. The discriminant makes a
 * Routing attempt structurally incapable of carrying Agent or Task attribution.
 */
export type UsageActivity = UsageActivityFields & (
  | { readonly kind: 'agent_run'; readonly correlation: AgentRunUsageCorrelation }
  | { readonly kind: 'routing_attempt'; readonly correlation: RoutingAttemptUsageCorrelation }
);

export function assertUsageActivityAttribution(activity: UsageActivity): void {
  const correlation = activity.correlation as unknown as Record<string, unknown>;
  const valid = activity.kind === 'agent_run'
    ? typeof correlation.runId === 'string' && correlation.runId.length > 0 &&
      correlation.attemptId === undefined && correlation.batchId === undefined &&
      typeof correlation.agentId === 'string' && correlation.agentId.length > 0
    : activity.kind === 'routing_attempt' &&
      typeof correlation.attemptId === 'string' && correlation.attemptId.length > 0 &&
      typeof correlation.batchId === 'string' && correlation.batchId.length > 0 &&
      typeof correlation.projectId === 'string' && correlation.projectId.length > 0 &&
      correlation.runId === undefined && correlation.taskId === undefined &&
      correlation.agentId === undefined && correlation.environmentInstanceId === undefined;
  if (!valid) throw new Error('Invalid usage activity attribution: work and routing ownership are disjoint');
}

export function assertUsageActivityIdentityUnchanged(prior: UsageActivity, next: UsageActivity): void {
  const same = prior.id === next.id && prior.kind === next.kind &&
    prior.engine === next.engine && prior.model === next.model && prior.createdAt === next.createdAt &&
    (prior.kind === 'agent_run' && next.kind === 'agent_run'
      ? prior.correlation.runId === next.correlation.runId &&
        prior.correlation.projectId === next.correlation.projectId &&
        prior.correlation.taskId === next.correlation.taskId &&
        prior.correlation.agentId === next.correlation.agentId &&
        prior.correlation.environmentInstanceId === next.correlation.environmentInstanceId
      : prior.kind === 'routing_attempt' && next.kind === 'routing_attempt' &&
        prior.correlation.attemptId === next.correlation.attemptId &&
        prior.correlation.batchId === next.correlation.batchId &&
        prior.correlation.projectId === next.correlation.projectId);
  if (!same) throw new Error('Usage activity identity is immutable after recording');
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
  /** A dimension is omitted when no activity reported that dimension. */
  readonly inputTokens?: number | undefined;
  readonly uncachedInputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly cacheWriteInputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningOutputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly status: TokenCoverageStatus;
}

export type CostCoverageStatus = 'single_provenance' | 'mixed_provenance' | 'unavailable';

export interface CostTotals {
  /** Omitted when no activity has a known estimate; known zero remains 0. */
  readonly apiEquivalentUsdMicros?: number | undefined;
  readonly status: CostCoverageStatus;
  readonly byProvenance: Partial<Record<ValuationProvenance, number>>;
}

export interface UsageActivityIdentity {
  readonly activityId: string;
  readonly kind: UsageActivityKind;
  readonly runId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly batchId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly model: string;
  readonly status: UsageActivityStatus;
  readonly createdAt: number;
  readonly settledAt?: number | undefined;
}

/** The bounds are absolute instants; the named IANA zone is explicit display/derivation context. */
export interface UsageTimeRange {
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly timeZone: string;
  readonly bounds: '[start, end)';
  readonly attribution: 'settlement';
}

export interface UsageAggregate {
  readonly totalActivities: number;
  readonly tokenCoverage: TokenCoverageCounts;
  readonly costCoverage: CostCoverageCounts;
  readonly tokens: TokenTotals;
  readonly cost: CostTotals;
  readonly billedCost: AttributableBilledCost;
  readonly totalSproutWallDurationMs?: number | undefined;
  readonly activityIdentities: readonly UsageActivityIdentity[];
  readonly timeRange?: UsageTimeRange | undefined;
  readonly workModelSubtotal?: UsageAggregate | undefined;
  readonly routingModelSubtotal?: UsageAggregate | undefined;
  readonly groups?: Record<string, UsageAggregate> | undefined;
  readonly provisionalTotals?: UsageAggregate | undefined;
}

export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function assertUsageObservation(observation: UsageObservation): void {
  if (observation.costEstimate.status === 'available' && (
    !isTokenCount(observation.costEstimate.apiEquivalentUsdMicros) ||
    observation.costEstimate.valuationProvenance === undefined
  )) {
    throw new Error('Available API-equivalent cost requires a safe amount and valuation provenance');
  }
  if (observation.billedCost.status === 'available' && !isTokenCount(observation.billedCost.billedUsdMicros)) {
    throw new Error('Available billed cost requires a safe amount');
  }
}

export function emptyTokenTotals(): TokenTotals {
  return { status: 'unavailable' };
}

export function emptyCostTotals(): CostTotals {
  return { status: 'unavailable', byProvenance: {} };
}

export function emptyUsageAggregate(): UsageAggregate {
  return {
    totalActivities: 0,
    tokenCoverage: { complete: 0, partial: 0, unavailable: 0 },
    costCoverage: { available: 0, pending: 0, unavailable: 0 },
    tokens: emptyTokenTotals(),
    cost: emptyCostTotals(),
    billedCost: { status: 'unavailable', currency: 'USD', reason: 'no activity observed' },
    activityIdentities: [],
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

  const tokenTotals: Partial<Record<keyof Omit<TokenTotals, 'status'>, number>> = {};
  const addToken = (key: keyof Omit<TokenTotals, 'status'>, value: number | undefined): void => {
    if (value !== undefined) tokenTotals[key] = (tokenTotals[key] ?? 0) + value;
  };
  let hasAnyTokenDimension = false;
  let apiEquivalentUsdMicros: number | undefined;
  const byProvenance: Partial<Record<ValuationProvenance, number>> = {};
  const seenProvenances = new Set<ValuationProvenance>();
  let totalWallDurationMs: number | undefined;
  let anyBilledAvailable = false;
  let totalBilledUsdMicros = 0;

  for (const { activity, observation } of items) {
    const duration = activity.status === 'active'
      ? activity.wallDurationMs ?? observation?.durations.sproutWallDurationMs
      : observation?.durations.sproutWallDurationMs ?? activity.wallDurationMs;
    if (duration !== undefined) totalWallDurationMs = (totalWallDurationMs ?? 0) + duration;

    if (!observation || observation.completeness === 'unavailable') {
      unavailableTokensCount += 1;
    } else if (observation.completeness === 'complete') {
      completeTokensCount += 1;
    } else {
      partialTokensCount += 1;
    }

    if (observation?.tokens) {
      for (const key of [
        'inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
        'outputTokens', 'reasoningOutputTokens', 'totalTokens',
      ] as const) {
        const value = observation.tokens[key];
        if (value !== undefined) hasAnyTokenDimension = true;
        addToken(key, value);
      }
    }

    if (!observation || observation.costEstimate.status === 'unavailable') {
      unavailableCostCount += 1;
    } else if (observation.costEstimate.status === 'pending') {
      pendingCostCount += 1;
    } else {
      availableCostCount += 1;
      const micros = observation.costEstimate.apiEquivalentUsdMicros;
      if (micros !== undefined) apiEquivalentUsdMicros = (apiEquivalentUsdMicros ?? 0) + micros;
      const provenance = observation.costEstimate.valuationProvenance;
      if (micros !== undefined && provenance !== undefined) {
        byProvenance[provenance] = (byProvenance[provenance] ?? 0) + micros;
        seenProvenances.add(provenance);
      }
    }

    if (observation?.billedCost.status === 'available' && observation.billedCost.billedUsdMicros !== undefined) {
      anyBilledAvailable = true;
      totalBilledUsdMicros += observation.billedCost.billedUsdMicros;
    }
  }

  const tokenStatus: TokenCoverageStatus = !hasAnyTokenDimension
    ? 'unavailable'
    : partialTokensCount > 0 || unavailableTokensCount > 0 || completeTokensCount !== items.length
      ? 'observed_incomplete'
      : 'complete';
  const costStatus: CostCoverageStatus = apiEquivalentUsdMicros === undefined
    ? 'unavailable'
    : seenProvenances.size > 1 ? 'mixed_provenance' : 'single_provenance';

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
    tokens: { ...tokenTotals, status: tokenStatus },
    cost: {
      ...(apiEquivalentUsdMicros !== undefined ? { apiEquivalentUsdMicros } : {}),
      status: costStatus,
      byProvenance,
    },
    billedCost: anyBilledAvailable
      ? { status: 'available', currency: 'USD', billedUsdMicros: totalBilledUsdMicros }
      : { status: 'unavailable', currency: 'USD', reason: 'provider does not supply per-run invoice facts' },
    ...(totalWallDurationMs !== undefined ? { totalSproutWallDurationMs: totalWallDurationMs } : {}),
    activityIdentities: items.map(({ activity }) => ({
      activityId: activity.id,
      kind: activity.kind,
      ...activity.correlation,
      model: activity.model,
      status: activity.status,
      createdAt: activity.createdAt,
      ...(activity.settledAt !== undefined ? { settledAt: activity.settledAt } : {}),
    })),
  };
}
