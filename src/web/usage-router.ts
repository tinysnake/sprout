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
import type { UsageActivityFilter, UsageAggregateFilter } from '../usage/store.ts';

export interface UsageRouterOptions {
  readonly usage: UsageService;
}

function json(context: ApiRequestContext, status: number, body: unknown): boolean {
  context.response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  context.response.end(JSON.stringify(sanitizeUsagePayload(body)));
  return true;
}

/** Sanitize sensitive values before transport export (privacy boundary). */
export function sanitizeUsagePayload<T>(value: T, keyName?: string): T {
  if (typeof value === 'string') {
    if (
      keyName === 'id' ||
      keyName === 'activityId' ||
      keyName === 'runId' ||
      keyName === 'attemptId' ||
      keyName === 'batchId' ||
      keyName === 'projectId' ||
      keyName === 'taskId' ||
      keyName === 'agentId' ||
      keyName === 'environmentInstanceId' ||
      keyName === 'supersedesObservationId' ||
      keyName === 'engine' ||
      keyName === 'model' ||
      keyName === 'status' ||
      keyName === 'kind' ||
      keyName === 'completeness' ||
      keyName === 'currency' ||
      keyName === 'valuationProvenance' ||
      keyName === 'billingBasis'
    ) {
      return value;
    }
    return redactSensitiveText(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUsagePayload(item)) as unknown as T;
  }
  if (typeof value === 'object' && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (/tokens?$/i.test(key) && !/secret|auth|access|session|bearer|cookie/i.test(key)) {
        sanitized[key] = sanitizeUsagePayload(val, key);
        continue;
      }
      if (/password|secret|token|credential|authorization/i.test(key)) {
        continue;
      }
      sanitized[key] = sanitizeUsagePayload(val, key);
    }
    return sanitized as T;
  }
  return value;
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

        return json(context, 200, { activities });
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
        return json(context, 200, detail);
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

        return json(context, 200, aggregate);
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
        return json(context, 200, detail);
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
        return json(context, 200, detail);
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
        return json(context, 200, aggregate);
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
        return json(context, 200, aggregate);
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
        return json(context, 200, aggregate);
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
        return json(context, 200, aggregate);
      }

      return false;
    },
  };
}
