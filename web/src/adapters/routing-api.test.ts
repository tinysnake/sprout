import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRoutingBrowserAdapter,
  type RoutingBatchDetailView,
  type RoutingEvidenceView,
} from './routing-api.ts';
import { type BrowserTransport } from '../transport/browser-transport.ts';

/**
 * The typed browser adapter contract for routing evidence (#97).
 *
 * The adapter must hit exactly the documented additive read-only routes,
 * reject failures through the shared transport immediately, never fabricate a
 * fact (an unknown batch is a rejection, not a row), and — per ADR-0007's
 * "no routing controls in the MVP" — expose inspection only: no command
 * method exists on this adapter. The view shapes mirror `src/web/views.ts`.
 */

function recordingTransport(
  responder: (path: string, init?: RequestInit) => unknown,
): { readonly transport: BrowserTransport; readonly calls: { path: string; init?: RequestInit }[] } {
  const calls: { path: string; init?: RequestInit }[] = [];
  const transport: BrowserTransport = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    setCsrfToken: () => undefined,
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      calls.push(init === undefined ? { path } : { path, init });
      return responder(path, init) as T;
    },
    events: () => () => undefined,
  };
  return { transport, calls };
}

const batchDetail: RoutingBatchDetailView = {
  batch: {
    id: 'bat-1',
    projectId: 'project-sprout',
    windowId: 'win-1',
    splitIndex: 0,
    splitCount: 1,
    cutoffAt: 30_000,
    status: 'routed',
    createdAt: 30_000,
    settledAt: 30_100,
    bounds: {
      inputContentChars: 4_000,
      contextMessageChars: 1_000,
      recentContextMessages: 12,
      totalContextChars: 48_000,
    },
    manifest: {
      projectId: 'project-sprout',
      windowId: 'win-1',
      cutoffAt: 30_000,
      policy: 'wake-model-assisted',
      bounds: {
        inputContentChars: 4_000,
        contextMessageChars: 1_000,
        recentContextMessages: 12,
        totalContextChars: 48_000,
      },
      inputs: [
        {
          inputId: 'msg-1',
          kind: 'message',
          authorId: 'operator',
          createdAt: 1_000,
          scopeId: 'channel-project-sprout',
          candidates: ['agent-scout'],
          excerptChars: 12,
          contentChars: 12,
          truncated: false,
        },
      ],
      candidates: [
        { agentId: 'agent-scout', responsibilities: ['Investigate'], collaborationInstructions: '' },
      ],
      tasks: [],
      recentContextIds: [],
      ancestorContextIds: [],
      exclusions: ['direct Messages and their replies'],
      contextChars: 900,
    },
    contextChars: 900,
  },
  window: {
    id: 'win-1',
    projectId: 'project-sprout',
    openedAt: 0,
    deadlineAt: 30_000,
    intervalMs: 30_000,
    status: 'closed',
    cursor: 'msg-1',
    inputCount: 1,
    closedAt: 30_000,
  },
  inputs: [
    {
      inputId: 'msg-1',
      position: 0,
      excerpt: 'please triage',
      truncated: false,
      excerptChars: 12,
      contentChars: 12,
    },
  ],
  attempts: [
    {
      id: 'att-1',
      batchId: 'bat-1',
      attemptNumber: 1,
      modelId: 'wake-model',
      startedAt: 30_010,
      finishedAt: 30_090,
      status: 'succeeded',
    },
  ],
  outcomes: [
    {
      inputId: 'msg-1',
      status: 'selected',
      assignments: [{ agentId: 'agent-scout', rationale: 'Falls to the investigator.' }],
      settledAt: 30_100,
    },
  ],
  wakes: [{ agentId: 'agent-scout', reason: 'routing-model', status: 'admitted', batchId: 'bat-1' }],
  replies: [{ idempotencyKey: 'bat-1:agent-scout', messageId: 'reply-bat-1:agent-scout' }],
};

const evidence: RoutingEvidenceView = {
  input: {
    kind: 'message',
    message: { id: 'msg-1', body: 'please triage', projectId: 'project-sprout' },
  },
  window: batchDetail.window,
  batches: [batchDetail],
  deterministicWakes: [],
  observations: [],
};

test('the routing adapter hits exactly the additive read-only evidence routes', async () => {
  const { transport, calls } = recordingTransport((path) => {
    if (path.endsWith('/routing-batches')) return { windows: [], batches: [] };
    if (path === '/api/routing-batches/bat-1') return { routingBatch: batchDetail };
    if (path === '/api/messages/msg-1/routing') return { routing: evidence };
    if (path === '/api/project-events/evt-1/routing') return { routing: evidence };
    throw new Error(`unexpected path: ${path}`);
  });
  const adapter = createRoutingBrowserAdapter(transport);

  const listed = await adapter.listRoutingBatches('project-sprout');
  assert.deepEqual(listed, { windows: [], batches: [] });

  const batch = await adapter.getRoutingBatch('bat-1');
  assert.equal(batch.batch.id, 'bat-1');
  assert.equal(batch.batch.manifest.policy, 'wake-model-assisted');
  assert.equal(batch.inputs[0]?.truncated, false);
  assert.equal(batch.outcomes[0]?.status, 'selected');
  assert.equal(batch.wakes[0]?.reason, 'routing-model');
  assert.equal(batch.replies[0]?.messageId, 'reply-bat-1:agent-scout');
  assert.equal(batch.attempts[0]?.status, 'succeeded');

  const messageRouting = await adapter.messageRouting('msg-1');
  assert.equal(messageRouting.input.kind, 'message');
  assert.equal(messageRouting.batches[0]?.batch.id, 'bat-1');
  assert.equal(messageRouting.window?.id, 'win-1');

  await adapter.eventRouting('evt-1');

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/projects/project-sprout/routing-batches',
      '/api/routing-batches/bat-1',
      '/api/messages/msg-1/routing',
      '/api/project-events/evt-1/routing',
    ],
    'every call is a documented GET route',
  );
  assert.ok(
    calls.every((call) => call.init === undefined),
    'evidence routes are reads: no request body is ever sent',
  );
});

test('the routing adapter rejects on transport failure instead of fabricating a fact', async () => {
  const { transport } = recordingTransport(() => {
    throw new Error('404 unknown routing batch: bat-missing');
  });
  const adapter = createRoutingBrowserAdapter(transport);
  await assert.rejects(
    () => adapter.getRoutingBatch('bat-missing'),
    /unknown routing batch/,
    'an unknown batch is a rejection, not an empty row',
  );
  await assert.rejects(() => adapter.messageRouting('msg-missing'), /unknown routing batch/);
});

test('the routing adapter exposes inspection only — MVP routing has no controls', () => {
  const { transport } = recordingTransport(() => ({}));
  const adapter = createRoutingBrowserAdapter(transport);
  const methods = Object.keys(adapter).sort();
  assert.deepEqual(methods, [
    'getRoutingBatch',
    'listRoutingBatches',
    'messageRouting',
    'state',
    'subscribeState',
    'eventRouting',
  ].sort(), 'no route-now, retry, override, or cancel command exists (ADR-0007)');
});
