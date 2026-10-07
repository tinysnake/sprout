/**
 * Usage and cost observability HTTP router (ADR-0010, #105).
 *
 * Implements additive domain routes for:
 * - GET /api/usage/activities
 * - GET /api/usage/activities/:id
 * Human HTTP is read-only; trusted adapters/reconciliation append corrections
 * through UsageService with source, reason, and current-head supersession.
 * - GET /api/usage/aggregate (and /api/usage/summary)
 * - GET /api/usage/runs/:runId
 * - GET /api/usage/attempts/:attemptId
 * - GET /api/usage/tasks/:taskId
 * - GET /api/usage/projects/:projectId
 * - GET /api/usage/agents/:agentId
 * - GET /api/usage/models/:model
 *
 * Privacy boundary: serializes only neutral identifiers, token dimensions,
 * Sprout wall duration, and integer USD micros. Excludes credentials, host
 * paths, private IP addresses, raw prompts, and raw reasoning.
 */

import type { ApiRequestContext, ApiRouter } from './router.ts';
import { redactSensitiveText } from '../environment/privacy.ts';
import type { UsageService } from '../usage/service.ts';
import type { UsageAggregate } from '../usage/model.ts';
import type { UsageActivityFilter, UsageAggregateFilter } from '../usage/store.ts';

export interface UsageRouterOptions {
  readonly usage: UsageService;
}

const TOKEN_DIMENSION_FIELDS = [
  'inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
  'outputTokens', 'reasoningOutputTokens', 'totalTokens',
] as const;
const TOKEN_COVERAGE_FIELDS = ['complete', 'partial', 'unavailable'] as const;
const COST_COVERAGE_FIELDS = ['available', 'pending', 'unavailable'] as const;
const COST_PROVENANCE_FIELDS = ['provider_estimated', 'harness_calculated', 'locally_estimated'] as const;
type Serializer = (value: unknown, ancestors: ReadonlySet<object>) => unknown;
type Schema = Readonly<Record<string, Serializer>>;
type UsagePayloadSchema = 'aggregate' | 'activityList' | 'detail' | 'observation' | 'error';

