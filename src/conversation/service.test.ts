import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConversationScopeService,
  type ConversationProjectFacts,
  type ConversationProjectPort,
} from './service.ts';
import {
  InMemoryConversationScopeStore,
} from './store.ts';
import {
  ConversationScopeError,
  currentWorkingGroupContent,
  isWorkingGroup,
  projectChannelScopeId,
  workingGroupStatus,
  type ConversationActor,
  type WorkingGroupScope,
} from './model.ts';

/**
 * Conversation scope and Working group behaviour (#95, ADR-0008).
 *
 * Every acceptance item is exercised against the real service over the
 * in-memory store with an explicit Project-facts port, so each failure
 * localises to the domain rule rather than a transport or adapter. The port is
 * mutated by tests to simulate Project edits (membership ends, archive), which
 * is exactly how the composed runtime observes the #92 authority changing.
 */

const human: ConversationActor = { memberId: 'operator', kind: 'human' };
const scout: ConversationActor = { memberId: 'scout', kind: 'agent' };
const scribe: ConversationActor = { memberId: 'scribe', kind: 'agent' };

interface Fixture {
  readonly store: InMemoryConversationScopeStore;
  readonly scopes: ConversationScopeService;
  readonly facts: Map<string, ConversationProjectFacts>;
  /** Advance the injected clock so timestamps are observable. */
  tick(ms?: number): number;
  /**
   * Reopen the capability over the same durable store and Project facts, as
   * a process restart would: process-memory state (such as in-flight
   * preparations) does not survive it.
   */
  restart(): ConversationScopeService;
}

function member(
  memberId: string,
  memberKind: 'human' | 'agent',
  extra: { endedAt?: number; endedReason?: string } = {},
): ConversationProjectFacts['members'][number] {
  return { memberId, memberKind, ...extra };
}

function fixture(
  projects: readonly ConversationProjectFacts[] = [
    {
      projectId: 'project-alpha',
      status: 'active',
      contentVersion: 3,
      goal: 'Ship the Alpha milestone.',
      rules: ['Report what you observed.'],
      members: [member('operator', 'human'), member('scout', 'agent'), member('scribe', 'agent')],
    },
    {
      projectId: 'project-beta',
      status: 'active',
      contentVersion: 1,
      goal: 'Ship the Beta milestone.',
      rules: [],
      members: [member('operator', 'human'), member('scout', 'agent')],
    },
  ],
): Fixture {
  const facts = new Map(projects.map((entry) => [entry.projectId, entry]));
  const port: ConversationProjectPort = {
    projectFacts: async (projectId) => facts.get(projectId),
  };
  const store = new InMemoryConversationScopeStore();
  let now = 1_000;
  const build = (): ConversationScopeService =>
    new ConversationScopeService({
      store,
      projects: port,
      clock: () => now,
      createId: () => `g${now}`,
    });
  const scopes = build();
  return {
    store,
    scopes,
    facts,
    tick(ms = 1_000) {
      now += ms;
      return now;
    },
    restart: build,
  };
}

async function createGroup(
  f: Fixture,
  input: {
    projectId?: string;
    displayName?: string;
    creator?: ConversationActor;
    memberIds?: readonly string[];
    goal?: string;
    rules?: readonly string[];
  } = {},
): Promise<WorkingGroupScope> {
  return f.scopes.createWorkingGroup({
    projectId: input.projectId ?? 'project-alpha',
    displayName: input.displayName ?? 'Core Mechanics',
    creator: input.creator ?? human,
    ...(input.memberIds !== undefined ? { memberIds: input.memberIds } : {}),
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.rules !== undefined ? { rules: input.rules } : {}),
  });
}

function rejects(
  promise: Promise<unknown>,
  code: string,
  message?: string,
): Promise<void> {
  return promise.then(
    () => assert.fail(`expected refusal ${code}`),
    (error: unknown) => {
      assert.ok(error instanceof ConversationScopeError, `expected ConversationScopeError, got ${String(error)}`);
      assert.equal(error.code, code);
      if (message !== undefined) assert.ok(error.message.includes(message), `message ${JSON.stringify(error.message)} should mention ${JSON.stringify(message)}`);
    },
  );
}

// --- AC: every Project has one Project channel; direct identity per Project ---

