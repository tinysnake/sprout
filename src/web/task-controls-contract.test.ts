import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { build, INSTANCE_ID, PROJECT_ID, scriptedEnvironment } from '../runtime-test-harness.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import type { TaskView } from './views.ts';

const content = { title: 'Operator-controlled Task', goal: 'Verify safe intervention', constraints: ['Preserve work'], validationCriteria: ['Evidence reviewed'] };

test('authenticated Task controls preserve authority, validation recovery, privacy, and safe terminal ordering over HTTP', async () => {
  const credential = randomBytes(32).toString('base64url');
  let cleanupUnavailable = true;
  let cleaned = false;
  const { runtime } = await build({
    configuration: { operatorCredential: credential }, listen: false,
    environment: scriptedEnvironment({ adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]), contexts: {
      async prepare() { return { bootstrapInstructions: '' }; },
      async recycle() {
        if (cleanupUnavailable) throw new Error('sensitive cleanup diagnostic must stay private');
        cleaned = true;
      },
    } }),
  });
  const { port } = await runtime.api.listen(Number(process.env.PORT ?? 0));
  const base = new URL('http://localhost');
  base.port = String(port);
  try {
    const signIn = await fetch(new URL('/api/auth/session', base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
    });
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = await signIn.json() as { csrfToken: string };
    const post = (path: string, body: unknown, session = true, csrf = true) => fetch(new URL(path, base), {
      method: 'POST', headers: { 'content-type': 'application/json', ...(session ? { cookie } : {}), ...(csrf ? { 'x-sprout-csrf': csrfToken } : {}) },
      body: JSON.stringify(body),
    });
    const proposalResponse = await post(`/api/projects/${PROJECT_ID}/task-proposals`, content);
    assert.equal(proposalResponse.status, 201);
    const { proposal } = await proposalResponse.json() as { proposal: { id: string; revision: number } };
    const begunResponse = await post(`/api/task-proposals/${proposal.id}/begin`, {
      expectedRevision: proposal.revision, environmentInstanceId: INSTANCE_ID,
      lead: { memberId: 'operator', memberKind: 'human' }, reason: 'Human approval',
    });
    assert.equal(begunResponse.status, 201);
    const { task } = await begunResponse.json() as { task: TaskView };
    const path = `/api/tasks/${task.id}`;
    const leaseId = (await runtime.tasks.get(task.id))!.environmentLeaseId!;
    for (const action of ['pause', 'interrupt', 'resume', 'cancel-pause', 'subordinate-stop', 'blockers', 'clear-blocker', 'completion-claims', 'validation', 'end', 'discard', 'recovery', 'content']) {
      assert.equal((await post(`${path}/${action}`, {}, false)).status, 401, action);
      assert.equal((await post(`${path}/${action}`, {}, true, false)).status, 403, action);
      assert.equal((await post(`${path}/${action}`, { actor: { memberId: 'scout', memberKind: 'agent' } })).status, 400, action);
    }
    assert.equal((await post(`${path}/end`, { reason: 'premature completion' })).status, 409);
    const pauseResponse = await post(`${path}/pause`, { reason: 'Human inspection' });
    assert.equal(pauseResponse.status, 200);
    assert.equal((await pauseResponse.json() as { task: TaskView }).task.pauseState, 'paused');
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'active');
    assert.equal((await post(`${path}/resume`, { reason: 'deliberate resumption' })).status, 200);
    assert.equal((await post(`${path}/content`, {
      expectedContentVersion: 1, content: { ...content, goal: 'Updated scope', lead: { memberId: 'operator', memberKind: 'human' } }, reason: 'Clarify scope',
    })).status, 200);
    const claimBody = { outcomeSummary: 'Delivered the verified result', validationEvidence: ['Contract checked'], durableChanges: [], limitations: [], recommendedDisposition: 'complete' };
    assert.equal((await post(`${path}/completion-claims`, { ...claimBody, privateReasoning: 'not a factual field' })).status, 400);
    const claimResponse = await post(`${path}/completion-claims`, claimBody);
    assert.equal(claimResponse.status, 200);
    const claimed = (await claimResponse.json() as { task: TaskView }).task;
    assert.equal(claimed.completionClaims?.[0]?.contentVersion, 2);
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'active');
    const accepted = await post(`${path}/validation`, { claimId: claimed.pendingCompletionClaimId, decision: 'accept', reason: 'Human verified evidence' });
    assert.equal(accepted.status, 409);
    assert.doesNotMatch(await accepted.text(), /sensitive cleanup diagnostic/);
    const recovering = (await runtime.tasks.get(task.id))!;
    assert.equal(recovering.environmentLifecycleState, 'recovery');
    assert.equal(recovering.status, 'in-progress');
    assert.equal(recovering.completedAt, undefined);
    assert.equal(cleaned, false);
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'recovering');
    cleanupUnavailable = false;
    const recovered = await post(`${path}/recovery`, { action: 'discard', reason: 'Retry accepted end cleanup' });
    assert.equal(recovered.status, 200);
    const completed = (await recovered.json() as { task: TaskView }).task;
    assert.equal(completed.status, 'done');
    assert.equal(completed.endDisposition, 'completed');
    assert.equal(cleaned, true);
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'released');
  } finally { await runtime.close(); }
});
