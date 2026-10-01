import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';

import type { Task } from '../task/model.ts';
import type { TaskControlService } from '../task/control-service.ts';
import type { ApiRequestContext } from './router.ts';
import { createTaskControlRouter } from './task-control-router.ts';

const task: Task = { id: 'task-1', projectId: 'project', title: 'Task', goal: 'Goal', constraints: [], status: 'in-progress', createdAt: 1, updatedAt: 1 };

async function invoke(options: { readonly session?: boolean; readonly body: unknown }) {
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
  } as unknown as TaskControlService;
  const router = createTaskControlRouter({ controls });
  const context: ApiRequestContext = {
    method: 'POST', response, pathname: '/api/tasks/task-1/pause', searchParams: new URLSearchParams(),
    segments: ['api', 'tasks', 'task-1', 'pause'],
    ...(options.session ? { operatorSessionId: 'authenticated-session' } : {}),
    readBody: async () => options.body as Record<string, unknown>,
  };
  const handled = await router.handle(context);
  return { handled, status, body: JSON.parse(responseBody) as { task?: unknown; code?: string }, commands };
}

test('Task control routes require the authenticated Human transport context', async () => {
  const result = await invoke({ body: { reason: 'pause' } });
  assert.equal(result.handled, true);
  assert.equal(result.status, 401);
  assert.equal(result.commands, 0);
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
