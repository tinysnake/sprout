import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvironmentOperations } from './environment-operations.ts';
import { EnvironmentPool, InMemoryLeaseStore } from '../environment/pool.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
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
  const containingLease = {
    environmentInstanceId: 'env-a', leaseId: 'lease-a', runId: 'run-pinned',
    holderKind: 'run' as const, holderId: agentId, leaseCapability: 'agent-run' as const,
    canRelease: () => false,
  };
  const lease = { id: 'lease-a', instanceId: 'env-a', capability: 'agent-run', mode: 'read-write' as const, holderId: agentId,
    holderKind: 'run' as const, runId: 'run-pinned', acquiredAt: 1, expiresAt: 60_001, state: 'active' as const };
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
      enrollment: {
        id: isA ? 'enrollment-a' : 'enrollment-b', status: 'approved',
        worker: { identityDigest: isA ? 'worker-digest-a' : 'worker-digest-b' },
      },
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
      getLease: () => lease,
      requiresLeaseForBoundOperation: () => true,
      acquireBoundOperationLeaseRevalidated: async () => { leaseAcquisitions++; throw new Error('lease acquisition should not occur'); },
      extendLease: () => lease, keepLeaseUntilCleanup: () => () => undefined,
      markRecovering: () => undefined, releaseLease: () => undefined,
    } as never,
  });
  const tools = await operations.attach(projectId, agentId, 'run-pinned', containingLease);
  await assert.rejects(operations.attach(projectId, agentId, 'later-run', containingLease), (error: unknown) =>
    error instanceof Error && 'reason' in error && error.reason === 'lease-required');
  assert.equal(workerDispatches, 0, 'a later run cannot inherit an earlier run lease or attach a workspace');
  assert.equal(leaseAcquisitions, 0, 'cross-run refusal does not acquire a replacement lease');
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

