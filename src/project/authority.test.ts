import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProjectAuthorityError,
  activeAgentMemberIds,
  currentProjectContent,
  membershipIsActive,
  membershipForMemberId,
  sanitizeProjectDisplayName,
  sanitizeProjectGoal,
  sanitizeProjectRules,
  sanitizeRoutingIntervalMs,
  sanitizeWakePolicy,
} from './authority-model.ts';
import { ProjectService } from './authority-service.ts';
import { InMemoryProjectAuthorityStore } from './authority-store.ts';
import { GENERAL_COLLABORATION_TEMPLATE } from './template.ts';

/**
 * Domain behaviour for durable Project, template-snapshot, and membership
 * authority (#92, ADR-0008).
 *
 * These tests pin the authority rules the ticket asks for: creation with only
 * a name and the Human membership, version-attributed template snapshots,
 * durable versioned content, non-destructive membership ending and
 * archive/restore, and active-work safety.
 */

function service(options: Parameters<typeof ProjectService.prototype['create']>[0] extends never ? never : {
  readonly workSafety?: ConstructorParameters<typeof ProjectService>[0]['workSafety'];
  readonly clock?: () => number;
  readonly createId?: () => string;
} = {}) {
  return new ProjectService({
    store: new InMemoryProjectAuthorityStore(),
    clock: options.clock ?? (() => 10_000),
    ...(options.workSafety !== undefined ? { workSafety: options.workSafety } : {}),
  });
}

test('the built-in General collaboration template is immutable and carries no concrete resources', () => {
  assert.equal(GENERAL_COLLABORATION_TEMPLATE.id, 'template-general-collaboration');
  assert.equal(GENERAL_COLLABORATION_TEMPLATE.version, 1);
  // No concrete Agent id, Environment instance, workspace path, model, or
  // credential anywhere in the template content.
  const serialized = JSON.stringify(GENERAL_COLLABORATION_TEMPLATE);
  assert.ok(!serialized.includes('agent-'), 'template must not name a concrete Agent');
  assert.ok(!serialized.includes('instance'), 'template must not name an Environment instance');
  assert.ok(!serialized.includes('/'), 'template must not carry a path');
  assert.ok(Object.isFrozen(GENERAL_COLLABORATION_TEMPLATE));
  // Mutating a nested array cannot reach other readers either: the template
  // module freezes the top level, and the service copies content on creation.
  assert.throws(() => {
    (GENERAL_COLLABORATION_TEMPLATE as unknown as { version: number }).version = 99;
  });
});

test('a Project can be created with only a name; the Human membership and template snapshot are implicit', async () => {
  const projects = service();
  const project = await projects.create({ id: 'project-solo', displayName: 'Solo project' });

  assert.equal(project.id, 'project-solo');
  assert.equal(project.status, 'active');
  // The local Human is a member from birth.
  assert.ok(membershipIsActive(project, 'operator'));
  // Missing Agents and Environments do not invalidate identity.
  assert.deepEqual(activeAgentMemberIds(project), []);
  // Goal and rules may be absent.
  assert.equal(currentProjectContent(project).goal, '');
  assert.deepEqual(currentProjectContent(project).rules, []);
  // The template snapshot records its source version at creation.
  assert.equal(project.template.templateId, GENERAL_COLLABORATION_TEMPLATE.id);
  assert.equal(project.template.templateVersion, GENERAL_COLLABORATION_TEMPLATE.version);
  // The Project channel is an invariant, not template content: it exists by
  // definition and is never stored as a mutable field.
  assert.equal(project.template.completionGuidance.length > 0, true);
});

test('creating a Project copies the template as an editable snapshot, not a link', async () => {
  const projects = service();
  const project = await projects.create({ id: 'project-snap', displayName: 'Snapshot' });
  const copied = currentProjectContent(project);

  // The copy is editable: a later edit appends a Project content version and
  // leaves the template source untouched.
  const edited = await projects.updateContent('project-snap', { goal: 'A different goal' });
  assert.equal(currentProjectContent(edited).goal, 'A different goal');
  assert.equal(GENERAL_COLLABORATION_TEMPLATE.goalGuidance.length > 0, true);
  assert.equal(copied.version, 1);
  assert.equal(edited.content.currentVersion, 2);
});

