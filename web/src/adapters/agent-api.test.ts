import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAgentBrowserAdapter, type AgentView } from './agent-api.ts';
import { BrowserRequestError, type BrowserTransport } from '../transport/browser-transport.ts';

/**
 * The typed browser adapter contract for Agent identities (#90).
 *
 * The adapter must hit exactly the documented additive routes, send commands as
 * POST JSON bodies, reject failures through the shared transport immediately,
 * and never fabricate a fact (an unknown agent is a rejection, not a row).
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

const agent: AgentView = {
  id: 'programmer',
  displayName: 'Programmer',
  status: 'active',
  configuration: {
    currentVersion: 2,
    versions: [
      {
        version: 1,
        at: 1_000,
        reason: 'Agent created with its initial ordered work options.',
        options: [{ id: 'opt-1', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' }],
      },
      {
        version: 2,
        at: 2_000,
        reason: 'switch primary engine',
        options: [{ id: 'opt-1', engine: 'pi', workModel: 'glm-5', effort: 'medium' }],
      },
    ],
  },
  createdAt: 1_000,
  updatedAt: 2_000,
};

test('the adapter reads agents through the additive routes', async () => {
  const { transport, calls } = recordingTransport((path) => {
    if (path === '/api/agents' || path.startsWith('/api/agents?')) return { agents: [agent] };
    return { agent };
  });
  const adapter = createAgentBrowserAdapter(transport);
  assert.deepEqual(await adapter.listAgents(), [agent]);
  assert.deepEqual(await adapter.listAgents('archived'), [agent]);
  assert.deepEqual(await adapter.getAgent('programmer'), agent);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/agents', '/api/agents?status=archived', '/api/agents/programmer'],
  );
});

test('creation and reconfiguration send POST JSON command bodies', async () => {
  const { transport, calls } = recordingTransport(() => ({ agent }));
  const adapter = createAgentBrowserAdapter(transport);
  await adapter.createAgent({
    id: 'programmer',
    displayName: 'Programmer',
    workOptions: [{ id: 'opt-1', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' }],
  });
  await adapter.reconfigureAgent('programmer', {
    workOptions: [{ engine: 'pi', workModel: 'glm-5', effort: 'medium' }],
    reason: 'switch primary engine',
  });
  assert.equal(calls[0]!.path, '/api/agents');
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.deepEqual(
    JSON.parse(String(calls[0]!.init?.body)),
    {
      id: 'programmer',
      displayName: 'Programmer',
      workOptions: [{ id: 'opt-1', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' }],
    },
  );
  assert.equal(calls[1]!.path, '/api/agents/programmer/configuration');
  assert.equal(calls[1]!.init?.method, 'POST');
});

test('archive and restore use the non-destructive command routes', async () => {
  const { transport, calls } = recordingTransport(() => ({ agent: { ...agent, status: 'archived' } }));
  const adapter = createAgentBrowserAdapter(transport);
  await adapter.archiveAgent('programmer');
  await adapter.restoreAgent('programmer');
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/agents/programmer/archive', '/api/agents/programmer/restore'],
  );
});

test('compatibility and run attribution read their dedicated routes', async () => {
  const { transport, calls } = recordingTransport((path) => {
    if (path.includes('/work-option')) {
      return {
        runId: 'run-1',
        agentId: 'programmer',
        environmentInstanceId: 'mac-mini-1',
        attribution: { engine: 'pi', workModel: 'glm-5', effort: 'medium', configurationVersion: 2 },
      };
    }
    return {
      agentId: 'programmer',
      environmentInstanceId: 'mac-mini-1',
      available: false,
      unavailableReason: 'Engine "codex" is not installed on this Environment.',
      options: [],
    };
  });
  const adapter = createAgentBrowserAdapter(transport);
  const compatibility = await adapter.compatibility('programmer');
  assert.equal(compatibility.available, false);
  assert.match(compatibility.unavailableReason ?? '', /not installed/);
  const attribution = await adapter.runWorkOption('run-1');
  assert.equal(attribution.attribution?.engine, 'pi');
  assert.equal(attribution.attribution?.configurationVersion, 2);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/agents/programmer/compatibility', '/api/runs/run-1/work-option'],
  );
});

test('a failed request rejects immediately through the shared transport', async () => {
  const transport: BrowserTransport = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    setCsrfToken: () => undefined,
    async request<T>(): Promise<T> {
      throw new BrowserRequestError('unknown agent', 404);
    },
    events: () => () => undefined,
  };
  const adapter = createAgentBrowserAdapter(transport);
  await assert.rejects(() => adapter.getAgent('nobody'), BrowserRequestError);
});
