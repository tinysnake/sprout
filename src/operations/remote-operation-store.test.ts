import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MemoryRemoteOperationIdentityStore, SqliteRemoteOperationIdentityStore, type RemoteOperationIdentity } from './remote-operation-store.ts';

const identity = (overrides: Partial<RemoteOperationIdentity> = {}): RemoteOperationIdentity => ({
  operationId: 'stable-operation-id', fingerprint: 'fingerprint-a', projectId: 'project-a',
  environmentInstanceId: 'environment-a', bindingId: 'binding-a', generation: 2,
  connectionEpoch: 4, workspaceId: 'workspace-a', operation: 'edit', state: 'running', updatedAt: 10,
  ...overrides,
});

test('memory operation identity claim is atomic by ID and fingerprint', async () => {
  const store = new MemoryRemoteOperationIdentityStore();
  assert.equal(await store.claim(identity()), 'claimed');
  assert.equal(await store.claim(identity()), 'same-identity');
  assert.equal(await store.claim(identity({ fingerprint: 'fingerprint-b' })), 'conflicting-identity');
});

test('SQLite operation identity survives store reconstruction and terminal outcome cannot regress', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const first = new SqliteRemoteOperationIdentityStore(db);
    assert.equal(await first.claim(identity()), 'claimed');
    await first.save(identity({ state: 'unknown', updatedAt: 11 }));
    const reopened = new SqliteRemoteOperationIdentityStore(db);
    assert.equal(await reopened.claim(identity()), 'same-identity');
    assert.equal(await reopened.claim(identity({ fingerprint: 'fingerprint-b' })), 'conflicting-identity');
    await reopened.save(identity({ state: 'completed', updatedAt: 12 }));
    await reopened.save(identity({ state: 'running', updatedAt: 13 }));
    assert.equal((await reopened.get('stable-operation-id'))?.state, 'completed');
  } finally {
    db.close();
  }
});
