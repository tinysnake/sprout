import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createConversationBrowserAdapter,
  type ConversationScopeView,
  type ScopeInspectionView,
  type WorkingGroupScopeView,
} from './conversation-api.ts';
import { type BrowserTransport } from '../transport/browser-transport.ts';

/**
 * The typed browser adapter contract for conversation scopes and Working
 * groups (#95).
 *
 * The adapter must hit exactly the documented additive routes, send commands
 * as POST JSON bodies, reject failures through the shared transport
 * immediately, and never fabricate a fact (an unknown scope is a rejection,
 * not a row). The view shapes mirror `src/web/views.ts`.
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

const channel: ConversationScopeView = {
  id: 'channel-project-sprout',
  projectId: 'project-sprout',
  kind: 'project',
  createdAt: 1_000,
  updatedAt: 1_000,
};

const direct: ConversationScopeView = {
  id: 'dm-abc',
  projectId: 'project-sprout',
  kind: 'direct',
  participants: ['agent-scout', 'operator'],
  createdAt: 1_000,
  updatedAt: 1_000,
};

const group: WorkingGroupScopeView = {
  id: 'wg-1',
  projectId: 'project-sprout',
  kind: 'working-group',
  creatorId: 'operator',
  status: 'active',
  content: {
    currentVersion: 2,
    versions: [
      {
        version: 1,
        at: 1_000,
        actorMemberId: 'operator',
        reason: 'Created.',
        displayName: 'Core Mechanics',
        goal: 'Design.',
        rules: ['Keep the loop short.'],
      },
      {
        version: 2,
        at: 2_000,
        actorMemberId: 'operator',
        reason: 'Replan.',
        displayName: 'Core Mechanics',
        goal: 'Revised.',
        rules: [],
      },
    ],
  },
  memberships: [
    { memberId: 'operator', memberKind: 'human', addedAt: 1_000, addedBy: 'operator' },
    { memberId: 'agent-scout', memberKind: 'agent', addedAt: 1_000, addedBy: 'operator', endedAt: 3_000, endedBy: 'operator' },
  ],
  lifecycle: [
    { action: 'disband', at: 1_500, actorMemberId: 'operator', reason: 'wrapped up' },
    { action: 'restore', at: 1_800, actorMemberId: 'operator', reason: 'back online' },
  ],
  createdAt: 1_000,
  updatedAt: 2_000,
};

const inspection: ScopeInspectionView = {
  scope: group,
  state: { scopeId: 'wg-1', writable: false, reason: 'working-group-disbanded' },
  context: {
    scopeId: 'wg-1',
    projectId: 'project-sprout',
    kind: 'working-group',
    project: { contentVersion: 3, goal: 'Ship.', rules: ['Report.'] },
    workingGroup: { displayName: 'Core Mechanics', contentVersion: 2, goal: 'Revised.', rules: [] },
  },
};

test('the adapter reads every scope kind through the additive routes', async () => {
  const { transport, calls } = recordingTransport((path) => {
    if (path === '/api/projects/project-sprout/scopes') return { scopes: [channel, direct, group] };
    if (path === '/api/projects/project-sprout/working-groups') return { workingGroups: [group] };
    if (path === '/api/working-groups/wg-1') return { workingGroup: group };
    if (path === '/api/scopes/wg-1') return inspection;
    throw new Error(`unexpected path: ${path}`);
  });
  const adapter = createConversationBrowserAdapter(transport);

  assert.deepEqual(await adapter.listScopes('project-sprout'), [channel, direct, group]);
  assert.deepEqual(await adapter.listWorkingGroups('project-sprout'), [group]);
  assert.deepEqual(await adapter.getWorkingGroup('wg-1'), group);
  assert.deepEqual(await adapter.inspectScope('wg-1'), inspection);
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/projects/project-sprout/scopes',
      '/api/projects/project-sprout/working-groups',
      '/api/working-groups/wg-1',
      '/api/scopes/wg-1',
    ],
  );
});

test('commands are POST JSON bodies on exactly the documented routes', async () => {
  const { transport, calls } = recordingTransport(() => ({ workingGroup: group, scope: direct }));
  const adapter = createConversationBrowserAdapter(transport);

  await adapter.createWorkingGroup('project-sprout', {
    displayName: 'Core Mechanics',
    memberIds: ['agent-scout'],
    goal: 'Design.',
    rules: ['Keep the loop short.'],
    reason: 'kickoff',
  });
  await adapter.openDirectConversation('project-sprout', { participants: ['operator', 'agent-scout'] });
  await adapter.updateWorkingGroupContent('wg-1', { goal: null, reason: 'clear' });
  await adapter.addWorkingGroupMember('wg-1', { memberId: 'agent-scribe', reason: 'reviewer' });
  await adapter.endWorkingGroupMember('wg-1', 'agent-scribe', { reason: 'done' });
  await adapter.disbandWorkingGroup('wg-1', { reason: 'wrapped up' });
  await adapter.restoreWorkingGroup('wg-1', { reason: 'back online' });

  assert.deepEqual(
    calls.map((call) => ({ path: call.path, method: call.init?.method ?? 'GET' })),
    [
      { path: '/api/projects/project-sprout/working-groups', method: 'POST' },
      { path: '/api/projects/project-sprout/scopes/direct', method: 'POST' },
      { path: '/api/working-groups/wg-1/content', method: 'POST' },
      { path: '/api/working-groups/wg-1/members', method: 'POST' },
      { path: '/api/working-groups/wg-1/members/agent-scribe/end', method: 'POST' },
      { path: '/api/working-groups/wg-1/disband', method: 'POST' },
      { path: '/api/working-groups/wg-1/restore', method: 'POST' },
    ],
  );
  const createBody = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(createBody, {
    displayName: 'Core Mechanics',
    memberIds: ['agent-scout'],
    goal: 'Design.',
    rules: ['Keep the loop short.'],
    reason: 'kickoff',
  });
  const editBody = JSON.parse(String(calls[2]?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(editBody, { goal: null, reason: 'clear' }, 'null clears the goal on the wire');
  const restoreBody = JSON.parse(String(calls[6]?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(restoreBody, { reason: 'back online' }, 'a restore carries its attributed reason');
  assert.equal(calls[0]?.init?.headers?.['content-type'], 'application/json');
});

test('a refused command rejects through the shared transport instead of fabricating a row', async () => {
  const refusal = new Error('working group is read-only');
  const { transport } = recordingTransport(() => {
    throw refusal;
  });
  const adapter = createConversationBrowserAdapter(transport);
  await assert.rejects(() => adapter.disbandWorkingGroup('wg-1'), /working group is read-only/);
  await assert.rejects(() => adapter.inspectScope('missing'), /working group is read-only/);
  await assert.rejects(() => adapter.listScopes('project-sprout'), /working group is read-only/);
});

test('adapter state delegates to the shared transport', () => {
  const { transport } = recordingTransport(() => ({}));
  const adapter = createConversationBrowserAdapter(transport);
  assert.deepEqual(adapter.state(), { status: 'online', connection: 'online', loading: false });
  const unsubscribe = adapter.subscribeState(() => undefined);
  assert.equal(typeof unsubscribe, 'function');
});
