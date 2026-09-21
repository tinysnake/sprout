import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createProjectBrowserAdapter, type ProjectAuthorityView } from './project-api.ts';
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
  id: 'project-sprout',
  displayName: 'Sprout',
  status: 'active',
  template: {
    templateId: 'template-general-collaboration',
    templateVersion: 1,
    templateName: 'General collaboration',
    collaborationGuidance: 'Coordinate through the project channel.',
    completionGuidance: 'A Human validates the outcome.',
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
