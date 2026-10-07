import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store/db.ts';
import { InMemoryTaskProposalStore, type TaskProposalStore } from './proposal-store.ts';
import { TaskProposalService } from './proposal-service.ts';
import type { TaskProposal } from './proposal-model.ts';

test('memory and SQLite storage obey atomic revision fencing, failure rollback, and snapshot isolation', async () => {
  const sqlite = new SqliteStore({ filename: ':memory:' });
  try {
    const stores: TaskProposalStore[] = [new InMemoryTaskProposalStore(), sqlite.taskProposals];
    for (const store of stores) {
      const service = new TaskProposalService({ store, agents: { agentIsActive: () => true }, projects: { projectFacts: async () => ({
        projectId: 'project', status: 'active', contentVersion: 1, goal: '', rules: [],
        members: [{ memberId: 'operator', memberKind: 'human' }],
      }) } });
      const proposal = await service.propose('project', { memberId: 'operator', memberKind: 'human' },
        { title: 'Task', goal: 'Prove contract', constraints: [], validationCriteria: [] });
      await assert.rejects(store.create(proposal), { code: 'stale-proposal' });
      await assert.rejects(store.change(proposal.id, 1, () => { throw new Error('write failed'); }), /write failed/);
      assert.deepEqual(await store.get(proposal.id), proposal);
      const stale = await store.get(proposal.id) as TaskProposal;
      const revised = await service.revise(proposal.id, proposal.proposer, {
        title: 'Task', goal: 'Revised', constraints: [], validationCriteria: [], expectedRevision: 1, reason: 'Narrow scope',
      });
      await assert.rejects(store.change(proposal.id, stale.revision, () => stale), { code: 'stale-proposal' });
      assert.deepEqual(await store.get(proposal.id), revised);
      const listed = await store.listForProject('project');
      (listed[0]!.versions[0]!.constraints as string[]).push('Mutation');
      assert.deepEqual((await store.get(proposal.id))!.versions[0]!.constraints, []);
    }
  } finally { sqlite.close(); }
});
