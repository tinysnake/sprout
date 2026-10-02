import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCollaborationStore } from '../collaboration/sqlite-store.ts';
import { InMemoryCollaborationStore } from '../collaboration/store.ts';
import { ConversationScopeService } from '../conversation/service.ts';
import { InMemoryConversationScopeStore } from '../conversation/store.ts';
import { createChatReadRouter } from './chat-read-router.ts';
import { createRunApi } from './api.ts';
import { build, privateInput, signIn } from './api-harness.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { OperatorSessionService } from '../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../auth/store.ts';

for (const backend of ['memory', 'sqlite'] as const) {
  test(`${backend}: authenticated count-only unread projection and receipts preserve private scope boundaries across reload`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-read-api-'));
    const filename = join(directory, 'store.db');
    let store = backend === 'memory' ? new InMemoryCollaborationStore() : new SqliteCollaborationStore({ filename });
    const scopes = new ConversationScopeService({ store: new InMemoryConversationScopeStore(), projects: { projectFacts: async (id) => id === 'project' ? { projectId: id, status: 'active', contentVersion: 1, goal: '', rules: [], members: [{ memberId: 'operator', memberKind: 'human' }, { memberId: 'agent-a', memberKind: 'agent' }, { memberId: 'agent-b', memberKind: 'agent' }, { memberId: 'agent-active', memberKind: 'agent' }, { memberId: 'agent-archived', memberKind: 'agent' }] } : undefined } });
    const channel = await scopes.ensureProjectChannel('project');
    const privateScope = await scopes.openDirect({ projectId: 'project', participants: ['agent-a', 'agent-b'] });
    const activeDirectScope = await scopes.openDirect({ projectId: 'project', participants: ['operator', 'agent-active'] });
    const archivedDirectScope = await scopes.openDirect({ projectId: 'project', participants: ['operator', 'agent-archived'] });
    const group = await scopes.createWorkingGroup({ projectId: 'project', displayName: 'Retired group', creator: { memberId: 'operator', kind: 'human' } });
    await scopes.disbandWorkingGroup(group.id, { memberId: 'operator', kind: 'human' });
    for (const scope of [channel, privateScope, group, activeDirectScope, archivedDirectScope]) {
      await store.postMessage({ message: { id: scope.id, scopeId: scope.id, projectId: 'project', channel: 'project', author: { id: 'agent-a', kind: 'agent' }, body: 'PRIVATE_MESSAGE_BODY', recipients: [], deliveryKey: scope.id, createdAt: 1 }, plan: { inputId: scope.id, decisions: [], observations: [] }, now: 1 });
    }
    const credential = privateInput();
    const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() }); await auth.initializeOrRecover(credential);
    const agents = { get: async (id: string) => ({ status: id === 'agent-archived' ? 'archived' as const : 'active' as const }) };
    const api = createRunApi({ orchestrator: build().orchestrator, agents: new AgentRegistry([]), auth, routers: [{ name: 'read-test', handle: (context) => createChatReadRouter({ store, scopes, agents }).handle(context) }] });
    const testPortBase = Number(process.env['DEV_PIPELINE_PORT_BASE'] ?? 0);
    const { port } = await api.listen(testPortBase ? testPortBase + (backend === 'memory' ? 1 : 2) : 0);
    const base = `http://127.0.0.1:${port}`;
    try {
      assert.equal((await fetch(`${base}/api/chat/unread`)).status, 401);
      const session = await signIn(base, credential);
      const get = async () => (await fetch(`${base}/api/chat/unread`, { headers: { cookie: session.cookie } })).json() as Promise<{ scopes: { scopeId: string; projectId: string; count: number }[] }>;
      const before = await get();
      assert.deepEqual(Object.fromEntries(before.scopes.map(({ scopeId, projectId, count }) => [scopeId, { projectId, count }])), {
        [channel.id]: { projectId: 'project', count: 1 },
        [group.id]: { projectId: 'project', count: 0 },
        [activeDirectScope.id]: { projectId: 'project', count: 1 },
      }, 'the projection retains active Human direct scopes and suppresses archived Agent direct scopes');
      assert.ok(!JSON.stringify(before).includes('PRIVATE'));
      const path = `${base}/api/scopes/${encodeURIComponent(channel.id)}/read`;
      assert.equal((await fetch(path, { method: 'POST', headers: { cookie: session.cookie } })).status, 403);
      const post = async (scopeId: string, messageIds: readonly string[]) => fetch(`${base}/api/scopes/${encodeURIComponent(scopeId)}/read`, { method: 'POST', headers: { cookie: session.cookie, 'x-sprout-csrf': session.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ messageIds, humanId: 'agent-a' }) });
      assert.equal((await post(privateScope.id, [privateScope.id])).status, 404);
      assert.equal((await post(channel.id, [channel.id, privateScope.id])).status, 400);
      assert.equal((await get()).scopes.find((scope) => scope.scopeId === channel.id)?.count, 1, 'invalid mixed receipts are atomic');
      const archivedReceipt = await post(archivedDirectScope.id, [archivedDirectScope.id]);
      assert.equal(archivedReceipt.status, 200, 'archived scope history remains available to its Human for read receipts');
      assert.deepEqual(await archivedReceipt.json(), { scopeId: archivedDirectScope.id, projectId: 'project', count: 0 });
      const response = await post(channel.id, [channel.id]); assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { scopeId: channel.id, projectId: 'project', count: 0 });
      if (store instanceof SqliteCollaborationStore) { store.close(); store = new SqliteCollaborationStore({ filename }); }
      assert.equal((await get()).scopes.find((scope) => scope.scopeId === channel.id)?.count, 0, 'a new store connection returns the durable receipt');
      assert.equal(await store.unreadCount(channel.id, 'agent-b'), 1, 'client actor fields cannot choose the marker owner');
    } finally { await api.close(); if (store instanceof SqliteCollaborationStore) store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
