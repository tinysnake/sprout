import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BridgedProjectRegistry } from './bridged-registry.ts';
import { ProjectService } from './authority-service.ts';
import { InMemoryProjectAuthorityStore } from './authority-store.ts';
import { InMemoryProjectAccessStore } from './access-store.ts';
import type { Project } from './model.ts';

/**
 * The one-identity seam between the M2 Project authority and the M1
 * collaboration registry (#92, F1).
 *
 * A Project created through the authority must be addressable on its Project
 * channel immediately: the wake contract reads this registry, so the mirrored
 * projection is what makes creation, routing, and wake atomic and observable.
 * Configured legacy Projects must survive the bridge untouched (#85).
 */

const legacy: Project = {
  id: 'composition-project',
  goal: 'Configured before the authority existed',
  rules: [],
  availableEnvironmentInstanceIds: ['instance-1'],
  memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }],
};

test('an authority Project mirrors into the registry and stays editable in the authority only', async () => {
  const registry = new BridgedProjectRegistry([legacy]);
  const projects = new ProjectService({ store: new InMemoryProjectAuthorityStore(), clock: () => 5_000 });
  await projects.create({ id: 'project-live', displayName: 'Live', goal: 'Bridge me' });
  const created = (await projects.get('project-live'))!;
  registry.mirror(created, ['instance-1']);

  // The mirrored projection is present and route-compatible; the explicit
  // goal input replaced the template-seeded goal (F2 semantics).
  const mirrored = registry.get('project-live');
  assert.ok(mirrored);
  assert.equal(mirrored.goal, 'Bridge me');
  assert.deepEqual(mirrored.availableEnvironmentInstanceIds, []);
  // The Human member never projects as an M1 Agent membership; there were no
  // Agent memberships, so none project.
  assert.deepEqual(mirrored.memberships, []);
  // The legacy configured Project is untouched.
  assert.equal(registry.get('composition-project')?.goal, 'Configured before the authority existed');

  // A later authority edit mirrors forward: one identity, current content.
  const edited = await projects.updateContent('project-live', { goal: 'New goal', reason: 'edit' });
  registry.mirror(edited, ['instance-1']);
  assert.equal(registry.get('project-live')?.goal, 'New goal');
});

test('an authority record with a legacy id wins the shared identity instead of forking it', async () => {
  const registry = new BridgedProjectRegistry([legacy]);
  const projects = new ProjectService({ store: new InMemoryProjectAuthorityStore(), clock: () => 5_000 });
  await projects.create({
    id: 'composition-project',
    displayName: 'Authority version',
    goal: 'Authority wins',
    agentMemberships: [],
  });
  const authority = (await projects.get('composition-project'))!;
  registry.mirror(authority, ['instance-1']);

  const resolved = registry.get('composition-project');
  assert.ok(resolved);
  assert.equal(resolved.goal, 'Authority wins');
  // The authority projection replaced the configured entry for the shared id.
  assert.notEqual(resolved, legacy);
});

test('loadAuthorities hydrates every stored record after the configured entries', async () => {
  const registry = new BridgedProjectRegistry([legacy]);
  const store = new InMemoryProjectAuthorityStore();
  const projects = new ProjectService({ store, clock: () => 5_000 });
  await projects.create({ id: 'project-a', displayName: 'A' });
  await projects.create({ id: 'project-b', displayName: 'B' });

  const hydrated = await registry.loadAuthorities(store, ['instance-1']);
  assert.equal(hydrated.length, 2);
  assert.ok(registry.get('project-a'));
  assert.ok(registry.get('project-b'));
  // Hydration never shadows a configured entry with a different id.
  assert.equal(registry.get('composition-project')?.goal, legacy.goal);
});

test('archived authority Projects disappear from legacy lookup and restore without invented Environment access', async () => {
  const registry = new BridgedProjectRegistry([legacy]);
  const projects = new ProjectService({
    store: new InMemoryProjectAuthorityStore(),
    agentAuthority: { agentIsActive: () => true },
    bridge: registry,
  });

  await projects.create({
    id: 'project-lifecycle',
    displayName: 'Lifecycle',
    agentMemberships: [{ agentId: 'scout' }],
  });
  const active = registry.get('project-lifecycle');
  assert.ok(active);
  assert.deepEqual(active.availableEnvironmentInstanceIds, []);

  await projects.archive('project-lifecycle');
  assert.equal(registry.get('project-lifecycle'), undefined);
  assert.equal(registry.list().some((project) => project.id === 'project-lifecycle'), false);
  assert.equal(registry.forAgent('scout').some((project) => project.id === 'project-lifecycle'), false);

  await projects.restore('project-lifecycle');
  assert.ok(registry.get('project-lifecycle'));
  assert.deepEqual(registry.get('project-lifecycle')?.availableEnvironmentInstanceIds, []);
});

/**
 * The Project Environment access projection (#93).
 *
 * A granted access relationship is what makes an authority Project's
 * environments resolvable by a run: only an active access contributes an
 * available instance, and every active access contributes a workspace entry.
 * A relative binding names a Worker-root-relative location; a Worker-managed
 * default binding carries no location, so the Worker resolves its own default
 * workspace for the Project instead of an unrelated instance working directory.
 */
