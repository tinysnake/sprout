/**
 * Feed/Attention projection evidence (#103).
 *
 * These tests pin the four acceptance shapes of the read-only Feed: derivation
 * from every authoritative source, scope/urgency filtering (including
 * infrastructure transcolation), referential integrity of deep-link identities,
 * and the privacy invariant that no engine prose, prompt, raw result, frozen
 * routing context, or conversation content ever crosses the projection. The
 * clearing test proves the projection holds no state of its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEED_ACTIVITY_LIMIT,
  FEED_TEXT_LIMIT,
  createFeedProjection,
  feedTarget,
  filterFeed,
  isFeedDeepLink,
  projectFeed,
  taskLifecycleSentence,
  type FeedProjectRef,
  type FeedSources,
} from './feed.ts';
import { DEFAULT_ROUTING_BOUNDS, type RoutingBatch, type RoutingContextManifest } from '../collaboration/routing.ts';
import type { ProjectEvent } from '../collaboration/events.ts';
import { sanitizeProjectId } from '../project/authority-model.ts';
import type { EnvironmentEnrollment } from '../environment/enrollment.ts';
import type { EnvironmentRecoveryRecord } from '../environment/recovery.ts';
import type { AgentRun } from '../run/model.ts';
import type { Task, TaskControlEvent } from '../task/model.ts';
import type { TaskProposal } from '../task/proposal-model.ts';

const NOW = 1_000;

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'projectId'>): Task {
  return { title: 'Feed work', goal: 'Deliver the feed', constraints: [], status: 'todo', createdAt: 1, updatedAt: NOW, ...overrides };
}

function makeProposal(overrides: Partial<TaskProposal> & Pick<TaskProposal, 'id' | 'projectId'>): TaskProposal {
  const actor = { memberId: 'human-1', memberKind: 'human' } as const;
  return {
    proposer: actor,
    origin: null,
    status: 'proposed',
    revision: 1,
    currentContentVersion: 1,
    versions: [{ version: 1, actor, at: 1, reason: 'initial', title: 'Add a feed projection', goal: 'Project the Feed', constraints: [], validationCriteria: [] }],
    lifecycle: [],
    createdAt: 1,
    updatedAt: 90,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ProjectEvent> & Pick<ProjectEvent, 'id' | 'projectId' | 'disposition'>): ProjectEvent {
  return {
    kind: 'operational',
    summary: 'A durable operational fact',
    producer: { id: 'sprout', kind: 'system' },
    responsibleAgentIds: [],
    deliveryKey: `key-${overrides.id}`,
    createdAt: 600,
    ...overrides,
  };
}

function makeEnrollment(overrides: Partial<EnvironmentEnrollment> & Pick<EnvironmentEnrollment, 'id' | 'environmentInstanceId'>): EnvironmentEnrollment {
  return {
    displayName: 'Windows Box',
    status: 'pending',
    everApproved: false,
    worker: { identityDigest: 'digest-1', platform: 'windows', capabilityRequests: [], engineFacts: [] },
    invalidatedIdentityDigests: [],
    requiresFreshIdentity: false,
    claim: undefined,
    capabilityPermissions: {},
    createdAt: 1,
    updatedAt: 150,
    revision: 1,
    decisions: [],
    ...overrides,
  };
}

function makeRecovery(overrides: Partial<EnvironmentRecoveryRecord> & Pick<EnvironmentRecoveryRecord, 'id' | 'environmentInstanceId' | 'leaseId'>): EnvironmentRecoveryRecord {
  return {
    holderKind: 'task',
    holderId: 'task-held',
    cause: 'worker-channel-lost',
    phase: 'recovery',
    startedAt: 350,
    updatedAt: 360,
    unresolvedFacts: ['task context recycle is unproven'],
    decisions: [],
    ...overrides,
  };
}

function makeRun(overrides: Partial<AgentRun> & Pick<AgentRun, 'id' | 'status'>): AgentRun {
  return {
    agentId: 'agent-scout',
    prompt: 'the original prompt text',
    environmentInstanceId: 'env-1',
    events: [],
    createdAt: 700,
    ...overrides,
  };
}

function makeBatch(overrides: Partial<RoutingBatch> & Pick<RoutingBatch, 'id' | 'projectId' | 'status'>): RoutingBatch {
  const manifest: RoutingContextManifest = {
    projectId: overrides.projectId,
    windowId: 'win-1',
    cutoffAt: 500,
    policy: 'explicit-only',
    bounds: DEFAULT_ROUTING_BOUNDS,
    inputs: [],
    candidates: [],
    tasks: [],
    recentContextIds: [],
    ancestorContextIds: [],
    exclusions: [],
    contextChars: 0,
  };
  return {
    windowId: 'win-1',
    splitIndex: 0,
    splitCount: 1,
    cutoffAt: 500,
    bounds: DEFAULT_ROUTING_BOUNDS,
    manifest,
    context: 'FROZEN ROUTING CONTEXT WITH MODEL INPUT',
    createdAt: 500,
    ...overrides,
  };
}

interface World {
  projects: FeedProjectRef[];
  tasks: Task[];
  proposals: TaskProposal[];
  events: ProjectEvent[];
  enrollments: EnvironmentEnrollment[];
  recoveries: EnvironmentRecoveryRecord[];
  runs: AgentRun[];
  batches: RoutingBatch[];
}

function sources(world: Partial<World>): FeedSources {
  return {
    projects: async () => world.projects ?? [],
    tasks: async () => world.tasks ?? [],
    proposals: async () => world.proposals ?? [],
    events: async () => world.events ?? [],
    enrollments: async () => world.enrollments ?? [],
    recoveries: async () => world.recoveries ?? [],
    runs: async () => world.runs ?? [],
    routingBatches: async () => world.batches ?? [],
    wakeFailures: async () => [],
    attentionResolutions: async () => [],
  };
}

/** One world exercising every attention source, in-flight work, and activity. */
function mixedWorld(): World {
  const claim = {
    id: 'claim-9',
    contentVersion: 1,
    actor: { memberId: 'agent-scout', memberKind: 'agent' as const },
    at: 95,
    outcomeSummary: 'CLAIM_PROSE_THAT_MUST_NOT_LEAK',
    validationEvidence: ['tests passed'],
    durableChanges: ['feed added'],
    limitations: [],
    recommendedDisposition: 'complete' as const,
  };
  return {
    projects: [
      { id: 'proj-mine', displayName: 'Minesweeper' },
      { id: 'proj-core', displayName: 'Sprout Core' },
    ],
    proposals: [
      makeProposal({ id: 'proposal-1', projectId: 'proj-mine' }),
      makeProposal({ id: 'proposal-closed', projectId: 'proj-mine', status: 'rejected' }),
    ],
    tasks: [
      makeTask({
        id: 'task-val',
        projectId: 'proj-mine',
        status: 'in-progress',
        environmentLifecycleState: 'awaiting-validation',
        environmentLeaseId: 'lease-1',
        pendingCompletionClaimId: 'claim-9',
        completionClaims: [claim],
        updatedAt: 100,
      }),
      makeTask({
        id: 'task-blk',
        projectId: 'proj-mine',
        status: 'blocked',
        environmentLifecycleState: 'blocked',
        environmentLeaseId: 'lease-2',
        blocker: {
          reason: 'Audio asset permission is missing.',
          requiredAction: 'Grant the asset permission on the host.',
          responsible: { kind: 'external-condition', condition: 'asset permission' },
          nextAdvancer: { memberId: 'human-1', memberKind: 'human' },
          createdBy: { memberId: 'agent-scout', memberKind: 'agent' },
          createdAt: 200,
        },
        updatedAt: 200,
      }),
      makeTask({
        id: 'task-held',
        projectId: 'proj-mine',
        status: 'in-progress',
        environmentLifecycleState: 'recovery',
        environmentLeaseId: 'lease-held',
        updatedAt: 300,
      }),
      makeTask({
        id: 'task-rec',
        projectId: 'proj-core',
        status: 'in-progress',
        environmentLifecycleState: 'recovery',
        environmentLeaseId: 'lease-rec',
        updatedAt: 400,
      }),
      makeTask({
        id: 'task-live',
        projectId: 'proj-core',
        status: 'in-progress',
        environmentLifecycleState: 'running',
        environmentLeaseId: 'lease-live',
        activeRunId: 'run-nested',
        updatedAt: 700,
      }),
    ],
    events: [
      makeEvent({ id: 'ev-har', projectId: 'proj-core', disposition: 'human-action-required', kind: 'release-approval', summary: 'Environment release needs Human approval', createdAt: 600 }),
      makeEvent({ id: 'ev-info', projectId: 'proj-core', disposition: 'informational', kind: 'agent-run-failure', summary: 'Agent run failed (execution) for agent-scout', createdAt: 610 }),
    ],
    enrollments: [makeEnrollment({ id: 'enr-1', environmentInstanceId: 'env-2' })],
    recoveries: [
      makeRecovery({ id: 'rec-1', environmentInstanceId: 'env-1', leaseId: 'lease-held', taskId: 'task-held' }),
    ],
    runs: [
      makeRun({ id: 'run-live', status: 'running', projectId: 'proj-mine', createdAt: 700, prompt: 'PROMPT_SECRET_9182', events: [{ type: 'tool-output', text: 'RAW_TOOL_OUTPUT_SECRET' }] }),
      makeRun({
        id: 'run-nested',
        status: 'running',
        projectId: 'proj-core',
        taskId: 'task-live',
        createdAt: 690,
        prompt: 'PROMPT_SECRET_NESTED',
        workOption: { id: 'primary', engine: 'codex', workModel: 'gpt-5.4', effort: 'high' },
      }),
      makeRun({ id: 'run-done', status: 'completed', projectId: 'proj-core', createdAt: 100, completedAt: 650, prompt: 'PROMPT_SECRET_DONE', result: { status: 'completed', text: 'RESULT_SECRET_DONE' }, events: [{ type: 'message', text: 'ENGINE_PROSE_SECRET', final: true }] }),
      makeRun({ id: 'run-failed-legacy', status: 'failed', createdAt: 90, completedAt: 95, prompt: 'PROMPT_SECRET_FAILED', failure: 'FAILURE_TEXT_SECRET', failureClass: 'execution' }),
    ],
    batches: [makeBatch({ id: 'batch-1', projectId: 'proj-mine', status: 'failed', error: 'the wake model returned no parseable judgement', settledAt: 505 })],
  };
}