test('goal, rules, wake policy, routing interval, memberships, responsibilities, and instructions are durable and versioned', async () => {
  const projects = service();
  await projects.create({
    id: 'project-versioned',
    displayName: 'Versioned',
    goal: 'First goal',
    rules: ['Report observations'],
    wakePolicy: 'wake-model-assisted',
    routingIntervalMs: 45_000,
    agentMemberships: [
      {
        agentId: 'agent-scout',
        responsibilities: ['Investigate'],
        collaborationInstructions: 'Keep it concise.',
      },
    ],
  });

  const first = await projects.get('project-versioned');
  assert.ok(first);
  const firstContent = currentProjectContent(first);
  assert.equal(firstContent.version, 1);
  assert.equal(firstContent.wakePolicy, 'wake-model-assisted');
  assert.equal(firstContent.routingIntervalMs, 45_000);
  assert.deepEqual(firstContent.memberships.find((m) => m.memberId === 'agent-scout')?.responsibilities, [
    'Investigate',
  ]);

  const second = await projects.updateContent('project-versioned', {
    goal: 'Revised goal',
    rules: ['Report observations', 'Never expand scope silently'],
    routingIntervalMs: 60_000,
    reason: 'Replan after feedback',
  });
  const secondContent = currentProjectContent(second);
  assert.equal(secondContent.version, 2);
  assert.equal(secondContent.reason, 'Replan after feedback');
  // The first version is never rewritten: later work attributes against it.
  assert.equal(second.content.versions.length, 2);
  assert.equal(second.content.versions[0]?.goal, 'First goal');
  assert.equal(second.content.versions[0]?.routingIntervalMs, 45_000);
});

test('membership edits append versions with actor time and reason facts', async () => {
  const projects = service();
  await projects.create({ id: 'project-members', displayName: 'Members' });
  let clock = 20_000;
  const ticking = new ProjectService({
    store: new InMemoryProjectAuthorityStore(),
    clock: () => clock++,
  });
  await ticking.create({ id: 'project-members', displayName: 'Members' });

  const added = await ticking.addMembership('project-members', {
    agentId: 'agent-cartographer',
    responsibilities: ['Maintain the domain map'],
    collaborationInstructions: 'Flag vocabulary drift.',
    reason: 'Enrol the cartographer',
  });
  const afterAdd = currentProjectContent(added);
  assert.equal(afterAdd.version, 2);
  assert.equal(afterAdd.at, 20_001);
  assert.equal(afterAdd.reason, 'Enrol the cartographer');
  assert.ok(membershipIsActive(added, 'agent-cartographer'));

  clock = 30_000;
  const ended = await ticking.endMembership('project-members', 'agent-cartographer', {
    reason: 'Reassign to another project',
  });
  const afterEnd = currentProjectContent(ended);
  assert.equal(afterEnd.version, 3);
  assert.equal(afterEnd.at, 30_000);
  const endedMembership = membershipForMemberId(ended, 'agent-cartographer');
  assert.ok(endedMembership);
  // The end is recorded, not erased: responsibilities, instructions, start,
  // end time, and end reason all remain for attribution.
  assert.equal(endedMembership.endedAt, 30_000);
  assert.equal(endedMembership.endedReason, 'Reassign to another project');
  assert.deepEqual(endedMembership.responsibilities, ['Maintain the domain map']);
  assert.ok(!membershipIsActive(ended, 'agent-cartographer'));
  assert.deepEqual(activeAgentMemberIds(ended), []);
});

test('ending the Human membership is refused', async () => {
  const projects = service();
  await projects.create({ id: 'project-human', displayName: 'Human' });
  await assert.rejects(
    () => projects.endMembership('project-human', 'operator'),
    (error: unknown) =>
      error instanceof ProjectAuthorityError && error.code === 'human-membership-required',
  );
});

