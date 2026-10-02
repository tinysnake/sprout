import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReplyProjectionApi } from './api-harness.ts';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForActiveRun(base: string, cookie: string, scopeId: string) {
  const path = `/api/chat/scopes/${encodeURIComponent(scopeId)}/active-runs`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${base}${path}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json() as { readonly runs: readonly { readonly id: string; readonly agentId: string; readonly status: string }[] };
    if (body.runs.length > 0) return body.runs;
    await settle(10);
  }
  assert.fail('the active Chat run was not projected');
}

test('Chat projects active run state, Human stop releases its lease before the next message, and interruption is recorded', async () => {
  const server = await buildReplyProjectionApi({ turns: [
    { events: [{ type: 'notice', text: 'private run progress' }], result: { status: 'completed', text: 'first turn' }, settleAfterMs: 5_000 },
    { events: [{ type: 'message', text: 'next turn', final: true }], result: { status: 'completed', text: 'next turn' } },
  ] });
  const path = `/api/chat/scopes/${encodeURIComponent(server.directScopeId)}/active-runs`;
  try {
    assert.equal((await fetch(`${server.base}${path}`)).status, 401);

    const send = (body: string, deliveryKey: string) => fetch(`${server.base}/api/messages`, {
      method: 'POST',
      headers: { cookie: server.cookie, 'x-sprout-csrf': server.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ scopeId: server.directScopeId, body, recipients: ['agent-scout'], deliveryKey, awaitReply: false }),
    });
    const first = await send('start a long chat run', 'chat-stop-1');
    assert.equal(first.status, 202);
    const firstBody = await first.json() as { readonly admittedRunIds: readonly string[] };
    const runId = firstBody.admittedRunIds[0];
    assert.ok(runId);

    const active = await waitForActiveRun(server.base, server.cookie, server.directScopeId);
    assert.deepEqual(active.map(({ id, agentId }) => ({ id, agentId })), [
      { id: runId, agentId: 'agent-scout' },
    ]);
    assert.ok(active[0]?.status === 'queued' || active[0]?.status === 'running');
    assert.doesNotMatch(JSON.stringify(active), /prompt|events|private run progress|engine/);
    const refreshed = await fetch(`${server.base}${path}`, { headers: { cookie: server.cookie } });
    assert.equal((await refreshed.json() as { readonly runs: readonly unknown[] }).runs.length, 1,
      'a fresh status read during the run receives the same authoritative active projection');

    const stopPath = `/api/chat/scopes/${encodeURIComponent(server.directScopeId)}/runs/${encodeURIComponent(runId)}/stop`;
    const wrongScopeStop = await fetch(`${server.base}/api/chat/scopes/${encodeURIComponent(server.channelScopeId)}/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST', headers: { cookie: server.cookie, 'x-sprout-csrf': server.csrf },
    });
    assert.equal(wrongScopeStop.status, 404, 'a Chat control cannot stop a run from another conversation');
    assert.equal((await fetch(`${server.base}${stopPath}`, { method: 'POST', headers: { cookie: server.cookie } })).status, 403,
      'Human stop requires the session CSRF proof');
    const stoppedResponse = await fetch(`${server.base}${stopPath}`, {
      method: 'POST',
      headers: { cookie: server.cookie, 'x-sprout-csrf': server.csrf },
    });
    assert.equal(stoppedResponse.status, 200);
    assert.deepEqual(await stoppedResponse.json(), { id: runId, status: 'interrupted' });
    const stopped = await server.orchestrator.load(runId);
    assert.equal(stopped?.interruptionReason, 'human-stop');
    assert.equal(server.orchestrator.leases().find((lease) => lease.runId === runId)?.state, 'released');
    assert.equal((await server.orchestrator.waitFor(runId)).status, 'interrupted');

    const next = await send('send the next chat message', 'chat-stop-2');
    assert.equal(next.status, 202);
    const nextBody = await next.json() as { readonly admittedRunIds: readonly string[] };
    assert.equal(nextBody.admittedRunIds.length, 1);
    const nextRun = await server.orchestrator.waitFor(nextBody.admittedRunIds[0]!);
    assert.equal(nextRun.status, 'completed', 'the next message is admitted without an environment-busy failure');

    const events = await server.collaboration.listEvents(server.projectId);
    const interruption = events.find((event) => event.kind === 'agent-run-interruption');
    assert.equal(interruption?.summary, 'Agent run interrupted for agent-scout');
    assert.equal(interruption?.detail, `run ${runId} · agent agent-scout · Reason: stopped by Human`);
    assert.deepEqual(interruption?.originScopeIds, [server.directScopeId]);

    const settled = await fetch(`${server.base}${path}`, { headers: { cookie: server.cookie } });
    assert.deepEqual(await settled.json(), { runs: [] });
    assert.equal((await fetch(`${server.base}${stopPath}`, {
      method: 'POST', headers: { cookie: server.cookie, 'x-sprout-csrf': server.csrf },
    })).status, 200, 'repeating stop on the settled run is an idempotent no-op');
  } finally {
    await server.api.close();
  }
});
