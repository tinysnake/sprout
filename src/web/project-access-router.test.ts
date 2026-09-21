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
import { createRunApi } from './api.ts';
import { createProjectRouter } from './project-router.ts';
import { toProjectEnvironmentAccessView } from './views.ts';

/**
 * HTTP contract, authorization, and privacy behaviour for the Project
 * Environment access and workspace routes (#93).
 *
 * The routes are exercised through the real HTTP transport after the #84 auth
 * boundary, so the tests prove what a browser actually receives: the
 * validate-before-record rule, binding history, safety-gated change/end, and
 * that no absolute host path can be observed.
 */

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

interface AccessRuntime {
  readonly api: Awaited<ReturnType<typeof createRunApi>>;
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
  readonly access: ProjectAccessService;
}

async function accessApi(options: {
  readonly accessible?: boolean;
  readonly activeWork?: () => boolean;
  readonly workerError?: string;
} = {}): Promise<AccessRuntime> {
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
        memberships: [{ agentId: 'agent-scout', responsibilities: [], collaborationInstructions: '' }],
      },
    ]),
    pool,
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  const credential = randomBytes(32).toString('base64url');
  await auth.initializeOrRecover(credential);
  const projects = new ProjectService({
    store: new InMemoryProjectAuthorityStore(),
    clock: () => 10_000,
    agentAuthority: { agentIsActive: () => true },
  });
  await projects.create({ id: 'project-sprout', displayName: 'Sprout' });
  const access = new ProjectAccessService({
    store: new InMemoryProjectAccessStore(),
    projects,
    clock: () => 10_000,
    createBindingId: (() => {
      let counter = 0;
      return () => `binding-${++counter}`;
    })(),
    environments: { environmentIsAccessible: () => options.accessible ?? true },
    workSafety: { hasActiveWorkOnEnvironment: () => options.activeWork?.() ?? false },
    worker: {
      async validate(input) {
        if (options.workerError !== undefined) throw new Error(options.workerError);
        return {
          workspaceId: 'a'.repeat(40),
          kind: input.selection.kind,
          ...(input.selection.path !== undefined ? { path: input.selection.path } : {}),
        };
      },
    },
  });
  const api = createRunApi({
    orchestrator,
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    auth,
    routers: [createProjectRouter({ projects, access })],
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
  return { api, base, cookie, csrf: csrfToken, access };
}

function get(runtime: AccessRuntime, path: string): Promise<Response> {
  return fetch(`${runtime.base}${path}`, { headers: { cookie: runtime.cookie } });
}

function command(runtime: AccessRuntime, path: string, body: unknown): Promise<Response> {
  return fetch(`${runtime.base}${path}`, {
    method: 'POST',
    headers: { cookie: runtime.cookie, 'content-type': 'application/json', 'x-sprout-csrf': runtime.csrf },
    body: JSON.stringify(body),
  });
}

test('granting access is one authenticated action that records the validated workspace', async () => {
  const runtime = await accessApi();
  try {
    const anonymous = await fetch(`${runtime.base}/api/projects/project-sprout/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ environmentInstanceId: 'mac-mini-1', workspace: { kind: 'default' } }),
    });
    assert.equal(anonymous.status, 401);

    const granted = await command(runtime, '/api/projects/project-sprout/access', {
      environmentInstanceId: 'mac-mini-1',
      workspace: { kind: 'relative', path: 'repos/sprout' },
      reason: 'initial repository',
    });
    assert.equal(granted.status, 201);
    const body = (await granted.json()) as {
      access: { status: string; current: { kind: string; path?: string; workspaceId: string }; history: unknown[] };
    };
    assert.equal(body.access.status, 'active');
    assert.equal(body.access.current.kind, 'relative');
    assert.equal(body.access.current.path, 'repos/sprout');
    assert.equal(body.access.history.length, 1);
    // The opaque workspace id is exposed, but never an absolute host path.
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('/Users/'));
    assert.ok(!serialized.includes(':\\'));
  } finally {
    await runtime.api.close();
  }
});

test('a failed Worker validation leaves the Project with no access over HTTP', async () => {
  const runtime = await accessApi({ workerError: 'the directory is not below the Worker root' });
  try {
    const failed = await command(runtime, '/api/projects/project-sprout/access', {
      environmentInstanceId: 'mac-mini-1',
      workspace: { kind: 'relative', path: 'repos/missing' },
    });
    assert.equal(failed.status, 400);
    assert.equal(((await failed.json()) as { code: string }).code, 'workspace-validation-failed');
    const listed = (await (await get(runtime, '/api/projects/project-sprout/access')).json()) as {
      access: unknown[];
    };
    assert.deepEqual(listed.access, []);
  } finally {
    await runtime.api.close();
  }
});

test('an unapproved Environment and an unsafe selection are distinct refusals', async () => {
  const runtime = await accessApi({ accessible: false });
  try {
    const notApproved = await command(runtime, '/api/projects/project-sprout/access', {
      environmentInstanceId: 'mac-mini-1',
      workspace: { kind: 'default' },
    });
    assert.equal(notApproved.status, 400);
    assert.equal(((await notApproved.json()) as { code: string }).code, 'environment-not-approved');

    const unsafe = await command(runtime, '/api/projects/project-sprout/access', {
      environmentInstanceId: 'mac-mini-1',
      workspace: { kind: 'relative', path: '/etc/passwd' },
    });
    assert.equal(unsafe.status, 400);
    assert.equal(((await unsafe.json()) as { code: string }).code, 'invalid-workspace-selection');
  } finally {
    await runtime.api.close();
  }
});

test('workspace change appends a binding and the old binding remains observable', async () => {
  const runtime = await accessApi();
  try {
    await command(runtime, '/api/projects/project-sprout/access', {
      environmentInstanceId: 'mac-mini-1',
      workspace: { kind: 'relative', path: 'repos/first' },
    });
    const changed = await command(runtime, '/api/projects/project-sprout/access/mac-mini-1/workspace', {
      workspace: { kind: 'relative', path: 'repos/second' },
      reason: 'maintained repository',
    });
    assert.equal(changed.status, 200);
    const body = (await changed.json()) as {
      access: {
        current: { path?: string };
        history: { path?: string; unboundAt?: number; unboundReason?: string }[];
      };
    };
    assert.equal(body.access.current.path, 'repos/second');
    assert.equal(body.access.history.length, 2);
    assert.equal(body.access.history[0]?.path, 'repos/first');
    assert.ok(body.access.history[0]?.unboundAt !== undefined);
    assert.equal(body.access.history[0]?.unboundReason, 'maintained repository');

    const listed = (await (await get(runtime, '/api/projects/project-sprout/access')).json()) as {
      access: { history: unknown[] }[];
    };
    assert.equal(listed.access.length, 1);
    assert.equal(listed.access[0]?.history.length, 2);
  } finally {
    await runtime.api.close();
  }
});

test('a workspace change and an access end are refused with 409 while active work depends on the binding', async () => {
  let activeWork = false;
  const runtime = await accessApi({ activeWork: () => activeWork });
  try {
    await command(runtime, '/api/projects/project-sprout/access', {
      environmentInstanceId: 'mac-mini-1',
      workspace: { kind: 'relative', path: 'repos/first' },
    });
    activeWork = true;
    const change = await command(runtime, '/api/projects/project-sprout/access/mac-mini-1/workspace', {
      workspace: { kind: 'relative', path: 'repos/second' },
    });
    assert.equal(change.status, 409);
    assert.equal(((await change.json()) as { code: string }).code, 'active-work-depends-on-binding');
    const end = await command(runtime, '/api/projects/project-sprout/access/mac-mini-1/end', {});
    assert.equal(end.status, 409);
    assert.equal(((await end.json()) as { code: string }).code, 'active-work-depends-on-binding');

    activeWork = false;
    const ended = await command(runtime, '/api/projects/project-sprout/access/mac-mini-1/end', {
      reason: 'retired',
    });
    assert.equal(ended.status, 200);
    const body = (await ended.json()) as {
      access: { status: string; current?: unknown; history: { unboundAt?: number }[]; endedReason?: string };
    };
    assert.equal(body.access.status, 'ended');
    assert.equal(body.access.current, undefined);
    assert.equal(body.access.history.length, 1);
    assert.ok(body.access.history[0]?.unboundAt !== undefined);
    assert.equal(body.access.endedReason, 'retired');
  } finally {
    await runtime.api.close();
  }
});

test('the access view never exposes an absolute host path, even from a corrupt record', () => {
  // Defence in depth: the domain refuses an absolute location, but the wire
  // projection must also drop one rather than pass it through.
  const view = toProjectEnvironmentAccessView({
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    status: 'active',
    startedAt: 1,
    updatedAt: 2,
    current: {
      bindingId: 'binding-1',
      workspaceId: 'a'.repeat(40),
      kind: 'relative',
      path: '/Users/operator/secret/repo',
      boundAt: 1,
    },
    history: [
      {
        bindingId: 'binding-0',
        workspaceId: 'b'.repeat(40),
        kind: 'relative',
        path: 'C:\\Users\\operator\\secret',
        boundAt: 0,
        unboundAt: 1,
        unboundReason: 'moved',
      },
    ],
  });
  assert.equal(view.current?.path, undefined, 'an absolute location is dropped');
  assert.equal(view.history[0]?.path, undefined, 'an escaped location is dropped');
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('/Users/'));
  assert.ok(!serialized.includes('C:\\'));
});

test('unknown access operations return typed errors rather than 500', async () => {
  const runtime = await accessApi();
  try {
    const missing = await command(runtime, '/api/projects/project-sprout/access/mac-mini-1/end', {});
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code: string }).code, 'unknown-environment-access');
    const unknownProject = await command(runtime, '/api/projects/project-none/access', {
      environmentInstanceId: 'mac-mini-1',
      workspace: { kind: 'default' },
    });
    assert.equal(unknownProject.status, 404);
    assert.equal(((await unknownProject.json()) as { code: string }).code, 'unknown-project');
    const malformed = await command(runtime, '/api/projects/project-sprout/access', {
      environmentInstanceId: 'mac-mini-1',
      workspace: { kind: 'nonsense' },
    });
    assert.equal(malformed.status, 400);
  } finally {
    await runtime.api.close();
  }
});

/**
 * The API boundary (ADR-0009): a Worker diagnostic that embeds a host path, a
 * credential, or machine identity reaches the client only as sanitized text.
 * The stable typed code is the contract; the message is not a leak channel.
 */
test('a Worker validation failure returns the sanitized typed error over HTTP', async () => {
  const runtime = await accessApi({
    workerError:
      'stat failed at /Users/<user>/secret and token=ghp_AAAAAAAAAAAAAAAAAAAAAA on build-7.internal',
  });
  try {
    const response = await command(runtime, '/api/projects/project-sprout/access', {
      environmentInstanceId: 'mac-mini-1',
      workspace: { kind: 'default' },
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; code: string };
    assert.equal(body.code, 'workspace-validation-failed');
    assert.match(body.error, /could not validate the selected Project workspace/);
    assert.ok(!body.error.includes('/Users/'), 'no host path reaches the API');
    assert.ok(!body.error.includes('ghp_AAAA'), 'no credential reaches the API');
    assert.ok(!body.error.includes('build-7.internal'), 'no machine identity reaches the API');
  } finally {
    await runtime.api.close();
  }
});
