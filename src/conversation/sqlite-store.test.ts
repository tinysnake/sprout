import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SqliteConversationScopeStore } from './sqlite-store.ts';
import { ConversationScopeService } from './service.ts';
import {
  directConversationScopeId,
  projectChannelScopeId,
  type ConversationScope,
  type DirectConversationScope,
  type ProjectChannelScope,
  type WorkingGroupScope,
} from './model.ts';
import type { ConversationProjectFacts } from './service.ts';
import { getSchemaVersion, defaultSafetyCopyPath } from '../store/schema.ts';

/**
 * Persistence and restart behaviour for conversation scopes (#95).
 *
 * The round trip runs over a real SQLite file, closes it, and reopens it the
 * way a process restart would, so the durable claims — one Project channel,
 * distinct direct-conversation identity, Working group versions and membership
 * history — are statements about the production adapter rather than the
 * in-memory contract.
 */

function facts(projectId: string): ConversationProjectFacts {
  return {
    projectId,
    status: 'active',
    contentVersion: 2,
    goal: 'Persist the scopes.',
    rules: ['Keep history.'],
    members: [
      { memberId: 'operator', memberKind: 'human' },
      { memberId: 'scout', memberKind: 'agent' },
      { memberId: 'scribe', memberKind: 'agent' },
    ],
  };
}

function service(store: SqliteConversationScopeStore): ConversationScopeService {
  return new ConversationScopeService({
    store,
    projects: { projectFacts: async (projectId) => (projectId === 'project-alpha' ? facts(projectId) : undefined) },
    clock: () => 5_000,
    createId: () => 'group-1',
  });
}

function withTempStore(run: (input: { path: string; store: SqliteConversationScopeStore }) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-conversation-'));
  const path = join(directory, 'sprout.db');
  const store = new SqliteConversationScopeStore({ filename: path });
  return run({ path, store })
    .then(() => {
      store.close();
    })
    .finally(() => {
      rmSync(directory, { recursive: true, force: true });
    });
}

test('every conversation scope kind round-trips through SQLite', async () => {
  await withTempStore(async ({ store }) => {
    const scopes = service(store);
    const channel = await scopes.ensureProjectChannel('project-alpha');
    const direct = await scopes.openDirect({
      projectId: 'project-alpha',
      participants: ['operator', 'scout'],
    });
    const group = await scopes.createWorkingGroup({
      projectId: 'project-alpha',
      displayName: 'Durable group',
      creator: { memberId: 'operator', kind: 'human' },
      memberIds: ['scout', 'scribe'],
      goal: 'Round trip.',
      rules: ['No loss.'],
      reason: 'seed',
    });
    await scopes.endWorkingGroupMember(group.id, { memberId: 'operator', kind: 'human' }, 'scribe', {
      reason: 'membership tidied',
    });

    const loadedChannel = await store.get(channel.id);
    assert.deepEqual(loadedChannel, channel, 'the Project channel document is byte-identical');
    const loadedDirect = (await store.get(direct.id)) as DirectConversationScope;
    assert.deepEqual(loadedDirect.participants, ['operator', 'scout']);
    assert.equal(loadedDirect.id, directConversationScopeId('project-alpha', ['operator', 'scout']));
    const loadedGroup = (await store.get(group.id)) as WorkingGroupScope;
    assert.equal(loadedGroup.content.currentVersion, 1);
    assert.equal(loadedGroup.content.versions[0]?.rules[0], 'No loss.');
    const ended = loadedGroup.memberships.find((entry) => entry.memberId === 'scribe');
    assert.equal(ended?.endedAt, 5_000);
    assert.equal(ended?.endedReason, 'membership tidied');
    assert.ok(loadedGroup.memberships.some((entry) => entry.memberId === 'scout' && entry.endedAt === undefined));

    const forProject = await store.listForProject('project-alpha');
    assert.equal(forProject.length, 3);
    assert.deepEqual(
      forProject.map((scope) => scope.kind),
      ['project', 'direct', 'working-group'],
      'scopes list oldest first',
    );
    assert.equal((await store.listForProject('project-other')).length, 0);
    assert.equal((await store.list()).length, 3);
  });
});

