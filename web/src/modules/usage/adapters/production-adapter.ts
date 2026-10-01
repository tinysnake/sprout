import type {
  UsageManagementService,
  UsageActivityItem,
  UsageProjectOption,
  UsageAgentOption,
  UsageOutcome,
} from '../types.ts';
import type { UsageBrowserAdapter } from '../../../adapters/usage-api.ts';
import type { UsageActivityFilter, UsageAggregateFilter } from '../../../../../src/usage/store.ts';
import type { UsageAggregate, UsageActivity as BackendActivity, UsageObservation } from '../../../../../src/usage/model.ts';
import type { ActivityDetailView } from '../../../../../src/usage/service.ts';

function mapOutcome(status: string): UsageOutcome {
  if (status === 'active') return 'ongoing';
  if (status === 'failed') return 'failed';
  if (status === 'stopped') return 'stopped';
  if (status === 'interrupted') return 'interrupted';
  return 'completed';
}

function mapSettlementRange(activity: BackendActivity): UsageActivityItem['settlementRange'] {
  const ts = activity.settledAt ?? activity.createdAt;
  const now = Date.now();
  const diffMs = now - ts;
  if (diffMs <= 24 * 60 * 60 * 1000) return 'today';
  if (diffMs <= 7 * 24 * 60 * 60 * 1000) return '7d';
  if (diffMs <= 30 * 24 * 60 * 60 * 1000) return '30d';
  return 'older';
}

export function mapObservationToItem(
  activity: BackendActivity,
  observation?: UsageObservation,
  history?: ActivityDetailView['supersessionHistory']
): UsageActivityItem {
  const outcome = mapOutcome(activity.status);
  const wallDurationMs = activity.wallDurationMs ?? observation?.durations.sproutWallDurationMs;
  const durationStatus = activity.status === 'active' ? 'partial' : wallDurationMs !== undefined ? 'complete' : 'unavailable';

  const tokenDim = observation?.tokens;
  const tokenStatus = observation?.completeness ?? (activity.status === 'active' ? 'partial' : 'unavailable');

  const costEstimate = observation?.costEstimate;
  const costStatus = costEstimate?.status ?? (activity.status === 'active' ? 'pending' : 'unavailable');

  const isResumed = activity.engine === 'pi' && Boolean(observation?.source && /resumed/i.test(observation.source));
  const isCorrected = (history && history.length > 0) || (observation?.supersedesObservationId !== undefined);
  const isDelayed = costStatus === 'pending' || (observation?.observedAt !== undefined && activity.settledAt !== undefined && observation.observedAt > activity.settledAt + 5000);

  const observationState = isCorrected ? 'corrected' : isDelayed ? 'delayed' : outcome === 'ongoing' ? 'pending' : 'stable';

  const projectId = activity.correlation.projectId ?? 'unassigned';
  const taskId = activity.kind === 'agent_run' ? activity.correlation.taskId : undefined;
  const agentId = activity.kind === 'agent_run' ? activity.correlation.agentId : undefined;

  return {
    id: activity.id,
    kind: activity.kind,
    projectId,
    taskId,
    agentId,
    engine: activity.engine,
    model: activity.model,
    provider: observation?.source?.split(' ')[0] ?? (activity.engine === 'pi' ? 'Anthropic' : activity.engine === 'codex' ? 'OpenAI' : undefined),
    modelIdentity: {
      source: observation?.source ?? `${activity.engine} telemetry`,
      provider: observation?.costEstimate.priceSource ?? activity.engine,
      version: observation?.sourceVersion ?? '1.0',
    },
    activityTime: new Date(activity.settledAt ?? activity.createdAt).toLocaleTimeString(),
    settlementRange: mapSettlementRange(activity),
    outcome,
    sessionMode: isResumed ? 'resumed' : 'new',
    observationState,
    wallDurationMs,
    durationStatus,
    durationSource: `Sprout ${activity.kind === 'agent_run' ? 'run' : 'routing-attempt'} lifecycle`,
    engineDurationMs: observation?.durations.engineTurnDurationMs,
    outcomeReason: activity.status !== 'completed' ? `Settled as ${activity.status}` : undefined,
    tokenDimensions: {
      status: tokenStatus,
      totalInput: tokenDim?.inputTokens,
      uncachedInput: tokenDim?.uncachedInputTokens,
      cachedReads: tokenDim?.cachedInputTokens,
      cacheWrite: tokenDim?.cacheWriteInputTokens,
      output: tokenDim?.outputTokens,
      reasoningOutput: tokenDim?.reasoningOutputTokens,
      total: tokenDim?.totalTokens,
      source: observation?.source ?? 'Engine telemetry',
    },
    costValuation: {
      attributableBilledCostStatus: observation?.billedCost.status ?? 'unavailable',
      apiEquivalentStatus: costStatus,
      estimatedUsdMicros: costEstimate?.apiEquivalentUsdMicros,
      provenance: costEstimate?.valuationProvenance,
      billingBasis: observation?.billingBasis ?? 'unknown',
      source: costEstimate?.priceSource,
      sourceVersion: costEstimate?.priceSourceVersion,
      note: costEstimate?.reason ?? 'API-equivalent USD estimation',
    },
    coverageNote: `${tokenStatus} token measurement. ${costStatus} cost estimate.`,
    observationHistory: (history ?? []).map((h: NonNullable<ActivityDetailView['supersessionHistory']>[number]) => ({
      timestamp: new Date(h.observedAt).toLocaleTimeString(),
      source: 'Telemetry observation',
      status: 'superseded',
      note: h.reason ?? 'Observation transition',
      supersedes: h.supersedesObservationId,
    })),
  };
}

