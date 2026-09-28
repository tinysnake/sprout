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
import { ProjectService } from '../project/authority-service.ts';
import { InMemoryProjectAuthorityStore } from '../project/authority-store.ts';
import { currentProjectContent } from '../project/authority-model.ts';
import { ConversationScopeService } from '../conversation/service.ts';
import { InMemoryConversationScopeStore } from '../conversation/store.ts';
import { projectChannelScopeId } from '../conversation/model.ts';
import type { ConversationProjectPort } from '../conversation/service.ts';
import { createRunApi } from './api.ts';
import { createProjectRouter } from './project-router.ts';
import { createConversationRouter } from './conversation-router.ts';

/**
 * HTTP contract, Human authority, and privacy behaviour for the conversation
 * scope and Working group routes (#95).
 *
 * The routes are exercised through the real HTTP transport after the #84 auth
 * boundary, so the tests prove what a browser actually receives — including
 * that no credential, host path, host identity, or raw command can be observed
 * — rather than calling the router directly.
 */

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

interface ScopeRuntime {
  readonly api: Awaited<ReturnType<typeof createRunApi>>;
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
  readonly projects: ProjectService;
  readonly scopes: ConversationScopeService;
  readonly scopeStore: InMemoryConversationScopeStore;
}

async function scopeApi(
  options: { readonly failFirstAuthoritySave?: boolean } = {},
): Promise<ScopeRuntime> {
  const authorityStore = new InMemoryProjectAuthorityStore();
  if (options.failFirstAuthoritySave) {
    const save = authorityStore.save.bind(authorityStore);
    let failed = false;
    authorityStore.save = async (project) => {
      if (!failed) {
        failed = true;
        throw new Error('simulated persistence failure');
      }
      await save(project);
    };
  }
  const scopeStore = new InMemoryConversationScopeStore();
  // The composed Project facts port, mirroring the runtime's projection: the
  // durable #92 authority record's lifecycle, versioned content, and membership.
  const projectFacts: ConversationProjectPort = {
    async projectFacts(projectId) {
      const authority = await authorityStore.get(projectId);
      if (authority === undefined) return undefined;
      const content = currentProjectContent(authority);
      return {
        projectId: authority.id,
        status: authority.status,
        contentVersion: authority.content.currentVersion,
        goal: content.goal,
        rules: [...content.rules],
        members: content.memberships.map((membership) => ({
          memberId: membership.memberId,
          memberKind: membership.memberKind,
          ...(membership.endedAt !== undefined ? { endedAt: membership.endedAt } : {}),
          ...(membership.endedReason !== undefined ? { endedReason: membership.endedReason } : {}),
        })),
      };
    },
  };
  const scopes = new ConversationScopeService({
    store: scopeStore,
    projects: projectFacts,
    clock: () => 10_000,
    createId: () => 'wg-http',
  });
  const projects = new ProjectService({
    store: authorityStore,
    clock: () => 10_000,
    agentAuthority: {
      agentIsActive: (agentId) => ['agent-scout', 'agent-scribe'].includes(agentId),
    },
    // The Project channel invariant rides the same prepare flow as the
    // runtime composition, so creating a Project records its channel.
    bridge: { prepare: (project) => scopes.prepareProjectChannel(project) },
  });

  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    projects: new ProjectRegistry([]),
    pool,
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  const credential = randomBytes(32).toString('base64url');
  await auth.initializeOrRecover(credential);
  const api = createRunApi({
    orchestrator,
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    auth,
    routers: [createProjectRouter({ projects }), createConversationRouter({ scopes })],
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
  return { api, base, cookie, csrf: csrfToken, projects, scopes, scopeStore };
}

function get(runtime: ScopeRuntime, path: string): Promise<Response> {
  return fetch(`${runtime.base}${path}`, { headers: { cookie: runtime.cookie } });
}

function command(runtime: ScopeRuntime, path: string, body: unknown): Promise<Response> {
  return fetch(`${runtime.base}${path}`, {
    method: 'POST',
    headers: { cookie: runtime.cookie, 'content-type': 'application/json', 'x-sprout-csrf': runtime.csrf },
    body: JSON.stringify(body),
  });
}

interface ScopeView {
  readonly id: string;
  readonly kind: string;
  readonly projectId?: string;
  readonly participants?: readonly string[];
  readonly status?: string;
  readonly lifecycle?: readonly {
    readonly action: 'disband' | 'restore';
    readonly at: number;
    readonly actorMemberId: string;
    readonly reason: string;
  }[];
  readonly memberships?: readonly {
    readonly memberId: string;
    readonly endedAt?: number;
    readonly endedBy?: string;
  }[];
  readonly content?: {
    readonly currentVersion: number;
    readonly versions: readonly { readonly version: number; readonly goal: string; readonly rules: readonly string[] }[];
  };
}

test('scope routes refuse unauthenticated callers before any domain rule runs', async () => {
  const runtime = await scopeApi();
  try {
    const anonymousGet = await fetch(`${runtime.base}/api/projects/project-x/scopes`);
    assert.equal(anonymousGet.status, 401);
    const anonymousPost = await fetch(`${runtime.base}/api/projects/project-x/working-groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Nope' }),
    });
    assert.equal(anonymousPost.status, 401);
    const anonymousInspect = await fetch(`${runtime.base}/api/scopes/scope-x`);
    assert.equal(anonymousInspect.status, 401);
  } finally {
    await runtime.api.close();
  }
});

test('creating a Project records its one Project channel, and listing keeps exactly one', async () => {
  const runtime = await scopeApi();
  try {
    const created = await command(runtime, '/api/projects', { id: 'project-web', displayName: 'Web' });
    assert.equal(created.status, 201);
    // The channel became durable with the Project itself, before any read.
    const durable = await runtime.scopeStore.get(projectChannelScopeId('project-web'));
    assert.equal(durable?.kind, 'project');

    const listed = await (await get(runtime, '/api/projects/project-web/scopes')).json() as {
      scopes: ScopeView[];
    };
    assert.deepEqual(listed.scopes.map((scope) => scope.kind), ['project']);
    const again = await (await get(runtime, '/api/projects/project-web/scopes')).json() as {
      scopes: ScopeView[];
    };
    assert.deepEqual(again.scopes.map((scope) => scope.id), listed.scopes.map((scope) => scope.id));
  } finally {
    await runtime.api.close();
  }
});

test('a failed Project persistence rolls back its prepared channel row and a retry finds none orphaned', async () => {
  const runtime = await scopeApi({ failFirstAuthoritySave: true });
  try {
    const failed = await command(runtime, '/api/projects', { id: 'project-orphan', displayName: 'Orphan risk' });
    assert.equal(failed.status, 500, 'the failed persistence surfaces as a server error');
    assert.equal(
      await runtime.scopeStore.get(projectChannelScopeId('project-orphan')),
      undefined,
      'no orphan scope row survives the failed Project creation',
    );

    // The retried creation persists and records exactly its one channel.
    const retried = await command(runtime, '/api/projects', { id: 'project-orphan', displayName: 'Orphan risk' });
    assert.equal(retried.status, 201);
    assert.equal(
      (await runtime.scopeStore.get(projectChannelScopeId('project-orphan')))?.kind,
      'project',
    );
  } finally {
    await runtime.api.close();
  }
});

test('direct conversations open idempotently and stay distinct per Project', async () => {
  const runtime = await scopeApi();
  try {
    await command(runtime, '/api/projects', { id: 'project-one', displayName: 'One' });
    await command(runtime, '/api/projects', { id: 'project-two', displayName: 'Two' });

    const open = await command(runtime, '/api/projects/project-one/scopes/direct', {
      participants: ['operator', 'operator'],
    });
    // Two distinct participants are required; the Human alone is not a pair.
    assert.equal(open.status, 400);
    assert.equal(((await open.json()) as { code: string }).code, 'invalid-participants');

    const first = await command(runtime, '/api/projects/project-one/scopes/direct', {
      participants: ['operator', 'agent-scout'],
    });
    // agent-scout is not yet a member of project-one: refused as a conflict.
    assert.equal(first.status, 409);
    assert.equal(((await first.json()) as { code: string }).code, 'not-a-project-member');
    await command(runtime, '/api/projects/project-one/memberships', { agentId: 'agent-scout' });

    const inOne = await command(runtime, '/api/projects/project-one/scopes/direct', {
      participants: ['agent-scout', 'operator'],
    });
    assert.equal(inOne.status, 201);
    const scopeOne = ((await inOne.json()) as { scope: ScopeView }).scope;

    const reopened = await command(runtime, '/api/projects/project-one/scopes/direct', {
      participants: ['operator', 'agent-scout'],
    });
    const scopeAgain = ((await reopened.json()) as { scope: ScopeView }).scope;
    assert.equal(scopeAgain.id, scopeOne.id, 'a repeated open returns one conversation');

    await command(runtime, '/api/projects/project-two/memberships', { agentId: 'agent-scout' });
    const inTwo = await command(runtime, '/api/projects/project-two/scopes/direct', {
      participants: ['operator', 'agent-scout'],
    });
    const scopeTwo = ((await inTwo.json()) as { scope: ScopeView }).scope;
    assert.notEqual(scopeTwo.id, scopeOne.id, 'the same pair in another Project is a distinct conversation');
    assert.deepEqual(scopeOne.participants, ['agent-scout', 'operator']);
  } finally {
    await runtime.api.close();
  }
});

test('the Working group lifecycle over HTTP follows ADR-0008', async () => {
  const runtime = await scopeApi();
  try {
    await command(runtime, '/api/projects', { id: 'project-wg', displayName: 'WG host' });
    await command(runtime, '/api/projects/project-wg/memberships', { agentId: 'agent-scout' });
    await command(runtime, '/api/projects/project-wg/memberships', { agentId: 'agent-scribe' });

    const created = await command(runtime, '/api/projects/project-wg/working-groups', {
      displayName: 'Core Mechanics',
      memberIds: ['agent-scout'],
      goal: 'Design the mechanics.',
      rules: ['Keep the loop short.'],
      reason: 'kickoff',
    });
    assert.equal(created.status, 201);
    const group = ((await created.json()) as { workingGroup: ScopeView }).workingGroup;
    assert.equal(group.kind, 'working-group');
    assert.equal(group.status, 'active');
    assert.deepEqual(
      group.memberships?.map((entry) => entry.memberId),
      ['operator', 'agent-scout'],
      'the Human creator is the first member',
    );
    assert.equal(group.content?.currentVersion, 1);

    const fetched = await (await get(runtime, `/api/working-groups/${group.id}`)).json() as {
      workingGroup: ScopeView;
    };
    assert.equal(fetched.workingGroup.content?.versions[0]?.goal, 'Design the mechanics.');

    const edited = await command(runtime, `/api/working-groups/${group.id}/content`, {
      goal: 'Revised.',
      reason: 'replan',
    });
    assert.equal(edited.status, 200);
    assert.equal(
      ((await edited.json()) as { workingGroup: ScopeView }).workingGroup.content?.currentVersion,
      2,
    );

    const added = await command(runtime, `/api/working-groups/${group.id}/members`, {
      memberId: 'agent-scribe',
    });
    assert.equal(added.status, 200);
    assert.deepEqual(
      ((await added.json()) as { workingGroup: ScopeView }).workingGroup.memberships?.map((entry) => entry.memberId),
      ['operator', 'agent-scout', 'agent-scribe'],
    );

    const ghostAdd = await command(runtime, `/api/working-groups/${group.id}/members`, {
      memberId: 'agent-ghost',
    });
    assert.equal(ghostAdd.status, 409);
    assert.equal(((await ghostAdd.json()) as { code: string }).code, 'member-not-current');

    const ended = await command(runtime, `/api/working-groups/${group.id}/members/agent-scribe/end`, {
      reason: 'review finished',
    });
    assert.equal(ended.status, 200);
    const endedView = ((await ended.json()) as { workingGroup: ScopeView }).workingGroup;
    const scribeEntry = endedView.memberships?.find((entry) => entry.memberId === 'agent-scribe');
    assert.ok(scribeEntry?.endedAt, 'the end is durable');
    assert.equal(scribeEntry?.endedBy, 'operator');

    const disbanded = await command(runtime, `/api/working-groups/${group.id}/disband`, {
      reason: 'done for now',
    });
    assert.equal(disbanded.status, 200);
    const disbandedView = ((await disbanded.json()) as { workingGroup: ScopeView }).workingGroup;
    assert.equal(disbandedView.status, 'disbanded');
    assert.deepEqual(
      disbandedView.lifecycle,
      [
        {
          action: 'disband',
          at: 10_000,
          actorMemberId: 'operator',
          reason: 'done for now',
        },
      ],
      'the disband reaches the browser durably attributed to the acting Human',
    );

    // Read-only after disband, observable over HTTP through the inspection route.
    const readOnlyEdit = await command(runtime, `/api/working-groups/${group.id}/content`, { goal: 'x' });
    assert.equal(readOnlyEdit.status, 409);
    assert.equal(((await readOnlyEdit.json()) as { code: string }).code, 'working-group-disbanded');
    const inspection = await (await get(runtime, `/api/scopes/${group.id}`)).json() as {
      scope: ScopeView;
      state: { writable: boolean; reason?: string };
      context: {
        project: { contentVersion: number; goal: string; rules: readonly string[] };
        workingGroup?: { contentVersion: number; goal: string; rules: readonly string[] };
      };
    };
    assert.deepEqual(inspection.state, {
      scopeId: group.id,
      writable: false,
      reason: 'working-group-disbanded',
    });
    assert.deepEqual(
      inspection.scope.lifecycle,
      disbandedView.lifecycle,
      'the inspection route serves the same attributed lifecycle history',
    );
    // The governing versions remain available, side by side, never merged.
    // Project content versions: create (1) + two membership adds (3).
    assert.equal(inspection.context.project.contentVersion, 3);
    assert.equal(inspection.context.workingGroup?.contentVersion, 2);
    assert.equal(inspection.context.workingGroup?.goal, 'Revised.');

    const restored = await command(runtime, `/api/working-groups/${group.id}/restore`, {
      reason: 'resumed',
    });
    assert.equal(restored.status, 200);
    const restoredView = ((await restored.json()) as { workingGroup: ScopeView }).workingGroup;
    assert.equal(restoredView.status, 'active');
    assert.deepEqual(
      restoredView.lifecycle,
      [
        { action: 'disband', at: 10_000, actorMemberId: 'operator', reason: 'done for now' },
        { action: 'restore', at: 10_000, actorMemberId: 'operator', reason: 'resumed' },
      ],
      'the restore appends its own attributed fact; the prior disband stays auditable',
    );
    const writable = await (await get(runtime, `/api/scopes/${group.id}`)).json() as {
      state: { writable: boolean };
    };
    assert.equal(writable.state.writable, true);
  } finally {
    await runtime.api.close();
  }
});

test('an ended Project membership ends Working group participation over HTTP without erasing history', async () => {
  const runtime = await scopeApi();
  try {
    await command(runtime, '/api/projects', { id: 'project-cascade', displayName: 'Cascade' });
    await command(runtime, '/api/projects/project-cascade/memberships', { agentId: 'agent-scout' });
    const created = await command(runtime, '/api/projects/project-cascade/working-groups', {
      displayName: 'Reviewer loop',
      memberIds: ['agent-scout'],
    });
    const group = ((await created.json()) as { workingGroup: ScopeView }).workingGroup;

    const ended = await command(runtime, '/api/projects/project-cascade/memberships/agent-scout/end', {
      reason: 'moved on',
    });
    assert.equal(ended.status, 200);

    const fetched = await (await get(runtime, `/api/working-groups/${group.id}`)).json() as {
      workingGroup: ScopeView;
    };
    const scout = fetched.workingGroup.memberships?.find((entry) => entry.memberId === 'agent-scout');
    assert.ok(scout?.endedAt, 'the participation ended with the Project membership');
    assert.equal(scout?.endedBy, 'project-membership');
    assert.equal(
      fetched.workingGroup.memberships?.some((entry) => entry.memberId === 'operator'),
      true,
      'the remaining membership history is intact',
    );
  } finally {
    await runtime.api.close();
  }
});

test('the scope read projection re-applies the privacy boundary so a hostile write cannot leak', async () => {
  const runtime = await scopeApi();
  try {
    await command(runtime, '/api/projects', { id: 'project-leak', displayName: 'Leak host' });
    const created = await command(runtime, '/api/projects/project-leak/working-groups', {
      displayName: 'Leaky <redacted-credential>',
      goal: 'Read /home/someone/.ssh/id_rsa and use api_key sk-abcdefghijklmnopqrstuvwx',
      rules: ['Phone home to worker.internal.corp:9000'],
      reason: 'contact sk-abcdefghijklmnopqrstuvwx immediately',
    });
    assert.equal(created.status, 201);
    const group = ((await created.json()) as { workingGroup: ScopeView }).workingGroup;

    const scopeResponse = await (await get(runtime, `/api/scopes/${group.id}`)).json();
    const groupResponse = await (await get(runtime, `/api/working-groups/${group.id}`)).json();
    const listedResponse = await (await get(runtime, '/api/projects/project-leak/scopes')).json();
    const serialized = JSON.stringify([scopeResponse, groupResponse, listedResponse]);
    assert.ok(!serialized.includes('/home/someone'), 'no host path reaches the wire');
    assert.ok(!serialized.includes('sk-abcdefghijklmnopqrstuvwx'), 'no credential reaches the wire');
    assert.ok(!serialized.includes('worker.internal.corp'), 'no hostname reaches the wire');
  } finally {
    await runtime.api.close();
  }
});

test('unknown targets are 404 and malformed input is 400 with typed codes', async () => {
  const runtime = await scopeApi();
  try {
    const missingProject = await get(runtime, '/api/projects/project-none/scopes');
    assert.equal(missingProject.status, 404);
    assert.equal(((await missingProject.json()) as { code: string }).code, 'unknown-project');

    const missingGroup = await get(runtime, '/api/working-groups/wg-none');
    assert.equal(missingGroup.status, 404);
    const missingScope = await get(runtime, '/api/scopes/scope-none');
    assert.equal(missingScope.status, 404);

    await command(runtime, '/api/projects', { id: 'project-valid', displayName: 'Valid' });
    const noName = await command(runtime, '/api/projects/project-valid/working-groups', {});
    assert.equal(noName.status, 400);
    const badMembers = await command(runtime, '/api/projects/project-valid/working-groups', {
      displayName: 'X',
      memberIds: 'operator',
    });
    assert.equal(badMembers.status, 400);
    const badDirect = await command(runtime, '/api/projects/project-valid/scopes/direct', {
      participants: ['operator', 7],
    });
    assert.equal(badDirect.status, 400);
  } finally {
    await runtime.api.close();
  }
});