test('every Project has exactly one Project channel, idempotent across reads and creation', async () => {
  const f = fixture();
  const first = await f.scopes.ensureProjectChannel('project-alpha');
  const again = await f.scopes.ensureProjectChannel('project-alpha');
  assert.equal(first.kind, 'project');
  assert.equal(first.id, projectChannelScopeId('project-alpha'));
  assert.equal(again.id, first.id, 'a repeated ensure returns the same channel');
  // The bridge path (used during Project persistence) is idempotent too.
  const prepared = await f.scopes.prepareProjectChannel({ id: 'project-alpha' });
  prepared.commit();
  const preparedAgain = await f.scopes.prepareProjectChannel({ id: 'project-alpha' });
  preparedAgain.commit();
  const channels = f.store.writes.filter((scope) => scope.kind === 'project');
  assert.equal(channels.length, 1, 'one durable write creates the one channel');

  const other = await f.scopes.ensureProjectChannel('project-beta');
  assert.notEqual(other.id, first.id, 'each Project owns its own channel');

  const listed = await f.scopes.listScopes('project-alpha');
  assert.deepEqual(
    listed.filter((scope) => scope.kind === 'project').map((scope) => scope.id),
    [first.id],
    'listing never reveals a second channel for one Project',
  );
});

test('a failed Project persistence rolls back exactly the channel row its preparation created', async () => {
  const f = fixture();
  const id = projectChannelScopeId('project-alpha');

  // The prepare phase writes the channel before the Project is persisted; a
  // failed Project save must not leave an orphan scope row behind.
  const prepared = await f.scopes.prepareProjectChannel({ id: 'project-alpha' });
  assert.equal((await f.store.get(id))?.kind, 'project', 'the row exists during preparation');
  await prepared.rollback();
  await prepared.rollback();
  prepared.commit();
  assert.equal(await f.store.get(id), undefined, 'rollback removes the prepared row');

  // A channel that already existed before preparation is never removed: the
  // rollback only erases what that preparation itself created.
  const ensured = await f.scopes.ensureProjectChannel('project-alpha');
  const preparedAgain = await f.scopes.prepareProjectChannel({ id: 'project-alpha' });
  await preparedAgain.rollback();
  assert.equal((await f.store.get(ensured.id))?.kind, 'project', 'a pre-existing channel survives');
  preparedAgain.commit();
});

test('direct-message identity is distinct per Project and repeated opens yield one conversation', async () => {
  const f = fixture([
    {
      projectId: 'project-alpha',
      status: 'active',
      contentVersion: 1,
      goal: 'A',
      rules: [],
      members: [member('operator', 'human'), member('scout', 'agent')],
    },
    {
      projectId: 'project-beta',
      status: 'active',
      contentVersion: 1,
      goal: 'B',
      rules: [],
      members: [member('operator', 'human'), member('scout', 'agent')],
    },
  ]);
  const inAlpha = await f.scopes.openDirect({
    projectId: 'project-alpha',
    participants: ['scout', 'operator'],
  });
  const inBeta = await f.scopes.openDirect({
    projectId: 'project-beta',
    participants: ['operator', 'scout'],
  });
  assert.notEqual(inAlpha.id, inBeta.id, 'the same pair in two Projects is two conversations');
  assert.deepEqual(inAlpha.participants, ['operator', 'scout'], 'participants are canonicalized');

  const writesBefore = f.store.writes.length;
  const reopened = await f.scopes.openDirect({
    projectId: 'project-alpha',
    participants: ['operator', 'scout'],
  });
  assert.equal(reopened.id, inAlpha.id, 'opening the same pair again finds one conversation');
  assert.equal(f.store.writes.length, writesBefore, 'a repeated open writes nothing');
});

test('direct conversations refuse non-members, self-pairs, and archived Projects', async () => {
  const f = fixture();
  await rejects(
    f.scopes.openDirect({ projectId: 'project-alpha', participants: ['operator', 'ghost'] }),
    'not-a-project-member',
    'ghost',
  );
  await rejects(
    f.scopes.openDirect({ projectId: 'project-alpha', participants: ['operator', 'operator'] }),
    'invalid-participants',
  );
  await rejects(
    f.scopes.openDirect({ projectId: 'project-alpha', participants: ['operator'] }),
    'invalid-participants',
  );
  await rejects(
    f.scopes.openDirect({ projectId: 'project-unknown', participants: ['operator', 'scout'] }),
    'unknown-project',
  );
  const facts = f.facts.get('project-alpha')!;
  f.facts.set('project-alpha', { ...facts, status: 'archived' });
  await rejects(
    f.scopes.openDirect({ projectId: 'project-alpha', participants: ['operator', 'scout'] }),
    'archived-project-is-read-only',
  );
  assert.equal(f.store.writes.length, 0, 'no refused open became durable');
});

// --- AC: atomic creation, creator inclusion, current members only, no work ---