export class ProductionUsageService implements UsageManagementService {
  readonly #adapter: UsageBrowserAdapter;
  readonly #detailCache = new Map<string, ActivityDetailView>();

  constructor(adapter: UsageBrowserAdapter) {
    this.#adapter = adapter;
  }

  async listActivities(filter?: UsageActivityFilter): Promise<readonly UsageActivityItem[]> {
    const backendActivities = await this.#adapter.listActivities(filter);
    // Fetch details for available activities to have full observations
    const items = await Promise.all(
      backendActivities.map(async (activity) => {
        let detail = this.#detailCache.get(activity.id);
        if (!detail) {
          try {
            detail = await this.#adapter.getActivity(activity.id);
            if (detail) this.#detailCache.set(activity.id, detail);
          } catch {
            // Non-fatal if detail cannot be loaded
          }
        }
        return mapObservationToItem(activity, detail?.effectiveObservation, detail?.supersessionHistory);
      })
    );
    return items;
  }

  async getAggregate(filter?: UsageAggregateFilter): Promise<UsageAggregate> {
    return this.#adapter.getAggregate(filter);
  }

  async getActivityDetail(activityId: string): Promise<ActivityDetailView | undefined> {
    if (this.#detailCache.has(activityId)) {
      return this.#detailCache.get(activityId);
    }
    const detail = await this.#adapter.getActivity(activityId);
    if (detail) {
      this.#detailCache.set(activityId, detail);
    }
    return detail;
  }

  async listProjects(): Promise<readonly UsageProjectOption[]> {
    const activities = await this.#adapter.listActivities();
    const projectIds = new Set<string>();
    for (const a of activities) {
      if (a.correlation.projectId) projectIds.add(a.correlation.projectId);
    }
    return [...projectIds].map((id) => ({ id, displayName: id }));
  }

  async listAgents(): Promise<readonly UsageAgentOption[]> {
    const activities = await this.#adapter.listActivities({ kind: 'agent_run' });
    const agentIds = new Set<string>();
    for (const a of activities) {
      if (a.kind === 'agent_run' && a.correlation.agentId) {
        agentIds.add(a.correlation.agentId);
      }
    }
    return [...agentIds].map((id) => ({ id, displayName: id }));
  }

  async listModels(): Promise<readonly string[]> {
    const activities = await this.#adapter.listActivities();
    return [...new Set(activities.map((a) => a.model))];
  }
}
