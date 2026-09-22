/**
 * Projection tests at the Web wire-contract seam (ticket #78, seam C1 from #71).
 *
 * These call the projection functions directly rather than through HTTP, so a
 * failure localises to the projection instead of the transport. The HTTP tests
 * in `api.test.ts` and `api-tasks.test.ts` remain the behavioural guard: together
 * they prove the extracted Module produces byte-identical payloads.
 *
 * Nothing here asserts private structure. Every assertion is about the
 * caller-facing wire shape a browser adapter consumes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRun } from '../run/model.ts';
import type { Message } from '../collaboration/model.ts';
import type { Project } from '../project/model.ts';
import type { Task, TaskRunLink } from '../task/model.ts';
import {
  summarizeRunHistory,
  toEnvironmentReadinessView,
  toMessageView,
  toProjectView,
  toProbeResultView,
  toRunView,
  toTaskContextState,
  toTaskRunLinkView,
  toTaskView,
  toTaskWithRunsView,
  toWakeView,
  type RunView,
} from './views.ts';
import type { EnvironmentReadiness } from '../environment/readiness.ts';

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    agentId: 'agent-scout',
    prompt: 'say hi',
    environmentInstanceId: 'mac-mini-1',
    status: 'completed',
    events: [{ type: 'message', text: 'done', final: true }],
    createdAt: 1_000,
    ...overrides,
  };
}

test('a run view exposes progress and the terminal result without server internals', () => {
  const view = toRunView(
    run({
      taskId: 'task-1',
      leaseId: 'lease-secret',
      handOff: {
        previousEnvironmentInstanceId: 'windows-1',
        text: 'HANDOFF_TEXT_MUST_NOT_LEAK',
        sourceRunIds: ['run-0'],
      },
      result: { status: 'completed', text: 'done' },
      tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      completedAt: 2_500,
    }),
  );

  assert.equal(view.id, 'run-1');
  assert.equal(view.status, 'completed');
  assert.equal(view.taskId, 'task-1');
  assert.equal(view.handOffAttached, true, 'a hand-off becomes a boolean fact');
  assert.deepEqual(view.tokenUsage, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  assert.equal(view.createdAt, 1_000);
  assert.equal(view.completedAt, 2_500);

  assert.equal('leaseId' in view, false, 'lease identity is not part of the wire contract');
  assert.equal('environmentInstanceId' in view, false, 'environment identity stays server-side');
  assert.equal('handOff' in view, false, 'only the hand-off boolean is exposed');
  assert.equal(
    JSON.stringify(view).includes('HANDOFF_TEXT_MUST_NOT_LEAK'),
    false,
    'the hand-off text never reaches the payload',
  );
});

test('optional run fields are absent rather than null when the run has none', () => {
  const view = toRunView(run());
  for (const field of ['taskId', 'failure', 'result', 'tokenUsage', 'completedAt']) {
    assert.equal(field in view, false, `${field} stays absent`);
  }
  assert.equal(view.handOffAttached, false);
});

test('run history totals accumulate duration and usage without hiding unavailable metrics', () => {
  const views: RunView[] = [
    toRunView(run({ id: 'a', createdAt: 1_000, completedAt: 2_500, tokenUsage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 } })),
    toRunView(run({ id: 'b', createdAt: 4_000, completedAt: 6_500 })),
    toRunView(run({ id: 'c', status: 'running', createdAt: 9_000 })),
  ];

  assert.deepEqual(summarizeRunHistory(views), {
    durationMs: 4_000,
    tokenUsage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    completedRunCount: 2,
    runsWithTokenUsage: 1,
  });
});

test('a message view carries the conversation unit and never raw run output', () => {
  const message: Message = {
    id: 'message-1',
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'agent-scout', kind: 'agent' },
    body: 'Scout: replied.',
    recipients: ['operator'],
    deliveryKey: 'key-1',
    inReplyTo: 'message-0',
    createdAt: 10,
  };

  const view = toMessageView(message);
  assert.deepEqual(view, {
    id: 'message-1',
    projectId: 'project-sprout',
    channel: 'direct',
    authorId: 'agent-scout',
    authorKind: 'agent',
    body: 'Scout: replied.',
    recipients: ['operator'],
    inReplyTo: 'message-0',
    createdAt: 10,
  });
  assert.equal('deliveryKey' in view, false, 'the idempotency key stays server-side');
});

test('a wake view exposes the reason, status, and linked run only', () => {
  assert.deepEqual(
    toWakeView({
      id: 'wake-1',
      messageId: 'message-1',
      projectId: 'project-sprout',
      agentId: 'agent-scout',
      reason: 'direct-recipient',
      status: 'admitted',
      idempotencyKey: 'message-1:agent-scout',
      runId: 'run-1',
      detail: 'internal note',
      createdAt: 10,
    }),
    { agentId: 'agent-scout', reason: 'direct-recipient', status: 'admitted', runId: 'run-1' },
  );

  const withoutRun = toWakeView({
    id: 'wake-2',
    messageId: 'message-1',
    projectId: 'project-sprout',
    agentId: 'agent-ranger',
    reason: 'broadcast',
    status: 'suppressed',
    idempotencyKey: 'message-1:agent-ranger',
    detail: 'nothing to do',
    createdAt: 10,
  });
  assert.deepEqual(withoutRun, { agentId: 'agent-ranger', reason: 'broadcast', status: 'suppressed' });
  assert.equal('runId' in withoutRun, false);
  assert.equal('detail' in withoutRun, false);
});

test('a project view exposes only the members a composer may address', () => {
  const project: Project = {
    id: 'project-sprout',
    goal: 'Ship Sprout',
    rules: ['Be kind'],
    availableEnvironmentInstanceIds: ['mac-mini-1'],
    memberships: [
      { agentId: 'agent-scout', responsibilities: ['Investigate'], collaborationInstructions: 'Speak up' },
      { agentId: 'agent-ranger', responsibilities: ['Review'], collaborationInstructions: '' },
    ],
  };

  assert.deepEqual(toProjectView(project), {
    id: 'project-sprout',
    goal: 'Ship Sprout',
    memberIds: ['agent-scout', 'agent-ranger'],
  });
});

test('the task context state maps each Worker lifecycle state to an operator answer', () => {
  const base: Task = {
    id: 'task-1',
    projectId: 'project-sprout',
    title: 'Durable Task',
    goal: 'Persist multi-run work.',
    constraints: [],
    status: 'in-progress',
    createdAt: 1,
    updatedAt: 1,
  };

  assert.equal(toTaskContextState(base), 'not-created');
  assert.equal(toTaskContextState({ ...base, environmentLifecycleState: 'beginning' }), 'preparing');
  for (const state of ['idle', 'running', 'blocked', 'awaiting-validation'] as const) {
    assert.equal(toTaskContextState({ ...base, environmentLifecycleState: state }), 'ready', state);
  }
  assert.equal(toTaskContextState({ ...base, environmentLifecycleState: 'ending' }), 'cleanup-in-progress');
  assert.equal(
    toTaskContextState({ ...base, environmentLifecycleState: 'recovery', recoveryState: 'ending' }),
    'cleanup-needs-recovery',
  );
  assert.equal(toTaskContextState({ ...base, environmentLifecycleState: 'recovery' }), 'recovery-retained');
  assert.equal(
    toTaskContextState({ ...base, environmentLifecycleState: 'recovery', recoveryState: 'idle' }),
    'recovery-retained',
  );
  for (const state of ['ended', 'discarded'] as const) {
    assert.equal(toTaskContextState({ ...base, environmentLifecycleState: state }), 'recycled', state);
  }
});

test('a task view projects the whole record and its derived context state', () => {
  const task: Task = {
    id: 'task-1',
    projectId: 'project-sprout',
    title: 'Durable Task',
    goal: 'Persist multi-run work.',
    constraints: ['No personal data'],
    status: 'blocked',
    assignedAgentId: 'agent-scout',
    environmentPreference: { kind: 'definition', id: 'macos-workstation' },
    blockerReason: 'waiting on a review',
    environmentInstanceId: 'mac-mini-1',
    environmentLeaseId: 'lease-1',
    environmentLifecycleState: 'blocked',
    activeRunId: 'run-1',
    createdAt: 1,
    updatedAt: 2,
  };

  const view = toTaskView(task);
  assert.equal(view.taskContextState, 'ready');
  assert.equal(view.blockerReason, 'waiting on a review');
  assert.deepEqual(view.environmentPreference, { kind: 'definition', id: 'macos-workstation' });
  assert.equal(view.environmentLeaseId, 'lease-1');
  assert.equal('recoveryState' in view, false);
  assert.equal('completedAt' in view, false);
});

test('a task-with-runs view keeps run links ordered and hides an unsettled summary', () => {
  const task: Task = {
    id: 'task-1',
    projectId: 'project-sprout',
    title: 'Durable Task',
    goal: 'Persist multi-run work.',
    constraints: [],
    status: 'in-progress',
    createdAt: 1,
    updatedAt: 1,
  };
  const link = (sequence: number, settled: boolean): TaskRunLink => ({
    taskId: 'task-1',
    runId: `run-${sequence}`,
    agentId: 'agent-scout',
    sequence,
    linkedAt: sequence,
    ...(settled
      ? { summary: { runId: `run-${sequence}`, agentId: 'agent-scout', status: 'completed', summary: `step ${sequence}`, recordedAt: 10 } }
      : {}),
  });

  const view = toTaskWithRunsView({ task, runs: [link(1, true), link(2, false)] });
  assert.deepEqual(view.runs.map((entry) => entry.runId), ['run-1', 'run-2']);
  assert.deepEqual(view.runs[0]?.summary, { status: 'completed', summary: 'step 1', recordedAt: 10 });
  assert.equal(view.runs[1]?.summary, undefined, 'a run in flight has no summary');

  assert.deepEqual(
    toTaskRunLinkView(link(2, false)),
    { runId: 'run-2', agentId: 'agent-scout', sequence: 2, linkedAt: 2 },
  );
});

test('the readiness wire view sanitizes the summary reason as free text', () => {
  // M77-PRIV-001 rework 4: the projection copied `summary.reason` verbatim, so a
  // legacy/raw readiness document could return a path, hostname, or named
  // credential through the field that claims to be the decisive reason. The
  // reason is free text — the compatibility detail can feed it — so it passes the
  // same boundary as every other free-text field while a decisive phrase stays.
  const base: EnvironmentReadiness = {
    enrollmentStatus: 'approved',
    connection: { state: 'online' },
    compatibility: { state: 'compatible' },
    capabilities: [],
    engines: [],
    workSafety: { state: 'clear' },
  };
  const reason = (value: string): string =>
    toEnvironmentReadinessView({
      environmentInstanceId: 'env-1',
      readiness: base,
      summary: { level: 'red', reason: value },
    }).summary.reason;

  const leaked = reason('blocked at /srv/leak on buildbox-7 using password=hunter2');
  assert.equal(/\/srv\/leak/.test(leaked), false, 'the legacy path is removed');
  assert.equal(/buildbox-7/.test(leaked), false, 'the legacy hostname is removed');
  assert.equal(/hunter2/.test(leaked), false, 'the legacy credential is removed');
  assert.match(leaked, /blocked/, 'the decisive word survives');

  // An ordinary product reason is untouched, and a wholly-sensitive one falls
  // back to the product-owned summary text rather than an empty string.
  assert.equal(reason('The Worker is offline.'), 'The Worker is offline.');
  assert.equal(reason('Lease recovery is required.'), 'Lease recovery is required.');
  assert.equal(reason('/srv/sprout/worker').length > 0, true);
  assert.equal(/\/srv\/sprout/.test(reason('/srv/sprout/worker')), false);
});

test('the readiness wire view retains only safe Worker provenance and independent engine facts', () => {
  const view = toEnvironmentReadinessView({
    environmentInstanceId: 'env-1',
    summary: { level: 'yellow', reason: 'Model entitlement is unavailable.' },
    readiness: {
      enrollmentStatus: 'approved',
      connection: { state: 'online', lastConfirmedAt: 1_000 },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      capabilities: [{ name: 'agent-run', permission: 'allowed', required: true }],
      engines: [{
        engine: 'pi', version: '0.86.1', installed: true, readiness: 'ready', required: true,
        models: { state: 'unknown', models: [] }, authenticated: true, authType: 'oauth',
        modelIdPresent: false, probedAt: 1_234, probeExitCode: 0, source: 'pi-auth-check',
      }],
      workSafety: { state: 'clear' },
    },
  });
  assert.deepEqual(view.engines[0], {
    engine: 'pi', version: '0.86.1', installed: true, readiness: 'ready', required: true,
    models: { state: 'unknown', models: [] }, authenticated: true, authType: 'oauth',
    modelIdPresent: false, probedAt: 1_234, probeExitCode: 0, source: 'pi-auth-check',
  });
  assert.equal(JSON.stringify(view).includes('provider'), false);
  assert.equal(JSON.stringify(view).includes('account'), false);
});

test('a legal multi-engine aggregate probe version is preserved identically in readiness and probe history (R118-PROVENANCE-005)', () => {
  const probe = {
    at: 1_234, latencyMs: 12, protocolOk: true, enginesOk: true, source: 'worker' as const,
    version: '0.154.0, 0.86.1', summary: 'Worker non-readiness probe completed.',
  };
  const readinessView = toEnvironmentReadinessView({
    environmentInstanceId: 'env-1',
    summary: { level: 'yellow', reason: 'Model entitlement is unavailable.' },
    readiness: {
      enrollmentStatus: 'approved',
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      capabilities: [],
      engines: [],
      probe,
      workSafety: { state: 'clear' },
    },
  });
  const historyView = toProbeResultView(probe);
  assert.equal(readinessView.probe?.version, '0.154.0, 0.86.1');
  assert.equal(historyView?.version, '0.154.0, 0.86.1');
  assert.equal(readinessView.probe?.version, historyView?.version);
  // An illegal version is still degraded in both projections.
  assert.equal(toProbeResultView({ ...probe, version: 'not a version' })?.version, 'unknown-version');
});

test('the readiness wire view drops a Worker-supplied provider/account identity (#114 C6, R118-BOUNDARY-003)', () => {
  const view = toEnvironmentReadinessView({
    environmentInstanceId: 'env-1',
    summary: { level: 'yellow', reason: 'Model entitlement is unavailable.' },
    readiness: {
      enrollmentStatus: 'approved',
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      capabilities: [],
      engines: [{
        engine: 'pi', installed: true, readiness: 'ready', required: true,
        models: { state: 'unknown', models: [] }, authenticated: true,
        // A legacy/raw document that bypassed the ingress sanitizer still must
        // not leak through the wire projection.
        authMode: 'provider-account', authType: 'openai-codex', source: 'openai-codex',
      }],
      workSafety: { state: 'clear' },
    },
  });
  assert.equal(view.engines[0]?.authMode, undefined);
  assert.equal(view.engines[0]?.authType, undefined);
  assert.equal(view.engines[0]?.source, undefined);
  assert.doesNotMatch(JSON.stringify(view), /openai-codex|provider-account/);
});

test('a run view exposes the workspace binding it was admitted under, sanitized', () => {
  const view = toRunView(
    run({
      projectId: 'project-sprout',
      workspaceBinding: {
        bindingId: 'binding-nine',
        workspaceId: 'a'.repeat(40),
        kind: 'relative',
        path: 'repos/sprout',
      },
    }),
  );
  assert.deepEqual(view.workspaceBinding, {
    bindingId: 'binding-nine',
    workspaceId: 'a'.repeat(40),
    kind: 'relative',
    path: 'repos/sprout',
  });

  // A corrupt durable binding cannot carry an absolute host path onto the wire:
  // the unsafe location is dropped, never repaired or exposed.
  const corrupt = toRunView(
    run({
      projectId: 'project-sprout',
      workspaceBinding: {
        bindingId: 'binding-nine',
        workspaceId: 'a'.repeat(40),
        kind: 'relative',
        path: '/Users/<user>/private',
      },
    }),
  );
  assert.equal(corrupt.workspaceBinding?.path, undefined, 'the absolute location is dropped');
  assert.ok(!JSON.stringify(corrupt).includes('/Users/'));
});

test('a run with no workspace binding reports none rather than inventing one', () => {
  const view = toRunView(run({ projectId: 'project-sprout' }));
  assert.equal('workspaceBinding' in view, false);
});
