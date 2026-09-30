import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskProposalService } from './proposal-service.ts';
import type { TaskProposalStore } from './proposal-store.ts';
import { InMemoryTaskProposalStore } from './proposal-store.ts';
import { SqliteStore } from '../store/db.ts';
import type { WorkingGroupScope } from '../conversation/model.ts';
import type { Message } from '../collaboration/model.ts';

const human = { memberId: 'operator', memberKind: 'human' as const };
const agent = { memberId: 'author', memberKind: 'agent' as const };
const other = { memberId: 'other', memberKind: 'agent' as const };
const content = { title: 'Improve checks', goal: 'Prove correctness', constraints: ['Keep authority'], validationCriteria: ['Tests pass'] };
function fixture(store: TaskProposalStore = new InMemoryTaskProposalStore()) {
  const facts = { projectId: 'project', status: 'active' as 'active' | 'archived', contentVersion: 1, goal: '', rules: [], members: structuredClone([human, agent, other]) as {memberId: string; memberKind: 'human' | 'agent'; endedAt?: number}[] };
  const activeAgents = new Set(['author', 'other']);
  const service = new TaskProposalService({ store, agents: { agentIsActive: id => activeAgents.has(id) }, projects: { projectFacts: async (id) => id === 'project' ? facts : undefined } });
  return { service, facts, store, activeAgents };
}

test('Human and Agent proposals share validated attributable content without execution dependencies', async () => {
  const { service, store } = fixture();
  for (const actor of [human, agent]) {
    const proposal = await service.propose('project', actor, content);
    assert.deepEqual(proposal.proposer, actor);
    assert.equal(proposal.currentContentVersion, 1);
    assert.deepEqual(proposal.versions[0]?.validationCriteria, content.validationCriteria);
    assert.deepEqual(proposal.versions[0]?.actor, actor);
  }
  const mutableActor = { ...agent, unexpected: 'not durable' };
  const pending = service.propose('project', mutableActor, content);
  mutableActor.memberId = other.memberId;
  const captured = await pending;
  assert.deepEqual(captured.proposer, agent, 'authority and attribution hold the same actor snapshot');
  assert.deepEqual(captured.versions[0]?.actor, agent, 'unknown actor fields are not persisted');
  const before = await store.listForProject('project');
  assert.deepEqual(await service.validate('project', agent, content), content);
  await assert.rejects(service.validate('project', agent, { ...content, goal: '' }), { code: 'invalid-content' });
  assert.deepEqual(await store.listForProject('project'), before);
  const privatePath = ['','synthetic','private','workspace'].join('/');
  const sensitive = { ...content, goal: `Review safely; do not disclose ${privatePath}` };
  const sanitized = await service.validate('project', human, sensitive);
  assert.ok(!sanitized.goal.includes(privatePath));
  const saved = await service.propose('project', human, sensitive);
  assert.equal(saved.versions[0]?.goal, sanitized.goal);
  await assert.rejects(service.propose('project', human, { ...content, goal: privatePath }), { code: 'invalid-content' });
});

test('Only proposer revises or withdraws; Human override and rejection require durable reasons', async () => {
  const { service } = fixture();
  const proposal = await service.propose('project', agent, content);
  await assert.rejects(service.revise(proposal.id, other, { ...content, reason: 'Correction', expectedRevision: 1 }), { code: 'authority-required' });
  await assert.rejects(service.reject(proposal.id, agent, { reason: 'Not needed', expectedRevision: 1 }), { code: 'authority-required' });
  await assert.rejects(service.revise(proposal.id, human, { ...content, reason: '', expectedRevision: 1 }), { code: 'invalid-content' });
  const revised = await service.revise(proposal.id, human, { ...content, goal: 'Corrected goal', reason: 'Narrow scope', expectedRevision: 1 });
  assert.equal(revised.versions[1]?.reason, 'Narrow scope');
  assert.deepEqual(revised.versions[1]?.actor, human);
  const rejected = await service.reject(proposal.id, human, { reason: 'No longer needed', expectedRevision: 2 });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.lifecycle[0]?.reason, 'No longer needed');
  await assert.rejects(service.revise(proposal.id, agent, { ...content, reason: 'Retry', expectedRevision: 3 }), { code: 'proposal-closed' });
  const own = await service.propose('project', agent, content);
  assert.equal((await service.withdraw(own.id, agent, { reason: 'Superseded', expectedRevision: 1 })).status, 'withdrawn');
});

test('Ended membership, actor-kind spoofing and archived Projects fail closed without losing historical reads', async () => {
  const { service, facts, activeAgents } = fixture();
  const proposal = await service.propose('project', agent, content);
  await assert.rejects(service.propose('project', { ...agent, memberKind: 'human' }, content), { code: 'membership-required' });
  activeAgents.delete(agent.memberId);
  await assert.rejects(service.propose('project', agent, content), { code: 'agent-read-only' });
  await assert.rejects(service.revise(proposal.id, agent, { ...content, reason: 'Correction', expectedRevision: 1 }), { code: 'agent-read-only' });
  activeAgents.add(agent.memberId);
  facts.members[1]!.endedAt = 5;
  await assert.rejects(service.withdraw(proposal.id, agent, { reason: 'Finished', expectedRevision: 1 }), { code: 'membership-required' });
  facts.status = 'archived';
  await assert.rejects(service.validate('project', human, content), { code: 'project-read-only' });
  assert.equal((await service.get(proposal.id)).id, proposal.id);
});