test('literal all and infra Projects have distinct scopes and counters', async () => {
  for (const id of ['all', 'infra']) assert.equal(sanitizeProjectId(id), id);
  for (const token of ['feed:all', 'feed:infra']) assert.notEqual(sanitizeProjectId(token), token);
  const snapshot = await projectFeed(sources({
    projects: ['all', 'infra'].map(id => ({ id, displayName: id })),
    proposals: ['all', 'infra'].map(id => makeProposal({ id: `p-${id}`, projectId: id })),
    enrollments: [makeEnrollment({ id: 'enr', environmentInstanceId: 'env' })],
  }));
  assert.equal(new Set(snapshot.scopes.map(s => s.id)).size, 4);
  for (const id of ['all', 'infra']) {
    assert.deepEqual(filterFeed(snapshot, { scope: id }).attention.map(i => i.id), [`proposal:p-${id}`]);
    assert.equal(snapshot.scopes.find(s => s.id === id)?.attentionCount, 1);
  }
  assert.deepEqual(filterFeed(snapshot, { scope: 'feed:infra' }).attention.map(i => i.id), ['enrollment:enr']);
  assert.equal(filterFeed(snapshot, { scope: 'feed:all' }).attention.length, 3);
});

test('attention derives from proposals, validation claims, blockers, recovery, enrollment, routing failures, and human-action-required events', async () => {
  const snapshot = await projectFeed(sources(mixedWorld()));

  assert.deepEqual(
    snapshot.attention.map((item) => item.id),
    [
      'event:ev-har',
      'routing-failure:batch-1',
      'task-recovery:task-rec',
      'lease-recovery:rec-1',
      'blocker:task-blk',
      'enrollment:enr-1',
      'validation:task-val:claim-9',
      'proposal:proposal-1',
    ],
    'attention is severity-ranked then newest-first, with one item per unresolved source',
  );
  assert.deepEqual(
    [...new Set(snapshot.attention.map((item) => item.severity))],
    ['action_required', 'attention', 'info'],
  );
  const categories = new Set(snapshot.attention.map((item) => item.category));
  assert.deepEqual(
    [...categories].sort(),
    ['enrollment-pending', 'human-action-required', 'lease-recovery', 'proposal-pending', 'routing-failure', 'task-blocker', 'task-recovery', 'task-validation'],
  );
  assert.ok(
    !snapshot.attention.some((item) => item.source.id === 'proposal-closed'),
    'a closed proposal is a cleared source',
  );
  assert.ok(
    !snapshot.attention.some((item) => item.id.startsWith('task-recovery:task-held')),
    'one recovery condition yields one item: the record transcolates instead of duplicating the Task item',
  );
  assert.ok(
    !snapshot.attention.some((item) => item.source.kind === 'event' && item.source.id === 'ev-info'),
    'an informational Project event never becomes attention',
  );
  const blocker = snapshot.attention.find((item) => item.category === 'task-blocker');
  assert.equal(blocker?.lifecycle, 'Task blocked · No active Agent run · Lease held');
  assert.match(blocker?.reason ?? '', /Required action: Grant the asset permission/);
});

