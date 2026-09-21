import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProjectAccessError,
  accessIsConsistent,
  sanitizeWorkspacePath,
  sanitizeWorkspaceSelection,
} from './access.ts';
import { ProjectAccessService, type WorkspaceValidatorPort } from './access-service.ts';
import { InMemoryProjectAccessStore, type ProjectAccessStore } from './access-store.ts';
import { ProjectService } from './authority-service.ts';
import { InMemoryProjectAuthorityStore } from './authority-store.ts';
import type { ProjectEnvironmentAccess, ValidatedWorkspace } from './access.ts';

/**
 * Domain behaviour for Project Environment access and Project workspaces (#93,
 * ADR-0008).
 *
 * These tests pin the ticket's acceptance rules at the domain boundary:
 * validate-before-record, one current binding per Environment with append-only
 * history, safety-gated change and end, and the absolute-path prohibition.
 */

function validator(options: {
  readonly result?: (input: {
    readonly projectId: string;
    readonly environmentInstanceId: string;
    readonly selection: { readonly kind: 'default' | 'relative'; readonly path?: string };
  }) => ValidatedWorkspace;
  readonly error?: string;
} = {}): { readonly port: WorkspaceValidatorPort; readonly calls: unknown[] } {
  const calls: unknown[] = [];
  const port: WorkspaceValidatorPort = {
    async validate(input) {
      calls.push(input);
      if (options.error !== undefined) throw new Error(options.error);
      return options.result === undefined
        ? {
            workspaceId: 'a'.repeat(40),
            kind: input.selection.kind,
            ...(input.selection.path !== undefined ? { path: input.selection.path } : {}),
          }
        : options.result(input);
    },
  };
  return { port, calls };
}

async function service(options: {
  readonly worker?: WorkspaceValidatorPort;
  readonly environments?: { environmentIsAccessible(id: string): boolean };
  readonly workSafety?: { hasActiveWorkOnEnvironment(projectId: string, instanceId: string): boolean };
  readonly clock?: () => number;
  readonly projects?: ProjectService;
  readonly store?: ProjectAccessStore;
} = {}) {
  const projects =
    options.projects ??
    new ProjectService({
      store: new InMemoryProjectAuthorityStore(),
      clock: options.clock ?? (() => 10_000),
      agentAuthority: { agentIsActive: () => true },
    });
  if (options.projects === undefined) {
    await projects.create({ id: 'project-sprout', displayName: 'Sprout' });
  }
  const store = options.store ?? new InMemoryProjectAccessStore();
  let counter = 0;
  const access = new ProjectAccessService({
    store,
    projects,
    worker: options.worker ?? validator().port,
    environments: options.environments ?? { environmentIsAccessible: () => true },
    ...(options.workSafety !== undefined ? { workSafety: options.workSafety } : {}),
    clock: options.clock ?? (() => 10_000),
    createBindingId: () => `binding-${++counter}`,
  });
  return { access, store, projects };
}

/**
 * A store that returns a fresh deep copy on every read, like the SQLite adapter
 * does when it parses one JSON document per call.
 *
 * The in-memory store returns the same object reference, which would hide an
 * unbind rule that compared bindings by object identity instead of by the
 * one-open-binding invariant.
 */
function cloningStore(): ProjectAccessStore {
  const inner = new InMemoryProjectAccessStore();
  const clone = (access: ProjectEnvironmentAccess): ProjectEnvironmentAccess =>
    JSON.parse(JSON.stringify(access)) as ProjectEnvironmentAccess;
  return {
    async save(access) {
      await inner.save(access);
    },
    async get(projectId, environmentInstanceId) {
      const found = await inner.get(projectId, environmentInstanceId);
      return found === undefined ? undefined : clone(found);
    },
    async listForProject(projectId) {
      return (await inner.listForProject(projectId)).map(clone);
    },
    async list() {
      return (await inner.list()).map(clone);
    },
  };
}

test('a Worker-managed default grant records access only after the Worker validates', async () => {
  const worker = validator();
  const { access } = await service({ worker: worker.port });
  const granted = await access.grant({
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    selection: { kind: 'default' },
  });

  assert.equal(worker.calls.length, 1, 'the Worker validated before anything was durable');
  assert.equal(granted.status, 'active');
  assert.equal(granted.current?.kind, 'default');
  assert.equal(granted.current?.workspaceId, 'a'.repeat(40));
  // The default carries no location, so no path is exposed.
  assert.equal(granted.current?.path, undefined);
  assert.equal(accessIsConsistent(granted), true);
});

