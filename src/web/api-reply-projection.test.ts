import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReplyProjectionApi } from './api-harness.ts';
import type { ReplyProjectionApi } from './api-harness.ts';
import {
  REPLY_PROJECTION_AGENT_ID as REPLY_AGENT_ID,
  REPLY_PROJECTION_OPERATOR_ID as REPLY_OPERATOR_ID,
} from './api-harness.ts';

/**
 * Reply projection evidence for #184: an engine reply produced by a real run
 * becomes a durable Agent Message in the originating conversation scope — for
 * all three scope kinds — with `inReplyTo` linkage and story-65 routing
 * evidence, and never for a run that fails or completes with no text.
 *
 * Everything here runs through the production HTTP routes (delivery, message
 * list, routing evidence, run status) over the real transport; no Message is
 * ever written by the test.
 */

interface MessageWire {
  readonly id: string;
  readonly authorKind: string;
  readonly authorId: string;
  readonly body: string;
  readonly scopeId: string;
  readonly inReplyTo?: string;
}

interface EvidenceWire {
  readonly window?: unknown;
  readonly batches: readonly unknown[];
  readonly deterministicWakes: readonly { readonly agentId: string; readonly runId?: string }[];
  readonly observations: readonly unknown[];
}

async function postMessage(
  api: ReplyProjectionApi,
  input: {
    readonly scopeId: string;
    readonly body: string;
    readonly deliveryKey: string;
    readonly awaitReply?: boolean;
    readonly recipients?: readonly string[];
  },
): Promise<{ readonly status: number; readonly body: { readonly message: MessageWire; readonly admittedRunIds: readonly string[] } }> {
  const response = await fetch(`${api.base}/api/messages`, {
    method: 'POST',
    headers: { cookie: api.cookie, 'x-sprout-csrf': api.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({
      scopeId: input.scopeId,
      authorId: REPLY_OPERATOR_ID,
      authorKind: 'human',
      body: input.body,
      deliveryKey: input.deliveryKey,
      ...(input.awaitReply === undefined ? {} : { awaitReply: input.awaitReply }),
      ...(input.recipients === undefined ? {} : { recipients: input.recipients }),
    }),
  });
  return {
    status: response.status,
    body: await response.json() as { readonly message: MessageWire; readonly admittedRunIds: readonly string[] },
  };
}

async function listScopeMessages(api: ReplyProjectionApi, scopeId: string): Promise<readonly MessageWire[]> {
  const response = await fetch(`${api.base}/api/messages?scopeId=${encodeURIComponent(scopeId)}`, {
    headers: { cookie: api.cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { readonly messages: readonly MessageWire[] };
  return body.messages;
}

interface FailureEventWire {
  readonly kind: string;
  readonly disposition: string;
  readonly summary: string;
  readonly detail: string;
  readonly producerId: string;
  readonly producerKind: string;
}

async function listProjectEvents(api: ReplyProjectionApi): Promise<readonly FailureEventWire[]> {
  const response = await fetch(`${api.base}/api/projects/${encodeURIComponent(api.projectId)}/events`, {
    headers: { cookie: api.cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { readonly events: readonly FailureEventWire[] };
  return body.events;
}

async function readEvidence(api: ReplyProjectionApi, messageId: string): Promise<EvidenceWire> {
  const response = await fetch(
    `${api.base}/api/messages/${encodeURIComponent(messageId)}/routing`,
    { headers: { cookie: api.cookie } },
  );
  assert.equal(response.status, 200, `routing evidence exists for ${messageId}`);
  const body = await response.json() as { readonly routing: EvidenceWire };
  return body.routing;
}

async function waitFor(
  label: string,
  condition: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${label} was not observed within ${timeoutMs}ms`);
}

test('a completed run projects its reply into the Project channel, Working group, and direct scope with inReplyTo and story-65 evidence', async () => {
  const api = await buildReplyProjectionApi({
    turns: [
      { events: [{ type: 'message', text: 'Channel reply.', final: true }], result: { status: 'completed', text: 'Channel reply.' } },
      { events: [{ type: 'message', text: 'Group reply.', final: true }], result: { status: 'completed', text: 'Group reply.' } },
      { events: [{ type: 'message', text: 'Direct reply.', final: true }], result: { status: 'completed', text: 'Direct reply.' } },
    ],
  });
  try {
    const cases = [
      {
        scopeId: api.channelScopeId,
        body: `@${REPLY_AGENT_ID} please summarize the reply path.`,
        reply: 'Channel reply.',
      },
      {
        scopeId: api.workingGroupScopeId,
        body: `@${REPLY_AGENT_ID} review the working group reply.`,
        reply: 'Group reply.',
      },
      {
        scopeId: api.directScopeId,
        body: 'Answer me directly.',
        reply: 'Direct reply.',
      },
    ] as const;

    for (const scopeCase of cases) {
      const delivered = await postMessage(api, {
        scopeId: scopeCase.scopeId,
        body: scopeCase.body,
        deliveryKey: `reply-evidence-${scopeCase.scopeId}`,
      });
      assert.equal(delivered.status, 202, 'the input is durable before its reply');
      assert.equal(delivered.body.admittedRunIds.length, 1, 'the input wakes one run');

      const messages = await listScopeMessages(api, scopeCase.scopeId);
      assert.ok(
        messages.every((message) => message.scopeId === scopeCase.scopeId),
        'every message of the conversation belongs to its scope',
      );
      const reply = messages.find((message) => message.authorKind === 'agent');
      assert.ok(reply, `the reply renders in scope ${scopeCase.scopeId}`);
      assert.equal(reply.body, scopeCase.reply, 'the reply body is the engine run final text');
      assert.equal(reply.authorId, REPLY_AGENT_ID, 'the reply is attributed to the Agent');
      assert.equal(reply.inReplyTo, delivered.body.message.id, 'the reply links to the human input');

      // Story 65: the reply's own evidence is the projected, non-routing state,
      // and the input's evidence carries the wake → run chain the page opens.
      const replyEvidence = await readEvidence(api, reply.id);
      assert.equal(replyEvidence.window, undefined, 'a projected reply owns no routing window');
      assert.equal(replyEvidence.batches.length, 0, 'a projected reply is in no batch');
      assert.equal(replyEvidence.deterministicWakes.length, 0, 'a projected reply never routes');
      assert.equal(replyEvidence.observations.length, 0, 'a projected reply produces no wake outcome');

      const inputEvidence = await readEvidence(api, delivered.body.message.id);
      assert.equal(inputEvidence.deterministicWakes.length, 1, 'the input carries its one wake');
      const wake = inputEvidence.deterministicWakes[0]!;
      assert.equal(wake.agentId, REPLY_AGENT_ID, 'the wake names the answering Agent');
      assert.ok(wake.runId, 'the wake links the run that produced the reply');
      const run = await api.readRun(wake.runId!);
      assert.equal(run.status, 'completed', 'the linked run completed');
    }
  } finally {
    await api.api.close();
  }
});

test('with the browser delivery shape (awaitReply false) the input is durable first and the reply arrives only after the run settles', async () => {
  const api = await buildReplyProjectionApi({
    turns: [
      { events: [{ type: 'message', text: 'Settled later.', final: true }], result: { status: 'completed', text: 'Settled later.' }, settleAfterMs: 500 },
    ],
  });
  try {
    const delivered = await postMessage(api, {
      scopeId: api.directScopeId,
      body: 'Reply when you are done.',
      deliveryKey: 'reply-no-yet-1',
      awaitReply: false,
    });
    assert.equal(delivered.status, 202);

    const beforeSettlement = await listScopeMessages(api, api.directScopeId);
    assert.equal(beforeSettlement.length, 1, 'only the human input exists before the run settles');
    assert.equal(beforeSettlement[0]?.authorKind, 'human');
    assert.equal(
      beforeSettlement.some((message) => message.authorKind === 'agent'),
      false,
      'no reply exists while the run is still open',
    );

    await waitFor('the projected reply after run settlement', async () => {
      const messages = await listScopeMessages(api, api.directScopeId);
      return messages.some((message) => message.authorKind === 'agent');
    });
    const afterSettlement = await listScopeMessages(api, api.directScopeId);
    const reply = afterSettlement.find((message) => message.authorKind === 'agent');
    assert.equal(reply?.body, 'Settled later.');
    assert.equal(reply?.inReplyTo, delivered.body.message.id);
  } finally {
    await api.api.close();
  }
});

test('a failed run and an empty #182-style completion never project a phantom reply', async () => {
  const api = await buildReplyProjectionApi({
    turns: [
      {
        events: [{ type: 'message', text: 'engine refused', final: true }],
        result: { status: 'failed', message: 'arbitrary engine diagnostic MUST NOT SURFACE' },
      },
      {
        events: [],
        result: { status: 'completed', text: '' },
      },
    ],
  });
  try {
    const failedRun = await postMessage(api, {
      scopeId: api.directScopeId,
      body: 'This run fails instead of replying.',
      deliveryKey: 'reply-failure-1',
      awaitReply: false,
    });
    assert.equal(failedRun.status, 202);
    assert.equal(failedRun.body.admittedRunIds.length, 1);
    await waitFor('the failed run to settle', async () => {
      const run = await api.readRun(failedRun.body.admittedRunIds[0]!);
      return run.status === 'failed' || run.status === 'completed';
    });
    const failedRunStatus = await api.readRun(failedRun.body.admittedRunIds[0]!);
    assert.equal(failedRunStatus.status, 'failed', 'the errored turn settles its run as failed');
    await waitFor('the #180 Project failure event', async () =>
      (await listProjectEvents(api)).some((event) => event.kind === 'agent-run-failure'));
    const failureEvents = await listProjectEvents(api);
    assert.equal(failureEvents.length, 1, 'one failure entry is produced for the failed run');
    const event = failureEvents[0]!;
    assert.equal(event.kind, 'agent-run-failure');
    assert.equal(event.disposition, 'informational', 'the failure entry cannot route or wake');
    assert.equal(event.producerId, 'sprout');
    assert.equal(event.producerKind, 'system');
    assert.match(event.summary, /Agent run failed \(execution\)/);
    assert.match(event.detail, /run /);
    assert.doesNotMatch(`${event.summary} ${event.detail}`, /MUST NOT SURFACE|arbitrary engine diagnostic/,
      'the failure class and reason are sanitized rather than engine text');

    const emptyRun = await postMessage(api, {
      scopeId: api.directScopeId,
      body: 'This run completes with no text.',
      deliveryKey: 'reply-failure-2',
      awaitReply: false,
    });
    assert.equal(emptyRun.status, 202);
    await waitFor('the empty completion to settle', async () => {
      const run = await api.readRun(emptyRun.body.admittedRunIds[0]!);
      return run.status !== 'running' && run.status !== 'queued';
    });

    // Allow a (wrong) deferred projection every chance to appear, then prove
    // none exists: neither outcome may ever render as a reply.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const messages = await listScopeMessages(api, api.directScopeId);
    assert.equal((await listProjectEvents(api)).length, 1, 'empty completion adds no failure event');
    assert.equal(messages.length, 2, 'exactly the two human inputs exist — no reply was fabricated');
    assert.ok(
      messages.every((message) => message.authorKind === 'human'),
      'a failed run and an empty completion render no agent-authored message',
    );
    const failedInputEvidence = await readEvidence(api, failedRun.body.message.id);
    assert.equal(
      failedInputEvidence.deterministicWakes.some((wake) => wake.runId === failedRun.body.admittedRunIds[0]),
      true,
      'the failure stays inspectable through the input wake → run chain, never as a reply',
    );
  } finally {
    await api.api.close();
  }
});
