import { EnvironmentRecoveryError } from '../environment/recovery-service.ts';
import { TaskControlError, type TaskControlService } from '../task/control-service.ts';
import type { Task } from '../task/model.ts';
import { TaskProposalError } from '../task/proposal-model.ts';
import { TaskPauseRetryRequired, TaskRecoveryRefusal, TaskTerminalMutationError } from '../task/environment-lifecycle.ts';
import { toTaskView } from './views.ts';
import type { ApiRequestContext, ApiRouter } from './router.ts';

function json(context: ApiRequestContext, status: number, body: unknown): boolean {
  context.response.writeHead(status, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify(body));
  return true;
}

/** Protected Human intervention and validation commands for begun Tasks. */
export function createTaskControlRouter(options: {
  readonly controls: TaskControlService;
  /** Resolve Environment proof and decision history together with the Task holder. */
  readonly recover?: (taskId: string, input: { action: 'resume' | 'discard'; reason: string }) => Promise<Task>;
}): ApiRouter {
  const { controls } = options;
  return {
    name: 'task-controls',
    async handle(context) {
      if (context.method !== 'POST' || context.segments.length !== 4
        || context.segments[0] !== 'api' || context.segments[1] !== 'tasks') return false;
      const action = context.segments[3] ?? '';
      const supported = new Set(['content', 'pause', 'interrupt', 'resume', 'cancel-pause', 'subordinate-stop', 'blockers', 'clear-blocker', 'completion-claims', 'validation', 'end', 'discard', 'recovery']);
      if (!supported.has(action)) return false;
      if (!context.operatorSessionId) return json(context, 401, { error: 'authentication required' });
      try {
        const body = await context.readBody();
        const taskId = context.segments[2] ?? '';
        if (!isRecord(body)) return json(context, 400, { code: 'invalid-command', error: 'a JSON command object is required' });
        let task: Task | undefined;
        switch (action) {
          case 'content':
            if (!onlyKeys(body, ['expectedContentVersion', 'content', 'reason'])
              || typeof body.expectedContentVersion !== 'number' || typeof body.reason !== 'string') {
              return json(context, 400, { code: 'invalid-command', error: 'expectedContentVersion, content, and reason are required' });
            }
            task = await controls.reviseForHuman(taskId, { expectedContentVersion: body.expectedContentVersion, content: body.content, reason: body.reason });
            break;
          case 'subordinate-stop':
            if (!onlyKeys(body, ['runId', 'reason']) || typeof body.runId !== 'string' || typeof body.reason !== 'string') {
              return json(context, 400, { code: 'invalid-command', error: 'runId and reason are required; actor fields are not accepted' });
            }
            task = await controls.stopSubordinateForHumanLead(taskId, { runId: body.runId, reason: body.reason });
            break;
          case 'pause':
          case 'interrupt':
          case 'resume':
          case 'cancel-pause':
          case 'clear-blocker':
          case 'end':
          case 'discard':
            if (!onlyKeys(body, ['reason']) || typeof body.reason !== 'string') {
              return json(context, 400, { code: 'invalid-command', error: 'reason is required and actor fields are not accepted' });
            }
            if (action === 'pause') task = await controls.pauseForHuman(taskId, { reason: body.reason });
            else if (action === 'interrupt') task = await controls.interruptForHuman(taskId, { reason: body.reason });
            else if (action === 'resume') task = await controls.resumeForHuman(taskId, { reason: body.reason });
            else if (action === 'cancel-pause') task = await controls.cancelPauseForHuman(taskId, { reason: body.reason });
            else if (action === 'clear-blocker') task = await controls.clearBlockerForHuman(taskId, { reason: body.reason });
            else if (action === 'end') task = await controls.endForHuman(taskId, { reason: body.reason });
            else task = await controls.discardForHuman(taskId, { reason: body.reason });
            break;
          case 'blockers':
            if (!onlyKeys(body, ['reason', 'requiredAction', 'responsible', 'nextAdvancer'])) {
              return json(context, 400, { code: 'invalid-command', error: 'blocker actor and unrecognized fields are not accepted' });
            }
            task = await controls.raiseBlockerForHuman(taskId, body);
            break;
          case 'completion-claims':
            if (!onlyKeys(body, ['outcomeSummary', 'validationEvidence', 'durableChanges', 'limitations', 'recommendedDisposition'])) {
              return json(context, 400, { code: 'invalid-command', error: 'completion claim actor and unrecognized fields are not accepted' });
            }
            task = await controls.submitCompletionClaimForHuman(taskId, body);
            break;
          case 'validation':
            if (!onlyKeys(body, ['claimId', 'decision', 'reason'])) {
              return json(context, 400, { code: 'invalid-command', error: 'claimId, decision, and reason are required; actor fields are not accepted' });
            }
            if (typeof body.claimId !== 'string' || typeof body.reason !== 'string'
              || (body.decision !== 'accept' && body.decision !== 'correct')) {
              return json(context, 400, { code: 'invalid-command', error: 'claimId, decision, and reason are required' });
            }
            task = await controls.validateForHuman(taskId, {
              claimId: body.claimId, decision: body.decision, reason: body.reason,
            });
            break;
          case 'recovery':
            if (!onlyKeys(body, ['action', 'reason']) || typeof body.reason !== 'string') {
              return json(context, 400, { code: 'invalid-command', error: 'action and reason are required; actor fields are not accepted' });
            }
            if (body.action !== 'resume' && body.action !== 'discard') {
              return json(context, 400, { code: 'invalid-command', error: 'action must be resume or discard' });
            }
            task = await (options.recover ?? controls.recoverForHuman.bind(controls))(taskId, {
              action: body.action, reason: body.reason,
            });
            break;
        }
        if (task === undefined) return json(context, 400, { code: 'invalid-command', error: 'unsupported Task control' });
        return json(context, 200, { task: toTaskView(task) });
      } catch (error) {
        if (error instanceof TaskPauseRetryRequired) return json(context, 409, { code: 'pause-retry-required', error: error.message });
        if (error instanceof TaskTerminalMutationError) return json(context, 409, { code: error.code, error: error.message });
        if (error instanceof TaskControlError) {
          const status = error.code === 'unknown-task' ? 404 : error.code === 'authority-required' ? 403
            : error.code === 'invalid-command' ? 400 : 409;
          return json(context, status, { code: error.code, error: error.message });
        }
        if (error instanceof TaskProposalError) {
          const status = ['unknown-project', 'unknown-proposal'].includes(error.code) ? 404
            : ['membership-required', 'authority-required', 'agent-read-only'].includes(error.code) ? 403 : 409;
          return json(context, status, { code: error.code, error: error.message });
        }
        if (error instanceof EnvironmentRecoveryError) return json(context, 409, { code: error.code, error: error.message });
        if (error instanceof TaskRecoveryRefusal) return json(context, 409, { code: error.code, error: error.message });
        return json(context, 409, { code: 'lifecycle-conflict', error: 'the Task command could not be completed' });
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}
