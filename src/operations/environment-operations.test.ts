import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvironmentOperations } from './environment-operations.ts';
import { MemoryRemoteOperationIdentityStore } from './remote-operation-store.ts';

const projectId = 'project-pinned';
const agentId = 'agent-pinned';
const binding = {
  bindingId: 'binding-env-a', generation: 1, workspaceId: 'workspace-env-a', kind: 'relative' as const,
  path: 'repos/project', boundAt: 1,
};
const accessA = {
  projectId, environmentInstanceId: 'env-a', status: 'active' as const, startedAt: 1, updatedAt: 1,
  current: binding, history: [binding],
};
const bindingB = { ...binding, bindingId: 'binding-env-b', workspaceId: 'workspace-env-b' };
const accessB = {
  projectId, environmentInstanceId: 'env-b', status: 'active' as const, startedAt: 1, updatedAt: 1,
  current: bindingB, history: [bindingB],
};

test('a pinned remote mutation refuses transport loss, revocation, and epoch change without using another Environment', async () => {
  let epochA = 1;
  let connectionA = 'connection-a-1';
  let liveA = true;
  let mutationPermission = true;
  let workerDispatches = 0;
  let leaseAcquisitions = 0;
  const projects = { get: async () => ({
    id: projectId, status: 'active', content: { currentVersion: 1, versions: [{ version: 1,
      memberships: [{ memberId: agentId, memberKind: 'agent' }] }] },
  }) };
  const accesses = new Map([[accessA.environmentInstanceId, accessA], [accessB.environmentInstanceId, accessB]]);
  const access = {
    get: async (_project: string, environmentInstanceId: string) => accesses.get(environmentInstanceId),
    listForProject: async () => [accessB, accessA],
  };
  const liveFor = (environmentInstanceId: string) => {
    if (environmentInstanceId === 'env-a' && !liveA) return undefined;
    const isA = environmentInstanceId === 'env-a';
    return {
      enrollment: { id: isA ? 'enrollment-a' : 'enrollment-b', status: 'approved' },
      epoch: { epoch: isA ? epochA : 1, connectionId: isA ? connectionA : 'connection-b-1' },
    };
  };
  const gateway = {
    liveFor,
    currentConnectionEpoch: (enrollmentId: string) => enrollmentId === 'enrollment-a' ? epochA : 1,
    isCurrentConnection: (enrollmentId: string, connectionId: string) => {
      const current = enrollmentId === 'enrollment-a' ? liveFor('env-a') : liveFor('env-b');
      return current?.epoch.connectionId === connectionId;
    },
  };
  const environment = {
    info: async (environmentInstanceId: string) => ({
      environmentInstanceId,
      workspaceOperations: { version: 3, operations: ['read', 'search', 'edit', 'patch', 'command'],
        maxReadBytes: 64 * 1024, maxSearchResults: 100 },
    }),
    connectionEpoch: (environmentInstanceId: string) => environmentInstanceId === 'env-a' ? epochA : 1,
    attachWorkspaceBinding: async () => ({ attached: true as const }),
    executeWorkspaceFileOperation: async (environmentInstanceId: string) => {
      workerDispatches++;
      throw new Error(`unexpected dispatch to ${environmentInstanceId}`);
    },
    inspectWorkspaceFileOperation: async () => ({ status: 'not-found' as const }),
    cancelWorkspaceFileOperation: async () => ({ accepted: false, status: 'not-found' as const }),
  };
  const operations = new EnvironmentOperations({
    projects: projects as never,
    access: access as never,
    environment: environment as never,
    gateway: gateway as never,
    catalog: { entry: () => ({ definition: { capabilities: [
      { name: 'read-only-investigation', requiresLease: false }, { name: 'agent-run', requiresLease: true },
    ] } }) } as never,
    enrollments: { get: async (id: string) => ({ id, environmentInstanceId: id === 'enrollment-a' ? 'env-a' : 'env-b',
      status: 'approved', capabilityPermissions: { 'read-only-investigation': true, 'agent-run': mutationPermission } }) } as never,
    store: new MemoryRemoteOperationIdentityStore(),
    pool: {
      requiresLeaseForBoundOperation: () => true,
      acquireBoundOperationLeaseRevalidated: async () => { leaseAcquisitions++; throw new Error('lease acquisition should not occur'); },
      extendLease: () => undefined, markRecovering: () => undefined, releaseLease: () => undefined,
    } as never,
  });
  const tools = await operations.attach(projectId, agentId, 'run-pinned');
  assert.equal(tools.binding.environmentInstanceId, 'env-a', 'the sorted first authorized binding is pinned for this run');
  assert.deepEqual(tools.operations, ['read', 'search', 'edit', 'patch', 'command']);

  liveA = false;
  const transportLost = await tools.edit!('src/file.txt', 'before', 'after', 'sdk-operation-transport');
  assert.equal(transportLost.failure, 'remote-operation-blocked');
  liveA = true;

  mutationPermission = false;
  const revoked = await tools.edit!('src/file.txt', 'before', 'after', 'sdk-operation-revoked');
  assert.equal(revoked.failure, 'remote-operation-blocked');
  mutationPermission = true;

  epochA = 2;
  connectionA = 'connection-a-2';
  const stale = await tools.edit!('src/file.txt', 'before', 'after', 'sdk-operation-stale-epoch');
  assert.equal(stale.failure, 'remote-operation-blocked');

  assert.equal(workerDispatches, 0, 'transport loss, revocation, and epoch change are refused before Worker dispatch');
  assert.equal(leaseAcquisitions, 0, 'refused work does not acquire a lease');
  assert.equal(gateway.liveFor('env-b')?.epoch.connectionId, 'connection-b-1', 'a different live Environment never substitutes for the pinned target');
});