test('granted access projects the Environment and a relative workspace into the M1 registry', async () => {
  const registry = new BridgedProjectRegistry();
  const projects = new ProjectService({
    store: new InMemoryProjectAuthorityStore(),
    agentAuthority: { agentIsActive: () => true },
    bridge: registry,
    clock: () => 5_000,
  });
  await projects.create({
    id: 'project-access',
    displayName: 'Access',
    agentMemberships: [{ agentId: 'scout' }],
  });

  const defaultAccess = {
    projectId: 'project-access',
    environmentInstanceId: 'instance-default',
    status: 'active' as const,
    startedAt: 1,
    updatedAt: 1,
    current: { bindingId: 'b1', workspaceId: 'a'.repeat(40), kind: 'default' as const, boundAt: 1 },
    history: [{ bindingId: 'b1', workspaceId: 'a'.repeat(40), kind: 'default' as const, boundAt: 1 }],
  };
  const relativeAccess = {
    projectId: 'project-access',
    environmentInstanceId: 'instance-relative',
    status: 'active' as const,
    startedAt: 1,
    updatedAt: 1,
    current: {
      bindingId: 'b2',
      workspaceId: 'b'.repeat(40),
      kind: 'relative' as const,
      path: 'repos/sprout',
      boundAt: 1,
    },
    history: [
      {
        bindingId: 'b2',
        workspaceId: 'b'.repeat(40),
        kind: 'relative' as const,
        path: 'repos/sprout',
        boundAt: 1,
      },
    ],
  };
  registry.prepareAccess('project-access', [defaultAccess, relativeAccess])();

  const projected = registry.get('project-access');
  assert.ok(projected);
  assert.deepEqual(projected.availableEnvironmentInstanceIds, ['instance-default', 'instance-relative']);
  // The relative binding names a location; the default binding is present but
  // pathless, so the Worker resolves its own default workspace.
  assert.deepEqual(projected.workspaces, [
    { environmentInstanceId: 'instance-default' },
    { environmentInstanceId: 'instance-relative', path: 'repos/sprout' },
  ]);
  assert.equal('path' in (projected.workspaces?.[0] ?? {}), false);
  assert.equal(projected.workspaces?.[1]?.path, 'repos/sprout');
});

test('loadAuthorities hydrates access before publishing, so a restart preserves granted environments', async () => {
  const registry = new BridgedProjectRegistry();
  const authorityStore = new InMemoryProjectAuthorityStore();
  const accessStore = new InMemoryProjectAccessStore();
  const projects = new ProjectService({
    store: authorityStore,
    agentAuthority: { agentIsActive: () => true },
    clock: () => 5_000,
  });
  await projects.create({ id: 'project-restart', displayName: 'Restart' });
  await accessStore.save({
    projectId: 'project-restart',
    environmentInstanceId: 'mac-mini-1',
    status: 'active',
    startedAt: 1,
    updatedAt: 1,
    current: {
      bindingId: 'b1',
      workspaceId: 'a'.repeat(40),
      kind: 'relative',
      path: 'repos/sprout',
      boundAt: 1,
    },
    history: [
      { bindingId: 'b1', workspaceId: 'a'.repeat(40), kind: 'relative', path: 'repos/sprout', boundAt: 1 },
    ],
  });

  await registry.loadAuthorities(authorityStore, [], accessStore);
  const restored = registry.get('project-restart');
  assert.deepEqual(restored?.availableEnvironmentInstanceIds, ['mac-mini-1']);
  assert.deepEqual(restored?.workspaces, [{ environmentInstanceId: 'mac-mini-1', path: 'repos/sprout' }]);
});

test('an ended access removes the environment from the Project projection', async () => {
  const registry = new BridgedProjectRegistry();
  const projects = new ProjectService({
    store: new InMemoryProjectAuthorityStore(),
    agentAuthority: { agentIsActive: () => true },
    bridge: registry,
    clock: () => 5_000,
  });
  await projects.create({ id: 'project-ended', displayName: 'Ended' });
  registry.prepareAccess('project-ended', [
    {
      projectId: 'project-ended',
      environmentInstanceId: 'mac-mini-1',
      status: 'active',
      startedAt: 1,
      updatedAt: 1,
      current: { bindingId: 'b1', workspaceId: 'a'.repeat(40), kind: 'default', boundAt: 1 },
      history: [{ bindingId: 'b1', workspaceId: 'a'.repeat(40), kind: 'default', boundAt: 1 }],
    },
  ])();
  assert.deepEqual(registry.get('project-ended')?.availableEnvironmentInstanceIds, ['mac-mini-1']);

  registry.prepareAccess('project-ended', [
    {
      projectId: 'project-ended',
      environmentInstanceId: 'mac-mini-1',
      status: 'ended',
      startedAt: 1,
      updatedAt: 2,
      endedAt: 2,
      endedReason: 'retired',
      history: [
        {
          bindingId: 'b1',
          workspaceId: 'a'.repeat(40),
          kind: 'default',
          boundAt: 1,
          unboundAt: 2,
          unboundReason: 'retired',
        },
      ],
    },
  ])();
  const projection = registry.get('project-ended');
  assert.ok(projection);
  assert.deepEqual(projection.availableEnvironmentInstanceIds, []);
  assert.equal(projection.workspaces, undefined);
});
