import type {
  UsageManagementService,
  UsageActivityItem,
  UsageProjectOption,
  UsageAgentOption,
} from '../types.ts';
import type { UsageActivityFilter, UsageAggregateFilter } from '../../../../../src/usage/store.ts';
import type { UsageAggregate } from '../../../../../src/usage/model.ts';
import type { ActivityDetailView } from '../../../../../src/usage/service.ts';

const initialActivities: UsageActivityItem[] = [
  {
    id: 'act-203',
    kind: 'agent_run',
    projectId: 'proj-minesweeper',
    taskId: 'task-101',
    agentId: 'programmer',
    engine: 'pi',
    provider: 'Anthropic',
    modelIdentity: { source: 'Pi telemetry', provider: 'Anthropic', version: 'Pi 0.85.1' },
    model: 'claude-3-5-sonnet',
    activityTime: '28m ago',
    settlementRange: 'today',
    outcome: 'completed',
    sessionMode: 'resumed',
    observationState: 'stable',
    wallDurationMs: 142000,
    durationStatus: 'complete',
    engineDurationMs: undefined,
    taskCalendarElapsedMs: 2100000,
    durationSource: 'Sprout run lifecycle: started to settled',
    coverageNote: 'All token dimensions observed on the final usage-bearing call.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 50400,
      uncachedInput: 18400,
      cachedReads: 32000,
      cacheWrite: 4200,
      output: 6800,
      reasoningOutput: 2400,
      total: 61400,
      source: 'Pi message_end final Usage',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 142000,
      provenance: 'harness_calculated',
      billingBasis: 'metered_api',
      source: 'Pi usage.cost',
      sourceVersion: 'Pi 0.85.1 catalogue snapshot',
      note: 'API-equivalent only. Calculated once from the frozen Pi catalogue.',
    },
    observationHistory: [
      {
        timestamp: '28m ago',
        source: 'Pi engine harness final turn emission',
        status: 'available',
        usdMicros: 142000,
        note: 'Harness-calculated from the frozen Pi model price catalogue.',
      },
    ],
  },
  {
    id: 'act-204',
    kind: 'agent_run',
    projectId: 'proj-minesweeper',
    taskId: 'task-101',
    agentId: 'reviewer',
    engine: 'codex',
    provider: 'OpenAI',
    modelIdentity: { source: 'Codex telemetry', provider: 'OpenAI', version: 'Codex CLI 0.154.0' },
    model: 'gpt-4o',
    activityTime: '3m ago',
    settlementRange: 'today',
    outcome: 'completed',
    sessionMode: 'new',
    observationState: 'corrected',
    wallDurationMs: 98000,
    durationStatus: 'complete',
    engineDurationMs: 94100,
    taskCalendarElapsedMs: 2100000,
    durationSource: 'Sprout run lifecycle: started to settled',
    coverageNote: 'Complete per-turn usage. A later provider estimate superseded the local fallback.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 36600,
      uncachedInput: 12100,
      cachedReads: 24500,
      cacheWrite: 0,
      output: 4100,
      reasoningOutput: 1200,
      total: 41900,
      source: 'Codex thread/tokenUsage.updated last by turnId',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 89000,
      provenance: 'provider_estimated',
      billingBasis: 'metered_api',
      source: 'Codex per-turn backend estimate',
      sourceVersion: 'Codex CLI 0.154.0',
      note: 'Provider estimate selected after the delayed backend response. It is not a bill.',
    },
    observationHistory: [
      {
        timestamp: '3m ago',
        source: 'Sprout frozen Codex price snapshot',
        status: 'superseded',
        usdMicros: 76000,
        note: 'Local estimate retained for correction history.',
      },
      {
        timestamp: '1m ago',
        source: 'Codex per-turn backend estimate',
        status: 'available and selected',
        usdMicros: 89000,
        note: 'Delayed provider estimate corrected the selected valuation.',
        supersedes: 'Sprout frozen Codex price snapshot',
      },
    ],
  },
  {
    id: 'act-202',
    kind: 'agent_run',
    projectId: 'proj-minesweeper',
    agentId: 'designer',
    engine: 'codex',
    provider: 'OpenAI',
    modelIdentity: { source: 'Codex telemetry', provider: 'OpenAI', version: 'Codex CLI 0.154.0' },
    model: 'gpt-4o',
    activityTime: '24m ago',
    settlementRange: 'today',
    outcome: 'stopped',
    sessionMode: 'new',
    observationState: 'stable',
    wallDurationMs: 34000,
    durationStatus: 'complete',
    durationSource: 'Sprout run lifecycle: started to stopped',
    coverageNote: 'Stopped after a trustworthy final usage event. Stopped does not mean zero usage.',
    outcomeReason: 'Human stopped the run before the next tool turn.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 14200,
      uncachedInput: 4200,
      cachedReads: 10000,
      cacheWrite: 0,
      output: 1800,
      reasoningOutput: 600,
      total: 16000,
      source: 'Codex thread/tokenUsage.updated last by turnId',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 38000,
      provenance: 'provider_estimated',
      billingBasis: 'subscription_included',
      source: 'Codex per-turn backend estimate',
      sourceVersion: 'Codex CLI 0.154.0',
      note: 'Subscription-inclusive basis leaves billed cost unavailable; the estimate is not converted to zero.',
    },
  },
  {
    id: 'act-wake-002',
    kind: 'routing_attempt',
    projectId: 'proj-minesweeper',
    engine: undefined,
    provider: 'OpenAI',
    modelIdentity: { source: 'Wake-model adapter', provider: 'OpenAI', version: 'OpenAI pricing snapshot 2025.2' },
    model: 'gpt-4o-mini',
    activityTime: '24m 30s ago',
    settlementRange: 'today',
    outcome: 'completed',
    sessionMode: 'new',
    observationState: 'stable',
    wallDurationMs: 1400,
    durationStatus: 'complete',
    durationSource: 'Sprout routing-attempt lifecycle',
    coverageNote: 'Routing telemetry is complete for this attempt. It belongs to the Project, not an Agent or Task.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 1840,
      uncachedInput: 1840,
      cachedReads: 0,
      cacheWrite: 0,
      output: 120,
      reasoningOutput: 0,
      total: 1960,
      source: 'Wake-model adapter attempt result',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 350,
      provenance: 'locally_estimated',
      billingBasis: 'metered_api',
      source: 'Frozen official price snapshot',
      sourceVersion: 'OpenAI pricing snapshot 2025.2',
      note: 'Routing activity is a separate Project-owned model activity.',
    },
  },
  {
    id: 'act-206',
    kind: 'agent_run',
    projectId: 'proj-minesweeper',
    taskId: 'task-101',
    agentId: 'programmer',
    engine: 'pi',
    provider: 'Anthropic',
    modelIdentity: { source: 'Pi telemetry', provider: 'Anthropic', version: 'Pi 0.85.1' },
    model: 'claude-3-5-sonnet',
    activityTime: 'ongoing now',
    settlementRange: 'today',
    outcome: 'ongoing',
    sessionMode: 'resumed',
    observationState: 'pending',
    wallDurationMs: 38000,
    durationStatus: 'partial',
    taskCalendarElapsedMs: 2100000,
    durationSource: 'Sprout run lifecycle: observed so far',
    coverageNote: 'Partial observation. The run is ongoing and is excluded from finalized totals.',
    tokenDimensions: {
      status: 'partial',
      totalInput: 22000,
      uncachedInput: 7200,
      cachedReads: 14800,
      cacheWrite: undefined,
      output: 3100,
      reasoningOutput: 900,
      total: undefined,
      source: 'Pi streaming usage observed so far',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'pending',
      estimatedUsdMicros: undefined,
      provenance: undefined,
      billingBasis: 'subscription_included',
      source: 'Pi final Usage not emitted yet',
      sourceVersion: 'Pi 0.85.1',
      note: 'Pending settlement. Known observed tokens are not a finalized estimate.',
    },
  },
  {
    id: 'act-207',
    kind: 'agent_run',
    projectId: 'proj-docs-portal',
    taskId: 'task-102',
    agentId: 'researcher',
    engine: 'codex',
    provider: 'OpenAI',
    modelIdentity: { source: 'Codex telemetry', provider: 'OpenAI', version: 'Codex CLI 0.154.0' },
    model: 'gpt-4o',
    activityTime: '2h ago',
    settlementRange: '7d',
    outcome: 'failed',
    sessionMode: 'new',
    observationState: 'delayed',
    wallDurationMs: 71000,
    durationStatus: 'complete',
    engineDurationMs: 68000,
    durationSource: 'Sprout run lifecycle: started to failed',
    coverageNote: 'Partial token observation before failure. Cost backend has not returned a correlated value.',
    outcomeReason: 'Engine reported a turn failure after tool invocation.',
    tokenDimensions: {
      status: 'partial',
      totalInput: 11800,
      uncachedInput: 11800,
      cachedReads: undefined,
      cacheWrite: undefined,
      output: 900,
      reasoningOutput: undefined,
      total: undefined,
      source: 'Codex last usage before turn failure',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'pending',
      estimatedUsdMicros: undefined,
      provenance: undefined,
      billingBasis: 'unknown',
      source: 'Codex per-turn cost poll pending',
      sourceVersion: 'Codex CLI 0.154.0',
      note: 'Delayed cost is not a zero and is not included in available USD arithmetic.',
    },
    observationHistory: [
      {
        timestamp: '2h ago',
        source: 'Codex turn/tokenUsage.updated',
        status: 'partial',
        note: 'Failure settled before all token dimensions were observed.',
      },
    ],
  },
  {
    id: 'act-208',
    kind: 'agent_run',
    projectId: 'proj-docs-portal',
    taskId: 'task-102',
    agentId: 'designer',
    engine: 'pi',
    provider: 'Anthropic',
    modelIdentity: { source: 'Pi telemetry', provider: 'Anthropic', version: 'Pi 0.85.1' },
    model: 'claude-3-5-sonnet',
    activityTime: 'yesterday',
    settlementRange: '7d',
    outcome: 'stopped',
    sessionMode: 'resumed',
    observationState: 'stable',
    wallDurationMs: 54000,
    durationStatus: 'complete',
    durationSource: 'Sprout run lifecycle: started to stopped',
    coverageNote: 'Complete usage for the resumed invocation. Historical session context is not counted again.',
    outcomeReason: 'Human interrupt settled the Agent run as stopped.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 18200,
      uncachedInput: 6200,
      cachedReads: 12000,
      cacheWrite: 1400,
      output: 2200,
      reasoningOutput: 700,
      total: 20400,
      source: 'Pi message_end final Usage for resumed invocation',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 21000,
      provenance: 'harness_calculated',
      billingBasis: 'subscription_included',
      source: 'Pi usage.cost',
      sourceVersion: 'Pi 0.85.1 catalogue snapshot',
      note: 'Subscription-inclusive basis is shown independently from the API-equivalent estimate.',
    },
  },
  {
    id: 'act-209',
    kind: 'agent_run',
    projectId: 'proj-docs-portal',
    taskId: 'task-102',
    agentId: 'researcher',
    engine: 'codex',
    provider: 'OpenAI',
    modelIdentity: { source: 'Codex telemetry', provider: 'OpenAI', version: 'Codex CLI 0.154.0' },
    model: 'gpt-4o',
    activityTime: 'yesterday',
    settlementRange: '7d',
    outcome: 'interrupted',
    sessionMode: 'new',
    observationState: 'stable',
    wallDurationMs: 29000,
    durationStatus: 'complete',
    durationSource: 'Sprout run lifecycle: started to interrupted',
    coverageNote: 'Partial usage retained from before interruption. It is not omitted or zero-filled.',
    outcomeReason: 'Worker disconnect interrupted the run before terminal engine usage.',
    tokenDimensions: {
      status: 'partial',
      totalInput: 8600,
      uncachedInput: 8600,
      cachedReads: undefined,
      cacheWrite: undefined,
      output: 600,
      reasoningOutput: 200,
      total: 9200,
      source: 'Codex last usage before interruption',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'unavailable',
      estimatedUsdMicros: undefined,
      provenance: undefined,
      billingBasis: 'unknown',
      source: 'No correlated provider estimate',
      sourceVersion: 'Codex CLI 0.154.0',
      note: 'Unavailable because the interrupted turn could not be correlated to a priced response.',
    },
  },
  {
    id: 'act-wake-003',
    kind: 'routing_attempt',
    projectId: 'proj-docs-portal',
    model: 'gpt-4o-mini',
    provider: 'OpenAI',
    modelIdentity: { source: 'Wake-model adapter', provider: 'OpenAI', version: 'Wake-model adapter contract pending' },
    activityTime: 'yesterday',
    settlementRange: '7d',
    outcome: 'failed',
    sessionMode: 'new',
    observationState: 'stable',
    wallDurationMs: 12000,
    durationStatus: 'complete',
    durationSource: 'Sprout routing-attempt lifecycle',
    coverageNote: 'Routing attempt failed validation. Missing routing telemetry is shown as a coverage gap.',
    outcomeReason: 'Wake model response was malformed after the bounded retry.',
    tokenDimensions: {
      status: 'unavailable',
      source: 'Routing adapter did not emit trustworthy usage',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'unavailable',
      estimatedUsdMicros: undefined,
      provenance: undefined,
      billingBasis: 'unknown',
      source: 'No routing valuation emitted',
      sourceVersion: 'Wake-model adapter contract pending',
      note: 'Unavailable is a coverage fact, not a zero-cost assertion.',
    },
  },
  {
    id: 'act-210',
    kind: 'agent_run',
    projectId: 'proj-docs-portal',
    taskId: 'task-102',
    agentId: 'programmer',
    engine: 'codex',
    provider: 'OpenAI',
    modelIdentity: { source: 'Codex telemetry', provider: 'OpenAI', version: 'Codex CLI 0.154.0' },
    model: 'gpt-4o',
    activityTime: '3d ago',
    settlementRange: '30d',
    outcome: 'completed',
    sessionMode: 'new',
    observationState: 'delayed',
    wallDurationMs: 121000,
    durationStatus: 'complete',
    durationSource: 'Sprout run lifecycle: started to settled',
    coverageNote: 'Complete tokens. Cost remains pending after the bounded provider collection window.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 29000,
      uncachedInput: 15000,
      cachedReads: 14000,
      cacheWrite: 800,
      output: 3600,
      reasoningOutput: 1000,
      total: 32600,
      source: 'Codex last usage correlated by turnId',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'pending',
      estimatedUsdMicros: undefined,
      provenance: undefined,
      billingBasis: 'metered_api',
      source: 'Codex backend estimate collection window',
      sourceVersion: 'Codex CLI 0.154.0',
      note: 'Cost was not reported in the turn collection window and remains pending.',
    },
    observationHistory: [
      {
        timestamp: '3d ago',
        source: 'Codex thread/tokenUsage.updated last',
        status: 'pending',
        note: 'Tokens observed complete; waiting on provider cost correlation.',
      },
    ],
  },
];

