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
import type {
  UsageActivityKind,
  UsageActivityStatus,
} from '../usage/model.ts';

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
        const kind = searchParams.get('kind') as UsageActivityKind | null;
        const runId = searchParams.get('runId') ?? undefined;
        const attemptId = searchParams.get('attemptId') ?? undefined;
        const batchId = searchParams.get('batchId') ?? undefined;
        const projectId = searchParams.get('projectId') ?? undefined;
        const taskId = searchParams.get('taskId') ?? undefined;
        const agentId = searchParams.get('agentId') ?? undefined;
        const model = searchParams.get('model') ?? undefined;
        const status = searchParams.get('status') as UsageActivityStatus | null;
        const provisionalParam = searchParams.get('provisional');
        const provisional = provisionalParam !== null ? provisionalParam === 'true' : undefined;
        const fromParam = searchParams.get('from');
        const from = fromParam !== null ? Number(fromParam) : undefined;
        const toParam = searchParams.get('to');
        const to = toParam !== null ? Number(toParam) : undefined;
        const limitParam = searchParams.get('limit');
        const limit = limitParam !== null ? Number(limitParam) : undefined;
        const offsetParam = searchParams.get('offset');
        const offset = offsetParam !== null ? Number(offsetParam) : undefined;

        const activities = await usage.listActivities({
          ...(kind ? { kind } : {}),
          ...(runId ? { runId } : {}),
          ...(attemptId ? { attemptId } : {}),
          ...(batchId ? { batchId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(taskId ? { taskId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(model ? { model } : {}),
          ...(status ? { status } : {}),
          ...(provisional !== undefined ? { provisional } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        });

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
        const kind = searchParams.get('kind') as UsageActivityKind | null;
        const runId = searchParams.get('runId') ?? undefined;
        const attemptId = searchParams.get('attemptId') ?? undefined;
        const batchId = searchParams.get('batchId') ?? undefined;
        const projectId = searchParams.get('projectId') ?? undefined;
        const taskId = searchParams.get('taskId') ?? undefined;
        const agentId = searchParams.get('agentId') ?? undefined;
        const model = searchParams.get('model') ?? undefined;
        const groupBy = searchParams.get('groupBy') as 'run' | 'task' | 'project' | 'agent' | 'model' | null;
        const provisionalParam = searchParams.get('provisional');
        const provisional = provisionalParam !== null ? provisionalParam === 'true' : undefined;
        const fromParam = searchParams.get('from');
        const from = fromParam !== null ? Number(fromParam) : undefined;
        const toParam = searchParams.get('to');
        const to = toParam !== null ? Number(toParam) : undefined;

        const aggregate = await usage.getAggregate({
          ...(kind ? { kind } : {}),
          ...(runId ? { runId } : {}),
          ...(attemptId ? { attemptId } : {}),
          ...(batchId ? { batchId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(taskId ? { taskId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(model ? { model } : {}),
          ...(groupBy ? { groupBy } : {}),
          ...(provisional !== undefined ? { provisional } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
        });

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

      // 6. GET /api/usage/tasks/:taskId
      if (sub === 'tasks' && segments.length === 4) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const taskId = segments[3]!;
        const aggregate = await usage.getTaskUsage(taskId);
        return json(context, 200, aggregate);
      }

      // 7. GET /api/usage/projects/:projectId
      if (sub === 'projects' && segments.length === 4) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const projectId = segments[3]!;
        const aggregate = await usage.getProjectUsage(projectId);
        return json(context, 200, aggregate);
      }

      // 8. GET /api/usage/agents/:agentId
      if (sub === 'agents' && segments.length === 4) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const agentId = segments[3]!;
        const aggregate = await usage.getAgentUsage(agentId);
        return json(context, 200, aggregate);
      }

      // 9. GET /api/usage/models/:model
      if (sub === 'models' && segments.length === 4) {
        if (method !== 'GET') {
          return json(context, 405, { error: 'method not allowed' });
        }
        const model = segments[3]!;
        const aggregate = await usage.getModelUsage(model);
        return json(context, 200, aggregate);
      }

      return false;
    },
  };
}
