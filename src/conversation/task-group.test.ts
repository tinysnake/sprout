import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationScopeService, type ConversationProjectFacts } from './service.ts';
import { InMemoryConversationScopeStore } from './store.ts';

interface TaskGroupSyncInput {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly lead: { readonly memberId: string; readonly kind: 'human' | 'agent' };
  readonly contentVersion: number;
  readonly status: 'in-progress' | 'done' | 'failed' | 'stopped' | 'cancelled';
}

function fixture() {
  let facts: ConversationProjectFacts = {
    projectId: 'project-alpha', status: 'active', contentVersion: 1,
    goal: 'Project goal', rules: ['Project rule'],
    members: [
      { memberId: 'operator', memberKind: 'human' },
      { memberId: 'scout', memberKind: 'agent' },
      { memberId: 'scribe', memberKind: 'agent' },
    ],
  };
  const store = new InMemoryConversationScopeStore();
  const scopes = new ConversationScopeService({
    store,
    projects: { projectFacts: async (projectId) => projectId === 'project-alpha' ? facts : projectId === 'project-beta' ? { ...facts, projectId } : undefined },
    clock: () => 100,
  });
  return {
    scopes,
    store,
    setFacts(next: ConversationProjectFacts) { facts = next; },
  };
}

async function sync(scopes: ConversationScopeService, input: TaskGroupSyncInput) {
  const port = scopes as unknown as {
    syncTaskGroup(value: TaskGroupSyncInput): Promise<{
      readonly id: string;
      readonly kind: string;
      readonly taskId: string;
      readonly frozenAt?: number;
      readonly terminalTaskStatus?: 'done' | 'failed' | 'stopped' | 'cancelled';
      readonly content: { readonly currentVersion: number; readonly versions: readonly {
        readonly taskContentVersion: number;
        readonly taskTitle: string;
        readonly goal: string;
        readonly rules: readonly string[];
      }[] };
    }>;
  };
  return port.syncTaskGroup(input);
}

const task = (taskId: string, overrides: Partial<TaskGroupSyncInput> = {}): TaskGroupSyncInput => ({
  taskId, projectId: 'project-alpha', title: `Task ${taskId}`, goal: `Goal ${taskId}`,
  constraints: [`Constraint ${taskId}`], lead: { memberId: 'operator', kind: 'human' },
  contentVersion: 1, status: 'in-progress', ...overrides,
});

test('task-group binds versioned task content and keeps task identity immutable', async () => {
  const f = fixture();
  const first = await sync(f.scopes, task('task-one'));
  assert.equal(first.kind, 'task-group');
  assert.equal(first.taskId, 'task-one');
  assert.equal(first.frozenAt, undefined);
  assert.equal(first.content.versions[0]?.taskTitle, 'Task task-one');
  assert.equal(first.content.versions[0]?.goal, 'Goal task-one');
  assert.deepEqual(first.content.versions[0]?.rules, ['Constraint task-one']);
  assert.deepEqual((await f.scopes.scopeContext(first.id)).taskGroup, {
    taskId: 'task-one', taskTitle: 'Task task-one', contentVersion: 1, taskContentVersion: 1,
    goal: 'Goal task-one', rules: ['Constraint task-one'],
  });

  const revised = await sync(f.scopes, task('task-one', {
    title: 'Revised task title', goal: 'Revised goal', constraints: ['Revised constraint'], contentVersion: 2,
  }));
  assert.equal(revised.content.currentVersion, 2);
  assert.equal(revised.content.versions.length, 2);
  assert.equal(revised.content.versions[1]?.taskContentVersion, 2);
  assert.equal(revised.content.versions[1]?.goal, 'Revised goal');
  await assert.rejects(
    sync(f.scopes, task('task-one', { projectId: 'project-beta' })),
    /cannot be rebound|binding/i,
  );
});

test('every current Project member, including later joiners, is admitted to the task-group', async () => {
  const f = fixture();
  const scope = await sync(f.scopes, task('task-members'));
  for (const memberId of ['operator', 'scout', 'scribe']) {
    assert.deepEqual(await f.scopes.scopeState(scope.id, memberId), { scopeId: scope.id, writable: true });
  }

  f.setFacts({
    projectId: 'project-alpha', status: 'active', contentVersion: 2,
    goal: 'Project goal', rules: ['Project rule'],
    members: [
      { memberId: 'operator', memberKind: 'human' },
      { memberId: 'scout', memberKind: 'agent' },
      { memberId: 'scribe', memberKind: 'agent' },
      { memberId: 'late-joiner', memberKind: 'agent' },
    ],
  });
  assert.deepEqual(await f.scopes.scopeState(scope.id, 'late-joiner'), { scopeId: scope.id, writable: true });
  assert.equal((await f.store.get(scope.id))?.kind, 'task-group');

  f.setFacts({
    projectId: 'project-alpha', status: 'active', contentVersion: 3,
    goal: 'Project goal', rules: ['Project rule'],
    members: [
      { memberId: 'operator', memberKind: 'human' },
      { memberId: 'scout', memberKind: 'agent' },
      { memberId: 'scribe', memberKind: 'agent', endedAt: 103 },
      { memberId: 'late-joiner', memberKind: 'agent' },
    ],
  });
  assert.deepEqual(await f.scopes.scopeState(scope.id, 'scribe'), {
    scopeId: scope.id, writable: false, reason: 'membership-ended',
  });
  assert.deepEqual(await f.scopes.scopeState(scope.id, 'late-joiner'), {
    scopeId: scope.id, writable: true,
  });
});

test('terminal task freezes the task-group while preserving its readable scope record', async () => {
  const f = fixture();
  const scope = await sync(f.scopes, task('task-freeze'));
  const frozen = await sync(f.scopes, task('task-freeze', { status: 'cancelled' }));
  assert.equal(frozen.terminalTaskStatus, 'cancelled');
  assert.equal(frozen.frozenAt, 100);
  assert.deepEqual(await f.scopes.scopeState(scope.id, 'operator'), {
    scopeId: scope.id, writable: false, reason: 'task-group-frozen',
  });
  assert.equal((await f.scopes.listScopes('project-alpha')).some((entry) => entry.id === scope.id), true);
  await assert.rejects(sync(f.scopes, task('task-freeze', {
    title: 'Must not revise frozen scope', contentVersion: 2,
  })), /frozen/i);
});

test('Force Release stops a terminal Task group while preserving its readable scope record', async () => {
  const f = fixture();
  const scope = await sync(f.scopes, task('task-stop-group'));
  const stopped = await sync(f.scopes, task('task-stop-group', { status: 'stopped' }));
  assert.equal(stopped.terminalTaskStatus, 'stopped');
  assert.equal(stopped.frozenAt, 100);
  assert.deepEqual(await f.scopes.scopeState(scope.id, 'operator'), {
    scopeId: scope.id, writable: false, reason: 'task-group-frozen',
  });
  await assert.rejects(sync(f.scopes, task('task-stop-group', {
    title: 'Must not revise frozen scope', contentVersion: 2,
  })), /frozen/i);
});

test('two task-groups have distinct immutable scope identities', async () => {
  const f = fixture();
  const first = await sync(f.scopes, task('task-parallel-a'));
  const second = await sync(f.scopes, task('task-parallel-b'));
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.taskId, second.taskId);
  assert.deepEqual(
    (await f.scopes.listScopes('project-alpha')).filter((entry) => entry.kind === 'task-group').map((entry) => entry.id),
    [first.id, second.id],
  );
});