test('every attention item carries severity, category, reason, lifecycle, and a valid deep-link identity to its owning surface', async () => {
  const world = mixedWorld();
  const snapshot = await projectFeed(sources(world));
  assert.ok(snapshot.attention.length >= 8);
  for (const item of snapshot.attention) {
    assert.ok(item.severity === 'action_required' || item.severity === 'attention' || item.severity === 'info');
    assert.ok(item.category.length > 0);
    assert.ok(item.reason.trim().length > 0 && item.reason.length <= FEED_TEXT_LIMIT, `reason bounded: ${item.reason.length}`);
    assert.ok(item.lifecycle.trim().length > 0 && item.lifecycle.includes(' · '), `lifecycle sentence: ${item.lifecycle}`);
    assert.ok(isFeedDeepLink(item.target), `deep link valid: ${JSON.stringify(item.target)}`);
    assert.ok(item.scopes.length > 0, 'every item is scoped');
    // The deep link resolves to an entity that actually exists.
    switch (item.target.surface) {
      case 'project-task-detail':
        assert.ok(world.tasks.some((task) => task.id === item.target.taskId));
        assert.ok(world.tasks.some((task) => task.id === item.target.taskId && task.projectId === item.target.projectId));
        break;
      case 'project-tasks':
        assert.ok(world.proposals.some((proposal) => proposal.id === item.target.proposalId));
        break;
      case 'project-chat-routing':
        assert.ok(world.batches.some((batch) => batch.id === item.target.batchId));
        break;
      case 'environment-detail':
        assert.ok(world.enrollments.some((enrollment) => enrollment.id === item.target.environmentId));
        break;
      case 'project-overview':
        assert.ok(world.projects.some((project) => project.id === item.target.projectId));
        break;
      default:
        assert.equal(item.target.surface, 'environments');
    }
    // The source identity resolves to the same authoritative entity.
    const sourceExists =
      (item.source.kind === 'task' && world.tasks.some((task) => task.id === item.source.id))
      || (item.source.kind === 'proposal' && world.proposals.some((proposal) => proposal.id === item.source.id))
      || (item.source.kind === 'recovery' && world.recoveries.some((record) => record.id === item.source.id))
      || (item.source.kind === 'enrollment' && world.enrollments.some((enrollment) => enrollment.id === item.source.id))
      || (item.source.kind === 'routing-batch' && world.batches.some((batch) => batch.id === item.source.id))
      || (item.source.kind === 'event' && world.events.some((event) => event.id === item.source.id));
    assert.ok(sourceExists, `source ${item.source.kind}:${item.source.id} exists`);
    for (const scope of item.scopes) {
      assert.ok(scope === 'feed:infra' || world.projects.some((project) => project.id === scope), `scope ${scope} is a known scope`);
    }
  }
  const scopeIds = snapshot.scopes.map((option) => option.id);
  assert.deepEqual(scopeIds, ['feed:all', 'proj-core', 'proj-mine', 'feed:infra']);
  assert.equal(snapshot.scopes[0]?.kind, 'all');
  assert.equal(snapshot.scopes[3]?.kind, 'infrastructure');
});

