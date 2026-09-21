import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { OperatorSessionService } from '../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../auth/store.ts';
import { InMemoryAgentStore } from '../agent/store.ts';
import { AgentService } from '../agent/service.ts';
import { createRunApi } from './api.ts';
import { createAgentRouter } from './agent-router.ts';

/**
 * HTTP contract, authorization, and privacy behaviour for the portable Agent
 * identity routes (#90).
 *
 * The routes are exercised through the real HTTP transport after the #84 auth
 * boundary, so the tests prove what a browser actually receives — including
 * that no credential, host path, or host identity can be observed — rather
 * than calling the router directly.
 */

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

interface AgentRuntime {
  readonly api: Awaited<ReturnType<typeof createRunApi>>;
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
  readonly agents: AgentService;
}

async function agentApi(): Promise<AgentRuntime> {
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    projects: new ProjectRegistry([
      {
        id: 'project-sprout',
        goal: 'Ship Sprout',
        rules: [],
        availableEnvironmentInstanceIds: ['mac-mini-1'],
        memberships: [
          { agentId: 'agent-scout', responsibilities: [], collaborationInstructions: '' },
        ],
      },
    ]),
    pool,
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  const credential = randomBytes(32).toString('base64url');
  await auth.initializeOrRecover(credential);
  const agents = new AgentService({ store: new InMemoryAgentStore(), clock: () => 10_000 });
  const api = createRunApi({
    orchestrator,
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    auth,
    routers: [createAgentRouter({ agents })],
  });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  assert.equal(response.status, 201);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return { api, base, cookie, csrf: csrfToken, agents };
}

function command(
  base: string,
  path: string,
  session: { readonly cookie: string; readonly csrf: string },
  body?: unknown,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'x-sprout-csrf': session.csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });
}

function read(
  base: string,
  path: string,
  session: { readonly cookie: string },
): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { cookie: session.cookie } });
}

interface AgentWireView {
  readonly id: string;
  readonly displayName: string;
  readonly status: string;
  readonly configuration: {
    readonly currentVersion: number;
    readonly versions: readonly {
      readonly version: number;
      readonly options: readonly { readonly engine: string; readonly workModel: string; readonly effort: string }[];
      readonly instructions?: string;
    }[];
  };
}

