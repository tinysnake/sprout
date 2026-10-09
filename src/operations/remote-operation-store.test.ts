import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MemoryRemoteOperationIdentityStore, SqliteRemoteOperationIdentityStore } from './remote-operation-store.ts';
import type { RemoteOperationIdentity, RemoteMcpOperationIdentity, RemoteMcpProcessIdentity } from './remote-operation-store.ts';

const processIdentity: RemoteMcpProcessIdentity = {
  projectId: 'project-1', environmentInstanceId: 'environment-1', bindingId: 'binding-1', generation: 2,
  connectionEpoch: 3, workspaceId: 'workspace-1', kind: 'relative', path: 'repos/sample',
  leaseId: 'lease-1', holderKind: 'task', holderId: 'task-1', runId: 'run-1', taskId: 'task-1',
  fingerprint: 'process-fingerprint', processId: 'process-1', state: 'running', updatedAt: 100,
};
const operationIdentity: RemoteMcpOperationIdentity = {
  ...processIdentity, operationId: 'operation-1', toolId: 'tool-1', fingerprint: 'operation-fingerprint', state: 'running', updatedAt: 101,
};

test('memory MCP identity store fences identity conflicts and lists unresolved processes', async () => {
  const store = new MemoryRemoteOperationIdentityStore();
  await store.saveMcpProcess(processIdentity);
  await store.saveMcpOperation(operationIdentity);
  assert.deepEqual(await store.getMcpProcess('process-1'), processIdentity);
  assert.deepEqual(await store.getMcpOperation('operation-1'), operationIdentity);
  assert.deepEqual(await store.listOpenMcpProcesses('environment-1'), [processIdentity]);
  await assert.rejects(store.saveMcpProcess({ ...processIdentity, fingerprint: 'different' }), /identity conflict/);
  await store.saveMcpProcess({ ...processIdentity, state: 'stopped', updatedAt: 102 });
  assert.deepEqual(await store.listOpenMcpProcesses('environment-1'), []);
});

test('SQLite MCP process and operation identities survive reopen with Task lease scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-mcp-identities-'));
  const path = join(directory, 'operations.db');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    const first = new SqliteRemoteOperationIdentityStore(db);
    await first.saveMcpProcess(processIdentity);
    await first.saveMcpOperation(operationIdentity);
    db.close();
    db = undefined;

    db = new DatabaseSync(path);
    const reopened = new SqliteRemoteOperationIdentityStore(db);
    assert.deepEqual(await reopened.getMcpProcess('process-1'), processIdentity);
    assert.deepEqual(await reopened.getMcpOperation('operation-1'), operationIdentity);
    assert.deepEqual(await reopened.listOpenMcpProcesses('environment-1'), [processIdentity]);
    await reopened.saveMcpProcess({ ...processIdentity, state: 'stopped', updatedAt: 102 });
    assert.deepEqual(await reopened.listOpenMcpProcesses('environment-1'), []);
    await assert.rejects(reopened.saveMcpOperation({ ...operationIdentity, fingerprint: 'different' }), /identity conflict/);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const identity = (overrides: Partial<RemoteOperationIdentity> = {}): RemoteOperationIdentity => ({
  operationId: 'stable-operation-id', fingerprint: 'fingerprint-a', projectId: 'project-a',
  environmentInstanceId: 'environment-a', bindingId: 'binding-a', generation: 2,
  connectionEpoch: 4, workspaceId: 'workspace-a', runId: 'run-a', leaseId: 'lease-a',
  holderKind: 'run', holderId: 'agent-a', operation: 'edit', state: 'running', updatedAt: 10,
  ...overrides,
});

test('memory operation identity claim is atomic by ID and fingerprint', async () => {
  const store = new MemoryRemoteOperationIdentityStore();
  assert.equal(await store.claim(identity()), 'claimed');
  assert.deepEqual(await store.listOpenOperations('environment-a'), [identity()]);
  assert.deepEqual(await store.listOpenOperations('environment-b'), []);
  assert.equal(await store.claim(identity()), 'same-identity');
  assert.equal(await store.claim(identity({ fingerprint: 'fingerprint-b' })), 'conflicting-identity');
});

test('SQLite operation store adds recovery links to an existing journal without inventing lease ownership', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-remote-operation-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'operations.db'));
  try {
    db.exec(`CREATE TABLE remote_workspace_operations (
      operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, project_id TEXT NOT NULL,
      environment_instance_id TEXT NOT NULL, binding_id TEXT NOT NULL, generation INTEGER NOT NULL,
      connection_epoch INTEGER NOT NULL, workspace_id TEXT NOT NULL, operation TEXT NOT NULL,
      state TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.prepare(`INSERT INTO remote_workspace_operations VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run('legacy-operation', 'legacy-fingerprint', 'project-a', 'environment-a', 'binding-a', 2, 4, 'workspace-a', 'edit', 'unknown', 10);
    const store = new SqliteRemoteOperationIdentityStore(db);
    const legacy = await store.get('legacy-operation');
    assert.equal(legacy?.state, 'unknown');
    assert.equal(legacy?.leaseId, undefined);
    assert.deepEqual(await store.listOpenOperations('environment-a'), [legacy]);
  } finally {
    db.close();
  }
});

test('SQLite operation identity survives store reconstruction and terminal outcome cannot regress', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-remote-operation-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'operations.db');
  const db = new DatabaseSync(filename);
  const first = new SqliteRemoteOperationIdentityStore(db);
  assert.equal(await first.claim(identity()), 'claimed');
  await first.save(identity({ state: 'unknown', updatedAt: 11 }));
  db.close();

  const reopenedDb = new DatabaseSync(filename);
  try {
    const reopened = new SqliteRemoteOperationIdentityStore(reopenedDb);
    assert.equal(await reopened.claim(identity()), 'same-identity');
    assert.equal(await reopened.claim(identity({ fingerprint: 'fingerprint-b' })), 'conflicting-identity');
    assert.deepEqual(await reopened.listOpenOperations('environment-a'), [{ ...identity(), state: 'unknown', updatedAt: 11 }]);
    assert.deepEqual(await reopened.listOpenOperations('environment-b'), []);
    await reopened.save(identity({ state: 'completed', updatedAt: 12 }));
    await reopened.save(identity({ state: 'running', updatedAt: 13 }));
    assert.deepEqual(await reopened.listOpenOperations('environment-a'), []);
    assert.equal((await reopened.get('stable-operation-id'))?.state, 'completed');
  } finally {
    reopenedDb.close();
  }
});