test('infrastructure recovery that blocks a Project transcolates into that scope while generic infrastructure stays global', async () => {
  const snapshot = await projectFeed(sources(mixedWorld()));

  const lease = snapshot.attention.find((item) => item.category === 'lease-recovery');
  assert.deepEqual(lease?.scopes, ['feed:infra', 'proj-mine'], 'the Task-held lease recovery belongs to infrastructure and the blocked Project');
  const enrollment = snapshot.attention.find((item) => item.category === 'enrollment-pending');
  assert.deepEqual(enrollment?.scopes, ['feed:infra'], 'a generic enrollment never appears in a Project scope');

  const inMine = filterFeed(snapshot, { scope: 'proj-mine' });
  assert.deepEqual(
    inMine.attention.map((item) => item.id),
    ['routing-failure:batch-1', 'lease-recovery:rec-1', 'blocker:task-blk', 'validation:task-val:claim-9', 'proposal:proposal-1'],
    'the transcolated infrastructure fact appears in the blocked Project scope',
  );
  assert.ok(!inMine.attention.some((item) => item.category === 'enrollment-pending'));

  const infra = filterFeed(snapshot, { scope: 'feed:infra' });
  assert.deepEqual(
    infra.attention.map((item) => item.id).sort(),
    ['enrollment:enr-1', 'lease-recovery:rec-1'],
  );
  assert.ok(!infra.attention.some((item) => item.source.kind === 'task'));

  const all = filterFeed(snapshot, { scope: 'feed:all' });
  assert.equal(all.attention.length, snapshot.attention.length);

  const mineOption = snapshot.scopes.find((option) => option.id === 'proj-mine');
  assert.equal(mineOption?.attentionCount, inMine.attention.length, 'scope counters agree with the filtered view');
  const infraOption = snapshot.scopes.find((option) => option.id === 'feed:infra');
  assert.equal(infraOption?.attentionCount, infra.attention.length);
});

test('terminal Tasks retain blocker history without permanent blocker Attention', async () => {
  const original = mixedWorld().tasks.find(task => task.id === 'task-blk')!;
  const stopEvidenceTask = {
    ...original,
    status: 'stopped' as const,
    environmentLifecycleState: 'discarded' as const,
    environmentLeaseId: 'lease-stopped',
  };
  assert.equal(taskLifecycleSentence(stopEvidenceTask), 'Task stopped · No active Agent run · Lease released');
  for (const terminal of [
    { status: 'cancelled' as const, environmentLifecycleState: 'ended' as const },
    { status: 'cancelled' as const, environmentLifecycleState: 'discarded' as const },
    { status: 'stopped' as const, environmentLifecycleState: 'discarded' as const },
    { status: 'done' as const, environmentLifecycleState: 'ended' as const },
  ]) {
    const task = { ...original, ...terminal };
    const snapshot = await projectFeed(sources({ tasks: [task] }));
    assert.equal(snapshot.attention.length, 0, 'terminal Task state clears the work condition even while blocker history remains');
    assert.ok(task.blocker);
  }
});

