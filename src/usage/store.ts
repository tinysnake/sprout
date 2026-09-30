/**
 * Usage storage interface (ADR-0010, #105).
 *
 * Defines durable persistence boundaries for usage activities, append-only
 * observations, delayed observations, corrections, and coverage-aware aggregates.
 */

import type {
  UsageActivity,
  UsageActivityKind,
  UsageActivityStatus,
  UsageObservation,
  UsageAggregate,
} from './model.ts';
import { aggregateObservations } from './model.ts';

export interface UsageActivityFilter {
  readonly kind?: UsageActivityKind | undefined;
  readonly runId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly batchId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly model?: string | undefined;
  readonly status?: UsageActivityStatus | undefined;
  /** True for in-progress (active) activities, false for finalized settled activities. */
  readonly provisional?: boolean | undefined;
  /** Inclusive lower bound for createdAt / settledAt (epoch ms). */
  readonly from?: number | undefined;
  /** Exclusive upper bound for createdAt / settledAt (epoch ms). */
  readonly to?: number | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface UsageAggregateFilter {
  readonly kind?: UsageActivityKind | undefined;
  readonly runId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly batchId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly model?: string | undefined;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly provisional?: boolean | undefined;
  readonly groupBy?: 'run' | 'task' | 'project' | 'agent' | 'model' | undefined;
}

export interface UsageStore {
  /** Record or update an activity (upsert on activity.id). */
  recordActivity(activity: UsageActivity): Promise<void>;

  /** Retrieve an activity by its unique identity. */
  getActivity(id: string): Promise<UsageActivity | undefined>;

  /** Find an activity correlated with an Agent run. */
  getActivityByRunId(runId: string): Promise<UsageActivity | undefined>;

  /** Find an activity correlated with a Routing attempt. */
  getActivityByAttemptId(attemptId: string): Promise<UsageActivity | undefined>;

  /** List activities matching the filter, ordered chronologically. */
  listActivities(filter?: UsageActivityFilter): Promise<readonly UsageActivity[]>;

  /**
   * Append a durable usage observation.
   *
   * If `supersedesObservationId` is set, marks that previous observation
   * superseded (`is_effective = 0`, `superseded_at = now`) while keeping all
   * its historical facts intact.
   */
  recordObservation(observation: UsageObservation): Promise<void>;

  /** Retrieve a specific observation by ID. */
  getObservation(id: string): Promise<UsageObservation | undefined>;

  /** Retrieve the currently effective observation for an activity. */
  getEffectiveObservation(activityId: string): Promise<UsageObservation | undefined>;

  /** Retrieve all observations and corrections for an activity in chronological order. */
  listObservations(activityId: string): Promise<readonly UsageObservation[]>;

  /** Compute coverage-aware aggregate across filtered activities and observations. */
  getAggregate(filter?: UsageAggregateFilter): Promise<UsageAggregate>;
}

/** In-memory adapter for testing and lightweight runtime composition. */
export class InMemoryUsageStore implements UsageStore {
  readonly #activities = new Map<string, UsageActivity>();
  readonly #observations = new Map<string, UsageObservation>();
  readonly #observationsByActivity = new Map<string, string[]>();

  async recordActivity(activity: UsageActivity): Promise<void> {
    this.#activities.set(activity.id, activity);
  }

  async getActivity(id: string): Promise<UsageActivity | undefined> {
    return this.#activities.get(id);
  }

  async getActivityByRunId(runId: string): Promise<UsageActivity | undefined> {
    for (const activity of this.#activities.values()) {
      if (activity.correlation.runId === runId) return activity;
    }
    return undefined;
  }

  async getActivityByAttemptId(attemptId: string): Promise<UsageActivity | undefined> {
    for (const activity of this.#activities.values()) {
      if (activity.correlation.attemptId === attemptId) return activity;
    }
    return undefined;
  }

  async listActivities(filter: UsageActivityFilter = {}): Promise<readonly UsageActivity[]> {
    let list = Array.from(this.#activities.values());

    if (filter.kind !== undefined) list = list.filter((a) => a.kind === filter.kind);
    if (filter.runId !== undefined) list = list.filter((a) => a.correlation.runId === filter.runId);
    if (filter.attemptId !== undefined) list = list.filter((a) => a.correlation.attemptId === filter.attemptId);
    if (filter.batchId !== undefined) list = list.filter((a) => a.correlation.batchId === filter.batchId);
    if (filter.projectId !== undefined) list = list.filter((a) => a.correlation.projectId === filter.projectId);
    if (filter.taskId !== undefined) list = list.filter((a) => a.correlation.taskId === filter.taskId);
    if (filter.agentId !== undefined) list = list.filter((a) => a.correlation.agentId === filter.agentId);
    if (filter.model !== undefined) list = list.filter((a) => a.model === filter.model);
    if (filter.status !== undefined) list = list.filter((a) => a.status === filter.status);
    if (filter.provisional === true) list = list.filter((a) => a.status === 'active');
    else if (filter.provisional === false) list = list.filter((a) => a.status !== 'active');
    if (filter.from !== undefined) {
      list = list.filter((a) => (a.settledAt ?? a.createdAt) >= filter.from!);
    }
    if (filter.to !== undefined) {
      list = list.filter((a) => (a.settledAt ?? a.createdAt) < filter.to!);
    }

    list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));

