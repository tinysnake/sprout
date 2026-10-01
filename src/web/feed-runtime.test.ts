/**
 * Full-runtime Feed journey evidence (#103).
 *
 * Unlike the router unit test, this composes the production runtime: the Feed
 * router is registered by `createRuntime`, its projection reads the real Task,
 * proposal, and collaboration stores, and the only way an item appears or
 * disappears is an authoritative domain command over HTTP.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { build, INSTANCE_ID, PROJECT_ID, scriptedEnvironment } from '../runtime-test-harness.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import type { TaskView } from './views.ts';

const content = {
  title: 'Feed projection journey',
  goal: 'Prove the Feed follows authoritative state',
  constraints: [],
  validationCriteria: ['Feed items clear with their sources'],
};

interface FeedBody {
  attention: { id: string; severity: string; category: string; reason: string; lifecycle: string; target: { path: string; taskId?: string } }[];
  inFlight: { id: string; kind: 'task' | 'run'; taskId?: string; lifecycle: string }[];
  activity: { id: string; summary: string }[];
  scopes: { id: string; kind: string; attentionCount: number }[];
}

test('the composed runtime serves GET /api/feed and its Attention follows real domain commands', async () => {
  const credential = randomBytes(32).toString('base64url');
  const { runtime } = await build({
    configuration: { operatorCredential: credential },
    listen: false,
    environment: scriptedEnvironment({
      adapters: new Map([['scripted', new ScriptedEngineAdapter({
        turns: [{
          events: [{ type: 'message', text: 'advancing the task', final: true }],
          result: { status: 'completed', text: 'done' },
          // Keep the nested run observable as in-flight while the Feed is read;
          // Interrupt below settles it deliberately.
          settleAfterMs: 60_000,
        }],
      })]]),
      contexts: { async prepare() { return { bootstrapInstructions: '' }; }, async recycle() {} },
    }),
  });
  const { port } = await runtime.api.listen(Number(process.env.PORT ?? 0));
  const base = new URL('http://localhost');
  base.port = String(port);
  try {
    const readFeed = async (cookie: string, query = ''): Promise<FeedBody> => {
      const response = await fetch(new URL(`/api/feed${query}`, base), { headers: { cookie } });
      assert.equal(response.status, 200);
      return await response.json() as FeedBody;
    };

    const signIn = await fetch(new URL('/api/auth/session', base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
    });
    assert.equal(signIn.status, 201);
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = await signIn.json() as { csrfToken: string };
    const post = (path: string, body: unknown) => fetch(new URL(path, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-sprout-csrf': csrfToken },
      body: JSON.stringify(body),
    });

    assert.equal((await fetch(new URL('/api/feed', base))).status, 401, 'anonymous reads are refused');

    // A proposal appears as info-tier Attention.
    const proposalResponse = await post(`/api/projects/${PROJECT_ID}/task-proposals`, content);
    assert.equal(proposalResponse.status, 201);
    const { proposal } = await proposalResponse.json() as { proposal: { id: string; revision: number } };
    let feed = await readFeed(cookie);
    assert.deepEqual(feed.attention.map((item) => item.id), [`proposal:${proposal.id}`]);
    assert.equal(feed.attention[0]?.severity, 'info');
    assert.match(feed.attention[0]?.target.path, /^\/project\/tasks\?proposal=/);
    assert.ok(feed.scopes.some((option) => option.id === PROJECT_ID && option.attentionCount === 1));

    // Approve-and-begin consumes the proposal: its Attention clears with it.
    const begin = await post(`/api/task-proposals/${proposal.id}/begin`, {
      expectedRevision: proposal.revision,
      environmentInstanceId: INSTANCE_ID,
      lead: { memberId: 'operator', memberKind: 'human' },
      reason: 'Human approval',
    });
    assert.equal(begin.status, 201);
    const { task } = await begin.json() as { task: TaskView };
    feed = await readFeed(cookie);
    assert.deepEqual(feed.attention, [], 'a begun proposal is a cleared source');

    // A routable blocker is action-required Attention with a detail deep link.
    const blocker = await post(`/api/tasks/${task.id}/blockers`, {
      reason: 'Host permission is missing.',
      requiredAction: 'Grant the permission.',
      responsible: { kind: 'external-condition', condition: 'host permission' },
      nextAdvancer: { memberId: 'operator', memberKind: 'human' },
    });
    assert.equal(blocker.status, 200);
    feed = await readFeed(cookie);
    assert.deepEqual(feed.attention.map((item) => item.category), ['task-blocker']);
    assert.equal(feed.attention[0]?.severity, 'action_required');
    assert.equal(feed.attention[0]?.target.path, `/project/tasks/${task.id}`);
    assert.match(feed.attention[0]?.lifecycle, /Task blocked/);
    const scoped = await readFeed(cookie, `?scope=${encodeURIComponent(PROJECT_ID)}&urgency=action_required`);
    assert.deepEqual(scoped.attention.map((item) => item.category), ['task-blocker']);
    assert.equal((await fetch(new URL('/api/feed?scope=ghost', base), { headers: { cookie } })).status, 400);

    // Clearing the authoritative blocker clears the Attention item.
    const cleared = await post(`/api/tasks/${task.id}/clear-blocker`, { reason: 'Permission granted' });
    assert.equal(cleared.status, 200);
    feed = await readFeed(cookie);
    assert.deepEqual(feed.attention, []);

    // An admitted nested run puts the Task and its run in flight.
    const advance = await post(`/api/tasks/${task.id}/advances`, { targetAgentId: 'scout', reason: 'Deliberate advance' });
    assert.equal(advance.status, 202);
    const advanced = await advance.json() as { runId: string };
    feed = await readFeed(cookie);
    assert.deepEqual(feed.inFlight.map((item) => item.id).sort(), [`run:${advanced.runId}`, `task:${task.id}`]);
    assert.match(feed.inFlight.find((item) => item.id === `task:${task.id}`)?.lifecycle ?? '', /Agent run active · Lease held/);

    // Two-stage Human control settles the run so a completion claim can follow.
    assert.equal((await post(`/api/tasks/${task.id}/pause`, { reason: 'Human inspection' })).status, 200);
    assert.equal((await post(`/api/tasks/${task.id}/interrupt`, { reason: 'Settle the run' })).status, 200);
    feed = await readFeed(cookie);
    assert.ok(!feed.inFlight.some((item) => item.id === `run:${advanced.runId}`), 'the settled run leaves in-flight work');

    // A completion claim becomes validation Attention; the claim text stays out.
    const claim = await post(`/api/tasks/${task.id}/completion-claims`, {
      outcomeSummary: 'CLAIM_TEXT_THAT_MUST_NOT_LEAK',
      validationEvidence: ['journey evidence'],
      durableChanges: [],
      limitations: [],
      recommendedDisposition: 'complete',
    });
    assert.equal(claim.status, 200);
    const claimed = (await claim.json() as { task: TaskView }).task;
    feed = await readFeed(cookie);
    assert.deepEqual(feed.attention.map((item) => item.category), ['task-validation']);
    assert.equal(feed.attention[0]?.severity, 'attention');
    assert.equal(feed.attention[0]?.target.taskId, task.id);
    assert.ok(!JSON.stringify(feed).includes('CLAIM_TEXT_THAT_MUST_NOT_LEAK'));

    // No command path on the composed runtime can dismiss it.
    const dismiss = await fetch(
      new URL(`/api/feed/attention/${encodeURIComponent(`validation:${task.id}:${claimed.pendingCompletionClaimId}`)}/dismiss`, base),
      { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-sprout-csrf': csrfToken }, body: '{}' },
    );
    assert.equal(dismiss.status, 404);
    feed = await readFeed(cookie);
    assert.deepEqual(feed.attention.map((item) => item.category), ['task-validation'], 'the failed dismiss changed nothing');
  } finally {
    await runtime.close();
  }
});
