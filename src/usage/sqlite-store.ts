/**
 * SQLite implementation of UsageStore (ADR-0010, #105).
 *
 * Implements durable, append-only usage activities and observations in SQLite.
 * Never overwrites prior observations; delayed observations and corrections
 * mark previous observations superseded and preserve complete history.
 */

import type { DatabaseSync } from 'node:sqlite';

import type {
  UsageActivity,
  UsageActivityKind,
  UsageActivityStatus,
  UsageObservation,
  UsageAggregate,
  MeasurementCompleteness,
  BilledCostStatus,
  ApiEquivalentCostStatus,
  ValuationProvenance,
  BillingBasis,
  DetailedTokenDimensions,
} from './model.ts';
import { aggregateObservations } from './model.ts';
import type {
  UsageActivityFilter,
  UsageAggregateFilter,
  UsageStore,
} from './store.ts';

interface ActivityRow {
  readonly id: string;
  readonly kind: string;
  readonly run_id: string | null;
  readonly attempt_id: string | null;
  readonly batch_id: string | null;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly agent_id: string | null;
  readonly environment_instance_id: string | null;
  readonly engine: string;
  readonly model: string;
  readonly status: string;
  readonly created_at: number;
  readonly settled_at: number | null;
  readonly wall_duration_ms: number | null;
}

interface ObservationRow {
  readonly id: string;
  readonly activity_id: string;
  readonly observed_at: number;
  readonly source: string;
  readonly source_version: string;
  readonly completeness: string;
  readonly input_tokens: number | null;
  readonly uncached_input_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cache_write_input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly reasoning_output_tokens: number | null;
  readonly total_tokens: number | null;
  readonly wall_duration_ms: number;
  readonly engine_turn_duration_ms: number | null;
  readonly billed_cost_status: string;
  readonly billed_usd_micros: number | null;
  readonly billed_reason: string | null;
  readonly cost_estimate_status: string;
  readonly cost_estimate_usd_micros: number | null;
  readonly valuation_provenance: string | null;
  readonly price_source: string | null;
  readonly price_source_version: string | null;
  readonly price_dimensions: string | null;
  readonly valued_at: number | null;
  readonly cost_estimate_reason: string | null;
  readonly billing_basis: string;
  readonly supersedes_observation_id: string | null;
  readonly superseded_at: number | null;
  readonly supersession_reason: string | null;
  readonly is_effective: number;
}

function toActivity(row: ActivityRow): UsageActivity {
  return {
    id: row.id,
    kind: row.kind as UsageActivityKind,
    correlation: {
      ...(row.run_id !== null ? { runId: row.run_id } : {}),
      ...(row.attempt_id !== null ? { attemptId: row.attempt_id } : {}),
      ...(row.batch_id !== null ? { batchId: row.batch_id } : {}),
      ...(row.project_id !== null ? { projectId: row.project_id } : {}),
      ...(row.task_id !== null ? { taskId: row.task_id } : {}),
      ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
      ...(row.environment_instance_id !== null ? { environmentInstanceId: row.environment_instance_id } : {}),
    },
    engine: row.engine,
    model: row.model,
    status: row.status as UsageActivityStatus,
    createdAt: row.created_at,
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
    ...(row.wall_duration_ms !== null ? { wallDurationMs: row.wall_duration_ms } : {}),
  };
}

