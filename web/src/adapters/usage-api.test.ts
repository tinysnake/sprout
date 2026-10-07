import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUsageBrowserAdapter } from './usage-api.ts';
import { emptyUsageAggregate } from '../../../src/usage/model.ts';
import type { BrowserTransport } from '../transport/browser-transport.ts';

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

test('usage browser adapter sends typed range and cross-filter queries to aggregate endpoints', async () => {
  const aggregate = emptyUsageAggregate();
  const { transport, calls } = recordingTransport(() => aggregate);
  const usage = createUsageBrowserAdapter(transport);

  assert.equal(usage.state().status, 'online');
  assert.deepEqual(await usage.getAggregate({
    kind: 'agent_run', projectId: 'project/one', from: 1000, to: 2000,
    timeZone: 'America/New_York', provisional: false, groupBy: 'model',
  }), aggregate);
  assert.deepEqual(await usage.getTaskUsage('task one', {
    projectId: 'project/one', agentId: 'agent/a', from: 1000, to: 2000, timeZone: 'UTC',
  }), aggregate);
  assert.deepEqual(await usage.getModelUsage('model/v1', { projectId: 'project/one', to: 3000 }), aggregate);

  assert.deepEqual(calls.map((call) => call.path), [
    '/api/usage/aggregate?kind=agent_run&projectId=project%2Fone&from=1000&to=2000&timeZone=America%2FNew_York&provisional=false&groupBy=model',
    '/api/usage/tasks/task%20one?projectId=project%2Fone&agentId=agent%2Fa&from=1000&to=2000&timeZone=UTC',
    '/api/usage/models/model%2Fv1?projectId=project%2Fone&to=3000',
  ]);
});

test('usage browser adapter reads constituent activity identities and activity history through typed routes', async () => {
  const detail = {
    activity: { id: 'ua_att_attempt-1', kind: 'routing_attempt' },
    observations: [],
    supersessionHistory: [],
  };
  const { transport, calls } = recordingTransport((path) => {
    if (path.startsWith('/api/usage/activities?')) return { activities: [] };
    return detail;
  });
  const usage = createUsageBrowserAdapter(transport);

  assert.deepEqual(await usage.listActivities({ projectId: 'project/one', from: 1000, to: 2000, limit: 25 }), []);
  assert.deepEqual(await usage.getActivity('ua_att_attempt-1'), detail);
  assert.deepEqual(await usage.getRoutingAttemptUsage('attempt/one'), detail);
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/usage/activities?projectId=project%2Fone&from=1000&to=2000&limit=25',
    '/api/usage/activities/ua_att_attempt-1',
    '/api/usage/attempts/attempt%2Fone',
  ]);
});
