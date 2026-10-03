import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { build, INSTANCE_ID, PROJECT_ID, scriptedEnvironment } from '../runtime-test-harness.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import type { TaskView } from './views.ts';

const content = { title: 'Operator-controlled Task', goal: 'Verify safe intervention', constraints: ['Preserve work'], validationCriteria: ['Evidence reviewed'] };

test('authenticated Pause and Interrupt route stop an active Task run and preserve its Task lease', async () => {
  const credential = randomBytes(32).toString('base64url');
  let engineInterrupts = 0;
  const adapter = new ScriptedEngineAdapter({
    turns: [{ events: [], result: { status: 'completed', text: 'The run should be stopped first.' }, settleAfterMs: 30_000 }],
    onInterrupt: () => { engineInterrupts += 1; },
  });
  const { runtime } = await build({
    configuration: { operatorCredential: credential }, listen: false,
    environment: scriptedEnvironment({ adapters: new Map([['scripted', adapter]]) }),
  });
  const { port } = await runtime.api.listen(Number(process.env.TASK_STOP_PORT ?? 0));
  const base = new URL('http://localhost');
  base.port = String(port);
  try {
    const signIn = await fetch(new URL('/api/auth/session', base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
    });
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = await signIn.json() as { csrfToken: string };
    const post = (path: string, body: unknown) => fetch(new URL(path, base), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-sprout-csrf': csrfToken }, body: JSON.stringify(body),
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
    const leaseId = task.environmentLeaseId!;
    const { runId } = await runtime.tasks.advanceWithAttribution(task.id, {
      agentId: 'scout', actor: { memberId: 'operator', memberKind: 'human' },
      reason: 'Start a bounded active run', contentVersion: 1,
    });
    let liveRun = await runtime.orchestrator.load(runId);
    for (let attempt = 0; attempt < 500 && liveRun?.status !== 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      liveRun = await runtime.orchestrator.load(runId);
    }
    assert.equal(liveRun?.status, 'running', 'the scripted engine has an active session before interruption');
    const directInterruptResponse = await post(`/api/tasks/${task.id}/interrupt`, { reason: 'Attempt an interrupt without a Pause request' });
    assert.equal(directInterruptResponse.status, 409, 'the existing Interrupt route is gated until a Pause request exists');
    assert.equal(engineInterrupts, 0, 'a refused direct Interrupt leaves the live engine session running');

    const pauseResponse = await post(`/api/tasks/${task.id}/pause`, { reason: 'Stop the current run before review' });
    assert.equal(pauseResponse.status, 200);
    assert.equal(((await pauseResponse.json()) as { task: TaskView }).task.pauseState, 'requested');
    const interruptResponse = await post(`/api/tasks/${task.id}/interrupt`, { reason: 'Stop the current run before review' });
    assert.equal(interruptResponse.status, 200);
    const stoppedTask = (await interruptResponse.json() as { task: TaskView }).task;
    const stoppedRun = await runtime.orchestrator.load(runId);
    assert.equal(engineInterrupts, 1, 'the route reaches the live EngineSession interrupt');
    assert.equal(stoppedRun?.status, 'stopped');
    assert.equal(stoppedRun?.result?.status, 'interrupted');
    assert.equal(stoppedTask.activeRunId, undefined);
    assert.equal(stoppedTask.status, 'in-progress');
    assert.equal(stoppedTask.pauseState, 'paused');
    assert.equal(stoppedTask.environmentLifecycleState, 'idle');
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'active', 'stopping a run does not release the Task-held lease');
    assert.deepEqual(stoppedTask.controlHistory?.filter((event) => ['pause-requested', 'interrupt-requested', 'paused'].includes(event.action)).map((event) => event.action), [
      'pause-requested', 'interrupt-requested', 'paused',
    ]);
  } finally { await runtime.close(); }
});

test('authenticated Human may submit a marked substitute claim for an Agent-led Task and accept it to completion', async () => {
  const credential = randomBytes(32).toString('base64url');
  const { runtime } = await build({
    configuration: { operatorCredential: credential }, listen: false,
    environment: scriptedEnvironment({ adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [
      { events: [], result: { status: 'completed', text: 'The bounded Agent work is complete.' } },
    ] })]]) }),
  });
  const { port } = await runtime.api.listen(Number(process.env.TASK_SUBSTITUTION_PORT ?? 0));
  const base = new URL('http://localhost');
  base.port = String(port);
  try {
    const signIn = await fetch(new URL('/api/auth/session', base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
    });
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = await signIn.json() as { csrfToken: string };
    const post = (path: string, body: unknown) => fetch(new URL(path, base), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-sprout-csrf': csrfToken }, body: JSON.stringify(body),
    });
    const proposalResponse = await post(`/api/projects/${PROJECT_ID}/task-proposals`, content);
    assert.equal(proposalResponse.status, 201);
    const { proposal } = await proposalResponse.json() as { proposal: { id: string; revision: number } };
    const begunResponse = await post(`/api/task-proposals/${proposal.id}/begin`, {
      expectedRevision: proposal.revision, environmentInstanceId: INSTANCE_ID,
      lead: { memberId: 'scout', memberKind: 'agent' }, reason: 'Human approval of Agent-led work',
    });
    assert.equal(begunResponse.status, 201);
    const { task } = await begunResponse.json() as { task: TaskView };
    const leaseId = (await runtime.tasks.get(task.id))!.environmentLeaseId!;
    let current = await runtime.tasks.get(task.id);
    for (let attempt = 0; attempt < 500 && current?.environmentLifecycleState !== 'idle'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await runtime.tasks.get(task.id);
    }
    assert.equal(current?.environmentLifecycleState, 'idle', 'the initial Agent-lead run settles before the claim');
    assert.equal(current?.activeRunId, undefined);

    const claimBody = {
      outcomeSummary: 'The approved work is complete', validationEvidence: ['Completion criteria passed'],
      durableChanges: ['The deliverable is present'], limitations: [], recommendedDisposition: 'complete',
    };
    await assert.rejects(
      runtime.taskControls.submitCompletionClaim(task.id, { memberId: 'scribe', memberKind: 'agent' }, claimBody),
      /Task lead authority is required/,
    );
    const claimResponse = await post(`/api/tasks/${task.id}/completion-claims`, claimBody);
    assert.equal(claimResponse.status, 200);
    const pending = (await claimResponse.json() as { task: TaskView }).task;
    const claim = pending.completionClaims?.find((item) => item.id === pending.pendingCompletionClaimId);
    assert.equal(pending.environmentLifecycleState, 'awaiting-validation');
    assert.deepEqual(claim?.actor, { memberId: 'operator', memberKind: 'human' });
    assert.deepEqual(claim?.substitutedFor, { memberId: 'scout', memberKind: 'agent' });
    assert.deepEqual(pending.controlHistory?.at(-1), {
      action: 'completion-claimed', actor: { memberId: 'operator', memberKind: 'human' },
      at: claim?.at, claimId: claim?.id, substitutedFor: { memberId: 'scout', memberKind: 'agent' },
    });
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'active');

    const accepted = await post(`/api/tasks/${task.id}/validation`, {
      claimId: pending.pendingCompletionClaimId, decision: 'accept', reason: 'Human verified the claim evidence',
    });
    assert.equal(accepted.status, 200);
    const completed = (await accepted.json() as { task: TaskView }).task;
    assert.equal(completed.status, 'done');
    assert.equal(completed.endDisposition, 'completed');
    assert.equal(completed.environmentLifecycleState, 'ended');
    assert.equal(runtime.pool.getLease(leaseId)?.state, 'released');
  } finally { await runtime.close(); }
});

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
