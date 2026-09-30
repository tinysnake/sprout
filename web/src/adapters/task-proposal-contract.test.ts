import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ScriptedEngineAdapter } from '../../../src/engine/scripted.ts';
import { build, PROJECT_ID, scriptedEnvironment } from '../../../src/runtime-test-harness.ts';
import type { TaskProposal } from './task-proposal-api.ts';
import { createTaskProposalBrowserAdapter } from './task-proposal-api.ts';
import { createBrowserTransport } from '../transport/browser-transport.ts';

const content = { title: 'Quiet proposal', goal: 'Prove proposal authority', constraints: [], validationCriteria: ['No work begins'] };

test('production transport and browser adapter deliver proposal authority without run or lease side effects', async () => {
  const credential = randomBytes(32).toString('base64url');
  const contextCalls: string[] = [];
  const environment = scriptedEnvironment({ adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]), contexts: {
    async prepare() { contextCalls.push('prepare'); throw new Error('proposal must not prepare Task context'); },
    async recycle() { contextCalls.push('recycle'); throw new Error('proposal must not recycle Task context'); },
  } });
  const { runtime, stores } = await build({ environment, configuration: { operatorCredential: credential }, listen: false });
  const { port } = await runtime.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const path = `/api/projects/${PROJECT_ID}/task-proposals`;
    assert.equal((await fetch(`${base}${path}`)).status, 401);
    const signIn = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }) });
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = await signIn.json() as { csrfToken: string };
    const headers = { cookie, 'content-type': 'application/json', 'x-sprout-csrf': csrfToken };
    assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(content) })).status, 403);
    const transport = createBrowserTransport({ fetch: ((url: string | URL | Request, init?: RequestInit) => fetch(`${base}${String(url)}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie } })) as typeof fetch });
    transport.setCsrfToken(csrfToken);
    const browser = createTaskProposalBrowserAdapter(transport);
    const callsBefore = [...contextCalls];
    assert.deepEqual(await browser.validate(PROJECT_ID, content), content);
    assert.deepEqual(await browser.list(PROJECT_ID), []);
    const forged = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify({ ...content, proposer: { memberId: 'scout', memberKind: 'agent' }, actor: { memberId: 'scout', memberKind: 'agent' } }) });
    assert.equal(forged.status, 201);
    const { proposal: human } = await forged.json() as { proposal: TaskProposal };
    assert.deepEqual(human.proposer, { memberId: 'operator', memberKind: 'human' });
    const agent = await runtime.taskProposals.propose(PROJECT_ID, { memberId: 'scout', memberKind: 'agent' }, content);
    const heldVersion = await browser.contentVersion(agent.id, 1);
    const revised = await browser.revise(agent.id, { ...content, goal: 'Corrected by Human', expectedRevision: 1, reason: 'Narrow scope' });
    assert.equal(revised.currentContentVersion, 2);
    assert.equal(heldVersion.goal, content.goal);
    await assert.rejects(browser.revise(agent.id, { ...content, expectedRevision: 1, reason: 'Stale correction' }), { code: 'stale-proposal', status: 409 });
    const rejected = await browser.reject(agent.id, { expectedRevision: 2, reason: 'Not required' });
    assert.equal((await browser.get(agent.id)).status, 'rejected');
    assert.equal(rejected.lifecycle[0]?.reason, 'Not required');
    assert.equal((await browser.withdraw(human.id, { expectedRevision: 1, reason: 'Superseded' })).status, 'withdrawn');
    const own = await browser.propose(PROJECT_ID, content);
    assert.equal(own.currentContentVersion, 1);
    assert.equal((await browser.list(PROJECT_ID)).length, 3);
    await assert.rejects(browser.get('missing'), { status: 404, code: 'unknown-proposal' });
    await assert.rejects(browser.validate(PROJECT_ID, { ...content, constraints: 'invalid' as unknown as string[] }), { status: 400, code: 'invalid-content' });
    for (const body of ['null', '[]', '{bad json']) {
      assert.equal((await fetch(`${base}/api/task-proposals/${own.id}/reject`, { method: 'POST', headers, body })).status, 400);
    }
    assert.equal((await browser.get(own.id)).revision, 1, 'invalid bodies have no durable effect');
    assert.deepEqual(await stores.tasks.list(), []);
    assert.deepEqual(await runtime.orchestrator.list(), []);
    assert.deepEqual(await runtime.collaboration.listWakeRequests(), []);
    assert.deepEqual(runtime.pool.leases(), []);
    assert.deepEqual(contextCalls, callsBefore);
    const begin = await fetch(`${base}/api/tasks/${own.id}/begin`, { method: 'POST', headers, body: '{}' });
    assert.equal(begin.status, 404, 'a proposal cannot be passed to legacy Task begin');
  } finally { await runtime.close(); }
});
