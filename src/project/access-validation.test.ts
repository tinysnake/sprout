import { test } from 'node:test';

import assert from 'node:assert/strict';import { ProjectAccessError } from './access.ts';

import { ProjectAccessService, type WorkspaceValidatorPort } from './access-service.ts';

import { InMemoryProjectAccessStore, type ProjectAccessStore } from './access-store.ts';

import { ProjectService } from './authority-service.ts';

import { InMemoryProjectAuthorityStore } from './authority-store.ts';import type { ValidatedWorkspace } from './access.ts';

import { BridgedProjectRegistry } from './bridged-registry.ts';


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


test('concurrent grants for different Environments merge their runtime projections', async () => {
  const registry = new BridgedProjectRegistry();
  const projects = new ProjectService({
    store: new InMemoryProjectAuthorityStore(),
    agentAuthority: { agentIsActive: () => true },
    bridge: registry,
  });
  await projects.create({ id: 'project-sprout', displayName: 'Sprout' });
  const access = new ProjectAccessService({
    store: new InMemoryProjectAccessStore(),
    projects,
    worker: validator().port,
    environments: { environmentIsAccessible: () => true },
    bridge: registry,
    createBindingId: (() => {
      let id = 0;
      return () => `binding-${++id}`;
    })(),
  });

  await Promise.all([
    access.grant({ projectId: 'project-sprout', environmentInstanceId: 'env-a', selection: { kind: 'default' } }),
    access.grant({ projectId: 'project-sprout', environmentInstanceId: 'env-b', selection: { kind: 'relative', path: 'repos/b' } }),
  ]);

  const projected = registry.get('project-sprout');
  assert.deepEqual(projected?.availableEnvironmentInstanceIds.slice().sort(), ['env-a', 'env-b']);
  assert.deepEqual(
    projected?.workspaces?.slice().sort((a, b) => a.environmentInstanceId.localeCompare(b.environmentInstanceId)),
    [{ environmentInstanceId: 'env-a' }, { environmentInstanceId: 'env-b', path: 'repos/b' }],
    'each commit merges only its Environment instead of replacing a stale project-wide snapshot',
  );
});


/**
 * A Worker exception is hostile text: it may embed host paths, credentials, or
 * machine identity. The durable ProjectAccessError — and therefore every API
 * response — carries only the sanitized diagnostic, never the raw message.
 */
test('a Worker validation failure sanitizes the raw error before it is raised', async () => {
  const { access } = await service({
    worker: validator({
      error: `stat failed at /Users/<user>/secret: token=ghp_AAAAAAAAAAAAAAAAAAAAAA --host build-7.internal`,
    }).port,
  });
  let raised: unknown;
  try {
    await access.grant({
      projectId: 'project-sprout',
      environmentInstanceId: 'mac-mini-1',
      selection: { kind: 'default' },
    });
    assert.fail('the validation failure must be raised');
  } catch (caught) {
    raised = caught;
  }
  assert.ok(raised instanceof ProjectAccessError);
  assert.equal(raised.code, 'workspace-validation-failed');
  assert.match(raised.message, /could not validate the selected Project workspace/);
  assert.doesNotMatch(raised.message, /\/Users\/<user>\/secret/);
  assert.doesNotMatch(raised.message, /ghp_AAAA/);
  assert.doesNotMatch(raised.message, /build-7\.internal/);
});


/**
 * A malformed Worker answer must be rejected, never coerced: a relative
 * selection answered with `kind: 'default'` would otherwise persist a
 * completely different durable workspace than the one the Human selected.
 */
test('a Worker answer whose kind mismatches the selection is rejected, not coerced', async () => {
  const { access } = await service({
    worker: validator({
      result: () => ({ workspaceId: 'a'.repeat(40), kind: 'default' }),
    }).port,
  });
  await assert.rejects(
    () =>
      access.grant({
        projectId: 'project-sprout',
        environmentInstanceId: 'mac-mini-1',
        selection: { kind: 'relative', path: 'repos/sprout' },
      }),
    (error: unknown) =>
      error instanceof ProjectAccessError && error.code === 'workspace-validation-failed',
  );
  const unchanged = await access.get('project-sprout', 'mac-mini-1');
  assert.equal(unchanged, undefined, 'a kind mismatch records nothing');
});


/** The mirror direction: a default selection answered with a relative kind. */
test('a default selection answered with a relative kind is rejected, not coerced', async () => {
  const { access } = await service({
    worker: validator({
      result: () => ({ workspaceId: 'a'.repeat(40), kind: 'relative', path: 'repos/other' }),
    }).port,
  });
  await assert.rejects(
    () =>
      access.grant({
        projectId: 'project-sprout',
        environmentInstanceId: 'mac-mini-1',
        selection: { kind: 'default' },
      }),
    (error: unknown) =>
      error instanceof ProjectAccessError && error.code === 'workspace-validation-failed',
  );
  const unchanged = await access.get('project-sprout', 'mac-mini-1');
  assert.equal(unchanged, undefined, 'a kind mismatch records nothing');
});


/** A change carries the same fail-closed rule as a grant. */
test('a workspace change refuses a kind mismatch without unbinding the current workspace', async () => {
  const { access } = await service();
  await access.grant({
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    selection: { kind: 'relative', path: 'repos/first' },
  });
  const mismatched = await service({
    worker: validator({
      result: () => ({ workspaceId: 'b'.repeat(40), kind: 'default' }),
    }).port,
  });
  await mismatched.access.grant({
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    selection: { kind: 'default' },
  });
  await assert.rejects(
    () =>
      mismatched.access.changeWorkspace({
        projectId: 'project-sprout',
        environmentInstanceId: 'mac-mini-1',
        selection: { kind: 'relative', path: 'repos/second' },
      }),
    (error: unknown) =>
      error instanceof ProjectAccessError && error.code === 'workspace-validation-failed',
  );
  const unchanged = await mismatched.access.get('project-sprout', 'mac-mini-1');
  assert.equal(unchanged?.history.length, 1, 'the refused change unbinds nothing');
  assert.equal(unchanged?.current?.kind, 'default');
});