test('an urgency filter narrows attention only; in-flight work and activity stay visible', async () => {
  const snapshot = await projectFeed(sources(mixedWorld()));
  const urgent = filterFeed(snapshot, { urgency: 'action_required' });
  assert.ok(urgent.attention.length > 0);
  assert.ok(urgent.attention.every((item) => item.severity === 'action_required'));
  assert.equal(urgent.inFlight.length, snapshot.inFlight.length);
  assert.equal(urgent.activity.length, snapshot.activity.length);
  const info = filterFeed(snapshot, { urgency: 'info' });
  assert.deepEqual(info.attention.map((item) => item.category), ['proposal-pending']);
});

test('attention holds no state of its own: an item exists only while its authoritative source does', async () => {
  const feed = createFeedProjection(sources(mixedWorld()));
  const before = await feed.snapshot();
  assert.ok(before.attention.some((item) => item.id === 'blocker:task-blk'));
  assert.ok(before.attention.some((item) => item.id === 'enrollment:enr-1'));
  assert.deepEqual(Object.keys(feed), ['snapshot'], 'the projection exposes no command surface to hide behind');

  // The sources clear: blocker removed, claim validated, enrollment approved,
  // recovery resolved, routing batch absent, proposal begun.
  const world = mixedWorld();
  world.tasks = world.tasks.map((task) => {
    if (task.id === 'task-blk') {
      const { blocker: _blocker, ...rest } = task;
      return { ...rest, status: 'todo', environmentLifecycleState: 'idle', updatedAt: 800 };
    }
    if (task.id === 'task-val') {
      const { pendingCompletionClaimId: _pending, ...rest } = task;
      return { ...rest, environmentLifecycleState: 'idle', updatedAt: 801 };
    }
    return task;
  });
  world.enrollments = world.enrollments.map((enrollment) => ({ ...enrollment, status: 'approved' as const, updatedAt: 802 }));
  world.recoveries = world.recoveries.map((record) => ({ ...record, phase: 'resolved' as const }));
  world.batches = [];
  world.proposals = world.proposals.map((proposal) => ({ ...proposal, status: 'begun' as const }));
  const after = await projectFeed(sources(world));
  assert.deepEqual(
    after.attention.map((item) => item.id),
    ['event:ev-har', 'task-recovery:task-rec', 'task-recovery:task-held'],
    'cleared sources vanish; a Task still in recovery keeps its own attention',
  );
  assert.ok(
    !JSON.stringify(after).includes('blocker:task-blk'),
    'nothing about the cleared condition survives in the snapshot',
  );
});

test('the projection never exposes engine prose, prompts, raw results, frozen routing context, or conversation content', async () => {
  const world = mixedWorld();
  world.tasks = [
    ...world.tasks,
    makeTask({
      id: 'task-path',
      projectId: 'proj-core',
      status: 'blocked',
      environmentLifecycleState: 'blocked',
      environmentLeaseId: 'lease-path',
      blocker: {
        reason: 'Lease proof at /Users/someone/private/task.log is missing.',
        requiredAction: 'Inspect the log at /Users/someone/private/task.log.',
        responsible: { kind: 'recovery', mechanism: 'worker reconnect' },
        nextAdvancer: { memberId: 'human-1', memberKind: 'human' },
        createdBy: { memberId: 'human-1', memberKind: 'human' },
        createdAt: 50,
      },
      updatedAt: 50,
    }),
  ];
  world.events = [
    ...world.events,
    makeEvent({ id: 'ev-path', projectId: 'proj-core', disposition: 'human-action-required', summary: 'Proof missing under /Users/someone/private', createdAt: 620 }),
  ];
  const snapshot = await projectFeed(sources(world));
  const wire = JSON.stringify(snapshot);

  for (const marker of [
    'PROMPT_SECRET_9182',
    'PROMPT_SECRET_NESTED',
    'PROMPT_SECRET_DONE',
    'PROMPT_SECRET_FAILED',
    'RAW_TOOL_OUTPUT_SECRET',
    'RESULT_SECRET_DONE',
    'ENGINE_PROSE_SECRET',
    'FAILURE_TEXT_SECRET',
    'FROZEN ROUTING CONTEXT WITH MODEL INPUT',
    'CLAIM_PROSE_THAT_MUST_NOT_LEAK',
    '/Users/someone/private',
  ]) {
    assert.ok(!wire.includes(marker), `feed wire must never contain ${marker}`);
  }
  assert.ok(wire.includes('<redacted-path>'), 'the projection redacts again at its own boundary');

  for (const item of [...snapshot.attention, ...snapshot.activity]) {
    const text = 'reason' in item ? item.reason : 'summary' in item ? item.summary : '';
    assert.ok(text.length <= 400, `bounded text: ${text.length}`);
  }
  for (const item of snapshot.activity) assert.ok(item.summary.length <= 300);
});

