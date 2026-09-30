import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../store/db.ts';
import { TaskProposalService } from './proposal-service.ts';

test('v21 forward migration keeps old durable facts and creates proposals behind a safety copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-migration-'));
  try {
    const filename = join(dir, 'state.sqlite');
    const legacy = new DatabaseSync(filename);
    legacy.exec("CREATE TABLE existing_facts (fact TEXT); INSERT INTO existing_facts VALUES ('Preserved'); PRAGMA user_version = 21;");
    legacy.close();
    const current = new SqliteStore({ filename });
    try {
      assert.equal(current.schemaVersion, 22);
      assert.ok(existsSync(`${filename}.safety-copy`));
      assert.equal(current.db.prepare('SELECT fact FROM existing_facts').get()!.fact, 'Preserved');
      const service = new TaskProposalService({ store: current.taskProposals, agents: { agentIsActive: () => true }, projects: { projectFacts: async () => ({
        projectId: 'project', status: 'active', contentVersion: 1, goal: '', rules: [], members: [{ memberId: 'operator', memberKind: 'human' }],
      }) } });
      const proposal = await service.propose('project', { memberId: 'operator', memberKind: 'human' }, { title: 'Task', goal: 'Migrated', constraints: [], validationCriteria: [] });
      assert.equal((await service.get(proposal.id)).versions[0]?.goal, 'Migrated');
    } finally { current.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