test('workspace operations refuse all bound work without a containing lease', async () => {
  const definition: EnvironmentDefinition = {
    id: 'definition-no-containing-lease', platform: 'container', capabilities: [
      { name: 'read-only-investigation', requiresLease: true, leaseMode: 'read' },
      { name: 'agent-run', requiresLease: true, leaseMode: 'read-write' },
    ],
  };
  const instance: EnvironmentInstance = { id: 'env-a', definitionId: definition.id };
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance], clock: { now: () => 1_000 } });
  let leaseAcquisitions = 0;
  const acquireLease = pool.acquireLease.bind(pool);
  pool.acquireLease = request => { leaseAcquisitions++; return acquireLease(request); };
  const acquireBoundOperationLease = pool.acquireBoundOperationLeaseRevalidated.bind(pool);
  pool.acquireBoundOperationLeaseRevalidated = async request => {
    leaseAcquisitions++;
    return acquireBoundOperationLease(request);
  };
  let workspace = Buffer.from('workspace sentinel');
  const originalWorkspace = Buffer.from(workspace);
  const workerDispatches: string[] = [];
  const environment = {
    connectionEpoch: () => 1,
    info: async () => ({ environmentInstanceId: 'env-a', workspaceOperations: { version: 3,
      operations: ['read', 'search', 'edit', 'patch', 'command'], maxReadBytes: 64 * 1024, maxSearchResults: 100 } }),
    attachWorkspaceBinding: async () => ({ attached: true as const }),
    executeWorkspaceFileOperation: async (_instanceId: string, request: { operation: string; operationId: string; path?: string }) => {
      workerDispatches.push(request.operation);
      if (request.operation !== 'read' && request.operation !== 'search') workspace = Buffer.from('changed workspace');
      return {
        projectId, environmentInstanceId: instance.id, bindingId: binding.bindingId, generation: binding.generation,
        connectionEpoch: 1, workspaceId: binding.workspaceId, operationId: request.operationId,
        operation: request.operation, status: 'completed' as const,
        ...(request.operation === 'read' ? { path: request.path!, content: workspace.toString('utf8') } : {}),
        ...(request.operation === 'search' ? { matches: [] } : {}),
        ...(request.operation === 'edit' || request.operation === 'patch' ? { path: request.path!, changedPaths: [request.path!] } : {}),
      };
    },
  };
  const operations = new EnvironmentOperations({
    projects: { get: async () => ({ id: projectId, status: 'active', content: { currentVersion: 1, versions: [{ version: 1,
      memberships: [{ memberId: agentId, memberKind: 'agent' }] }] } }) } as never,
    access: { get: async () => accessA, listForProject: async () => [accessA] } as never,
    environment: environment as never,
    gateway: {
      liveFor: () => ({ enrollment: { id: 'enrollment-a', status: 'approved', worker: { identityDigest: 'worker-digest-a' } },
        epoch: { epoch: 1, connectionId: 'connection-a-1' } }),
      currentConnectionEpoch: () => 1, isCurrentConnection: () => true,
    } as never,
    catalog: { entry: () => ({ definition }) } as never,
    enrollments: { get: async () => ({ id: 'enrollment-a', environmentInstanceId: 'env-a', status: 'approved',
      capabilityPermissions: { 'read-only-investigation': true, 'agent-run': true } }) } as never,
    store: new MemoryRemoteOperationIdentityStore(),
    pool,
  });

  const tools = await operations.attach(projectId, agentId, 'run-without-lease');
  const attempts = [
    { operation: 'read', result: await tools.read('src/file.txt', 'no-lease-read') },
    { operation: 'search', result: await tools.search('needle', undefined, 'no-lease-search') },
    { operation: 'execute', result: await tools.command!('npm', [], {}, 'no-lease-execute') },
    { operation: 'edit', result: await tools.edit!('src/file.txt', 'before', 'after', 'no-lease-edit') },
    { operation: 'patch', result: await tools.patch!('src/file.txt', [{ before: 'before', after: 'after' }], 'no-lease-patch') },
  ];

  assert.deepEqual({
    operations: tools.operations,
    failures: attempts.map(({ operation, result }) => ({ operation, failure: result.failure })),
    workerDispatches,
    leaseAcquisitions,
    workspaceUnchanged: workspace.equals(originalWorkspace),
  }, {
    operations: [],
    failures: ['read', 'search', 'execute', 'edit', 'patch'].map(operation => ({ operation, failure: 'lease-required' })),
    workerDispatches: [],
    leaseAcquisitions: 0,
    workspaceUnchanged: true,
  });
});

