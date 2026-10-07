import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';

import type { Task } from '../task/model.ts';
import { TaskControlError, type TaskControlService } from '../task/control-service.ts';
import type { ApiRequestContext } from './router.ts';
import { createTaskControlRouter } from './task-control-router.ts';
import { TaskPauseRetryRequired, TaskTerminalMutationError } from '../task/environment-lifecycle.ts';

const task: Task = { id: 'task-1', projectId: 'project', title: 'Task', goal: 'Goal', constraints: [], status: 'in-progress', createdAt: 1, updatedAt: 1 };

async function invoke(options: { readonly session?: boolean; readonly body: unknown; readonly action?: string; readonly stopFailure?: TaskControlError; readonly clearFailure?: Error }) {
  let status = 0;
  let responseBody = '';
  const response = {
    writeHead(code: number) { status = code; return this; },
    end(body?: string) { responseBody = body ?? ''; return this; },
  } as unknown as ServerResponse;
  let commands = 0;
  const controls = {
    pauseForHuman: async () => { commands += 1; return task; },
    submitCompletionClaimForHuman: async () => { commands += 1; return task; },
    stopSubordinateForHumanLead: async () => {
      commands += 1;
      if (options.stopFailure) throw options.stopFailure;
      return task;
    },
    clearBlockerForHuman: async () => {
      commands += 1;
      if (options.clearFailure) throw options.clearFailure;
      return task;
    },
  } as unknown as TaskControlService;
  const router = createTaskControlRouter({ controls });
  const action = options.action ?? 'pause';
  const context: ApiRequestContext = {
    method: 'POST', response, pathname: `/api/tasks/task-1/${action}`, searchParams: new URLSearchParams(),
    segments: ['api', 'tasks', 'task-1', action],
    ...(options.session ? { operatorSessionId: 'authenticated-session' } : {}),
    readBody: async () => options.body as Record<string, unknown>,
  };
  const handled = await router.handle(context);
  return { handled, status, body: JSON.parse(responseBody) as { task?: unknown; code?: string }, commands };
}

test('terminal blocker refusals preserve their product-owned code and reason over HTTP', async () => {
  const terminal = await invoke({
    session: true, action: 'clear-blocker', body: { reason: 'Remove the historical blocker' },
    clearFailure: new TaskTerminalMutationError('cancelled', 'clear'),
  });
  assert.equal(terminal.status, 409);
  assert.deepEqual(terminal.body, {
    code: 'terminal-task', error: 'This Task is cancelled; its blocker is historical.',
  });

  const concurrent = await invoke({
    session: true, action: 'clear-blocker', body: { reason: 'Clear after checking the current Task' },
    clearFailure: new Error('task task-1 changed before blocker was recorded'),
  });
  assert.equal(concurrent.status, 409);
  assert.equal(concurrent.body.code, 'lifecycle-conflict', 'the existing concurrent-change path keeps its stale-lifecycle code');
});

test('Pause CAS exhaustion returns explicit Human retry and cancellation guidance', async () => {
  let status = 0;
  let responseBody = '';
  const response = {
    writeHead(code: number) { status = code; return this; },
    end(body?: string) { responseBody = body ?? ''; return this; },
  } as unknown as ServerResponse;
  const controls = {
    pauseForHuman: async () => { throw new TaskPauseRetryRequired(); },
  } as unknown as TaskControlService;
  const router = createTaskControlRouter({ controls });
  const context: ApiRequestContext = {
    method: 'POST', response, pathname: '/api/tasks/task-1/pause', searchParams: new URLSearchParams(),
    segments: ['api', 'tasks', 'task-1', 'pause'], operatorSessionId: 'authenticated-session',
    readBody: async () => ({ reason: 'hold before next run' }),
  };
  assert.equal(await router.handle(context), true);
  assert.equal(status, 409);
  assert.deepEqual(JSON.parse(responseBody), {
    code: 'pause-retry-required',
    error: 'Pause could not be recorded after repeated Task changes; retry Human Pause or explicitly cancel the outstanding Pause request',
  });
});

test('cancel-pause dispatches only the authenticated Human command shape', async () => {
  let status = 0;
  let responseBody = '';
  let commands = 0;
  const response = {
    writeHead(code: number) { status = code; return this; },
    end(body?: string) { responseBody = body ?? ''; return this; },
  } as unknown as ServerResponse;
  const controls = {
    cancelPauseForHuman: async (_taskId: string, input: { reason: string }) => {
      commands += 1;
      assert.equal(input.reason, 'release pending hold');
      return task;
    },
  } as unknown as TaskControlService;
  const router = createTaskControlRouter({ controls });
  const context: ApiRequestContext = {
    method: 'POST', response, pathname: '/api/tasks/task-1/cancel-pause', searchParams: new URLSearchParams(),
    segments: ['api', 'tasks', 'task-1', 'cancel-pause'], operatorSessionId: 'authenticated-session',
    readBody: async () => ({ reason: 'release pending hold' }),
  };
  assert.equal(await router.handle(context), true);
  assert.equal(status, 200);
  assert.equal(commands, 1);
  assert.ok(JSON.parse(responseBody).task);
});

test('Task control routes require the authenticated Human transport context', async () => {
  const result = await invoke({ body: { reason: 'pause' } });
  assert.equal(result.handled, true);
  assert.equal(result.status, 401);
  assert.equal(result.commands, 0);
});

test('subordinate stop routes use the authenticated lead and reject forged actors', async () => {
  const stopped = await invoke({ session: true, action: 'subordinate-stop', body: { runId: 'run-1', reason: 'Stop the initiated run.' } });
  assert.equal(stopped.handled, true);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.commands, 1);

  const forged = await invoke({ session: true, action: 'subordinate-stop', body: { runId: 'run-1', reason: 'Stop the run.', actor: { memberId: 'pi', memberKind: 'agent' } } });
  assert.equal(forged.status, 400);
  assert.equal(forged.commands, 0);

  const notLead = await invoke({
    session: true, action: 'subordinate-stop', body: { runId: 'run-1', reason: 'Borrow lead authority.' },
    stopFailure: new TaskControlError('authority-required', 'only the current Task lead can use this route'),
  });
  assert.equal(notLead.status, 403);
  assert.equal(notLead.body.code, 'authority-required');
});

test('Task control HTTP commands reject caller-selected actor authority', async () => {
  const pause = await invoke({ session: true, body: { reason: 'pause', actor: { memberId: 'pi', memberKind: 'agent' } } });
  assert.equal(pause.status, 400);
  assert.equal(pause.commands, 0);

  const controls = {
    submitCompletionClaimForHuman: async () => { throw new Error('should not receive a forged claim'); },
  } as unknown as TaskControlService;
  const router = createTaskControlRouter({ controls });
  let status = 0;
  const response = {
    writeHead(code: number) { status = code; return this; },
    end() { return this; },
  } as unknown as ServerResponse;
  const context: ApiRequestContext = {
    method: 'POST', response, pathname: '/api/tasks/task-1/completion-claims', searchParams: new URLSearchParams(),
    segments: ['api', 'tasks', 'task-1', 'completion-claims'], operatorSessionId: 'authenticated-session',
    readBody: async () => ({ outcomeSummary: 'finished', validationEvidence: ['check passed'], durableChanges: [], limitations: [], recommendedDisposition: 'complete', actor: { memberId: 'pi', memberKind: 'agent' } }),
  };
  assert.equal(await router.handle(context), true);
  assert.equal(status, 400);
});