test('Working group creation is one atomic record with the channel, creator first, and only current members', async () => {
  const f = fixture();
  const group = await createGroup(f, {
    creator: scout,
    memberIds: ['scribe', 'operator'],
    goal: 'Design the mechanics.',
    rules: ['Keep the loop short.'],
  });
  // One record is one write: the channel cannot exist without the group.
  assert.equal(f.store.writes.length, 1);
  assert.equal(f.store.writes[0]?.id, group.id);
  assert.equal(group.kind, 'working-group');
  assert.equal(group.creatorId, 'scout');
  assert.deepEqual(
    group.memberships.map((entry) => entry.memberId),
    ['scout', 'scribe', 'operator'],
    'the creator is the first member even though it was not requested again',
  );
  assert.equal(group.memberships[0]?.addedBy, 'scout');
  assert.equal(group.content.currentVersion, 1);
  assert.equal(workingGroupStatus(group), 'active');
  assert.deepEqual(group.lifecycle, [], 'a fresh group has an empty lifecycle history');

  // No member outside the Project may be included — not by request, not by creator.
  const writesBefore = f.store.writes.length;
  await rejects(
    createGroup(f, { creator: human, memberIds: ['ghost'] }),
    'member-not-current',
    'ghost',
  );
  // An ended Project membership is not a current member either.
  const facts = f.facts.get('project-alpha')!;
  f.facts.set('project-alpha', {
    ...facts,
    members: facts.members.map((entry) =>
      entry.memberId === 'scribe' ? { ...entry, endedAt: 5_000, endedReason: 'moved on' } : entry,
    ),
  });
  await rejects(
    createGroup(f, { creator: human, memberIds: ['scribe'] }),
    'member-not-current',
    'scribe',
  );
  assert.equal(f.store.writes.length, writesBefore, 'a refused creation writes nothing at all');

  // Creation itself sends no message, wakes no Agent, and creates no work:
  // this Module composes no collaboration, run, Task, or lease port, and the
  // only durable effect of creation is the one scope record asserted above.
  assert.equal((await f.scopes.listScopes('project-alpha')).filter(isWorkingGroup).length, 1);
});

// --- AC: creator and Human management authority ---

test('only the creator or the Human may manage a Working group, and only as a current member', async () => {
  const f = fixture();
  const group = await createGroup(f, { creator: scout, memberIds: ['scribe', 'operator'] });
  f.tick();

  // The creator manages its own group.
  const renamed = await f.scopes.updateWorkingGroup(group.id, scout, { displayName: 'Renamed' });
  assert.equal(renamed.content.currentVersion, 2);

  // Another member without creator status may not.
  await rejects(
    f.scopes.updateWorkingGroup(group.id, scribe, { displayName: 'Hijacked' }),
    'management-authority-required',
    'creator',
  );
  await rejects(
    f.scopes.disbandWorkingGroup(group.id, scribe),
    'management-authority-required',
  );

  // The Human may manage any Working group, including one it did not create.
  const byHuman = await f.scopes.updateWorkingGroup(group.id, human, { goal: 'Human goal' });
  assert.equal(byHuman.content.currentVersion, 3);

  // An actor outside the Project may not act at all, and an actor whose
  // membership ended is no longer a current member.
  await rejects(
    f.scopes.updateWorkingGroup(group.id, { memberId: 'ghost', kind: 'agent' }, { goal: 'x' }),
    'not-a-project-member',
  );
  const facts = f.facts.get('project-alpha')!;
  f.facts.set('project-alpha', {
    ...facts,
    members: facts.members.map((entry) =>
      entry.memberId === 'scout' ? { ...entry, endedAt: 9_000, endedReason: 'left' } : entry,
    ),
  });
  await rejects(
    f.scopes.updateWorkingGroup(group.id, scout, { goal: 'x' }),
    'not-a-project-member',
  );
  // The Human still manages the group after the creator's Project membership ended.
  const stillManaged = await f.scopes.updateWorkingGroup(group.id, human, { goal: 'kept' });
  assert.equal(stillManaged.creatorId, 'scout', 'creatorship is historical fact, not reassigned');
});

// --- AC: durable membership history ---