function toObservation(row: ObservationRow): UsageObservation {
  const hasTokens =
    row.input_tokens !== null ||
    row.uncached_input_tokens !== null ||
    row.cached_input_tokens !== null ||
    row.cache_write_input_tokens !== null ||
    row.output_tokens !== null ||
    row.reasoning_output_tokens !== null ||
    row.total_tokens !== null;

  let tokens: DetailedTokenDimensions | undefined;
  if (hasTokens) {
    tokens = {
      ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
      ...(row.uncached_input_tokens !== null ? { uncachedInputTokens: row.uncached_input_tokens } : {}),
      ...(row.cached_input_tokens !== null ? { cachedInputTokens: row.cached_input_tokens } : {}),
      ...(row.cache_write_input_tokens !== null ? { cacheWriteInputTokens: row.cache_write_input_tokens } : {}),
      ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
      ...(row.reasoning_output_tokens !== null ? { reasoningOutputTokens: row.reasoning_output_tokens } : {}),
      ...(row.total_tokens !== null ? { totalTokens: row.total_tokens } : {}),
    };
  }

  let priceDimensions: Record<string, unknown> | undefined;
  if (row.price_dimensions !== null) {
    try {
      priceDimensions = JSON.parse(row.price_dimensions) as Record<string, unknown>;
    } catch {
      priceDimensions = undefined;
    }
  }

  return {
    id: row.id,
    activityId: row.activity_id,
    observedAt: row.observed_at,
    source: row.source,
    sourceVersion: row.source_version,
    completeness: row.completeness as MeasurementCompleteness,
    ...(tokens !== undefined ? { tokens } : {}),
    durations: {
      sproutWallDurationMs: row.wall_duration_ms,
      ...(row.engine_turn_duration_ms !== null ? { engineTurnDurationMs: row.engine_turn_duration_ms } : {}),
    },
    billedCost: {
      status: row.billed_cost_status as BilledCostStatus,
      currency: 'USD',
      ...(row.billed_usd_micros !== null ? { billedUsdMicros: row.billed_usd_micros } : {}),
      ...(row.billed_reason !== null ? { reason: row.billed_reason } : {}),
    },
    costEstimate: {
      status: row.cost_estimate_status as ApiEquivalentCostStatus,
      currency: 'USD',
      ...(row.cost_estimate_usd_micros !== null ? { apiEquivalentUsdMicros: row.cost_estimate_usd_micros } : {}),
      ...(row.valuation_provenance !== null ? { valuationProvenance: row.valuation_provenance as ValuationProvenance } : {}),
      ...(row.price_source !== null ? { priceSource: row.price_source } : {}),
      ...(row.price_source_version !== null ? { priceSourceVersion: row.price_source_version } : {}),
      ...(priceDimensions !== undefined ? { priceDimensions } : {}),
      ...(row.valued_at !== null ? { valuedAt: row.valued_at } : {}),
      ...(row.cost_estimate_reason !== null ? { reason: row.cost_estimate_reason } : {}),
    },
    billingBasis: row.billing_basis as BillingBasis,
    ...(row.supersedes_observation_id !== null ? { supersedesObservationId: row.supersedes_observation_id } : {}),
    ...(row.superseded_at !== null ? { supersededAt: row.superseded_at } : {}),
    ...(row.supersession_reason !== null ? { supersessionReason: row.supersession_reason } : {}),
    isEffective: row.is_effective === 1,
  };
}

export interface SqliteUsageStoreOptions {
  readonly db: DatabaseSync;
}

export class SqliteUsageStore implements UsageStore {
  readonly #db: DatabaseSync;

