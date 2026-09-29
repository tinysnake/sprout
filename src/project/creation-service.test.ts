import assert from 'node:assert/strict';
import { test } from 'node:test';

import { currentProjectContent } from './authority-model.ts';
import { ProjectService } from './authority-service.ts';
import { ProjectAccessService } from './access-service.ts';
import { ProjectCreationService } from './creation-service.ts';
import { SqliteStore } from '../store/db.ts';
import { ConversationScopeService } from '../conversation/service.ts';
import { projectChannelScopeId } from '../conversation/model.ts';

function services(options: {
  readonly rejectWorkspace?: boolean;
  readonly bridge?: ConstructorParameters<typeof ProjectService>[0]['bridge'];
} = {}) {
  const stores = new SqliteStore({ filename: ':memory:' });
  const projects = new ProjectService({
    store: stores.projectAuthorities,
    agentAuthority: { agentIsActive: (agentId) => agentId === 'agent-ready' },
    createId: () => 'project-atomic',
    ...(options.bridge !== undefined ? { bridge: options.bridge } : {}),
  });
  const access = new ProjectAccessService({
    store: stores.projectAccess,
    projects,
    environments: { environmentIsAccessible: (id) => id === 'inst-ready' },
    worker: {
      async validate({ selection }) {
        if (options.rejectWorkspace) throw new Error('worker refused the workspace');
        return {
          workspaceId: 'a'.repeat(40),
          kind: selection.kind,
          ...(selection.kind === 'relative' ? { path: selection.path } : {}),
        };
      },
    },
  });
  return {
    stores,
    projects,
    creation: new ProjectCreationService({ projects, access, store: stores.projectCreation }),
  };
}

const selectedResources = {
  project: {
    displayName: 'Atomic Project',
    agentMemberships: [{ agentId: 'agent-ready', responsibilities: ['Implement'] }],
  },
  environments: [{ environmentInstanceId: 'inst-ready', selection: { kind: 'default' as const } }],
};

test('one Project creation commits selected Agent membership and workspace access together', async () => {
  const { stores, projects, creation } = services();
  try {
    const created = await creation.create(selectedResources);
    const durable = await projects.get(created.id);
    const access = await stores.projectAccess.get(created.id, 'inst-ready');
    assert.ok(durable);
    assert.equal(currentProjectContent(durable).memberships.some((member) => member.memberId === 'agent-ready'), true);
    assert.equal(access?.status, 'active');
    assert.equal(access?.current?.kind, 'default');
    assert.deepEqual(await stores.projectAccess.listForProject(created.id), [access]);
  } finally {
    stores.close();
  }
});

test('workspace preparation refusal leaves Project identity and memberships absent', async () => {
  const { stores, projects, creation } = services({ rejectWorkspace: true });
  try {
    await assert.rejects(() => creation.create(selectedResources));
    assert.equal(await projects.get('project-atomic'), undefined);
    assert.deepEqual(await stores.projectAccess.list(), []);
  } finally {
    stores.close();
  }
});

test('a durable workspace insert failure rolls back the new Project row', async () => {
  const { stores, projects, creation } = services();
  try {
    stores.db.exec(`
      CREATE TRIGGER reject_initial_project_access
      BEFORE INSERT ON project_environment_access
      BEGIN
        SELECT RAISE(ABORT, 'test access insert refusal');
      END;
    `);
    await assert.rejects(() => creation.create(selectedResources));
    assert.equal(await projects.get('project-atomic'), undefined);
    assert.deepEqual(await stores.projectAccess.list(), []);
  } finally {
    stores.close();
  }
});

test('aggregate creation rolls back a prepared Project channel when access persistence fails', async () => {
  let prepared = false;
  let published = false;
  const { stores, projects, creation } = services({
    bridge: {
      prepare: () => {
        prepared = true;
        return {
          commit: () => { published = true; },
          rollback: () => { prepared = false; },
        };
      },
    },
  });
  try {
    stores.db.exec(`
      CREATE TRIGGER reject_initial_project_access
      BEFORE INSERT ON project_environment_access
      BEGIN
        SELECT RAISE(ABORT, 'test access insert refusal');
      END;
    `);
    await assert.rejects(() => creation.create(selectedResources));
    assert.equal(prepared, false);
    assert.equal(published, false);
    assert.equal(await projects.get('project-atomic'), undefined);
  } finally {
    stores.close();
  }
});

test('overlapping duplicate-ID creations leave the winner its Project channel and selected resources', async () => {
  const stores = new SqliteStore({ filename: ':memory:' });
  const id = 'project-atomic';
  const channelId = projectChannelScopeId(id);
  let entered!: () => void;
  const firstRead = new Promise<void>((resolve) => { entered = resolve; });
  let reads = 0;
  const scopes = new ConversationScopeService({
    store: {
      save: (scope) => stores.conversationScopes.save(scope),
      get: async (scopeId) => {
        const snapshot = await stores.conversationScopes.get(scopeId);
        if (scopeId === channelId && ++reads === 1) {
          entered();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return snapshot;
      },
      list: () => stores.conversationScopes.list(),
      listForProject: (projectId) => stores.conversationScopes.listForProject(projectId),
      update: (scopeId, mutate) => stores.conversationScopes.update(scopeId, mutate),
      removeProjectChannel: (scopeId) => stores.conversationScopes.removeProjectChannel(scopeId),
    },
    projects: { projectFacts: async () => undefined },
  });
  const projects = new ProjectService({
    store: stores.projectAuthorities,
    agentAuthority: { agentIsActive: (agentId) => agentId === 'agent-ready' },
    createId: () => id,
    bridge: { prepare: (project) => scopes.prepareProjectChannel(project) },
  });
  const access = new ProjectAccessService({
    store: stores.projectAccess,
    projects,
    environments: { environmentIsAccessible: (instanceId) => instanceId === 'inst-ready' },
    worker: { validate: async ({ selection }) => ({ workspaceId: 'a'.repeat(40), kind: selection.kind }) },
  });
  const creation = new ProjectCreationService({ projects, access, store: stores.projectCreation });
  try {
    const first = creation.create(selectedResources);
    await firstRead;
    const second = creation.create(selectedResources);
    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    const durable = await projects.get(id);
    assert.ok(durable);
    assert.equal(currentProjectContent(durable).memberships.some((member) => member.memberId === 'agent-ready'), true);
    assert.equal((await stores.projectAccess.get(id, 'inst-ready'))?.status, 'active');
    assert.equal((await stores.projectAuthorities.list()).length, 1);
    assert.equal((await stores.projectAccess.list()).length, 1);
    assert.deepEqual((await stores.conversationScopes.listForProject(id)).map((scope) => scope.id), [channelId]);
  } finally {
    stores.close();
  }
});