test('membership history is durable across add, end, and re-add', async () => {
  const f = fixture();
  const group = await createGroup(f, { creator: human, memberIds: ['scout'] });
  f.tick();
  const added = await f.scopes.addWorkingGroupMember(group.id, human, 'scribe', {
    reason: 'needs the reviewer',
  });
  assert.equal(added.memberships.length, 3);

  f.tick();
  const ended = await f.scopes.endWorkingGroupMember(group.id, human, 'scribe', {
    reason: 'review finished',
  });
  const entry = ended.memberships.find((membership) => membership.memberId === 'scribe');
  assert.ok(entry?.endedAt, 'the end is recorded');
  assert.equal(entry?.endedBy, 'operator');
  assert.equal(entry?.endedReason, 'review finished');
  assert.ok(entry?.addedAt !== undefined && entry?.addedBy === 'operator', 'the add facts survive the end');

  f.tick();
  const readded = await f.scopes.addWorkingGroupMember(group.id, human, 'scribe');
  const entries = readded.memberships.filter((membership) => membership.memberId === 'scribe');
  assert.equal(entries.length, 2, 'a re-add appends a new entry instead of rewriting history');
  assert.ok(entries[0]?.endedAt !== undefined, 'the ended entry is retained verbatim');
  assert.equal(entries[1]?.endedAt, undefined);

  // Ending the re-added participation works once, and a second end — or an end
  // for a member the group never had — is refused as no active participation.
  await f.scopes.endWorkingGroupMember(group.id, human, 'scribe');
  await rejects(
    f.scopes.endWorkingGroupMember(group.id, human, 'scribe'),
    'membership-not-active',
  );
  await rejects(
    f.scopes.endWorkingGroupMember(group.id, human, 'ghost'),
    'membership-not-active',
  );
  await rejects(
    f.scopes.addWorkingGroupMember(group.id, human, 'scout'),
    'already-a-member',
  );
  await rejects(
    f.scopes.addWorkingGroupMember(group.id, human, 'ghost'),
    'member-not-current',
  );
});

// --- AC: disband/read-only and restore ---

test('disband renders the Working group read-only while configuration and history remain; restore revives it', async () => {
  const f = fixture();
  const group = await createGroup(f, {
    creator: human,
    memberIds: ['scout'],
    goal: 'Design.',
    rules: ['Ship weekly.'],
  });
  f.tick();
  const disbanded = await f.scopes.disbandWorkingGroup(group.id, human, { reason: 'done' });
  assert.equal(workingGroupStatus(disbanded), 'disbanded');
  assert.deepEqual(
    disbanded.lifecycle,
    [{ action: 'disband', at: 2_000, actorMemberId: 'operator', reason: 'done' }],
    'the disband is durably attributed to the acting member',
  );
  // Nothing is deleted: configuration, content versions, and membership
  // history are still on the record the store holds.
  const stored = await f.store.get(group.id);
  assert.ok(stored !== undefined && isWorkingGroup(stored));
  assert.deepEqual(stored.content.versions, group.content.versions);
  assert.deepEqual(stored.memberships, group.memberships);
  assert.equal(currentGoal(stored), 'Design.');

  const state = await f.scopes.scopeState(group.id, 'operator');
  assert.deepEqual(state, {
    scopeId: group.id,
    writable: false,
    reason: 'working-group-disbanded',
  });
  await rejects(f.scopes.updateWorkingGroup(group.id, human, { goal: 'x' }), 'working-group-disbanded');
  await rejects(f.scopes.addWorkingGroupMember(group.id, human, 'scribe'), 'working-group-disbanded');
  await rejects(f.scopes.disbandWorkingGroup(group.id, human), 'working-group-disbanded');

  f.tick();
  const restored = await f.scopes.restoreWorkingGroup(group.id, human, { reason: 'back' });
  assert.equal(workingGroupStatus(restored), 'active');
  assert.deepEqual(
    restored.lifecycle,
    [
      { action: 'disband', at: 2_000, actorMemberId: 'operator', reason: 'done' },
      { action: 'restore', at: 3_000, actorMemberId: 'operator', reason: 'back' },
    ],
    'restore appends its own attributed fact without erasing the disband',
  );
  const writable = await f.scopes.scopeState(group.id, 'operator');
  assert.equal(writable.writable, true);
  await rejects(f.scopes.restoreWorkingGroup(group.id, human), 'not-disbanded');
});

// --- F1 (#95 rework): every lifecycle transition stays attributable and auditable ---

test('repeated disband and restore cycles keep every prior transition fact auditable', async () => {
  const f = fixture();
  const group = await createGroup(f, { creator: scout, memberIds: ['operator'] });

  f.tick();
  await f.scopes.disbandWorkingGroup(group.id, human, { reason: 'first pause' });
  f.tick();
  await f.scopes.restoreWorkingGroup(group.id, human, { reason: 'first resume' });
  f.tick();
  // A second actor: the creator (scout) manages its own group as well.
  await f.scopes.disbandWorkingGroup(group.id, scout, { reason: 'second pause' });
  f.tick();
  await f.scopes.restoreWorkingGroup(group.id, human, { reason: 'second resume' });

  const stored = await f.store.get(group.id);
  assert.ok(stored !== undefined && isWorkingGroup(stored));
  assert.deepEqual(
    stored.lifecycle,
    [
      { action: 'disband', at: 2_000, actorMemberId: 'operator', reason: 'first pause' },
      { action: 'restore', at: 3_000, actorMemberId: 'operator', reason: 'first resume' },
      { action: 'disband', at: 4_000, actorMemberId: 'scout', reason: 'second pause' },
      { action: 'restore', at: 5_000, actorMemberId: 'operator', reason: 'second resume' },
    ],
    'no transition overwrites an earlier one; each keeps its actor, time, and reason',
  );
  assert.equal(workingGroupStatus(stored), 'active', 'the last transition decides the derived status');

  // The stored record — not just the last return value — proves auditability
  // after another disband: the earlier four facts are still all present.
  f.tick();
  await f.scopes.disbandWorkingGroup(group.id, human, { reason: 'third pause' });
  const afterFinal = await f.store.get(group.id);
  assert.ok(afterFinal !== undefined && isWorkingGroup(afterFinal));
  assert.equal(afterFinal.lifecycle.length, 5);
  assert.equal(afterFinal.lifecycle[1]?.reason, 'first resume');
  assert.equal(afterFinal.lifecycle[3]?.actorMemberId, 'operator');
  assert.equal(workingGroupStatus(afterFinal), 'disbanded');
});

