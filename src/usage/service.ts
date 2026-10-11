/**
 * Usage domain service (ADR-0010, #105).
 *
 * Coordinates usage observation recording, delayed updates, corrections,
 * and multi-dimensional aggregates. Enforces:
 * - Activity identity and run/attempt correlation
 * - Detailed token dimensions without inventing zeros
 * - Sprout wall duration distinguished from engine or Task timing
 * - Independent attributable billed cost and API-equivalent estimates
 * - Frozen valuation provenance and billing basis
 * - Append-only delayed observations and corrections with supersession history
 */

import { randomUUID } from 'node:crypto';

import type { AgentRun } from '../run/model.ts';
import type { RoutingAttempt } from '../collaboration/routing.ts';
import type {
  UsageActivity,
  UsageObservation,
  UsageAggregate,
  DetailedTokenDimensions,
  ApiEquivalentCostEstimate,
  AttributableBilledCost,
  BillingBasis,
  MeasurementCompleteness,
  UsageActivityStatus,
} from './model.ts';
import {
  calculateLocalEstimate,
  defaultUnavailableBilledCost,
  defaultUnavailableCostEstimate,
} from './valuation.ts';
import type {
  UsageActivityFilter,
  UsageAggregateFilter,
  UsageStore,
} from './store.ts';

export interface UsageServiceOptions {
  readonly store: UsageStore;
  readonly clock?: { now(): number };
}

export interface DelayedObservationInput {
  readonly activityId: string;
  readonly supersedesObservationId: string;
  readonly source: string;
  readonly sourceVersion?: string | undefined;
  readonly reason: string;
  readonly tokens?: DetailedTokenDimensions | undefined;
  readonly completeness?: MeasurementCompleteness | undefined;
  readonly costEstimate?: ApiEquivalentCostEstimate | undefined;
  readonly billedCost?: AttributableBilledCost | undefined;
  readonly billingBasis?: BillingBasis | undefined;
}

export interface ActivityDetailView {
  readonly activity: UsageActivity;
  readonly effectiveObservation?: UsageObservation | undefined;
  readonly observations: readonly UsageObservation[];
  readonly supersessionHistory: readonly {
    readonly observationId: string;
    readonly supersedesObservationId?: string | undefined;
    readonly observedAt: number;
    readonly reason?: string | undefined;
  }[];
}

function equivalentUsageObservation(
  left: UsageObservation,
  right: UsageObservation,
  provisional: boolean,
): boolean {
  const facts = (observation: UsageObservation) => JSON.stringify({
    source: observation.source,
    sourceVersion: observation.sourceVersion,
    completeness: observation.completeness,
    tokens: observation.tokens,
    ...(provisional ? {} : { durations: observation.durations }),
    billedCost: observation.billedCost,
    costEstimate: {
      status: observation.costEstimate.status,
      currency: observation.costEstimate.currency,
      apiEquivalentUsdMicros: observation.costEstimate.apiEquivalentUsdMicros,
      valuationProvenance: observation.costEstimate.valuationProvenance,
      priceSource: observation.costEstimate.priceSource,
      priceSourceVersion: observation.costEstimate.priceSourceVersion,
      priceDimensions: observation.costEstimate.priceDimensions,
      reason: observation.costEstimate.reason,
    },
    billingBasis: observation.billingBasis,
  });
  return facts(left) === facts(right);
}

export class UsageService {
  readonly #store: UsageStore;
  readonly #clock: { now(): number };