/** NFKC alone does not remove joiners/other invisible formatting characters. */
function normalizeUsageKey(key: string): string {
  return key.normalize('NFKC').replace(/\p{Cf}/gu, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only declared, canonical own properties can cross this transport boundary. */
function projectObject(value: unknown, schema: Schema, ancestors: ReadonlySet<object>): unknown {
  if (!isRecord(value) || ancestors.has(value) || ancestors.size >= 32) return undefined;
  const next = new Set(ancestors).add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const normalized = normalizeUsageKey(key);
    // Compare only normalized keys, then refuse aliases rather than accepting
    // ambiguous facts or forwarding unknown objects through a generic fallback.
    if (!Object.hasOwn(schema, normalized) || key !== normalized) continue;
    const projected = schema[normalized]!(value[key], next);
    if (projected !== undefined) result[normalized] = projected;
  }
  return result;
}

const object = (schema: Schema): Serializer => (value, ancestors) => projectObject(value, schema, ancestors);
const identifier: Serializer = (value) => typeof value === 'string' ? value : undefined;
const text: Serializer = (value) => typeof value === 'string' ? redactSensitiveText(value) : undefined;
const integer: Serializer = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const instant: Serializer = (value) => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
const decimal: Serializer = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const boolean: Serializer = (value) => typeof value === 'boolean' ? value : undefined;
const enumeration = (...values: string[]): Serializer => (value) => typeof value === 'string' && values.includes(value) ? value : undefined;
const numbers = (fields: readonly string[]): Schema => Object.fromEntries(fields.map((field) => [field, integer]));
const list = (item: Serializer): Serializer => (value, ancestors) => {
  if (!Array.isArray(value) || ancestors.has(value) || ancestors.size >= 32) return undefined;
  const next = new Set(ancestors).add(value);
  return value.map((entry) => item(entry, next)).filter((entry) => entry !== undefined);
};

const TOKEN_SCHEMA: Schema = {
  ...numbers(TOKEN_DIMENSION_FIELDS),
  status: enumeration('complete', 'observed_incomplete', 'unavailable'),
};
const BILLED_COST_SCHEMA: Schema = {
  status: enumeration('available', 'unavailable'), currency: enumeration('USD'), billedUsdMicros: integer, reason: text,
};
const COST_SCHEMA: Schema = {
  apiEquivalentUsdMicros: integer, status: enumeration('single_provenance', 'mixed_provenance', 'unavailable'),
  byProvenance: object(numbers(COST_PROVENANCE_FIELDS)),
};
const TIME_RANGE_SCHEMA: Schema = {
  from: instant, to: instant, timeZone: text, bounds: enumeration('[start, end)'), attribution: enumeration('settlement'),
};
const WORK_CORRELATION_SCHEMA: Schema = {
  runId: identifier, projectId: identifier, taskId: identifier, agentId: identifier,
  environmentInstanceId: identifier,
  executionMode: enumeration('environment-hosted', 'host-run'),
};
const ROUTING_CORRELATION_SCHEMA: Schema = { attemptId: identifier, batchId: identifier, projectId: identifier };
const ACTIVITY_STATUS = enumeration('active', 'completed', 'failed', 'interrupted', 'stopped');
const IDENTITY_SCHEMA: Schema = {
  activityId: identifier, kind: enumeration('agent_run', 'routing_attempt'),
  model: identifier, status: ACTIVITY_STATUS, createdAt: instant, settledAt: instant,
};
const identity: Serializer = (value, ancestors) => {
  if (!isRecord(value)) return undefined;
  const correlation = value.kind === 'routing_attempt' ? ROUTING_CORRELATION_SCHEMA
    : value.kind === 'agent_run' ? WORK_CORRELATION_SCHEMA : {};
  // Environment is an activity-detail link, not an aggregate identity field.
  const { environmentInstanceId: _environment, ...aggregateCorrelation } = correlation;
  return projectObject(value, { ...IDENTITY_SCHEMA, ...aggregateCorrelation }, ancestors);
};
const activity: Serializer = (value, ancestors) => {
  if (!isRecord(value)) return undefined;
  const correlation = value.kind === 'routing_attempt' ? ROUTING_CORRELATION_SCHEMA
    : value.kind === 'agent_run' ? WORK_CORRELATION_SCHEMA : {};
  return projectObject(value, {
    id: identifier, kind: enumeration('agent_run', 'routing_attempt'), correlation: object(correlation),
    engine: identifier, model: identifier, status: ACTIVITY_STATUS, createdAt: instant, settledAt: instant, wallDurationMs: integer,
  }, ancestors);
};

const aggregate: Serializer = (value, ancestors) => projectObject(value, AGGREGATE_SCHEMA, ancestors);
const groups: Serializer = (value, ancestors) => {
  if (!isRecord(value) || ancestors.has(value) || ancestors.size >= 32) return undefined;
  const result: Record<string, unknown> = Object.create(null);
  const next = new Set(ancestors).add(value);
  // Group names are dynamic domain identifiers; each value must still be an
  // aggregate, never an arbitrary object. Keys cannot change object prototypes.
  for (const key of Object.keys(value)) {
    const normalized = normalizeUsageKey(key);
    if (key !== normalized || ['__proto__', 'constructor', 'prototype'].includes(normalized.toLowerCase())) continue;
    const entry = value[key];
    if (!isRecord(entry) || !Object.hasOwn(entry, 'totalActivities') || integer(entry.totalActivities, next) === undefined) continue;
    const projected = aggregate(entry, next);
    if (projected !== undefined) result[normalized] = projected;
  }
  return result;
};
const AGGREGATE_SCHEMA = {
  totalActivities: integer, tokenCoverage: object(numbers(TOKEN_COVERAGE_FIELDS)),
  costCoverage: object(numbers(COST_COVERAGE_FIELDS)), tokens: object(TOKEN_SCHEMA), cost: object(COST_SCHEMA),
  billedCost: object(BILLED_COST_SCHEMA), totalSproutWallDurationMs: integer, activityIdentities: list(identity),
  timeRange: object(TIME_RANGE_SCHEMA), workModelSubtotal: aggregate, routingModelSubtotal: aggregate,
  provisionalTotals: aggregate, groups,
} satisfies Record<keyof UsageAggregate, Serializer>;

// Both established valuation adapters have declared price dimensions. Unknown
// provider metadata is internal evidence and cannot become browser prose.
const PRICE_DIMENSIONS_SCHEMA: Schema = {
  model: identifier, route: text, serviceTier: text, ...numbers(TOKEN_DIMENSION_FIELDS),
  rates: object({ inputMicrosPerToken: decimal, cachedInputMicrosPerToken: decimal, outputMicrosPerToken: decimal }),
  input: decimal, output: decimal, cacheRead: decimal, cacheWrite: decimal, total: decimal,
};
const OBSERVATION_SCHEMA: Schema = {
  id: identifier, activityId: identifier, observedAt: instant, source: text, sourceVersion: text,
  completeness: enumeration('complete', 'partial', 'unavailable'), tokens: object(numbers(TOKEN_DIMENSION_FIELDS)),
  durations: object({ sproutWallDurationMs: integer, engineTurnDurationMs: integer }), billedCost: object(BILLED_COST_SCHEMA),
  costEstimate: object({
    status: enumeration('available', 'pending', 'unavailable'), currency: enumeration('USD'), apiEquivalentUsdMicros: integer,
    valuationProvenance: enumeration(...COST_PROVENANCE_FIELDS), priceSource: text, priceSourceVersion: text,
    priceDimensions: object(PRICE_DIMENSIONS_SCHEMA), valuedAt: instant, reason: text,
  }),
  billingBasis: enumeration('metered_api', 'subscription_included', 'unknown'), supersedesObservationId: identifier,
  supersededAt: instant, supersessionReason: text, isEffective: boolean,
};
const PAYLOAD_SCHEMAS: Record<UsagePayloadSchema, Schema> = {
  aggregate: AGGREGATE_SCHEMA,
  activityList: { activities: list(activity) },
  detail: {
    activity, effectiveObservation: object(OBSERVATION_SCHEMA), observations: list(object(OBSERVATION_SCHEMA)),
    supersessionHistory: list(object({ observationId: identifier, supersedesObservationId: identifier, observedAt: instant, reason: text })),
  },
  observation: OBSERVATION_SCHEMA,
  error: { error: text },
};

/** Closed-world projection; unknown properties are dropped without traversal. */
export function sanitizeUsagePayload<T>(value: T, schema: UsagePayloadSchema = 'observation'): T {
  return (projectObject(value, PAYLOAD_SCHEMAS[schema], new Set()) ?? {}) as T;
}

function json(context: ApiRequestContext, status: number, body: unknown, schema: UsagePayloadSchema = 'error'): boolean {
  context.response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  context.response.end(JSON.stringify(sanitizeUsagePayload(body, schema)));
  return true;
}

interface ParsedUsageFilters {
  readonly activity: UsageActivityFilter;
  readonly aggregate: UsageAggregateFilter;
  readonly error?: string | undefined;
}

function parseUsageFilters(searchParams: URLSearchParams): ParsedUsageFilters {
  const filters: Record<string, string | number | boolean> = {};
  const kind = searchParams.get('kind');
  if (kind !== null) {
    if (kind !== 'agent_run' && kind !== 'routing_attempt') return { activity: {}, aggregate: {}, error: 'invalid kind' };
    filters.kind = kind;
  }
  const status = searchParams.get('status');
  if (status !== null) {
    if (!['active', 'completed', 'failed', 'interrupted', 'stopped'].includes(status)) {
      return { activity: {}, aggregate: {}, error: 'invalid status' };
    }
    filters.status = status;
  }
  for (const key of ['runId', 'attemptId', 'batchId', 'projectId', 'taskId', 'agentId', 'model'] as const) {
    const value = searchParams.get(key);
    if (value !== null && value.length > 0) filters[key] = value;
  }
  const provisional = searchParams.get('provisional');
  if (provisional !== null) {
    if (provisional !== 'true' && provisional !== 'false') return { activity: {}, aggregate: {}, error: 'invalid provisional flag' };
    filters.provisional = provisional === 'true';
  }
  for (const key of ['from', 'to'] as const) {
    const value = searchParams.get(key);
    if (value === null) continue;
    if (!/^-?\d+$/.test(value)) return { activity: {}, aggregate: {}, error: `invalid ${key} instant` };
    const instant = Number(value);
    if (!Number.isSafeInteger(instant)) return { activity: {}, aggregate: {}, error: `invalid ${key} instant` };
    filters[key] = instant;
  }
  const from = filters.from as number | undefined;
  const to = filters.to as number | undefined;
  if (from !== undefined && to !== undefined && from >= to) {
    return { activity: {}, aggregate: {}, error: 'time range must have from < to' };
  }
  const timeZone = searchParams.get('timeZone');
  if (timeZone !== null) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    } catch {
      return { activity: {}, aggregate: {}, error: 'invalid timeZone; expected an IANA time zone' };
    }
    filters.timeZone = timeZone;
  } else {
    filters.timeZone = 'UTC';
  }
  const limit = searchParams.get('limit');
  if (limit !== null) {
    if (!/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) > 500) {
      return { activity: {}, aggregate: {}, error: 'limit must be an integer from 0 to 500' };
    }
    filters.limit = Number(limit);
  }
  const offset = searchParams.get('offset');
  if (offset !== null) {
    if (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) {
      return { activity: {}, aggregate: {}, error: 'offset must be a non-negative integer' };
    }
    filters.offset = Number(offset);
  }
  const groupBy = searchParams.get('groupBy');
  if (groupBy !== null) {
    if (!['run', 'task', 'project', 'agent', 'model'].includes(groupBy)) {
      return { activity: {}, aggregate: {}, error: 'invalid groupBy' };
    }
    filters.groupBy = groupBy;
  }
  const aggregateFilters = Object.fromEntries(
    Object.entries(filters).filter(([key]) => key !== 'limit' && key !== 'offset'),
  );
  return {
    activity: filters as unknown as UsageActivityFilter,
    aggregate: aggregateFilters as unknown as UsageAggregateFilter,
  };
}