function currentGoal(group: WorkingGroupScope): string {
  return group.content.versions[group.content.versions.length - 1]!.goal;
}

test('restore rechecks eligibility: an absent member refuses restore, an ended membership restores without them', async () => {
  const f = fixture();
  const group = await createGroup(f, { creator: human, memberIds: ['scout', 'scribe'] });

  // Case 1: the member vanishes from the Project without an ended fact (a
  // host-configured projection dropped it). No proof of an end exists, so the
  // participation stays open — and restore refuses instead of reopening an
  // ineligible group.
  const facts = f.facts.get('project-alpha')!;
  f.facts.set('project-alpha', {
    ...facts,
    members: facts.members.filter((entry) => entry.memberId !== 'scribe'),
  });
  await f.scopes.disbandWorkingGroup(group.id, human);
  await rejects(f.scopes.restoreWorkingGroup(group.id, human), 'members-not-eligible', 'scribe');

  // Case 2: a recorded Project membership end cascades the participation end
  // first, so the restored group simply excludes the ineligible member.
  f.facts.set('project-alpha', {
    ...facts,
    members: facts.members.map((entry) =>
      entry.memberId === 'scribe' ? { ...entry, endedAt: 7_000, endedReason: 'left the Project' } : entry,
    ),
  });
  const restored = await f.scopes.restoreWorkingGroup(group.id, human);
  assert.equal(workingGroupStatus(restored), 'active');
  assert.deepEqual(
    restored.memberships.filter((entry) => entry.endedAt === undefined).map((entry) => entry.memberId),
    ['operator', 'scout'],
  );
});

// --- AC: ended-membership behaviour ---

test('an ended Project membership ends that member participation with the Project end facts, keeping history', async () => {
  const f = fixture();
  const group = await createGroup(f, { creator: human, memberIds: ['scout', 'scribe'] });
  assert.equal(group.kind, 'working-group');
  const facts = f.facts.get('project-alpha')!;
  f.facts.set('project-alpha', {
    ...facts,
    members: facts.members.map((entry) =>
      entry.memberId === 'scribe' ? { ...entry, endedAt: 6_500, endedReason: 'reassigned' } : entry,
    ),
  });

  const [synced] = await f.scopes.listWorkingGroups('project-alpha');
  assert.ok(synced);
  const entries = synced.memberships.filter((entry) => entry.memberId === 'scribe');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.endedAt, 6_500, 'the Project membership end time is the participation end time');
  assert.equal(entries[0]?.endedBy, 'project-membership');
  assert.equal(entries[0]?.endedReason, 'reassigned');
  assert.ok(entries[0]?.addedAt !== undefined, 'the add facts are not erased');

  // Idempotent: a second sync ends nothing and writes nothing new.
  const writes = f.store.writes.length;
  const changed = await f.scopes.syncProjectMembershipEnds('project-alpha');
  assert.equal(changed, 0);
  assert.equal(f.store.writes.length, writes);
});