test('a failed Worker validation leaves the Project unchanged', async () => {
  const worker = validator({ error: 'no such directory below the Worker root' });
  const { access, store } = await service({ worker: worker.port });
  await assert.rejects(
    () =>
      access.grant({
        projectId: 'project-sprout',
        environmentInstanceId: 'mac-mini-1',
        selection: { kind: 'relative', path: 'repos/sprout' },
      }),
    (error: unknown) => error instanceof ProjectAccessError && error.code === 'workspace-validation-failed',
  );
  assert.deepEqual(await store.listForProject('project-sprout'), []);
});

test('a relative grant exposes a Worker-root-relative location and never an absolute path', async () => {
  const { access } = await service();
  const granted = await access.grant({
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    selection: { kind: 'relative', path: 'repos/sprout' },
  });
  assert.equal(granted.current?.kind, 'relative');
  assert.equal(granted.current?.path, 'repos/sprout');
  const serialized = JSON.stringify(granted);
  assert.ok(!serialized.includes('/Users/'), 'no absolute host path may appear');
  assert.ok(!serialized.includes(':\\'), 'no Windows absolute path may appear');
});

test('a relative selection that is absolute or escapes the root is refused before any Worker call', async () => {
  const worker = validator();
  const { access } = await service({ worker: worker.port });
  for (const path of ['/etc/passwd', 'C:\\Users\\x', '../escape', 'a/../../b', '']) {
    await assert.rejects(
      () =>
        access.grant({
          projectId: 'project-sprout',
          environmentInstanceId: 'mac-mini-1',
          selection: { kind: 'relative', path },
        }),
      (error: unknown) => error instanceof ProjectAccessError && error.code === 'invalid-workspace-selection',
      `path ${JSON.stringify(path)} must be refused`,
    );
  }
  assert.equal(worker.calls.length, 0, 'the Worker is never asked to validate an unsafe selection');
});

test('a second grant for the same Environment is refused while access is active', async () => {
  const { access } = await service();
  await access.grant({ projectId: 'project-sprout', environmentInstanceId: 'mac-mini-1', selection: { kind: 'default' } });
  await assert.rejects(
    () => access.grant({ projectId: 'project-sprout', environmentInstanceId: 'mac-mini-1', selection: { kind: 'default' } }),
    (error: unknown) => error instanceof ProjectAccessError && error.code === 'duplicate-environment-access',
  );
});

test('granting access to an Environment with no approved enrollment is refused', async () => {
  const { access } = await service({ environments: { environmentIsAccessible: () => false } });
  await assert.rejects(
    () => access.grant({ projectId: 'project-sprout', environmentInstanceId: 'mac-mini-1', selection: { kind: 'default' } }),
    (error: unknown) => error instanceof ProjectAccessError && error.code === 'environment-not-approved',
  );
});

test('changing the workspace retains the previous binding and marks it unbound', async () => {
  const { access } = await service();
  await access.grant({
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    selection: { kind: 'relative', path: 'repos/first' },
  });
  const changed = await access.changeWorkspace({
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    selection: { kind: 'relative', path: 'repos/second' },
    reason: 'moved to the maintained repository',
  });
  assert.equal(changed.current?.path, 'repos/second');
  assert.equal(changed.history.length, 2, 'the old binding is retained');
  const [previous, current] = changed.history;
  assert.equal(previous?.path, 'repos/first');
  assert.equal(previous?.unboundAt, 10_000);
  assert.equal(previous?.unboundReason, 'moved to the maintained repository');
  assert.equal(current?.path, 'repos/second');
  assert.equal(current?.unboundAt, undefined);
  // At most one open binding, which is what "one current workspace" means.
  assert.equal(changed.history.filter((binding) => binding.unboundAt === undefined).length, 1);
  assert.equal(accessIsConsistent(changed), true);
});

test('a workspace change is refused while active work depends on the binding', async () => {
  let activeWork = false;
  const { access } = await service({
    workSafety: { hasActiveWorkOnEnvironment: () => activeWork },
  });
  await access.grant({
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    selection: { kind: 'relative', path: 'repos/first' },
  });
  activeWork = true;
  await assert.rejects(
    () =>
      access.changeWorkspace({
        projectId: 'project-sprout',
        environmentInstanceId: 'mac-mini-1',
        selection: { kind: 'relative', path: 'repos/second' },
      }),
    (error: unknown) => error instanceof ProjectAccessError && error.code === 'active-work-depends-on-binding',
  );
  // The binding is untouched: a refused change records nothing.
  const unchanged = await access.get('project-sprout', 'mac-mini-1');
  assert.equal(unchanged?.current?.path, 'repos/first');
  assert.equal(unchanged?.history.length, 1);
});