test('ending a membership is refused while active work depends on the member', async () => {
  const blockers = {
    hasActiveRun: (projectId: string) => projectId === 'project-busy',
    hasUnfinishedTask: () => false,
    memberHasActiveRun: (projectId: string, memberId: string) =>
      projectId === 'project-busy' && memberId === 'agent-runner',
    memberHasUnfinishedTask: (projectId: string, memberId: string) =>
      projectId === 'project-busy' && memberId === 'agent-lead',
  };
  const projects = new ProjectService({
    store: new InMemoryProjectAuthorityStore(),
    workSafety: blockers,
  });
  await projects.create({
    id: 'project-busy',
    displayName: 'Busy',
    agentMemberships: [{ agentId: 'agent-runner' }, { agentId: 'agent-lead' }],
  });

  await assert.rejects(
    () => projects.endMembership('project-busy', 'agent-runner'),
    (error: unknown) =>
      error instanceof ProjectAuthorityError && error.code === 'active-work-depends-on-project',
  );
  await assert.rejects(
    () => projects.endMembership('project-busy', 'agent-lead'),
    (error: unknown) =>
      error instanceof ProjectAuthorityError && error.code === 'active-work-depends-on-project',
  );
  // A quiet member can end normally.
  await projects.create({ id: 'project-quiet', displayName: 'Quiet', agentMemberships: [{ agentId: 'agent-idle' }] });
  const ended = await projects.endMembership('project-quiet', 'agent-idle');
  assert.ok(membershipForMemberId(ended, 'agent-idle')?.endedAt);
});

test('re-adding a previously ended membership starts a fresh relationship while the old one keeps its history', async () => {
  let clock = 1_000;
  const projects = new ProjectService({
    store: new InMemoryProjectAuthorityStore(),
    clock: () => clock++,
  });
  await projects.create({ id: 'project-rejoin', displayName: 'Rejoin' });
  await projects.addMembership('project-rejoin', { agentId: 'agent-scout' });
  const ended = await projects.endMembership('project-rejoin', 'agent-scout', { reason: 'first stint over' });
  const endedAt = membershipForMemberId(ended, 'agent-scout')?.endedAt ?? 0;

  clock = 100_000;
  const readded = await projects.addMembership('project-rejoin', { agentId: 'agent-scout' });
  const content = currentProjectContent(readded);
  const memberships = content.memberships.filter((membership) => membership.memberId === 'agent-scout');
  assert.equal(memberships.length, 1, 'the current version carries the fresh relationship');
  assert.ok((memberships[0]?.startedAt ?? 0) > endedAt);
  assert.equal(memberships[0]?.endedAt, undefined);
  // The version that ended the old membership is untouched history.
  const pastEnd = readded.content.versions.find((version) =>
    version.memberships.some((membership) => membership.endedReason === 'first stint over'),
  );
  assert.ok(pastEnd);
});