test('an ended membership renders the member scopes read-only while history stays readable', async () => {
  const f = fixture();
  await f.scopes.ensureProjectChannel('project-alpha');
  const direct = await f.scopes.openDirect({
    projectId: 'project-alpha',
    participants: ['operator', 'scout'],
  });
  const group = await createGroup(f, { creator: human, memberIds: ['scout'] });
  f.tick();

  const facts = f.facts.get('project-alpha')!;
  f.facts.set('project-alpha', {
    ...facts,
    members: facts.members.map((entry) =>
      entry.memberId === 'scout' ? { ...entry, endedAt: 8_000, endedReason: 'done' } : entry,
    ),
  });

  // The ended member cannot write anywhere in this Project…
  assert.deepEqual(await f.scopes.scopeState(projectChannelScopeId('project-alpha'), 'scout'), {
    scopeId: projectChannelScopeId('project-alpha'),
    writable: false,
    reason: 'membership-ended',
  });
  assert.deepEqual(await f.scopes.scopeState(direct.id, 'scout'), {
    scopeId: direct.id,
    writable: false,
    reason: 'membership-ended',
  });
  assert.deepEqual(await f.scopes.scopeState(group.id, 'scout'), {
    scopeId: group.id,
    writable: false,
    reason: 'membership-ended',
  });
  // …the healthy side of the direct conversation cannot send to them either…
  assert.deepEqual(await f.scopes.scopeState(direct.id, 'operator'), {
    scopeId: direct.id,
    writable: false,
    reason: 'membership-ended',
  });
  // …while the Project channel stays writable for current members, and a
  // non-participant never gains direct-conversation access.
  assert.equal((await f.scopes.scopeState(projectChannelScopeId('project-alpha'), 'operator')).writable, true);
  assert.deepEqual(await f.scopes.scopeState(direct.id, 'scribe'), {
    scopeId: direct.id,
    writable: false,
    reason: 'not-a-participant',
  });
  assert.deepEqual(await f.scopes.scopeState(group.id, 'ghost'), {
    scopeId: group.id,
    writable: false,
    reason: 'not-a-member',
  });

  // History remains readable for everyone: the records are all still there.
  const scopes = await f.scopes.listScopes('project-alpha');
  assert.equal(scopes.length, 3);
  const [readableGroup] = await f.scopes.listWorkingGroups('project-alpha');
  assert.equal(readableGroup?.memberships.length, 2, 'membership history is intact');
});

test('an archived Project renders every scope read-only', async () => {
  const f = fixture();
  const channel = await f.scopes.ensureProjectChannel('project-alpha');
  const direct = await f.scopes.openDirect({
    projectId: 'project-alpha',
    participants: ['operator', 'scout'],
  });
  const group = await createGroup(f, { creator: human, memberIds: ['scout'] });

  const facts = f.facts.get('project-alpha')!;
  f.facts.set('project-alpha', { ...facts, status: 'archived' });

  for (const scopeId of [channel.id, direct.id, group.id]) {
    const state = await f.scopes.scopeState(scopeId, 'operator');
    assert.deepEqual(state, { scopeId, writable: false, reason: 'project-archived' });
  }
  await rejects(createGroup(f, {}), 'archived-project-is-read-only');
  await rejects(
    f.scopes.updateWorkingGroup(group.id, human, { goal: 'x' }),
    'archived-project-is-read-only',
  );
  // Reading survives archive: history is never hidden or deleted.
  assert.equal((await f.scopes.listScopes('project-alpha')).length, 3);
});

// --- AC: governing versions without conflict interpretation ---

test('scope context carries Project and Working group goal/rules versions verbatim, never merged', async () => {
  const f = fixture([
    {
      projectId: 'project-alpha',
      status: 'active',
      contentVersion: 3,
      goal: 'Ship the Alpha milestone.',
      rules: ['Always publish the daily log.', 'Escalate blockers.'],
      members: [member('operator', 'human'), member('scout', 'agent')],
    },
  ]);
  await f.scopes.ensureProjectChannel('project-alpha');
  const group = await f.scopes.createWorkingGroup({
    projectId: 'project-alpha',
    displayName: 'Focused rewrite',
    creator: human,
    memberIds: ['scout'],
    goal: 'Rewrite the parser only.',
    rules: ['Never publish the daily log.'],
  });

  const context = await f.scopes.scopeContext(group.id);
  assert.equal(context.project.contentVersion, 3, 'the governing Project version is reported');
  assert.equal(context.workingGroup?.contentVersion, 1, 'the governing group version is reported');
  // Both halves are returned verbatim as separate facts — contradictory rules
  // stay contradictory; Sprout performs no precedence or merge (ADR-0008).
  assert.deepEqual(context.project.rules, ['Always publish the daily log.', 'Escalate blockers.']);
  assert.deepEqual(context.workingGroup?.rules, ['Never publish the daily log.']);
  assert.equal(context.workingGroup?.goal, 'Rewrite the parser only.');

  // The versions evolve independently: an edit appends a group version and
  // does not touch the Project's, and vice versa.
  f.tick();
  const edited = await f.scopes.updateWorkingGroup(group.id, human, { rules: ['Ship fast.'] });
  assert.equal(edited.content.currentVersion, 2);
  const after = await f.scopes.scopeContext(group.id);
  assert.equal(after.workingGroup?.contentVersion, 2);
  assert.equal(after.project.contentVersion, 3);
  assert.deepEqual(after.workingGroup?.rules, ['Ship fast.']);

  // A non-Working group scope has the Project half only.
  const channelContext = await f.scopes.scopeContext(projectChannelScopeId('project-alpha'));
  assert.equal(channelContext.workingGroup, undefined);
  assert.equal(channelContext.project.contentVersion, 3);
});

