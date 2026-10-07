import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ScriptedEngineAdapter } from '../../../src/engine/scripted.ts';
import { build, INSTANCE_ID, PROJECT_ID, scriptedEnvironment, scriptedTurn } from '../../../src/runtime-test-harness.ts';
import { createTaskProposalBrowserAdapter } from './task-proposal-api.ts';
import { createBrowserTransport } from '../transport/browser-transport.ts';
import type { TaskContextMaterialization } from '../../../src/worker/protocol.ts';

const content = {
  title: 'Approved through the operator API',
  goal: 'Preserve the Human-approved content snapshot.',
  constraints: ['Use the granted Project workspace.'],
  validationCriteria: ['The snapshot is visible to the Worker.'],
};

test('the authenticated API begins one proposal snapshot and exposes Human-attributed sequential advancement', async () => {
  const credential = randomBytes(32).toString('base64url');
  const prepared: TaskContextMaterialization[] = [];
  const environment = scriptedEnvironment({
    adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [scriptedTurn('Implementation step completed.')] })]]),
    contexts: {
      async prepare(input) { prepared.push(structuredClone(input)); return { bootstrapInstructions: 'Start from the approved context.' }; },
      async recycle() {},
    },
  });
  const { runtime } = await build({ configuration: { operatorCredential: credential }, environment, listen: false });
  const { port } = await runtime.api.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const unauthenticated = await fetch(`${base}/api/task-proposals/not-a-proposal/begin`, { method: 'POST' });
    assert.equal(unauthenticated.status, 401);
    const signIn = await fetch(`${base}/api/auth/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
    });
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = await signIn.json() as { csrfToken: string };
    const noCsrf = await fetch(`${base}/api/task-proposals/not-a-proposal/begin`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(noCsrf.status, 403);
    const transport = createBrowserTransport({ fetch: ((url: string | URL | Request, init?: RequestInit) => fetch(`${base}${String(url)}`, {
      ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie },
    })) as typeof fetch });
    transport.setCsrfToken(csrfToken);
    const directTask = await transport.request<{ code: string }>('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(content),
    }).catch(error => error as { code?: string });
    assert.equal((directTask as { code?: string }).code, 'proposal-required', 'the protected runtime has no unapproved Task creation path');
    const browser = createTaskProposalBrowserAdapter(transport);
    const proposal = await browser.propose(PROJECT_ID, content);
    const begin = await browser.begin(proposal.id, {
      expectedRevision: proposal.revision,
      environmentInstanceId: INSTANCE_ID,
      lead: { memberId: 'operator', memberKind: 'human' },
      reason: 'Begin after Human approval.',
    });
    assert.equal(begin.duplicate, false);
    assert.equal(begin.task.environmentLifecycleState, 'idle');
    assert.equal(begin.task.environmentInstanceId, INSTANCE_ID);
    assert.equal(begin.task.admission?.proposalId, proposal.id);
    assert.equal(begin.task.admission?.contentVersion, 1);
    assert.deepEqual(begin.task.admission?.approvedBy, { memberId: 'operator', memberKind: 'human' });
    assert.equal((await browser.get(proposal.id)).status, 'begun');
    assert.equal(prepared[0]?.taskContentVersion, 1);
    assert.deepEqual(prepared[0]?.taskValidationCriteria, content.validationCriteria);
    assert.equal(runtime.orchestrator.known().length, 0, 'a Human Task lead does not wake an Agent');
    const legacyAdvance = await transport.request(`/api/tasks/${encodeURIComponent(begin.task.id)}/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'scout' }),
    }).catch(error => error as { code?: string });
    assert.equal((legacyAdvance as { code?: string }).code, 'use-task-advances');
    assert.equal(runtime.orchestrator.known().length, 0, 'legacy advancement cannot bypass the attributed command');

    const advance = await transport.request<{ task: { id: string }; runId: string; advance: {
      agentId: string; actor: { memberId: string; memberKind: string }; reason: string; contentVersion: number;
    } }>(`/api/tasks/${encodeURIComponent(begin.task.id)}/advances`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAgentId: 'scout', reason: 'Run the verified next step.', actor: { memberId: 'scribe', memberKind: 'agent' } }),
    });
    assert.equal(advance.advance.agentId, 'scout');
    assert.deepEqual(advance.advance.actor, { memberId: 'operator', memberKind: 'human' }, 'body identity cannot replace session authority');
    assert.equal(advance.advance.reason, 'Run the verified next step.');
    assert.equal(advance.advance.contentVersion, 1);
    const details = await transport.request<{ runs: { runId: string; actor?: { memberId: string }; reason?: string; contentVersion?: number }[] }>(`/api/tasks/${encodeURIComponent(begin.task.id)}`);
    assert.equal(details.runs.length, 1);
    assert.equal(details.runs[0]?.runId, advance.runId);
    assert.equal(details.runs[0]?.actor?.memberId, 'operator');
    assert.equal(details.runs[0]?.reason, 'Run the verified next step.');
    assert.equal(details.runs[0]?.contentVersion, 1);

    const repeated = await browser.begin(proposal.id, {
      expectedRevision: proposal.revision,
      environmentInstanceId: INSTANCE_ID,
      lead: { memberId: 'operator', memberKind: 'human' },
      reason: 'Begin after Human approval.',
    });
    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.task.id, begin.task.id);
    assert.equal(runtime.pool.leases().filter(lease => lease.state === 'active').length, 1);
  } finally {
    await runtime.close();
  }
});
