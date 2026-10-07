import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCollaborationStore } from '../collaboration/sqlite-store.ts';
import { InMemoryCollaborationStore, type CollaborationStore } from '../collaboration/store.ts';
import { freezeRoutingBatches } from '../collaboration/routing-context.ts';
import { build, privateInput, signIn } from './api-harness.ts';
import { createRunApi } from './api.ts';
import { createCollaborationAttentionRouter } from './collaboration-attention-router.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { OperatorSessionService } from '../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../auth/store.ts';
import { planWake } from '../collaboration/wake.ts';
import { projectFeed, isFeedDeepLink, type FeedSources } from './feed.ts';

function sources(store: CollaborationStore): FeedSources {
  return {
    projects: async () => [{ id: 'project', displayName: 'Project' }],
    tasks: async () => [], proposals: async () => [], events: () => store.listEvents(),
    enrollments: async () => [], recoveries: async () => [], runs: async () => [],
    routingBatches: () => store.listRoutingBatches(),
    wakeFailures: () => store.listWakeFailures(),
    attentionResolutions: () => store.listAttentionResolutions(),
  };
}

for (const target of ['agent-unknown', 'agent-ended']) {
  test(`failed deterministic address to ${target} becomes sanitized Attention and clears durably`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-feed-wake-'));
    const filename = join(directory, 'store.db');
    let store = new SqliteCollaborationStore({ filename });
    try {
      const message = {
        id: 'input', projectId: 'project', scopeId: 'scope', channel: 'project' as const,
        author: { id: 'operator', kind: 'human' as const }, body: `@${target} PRIVATE_MESSAGE_PROSE`,
        recipients: [], deliveryKey: 'delivery', createdAt: 1,
      };
      const plan = planWake(message, {
        scope: { kind: 'project' }, wakePolicy: 'explicit-only',
        members: [{ memberId: 'agent-ended', memberKind: 'agent', endedAt: 1 }],
      });
      assert.equal(plan.observations[0]?.status, 'failed');
      await store.postMessage({ message, plan, now: 1 });
      // Legacy diagnostic prose is structurally excluded from the Feed.
      await store.recordObservation({ inputId: 'input', observation: {
        agentId: target, status: 'failed', reason: 'agent-mention', detail: 'PRIVATE_DIAGNOSTIC_PROSE',
      }, now: 2 });
      const before = await projectFeed(sources(store));
      assert.equal(before.attention.length, 1);
      assert.equal(before.attention[0]?.category, 'routing-failure');
      assert.equal(before.attention[0]?.source.kind, 'wake-input');
      assert.ok(isFeedDeepLink(before.attention[0]?.target));
      assert.match(before.attention[0]?.lifecycle ?? '', /Routing failed ·/);
      assert.ok(!JSON.stringify(before).includes('PRIVATE_'));
      await store.resolveAttention({ projectId: 'project', kind: 'wake-input', sourceId: 'input', actor: { id: 'operator', kind: 'human' }, now: 3 });
      store.close();
      store = new SqliteCollaborationStore({ filename });
      assert.equal((await projectFeed(sources(store))).attention.length, 0);
      assert.equal((await store.listObservations('input')).length, 2, 'failure evidence stays intact');
      await store.recordObservation({ inputId: 'input', observation: plan.observations[0]!, now: 2 });
      assert.equal((await projectFeed(sources(store))).attention.length, 1, 'a later failure reopens attention even without a later timestamp');
      await store.resolveAttention({ projectId: 'project', kind: 'wake-input', sourceId: 'input', actor: { id: 'operator', kind: 'human' }, now: 4 });
      assert.equal((await projectFeed(sources(store))).attention.length, 0);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const backend of ['memory', 'sqlite'] as const) {
  test(`failed batches clear through Human resolution in ${backend} without rerouting`, async () => {
    const store = backend === 'memory' ? new InMemoryCollaborationStore() : new SqliteCollaborationStore({ filename: ':memory:' });
    try {
      const event = {
        id: 'eligible', projectId: 'project', kind: 'operational', summary: 'Route this fact',
        producer: { id: 'sprout', kind: 'system' as const }, disposition: 'wake-eligible' as const,
        responsibleAgentIds: [], deliveryKey: 'eligible', createdAt: 1,
      };
      const published = await store.publishEvent({ event, plan: { inputId: event.id, decisions: [], observations: [] }, now: 1, collect: { intervalMs: 1000 } });
      const plans = freezeRoutingBatches({
        window: published.window!, inputs: [{ inputId: event.id, kind: 'event', authorId: 'sprout', createdAt: 1, scopeId: '', content: event.summary, candidates: [] }],
        contract: { projectId: 'project', goal: '', rules: [], candidates: [] }, recentContext: [], messageById: () => undefined, now: 1001, createBatchId: () => 'batch',
      });
      await store.freezeRoutingWindow({ windowId: published.window!.id, batches: plans, now: 1001 });
      await store.settleRoutingBatch({ batchId: 'batch', status: 'failed', outcomes: [], now: 1002 });
      assert.equal((await projectFeed(sources(store))).attention.length, 1);
      await store.resolveAttention({ projectId: 'project', kind: 'routing-batch', sourceId: 'batch', actor: { id: 'operator', kind: 'human' }, now: 1003 });
      assert.equal((await projectFeed(sources(store))).attention.length, 0);
      assert.equal((await store.getRoutingBatch('batch'))?.status, 'failed');
      assert.equal((await store.listWakeRequests()).length, 0);
      await assert.rejects(() => store.resolveAttention({ projectId: 'project', kind: 'event', sourceId: event.id, actor: { id: 'operator', kind: 'human' }, now: 1004 }), /source/);
    } finally { if (store instanceof SqliteCollaborationStore) store.close(); }
  });
}

test('collaboration resolution requires the operator session and CSRF and ignores a supplied actor', async () => {
  const store = new InMemoryCollaborationStore();
  const event = {
    id: 'event', projectId: 'project', kind: 'approval', summary: 'Human action required',
    producer: { id: 'sprout', kind: 'system' as const }, disposition: 'human-action-required' as const,
    responsibleAgentIds: [], deliveryKey: 'event', createdAt: 1,
  };
  await store.publishEvent({ event, plan: { inputId: event.id, decisions: [], observations: [] }, now: 1 });
  const credential = privateInput();
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  await auth.initializeOrRecover(credential);
  const context = build();
  const api = createRunApi({ orchestrator: context.orchestrator, agents: new AgentRegistry([]), auth,
    routers: [createCollaborationAttentionRouter({ store, now: () => 2 })] });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const url = `${base}/api/projects/project/collaboration-attention/event/event/resolve`;
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const session = await signIn(base, credential);
    assert.equal((await fetch(url, { method: 'POST', headers: { cookie: session.cookie } })).status, 403);
    const response = await fetch(url, { method: 'POST', headers: { cookie: session.cookie, 'x-sprout-csrf': session.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ actor: { id: 'agent', kind: 'agent' } }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await store.listAttentionResolutions(), [{ projectId: 'project', kind: 'event', sourceId: 'event', humanId: 'operator', resolvedAt: 2, sourceVersion: 0 }]);
    assert.deepEqual(await store.getEvent('event'), event);
  } finally { await api.close(); }
});

test('only a Human can resolve event Attention, with the fact intact after SQLite reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-feed-resolution-'));
  const filename = join(directory, 'store.db');
  let store = new SqliteCollaborationStore({ filename });
  try {
    const event = {
      id: 'event', projectId: 'project', kind: 'approval', summary: 'Human action required',
      producer: { id: 'sprout', kind: 'system' as const }, disposition: 'human-action-required' as const,
      responsibleAgentIds: [], deliveryKey: 'event-key', createdAt: 1,
    };
    await store.publishEvent({ event, plan: { inputId: event.id, decisions: [], observations: [] }, now: 1 });
    assert.equal((await projectFeed(sources(store))).attention.length, 1);
    store.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec('DROP TABLE collaboration_attention_resolutions; PRAGMA user_version = 23;');
    legacy.close();
    store = new SqliteCollaborationStore({ filename });
    assert.equal((await projectFeed(sources(store))).attention.length, 1, 'v23 migration preserves unresolved event Attention');
    const input = { projectId: 'project', kind: 'event' as const, sourceId: event.id, now: 2 };
    await assert.rejects(() => store.resolveAttention({ ...input, actor: { id: 'agent', kind: 'agent' } }), /Human/);
    assert.equal((await projectFeed(sources(store))).attention.length, 1);
    await assert.rejects(() => store.resolveAttention({ ...input, projectId: 'other', actor: { id: 'operator', kind: 'human' } }), /source/);
    await store.resolveAttention({ ...input, actor: { id: 'operator', kind: 'human' } });
    await store.resolveAttention({ ...input, now: 3, actor: { id: 'operator', kind: 'human' } });
    store.close();
    store = new SqliteCollaborationStore({ filename });
    const after = await projectFeed(sources(store));
    assert.equal(after.attention.length, 0);
    assert.ok(after.activity.some(item => item.id === 'event:event'));
    assert.deepEqual(await store.getEvent(event.id), event);
    assert.equal((await store.listAttentionResolutions()).length, 1, 'resolution retries are idempotent');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