// --- Error surfaces ---

test('unknown scopes and Projects fail closed with typed errors', async () => {
  const f = fixture();
  await rejects(f.scopes.listScopes('project-missing'), 'unknown-project');
  await rejects(f.scopes.scopeState('scope-missing', 'operator'), 'unknown-scope');
  await rejects(f.scopes.scopeContext('scope-missing'), 'unknown-scope');
  await rejects(f.scopes.getWorkingGroup('wg-missing').then((group) => {
    if (group === undefined) throw new ConversationScopeError('unknown-working-group', 'unknown working group: wg-missing');
    return group;
  }), 'unknown-working-group');
  await rejects(f.scopes.createWorkingGroup({
    projectId: 'project-alpha',
    displayName: '   ',
    creator: human,
  }), 'invalid-display-name');
  await rejects(f.scopes.humanAuthority('project-missing'), 'unknown-project');

  // The Human actor resolves from the Project's own membership.
  assert.deepEqual(await f.scopes.humanAuthority('project-alpha'), {
    memberId: 'operator',
    kind: 'human',
  });
});

// --- F1 (#95 rework 2): concurrent lifecycle commands cannot overwrite an accepted transition ---

function fulfilled<T>(results: readonly PromiseSettledResult<T>[]): PromiseFulfilledResult<T>[] {
  return results.filter((entry): entry is PromiseFulfilledResult<T> => entry.status === 'fulfilled');
}

