import type { InjectionKey } from 'vue';
import type {
  UsageAggregate,
  UsageActivityKind,
  ValuationProvenance,
  BillingBasis,
} from '../../../../src/usage/model.ts';
import type { ActivityDetailView } from '../../../../src/usage/service.ts';
import type { UsageActivityFilter, UsageAggregateFilter } from '../../../../src/usage/store.ts';

export type UsageTab = 'run' | 'task' | 'project' | 'agent' | 'model' | 'time';

export type UsageSettlementRange = 'today' | '7d' | '30d' | 'all';

export type UsageOutcome = 'completed' | 'ongoing' | 'failed' | 'stopped' | 'interrupted';

export type UsageObservationState = 'stable' | 'delayed' | 'corrected' | 'pending';

export interface UsageModelIdentity {
  readonly source: string;
  readonly provider: string;
  readonly version: string;
}

export interface UsageTokenDimensions {
  readonly status: 'complete' | 'partial' | 'unavailable';
  readonly totalInput?: number | undefined;
  readonly uncachedInput?: number | undefined;
  readonly cachedReads?: number | undefined;
  readonly cacheWrite?: number | undefined;
  readonly output?: number | undefined;
  readonly reasoningOutput?: number | undefined;
  readonly total?: number | undefined;
  readonly source: string;
}

export interface UsageCostValuation {
  readonly attributableBilledCostStatus: 'available' | 'unavailable';
  readonly apiEquivalentStatus: 'available' | 'pending' | 'unavailable';
  readonly estimatedUsdMicros?: number | undefined;
  readonly provenance?: ValuationProvenance | undefined;
  readonly billingBasis: BillingBasis;
  readonly source?: string | undefined;
  readonly sourceVersion?: string | undefined;
  readonly note: string;
}

export interface UsageObservationHistoryEntry {
  readonly timestamp: string;
  readonly source: string;
  readonly status: string;
  readonly usdMicros?: number | undefined;
  readonly note: string;
  readonly supersedes?: string | undefined;
}

/** Composed activity item for the Manage / Usage and Costs UI */
export interface UsageActivityItem {
  readonly id: string;
  readonly kind: UsageActivityKind;
  readonly projectId: string;
  readonly taskId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly engine?: string | undefined;
  readonly model: string;
  readonly provider?: string | undefined;
  readonly modelIdentity: UsageModelIdentity;
  readonly activityTime: string;
  readonly settlementRange: 'today' | '7d' | '30d';
  readonly outcome: UsageOutcome;
  readonly sessionMode: 'new' | 'resumed';
  readonly observationState: UsageObservationState;
  readonly wallDurationMs?: number | undefined;
  readonly durationStatus: 'complete' | 'partial' | 'unavailable';
  readonly durationSource: string;
  readonly engineDurationMs?: number | undefined;
  readonly taskCalendarElapsedMs?: number | undefined;
  readonly outcomeReason?: string | undefined;
  readonly tokenDimensions: UsageTokenDimensions;
  readonly costValuation: UsageCostValuation;
  readonly coverageNote: string;
  readonly observationHistory?: readonly UsageObservationHistoryEntry[] | undefined;
}

export interface UsageFilterState {
  readonly tab: UsageTab;
  readonly timeRange: UsageSettlementRange;
  readonly projectId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly model?: string | undefined;
  readonly selectedActivityId?: string | undefined;
}

export interface UsageProjectOption {
  readonly id: string;
  readonly displayName: string;
}

export interface UsageAgentOption {
  readonly id: string;
  readonly displayName: string;
}

/**
 * Authoritative remote-state port for Manage / Usage and Costs (ADR-0010, ADR-0011).
 *
 * Separates backend facts from UI state: the page owns presentation and
 * interaction only, while usage activities, append-only observations, valuation
 * history, and coverage-aware aggregation remain backend-owned.
 */
export interface UsageManagementService {
  listActivities(filter?: UsageActivityFilter): Promise<readonly UsageActivityItem[]>;
  getAggregate(filter?: UsageAggregateFilter): Promise<UsageAggregate>;
  getActivityDetail(activityId: string): Promise<ActivityDetailView | undefined>;
  listProjects(): Promise<readonly UsageProjectOption[]>;
  listAgents(): Promise<readonly UsageAgentOption[]>;
  listModels(): Promise<readonly string[]>;
}

export const USAGE_SERVICE: InjectionKey<UsageManagementService> = Symbol(
  'sprout.usage.service'
);