    if (filter.offset !== undefined) list = list.slice(filter.offset);
    if (filter.limit !== undefined) list = list.slice(0, filter.limit);

    return list;
  }

  async recordObservation(observation: UsageObservation): Promise<void> {
    if (this.#observations.has(observation.id)) throw new Error('Observation already exists');
    if (observation.isEffective) {
      const head = (this.#observationsByActivity.get(observation.activityId) ?? [])
        .map((id) => this.#observations.get(id)).find((obs) => obs?.isEffective);
      if (head?.id !== observation.supersedesObservationId) {
        throw new Error('Cannot supersede a stale observation; use the current effective head');
      }
    }
    if (observation.supersedesObservationId !== undefined) {
      const prior = this.#observations.get(observation.supersedesObservationId);
      if (prior) {
        this.#observations.set(prior.id, {
          ...prior,
          isEffective: false,
          supersededAt: observation.observedAt,
        });
      }
    }

    this.#observations.set(observation.id, observation);
    let ids = this.#observationsByActivity.get(observation.activityId);
    if (!ids) {
      ids = [];
      this.#observationsByActivity.set(observation.activityId, ids);
    }
    ids.push(observation.id);
  }

  async getObservation(id: string): Promise<UsageObservation | undefined> {
    return this.#observations.get(id);
  }

  async getEffectiveObservation(activityId: string): Promise<UsageObservation | undefined> {
    const ids = this.#observationsByActivity.get(activityId) ?? [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const obs = this.#observations.get(ids[i]!);
      if (obs && obs.isEffective) return obs;
    }
    return undefined;
  }

  async listObservations(activityId: string): Promise<readonly UsageObservation[]> {
    const ids = this.#observationsByActivity.get(activityId) ?? [];
    const list: UsageObservation[] = [];
    for (const id of ids) {
      const obs = this.#observations.get(id);
      if (obs) list.push(obs);
    }
    return list;
  }

  async getAggregate(filter: UsageAggregateFilter = {}): Promise<UsageAggregate> {
    const finalizedActivities = await this.listActivities({
      kind: filter.kind,
      runId: filter.runId,
      attemptId: filter.attemptId,
      batchId: filter.batchId,
      projectId: filter.projectId,
      taskId: filter.taskId,
      agentId: filter.agentId,
      model: filter.model,
      provisional: false,
      from: filter.from,
      to: filter.to,
    });

    const items: { activity: UsageActivity; observation?: UsageObservation | undefined }[] = [];
    for (const activity of finalizedActivities) {
      const observation = await this.getEffectiveObservation(activity.id);
      items.push({ activity, observation });
    }

    const overall = aggregateObservations(items);

    const workItems = items.filter((i) => i.activity.kind === 'agent_run');
    const routingItems = items.filter((i) => i.activity.kind === 'routing_attempt');
    const workModelSubtotal = aggregateObservations(workItems);
    const routingModelSubtotal = aggregateObservations(routingItems);

    let groups: Record<string, UsageAggregate> | undefined;
    if (filter.groupBy !== undefined) {
      groups = {};
      const grouped = new Map<string, { activity: UsageActivity; observation?: UsageObservation | undefined }[]>();
      for (const item of items) {
        let key: string | undefined;
        if (filter.groupBy === 'task') key = item.activity.correlation.taskId;
        else if (filter.groupBy === 'agent') key = item.activity.correlation.agentId;
        else if (filter.groupBy === 'project') key = item.activity.correlation.projectId;
        else if (filter.groupBy === 'model') key = item.activity.model;
        else if (filter.groupBy === 'run') key = item.activity.correlation.runId;

        const effectiveKey = key ?? '(none)';
        let groupList = grouped.get(effectiveKey);
        if (!groupList) {
          groupList = [];
          grouped.set(effectiveKey, groupList);
        }
        groupList.push(item);
      }
      for (const [key, groupList] of grouped) {
        groups[key] = aggregateObservations(groupList);
      }
    }

    const provisionalActivities = await this.listActivities({
      kind: filter.kind,
      runId: filter.runId,
      attemptId: filter.attemptId,
      batchId: filter.batchId,
      projectId: filter.projectId,
      taskId: filter.taskId,
      agentId: filter.agentId,
      model: filter.model,
      provisional: true,
      from: filter.from,
      to: filter.to,
    });
    const provisionalItems: { activity: UsageActivity; observation?: UsageObservation | undefined }[] = [];
    for (const activity of provisionalActivities) {
      const observation = await this.getEffectiveObservation(activity.id);
      provisionalItems.push({ activity, observation });
    }
    const provisionalTotals =
      provisionalItems.length > 0 ? aggregateObservations(provisionalItems) : undefined;

    return {
      ...overall,
      workModelSubtotal,
      routingModelSubtotal,
      ...(groups !== undefined ? { groups } : {}),
      ...(provisionalTotals !== undefined ? { provisionalTotals } : {}),
    };
  }
}