  constructor(options: UsageServiceOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  get store(): UsageStore {
    return this.#store;
  }

  /**
   * Record or update an Agent run activity and its observation.
   *
   * Called when a run starts, advances, or settles. Trustworthy partial usage
   * is preserved on failure, stop, or interruption.
   */
  async recordRunActivity(run: AgentRun): Promise<UsageActivity> {
    const activityId = `ua_run_${run.id}`;
    const now = this.#clock.now();

    let status: UsageActivityStatus;
    if (run.status === 'queued' || run.status === 'running') {
      status = 'active';
    } else if (run.status === 'completed') {
      status = 'completed';
    } else if (run.recoverySettlement?.status === 'stopped') {
      status = 'stopped';
    } else if (run.status === 'interrupted') {
      status = 'interrupted';
    } else {
      status = 'failed';
    }

    const wallDurationMs = run.completedAt !== undefined
      ? Math.max(0, run.completedAt - run.createdAt)
      : status === 'active' ? Math.max(0, now - run.createdAt) : undefined;

    const activity: UsageActivity = {
      id: activityId,
      kind: 'agent_run',
      correlation: {
        runId: run.id,
        ...(run.taskId !== undefined ? { taskId: run.taskId } : {}),
        ...(run.projectId !== undefined ? { projectId: run.projectId } : {}),
        agentId: run.agentId,
        ...(run.executionMode !== 'host-run' ? { environmentInstanceId: run.environmentInstanceId } : {}),
        executionMode: run.executionMode ?? 'environment-hosted',
        ...(run.engineHostProfileId !== undefined ? { engineHostProfileId: run.engineHostProfileId } : {}),
      },
      engine: run.workOption?.engine ?? 'unknown',
      model: run.workOption?.workModel ?? 'unknown',
      status,
      createdAt: run.createdAt,
      ...(run.completedAt !== undefined ? { settledAt: run.completedAt } : {}),
      ...(wallDurationMs !== undefined ? { wallDurationMs } : {}),
    };

    const priorActivity = await this.#store.getActivity(activityId);
    await this.#store.recordActivity(activity);

    const hasObservedUsage = run.detailedTokens !== undefined || run.tokenUsage !== undefined ||
      run.result?.detailedTokens !== undefined || run.result?.tokenUsage !== undefined ||
      run.result?.costEstimate !== undefined;
    if (run.completedAt === undefined ? hasObservedUsage : true) {
      const existing = await this.#store.getEffectiveObservation(activityId);
      const mayFinalizeProvisional = priorActivity?.settledAt === undefined;
      if (existing === undefined || run.completedAt === undefined || mayFinalizeProvisional) {
        await this.#recordRunObservation(activity, run, wallDurationMs ?? 0, now, existing);
      }
    }

    return activity;
  }

  async #recordRunObservation(
    activity: UsageActivity,
    run: AgentRun,
    wallDurationMs: number,
    now: number,
    prior?: UsageObservation,
  ): Promise<void> {
    const engine = run.workOption?.engine ?? 'unknown';
    const model = run.workOption?.workModel ?? 'unknown';
    const result = run.result;

    const fromCoarseUsage = (
      tokenUsage: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number } | undefined,
    ): DetailedTokenDimensions | undefined => tokenUsage === undefined ? undefined : {
      inputTokens: tokenUsage.promptTokens,
      outputTokens: tokenUsage.completionTokens,
      totalTokens: tokenUsage.totalTokens,
    };
    const resultTokens = result?.detailedTokens ?? fromCoarseUsage(result?.tokenUsage);
    const runTokens = run.detailedTokens ?? fromCoarseUsage(run.tokenUsage);
    const settledResultOmittedTokens = run.completedAt !== undefined && result !== undefined && resultTokens === undefined;
    const reportedTokens = resultTokens ?? (settledResultOmittedTokens ? undefined : runTokens);
    const carriedTokens = reportedTokens === undefined
      ? settledResultOmittedTokens ? runTokens ?? prior?.tokens : prior?.tokens
      : undefined;
    const detailedTokens = reportedTokens ?? carriedTokens;
    const carriedTokenObservation = reportedTokens === undefined && detailedTokens !== undefined;

    let completeness: MeasurementCompleteness;
    if (reportedTokens !== undefined) {
      completeness = run.status === 'completed' ? 'complete' : 'partial';
    } else if (carriedTokenObservation) {
      completeness = 'partial';
    } else {
      completeness = 'unavailable';
    }

    let costEstimate: ApiEquivalentCostEstimate;
    if (result?.costEstimate !== undefined) {
      costEstimate = result.costEstimate;
    } else if (engine === 'codex' || engine === 'openai') {
      const localEstimate = calculateLocalEstimate({
        engine,
        model,
        tokens: detailedTokens,
        pricingContext: result?.pricingContext,
        valuedAt: now,
      });
      costEstimate = localEstimate.status === 'available' ? localEstimate :
        prior?.costEstimate ?? localEstimate;
    } else {
      costEstimate = prior?.costEstimate ??
        defaultUnavailableCostEstimate(`no price calculation available for engine '${engine}'`);
    }

