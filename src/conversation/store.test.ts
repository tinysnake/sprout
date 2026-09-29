import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryConversationScopeStore } from './store.ts';
import { ConversationScopeError, isWorkingGroup, type WorkingGroupScope } from './model.ts';

/**
 * The conversation scope store seam contract (#95): `update` is the one
 * serialized, conditional rewrite of a recorded document — the in-process
 * serialization that keeps an accepted lifecycle edit from being overwritten
 * — and removal is fenced to Project-channel rows.
 */

function group(overrides: Partial<WorkingGroupScope> = {}): WorkingGroupScope {
  return {
    id: 'wg-1',
    kind: 'working-group',
    projectId: 'project-alpha',
    creatorId: 'operator',
    lifecycle: [],
    content: {
      currentVersion: 1,
      versions: [
        {
          version: 1,
          at: 1,
          actorMemberId: 'operator',
          reason: 'seed',
          displayName: 'Loop',
          goal: '',
          rules: [],
        },
      ],
    },
    memberships: [{ memberId: 'operator', memberKind: 'human', addedAt: 1, addedBy: 'operator' }],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('update applies a synchronous mutation as one serialized read-modify-write', async () => {
  const store = new InMemoryConversationScopeStore();
  await store.save(group());

  const next = await store.update('wg-1', (current) => {
    assert.ok(current !== undefined && isWorkingGroup(current), 'the mutation sees the stored row');
    return {
      ...current,
      lifecycle: [
        ...current.lifecycle,
        { action: 'disband', at: 2, actorMemberId: 'operator', reason: 'paused' },
      ],
      updatedAt: 2,
    };
  });
  assert.ok(next !== undefined && isWorkingGroup(next));
  assert.equal(next.lifecycle.length, 1);
  assert.deepEqual(await store.get('wg-1'), next, 'the applied result is the recorded state');
  assert.equal(store.writes[store.writes.length - 1], next, 'the recorded write is the applied result');
});

test('update writes nothing when the mutation declines or throws', async () => {
  const store = new InMemoryConversationScopeStore();
  const original = group();
  await store.save(original);

  const declined = await store.update('wg-1', () => undefined);
  assert.equal(declined, undefined, 'declining mutates nothing');
  assert.equal(store.writes.length, 1, 'a declined update records no write');
  assert.deepEqual(await store.get('wg-1'), original);

  await assert.rejects(
    store.update('wg-1', () => {
      throw new ConversationScopeError('working-group-disbanded', 'refused before writing');
    }),
    (error: unknown) => error instanceof ConversationScopeError && error.code === 'working-group-disbanded',
  );
  assert.equal(store.writes.length, 1, 'a throwing mutation records no write');
  assert.deepEqual(await store.get('wg-1'), original, 'the stored row is untouched');
});

test('update refuses a result whose row changed since its read', async () => {
  const store = new InMemoryConversationScopeStore();
  await store.save(group());

  await assert.rejects(
    store.update('wg-1', (current) => {
      assert.ok(current !== undefined);
      // A competing writer that commits during the critical section — the
      // conditional write then sees a row it did not read and refuses the
      // stale result instead of overwriting the accepted change (F1).
      void store.save({ ...current, updatedAt: 99 });
      return {
        ...current,
        lifecycle: [{ action: 'disband', at: 2, actorMemberId: 'operator', reason: 'stale twin' }],
      };
    }),
    (error: unknown) =>
      error instanceof ConversationScopeError && error.code === 'stale-scope-write',
  );
  const stored = await store.get('wg-1');
  assert.ok(stored !== undefined && isWorkingGroup(stored));
  assert.equal(stored.updatedAt, 99, 'the competing write stands');
  assert.deepEqual(stored.lifecycle, [], 'the refused lifecycle event never landed');
});

test('removal is fenced to Project-channel rows', async () => {
  const store = new InMemoryConversationScopeStore();
  await store.save({ id: 'channel-p', kind: 'project', projectId: 'p', createdAt: 1, updatedAt: 1 });
  await store.save(group());

  await assert.rejects(
    store.removeProjectChannel('wg-1'),
    /only a Project-channel row is removable/,
    'a Working group carrying history is never removable',
  );
  assert.ok(await store.get('wg-1'), 'the refused removal left the group intact');

  await store.removeProjectChannel('channel-p');
  assert.equal(await store.get('channel-p'), undefined);
  await store.removeProjectChannel('channel-missing'); // a missing row is a no-op
});
