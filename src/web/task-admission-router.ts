import type { ApiRequestContext, ApiRouter } from './router.ts';
import { TaskAdmissionError } from '../task/admission-service.ts';
import type { TaskAdmissionService } from '../task/admission-service.ts';
import { TaskAdvanceConflictError } from '../task/environment-lifecycle.ts';
import { TaskProposalError } from '../task/proposal-model.ts';
import { toTaskRunLinkView, toTaskView } from './views.ts';

function json(context: ApiRequestContext, status: number, body: unknown): boolean {
  context.response.writeHead(status, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify(body));
  return true;
}

/** Protected Human commands for proposal begin and attributed Task advances. */
export function createTaskAdmissionRouter(options: { readonly admissions: TaskAdmissionService }): ApiRouter {
  const { admissions } = options;
  return {
    name: 'task-admission',
    async handle(context) {
      const begin = context.method === 'POST' && context.segments.length === 4
        && context.segments[0] === 'api' && context.segments[1] === 'task-proposals' && context.segments[3] === 'begin';
      const advance = context.method === 'POST' && context.segments.length === 4
        && context.segments[0] === 'api' && context.segments[1] === 'tasks' && context.segments[3] === 'advances';
      if (!begin && !advance) return false;
      if (!context.operatorSessionId) return json(context, 401, { error: 'authentication required' });
      try {
        const body = await context.readBody();
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return json(context, 400, { code: 'invalid-command', error: 'a JSON command object is required' });
        }
        if (begin) {
          if (!isActor(body.lead) || !Number.isSafeInteger(body.expectedRevision)
            || typeof body.environmentInstanceId !== 'string'
            || (body.reason !== undefined && typeof body.reason !== 'string')) {
            return json(context, 400, { code: 'invalid-command', error: 'expectedRevision, environmentInstanceId, and lead are required; reason is optional' });
          }
          const result = await admissions.beginForHuman(context.segments[2] ?? '', {
            expectedRevision: body.expectedRevision as number,
            environmentInstanceId: body.environmentInstanceId,
            lead: body.lead,
            ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
          });
          return json(context, result.duplicate ? 200 : 201, {
            task: toTaskView(result.task),
            duplicate: result.duplicate,
            ...(result.initialRunId !== undefined ? { initialRunId: result.initialRunId } : {}),
            ...(result.initialRunFailed ? { initialRunFailed: true } : {}),
          });
        }
        if (typeof body.targetAgentId !== 'string' || typeof body.reason !== 'string'
          || (body.prompt !== undefined && typeof body.prompt !== 'string')) {
          return json(context, 400, { code: 'invalid-command', error: 'targetAgentId and reason are required' });
        }
        const result = await admissions.advanceForHuman(context.segments[2] ?? '', {
          targetAgentId: body.targetAgentId,
          reason: body.reason,
          ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
        });
        return json(context, 202, {
          task: toTaskView(result.task),
          runId: result.runId,
          advance: toTaskRunLinkView(result.audit),
        });
      } catch (error) {
        if (error instanceof TaskAdvanceConflictError) {
          return json(context, 409, { code: error.code, error: error.message });
        }
        if (error instanceof TaskProposalError) {
          const status = error.code.startsWith('unknown-') ? 404 : error.code === 'invalid-content' ? 400
            : ['membership-required', 'authority-required'].includes(error.code) ? 403 : 409;
          return json(context, status, { code: error.code, error: error.message });
        }
        if (error instanceof TaskAdmissionError) {
          const status = error.code === 'invalid-command' ? 400
            : error.code === 'task-not-admitted' ? 404 : error.code === 'advance-forbidden' ? 403 : 409;
          return json(context, status, { code: error.code, error: error.message });
        }
        return json(context, 500, { error: 'the request could not be completed' });
      }
    },
  };
}

function isActor(value: unknown): value is { readonly memberId: string; readonly memberKind: 'human' | 'agent' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actor = value as Record<string, unknown>;
  return typeof actor.memberId === 'string' && (actor.memberKind === 'human' || actor.memberKind === 'agent');
}