test('a run borrows its admitted shared read lease for reads and refuses mutations', async () => {
  const definition: EnvironmentDefinition = {
    id: 'definition-read-write-modes', platform: 'container', capabilities: [
      { name: 'read-only-investigation', requiresLease: true, leaseMode: 'read' },
      { name: 'agent-run', requiresLease: true, leaseMode: 'read-write' },
    ],
  };
  const instance: EnvironmentInstance = { id: 'env-a', definitionId: definition.id };
  const store = new InMemoryLeaseStore();
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance], store, clock: { now: () => 1_000 } });
  const admitted = pool.acquireLease({ instanceId: instance.id, capability: 'read-only-investigation', mode: 'read',
    holderId: agentId, runId: 'run-read-only', ttlMs: 60_000 });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) throw new Error('read lease admission failed');
  const shared = pool.acquireLease({ instanceId: instance.id, capability: 'read-only-investigation', mode: 'read',
    holderId: 'another-reader', runId: 'run-another-reader', ttlMs: 60_000 });
  assert.equal(shared.ok, true, 'another run can hold a shared read lease');
  assert.equal(pool.activeLeases(instance.id).length, 2, 'both admitted read leases coexist');
  const containingLease = {
    environmentInstanceId: instance.id, leaseId: admitted.lease.id, runId: 'run-read-only',
    holderKind: 'run' as const, holderId: agentId, leaseCapability: 'read-only-investigation' as const,
    canRelease: () => false,
  };
  let workspace = Buffer.from('workspace sentinel');
  const originalWorkspace = Buffer.from(workspace);
  let workerCalls = 0;
  let mutationCalls = 0;
  const environment = {
    connectionEpoch: () => 1,
    info: async () => ({ environmentInstanceId: 'env-a', workspaceOperations: { version: 3,
      operations: ['read', 'search', 'edit', 'patch', 'command'], maxReadBytes: 64 * 1024, maxSearchResults: 100 } }),
    attachWorkspaceBinding: async () => ({ attached: true as const }),
    executeWorkspaceFileOperation: async (_instanceId: string, request: { operation: string; operationId: string; path?: string }) => {
      workerCalls++;
      if (request.operation !== 'read' && request.operation !== 'search') {
        mutationCalls++;
        workspace = Buffer.from('changed workspace');
      }
      return {
        projectId,
        environmentInstanceId: instance.id,
        bindingId: binding.bindingId,
        generation: binding.generation,
        connectionEpoch: 1,
        workspaceId: binding.workspaceId,
        operationId: request.operationId,
        operation: request.operation,
        status: 'completed' as const,
        ...(request.operation === 'read' ? { path: request.path!, content: workspace.toString('utf8') } : {}),
        ...(request.operation === 'search' ? { matches: [] } : {}),
        ...(request.operation === 'edit' || request.operation === 'patch' ? { path: request.path!, changedPaths: [request.path!] } : {}),
      };
    },
  };
  const operations = new EnvironmentOperations({
    projects: { get: async () => ({ id: projectId, status: 'active', content: { currentVersion: 1, versions: [{ version: 1,
      memberships: [{ memberId: agentId, memberKind: 'agent' }] }] } }) } as never,
    access: { get: async () => accessA, listForProject: async () => [accessA] } as never,
    environment: environment as never,
    gateway: {
      liveFor: () => ({ enrollment: { id: 'enrollment-a', status: 'approved', worker: { identityDigest: 'worker-digest-a' } },
        epoch: { epoch: 1, connectionId: 'connection-a-1' } }),
      currentConnectionEpoch: () => 1, isCurrentConnection: () => true,
    } as never,
    catalog: { entry: () => ({ definition }) } as never,
    enrollments: { get: async () => ({ id: 'enrollment-a', environmentInstanceId: 'env-a', status: 'approved',
      capabilityPermissions: { 'read-only-investigation': true, 'agent-run': true } }) } as never,
    store: new MemoryRemoteOperationIdentityStore(),
    pool,
  });

  const tools = await operations.attach(projectId, agentId, 'run-read-only', containingLease);
  assert.equal(tools.leaseMode, 'read');
  assert.deepEqual(tools.operations, ['read', 'search']);
  const read = await tools.read!('src/file.txt', 'read-only-read');
  assert.equal(read.status, 'completed', read.failure ?? '');
  assert.equal(read.content, 'workspace sentinel');
  const lease = admitted.lease;
  assert.equal(lease.mode, 'read');
  assert.equal(store.get(lease.id)?.mode, 'read');

  const attempts = await Promise.all([
    tools.edit!('src/file.txt', 'workspace sentinel', 'changed', 'read-only-edit'),
    tools.patch!('src/file.txt', [{ before: 'workspace sentinel', after: 'changed' }], 'read-only-patch'),
    tools.command!('npm', [], {}, 'read-only-command'),
  ]);
  assert.deepEqual(attempts.map((result) => result.failure), ['read-only-lease', 'read-only-lease', 'read-only-lease']);
  assert.deepEqual(workspace, originalWorkspace, 'mutation attempts leave the workspace byte-for-byte unchanged');
  assert.equal(workerCalls, 1, 'only the read reaches the Worker');
  assert.equal(mutationCalls, 0, 'the Worker receives no mutation');
  if (shared.ok) pool.releaseLease(shared.lease.id);

  await tools.settle?.('unknown');
  assert.equal(pool.getLease(lease!.id)?.state, 'recovering');
  assert.equal(pool.getLease(lease!.id)?.mode, 'read');
  pool.resolveRecovery(lease!.id);
  assert.deepEqual(pool.activeLeases(instance.id), []);
});