    const observation: UsageObservation = {
      id: prior === undefined ? `uobs_run_${run.id}_initial` : `uobs_run_${run.id}_${randomUUID()}`,
      activityId: activity.id,
      observedAt: now,
      source: carriedTokenObservation && run.completedAt !== undefined
        ? `${prior?.source ?? result?.source ?? `${engine}:turn`} (last observed before settlement; final update reported no token dimensions)`
        : result?.source ?? prior?.source ?? `${engine}:turn`,
      sourceVersion: result?.sourceVersion ?? prior?.sourceVersion ?? '1.0',
      completeness,
      ...(detailedTokens !== undefined ? { tokens: detailedTokens } : {}),
      durations: {
        sproutWallDurationMs: wallDurationMs,
        ...(result?.engineTurnDurationMs !== undefined
          ? { engineTurnDurationMs: result.engineTurnDurationMs }
          : prior?.durations.engineTurnDurationMs !== undefined
            ? { engineTurnDurationMs: prior.durations.engineTurnDurationMs }
            : {}),
      },
      billedCost: prior?.billedCost ?? defaultUnavailableBilledCost(),
      costEstimate,
      billingBasis: result?.billingBasis ?? prior?.billingBasis ?? 'unknown',
      ...(prior !== undefined ? {
        supersedesObservationId: prior.id,
        supersessionReason: run.completedAt === undefined
          ? 'Provisional usage observation updated from run telemetry'
          : 'Run usage finalized at settlement',
      } : {}),
      isEffective: true,
    };
    if (prior !== undefined && equivalentUsageObservation(prior, observation, activity.status === 'active')) return;
    await this.#store.recordObservation(observation);
  }

  /**
   * Record a wake-model Routing attempt activity and its observation.
   *
   * A Routing attempt belongs to its Project and model, never to an Agent or Task.
   * Unsupported telemetry produces an explicitly unavailable observation, never zero.
   */
  async recordRoutingAttemptActivity(
    attempt: RoutingAttempt,
    context: {
      readonly batchId: string;
      readonly projectId: string;
      readonly durationMs?: number | undefined;
      readonly tokens?: DetailedTokenDimensions | undefined;
      readonly cost?: ApiEquivalentCostEstimate | undefined;
      readonly billingBasis?: BillingBasis | undefined;
      readonly source?: string | undefined;
      readonly sourceVersion?: string | undefined;
    },
  ): Promise<UsageActivity> {
    const activityId = `ua_att_${attempt.id}`;
    const now = this.#clock.now();
    const settled = attempt.status !== 'started';
    const wallDurationMs = context.durationMs ?? Math.max(
      0,
      (settled ? attempt.finishedAt : now) - attempt.startedAt,
    );

    let status: UsageActivityStatus;
    if (attempt.status === 'started') {
      status = 'active';
    } else if (attempt.status === 'succeeded') {
      status = 'completed';
    } else {
      status = 'failed';
    }

    const activity: UsageActivity = {
      id: activityId,
      kind: 'routing_attempt',
      correlation: {
        attemptId: attempt.id,
        batchId: context.batchId,
        projectId: context.projectId,
      },
      engine: 'routing-model',
      model: attempt.modelId,
      status,
      createdAt: attempt.startedAt,
      ...(settled ? { settledAt: attempt.finishedAt } : {}),
      wallDurationMs,
    };

    const priorActivity = await this.#store.getActivity(activityId);
    await this.#store.recordActivity(activity);

    const existing = await this.#store.getEffectiveObservation(activityId);
    const hasObservedUsage = context.tokens !== undefined || context.cost !== undefined;
    const shouldRecordObservation = attempt.status === 'started'
      ? hasObservedUsage
      : existing === undefined || priorActivity?.settledAt === undefined;
    if (shouldRecordObservation) {
      const tokens = context.tokens ?? existing?.tokens;
      const completeness: MeasurementCompleteness = tokens === undefined
        ? 'unavailable'
        : !settled || attempt.status === 'failed' ? 'partial' : 'complete';
      const costEstimate = context.cost ?? existing?.costEstimate ??
        defaultUnavailableCostEstimate('wake-model telemetry unavailable');
      const observation: UsageObservation = {
        id: existing === undefined ? `uobs_att_${attempt.id}_initial` : `uobs_att_${attempt.id}_${randomUUID()}`,
        activityId: activity.id,
        observedAt: now,
        source: context.source ?? existing?.source ?? 'routing-model:judge',
        sourceVersion: context.sourceVersion ?? existing?.sourceVersion ?? '1.0',
        completeness,
        ...(tokens !== undefined ? { tokens } : {}),
        durations: { sproutWallDurationMs: wallDurationMs },
        billedCost: existing?.billedCost ?? defaultUnavailableBilledCost('wake model does not supply attributable invoice facts'),
        costEstimate,
        billingBasis: context.billingBasis ?? existing?.billingBasis ?? 'unknown',
        ...(existing !== undefined ? {
          supersedesObservationId: existing.id,
          supersessionReason: settled
            ? 'Routing attempt usage finalized at settlement'
            : 'Provisional Routing telemetry updated from the attempt',
        } : {}),
        isEffective: true,
      };
      if (existing === undefined || !equivalentUsageObservation(existing, observation, !settled)) {
        await this.#store.recordObservation(observation);
      }
    }

    return activity;
  }

  /**
   * Append a delayed observation or correction for an existing activity.
   *
   * Appends to supersession history rather than overwriting prior observations.
   */
  async recordDelayedObservation(input: DelayedObservationInput): Promise<UsageObservation> {
    if (!input.source.trim() || !input.reason.trim()) {
      throw new Error('Corrections require source and reason');
    }
    const activity = await this.#store.getActivity(input.activityId);
    if (!activity) {
      throw new Error(`Usage activity not found: ${input.activityId}`);
    }

    const prior = await this.#store.getObservation(input.supersedesObservationId);
    if (!prior || prior.activityId !== input.activityId) {
      throw new Error(`Superseded observation not found for activity: ${input.supersedesObservationId}`);
    }

    if (!prior.isEffective) {
      throw new Error('Cannot supersede a stale observation; use the current effective head');
    }
    const now = this.#clock.now();
    const newId = `uobs_${randomUUID()}`;

    const observation: UsageObservation = {
      id: newId,
      activityId: input.activityId,
      observedAt: now,
      source: input.source,
      sourceVersion: input.sourceVersion ?? prior.sourceVersion,
      completeness: input.completeness ?? (input.tokens !== undefined ? 'complete' : prior.completeness),
      tokens: input.tokens ?? prior.tokens,
      durations: prior.durations,
      billedCost: input.billedCost ?? prior.billedCost,
      costEstimate: input.costEstimate ?? prior.costEstimate,
      billingBasis: input.billingBasis ?? prior.billingBasis,
      supersedesObservationId: input.supersedesObservationId,
      supersessionReason: input.reason,
      isEffective: true,
    };

    await this.#store.recordObservation(observation);
    return observation;
  }

  async recordCorrection(input: DelayedObservationInput): Promise<UsageObservation> {
    return this.recordDelayedObservation(input);
  }

  async getActivity(id: string): Promise<ActivityDetailView | undefined> {
    const activity = await this.#store.getActivity(id);
    if (!activity) return undefined;

    const effectiveObservation = await this.#store.getEffectiveObservation(id);
    const observations = await this.#store.listObservations(id);

    const supersessionHistory = observations.map((obs) => ({
      observationId: obs.id,
      ...(obs.supersedesObservationId !== undefined ? { supersedesObservationId: obs.supersedesObservationId } : {}),
      observedAt: obs.observedAt,
      ...(obs.supersessionReason !== undefined ? { reason: obs.supersessionReason } : {}),
    }));

    return {
      activity,
      effectiveObservation,
      observations,
      supersessionHistory,
    };
  }

  async getActivityByRunId(runId: string): Promise<ActivityDetailView | undefined> {
    const activity = await this.#store.getActivityByRunId(runId);
    if (!activity) return undefined;
    return this.getActivity(activity.id);
  }

  async getActivityByAttemptId(attemptId: string): Promise<ActivityDetailView | undefined> {
    const activity = await this.#store.getActivityByAttemptId(attemptId);
    if (!activity) return undefined;
    return this.getActivity(activity.id);
  }

  async listActivities(filter?: UsageActivityFilter): Promise<readonly UsageActivity[]> {
    return this.#store.listActivities(filter);
  }

  async getAggregate(filter?: UsageAggregateFilter): Promise<UsageAggregate> {
    return this.#store.getAggregate(filter);
  }

  /**
   * View: Agent run usage drill-down.
   */
  async getRunUsage(runId: string): Promise<ActivityDetailView | undefined> {
    return this.getActivityByRunId(runId);
  }

  /**
   * View: Task usage aggregate (includes nested Agent runs, grouped by Agent and model).
   */
  async getTaskUsage(taskId: string, filter: UsageAggregateFilter = {}): Promise<UsageAggregate> {
    return this.getAggregate({ ...filter, taskId, kind: 'agent_run', groupBy: filter.groupBy ?? 'agent' });
  }

  /**
   * View: Project usage aggregate (includes Agent runs and Routing attempts,
   * with separate work-model and routing-model subtotals).
   */
  async getProjectUsage(projectId: string, filter: UsageAggregateFilter = {}): Promise<UsageAggregate> {
    return this.getAggregate({ ...filter, projectId, groupBy: filter.groupBy ?? 'task' });
  }

  /**
   * View: Agent usage aggregate (across Projects, does not absorb Routing attempts).
   */
  async getAgentUsage(agentId: string, filter: UsageAggregateFilter = {}): Promise<UsageAggregate> {
    return this.getAggregate({ ...filter, agentId, kind: 'agent_run', groupBy: filter.groupBy ?? 'project' });
  }

  /**
   * View: Model usage aggregate (attributes usage to model, separates work & routing).
   */
  async getModelUsage(model: string, filter: UsageAggregateFilter = {}): Promise<UsageAggregate> {
    return this.getAggregate({ ...filter, model, groupBy: filter.groupBy ?? 'project' });
  }
}