test('an anonymous caller cannot reach any Agent identity route', async () => {
  const runtime = await agentApi();
  try {
    assert.equal((await fetch(`${runtime.base}/api/agents`)).status, 401);
    assert.equal((await fetch(`${runtime.base}/api/agents`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${runtime.base}/api/agents/x`)).status, 401);
  } finally {
    await runtime.api.close();
  }
});

test('a write without the CSRF header is refused', async () => {
  const runtime = await agentApi();
  try {
    const response = await fetch(`${runtime.base}/api/agents`, {
      method: 'POST',
      headers: { cookie: runtime.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'X', workOptions: [{ engine: 'codex', workModel: 'm', effort: 'high' }] }),
    });
    assert.equal(response.status, 403);
  } finally {
    await runtime.api.close();
  }
});

test('an Agent is created over HTTP with its identity, options, and version', async () => {
  const runtime = await agentApi();
  try {
    const created = await command(runtime.base, '/api/agents', runtime, {
      id: 'programmer',
      displayName: 'Programmer',
      instructions: 'Check pure functions.',
      workOptions: [
        { id: 'opt-1', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' },
        { id: 'opt-2', engine: 'pi', workModel: 'glm-5', effort: 'medium' },
      ],
    });
    assert.equal(created.status, 201);
    const { agent } = (await created.json()) as { agent: AgentWireView };
    assert.equal(agent.id, 'programmer');
    assert.equal(agent.displayName, 'Programmer');
    assert.equal(agent.status, 'active');
    assert.equal(agent.configuration.currentVersion, 1);
    assert.equal(agent.configuration.versions[0]!.options.length, 2);
    assert.equal(agent.configuration.versions[0]!.instructions, 'Check pure functions.');

    // The durable store holds the same identity.
    assert.equal((await runtime.agents.get('programmer'))?.displayName, 'Programmer');
  } finally {
    await runtime.api.close();
  }
});

test('creation validates the display name and the minimum-one-option invariant', async () => {
  const runtime = await agentApi();
  try {
    const noName = await command(runtime.base, '/api/agents', runtime, {
      displayName: '',
      workOptions: [{ engine: 'codex', workModel: 'm', effort: 'high' }],
    });
    assert.equal(noName.status, 400);
    const noOptions = await command(runtime.base, '/api/agents', runtime, {
      displayName: 'X',
      workOptions: [],
    });
    assert.equal(noOptions.status, 400);
    const malformed = await command(runtime.base, '/api/agents', runtime, {
      displayName: 'X',
    });
    assert.equal(malformed.status, 400);
  } finally {
    await runtime.api.close();
  }
});

test('configuration edits append versions; the archive guard and restore work over HTTP', async () => {
  const runtime = await agentApi();
  try {
    await command(runtime.base, '/api/agents', runtime, {
      id: 'programmer',
      displayName: 'Programmer',
      workOptions: [{ id: 'opt-1', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' }],
    });

    const edited = await command(runtime.base, '/api/agents/programmer/configuration', runtime, {
      workOptions: [{ id: 'opt-1', engine: 'pi', workModel: 'glm-5', effort: 'medium' }],
      reason: 'switch primary engine',
    });
    assert.equal(edited.status, 200);
    const { agent: editedAgent } = (await edited.json()) as { agent: AgentWireView };
    assert.equal(editedAgent.configuration.currentVersion, 2);
    assert.equal(editedAgent.configuration.versions.length, 2);

    const archived = await command(runtime.base, '/api/agents/programmer/archive', runtime, {});
    assert.equal(archived.status, 200);
    const { agent: archivedAgent } = (await archived.json()) as { agent: AgentWireView };
    assert.equal(archivedAgent.status, 'archived');
    // The configuration history survived the archive verbatim.
    assert.equal(archivedAgent.configuration.versions.length, 2);

    // An archived Agent is read-only.
    const editArchived = await command(runtime.base, '/api/agents/programmer/configuration', runtime, {
      workOptions: [{ engine: 'pi', workModel: 'm', effort: 'low' }],
    });
    assert.equal(editArchived.status, 400);

    const restored = await command(runtime.base, '/api/agents/programmer/restore', runtime, {});
    assert.equal(restored.status, 200);
    const { agent: restoredAgent } = (await restored.json()) as { agent: AgentWireView };
    assert.equal(restoredAgent.status, 'active');
  } finally {
    await runtime.api.close();
  }
});

test('the list and detail routes report archived Agents and filter by status', async () => {
  const runtime = await agentApi();
  try {
    await command(runtime.base, '/api/agents', runtime, {
      id: 'agent-a', displayName: 'A', workOptions: [{ engine: 'codex', workModel: 'm', effort: 'high' }],
    });
    await command(runtime.base, '/api/agents', runtime, {
      id: 'agent-b', displayName: 'B', workOptions: [{ engine: 'pi', workModel: 'm', effort: 'low' }],
    });
    await command(runtime.base, '/api/agents/agent-b/archive', runtime, {});

    const all = await read(runtime.base, '/api/agents', runtime);
    assert.equal(all.status, 200);
    const listed = (await all.json()) as { agents: readonly AgentWireView[] };
    assert.equal(listed.agents.length, 2);

    const archivedOnly = await read(runtime.base, '/api/agents?status=archived', runtime);
    const archivedList = (await archivedOnly.json()) as { agents: readonly AgentWireView[] };
    assert.deepEqual(archivedList.agents.map((agent) => agent.id), ['agent-b']);

  } finally {
    await runtime.api.close();
  }
});

test('instructions null over the wire clears durably; an omitted field keeps them', async () => {
  const runtime = await agentApi();
  try {
    await command(runtime.base, '/api/agents', runtime, {
      id: 'programmer',
      displayName: 'Programmer',
      instructions: 'Verify tests before claiming completion.',
      workOptions: [{ id: 'opt-1', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' }],
    });

    // An omitted field keeps the current instructions (a keep-edit still
    // appends its version).
    const kept = await command(runtime.base, '/api/agents/programmer/configuration', runtime, {
      workOptions: [{ id: 'opt-1', engine: 'pi', workModel: 'glm-5', effort: 'medium' }],
      reason: 'switch engine',
    });
    assert.equal(kept.status, 200);
    const { agent: keptAgent } = (await kept.json()) as { agent: AgentWireView };
    assert.equal(keptAgent.configuration.currentVersion, 2);
    assert.equal(keptAgent.configuration.versions[1]!.instructions, 'Verify tests before claiming completion.');

    // An explicit `null` clears: the new version carries no instructions and
    // the read-back proves the durable state, not just the response.
    const cleared = await command(runtime.base, '/api/agents/programmer/configuration', runtime, {
      workOptions: [{ id: 'opt-1', engine: 'pi', workModel: 'glm-5', effort: 'medium' }],
      instructions: null,
      reason: 'Standing instructions updated.',
    });
    assert.equal(cleared.status, 200);
    const { agent: clearedAgent } = (await cleared.json()) as { agent: AgentWireView };
    assert.equal(clearedAgent.configuration.currentVersion, 3);
    assert.equal('instructions' in clearedAgent.configuration.versions[2]!, false);

    const detail = await read(runtime.base, '/api/agents/programmer', runtime);
    assert.equal(detail.status, 200);
    const { agent: reread } = (await detail.json()) as { agent: AgentWireView };
    assert.equal('instructions' in reread.configuration.versions[2]!, false, 'the clear is durable');
    assert.equal(reread.configuration.versions[0]!.instructions, 'Verify tests before claiming completion.');
    assert.equal(reread.configuration.versions[1]!.instructions, 'Verify tests before claiming completion.');
  } finally {
    await runtime.api.close();
  }
});

test('validation refusals answer with a typed 400 code and no raw diagnostic', async () => {
  const runtime = await agentApi();
  try {
    await command(runtime.base, '/api/agents', runtime, {
      id: 'programmer',
      displayName: 'Programmer',
      workOptions: [{ id: 'opt-1', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' }],
    });

    // A host-shaped work model is refused by the write boundary.
    const refused = await command(runtime.base, '/api/agents/programmer/configuration', runtime, {
      workOptions: [{ engine: 'codex', workModel: 'buildbox-7', effort: 'high' }],
    });
    assert.equal(refused.status, 400);
    const { error, code } = (await refused.json()) as { error?: string; code?: string };
    assert.match(error ?? '', /valid work model identifier/);
    assert.equal(code, 'invalid-work-option');
    // The refusal never carries a host path, credential, or address shape.
    assert.equal(/\/Users\//.test(error ?? ''), false);
    assert.equal(/sk-[a-zA-Z0-9]{20,}/.test(error ?? ''), false);
    // Nothing was written.
    const unchanged = await read(runtime.base, '/api/agents/programmer', runtime);
    const { agent } = (await unchanged.json()) as { agent: AgentWireView };
    assert.equal(agent.configuration.currentVersion, 1);
  } finally {
    await runtime.api.close();
  }
});

test('no host path, credential, or address can enter an Agent through the API', async () => {
  const runtime = await agentApi();
  try {
    // The display name carrying a path and a credential is refused outright:
    // it reduces to placeholders, so there is nothing usable to persist.
    const badName = await command(runtime.base, '/api/agents', runtime, {
      id: 'leaky',
      displayName: '/Users/someone/.ssh sk-abcdefghijklmnopqrstuvwx',
      workOptions: [{ engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' }],
    });
    assert.equal(badName.status, 400);

    // A host-shaped work model cannot masquerade as an identifier.
    const badOption = await command(runtime.base, '/api/agents', runtime, {
      id: 'leaky',
      displayName: 'Leaky',
      instructions: 'Run against 10.0.0.42 and read /etc/secrets with password=hunter2correcthorse',
      workOptions: [
        { engine: 'codex', workModel: 'buildbox-7', effort: 'high' },
        { engine: 'pi', workModel: 'glm-5', effort: 'medium' },
      ],
    });
    assert.equal(badOption.status, 400);
    const body = (await badOption.json()) as { error?: string };
    assert.match(body.error ?? '', /valid work model identifier/);
    // Nothing durable was written for either refused request.
    assert.equal(await runtime.agents.get('leaky'), undefined);
  } finally {
    await runtime.api.close();
  }
});