  constructor(options: SqliteUsageStoreOptions) {
    this.#db = options.db;
    this.#init();
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS usage_activities (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        run_id TEXT,
        attempt_id TEXT,
        batch_id TEXT,
        project_id TEXT,
        task_id TEXT,
        agent_id TEXT,
        environment_instance_id TEXT,
        engine TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        wall_duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS usage_activities_kind_idx ON usage_activities (kind);
      CREATE INDEX IF NOT EXISTS usage_activities_run_id_idx ON usage_activities (run_id);
      CREATE INDEX IF NOT EXISTS usage_activities_attempt_id_idx ON usage_activities (attempt_id);
      CREATE INDEX IF NOT EXISTS usage_activities_project_id_idx ON usage_activities (project_id);
      CREATE INDEX IF NOT EXISTS usage_activities_task_id_idx ON usage_activities (task_id);
      CREATE INDEX IF NOT EXISTS usage_activities_agent_id_idx ON usage_activities (agent_id);
      CREATE INDEX IF NOT EXISTS usage_activities_model_idx ON usage_activities (model);
      CREATE INDEX IF NOT EXISTS usage_activities_settled_at_idx ON usage_activities (settled_at);

      CREATE TABLE IF NOT EXISTS usage_observations (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        source_version TEXT NOT NULL,
        completeness TEXT NOT NULL,
        input_tokens INTEGER,
        uncached_input_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_output_tokens INTEGER,
        total_tokens INTEGER,
        wall_duration_ms INTEGER NOT NULL,
        engine_turn_duration_ms INTEGER,
        billed_cost_status TEXT NOT NULL,
        billed_usd_micros INTEGER,
        billed_reason TEXT,
        cost_estimate_status TEXT NOT NULL,
        cost_estimate_usd_micros INTEGER,
        valuation_provenance TEXT,
        price_source TEXT,
        price_source_version TEXT,
        price_dimensions TEXT,
        valued_at INTEGER,
        cost_estimate_reason TEXT,
        billing_basis TEXT NOT NULL,
        supersedes_observation_id TEXT,
        superseded_at INTEGER,
        supersession_reason TEXT,
        is_effective INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS usage_observations_activity_idx ON usage_observations (activity_id);
      CREATE INDEX IF NOT EXISTS usage_observations_effective_idx ON usage_observations (activity_id, is_effective);
    `);
  }

  async recordActivity(activity: UsageActivity): Promise<void> {
    const stmt = this.#db.prepare(`
      INSERT INTO usage_activities
        (id, kind, run_id, attempt_id, batch_id, project_id, task_id, agent_id,
         environment_instance_id, engine, model, status, created_at, settled_at, wall_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        run_id = excluded.run_id,
        attempt_id = excluded.attempt_id,
        batch_id = excluded.batch_id,
        project_id = excluded.project_id,
        task_id = excluded.task_id,
        agent_id = excluded.agent_id,
        environment_instance_id = excluded.environment_instance_id,
        engine = excluded.engine,
        model = excluded.model,
        status = excluded.status,
        created_at = excluded.created_at,
        settled_at = excluded.settled_at,
        wall_duration_ms = excluded.wall_duration_ms
    `);

    stmt.run(
      activity.id,
      activity.kind,
      activity.correlation.runId ?? null,
      activity.correlation.attemptId ?? null,
      activity.correlation.batchId ?? null,
      activity.correlation.projectId ?? null,
      activity.correlation.taskId ?? null,
      activity.correlation.agentId ?? null,
      activity.correlation.environmentInstanceId ?? null,
      activity.engine,
      activity.model,
      activity.status,
      activity.createdAt,
      activity.settledAt ?? null,
      activity.wallDurationMs ?? null,
    );
  }

  async getActivity(id: string): Promise<UsageActivity | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM usage_activities WHERE id = ?')
      .get(id) as unknown as ActivityRow | undefined;
    return row ? toActivity(row) : undefined;
  }

  async getActivityByRunId(runId: string): Promise<UsageActivity | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM usage_activities WHERE run_id = ? LIMIT 1')
      .get(runId) as unknown as ActivityRow | undefined;
    return row ? toActivity(row) : undefined;
  }

  async getActivityByAttemptId(attemptId: string): Promise<UsageActivity | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM usage_activities WHERE attempt_id = ? LIMIT 1')
      .get(attemptId) as unknown as ActivityRow | undefined;
    return row ? toActivity(row) : undefined;
  }

  async listActivities(filter: UsageActivityFilter = {}): Promise<readonly UsageActivity[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.kind !== undefined) {
      conditions.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.runId !== undefined) {
      conditions.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.attemptId !== undefined) {
      conditions.push('attempt_id = ?');
      params.push(filter.attemptId);
    }
    if (filter.batchId !== undefined) {
      conditions.push('batch_id = ?');
      params.push(filter.batchId);
    }
    if (filter.projectId !== undefined) {
      conditions.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.taskId !== undefined) {
      conditions.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.agentId !== undefined) {
      conditions.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.model !== undefined) {
      conditions.push('model = ?');
      params.push(filter.model);
    }
    if (filter.status !== undefined) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.provisional === true) {
      conditions.push("status = 'active'");
    } else if (filter.provisional === false) {
      conditions.push("status != 'active'");
    }
    if (filter.from !== undefined) {
      conditions.push('(settled_at >= ? OR (settled_at IS NULL AND created_at >= ?))');
      params.push(filter.from, filter.from);
    }
    if (filter.to !== undefined) {
      conditions.push('(settled_at < ? OR (settled_at IS NULL AND created_at < ?))');
      params.push(filter.to, filter.to);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT * FROM usage_activities ${whereClause} ORDER BY created_at ASC, id ASC`;

    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    }

    const rows = this.#db.prepare(sql).all(...params) as unknown as readonly ActivityRow[];
    return rows.map(toActivity);
  }

  async recordObservation(observation: UsageObservation): Promise<void> {
    // No await inside the savepoint: checking the head, selecting its successor,
    // and inserting are one atomic write, including when callers race.
    this.#db.exec('SAVEPOINT usage_observation_record');
    try {
      if (observation.isEffective) {
        const head = this.#db.prepare(
          'SELECT id FROM usage_observations WHERE activity_id = ? AND is_effective = 1',
        ).get(observation.activityId) as { id: string } | undefined;
        if (head?.id !== observation.supersedesObservationId) {
          throw new Error('Cannot supersede a stale observation; use the current effective head');
        }
      }
      if (observation.supersedesObservationId !== undefined) {
        this.#db
          .prepare(`
            UPDATE usage_observations
               SET is_effective = 0,
                   superseded_at = ?
             WHERE id = ? AND activity_id = ?
          `)
          .run(
            observation.observedAt,
            observation.supersedesObservationId,
            observation.activityId,
          );
      }

      const tokens = observation.tokens;
      const priceDims =
        observation.costEstimate.priceDimensions !== undefined
          ? JSON.stringify(observation.costEstimate.priceDimensions)
          : null;

      this.#db
        .prepare(`
          INSERT INTO usage_observations
            (id, activity_id, observed_at, source, source_version, completeness,
             input_tokens, uncached_input_tokens, cached_input_tokens, cache_write_input_tokens,
             output_tokens, reasoning_output_tokens, total_tokens, wall_duration_ms,
             engine_turn_duration_ms, billed_cost_status, billed_usd_micros, billed_reason,
             cost_estimate_status, cost_estimate_usd_micros, valuation_provenance,
             price_source, price_source_version, price_dimensions, valued_at,
             cost_estimate_reason, billing_basis, supersedes_observation_id,
             superseded_at, supersession_reason, is_effective)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          observation.id,
          observation.activityId,
          observation.observedAt,
          observation.source,
          observation.sourceVersion,
          observation.completeness,
          tokens?.inputTokens ?? null,
          tokens?.uncachedInputTokens ?? null,
          tokens?.cachedInputTokens ?? null,
          tokens?.cacheWriteInputTokens ?? null,
          tokens?.outputTokens ?? null,
          tokens?.reasoningOutputTokens ?? null,
          tokens?.totalTokens ?? null,
          observation.durations.sproutWallDurationMs,
          observation.durations.engineTurnDurationMs ?? null,
          observation.billedCost.status,
          observation.billedCost.billedUsdMicros ?? null,
          observation.billedCost.reason ?? null,
          observation.costEstimate.status,
          observation.costEstimate.apiEquivalentUsdMicros ?? null,
          observation.costEstimate.valuationProvenance ?? null,
          observation.costEstimate.priceSource ?? null,
          observation.costEstimate.priceSourceVersion ?? null,
          priceDims,
          observation.costEstimate.valuedAt ?? null,
          observation.costEstimate.reason ?? null,
          observation.billingBasis,
          observation.supersedesObservationId ?? null,
          observation.supersededAt ?? null,
          observation.supersessionReason ?? null,
          observation.isEffective ? 1 : 0,
        );
      this.#db.exec('RELEASE usage_observation_record');
    } catch (error) {
      this.#db.exec('ROLLBACK TO usage_observation_record; RELEASE usage_observation_record');
      throw error;
    }
  }

  async getObservation(id: string): Promise<UsageObservation | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM usage_observations WHERE id = ?')
      .get(id) as unknown as ObservationRow | undefined;
    return row ? toObservation(row) : undefined;
  }

  async getEffectiveObservation(activityId: string): Promise<UsageObservation | undefined> {
    const row = this.#db
      .prepare(`
        SELECT * FROM usage_observations
         WHERE activity_id = ? AND is_effective = 1
         ORDER BY observed_at DESC, id DESC
         LIMIT 1
      `)
      .get(activityId) as unknown as ObservationRow | undefined;
    return row ? toObservation(row) : undefined;
  }

  async listObservations(activityId: string): Promise<readonly UsageObservation[]> {
    const rows = this.#db
      .prepare(`
        SELECT * FROM usage_observations
         WHERE activity_id = ?
         ORDER BY observed_at ASC, rowid ASC
      `)
      .all(activityId) as unknown as readonly ObservationRow[];
    return rows.map(toObservation);
  }

  async getAggregate(filter: UsageAggregateFilter = {}): Promise<UsageAggregate> {
    // 1. Finalized activities (default unless provisional requested)
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

    // Subtotals: work model vs routing model
    const workItems = items.filter((i) => i.activity.kind === 'agent_run');
    const routingItems = items.filter((i) => i.activity.kind === 'routing_attempt');
    const workModelSubtotal = aggregateObservations(workItems);
    const routingModelSubtotal = aggregateObservations(routingItems);

    // Groups if requested
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
        let list = grouped.get(effectiveKey);
        if (!list) {
          list = [];
          grouped.set(effectiveKey, list);
        }
        list.push(item);
      }
      for (const [key, list] of grouped) {
        groups[key] = aggregateObservations(list);
      }
    }

    // Provisional activities
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