test('a save upserts by identity so a repeated channel or direct open stays one row', async () => {
  await withTempStore(async ({ store }) => {
    const scopes = service(store);
    const channel = await scopes.ensureProjectChannel('project-alpha');
    await store.save({ ...channel, createdAt: 1 } as ProjectChannelScope);
    const all = await store.listForProject('project-alpha');
    assert.equal(all.length, 1, 'a repeated save of one id is one row');
    assert.equal((await store.get(channel.id))?.createdAt, 1, 'the last write wins');
  });
});

test('scopes, history, and lifecycle survive a restart reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-conversation-restart-'));
  const path = join(directory, 'sprout.db');
  {
    const first = new SqliteConversationScopeStore({ filename: path });
    const scopes = service(first);
    const channel = await scopes.ensureProjectChannel('project-alpha');
    const group = await scopes.createWorkingGroup({
      projectId: 'project-alpha',
      displayName: 'Across restarts',
      creator: { memberId: 'operator', kind: 'human' },
      memberIds: ['scout'],
      goal: 'Restart-proof.',
    });
    await scopes.disbandWorkingGroup(group.id, { memberId: 'operator', kind: 'human' }, {
      reason: 'paused the effort',
    });
    first.close();

    // Reopen exactly as a restart would: no in-memory state survives.
    const second = new SqliteConversationScopeStore({ filename: path });
    try {
      const reopenedChannel = (await second.get(channel.id)) as ProjectChannelScope;
      assert.equal(reopenedChannel.kind, 'project');
      const reopened = (await second.get(group.id)) as WorkingGroupScope;
      assert.equal(reopened.status, 'disbanded', 'the disband status is durable');
      assert.equal(reopened.disbandedReason, 'paused the effort');
      assert.equal(reopened.content.versions[0]?.goal, 'Restart-proof.');
      assert.equal(reopened.memberships.length, 2);

      // The restarted service observes the same facts: disband still renders
      // the channel read-only, and restore revives the durable record.
      const restarted = service(second);
      const state = await restarted.scopeState(group.id, 'operator');
      assert.deepEqual(state, { scopeId: group.id, writable: false, reason: 'working-group-disbanded' });
      const restored = await restarted.restoreWorkingGroup(group.id, {
        memberId: 'operator',
        kind: 'human',
      });
      assert.equal(restored.status, 'active');
      assert.equal(restored.createdAt, 5_000, 'identity and creation time are not rewritten by restore');
    } finally {
      second.close();
    }
  }
});

test('an existing pre-scope database receives the conversation scope table through migration v18', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-conversation-migrate-'));
  const path = join(directory, 'sprout.db');
  try {
    // A non-empty v17 store: opening it must forward-migrate to v18 with a
    // safety copy, creating the conversation scope table (ADR-0009).
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      INSERT INTO projects VALUES ('p1', '{"id":"p1"}');
      PRAGMA user_version = 17;
    `);
    legacy.close();

    const store = new SqliteConversationScopeStore({ filename: path });
    try {
      // Probe through a second connection: the adapter owns no version accessor.
      const probe = new DatabaseSync(path);
      assert.equal(getSchemaVersion(probe), 18);
      probe.close();
      assert.ok(existsSync(defaultSafetyCopyPath(path)), 'the pre-migration safety copy exists');
      const scopes: readonly ConversationScope[] = await store.list();
      assert.deepEqual(scopes, [], 'the migrated table starts empty');
      await store.save({
        id: projectChannelScopeId('p1'),
        kind: 'project',
        projectId: 'p1',
        createdAt: 1,
        updatedAt: 1,
      });
      assert.equal((await store.list()).length, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