test('in-flight work projects current Tasks and runs with configured identity and lifecycle only', async () => {
  const world = mixedWorld();
  world.runs.push(makeRun({ id: 'run-unscoped', status: 'running' }));
  const snapshot = await projectFeed(sources(world));
  assert.deepEqual(
    snapshot.inFlight.map((item) => item.id).sort(),
    ['run:run-live', 'run:run-nested', 'run:run-unscoped', 'task:task-live'],
    'terminal runs and resting Tasks are not in flight',
  );
  const taskItem = snapshot.inFlight.find((item) => item.kind === 'task');
  assert.equal(taskItem?.lifecycle, 'Task active · Agent run active · Lease held');
  assert.equal(taskItem?.engine, 'codex');
  assert.equal(taskItem?.model, 'gpt-5.4');
  assert.deepEqual(taskItem?.target?.path, '/project/tasks/task-live');
  const runItem = snapshot.inFlight.find((item) => item.id === 'run:run-live');
  assert.match(runItem?.lifecycle ?? '', /^Run running · Agent agent-scout/);
  assert.equal(snapshot.inFlight.find((item) => item.id === 'run:run-unscoped')?.target?.surface, 'agent-detail');
  assert.equal(snapshot.inFlight.find((item) => item.id === 'run:run-unscoped')?.target?.path, '/manage/agents/agent-scout');
  assert.ok(!JSON.stringify(snapshot.inFlight).includes('PROMPT_SECRET'), 'a run projects no prompt');
});

test('in-flight cards expose configured engine and work model identifiers without run content', async () => {
  const task = makeTask({
    id: 'task-configured',
    projectId: 'project-configured',
    status: 'in-progress',
    environmentLifecycleState: 'running',
    activeRunId: 'run-configured',
  });
  const run = makeRun({
    id: 'run-configured',
    status: 'running',
    projectId: 'project-configured',
    taskId: 'task-configured',
    prompt: 'PROMPT_SECRET_CONFIGURED',
    events: [{ type: 'message', text: 'ENGINE_PROSE_SECRET', final: true }],
    workOption: { id: 'primary', engine: 'codex', workModel: 'gpt-5.4', effort: 'high' },
  });
  const snapshot = await projectFeed(sources({
    projects: [{ id: 'project-configured', displayName: 'Configured Project' }],
    tasks: [task],
    runs: [run],
  }));
  const taskItem = snapshot.inFlight.find((item) => item.id === 'task:task-configured');
  const runItem = snapshot.inFlight.find((item) => item.id === 'run:run-configured');

  assert.equal(taskItem?.engine, 'codex');
  assert.equal(taskItem?.model, 'gpt-5.4');
  assert.equal(runItem?.engine, 'codex');
  assert.equal(runItem?.model, 'gpt-5.4');
  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes('PROMPT_SECRET_CONFIGURED'));
  assert.ok(!wire.includes('ENGINE_PROSE_SECRET'));
});

