import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserTransport } from '../transport/browser-transport.ts';
import { BrowserRequestError } from '../transport/browser-transport.ts';
import { createTaskBrowserAdapter } from './task-api.ts';

function transportStub(handler: (path: string, init?: RequestInit) => unknown | Promise<unknown>) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const transport = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    setCsrfToken: () => undefined,
    events: () => () => undefined,
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      calls.push({ path, init });
      return await handler(path, init) as T;
    },
  } as BrowserTransport;
  return { adapter: createTaskBrowserAdapter(transport), calls };
}

test('Task browser adapter uses encoded production proposal, Task, run, and control routes', async () => {
  const { adapter, calls } = transportStub((path) => {
    if (path.endsWith('/task-proposals')) return { proposals: [] };
    if (path === '/api/tasks?projectId=project%2Fone%20two') return { tasks: [] };
    if (path.endsWith('/advances')) return { task: {}, runId: 'run-a', advance: {} };
    return { proposal: {}, task: {}, contentVersion: {} };
  });

  await adapter.listProposals('project/one two');
  await adapter.listTasks('project/one two');
  await adapter.getTask('task/one two');
  await adapter.advance('task/one two', { targetAgentId: 'agent-a', reason: 'Continue verified work.' });
  await adapter.reviseTaskContent('task/one two', { expectedContentVersion: 1, content: { title: 'Title', goal: 'Goal', constraints: [], validationCriteria: [], lead: { memberId: 'agent-a', memberKind: 'agent' } }, reason: 'Revise bounded Task content.' });
  await adapter.pause('task/one two', 'Hold further runs.');
  await adapter.interrupt('task/one two', 'Stop the active run.');
  await adapter.resume('task/one two', 'Resume deliberate work.');
  await adapter.raiseBlocker('task/one two', { reason: 'Waiting for approval.', requiredAction: 'Record approval.', responsible: { kind: 'external-condition', condition: 'Approval arrives.' }, nextAdvancer: { memberId: 'agent-a', memberKind: 'agent' } });
  await adapter.clearBlocker('task/one two', 'Approval arrived.');
  await adapter.submitCompletionClaim('task/one two', { outcomeSummary: 'Work is ready.', validationEvidence: ['Checks passed.'], durableChanges: [], limitations: [], recommendedDisposition: 'complete' });
  await adapter.validate('task/one two', { claimId: 'claim-a', decision: 'accept', reason: 'Evidence is sufficient.' });
  await adapter.end('task/one two', 'Retry safe completion cleanup.');
  await adapter.discard('task/one two', 'Abandon the proposed work.');
  await adapter.reopen('task/one two', 'Continue the ended Task.');
  await adapter.recover('task/one two', { action: 'resume', reason: 'Recovery evidence is ready.' });
  await adapter.stopSubordinate('task/one two', { runId: 'run/one', reason: 'Stop this run.' });
  await adapter.getContentVersion('proposal/one two', 4);

  assert.equal(calls.at(-1)?.path, '/api/task-proposals/proposal%2Fone%20two/versions/4');
  assert.deepEqual(calls.slice(3, -1).map(({ path }) => path), [
    '/api/tasks/task%2Fone%20two/advances',
    '/api/tasks/task%2Fone%20two/content',
    '/api/tasks/task%2Fone%20two/pause',
    '/api/tasks/task%2Fone%20two/interrupt',
    '/api/tasks/task%2Fone%20two/resume',
    '/api/tasks/task%2Fone%20two/blockers',
    '/api/tasks/task%2Fone%20two/clear-blocker',
    '/api/tasks/task%2Fone%20two/completion-claims',
    '/api/tasks/task%2Fone%20two/validation',
    '/api/tasks/task%2Fone%20two/end',
    '/api/tasks/task%2Fone%20two/discard',
    '/api/tasks/task%2Fone%20two/reopen',
    '/api/tasks/task%2Fone%20two/recovery',
    '/api/tasks/task%2Fone%20two/subordinate-stop',
  ]);
  assert.deepEqual(JSON.parse(String(calls.at(-2)?.init?.body)), { runId: 'run/one', reason: 'Stop this run.' });
  assert.equal(calls[3]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { targetAgentId: 'agent-a', reason: 'Continue verified work.' });
  assert.deepEqual(JSON.parse(String(calls[5]?.init?.body)), { reason: 'Hold further runs.' });
  assert.deepEqual(JSON.parse(String(calls[8]?.init?.body)), { reason: 'Waiting for approval.', requiredAction: 'Record approval.', responsible: { kind: 'external-condition', condition: 'Approval arrives.' }, nextAdvancer: { memberId: 'agent-a', memberKind: 'agent' } });
  assert.deepEqual(JSON.parse(String(calls.find((call) => call.path.endsWith('/reopen'))?.init?.body)), { reason: 'Continue the ended Task.' });
});

test('Task browser adapter preserves typed 409 conflict codes for page presentation', async () => {
  const codes = ['advance-conflict', 'environment-recovering', 'lifecycle-conflict'] as const;
  for (const code of codes) {
    const refusal = new BrowserRequestError('rejected', 409, { code, message: `refused ${code}` });
    const { adapter } = transportStub(() => { throw refusal; });
    await assert.rejects(adapter.advance('task-a', { targetAgentId: 'agent-a', reason: 'Try one deliberate advance.' }), (error: unknown) => {
      assert.equal(error, refusal);
      assert.equal((error as BrowserRequestError).status, 409);
      assert.equal((error as BrowserRequestError).code, code);
      return true;
    });
  }
});