function refused<T>(results: readonly PromiseSettledResult<T>[], code: string): number {
  const rejections = results.filter(
    (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
  );
  for (const rejection of rejections) {
    assert.ok(
      rejection.reason instanceof ConversationScopeError,
      `expected ConversationScopeError, got ${String(rejection.reason)}`,
    );
    assert.equal(rejection.reason.code, code);
  }
  return rejections.length;
}

test('concurrent lifecycle commands are serialized: exactly one transition wins and the accepted one stays durable', async () => {
  const f = fixture();
  // Creator (scout) and Human (operator) are both authorized managers, so
  // neither race below can lose on authority — only on staleness.
  const group = await createGroup(f, { creator: scout, memberIds: ['operator'] });
  f.tick();

  // Two authorized disbands race past the same prior status. Exactly one may
  // succeed; the other must refuse against the committed row instead of also
  // returning success from the same stale snapshot — and the durable record
  // must hold exactly the event of the command that won (F1, ADR-0008).
  const disbands = await Promise.allSettled([
    f.scopes.disbandWorkingGroup(group.id, human, { reason: 'operator pause' }),
    f.scopes.disbandWorkingGroup(group.id, human, { reason: 'duplicate pause' }),
  ]);
  assert.equal(fulfilled(disbands).length, 1, 'the stale disband must not succeed');
  assert.equal(refused(disbands, 'working-group-disbanded'), 1, 'the loser is a typed refusal, not a silent success');
  const acceptedDisband = fulfilled(disbands)[0]!.value;
  let stored = await f.store.get(group.id);
  assert.ok(stored !== undefined && isWorkingGroup(stored));
  assert.deepEqual(
    stored.lifecycle,
    acceptedDisband.lifecycle,
    'the accepted event — actor, time, reason — is exactly what is durable; the stale twin never landed',
  );
  assert.equal(workingGroupStatus(stored), 'disbanded');

  // The same race on restore: one committed transition, one typed refusal,
  // the disband fact still auditable underneath.
  const restores = await Promise.allSettled([
    f.scopes.restoreWorkingGroup(group.id, human, { reason: 'operator resume' }),
    f.scopes.restoreWorkingGroup(group.id, scout, { reason: 'creator resume' }),
  ]);
  assert.equal(fulfilled(restores).length, 1, 'the stale restore must not succeed');
  assert.equal(refused(restores, 'not-disbanded'), 1);
  const acceptedRestore = fulfilled(restores)[0]!.value;
  stored = await f.store.get(group.id);
  assert.ok(stored !== undefined && isWorkingGroup(stored));
  assert.deepEqual(
    stored.lifecycle,
    acceptedRestore.lifecycle,
    'the accepted restore appends without overwriting the accepted disband',
  );
  assert.equal(stored.lifecycle.length, 2, 'one disband plus one restore — no event lost to the race');
  assert.equal(workingGroupStatus(stored), 'active');
});

test('interleaved content, membership, and lifecycle edits never lose an accepted change', async () => {
  const f = fixture();
  const group = await createGroup(f, { creator: human, memberIds: ['scout'] });
  f.tick();

  // Three commands interleave against one snapshot. Every command that *is
  // accepted* (returns success) must be durable in the final record: a
  // last-write-wins store silently drops the two that a later snapshot
  // overwrote even though both returned success.
  const results = await Promise.allSettled([
    f.scopes.updateWorkingGroup(group.id, human, { goal: 'Retargeted.', reason: 'pivot' }),
    f.scopes.disbandWorkingGroup(group.id, human, { reason: 'pause for review' }),
    f.scopes.addWorkingGroupMember(group.id, human, 'scribe', { reason: 'needs the reviewer' }),
  ]);
  assert.ok(fulfilled(results).length >= 1, 'the first command to commit is always accepted');
  const stored = await f.store.get(group.id);
  assert.ok(stored !== undefined && isWorkingGroup(stored));

  const [updated, disbanded, added] = results;
  if (updated?.status === 'fulfilled') {
    assert.equal(
      stored.content.currentVersion,
      updated.value.content.currentVersion,
      'the accepted content version survives the interleaving',
    );
    assert.equal(currentWorkingGroupContent(stored).goal, 'Retargeted.');
  }
  if (disbanded?.status === 'fulfilled') {
    assert.deepEqual(stored.lifecycle, disbanded.value.lifecycle, 'the accepted disband survives');
    assert.equal(workingGroupStatus(stored), 'disbanded');
  } else {
    assert.equal(disbanded?.status, 'rejected');
    refused([disbanded!], 'working-group-disbanded');
  }
  if (added?.status === 'fulfilled') {
    const acceptedEntry = added.value.memberships.find(
      (entry) => entry.memberId === 'scribe' && entry.endedAt === undefined,
    );
    const storedEntry = stored.memberships.find(
      (entry) => entry.memberId === 'scribe' && entry.endedAt === undefined,
    );
    assert.ok(acceptedEntry !== undefined, 'the accepted add returned its membership');
    assert.deepEqual(storedEntry, acceptedEntry, 'the accepted membership survives the interleaving');
  } else {
    assert.equal(added?.status, 'rejected');
    refused([added!], 'working-group-disbanded');
  }
});

// --- F2 (#95 rework 2): an interrupted channel preparation is reconciled away at restart ---

test('restart reconciliation removes an abandoned channel preparation and keeps every live scope', async () => {
  const f = fixture();
  const alphaChannel = await f.scopes.ensureProjectChannel('project-alpha');
  const alphaGroup = await createGroup(f, { creator: human, memberIds: ['scout'] });
  f.tick();
  const betaChannel = await f.scopes.ensureProjectChannel('project-beta');
  const betaGroup = await createGroup(f, { projectId: 'project-beta', displayName: 'Beta loop' });

  // The crash window: preparation wrote the channel row, then the process
  // died before the Project save — neither commit nor rollback ever runs.
  const crashedId = projectChannelScopeId('project-crashed');
  await f.scopes.prepareProjectChannel({ id: 'project-crashed' });
  assert.equal((await f.store.get(crashedId))?.kind, 'project', 'the interrupted preparation left its row');

  // While its Project persistence is still in flight in *this* process the
  // row is a live preparation, not an abandoned one: reconciliation reaps it
  // only after the process that owned it is gone.
  assert.equal(await f.scopes.removeOrphanProjectChannels(), 0, 'an in-flight preparation is never reaped');
  assert.equal((await f.store.get(crashedId))?.kind, 'project');

  // A Working group's Project disappears from the facts (host-configured
  // projection drift): history is never deletion material, but its channel —
  // a kind-`project` row with no Project behind it — is an orphan by rule.
  f.facts.delete('project-beta');

  // Restart: a fresh capability over the same durable store, exactly as a
  // new process would open it.
  const restarted = f.restart();
  assert.equal(await restarted.removeOrphanProjectChannels(), 2, 'both abandoned preparations are removed');
  assert.equal(await f.store.get(crashedId), undefined, 'no orphan channel row survives the restart');
  assert.equal(await f.store.get(betaChannel.id), undefined, 'a channel whose Project is gone is incomplete');

  // Everything live survives untouched: the Project that exists keeps its
  // channel, and both Working group records keep creator, content, and
  // membership history (ADR-0008: lifecycle facts are never deleted).
  assert.equal((await f.store.get(alphaChannel.id))?.kind, 'project', 'the live channel is kept');
  const keptAlpha = await f.store.get(alphaGroup.id);
  assert.ok(keptAlpha !== undefined && isWorkingGroup(keptAlpha));
  assert.equal(keptAlpha.creatorId, 'operator');
  assert.equal(keptAlpha.content.currentVersion, 1);
  assert.equal(keptAlpha.memberships.length, 2);
  const keptBeta = await f.store.get(betaGroup.id);
  assert.ok(keptBeta !== undefined && isWorkingGroup(keptBeta), 'a Working group is never a removal candidate');
  assert.equal(keptBeta.memberships.length, 1);
});