test('chat-related activity retains exact Message, Project event, Agent, Project and run identities', async () => {
  const source = sources({
    projects: [{ id: 'proj-chat', displayName: 'Chat Project' }],
    events: [
      makeEvent({ id: 'event-chat-complete', projectId: 'proj-chat', kind: 'chat-complete', disposition: 'informational', producer: { id: 'agent-scout', kind: 'agent' } }),
      makeEvent({ id: 'event-chat-started', projectId: 'proj-chat', kind: 'chat-started', disposition: 'informational' }),
      makeEvent({ id: 'event-chat-error', projectId: 'proj-chat', kind: 'agent-run-failure', disposition: 'informational', deliveryKey: 'run-failure:run-chat-error' }),
      makeEvent({ id: 'event-chat-error-generic', projectId: 'proj-chat', kind: 'chat-error', disposition: 'informational' }),
    ],
    runs: [
      makeRun({ id: 'run-chat-complete', agentId: 'agent-scout', projectId: 'proj-chat', status: 'completed', completedAt: 710 }),
      makeRun({ id: 'run-chat-error', agentId: 'agent-scout', projectId: 'proj-chat', status: 'failed', completedAt: 711 }),
      makeRun({ id: 'run-without-origin', agentId: 'agent-scout', projectId: 'proj-chat', status: 'completed', completedAt: 712 }),
    ],
  });
  const snapshot = await projectFeed({
    ...source,
    chatActivityOrigins: async () => [
      { runId: 'run-chat-complete', projectId: 'proj-chat', agentId: 'agent-scout', scopeId: 'dm-proj-chat-agent-scout', messageId: 'message-trigger' },
      { runId: 'run-chat-error', projectId: 'proj-chat', agentId: 'agent-scout', scopeId: 'wg-proj-chat-review', messageId: 'message-error-trigger' },
      { runId: 'run-without-origin', projectId: 'proj-chat', agentId: 'agent-scout', scopeId: '../settings', messageId: 'message-hostile' },
    ],
  });
  const completed = snapshot.activity.find((item) => item.id === 'run:run-chat-complete');
  assert.deepEqual(
    { projectId: completed?.target?.projectId, scopeId: completed?.target?.scopeId, messageId: completed?.target?.messageId, runId: completed?.target?.runId, agentId: completed?.target?.agentId },
    { projectId: 'proj-chat', scopeId: 'dm-proj-chat-agent-scout', messageId: 'message-trigger', runId: 'run-chat-complete', agentId: 'agent-scout' },
  );
  assert.equal(snapshot.activity.find((item) => item.id === 'event:event-chat-complete')?.target?.eventId, 'event-chat-complete');
  assert.equal(snapshot.activity.find((item) => item.id === 'event:event-chat-started')?.target?.eventId, 'event-chat-started');
  assert.equal(snapshot.activity.find((item) => item.id === 'event:event-chat-error-generic')?.target?.eventId, 'event-chat-error-generic');
  const failed = snapshot.activity.find((item) => item.id === 'event:event-chat-error');
  assert.deepEqual(
    {
      projectId: failed?.target?.projectId,
      scopeId: failed?.target?.scopeId,
      messageId: failed?.target?.messageId,
      eventId: failed?.target?.eventId,
      runId: failed?.target?.runId,
      agentId: failed?.target?.agentId,
    },
    {
      projectId: 'proj-chat',
      scopeId: 'wg-proj-chat-review',
      messageId: undefined,
      eventId: 'event-chat-error',
      runId: 'run-chat-error',
      agentId: 'agent-scout',
    },
    'event activity focuses its own Project event while retaining safe causal run context',
  );
  assert.equal(snapshot.activity.find((item) => item.id === 'run:run-without-origin')?.target, undefined, 'missing or hostile causal identities do not guess a Chat destination');
});

test('operational activity is bounded, sanitized, and newest first', async () => {
  const base = await projectFeed(sources(mixedWorld()));
  const runActivity = base.activity.find((item) => item.id === 'run:run-done');
  assert.ok(base.activity.some((item) => item.kind === 'agent-run'), 'settled runs contribute fact-form activity');
  assert.equal(runActivity?.summary, 'Agent run completed · agent-scout');

  const world = mixedWorld();
  world.events = [
    ...world.events,
    ...Array.from({ length: 60 }, (_unused, index) =>
      makeEvent({ id: `ev-${index}`, projectId: 'proj-core', disposition: 'informational', kind: 'heartbeat', summary: `observed ${index}`, createdAt: 1_000 + index })),
  ];
  const snapshot = await projectFeed(sources(world));
  assert.equal(snapshot.activity.length, FEED_ACTIVITY_LIMIT);
  assert.equal(snapshot.activity[0]?.id, 'event:ev-59', 'the newest fact leads the stream');
  for (let index = 1; index < snapshot.activity.length; index += 1) {
    assert.ok((snapshot.activity[index - 1]?.at ?? 0) >= (snapshot.activity[index]?.at ?? 0), 'activity is newest-first');
  }
});

test('items whose source has no owning Project are omitted rather than deep-linked to a phantom surface', async () => {
  const world = mixedWorld();
  world.proposals = [...world.proposals, makeProposal({ id: 'proposal-ghost', projectId: 'ghost-project' })];
  world.events = [...world.events, makeEvent({ id: 'ev-ghost', projectId: 'ghost-project', disposition: 'human-action-required', summary: 'Ghost project event' })];
  world.recoveries = [...world.recoveries, makeRecovery({ id: 'rec-dangling', environmentInstanceId: 'env-3', leaseId: 'lease-dangling', taskId: 'missing-task', holderId: 'missing-task' })];
  world.tasks = [...world.tasks, makeTask({ id: 'task-x', projectId: 'proj-x', status: 'in-progress', environmentLifecycleState: 'awaiting-validation', environmentLeaseId: 'lease-x', pendingCompletionClaimId: 'claim-x', completionClaims: [], updatedAt: 500 })];

  const snapshot = await projectFeed(sources(world));
  const scopeIds = snapshot.scopes.map((option) => option.id);
  assert.ok(!scopeIds.includes('ghost-project'), 'a Project with no authority and no work earns no scope');
  assert.ok(scopeIds.includes('proj-x'), 'a Project a Task actually references is scoping-eligible');
  assert.equal(snapshot.scopes.find((option) => option.id === 'proj-x')?.label, 'proj-x');
  assert.ok(snapshot.attention.some((item) => item.id === 'validation:task-x:claim-x'));
  assert.ok(!snapshot.attention.some((item) => item.id === 'proposal:proposal-ghost'));
  assert.ok(!snapshot.attention.some((item) => item.id === 'event:ev-ghost'));
  const ghostActivity = snapshot.activity.find((item) => item.id === 'event:ev-ghost');
  assert.deepEqual(ghostActivity?.scopes, [], 'durable activity still shows, globally, without a phantom deep link');
  assert.equal(ghostActivity?.target, undefined);
  const dangling = snapshot.attention.find((item) => item.id === 'lease-recovery:rec-dangling');
  assert.deepEqual(dangling?.scopes, ['feed:infra'], 'a recovery record whose Task is gone stays infrastructure-only');
  assert.equal(dangling?.target?.surface, 'environments');
});

