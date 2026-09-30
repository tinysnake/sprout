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
    } else if (run.status === 'interrupted') {
      status = 'interrupted';
    } else {
      status = 'failed';
    }

    const wallDurationMs =
      run.completedAt !== undefined ? Math.max(0, run.completedAt - run.createdAt) : undefined;

    const activity: UsageActivity = {
      id: activityId,
      kind: 'agent_run',
      correlation: {
        runId: run.id,
        ...(run.taskId !== undefined ? { taskId: run.taskId } : {}),
        ...(run.projectId !== undefined ? { projectId: run.projectId } : {}),
        agentId: run.agentId,
        environmentInstanceId: run.environmentInstanceId,
      },
      engine: run.workOption?.engine ?? 'unknown',
      model: run.workOption?.workModel ?? 'unknown',
      status,
      createdAt: run.createdAt,
      ...(run.completedAt !== undefined ? { settledAt: run.completedAt } : {}),
      ...(wallDurationMs !== undefined ? { wallDurationMs } : {}),
    };

    await this.#store.recordActivity(activity);

    // If run is settled, record its initial observation if none exists yet
    if (run.completedAt !== undefined) {
      const existing = await this.#store.getEffectiveObservation(activityId);
      if (existing === undefined) {
        await this.#recordInitialRunObservation(activity, run, wallDurationMs ?? 0, now);
      }
    }

    return activity;
  }

  async #recordInitialRunObservation(
    activity: UsageActivity,
    run: AgentRun,
    wallDurationMs: number,
    now: number,
  ): Promise<void> {
    const engine = run.workOption?.engine ?? 'unknown';
    const model = run.workOption?.workModel ?? 'unknown';
    const result = run.result;

    const detailedTokens = run.detailedTokens ?? (
      run.tokenUsage !== undefined
        ? {
            inputTokens: run.tokenUsage.promptTokens,
            uncachedInputTokens: run.tokenUsage.promptTokens,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: run.tokenUsage.completionTokens,
            totalTokens: run.tokenUsage.totalTokens,
          }
        : undefined
    );

    let completeness: MeasurementCompleteness;
    if (detailedTokens !== undefined) {
      completeness = run.status === 'completed' ? 'complete' : 'partial';
    } else {
      completeness = 'unavailable';
    }

    let costEstimate: ApiEquivalentCostEstimate;
    if (result?.costEstimate !== undefined) {
      costEstimate = result.costEstimate;
    } else if (engine === 'codex' || engine === 'openai') {
      costEstimate = calculateLocalEstimate({
        engine,
        model,
        tokens: detailedTokens,
        valuedAt: now,
      });
    } else {
      costEstimate = defaultUnavailableCostEstimate(`no price calculation available for engine '${engine}'`);
    }

    const observation: UsageObservation = {
      id: `uobs_run_${run.id}_initial`,
      activityId: activity.id,
      observedAt: now,
      source: result?.source ?? `${engine}:turn`,
      sourceVersion: result?.sourceVersion ?? '1.0',
      completeness,
      ...(detailedTokens !== undefined ? { tokens: detailedTokens } : {}),
      durations: {
        sproutWallDurationMs: wallDurationMs,
        ...(result?.engineTurnDurationMs !== undefined ? { engineTurnDurationMs: result.engineTurnDurationMs } : {}),
      },
      billedCost: defaultUnavailableBilledCost(),
      costEstimate,
      billingBasis: result?.billingBasis ?? 'metered_api',
      isEffective: true,
    };

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
    const wallDurationMs =
      context.durationMs ?? Math.max(0, attempt.finishedAt - attempt.startedAt);

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
      settledAt: attempt.finishedAt,
      wallDurationMs,
    };

    await this.#store.recordActivity(activity);

    if (attempt.status !== 'started') {
      const existing = await this.#store.getEffectiveObservation(activityId);
      if (existing === undefined) {
        let completeness: MeasurementCompleteness;
        if (context.tokens !== undefined) {
          completeness = attempt.status === 'succeeded' ? 'complete' : 'partial';
        } else {
          completeness = 'unavailable';
        }

        const costEstimate =
          context.cost ?? defaultUnavailableCostEstimate('wake-model telemetry unavailable');

        const observation: UsageObservation = {
          id: `uobs_att_${attempt.id}_initial`,
          activityId: activity.id,
          observedAt: now,
          source: context.source ?? 'routing-model:judge',
          sourceVersion: context.sourceVersion ?? '1.0',
          completeness,
          ...(context.tokens !== undefined ? { tokens: context.tokens } : {}),
          durations: {
            sproutWallDurationMs: wallDurationMs,
          },
          billedCost: defaultUnavailableBilledCost('wake model does not supply attributable invoice facts'),
          costEstimate,
          billingBasis: context.billingBasis ?? 'unknown',
          isEffective: true,
        };

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
    const activity = await this.#store.getActivity(input.activityId);
    if (!activity) {
      throw new Error(`Usage activity not found: ${input.activityId}`);
    }

    const prior = await this.#store.getObservation(input.supersedesObservationId);
    if (!prior || prior.activityId !== input.activityId) {
      throw new Error(`Superseded observation not found for activity: ${input.supersedesObservationId}`);
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
  async getTaskUsage(taskId: string): Promise<UsageAggregate> {
    return this.getAggregate({ taskId, groupBy: 'agent' });
  }

  /**
   * View: Project usage aggregate (includes Agent runs and Routing attempts,
   * with separate work-model and routing-model subtotals).
   */
  async getProjectUsage(projectId: string): Promise<UsageAggregate> {
    return this.getAggregate({ projectId, groupBy: 'task' });
  }

  /**
   * View: Agent usage aggregate (across Projects, does not absorb Routing attempts).
   */
  async getAgentUsage(agentId: string): Promise<UsageAggregate> {
    return this.getAggregate({ agentId, kind: 'agent_run', groupBy: 'project' });
  }

  /**
   * View: Model usage aggregate (attributes usage to model, separates work & routing).
   */
  async getModelUsage(model: string): Promise<UsageAggregate> {
    return this.getAggregate({ model, groupBy: 'project' });
  }
}