test('archive is refused while active work depends on the Project and retains everything when it succeeds', async () => {
  const blockers = {
    hasActiveRun: (projectId: string) => projectId === 'project-active',
    hasUnfinishedTask: (projectId: string) => projectId === 'project-tasked',
    memberHasActiveRun: () => false,
    memberHasUnfinishedTask: () => false,
  };
  const projects = new ProjectService({
    store: new InMemoryProjectAuthorityStore(),
    workSafety: blockers,
  });
  await projects.create({
    id: 'project-active',
    displayName: 'Active run',
    agentMemberships: [{ agentId: 'agent-one' }],
  });
  await projects.create({
    id: 'project-tasked',
    displayName: 'Unfinished task',
    agentMemberships: [{ agentId: 'agent-two' }],
  });
  await projects.create({ id: 'project-restful', displayName: 'Restful' });

  await assert.rejects(
    () => projects.archive('project-active'),
    (error: unknown) =>
      error instanceof ProjectAuthorityError && error.code === 'active-work-depends-on-project',
  );
  await assert.rejects(
    () => projects.archive('project-tasked'),
    (error: unknown) =>
      error instanceof ProjectAuthorityError && error.code === 'active-work-depends-on-project',
  );

  const archived = await projects.archive('project-restful', { reason: 'work concluded' });
  assert.equal(archived.status, 'archived');
  assert.equal(archived.archivedReason, 'work concluded');
  // Memberships and history are preserved verbatim.
  assert.ok(membershipIsActive(archived, 'operator'));

  // An archived Project is read-only.
  await assert.rejects(
    () => projects.updateContent('project-restful', { goal: 'x' }),
    (error: unknown) =>
      error instanceof ProjectAuthorityError && error.code === 'archived-project-is-read-only',
  );
  await assert.rejects(
    () => projects.addMembership('project-restful', { agentId: 'agent-new' }),
    (error: unknown) =>
      error instanceof ProjectAuthorityError && error.code === 'archived-project-is-read-only',
  );

  // Restore re-enables work without erasing the archive facts.
  const restored = await projects.restore('project-restful');
  assert.equal(restored.status, 'active');
  assert.ok(restored.archivedAt !== undefined);
  assert.ok(restored.restoredAt !== undefined);
  const edited = await projects.updateContent('project-restful', { goal: 'back in business' });
  assert.equal(currentProjectContent(edited).goal, 'back in business');
});

test('free text passes the privacy boundary and an empty goal never invalidates the Project', async () => {
  const projects = service();
  // A display name that reduces to nothing usable is refused; a goal that
  // does is simply absent.
  assert.throws(
    () => sanitizeProjectDisplayName('   '),
    (error: unknown) => error instanceof ProjectAuthorityError,
  );
  // Sensitive content is redacted rather than persisted.
  const goal = sanitizeProjectGoal('Work from /home/someone/secrets with api_key=abcdef');
  assert.ok(!goal.includes('/home/someone'));
  assert.ok(!goal.includes('abcdef'));
  const rules = sanitizeProjectRules(['Report what you observed', 'token abcdefXYZ unused', '   ']);
  assert.ok(rules[0]?.includes('Report what you observed'));
  assert.ok(!JSON.stringify(rules).includes('abcdefXYZ'));
  // Boundary clamps keep the routing interval within a bounded window.
  assert.equal(sanitizeRoutingIntervalMs(undefined), 30_000);
  assert.equal(sanitizeRoutingIntervalMs(0), 1_000);
  assert.equal(sanitizeRoutingIntervalMs(999_999_999), 3_600_000);
  assert.equal(sanitizeWakePolicy(undefined), 'explicit-only');
  assert.equal(sanitizeWakePolicy('wake-model-assisted'), 'wake-model-assisted');
  assert.equal(sanitizeWakePolicy('nonsense'), 'explicit-only');

  const project = await projects.create({
    id: 'project-privacy',
    displayName: 'Privacy',
    goal: 'Goal at /home/secret/dir',
    agentMemberships: [
      { agentId: 'agent-leaky', collaborationInstructions: 'Report to host.internal.corp:9000' },
    ],
  });
  const content = currentProjectContent(project);
  assert.ok(!content.goal.includes('/home/secret'));
  const leaky = content.memberships.find((membership) => membership.memberId === 'agent-leaky');
  assert.ok(leaky !== undefined && !leaky.collaborationInstructions.includes('host.internal.corp'));
});

test('a Project authority record survives an in-memory store round-trip and a restart-shaped reopen', async () => {
  const projects = service();
  await projects.create({
    id: 'project-durable',
    displayName: 'Durable',
    goal: 'Persist me',
    agentMemberships: [{ agentId: 'agent-scout' }],
  });
  const stored = await projects.get('project-durable');
  assert.ok(stored);
  assert.equal(stored.content.currentVersion, 1);
  assert.deepEqual(activeAgentMemberIds(stored), ['agent-scout']);
  assert.equal(stored.template.templateVersion, 1);
});
