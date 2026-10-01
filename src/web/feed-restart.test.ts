/**
 * Restart evidence for the Feed projection (#103).
 *
 * The projection holds no durable state of its own, so a restart must
 * reconstruct the identical snapshot — attention, in-flight work, activity,
 * and scope counters — from the reopened SQLite stores. This is the restart
 * half of "Attention clears only when its authoritative source clears": after
 * reopening, nothing is dismissed, nothing is duplicated, and nothing is lost.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectFeed, type FeedSources, type FeedSnapshot } from './feed.ts';
import { SqliteStore } from '../store/db.ts';
import type { ProjectAuthority } from '../project/authority-model.ts';
import type { Task } from '../task/model.ts';
import type { TaskProposal } from '../task/proposal-model.ts';
import type { EnvironmentEnrollment } from '../environment/enrollment.ts';
import type { EnvironmentRecoveryRecord } from '../environment/recovery.ts';
import type { AgentRun } from '../run/model.ts';

const PROJECT_ID = 'proj-feed';

function storeSources(store: SqliteStore): FeedSources {
  return {
    projects: async () =>
      (await store.projectAuthorities.list()).map((project) => ({ id: project.id, displayName: project.displayName })),
    tasks: () => store.tasks.list(),
    proposals: () => store.taskProposals.listForProject(PROJECT_ID),
    events: () => store.collaboration.listEvents(),
    enrollments: () => store.enrollments.list(),
    recoveries: () => store.recovery.list(),
    runs: () => store.runs.list(),
    routingBatches: async () => [],
  };
}

const authority: ProjectAuthority = {
  id: PROJECT_ID,
  displayName: 'Feed Evidence',
  status: 'active',
  template: {
    templateId: 'general',
    templateVersion: 1,
    templateName: 'General',
    collaborationGuidance: '',
    completionGuidance: '',
    goalGuidance: '',
    suggestedRules: [],
    roleSlots: [],
    wakePolicy: 'explicit-only',
    routingIntervalMs: 60_000,
  },
  content: {
    currentVersion: 1,
    versions: [{
      version: 1,
      at: 1,
      reason: 'creation',
      goal: 'Evidence the Feed across a restart',
      completionGuidance: '',
      rules: [],
      wakePolicy: 'explicit-only',
      routingIntervalMs: 60_000,
      memberships: [],
    }],
  },
  createdAt: 1,
  updatedAt: 1,
};

const blockedTask: Task = {
  id: 'task-blocked',
  projectId: PROJECT_ID,
  title: 'Recover the lease',
  goal: 'Prove the task context state',
  constraints: [],
  status: 'blocked',
  environmentInstanceId: 'env-1',
  environmentLeaseId: 'lease-1',
  environmentLifecycleState: 'blocked',
  pendingCompletionClaimId: 'claim-1',
  completionClaims: [{
    id: 'claim-1',
    contentVersion: 1,
    actor: { memberId: 'agent-scout', memberKind: 'agent' },
    at: 200,
    outcomeSummary: 'Restart evidence recorded',
    validationEvidence: ['feed restart test'],
    durableChanges: [],
    limitations: [],
    recommendedDisposition: 'complete',
  }],
  blocker: {
    reason: 'Restart left an unproven cleanup.',
    requiredAction: 'Re-prove context absence after restart.',
    responsible: { kind: 'recovery', mechanism: 'fresh sentinel proof' },
    nextAdvancer: { memberId: 'human-1', memberKind: 'human' },
    createdBy: { memberId: 'agent-scout', memberKind: 'agent' },
    createdAt: 300,
  },
  createdAt: 1,
  updatedAt: 300,
};

const proposal: TaskProposal = {
  id: 'proposal-1',
  projectId: PROJECT_ID,
  proposer: { memberId: 'human-1', memberKind: 'human' },
  origin: null,
  status: 'proposed',
  revision: 1,
  currentContentVersion: 1,
  versions: [{
    version: 1,
    actor: { memberId: 'human-1', memberKind: 'human' },
    at: 1,
    reason: 'initial',
    title: 'Restart-safe feed',
    goal: 'Prove projection restart',
    constraints: [],
    validationCriteria: [],
  }],
  lifecycle: [],
  createdAt: 1,
  updatedAt: 400,
};

const pendingEnrollment: EnvironmentEnrollment = {
  id: 'enr-1',
  environmentInstanceId: 'env-2',
  displayName: 'Second Host',
  status: 'pending',
  everApproved: false,
  worker: { identityDigest: 'digest-1', platform: 'macos', capabilityRequests: [], engineFacts: [] },
  invalidatedIdentityDigests: [],
  requiresFreshIdentity: false,
  claim: undefined,
  capabilityPermissions: {},
  createdAt: 1,
  updatedAt: 500,
  revision: 1,
  decisions: [{ kind: 'requested', actor: 'host', at: 1, reason: 'host requested enrollment' }],
};

const recovery: EnvironmentRecoveryRecord = {
  id: 'rec-1',
  environmentInstanceId: 'env-1',
  enrollmentId: 'enr-1',
  leaseId: 'lease-1',
  holderKind: 'task',
  holderId: 'task-blocked',
  taskId: 'task-blocked',
  cause: 'worker-channel-lost',
  phase: 'recovery',
  startedAt: 250,
  updatedAt: 600,
  unresolvedFacts: ['task context recycle is unproven'],
  decisions: [],
};

const runningRun: AgentRun = {
  id: 'run-live',
  agentId: 'agent-scout',
  prompt: 'PROMPT_MARKER_RESTART',
  environmentInstanceId: 'env-1',
  projectId: PROJECT_ID,
  taskId: 'task-blocked',
  status: 'running',
  events: [{ type: 'tool-output', text: 'TOOL_MARKER_RESTART' }],
  createdAt: 700,
};

const settledRun: AgentRun = {
  id: 'run-done',
  agentId: 'agent-scout',
  prompt: 'PROMPT_MARKER_DONE',
  environmentInstanceId: 'env-1',
  projectId: PROJECT_ID,
  status: 'completed',
  events: [],
  result: { status: 'completed', text: 'RESULT_MARKER_DONE' },
  createdAt: 100,
  completedAt: 650,
};

async function seed(store: SqliteStore): Promise<void> {
  await store.projectAuthorities.save(authority);
  await store.tasks.create(blockedTask);
  await store.taskProposals.create(proposal);
  await store.enrollments.createIfInstanceAbsent(pendingEnrollment);
  await store.recovery.save(recovery);
  await store.runs.save(runningRun);
  await store.runs.save(settledRun);
  const event = {
    id: 'ev-har',
    projectId: PROJECT_ID,
    kind: 'release-approval',
    summary: 'Release approval needs the Human',
    producer: { id: 'sprout', kind: 'system' as const },
    disposition: 'human-action-required' as const,
    responsibleAgentIds: [],
    deliveryKey: 'ev-har-1',
    createdAt: 550,
  };
  await store.collaboration.publishEvent({
    event,
    plan: { inputId: event.id, decisions: [], observations: [] },
    now: event.createdAt,
  });
}

function summarize(snapshot: FeedSnapshot): unknown {
  return {
    attention: snapshot.attention.map((item) => ({ id: item.id, severity: item.severity, path: item.target.path, scopes: item.scopes })),
    inFlight: snapshot.inFlight.map((item) => ({ id: item.id, lifecycle: item.lifecycle })),
    activity: snapshot.activity.map((item) => ({ id: item.id, summary: item.summary })),
    scopes: snapshot.scopes,
  };
}

test('a restart reconstructs the identical Feed snapshot from reopened durable stores', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-feed-restart-'));
  const filename = join(directory, 'sprout.db');
  try {
    const first = new SqliteStore({ filename });
    await seed(first);
    const before = await projectFeed(storeSources(first));
    first.close();

    const second = new SqliteStore({ filename });
    const after = await projectFeed(storeSources(second));
    second.close();

    assert.deepEqual(summarize(after), summarize(before), 'every section and scope counter survives the reopen');
    assert.deepEqual(
      after.attention.map((item) => item.id),
      [
        'lease-recovery:rec-1',
        'event:ev-har',
        'blocker:task-blocked',
        'enrollment:enr-1',
        'validation:task-blocked:claim-1',
        'proposal:proposal-1',
      ],
      'attention derives from the reopened facts with nothing dismissed and nothing duplicated',
    );
    const lease = after.attention.find((item) => item.category === 'lease-recovery');
    assert.deepEqual(lease?.scopes, ['infra', PROJECT_ID], 'the Task-held lease recovery transcolates after restart');
    assert.deepEqual(after.inFlight.map((item) => item.id), ['run:run-live'], 'a resting blocked Task is not in flight');
    assert.ok(after.activity.some((item) => item.id === 'run:run-done'), 'settled-run activity is durable, not cached');
    const wire = JSON.stringify(after);
    for (const marker of ['PROMPT_MARKER_RESTART', 'TOOL_MARKER_RESTART', 'PROMPT_MARKER_DONE', 'RESULT_MARKER_DONE']) {
      assert.ok(!wire.includes(marker), `restart wire must never contain ${marker}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
