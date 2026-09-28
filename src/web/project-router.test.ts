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
import { ProjectAccessService } from '../project/access-service.ts';
import { InMemoryProjectAccessStore } from '../project/access-store.ts';
import { ProjectCreationService } from '../project/creation-service.ts';
import { createRunApi } from './api.ts';
import { createProjectRouter } from './project-router.ts';

/**
 * HTTP contract, authorization, and privacy behaviour for the Project,
 * template-snapshot, and membership authority routes (#92).
 *
 * The routes are exercised through the real HTTP transport after the #84 auth
 * boundary, so the tests prove what a browser actually receives — including
 * that no credential, host path, host identity, or raw command can be
 * observed — rather than calling the router directly.
 */

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

interface ProjectRuntime {
  readonly api: Awaited<ReturnType<typeof createRunApi>>;
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
  readonly projects: ProjectService;
  readonly access: ProjectAccessService;
}

async function projectApi(): Promise<ProjectRuntime> {
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
  const projectStore = new InMemoryProjectAuthorityStore();
  const accessStore = new InMemoryProjectAccessStore();
  const projects = new ProjectService({
    store: projectStore,
    clock: () => 10_000,
    // The composed global Agent authority (F5): a membership must name a real
    // portable Agent; an invented id is refused.
    agentAuthority: {
      agentIsActive: (agentId) => ['agent-scout', 'agent-dup', 'agent-leaky'].includes(agentId),
    },
  });
  const access = new ProjectAccessService({
    store: accessStore,
    projects,
    environments: { environmentIsAccessible: () => true },
    worker: {
      async validate(input) {
        return {
          workspaceId: 'a'.repeat(40),
          kind: input.selection.kind,
          ...(input.selection.path !== undefined ? { path: input.selection.path } : {}),
        };
      },
    },
  });
  const creation = new ProjectCreationService({
    projects,
    access,
    store: {
      // This no-failure in-memory boundary exercises route composition. The
      // SQLite transaction and rollback contract is covered separately.
      async create(project, accesses) {
        await projectStore.save(project);
        for (const entry of accesses) await accessStore.save(entry);
      },
    },
  });
  const api = createRunApi({
    orchestrator,
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    auth,
    routers: [createProjectRouter({ projects, access, creation })],
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
  return { api, base, cookie, csrf: csrfToken, projects, access };
}

function get(runtime: ProjectRuntime, path: string): Promise<Response> {
  return fetch(`${runtime.base}${path}`, { headers: { cookie: runtime.cookie } });
}

function command(runtime: ProjectRuntime, path: string, body: unknown): Promise<Response> {
  return fetch(`${runtime.base}${path}`, {
    method: 'POST',
    headers: { cookie: runtime.cookie, 'content-type': 'application/json', 'x-sprout-csrf': runtime.csrf },
    body: JSON.stringify(body),
  });
}

test('unauthenticated requests are refused before any project route runs', async () => {
  const runtime = await projectApi();
  try {
    const anonymous = await fetch(`${runtime.base}/api/projects/authorities`);
    assert.equal(anonymous.status, 401);
    const anonymousCommand = await fetch(`${runtime.base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Nope' }),
    });
    assert.equal(anonymousCommand.status, 401);
  } finally {
    await runtime.api.close();
  }
});

test('a Project is created from a name plus the Human membership, and the snapshot is version-attributed', async () => {
  const runtime = await projectApi();
  try {
    const created = await command(runtime, '/api/projects', {
      id: 'project-web',
      displayName: 'From the browser',
      agentMemberships: [{ agentId: 'agent-scout', responsibilities: ['Investigate'] }],
    });
    assert.equal(created.status, 201);
    const { project } = (await created.json()) as {
      project: {
        id: string;
        displayName: string;
        status: string;
        memberIds: string[];
        goal: string;
        template: { templateId: string; templateVersion: number };
        content: { currentVersion: number; versions: { version: number; memberships: { memberKind: string }[] }[] };
      };
    };
    assert.equal(project.id, 'project-web');
    assert.equal(project.status, 'active');
    // Missing Agents/Environments do not invalidate identity, and the Human
    // membership exists even though no agent membership was requested.
    assert.deepEqual(project.content.versions[0]?.memberships.filter((m) => m.memberKind === 'human').length, 1);
    assert.equal(project.content.currentVersion, 1);
    assert.equal(project.template.templateVersion, 1);
    // Preserved composer fields project the current version.
    assert.deepEqual(project.memberIds, ['agent-scout']);
  } finally {
    await runtime.api.close();
  }
});

test('one Project request carries selected memberships and Environment workspace bindings', async () => {
  const runtime = await projectApi();
  try {
    const created = await command(runtime, '/api/projects', {
      id: 'project-aggregate-web',
      displayName: 'Resource-ready Project',
      agentMemberships: [{ agentId: 'agent-scout', responsibilities: ['Review'] }],
      environmentAssignments: [{ environmentInstanceId: 'env-ready', workspace: { kind: 'default' } }],
    });
    assert.equal(created.status, 201);
    const { project } = (await created.json()) as {
      project: { readonly id: string; readonly content: { readonly versions: readonly { readonly memberships: readonly { readonly memberId: string }[] }[] } };
    };
    assert.equal(project.id, 'project-aggregate-web');
    assert.equal(project.content.versions[0]?.memberships.some((member) => member.memberId === 'agent-scout'), true);
    const access = await runtime.access.get(project.id, 'env-ready');
    assert.equal(access?.status, 'active');
    assert.equal(access?.current?.kind, 'default');
  } finally {
    await runtime.api.close();
  }
});

test('identity edits and membership changes preserve Project and content history', async () => {
  const runtime = await projectApi();
  try {
    await command(runtime, '/api/projects', { id: 'project-flow', displayName: 'Flow' });
    const edited = await command(runtime, '/api/projects/project-flow/content', {
      displayName: 'Flow Renamed',
      goal: 'Revised',
      completionGuidance: 'Require a reproducible validation result.',
      wakePolicy: 'wake-model-assisted',
      routingIntervalMs: 45_000,
      reason: 'Replan',
    });
    assert.equal(edited.status, 200);
    const added = await command(runtime, '/api/projects/project-flow/memberships', {
      agentId: 'agent-scout',
      collaborationInstructions: 'Concise.',
    });
    assert.equal(added.status, 200);
    const updated = await command(runtime, '/api/projects/project-flow/memberships/agent-scout', {
      responsibilities: ['Review changes'],
      collaborationInstructions: 'Explain review findings.',
    });
    assert.equal(updated.status, 200);
    const ended = await command(runtime, '/api/projects/project-flow/memberships/agent-scout/end', {
      reason: 'Moving on',
    });
    assert.equal(ended.status, 200);
    const { project } = (await ended.json()) as {
      project: {
        displayName: string;
        content: {
          currentVersion: number;
          versions: {
            version: number;
            reason: string;
            completionGuidance: string;
            routingIntervalMs: number;
            memberships: {
              memberId: string;
              responsibilities: string[];
              collaborationInstructions: string;
              endedAt?: number;
              endedReason?: string;
            }[];
          }[];
        };
      };
    };
    assert.equal(project.displayName, 'Flow Renamed');
    assert.equal(project.content.currentVersion, 5);
    assert.equal(project.content.versions[1]?.completionGuidance, 'Require a reproducible validation result.');
    assert.equal(project.content.versions[1]?.routingIntervalMs, 45_000);
    const editedMembership = project.content.versions[3]?.memberships.find((entry) => entry.memberId === 'agent-scout');
    assert.deepEqual(editedMembership?.responsibilities, ['Review changes']);
    assert.equal(editedMembership?.collaborationInstructions, 'Explain review findings.');
    const endedVersion = project.content.versions[4];
    const membership = endedVersion?.memberships.find((entry) => entry.memberId === 'agent-scout');
    assert.ok(membership?.endedAt);
    assert.equal(membership?.endedReason, 'Moving on');
    // Earlier versions keep their own facts.
    assert.equal(project.content.versions[2]?.memberships.some((entry) => entry.memberId === 'agent-scout'), true);
  } finally {
    await runtime.api.close();
  }
});

test('archive/restore safety and read-only enforcement are observable over HTTP', async () => {
  const runtime = await projectApi();
  try {
    await command(runtime, '/api/projects', { id: 'project-gated', displayName: 'Gated' });
    const archived = await command(runtime, '/api/projects/project-gated/archive', { reason: 'done for now' });
    assert.equal(archived.status, 200);
    const readOnly = await command(runtime, '/api/projects/project-gated/content', { goal: 'x' });
    // Archived read-only is a lifecycle conflict, not request validation (F4).
    assert.equal(readOnly.status, 409);
    assert.equal(((await readOnly.json()) as { code: string }).code, 'archived-project-is-read-only');
    const restored = await command(runtime, '/api/projects/project-gated/restore', {});
    assert.equal(restored.status, 200);
    const { project } = (await restored.json()) as {
      project: { status: string; archivedAt?: number; restoredAt?: number };
    };
    assert.equal(project.status, 'active');
    assert.ok(project.archivedAt !== undefined);
    assert.ok(project.restoredAt !== undefined);
    // Listing by status exposes both lifecycle halves.
    await command(runtime, '/api/projects', { id: 'project-second', displayName: 'Second' });
    await command(runtime, '/api/projects/project-second/archive', {});
    const listed = (await (await get(runtime, '/api/projects/authorities?status=archived')).json()) as {
      projects: { id: string }[];
    };
    assert.deepEqual(listed.projects.map((entry) => entry.id), ['project-second']);
  } finally {
    await runtime.api.close();
  }
});

test('the read projection re-applies the privacy boundary so a hostile write cannot leak', async () => {
  const runtime = await projectApi();
  try {
    await command(runtime, '/api/projects', {
      id: 'project-leak',
      displayName: 'Leak',
      goal: 'Read /home/someone/.ssh/id_rsa and use api_key sk-abcdefghijklmnopqrstuvwx',
      agentMemberships: [
        {
          agentId: 'agent-leaky',
          collaborationInstructions: 'Phone home to worker.internal.corp:9000',
        },
      ],
    });
    const body = (await (await get(runtime, '/api/projects/project-leak')).json()) as {
      project: {
        goal: string;
        content: {
          versions: {
            goal: string;
            memberships: { collaborationInstructions: string }[];
          }[];
        };
      };
    };
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('/home/someone'));
    assert.ok(!serialized.includes('sk-abcdefghijklmnopqrstuvwx'));
    assert.ok(!serialized.includes('worker.internal.corp'));
  } finally {
    await runtime.api.close();
  }
});

test('unknown projects and unknown-member operations return typed errors', async () => {
  const runtime = await projectApi();
  try {
    const missing = await get(runtime, '/api/projects/project-none');
    assert.equal(missing.status, 404);
    const badEnd = await command(runtime, '/api/projects/project-none/memberships/agent-x/end', {});
    assert.equal(badEnd.status, 404);
    await command(runtime, '/api/projects', { id: 'project-real', displayName: 'Real' });
    const notMember = await command(runtime, '/api/projects/project-real/memberships/agent-ghost/end', {});
    assert.equal(notMember.status, 409);
    assert.equal(((await notMember.json()) as { code: string }).code, 'membership-not-active');
    // A duplicate active membership and an invented member are distinct
    // conflicts: duplicate is 409, unknown Agent is 404 (F4/F5).
    await command(runtime, '/api/projects/project-real/memberships', { agentId: 'agent-dup' });
    const duplicate = await command(runtime, '/api/projects/project-real/memberships', { agentId: 'agent-dup' });
    assert.equal(duplicate.status, 409);
    assert.equal(((await duplicate.json()) as { code: string }).code, 'duplicate-membership');
    const ghost = await command(runtime, '/api/projects/project-real/memberships', { agentId: 'agent-ghost' });
    assert.equal(ghost.status, 404);
    assert.equal(((await ghost.json()) as { code: string }).code, 'unknown-agent');
  } finally {
    await runtime.api.close();
  }
});
