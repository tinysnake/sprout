import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createProjectAccessBrowserAdapter,
  createProjectBrowserAdapter,
  type ProjectAuthorityView,
  type ProjectEnvironmentAccessView,
} from './project-api.ts';
import { type BrowserTransport } from '../transport/browser-transport.ts';

/**
 * The typed browser adapter contract for Project authority (#92).
 *
 * The adapter must hit exactly the documented additive routes, send commands
 * as POST JSON bodies, reject failures through the shared transport
 * immediately, and never fabricate a fact (an unknown project is a rejection,
 * not a row).
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

const project: ProjectAuthorityView = {
  // Preserved composer fields (F6): the browser authority view keeps the M1
  // `goal` and `memberIds` projection the existing composer consumes.
  id: 'project-sprout',
  goal: 'Revised goal',
  memberIds: ['agent-scout'],
  displayName: 'Sprout',
  status: 'active',
  template: {
    templateId: 'template-general-collaboration',
    templateVersion: 1,
    templateName: 'General collaboration',
    collaborationGuidance: 'Coordinate through the project channel.',
    completionGuidance: 'A Human validates the outcome.',
    goalGuidance: 'Coordinate durable, Human-supervised work toward a shared goal.',
    suggestedRules: ['Report what you actually observed.'],
    roleSlots: [
      {
        name: 'Contributor',
        suggestedResponsibilities: ['Investigate and implement assigned work'],
        suggestedCollaborationInstructions: 'Collaborate through the project channel.',
      },
    ],
    wakePolicy: 'explicit-only',
    routingIntervalMs: 30_000,
  },
  content: {
    currentVersion: 2,
    versions: [
      {
        version: 1,
        at: 1_000,
        reason: 'Created from the General collaboration template.',
        goal: 'First goal',
        rules: ['Report observations'],
        wakePolicy: 'explicit-only',
        routingIntervalMs: 30_000,
        memberships: [
          { memberId: 'operator', memberKind: 'human', responsibilities: [], collaborationInstructions: '', startedAt: 1_000 },
        ],
      },
      {
        version: 2,
        at: 2_000,
        reason: 'Replan after feedback',
        goal: 'Revised goal',
        rules: [],
        wakePolicy: 'wake-model-assisted',
        routingIntervalMs: 45_000,
        memberships: [
          {
            memberId: 'agent-scout',
            memberKind: 'agent',
            responsibilities: ['Investigate'],
            collaborationInstructions: 'Concise.',
            startedAt: 2_000,
          },
        ],
      },
    ],
  },
  createdAt: 1_000,
  updatedAt: 2_000,
};

test('the adapter reads projects through the additive authority routes', async () => {
  const { transport, calls } = recordingTransport((path) => {
    if (path === '/api/projects/authorities' || path.startsWith('/api/projects/authorities?')) {
      return { projects: [project] };
    }
    return { project };
  });
  const adapter = createProjectBrowserAdapter(transport);
  assert.deepEqual(await adapter.listProjects(), [project]);
  assert.deepEqual(await adapter.listProjects('archived'), [project]);
  assert.deepEqual(await adapter.getProject('project-sprout'), project);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/projects/authorities', '/api/projects/authorities?status=archived', '/api/projects/project-sprout'],
  );
  // The typed browser view carries the same preserved composer fields the
  // server projection sends, so the M1 composer and the M2 page share one
  // wire contract (F6).
  const viewed = await adapter.getProject('project-sprout');
  assert.equal(viewed.goal, 'Revised goal');
  assert.deepEqual(viewed.memberIds, ['agent-scout']);
  assert.equal(viewed.template.wakePolicy, 'explicit-only');
  assert.equal(viewed.template.routingIntervalMs, 30_000);
  assert.equal(viewed.template.roleSlots.length, 1);
});

test('creation and content edits send POST JSON command bodies', async () => {
  const { transport, calls } = recordingTransport(() => ({ project }));
  const adapter = createProjectBrowserAdapter(transport);
  await adapter.createProject({
    id: 'project-sprout',
    displayName: 'Sprout',
    agentMemberships: [{ agentId: 'agent-scout', responsibilities: ['Investigate'] }],
  });
  await adapter.updateProjectContent('project-sprout', { goal: null, rules: ['New rule'] });
  const [create, edit] = calls;
  assert.equal(create?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(create?.init?.body)), {
    id: 'project-sprout',
    displayName: 'Sprout',
    agentMemberships: [{ agentId: 'agent-scout', responsibilities: ['Investigate'] }],
  });
  assert.equal(edit?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(edit?.init?.body)), { goal: null, rules: ['New rule'] });
});

test('membership, archive, and restore commands hit their dedicated routes', async () => {
  const { transport, calls } = recordingTransport(() => ({ project }));
  const adapter = createProjectBrowserAdapter(transport);
  await adapter.addProjectMembership('project-sprout', { agentId: 'agent-two' });
  await adapter.endProjectMembership('project-sprout', 'agent-two', { reason: 'moving on' });
  await adapter.archiveProject('project-sprout', { reason: 'done' });
  await adapter.restoreProject('project-sprout');
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/projects/project-sprout/memberships',
      '/api/projects/project-sprout/memberships/agent-two/end',
      '/api/projects/project-sprout/archive',
      '/api/projects/project-sprout/restore',
    ],
  );
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { reason: 'moving on' });
});

const access: ProjectEnvironmentAccessView = {
  projectId: 'project-sprout',
  environmentInstanceId: 'mac-mini-1',
  status: 'active',
  startedAt: 1_000,
  updatedAt: 2_000,
  current: {
    bindingId: 'binding-2',
    workspaceId: 'a'.repeat(40),
    kind: 'relative',
    path: 'repos/second',
    boundAt: 2_000,
  },
  history: [
    {
      bindingId: 'binding-1',
      workspaceId: 'a'.repeat(40),
      kind: 'relative',
      path: 'repos/first',
      boundAt: 1_000,
      unboundAt: 2_000,
      unboundReason: 'moved',
    },
    {
      bindingId: 'binding-2',
      workspaceId: 'a'.repeat(40),
      kind: 'relative',
      path: 'repos/second',
      boundAt: 2_000,
    },
  ],
};

test('the access adapter reads and commands the additive access routes', async () => {
  const { transport, calls } = recordingTransport((path) => {
    if (path.endsWith('/access') && path.startsWith('/api/projects/')) {
      // A list route returns an array; a grant returns one record.
      return path === '/api/projects/project-sprout/access'
        ? { access: [access] }
        : { access };
    }
    return { access };
  });
  const adapter = createProjectAccessBrowserAdapter(transport);
  assert.deepEqual(await adapter.listProjectAccess('project-sprout'), [access]);
  await adapter.grantProjectAccess('project-sprout', {
    environmentInstanceId: 'mac-mini-1',
    workspace: { kind: 'default' },
  });
  await adapter.changeProjectWorkspace('project-sprout', 'mac-mini-1', {
    workspace: { kind: 'relative', path: 'repos/third' },
    reason: 'maintained',
  });
  await adapter.endProjectAccess('project-sprout', 'mac-mini-1', { reason: 'retired' });

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/projects/project-sprout/access',
      '/api/projects/project-sprout/access',
      '/api/projects/project-sprout/access/mac-mini-1/workspace',
      '/api/projects/project-sprout/access/mac-mini-1/end',
    ],
  );
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    environmentInstanceId: 'mac-mini-1',
    workspace: { kind: 'default' },
  });
  const changed = JSON.parse(String(calls[2]?.init?.body)) as { workspace: { kind: string; path: string } };
  assert.equal(changed.workspace.path, 'repos/third');
  // The typed view exposes the Worker-relative location, never an absolute path.
  const serialized = JSON.stringify(access);
  assert.ok(!serialized.includes('/Users/'));
});