export function createUsageRouter(options: UsageRouterOptions): ApiRouter {
  const { usage } = options;

  return {
    name: 'usage-router',
    async handle(context: ApiRequestContext): Promise<boolean> {
      const { segments, method, searchParams } = context;

      // Mount prefix: /api/usage
      if (segments[0] !== 'api' || segments[1] !== 'usage') {
        return false;
      }

      const sub = segments[2];

      // 1. GET /api/usage/activities
      if (sub === 'activities' && segments.length === 3) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const filters = parseUsageFilters(searchParams);
        if (filters.error) return json(context, 400, { error: filters.error });
        const activities = await usage.listActivities(filters.activity);

        return json(context, 200, { activities }, 'activityList');
      }

      // 2. GET /api/usage/activities/:id
      if (sub === 'activities' && segments.length === 4) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const activityId = segments[3]!;
        const detail = await usage.getActivity(activityId);
        if (!detail) {
          return json(context, 404, { error: `usage activity not found: ${activityId}` });
        }
        return json(context, 200, detail, 'detail');
      }

      // ADR-0010 forbids Human measurement editing, including payloads claiming
      // provider provenance. Operator authentication is not producer authority.
      if (sub === 'activities' && segments[4] === 'observations' && segments.length === 5) {
        return json(context, 405, { error: 'usage observations are read-only on the Human HTTP surface' });
      }

      // 4. GET /api/usage/aggregate and GET /api/usage/summary
      if ((sub === 'aggregate' || sub === 'summary') && segments.length === 3) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const filters = parseUsageFilters(searchParams);
        if (filters.error) return json(context, 400, { error: filters.error });
        const aggregate = await usage.getAggregate(filters.aggregate);

        return json(context, 200, aggregate, 'aggregate');
      }

      // 5. GET /api/usage/runs/:runId
      if (sub === 'runs' && segments.length === 4) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const runId = segments[3]!;
        const detail = await usage.getRunUsage(runId);
        if (!detail) {
          return json(context, 404, { error: `usage for run not found: ${runId}` });
        }
        return json(context, 200, detail, 'detail');
      }

      // 6. GET /api/usage/attempts/:attemptId
      if (sub === 'attempts' && segments.length === 4) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const attemptId = segments[3]!;
        const detail = await usage.getActivityByAttemptId(attemptId);
        if (!detail) {
          return json(context, 404, { error: `usage for Routing attempt not found: ${attemptId}` });
        }
        return json(context, 200, detail, 'detail');
      }

      // 7. GET /api/usage/tasks/:taskId
      if (sub === 'tasks' && segments.length === 4) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const filters = parseUsageFilters(searchParams);
        if (filters.error) return json(context, 400, { error: filters.error });
        const taskId = segments[3]!;
        const aggregate = await usage.getTaskUsage(taskId, filters.aggregate);
        return json(context, 200, aggregate, 'aggregate');
      }

      // 8. GET /api/usage/projects/:projectId
      if (sub === 'projects' && segments.length === 4) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const filters = parseUsageFilters(searchParams);
        if (filters.error) return json(context, 400, { error: filters.error });
        const projectId = segments[3]!;
        const aggregate = await usage.getProjectUsage(projectId, filters.aggregate);
        return json(context, 200, aggregate, 'aggregate');
      }

      // 9. GET /api/usage/agents/:agentId
      if (sub === 'agents' && segments.length === 4) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const filters = parseUsageFilters(searchParams);
        if (filters.error) return json(context, 400, { error: filters.error });
        const agentId = segments[3]!;
        const aggregate = await usage.getAgentUsage(agentId, filters.aggregate);
        return json(context, 200, aggregate, 'aggregate');
      }

      // 10. GET /api/usage/models/:model
      if (sub === 'models' && segments.length === 4) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const filters = parseUsageFilters(searchParams);
        if (filters.error) return json(context, 400, { error: filters.error });
        const model = segments[3]!;
        const aggregate = await usage.getModelUsage(model, filters.aggregate);
        return json(context, 200, aggregate, 'aggregate');
      }

      return false;
    },
  };
}