test('ending access is non-destructive and refused while active work depends on the binding', async () => {
  let activeWork = false;
  const { access } = await service({
    workSafety: { hasActiveWorkOnEnvironment: () => activeWork },
  });
  await access.grant({ projectId: 'project-sprout', environmentInstanceId: 'mac-mini-1', selection: { kind: 'relative', path: 'repos/sprout' } });

  activeWork = true;
  await assert.rejects(
    () => access.end({ projectId: 'project-sprout', environmentInstanceId: 'mac-mini-1' }),
    (error: unknown) => error instanceof ProjectAccessError && error.code === 'active-work-depends-on-binding',
  );

  activeWork = false;
  const ended = await access.end({ projectId: 'project-sprout', environmentInstanceId: 'mac-mini-1', reason: 'retired' });
  assert.equal(ended.status, 'ended');
  assert.equal(ended.current, undefined);
  assert.equal(ended.history.length, 1, 'history is retained');
  assert.equal(ended.history[0]?.unboundAt, 10_000);
  assert.equal(ended.endedReason, 'retired');
  assert.equal(accessIsConsistent(ended), true);

  // Re-granting reactivates the relationship with a fresh binding while keeping
  // the original history and relationship start.
  const regranted = await access.grant({ projectId: 'project-sprout', environmentInstanceId: 'mac-mini-1', selection: { kind: 'default' } });
  assert.equal(regranted.status, 'active');
  assert.equal(regranted.history.length, 2);
  assert.equal(regranted.startedAt, ended.startedAt);
});

test('access to an archived Project is refused at the access boundary', async () => {
  const projects = new ProjectService({
    store: new InMemoryProjectAuthorityStore(),
    clock: () => 10_000,
    agentAuthority: { agentIsActive: () => true },
  });
  await projects.create({ id: 'project-sprout', displayName: 'Sprout' });
  await projects.archive('project-sprout');
  const { access } = await service({ projects });
  await assert.rejects(
    () => access.grant({ projectId: 'project-sprout', environmentInstanceId: 'mac-mini-1', selection: { kind: 'default' } }),
    (error: unknown) => error instanceof ProjectAccessError && error.code === 'archived-project-is-read-only',
  );
});

test('the workspace path validator refuses absolute, traversal, and Windows-rooted locations', () => {
  assert.equal(sanitizeWorkspacePath('repos/sprout'), 'repos/sprout');
  assert.equal(sanitizeWorkspacePath('minesweeper'), 'minesweeper');
  assert.equal(sanitizeWorkspacePath('/etc'), undefined);
  assert.equal(sanitizeWorkspacePath('C:/Users'), undefined);
  assert.equal(sanitizeWorkspacePath('..'), undefined);
  assert.equal(sanitizeWorkspacePath('a/../b'), undefined);
  assert.equal(sanitizeWorkspacePath(''), undefined);
  assert.deepEqual(sanitizeWorkspaceSelection({ kind: 'default' }), { kind: 'default' });
  assert.deepEqual(
    sanitizeWorkspaceSelection({ kind: 'relative', path: 'repos/sprout' }),
    { kind: 'relative', path: 'repos/sprout' },
  );
});

/**
 * The unbind rule must not depend on object identity.
 *
 * A durable store (SQLite) parses one JSON document per read, so the current
 * binding and its history entry are distinct objects. Changing or ending the
 * workspace over such a store must still leave exactly one open binding.
 */
test('change and end unbind correctly over a store that returns fresh copies', async () => {
  const { access } = await service({ store: cloningStore() });
  await access.grant({
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    selection: { kind: 'relative', path: 'repos/first' },
  });
  const changed = await access.changeWorkspace({
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    selection: { kind: 'relative', path: 'repos/second' },
    reason: 'moved',
  });
  assert.equal(changed.history.length, 2);
  assert.equal(changed.history.filter((binding) => binding.unboundAt === undefined).length, 1);
  assert.equal(accessIsConsistent(changed), true);

  const ended = await access.end({
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    reason: 'retired',
  });
  assert.equal(ended.status, 'ended');
  assert.equal(ended.current, undefined);
  assert.equal(ended.history.filter((binding) => binding.unboundAt === undefined).length, 0);
  assert.equal(accessIsConsistent(ended), true);
});
