import assert from 'node:assert/strict';
import { test } from 'node:test';

import { currentProjectContent } from './authority-model.ts';
import { ProjectService } from './authority-service.ts';
import { ProjectAccessService } from './access-service.ts';
import { ProjectCreationService } from './creation-service.ts';
import { SqliteStore } from '../store/db.ts';

function services(options: { readonly rejectWorkspace?: boolean } = {}) {
  const stores = new SqliteStore({ filename: ':memory:' });
  const projects = new ProjectService({
    store: stores.projectAuthorities,
    agentAuthority: { agentIsActive: (agentId) => agentId === 'agent-ready' },
    createId: () => 'project-atomic',
  });
  const access = new ProjectAccessService({
    store: stores.projectAccess,
    projects,
    environments: { environmentIsAccessible: () => true },
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
  environments: [{ environmentInstanceId: 'env-ready', selection: { kind: 'default' as const } }],
};

test('one Project creation commits selected Agent membership and workspace access together', async () => {
  const { stores, projects, creation } = services();
  try {
    const created = await creation.create(selectedResources);
    const durable = await projects.get(created.id);
    const access = await stores.projectAccess.get(created.id, 'env-ready');
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
