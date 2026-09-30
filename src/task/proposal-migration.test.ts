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
      assert.equal(current.schemaVersion, 23);
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

test('v22 additive provenance migration explicitly reads historical direct proposals as no-origin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-origin-migration-'));
  try {
    const filename = join(dir, 'state.sqlite');
    const legacy = new DatabaseSync(filename);
    const oldProposal = {
      id: 'legacy-proposal', projectId: 'project', proposer: { memberId: 'operator', memberKind: 'human' },
      status: 'proposed', revision: 1, currentContentVersion: 1,
      versions: [{ title: 'Old', goal: 'Preserved', constraints: [], validationCriteria: [], version: 1,
        actor: { memberId: 'operator', memberKind: 'human' }, at: 1, reason: 'Proposed' }],
      lifecycle: [], createdAt: 1, updatedAt: 1,
    };
    legacy.exec(`CREATE TABLE task_proposals (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1)
    );
    CREATE INDEX task_proposals_project ON task_proposals(project_id);
    PRAGMA user_version = 22;`);
    legacy.prepare('INSERT INTO task_proposals (id, project_id, document, revision) VALUES (?, ?, ?, ?)')
      .run(oldProposal.id, oldProposal.projectId, JSON.stringify(oldProposal), oldProposal.revision);
    legacy.close();

    const current = new SqliteStore({ filename });
    try {
      assert.equal(current.schemaVersion, 23);
      const restored = await current.taskProposals.get(oldProposal.id);
      assert.equal(restored?.origin, null);
      assert.equal(restored?.versions[0]?.goal, 'Preserved');
      assert.equal(current.db.prepare('SELECT working_group_id, source_message_id FROM task_proposals WHERE id = ?').get(oldProposal.id)?.working_group_id, null);
    } finally { current.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
