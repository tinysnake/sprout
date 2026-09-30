import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskProposalBrowserAdapter } from './task-proposal-api.ts';
import { BrowserRequestError, createBrowserTransport } from '../transport/browser-transport.ts';

test('proposal adapter encodes Project and proposal identities and retains optimistic command fences', async () => {
  const calls: { path: string; method?: string; body?: string }[] = [];
  const transport = createBrowserTransport({ fetch: (async (url, init) => {
    calls.push({ path: String(url), ...(init?.method ? { method: init.method } : {}), ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    return new Response(JSON.stringify({ proposal: { id: 'proposal' }, proposals: [], content: {}, contentVersion: {} }), { status: 200 });
  }) as typeof fetch });
  const browser = createTaskProposalBrowserAdapter(transport);
  const content = { title: 'Task', goal: 'Goal', constraints: [], validationCriteria: [] };
  const decision = { reason: 'Changed', expectedRevision: 7 };
  await browser.list('project/with space');
  await browser.get('proposal/with space');
  await browser.contentVersion('proposal/with space', 3);
  await browser.validate('project/with space', content);
  await browser.propose('project/with space', content);
  await browser.revise('proposal/with space', { ...content, ...decision });
  await browser.withdraw('proposal/with space', decision);
  await browser.reject('proposal/with space', decision);
  assert.deepEqual(calls.map(c => c.path), [
    '/api/projects/project%2Fwith%20space/task-proposals',
    '/api/task-proposals/proposal%2Fwith%20space',
    '/api/task-proposals/proposal%2Fwith%20space/versions/3',
    '/api/projects/project%2Fwith%20space/task-proposals/validate',
    '/api/projects/project%2Fwith%20space/task-proposals',
    '/api/task-proposals/proposal%2Fwith%20space/content',
    '/api/task-proposals/proposal%2Fwith%20space/withdraw',
    '/api/task-proposals/proposal%2Fwith%20space/reject',
  ]);
  for (const call of calls.slice(3)) assert.equal(call.method, 'POST');
  assert.deepEqual(JSON.parse(calls[5]!.body!), { ...content, ...decision });
  assert.deepEqual(JSON.parse(calls[7]!.body!), decision);
});

test('disconnected proposal command rejects once, exposes offline state and is never replayed', async () => {
  let calls = 0;
  const transport = createBrowserTransport({ fetch: (async () => { calls++; throw new Error('unreachable'); }) as typeof fetch });
  const browser = createTaskProposalBrowserAdapter(transport);
  const states: string[] = [];
  const unsubscribe = browser.subscribeState(state => states.push(state.connection));
  await assert.rejects(browser.reject('proposal', { expectedRevision: 1, reason: 'Not needed' }), BrowserRequestError);
  assert.equal(calls, 1);
  assert.equal(browser.state().connection, 'offline');
  assert.ok(states.includes('offline'));
  unsubscribe();
});
