import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import type { TaskAdmissionService } from '../task/admission-service.ts';
import { TaskAdvanceConflictError } from '../task/environment-lifecycle.ts';
import { createTaskAdmissionRouter } from './task-admission-router.ts';

test('an overlapping admission advance returns the typed 409 response shape', async () => {
  let statusCode: number | undefined;
  let responseBody = '';
  const response = {
    writeHead(status: number) { statusCode = status; return this; },
    end(body?: string) { responseBody = body ?? ''; },
  } as unknown as ServerResponse;
  const admissions = {
    async advanceForHuman() {
      throw new TaskAdvanceConflictError('task task-1 already has an active run');
    },
  } as unknown as TaskAdmissionService;
  const handled = await createTaskAdmissionRouter({ admissions }).handle({
    method: 'POST',
    response,
    pathname: '/api/tasks/task-1/advances',
    searchParams: new URLSearchParams(),
    segments: ['api', 'tasks', 'task-1', 'advances'],
    operatorSessionId: 'session',
    async readBody() { return { targetAgentId: 'scout', reason: 'Continue after review.' }; },
  });

  assert.equal(handled, true);
  assert.equal(statusCode, 409);
  assert.deepEqual(JSON.parse(responseBody), {
    code: 'advance-conflict',
    error: 'task task-1 already has an active run',
  });
});