test('Task reopen control-history events produce separate task-centric Feed beats with actor and reason', async () => {
  const history: TaskControlEvent[] = [
    { action: 'reopened', actor: { memberId: 'operator', memberKind: 'human' }, at: 900, reason: 'Recovery evidence was reviewed.', fromStatus: 'stopped', previousCompletedAt: 800 },
    { action: 'reopened', actor: { memberId: 'operator', memberKind: 'human' }, at: 950, reason: 'The remaining work is still needed.', fromStatus: 'cancelled' },
  ];
  const snapshot = await projectFeed(sources({
    projects: [{ id: 'proj-reopen', displayName: 'Reopen Project' }],
    tasks: [makeTask({ id: 'task-reopen', projectId: 'proj-reopen', status: 'in-progress', controlHistory: history })],
  }));
  const beats = snapshot.activity.filter((item) => item.kind === 'task-reopened').sort((left, right) => left.at - right.at);
  assert.equal(beats.length, 2, 'each reopen cycle remains a distinct activity item');
  assert.notEqual(beats[0]?.id, beats[1]?.id);
  assert.equal(beats[0]?.summary, 'Task reopened by Human operator: Recovery evidence was reviewed.');
  assert.equal(beats[1]?.summary, 'Task reopened by Human operator: The remaining work is still needed.');
  assert.deepEqual(beats[0]?.scopes, ['proj-reopen']);
  assert.equal(beats[0]?.target?.surface, 'project-task-detail');
  assert.equal(beats[0]?.target?.taskId, 'task-reopen');
});

test('isFeedDeepLink accepts canonical targets and rejects malformed identities', () => {
  assert.ok(isFeedDeepLink({ surface: 'project-task-detail', taskId: 'task-1', path: '/project/tasks/task-1' }));
  assert.ok(isFeedDeepLink({ surface: 'project-tasks', proposalId: 'p 1', path: '/project/tasks?proposal=p%201' }));
  assert.ok(isFeedDeepLink({ surface: 'agent-detail', agentId: 'agent-1', path: '/manage/agents/agent-1' }));
  const chatTarget = feedTarget({ surface: 'project-chat', projectId: 'project-1', scopeId: 'dm-project-1-agent-1', messageId: 'message-1', runId: 'run-1', agentId: 'agent-1' });
  assert.equal(chatTarget.path, '/project/chat/dm-project-1-agent-1?message=message-1');
  assert.ok(isFeedDeepLink(chatTarget));
  assert.ok(!isFeedDeepLink({ surface: 'project-chat', projectId: 'project-1', scopeId: '../settings', messageId: 'message-1', path: '/project/chat/%2E%2E%2Fsettings?message=message-1' }), 'hostile conversation ids are rejected');
  assert.ok(!isFeedDeepLink({ surface: 'project-chat', projectId: 'project-1', messageId: 'message-1', path: '/project/chat?message=message-1' }), 'message focus requires its exact conversation');
  assert.ok(!isFeedDeepLink({ surface: 'project-chat', projectId: 'project-1', scopeId: 'dm-project-1-agent-1', eventId: '<script>', path: '/project/chat/dm-project-1-agent-1?event=%3Cscript%3E' }), 'hostile event ids are rejected');
  assert.ok(!isFeedDeepLink({ surface: 'project-task-detail', path: '/project/tasks/task-1' }), 'a detail link without its Task id is invalid');
  assert.ok(!isFeedDeepLink({ surface: 'project-task-detail', taskId: 'task-1', path: '/project/tasks/other' }), 'a path that disagrees with its identity is invalid');
  assert.ok(!isFeedDeepLink({ surface: 'made-up', path: '/made-up' }), 'unknown surface');
  assert.ok(!isFeedDeepLink(null));
  assert.throws(() => feedTarget({ surface: 'project-task-detail' }), /requires taskId/);
  assert.throws(() => feedTarget({ surface: 'project-task-detail', taskId: 't', proposalId: 'p' }), /owns the project-tasks surface/);
  assert.equal(
    taskLifecycleSentence(makeTask({ id: 't', projectId: 'p', environmentLifecycleState: 'beginning' })),
    'Task beginning · No active Agent run · No lease',
  );
  assert.equal(
    taskLifecycleSentence(makeTask({ id: 't', projectId: 'p', status: 'in-progress', pauseState: 'paused', environmentLeaseId: 'lease' })),
    'Task paused · No active Agent run · Lease held',
  );
});