const initialProjects: UsageProjectOption[] = [
  { id: 'proj-minesweeper', displayName: 'Project Minesweeper' },
  { id: 'proj-docs-portal', displayName: 'Docs & API Portal' },
];

const initialAgents: UsageAgentOption[] = [
  { id: 'programmer', displayName: 'Programmer Agent' },
  { id: 'reviewer', displayName: 'Reviewer Agent' },
  { id: 'designer', displayName: 'Designer Agent' },
  { id: 'researcher', displayName: 'Researcher Agent' },
];

export class FixtureUsageService implements UsageManagementService {
  readonly #activities: UsageActivityItem[];
  readonly #projects: UsageProjectOption[];
  readonly #agents: UsageAgentOption[];

  constructor(options?: {
    activities?: UsageActivityItem[];
    projects?: UsageProjectOption[];
    agents?: UsageAgentOption[];
  }) {
    this.#activities = options?.activities ? [...options.activities] : [...initialActivities];
    this.#projects = options?.projects ? [...options.projects] : [...initialProjects];
    this.#agents = options?.agents ? [...options.agents] : [...initialAgents];
  }

  get rawActivities(): UsageActivityItem[] {
    return this.#activities;
  }

  async listActivities(filter: UsageActivityFilter = {}): Promise<readonly UsageActivityItem[]> {
    return this.#activities.filter((activity) => {
      if (filter.kind && activity.kind !== filter.kind) return false;
      if (filter.runId && `run-${activity.id}` !== filter.runId) return false;
      if (filter.attemptId && `att-${activity.id}` !== filter.attemptId) return false;
      const ageDays = { today: 0, '7d': 3, '30d': 15, older: 60 }[activity.settlementRange];
      const instant = Date.now() - ageDays * 86400000;
      if (filter.from !== undefined && instant < filter.from) return false;
      if (filter.to !== undefined && instant >= filter.to) return false;
      if (filter.projectId && filter.projectId !== 'all' && activity.projectId !== filter.projectId) return false;
      if (filter.taskId && filter.taskId !== 'all' && activity.taskId !== filter.taskId) return false;
      if (filter.agentId && filter.agentId !== 'all' && activity.agentId !== filter.agentId) return false;
      if (filter.model && filter.model !== 'all' && activity.model !== filter.model) return false;
      if (filter.provisional === true && activity.outcome !== 'ongoing') return false;
      if (filter.provisional === false && activity.outcome === 'ongoing') return false;
      return true;
    });
  }

  async getAggregate(filter: UsageAggregateFilter = {}): Promise<UsageAggregate> {
    const activities = await this.listActivities({
      kind: filter.kind,
      runId: filter.runId,
      attemptId: filter.attemptId,
      from: filter.from,
      to: filter.to,
      projectId: filter.projectId,
      taskId: filter.taskId,
      agentId: filter.agentId,
      model: filter.model,
      provisional: filter.provisional,
    });

    return this.#buildAggregate(activities);
  }

  #buildAggregate(activities: readonly UsageActivityItem[], isSubtotal = false): UsageAggregate {
    let completeTokens = 0;
    let partialTokens = 0;
    let unavailableTokens = 0;
    let availableCost = 0;
    let pendingCost = 0;
    let unavailableCost = 0;
    let totalDuration = 0;
    let totalTokens = 0;
    let totalUsdMicros = 0;
    const byProvenance: Partial<Record<string, number>> = {};
    const seenProvenances = new Set<string>();

    for (const a of activities) {
      if (a.wallDurationMs !== undefined) totalDuration += a.wallDurationMs;
      if (a.tokenDimensions.status === 'complete') completeTokens += 1;
      else if (a.tokenDimensions.status === 'partial') partialTokens += 1;
      else unavailableTokens += 1;

      if (a.tokenDimensions.total !== undefined) totalTokens += a.tokenDimensions.total;

      if (a.costValuation.apiEquivalentStatus === 'available') {
        availableCost += 1;
        if (a.costValuation.estimatedUsdMicros !== undefined) {
          totalUsdMicros += a.costValuation.estimatedUsdMicros;
          const prov = a.costValuation.provenance ?? 'locally_estimated';
          seenProvenances.add(prov);
          byProvenance[prov] = (byProvenance[prov] ?? 0) + a.costValuation.estimatedUsdMicros;
        }
      } else if (a.costValuation.apiEquivalentStatus === 'pending') {
        pendingCost += 1;
      } else {
        unavailableCost += 1;
      }
    }

    const tokenStatus = activities.length === 0
      ? 'unavailable'
      : (partialTokens > 0 || unavailableTokens > 0)
        ? 'observed_incomplete'
        : 'complete';

    const costStatus = availableCost === 0
      ? 'unavailable'
      : seenProvenances.size > 1
        ? 'mixed_provenance'
        : 'single_provenance';

    const workActivities = activities.filter((a) => a.kind === 'agent_run');
    const routingActivities = activities.filter((a) => a.kind === 'routing_attempt');

    return {
      totalActivities: activities.length,
      tokenCoverage: { complete: completeTokens, partial: partialTokens, unavailable: unavailableTokens },
      costCoverage: { available: availableCost, pending: pendingCost, unavailable: unavailableCost },
      tokens: {
        totalTokens: totalTokens > 0 ? totalTokens : undefined,
        status: tokenStatus,
      },
      cost: {
        apiEquivalentUsdMicros: totalUsdMicros > 0 ? totalUsdMicros : undefined,
        status: costStatus,
        byProvenance,
      },
      billedCost: { status: 'unavailable', currency: 'USD', reason: 'no per-activity bill exposed' },
      totalSproutWallDurationMs: totalDuration > 0 ? totalDuration : undefined,
      activityIdentities: activities.map((a) => ({
        activityId: a.id,
        runId: a.kind === 'agent_run' ? `run-${a.id}` : undefined,
        attemptId: a.kind === 'routing_attempt' ? `att-${a.id}` : undefined,
        kind: a.kind,
        projectId: a.projectId,
        taskId: a.taskId,
        agentId: a.agentId,
        model: a.model,
        status: a.outcome === 'ongoing' ? 'active' : a.outcome,
        createdAt: 0,
      })),
      workModelSubtotal: !isSubtotal && workActivities.length > 0 ? this.#buildAggregate(workActivities, true) : undefined,
      routingModelSubtotal: !isSubtotal && routingActivities.length > 0 ? this.#buildAggregate(routingActivities, true) : undefined,
    };
  }

  async getActivityDetail(activityId: string): Promise<ActivityDetailView | undefined> {
    const item = this.#activities.find((a) => a.id === activityId);
    if (!item) return undefined;

    return {
      activity: {
        id: item.id,
        engine: item.engine ?? 'pi',
        model: item.model,
        status: item.outcome === 'ongoing' ? 'active' : item.outcome,
        createdAt: 0,
        settledAt: item.outcome === 'ongoing' ? undefined : 1,
        wallDurationMs: item.wallDurationMs,
        ...(item.kind === 'agent_run'
          ? {
              kind: 'agent_run' as const,
              correlation: {
                runId: `run-${item.id}`,
                projectId: item.projectId,
                taskId: item.taskId,
                agentId: item.agentId ?? 'unassigned',
              },
            }
          : {
              kind: 'routing_attempt' as const,
              correlation: {
                attemptId: `att-${item.id}`,
                batchId: 'batch-0',
                projectId: item.projectId,
              },
            }),
      },
      effectiveObservation: {
        id: `obs-${item.id}-effective`, activityId: item.id, observedAt: 1,
        source: item.modelIdentity.source, sourceVersion: item.modelIdentity.version,
        completeness: item.tokenDimensions.status,
        tokens: {
          inputTokens: item.tokenDimensions.totalInput, uncachedInputTokens: item.tokenDimensions.uncachedInput,
          cachedInputTokens: item.tokenDimensions.cachedReads, cacheWriteInputTokens: item.tokenDimensions.cacheWrite,
          outputTokens: item.tokenDimensions.output, reasoningOutputTokens: item.tokenDimensions.reasoningOutput,
          totalTokens: item.tokenDimensions.total,
        },
        durations: { sproutWallDurationMs: item.wallDurationMs ?? 0 },
        billedCost: { status: item.costValuation.attributableBilledCostStatus, currency: 'USD' },
        costEstimate: { status: item.costValuation.apiEquivalentStatus, currency: 'USD',
          apiEquivalentUsdMicros: item.costValuation.estimatedUsdMicros, valuationProvenance: item.costValuation.provenance },
        billingBasis: item.costValuation.billingBasis, isEffective: true,
      },
      observations: (item.observationHistory ?? []).map((h, i) => ({
        id: `obs-${item.id}-${i}`,
        activityId: item.id,
        observedAt: 0,
        source: h.source,
        sourceVersion: '1.0',
        completeness: item.tokenDimensions.status,
        durations: { sproutWallDurationMs: item.wallDurationMs ?? 0 },
        billedCost: { status: 'unavailable', currency: 'USD' as const },
        costEstimate: {
          status: item.costValuation.apiEquivalentStatus,
          currency: 'USD' as const,
          apiEquivalentUsdMicros: h.usdMicros ?? item.costValuation.estimatedUsdMicros,
          valuationProvenance: item.costValuation.provenance,
        },
        billingBasis: item.costValuation.billingBasis,
        isEffective: i === (item.observationHistory?.length ?? 1) - 1,
      })),
      supersessionHistory: [],
    };
  }

  async listProjects(): Promise<readonly UsageProjectOption[]> {
    return this.#projects;
  }

  async listAgents(): Promise<readonly UsageAgentOption[]> {
    return this.#agents;
  }

  async listModels(): Promise<readonly string[]> {
    return [...new Set(this.#activities.map((a) => a.model))];
  }
}