test('Concurrent content changes refuse stale writes and frozen content cannot be mutated by later revisions or callers', async () => {
  const { service } = fixture();
  const proposal = await service.propose('project', agent, content);
  const admitted = await service.contentVersion(proposal.id, 1);
  const outcomes = await Promise.allSettled(['First', 'Second'].map(goal => service.revise(proposal.id, agent, { ...content, goal, reason: 'Improve', expectedRevision: 1 })));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal((outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult).reason.code, 'stale-proposal');
  assert.equal(admitted.goal, content.goal);
  (admitted.constraints as string[]).push('Caller mutation');
  assert.deepEqual((await service.contentVersion(proposal.id, 1)).constraints, content.constraints);
  await assert.rejects(service.contentVersion(proposal.id, 99), { code: 'unknown-content-version' });
});

test('SQLite restart preserves version and lifecycle attribution using the same store contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-test-'));
  try {
    const filename = join(dir, 'state.sqlite');
    let db = new SqliteStore({ filename });
    let service = fixture(db.taskProposals).service;
    const proposal = await service.propose('project', agent, content);
    await service.revise(proposal.id, human, { ...content, goal: 'Revised', reason: 'Correction', expectedRevision: 1 });
    await service.reject(proposal.id, human, { reason: 'Replaced', expectedRevision: 2 });
    const before = await service.get(proposal.id);
    db.close();
    db = new SqliteStore({ filename });
    service = fixture(db.taskProposals).service;
    assert.deepEqual(await service.get(proposal.id), before);
    assert.equal((await service.contentVersion(proposal.id, 1)).goal, content.goal);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Working-group and source-Message provenance survives SQLite restart; direct origins are explicitly null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-origin-'));
  const origin = { workingGroupId: 'group-1', sourceMessageId: 'message-1' };
  const group: WorkingGroupScope = {
    id: origin.workingGroupId, projectId: 'project', kind: 'working-group', creatorId: agent.memberId,
    memberships: [{ ...agent, addedAt: 1, addedBy: agent.memberId }], lifecycle: [],
    content: { currentVersion: 1, versions: [{ version: 1, at: 1, actorMemberId: agent.memberId, reason: 'Created', displayName: 'Group', goal: '', rules: [] }] },
    createdAt: 1, updatedAt: 1,
  };
  const message: Message = {
    id: origin.sourceMessageId, projectId: 'project', scopeId: group.id, channel: 'working-group',
    author: { id: agent.memberId, kind: agent.memberKind }, body: 'Source', recipients: [], deliveryKey: 'source', createdAt: 2,
  };
  let db = new SqliteStore({ filename: join(dir, 'state.sqlite') });
  const { facts, activeAgents } = fixture(db.taskProposals);
  const origins = {
    getWorkingGroup: async (id: string) => id === group.id ? group : undefined,
    getMessage: async (id: string) => id === message.id ? message : undefined,
  };
  const createService = (store: TaskProposalStore) => new TaskProposalService({
    store, agents: { agentIsActive: id => activeAgents.has(id) },
    projects: { projectFacts: async id => id === 'project' ? facts : undefined }, origins,
  });
  try {
    let service = createService(db.taskProposals);
    const mutableInput = { ...content, origin: { ...origin } };
    const creating = service.propose('project', agent, mutableInput);
    mutableInput.origin.workingGroupId = 'foreign-group';
    const fromGroup = await creating;
    assert.deepEqual(fromGroup.origin, origin);
    assert.deepEqual((await service.get(fromGroup.id)).origin, origin);
    const directHuman = await service.propose('project', human, content);
    const directAgent = await service.propose('project', agent, content);
    assert.equal(directHuman.origin, null);
    assert.equal(directAgent.origin, null);
    db.close();
    db = new SqliteStore({ filename: join(dir, 'state.sqlite') });
    service = createService(db.taskProposals);
    assert.deepEqual((await service.get(fromGroup.id)).origin, origin);
    assert.equal((await service.get(directHuman.id)).origin, null);
    assert.equal((await service.get(directAgent.id)).origin, null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('foreign or mismatched Working-group and Message provenance is refused', async () => {
  const { store, facts, activeAgents } = fixture();
  const group: WorkingGroupScope = {
    id: 'group-1', projectId: 'project', kind: 'working-group', creatorId: agent.memberId,
    memberships: [{ ...agent, addedAt: 1, addedBy: agent.memberId }], lifecycle: [],
    content: { currentVersion: 1, versions: [{ version: 1, at: 1, actorMemberId: agent.memberId, reason: 'Created', displayName: 'Group', goal: '', rules: [] }] },
    createdAt: 1, updatedAt: 1,
  };
  let message: Message = {
    id: 'message-1', projectId: 'project', scopeId: group.id, channel: 'working-group',
    author: { id: agent.memberId, kind: agent.memberKind }, body: 'Source', recipients: [], deliveryKey: 'source', createdAt: 2,
  };
  const service = new TaskProposalService({
    store, agents: { agentIsActive: id => activeAgents.has(id) },
    projects: { projectFacts: async id => id === 'project' ? facts : undefined },
    origins: {
      getWorkingGroup: async id => id === group.id ? group : undefined,
      getMessage: async id => id === message.id ? message : undefined,
    },
  });
  await assert.rejects(service.propose('project', agent, { ...content, origin: { workingGroupId: 'foreign-group', sourceMessageId: message.id } }), { code: 'invalid-content' });
  message = { ...message, projectId: 'another-project' };
  await assert.rejects(service.propose('project', agent, { ...content, origin: { workingGroupId: group.id, sourceMessageId: message.id } }), { code: 'invalid-content' });
  message = { ...message, projectId: 'project', scopeId: 'foreign-group' };
  await assert.rejects(service.propose('project', agent, { ...content, origin: { workingGroupId: group.id, sourceMessageId: message.id } }), { code: 'invalid-content' });
  assert.deepEqual(await store.listForProject('project'), []);
});
