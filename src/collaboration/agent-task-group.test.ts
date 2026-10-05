import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationScopeService } from '../conversation/service.ts';
import { taskGroupScopeId } from '../conversation/model.ts';
import { InMemoryConversationScopeStore } from '../conversation/store.ts';
import { CollaborationCoordinator } from './coordinator.ts';
import { InMemoryCollaborationStore } from './store.ts';

const taskId = 'task-alpha';
const projectId = 'project-alpha';
const runId = 'run-scout';
const leaseId = 'lease-task-alpha';

function makeTask(status: 'in-progress' | 'done' = 'in-progress') {
  return {
    id: taskId,
    projectId,
    title: 'Implement the report',
    goal: 'Ship the report',
    constraints: [],
    status,
    assignedAgentId: 'scout',
    environmentInstanceId: 'environment-alpha',
    environmentLeaseId: leaseId,
    environmentLifecycleState: status === 'in-progress' ? 'running' as const : 'ended' as const,
    activeRunId: runId,
    admission: {
      proposalId: 'proposal-alpha',
      proposalRevision: 1,
      contentVersion: 1,
      validationCriteria: [],
      lead: { memberId: 'scout', memberKind: 'agent' as const },
      contextAgentId: 'scout',
      approvedBy: { memberId: 'operator', memberKind: 'human' as const },
      approvedAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

async function buildHarness(options: {
  stopAtPersistCheck?: boolean;
  staleRunAtPersistCheck?: boolean;
  staleTaskAtPersistCheck?: boolean;
  revokeLeaseAtPersistCheck?: boolean;
} = {}) {
  let task = makeTask();
  let runStatus: 'running' | 'stopped' = 'running';
  let stopRequested = false;
  let leaseActive = true;
  let taskReads = 0;
  const scopeStore = new InMemoryConversationScopeStore();
  const scopes = new ConversationScopeService({
    store: scopeStore,
    projects: {
      async projectFacts(id) {
        if (id !== projectId) return undefined;
        return {
          projectId,
          status: 'active' as const,
          contentVersion: 1,
          goal: 'Ship Sprout',
          rules: [],
          members: [
            { memberId: 'operator', memberKind: 'human' as const },
            { memberId: 'scout', memberKind: 'agent' as const },
            { memberId: 'forge', memberKind: 'agent' as const },
          ],
        };
      },
    },
    tasks: {
      async taskFacts(id) {
        return id === taskId ? { projectId, status: task.status } : undefined;
      },
    },
    clock: () => 10,
  });
  const group = await scopes.syncTaskGroup({
    taskId,
    projectId,
    title: 'Implement the report',
    goal: 'Ship the report',
    constraints: [],
    lead: { memberId: 'scout', kind: 'agent' },
    contentVersion: 1,
    status: task.status,
  });
  const collaborationStore = new InMemoryCollaborationStore();
  const admitted: string[] = [];
  const runs = {
    async load(id: string) {
      if (id !== runId) return undefined;
      if (options.staleRunAtPersistCheck) runStatus = 'stopped';
      return {
        id: runId,
        agentId: 'scout',
        projectId,
        taskId,
        prompt: 'do the task',
        leaseId,
        environmentInstanceId: 'environment-alpha',
        status: runStatus,
        events: [],
        createdAt: 1,
      };
    },
    async submit(input: { readonly agentId: string }) {
      admitted.push(input.agentId);
      return { id: `wake-run-${admitted.length}` };
    },
    async waitFor(id: string) {
      return { id, agentId: 'forge', prompt: 'review', projectId, environmentInstanceId: 'environment-alpha', status: 'completed' as const, events: [], createdAt: 2 };
    },
  };
  const collaboration = new CollaborationCoordinator({
    scopes,
    store: collaborationStore,
    runs,
    clock: { now: () => 10 },
  });
  const taskStore = {
    async get(id: string) {
      if (id !== taskId) return undefined;
      taskReads += 1;
      if (taskReads === 1) {
        if (options.stopAtPersistCheck) stopRequested = true;
        if (options.staleRunAtPersistCheck) runStatus = 'stopped';
        if (options.staleTaskAtPersistCheck) task = { ...task, activeRunId: 'another-run' };
        if (options.revokeLeaseAtPersistCheck) leaseActive = false;
      }
      return task;
    },
  };
  const pool = {
    getLease(id: string) {
      if (id !== leaseId) return undefined;
      return {
        id: leaseId,
        instanceId: 'environment-alpha',
        capability: 'agent-run',
        holderId: taskId,
        holderKind: 'task' as const,
        taskId,
        acquiredAt: 1,
        expiresAt: 100,
        state: leaseActive ? 'active' as const : 'released' as const,
      };
    },
  };
  const currentRun = {
    id: runId,
    agentId: 'scout',
    projectId,
    taskId,
    leaseId,
    environmentInstanceId: 'environment-alpha',
    status: 'running',
    events: [],
    createdAt: 1,
  };
  const assertActive = () => {
    if (stopRequested) throw new Error('Agent message capability is no longer active');
  };
  const { createAgentTaskGroupMessageSender } = await import('./agent-task-group.ts');
  const send = createAgentTaskGroupMessageSender({
    run: currentRun,
    runs,
    tasks: taskStore,
    pool,
    scopes,
    collaboration,
    assertActive,
  });
  const { createAgentTaskGroupMessageBridge } = await import('../worker/agent-task-group-bridge.ts');
  const bridge = await createAgentTaskGroupMessageBridge(send);
  return {
    taskGroupId: group.id,
    sendDirect: send,
    setTask(value: ReturnType<typeof makeTask>) { task = value; },
    async freezeTaskGroup() {
      task = makeTask('done');
      await scopes.syncTaskGroup({
        taskId,
        projectId,
        title: task.title,
        goal: task.goal,
        constraints: task.constraints,
        lead: { memberId: 'scout', kind: 'agent' },
        contentVersion: 1,
        status: 'done',
      });
    },
    async post(input: unknown) {
      let response: Response;
      try {
        response = await fetch(bridge.environment.SPROUT_TASK_GROUP_POST_URL!, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bridge.environment.SPROUT_TASK_GROUP_POST_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(input),
        });
      } catch (error) {
        const code = (error as Error & { readonly cause?: { readonly code?: string } }).cause?.code;
        throw new Error(`Task-group bridge fetch failed${code !== undefined ? ` (${code})` : ''}`);
      }
      return { response, body: await response.json() as Record<string, any> };
    },
    messages: () => collaboration.listMessages(),
    collaborationStore,
    wakes: () => collaboration.listWakeRequests(),
    admitted,
    close: () => bridge.close(),
  };
}

test('task-group channel stamps identity, kind, Task/run binding, and mention recipients over spoofed fields', async t => {
  const h = await buildHarness();
  t.after(h.close);
  const body = '## Done\n- report draft is ready\n\n@forge please review the final section.\n\nUnresolved: chart source.';
  const { response, body: result } = await h.post({
    body,
    deliveryKey: 'handoff-once',
    kind: 'question',
    authorId: 'forge',
    authorKind: 'human',
    projectId: 'forged-project',
    scopeId: 'forged-group',
    sender: { id: 'forge', kind: 'human' },
    taskId: 'forged-task',
    runId: 'forged-run',
    workItemId: 'forged-work-item',
    groupId: 'forged-group',
    to: ['scout'],
    envelope: {
      kind: 'assignment',
      sender: { id: 'forge', kind: 'human' },
      taskId: 'forged-task',
      runId: 'forged-run',
      workItemId: 'forged-work-item',
      groupId: 'forged-group',
      to: ['scout'],
    },
  });
  assert.equal(response.status, 200);
  assert.equal(result.authorId, 'scout');
  assert.equal(result.scopeId, taskGroupScopeId(taskId));
  assert.deepEqual(result.envelope, {
    kind: 'question',
    sender: { id: 'scout', kind: 'agent' },
    taskId,
    runId,
    workItemId: taskId,
    groupId: h.taskGroupId,
    to: ['forge'],
  });
  assert.deepEqual(result.wakes.map((wake: { readonly agentId: string; readonly reason: string }) => [wake.agentId, wake.reason]), [['forge', 'agent-mention']]);
  assert.equal((await h.messages())[0]?.body, body);
});

test('task-group accepts free-form body unchanged and defaults its stamped kind to status', async t => {
  const h = await buildHarness();
  t.after(h.close);
  const body = '{unstructured report}\n\n完成 / 交付 / 请下游 / 未决\n\nA prose question? 🙂\n';
  const { response, body: result } = await h.post({ body, deliveryKey: 'free-body' });
  assert.equal(response.status, 200);
  assert.equal((await h.messages())[0]?.body, body);
  assert.equal(result.envelope.kind, 'status');
  assert.deepEqual(result.envelope.to, []);
});

test('task-group accepts an empty free-form body unchanged', async t => {
  const h = await buildHarness();
  t.after(h.close);
  const { response, body: result } = await h.post({ body: '', deliveryKey: 'empty-body' });
  assert.equal(response.status, 200);
  assert.equal((await h.messages())[0]?.body, '');
  assert.equal(result.envelope.kind, 'status');
});


test('task-group deliveryKey retry returns one stored message and one wake', async t => {
  const h = await buildHarness();
  t.after(h.close);
  const input = { body: '@forge take a look', deliveryKey: 'retry-key' };
  const first = await h.post(input);
  const second = await h.post(input);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.messageId, first.body.messageId);
  assert.equal((await h.messages()).length, 1);
  assert.deepEqual(h.admitted, ['forge']);
});

test('the session post bridge relays an explicit same-group reply link', async t => {
  const h = await buildHarness();
  t.after(h.close);
  const first = await h.post({ body: 'I found the issue.', deliveryKey: 'reply-parent' });
  const second = await h.post({
    body: 'The fix is ready.',
    deliveryKey: 'reply-child',
    inReplyTo: first.body.messageId,
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.body.inReplyTo, first.body.messageId);
  assert.equal((await h.messages()).find(message => message.id === second.body.messageId)?.inReplyTo, first.body.messageId);
});

test('task-group reply link refuses a Message from another scope', async t => {
  const h = await buildHarness();
  t.after(h.close);
  await h.collaborationStore.postMessage({
    message: {
      id: 'foreign-message', projectId, scopeId: 'direct:operator:scout', channel: 'direct',
      author: { id: 'operator', kind: 'human' }, body: 'Private direct message', recipients: ['scout'],
      deliveryKey: 'foreign-message-key', createdAt: 1,
    },
    plan: { inputId: 'foreign-message', decisions: [], observations: [] },
    now: 1,
  });
  const { response, body } = await h.post({
    body: 'This must stay in the Task group.', deliveryKey: 'cross-scope-reply', inReplyTo: 'foreign-message',
  });
  assert.equal(response.status, 409);
  assert.equal(body.code, 'invalid-reply-target');
  assert.deepEqual((await h.messages()).filter(message => message.scopeId === h.taskGroupId), []);
});
test('concurrent task-group deliveryKey retries store one message and admit one wake', async t => {
  const h = await buildHarness();
  t.after(h.close);
  const input = { body: '@forge review this once', deliveryKey: 'concurrent-retry' };
  const [first, second] = await Promise.all([h.post(input), h.post(input)]);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal([first.body.duplicate, second.body.duplicate].filter(Boolean).length, 1);
  assert.equal(first.body.messageId, second.body.messageId);
  assert.equal((await h.messages()).length, 1);
  assert.equal((await h.wakes()).length, 1, 'one durable wake belongs to the one stored Message');
  assert.deepEqual(h.admitted, ['forge']);
});


test('a Stop requested during the persistence-time authority check leaves no group post', async () => {
  const h = await buildHarness({ stopAtPersistCheck: true });
  try {
    await assert.rejects(
      h.sendDirect({ body: 'This send races with Stop.', deliveryKey: 'stop-mid-send' }),
      (error: unknown) => error instanceof Error && error.message.includes('no longer active'),
    );
    assert.deepEqual(await h.messages(), []);
    assert.deepEqual(h.admitted, []);
  } finally {
    await h.close();
  }
});

test('persistence refuses a run that became stale during the authority check', async () => {
  const h = await buildHarness({ staleRunAtPersistCheck: true });
  try {
    await assert.rejects(
      h.sendDirect({ body: 'This run is no longer current.', deliveryKey: 'stale-run' }),
      (error: unknown) => error instanceof Error && error.message.includes('Task run is no longer current'),
    );
    assert.deepEqual(await h.messages(), []);
  } finally {
    await h.close();
  }
});

test('persistence refuses a Task whose active run changed during the authority check', async () => {
  const h = await buildHarness({ staleTaskAtPersistCheck: true });
  try {
    await assert.rejects(
      h.sendDirect({ body: 'This Task is now assigned to another run.', deliveryKey: 'stale-task' }),
      (error: unknown) => error instanceof Error && error.message.includes('Task run is no longer current'),
    );
    assert.deepEqual(await h.messages(), []);
  } finally {
    await h.close();
  }
});

test('persistence refuses a Task lease revoked during the authority check', async () => {
  const h = await buildHarness({ revokeLeaseAtPersistCheck: true });
  try {
    await assert.rejects(
      h.sendDirect({ body: 'The Task lease is no longer active.', deliveryKey: 'revoked-lease' }),
      (error: unknown) => error instanceof Error && error.message.includes('Task environment lease is no longer active'),
    );
    assert.deepEqual(await h.messages(), []);
  } finally {
    await h.close();
  }
});

test('a frozen Task group returns truthful 409 and keeps its history unchanged', async t => {
  const h = await buildHarness();
  t.after(h.close);
  await h.sendDirect({ body: 'Existing group history.', deliveryKey: 'before-freeze' });
  const before = await h.messages();
  await h.freezeTaskGroup();
  const { response, body } = await h.post({ body: 'This should remain refused.', deliveryKey: 'frozen-group' });
  assert.equal(response.status, 409);
  assert.equal(body.code, 'scope-read-only');
  assert.equal(body.reason, 'task-group-frozen');
  assert.deepEqual(await h.messages(), before);
});
