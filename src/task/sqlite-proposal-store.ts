import type { DatabaseSync } from 'node:sqlite';
import { TaskProposalError, type TaskProposal } from './proposal-model.ts';
import type { TaskProposalStore } from './proposal-store.ts';

/** Mounted on the shared migrated handle. Fresh stores initialize like other domain adapters. */
export class SqliteTaskProposalStore implements TaskProposalStore {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS task_proposals (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1)
    );
    CREATE INDEX IF NOT EXISTS task_proposals_project ON task_proposals(project_id);`);
  }
  async create(proposal: TaskProposal): Promise<void> {
    const inserted = this.db.prepare(`INSERT INTO task_proposals (id, project_id, document, revision)
      VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(proposal.id, proposal.projectId, JSON.stringify(proposal), proposal.revision);
    if (inserted.changes !== 1) throw new TaskProposalError('stale-proposal');
  }
  async get(id: string): Promise<TaskProposal | undefined> {
    const row = this.db.prepare('SELECT document FROM task_proposals WHERE id = ?').get(id) as { document: string } | undefined;
    return row ? JSON.parse(row.document) as TaskProposal : undefined;
  }
  async listForProject(projectId: string): Promise<readonly TaskProposal[]> {
    const rows = this.db.prepare(`SELECT document FROM task_proposals WHERE project_id = ?
      ORDER BY json_extract(document, '$.createdAt'), id`).all(projectId) as unknown as { document: string }[];
    return rows.map(row => JSON.parse(row.document) as TaskProposal);
  }
  async change(id: string, expectedRevision: number, mutate: (current: TaskProposal) => TaskProposal): Promise<TaskProposal> {
    // Synchronous read/mutate/CAS: no await permits an interleaving in this process;
    // document + revision fence also protects against a writer on another connection.
    const row = this.db.prepare('SELECT document, revision FROM task_proposals WHERE id = ?').get(id) as { document: string; revision: number } | undefined;
    if (!row) throw new TaskProposalError('unknown-proposal');
    if (row.revision !== expectedRevision) throw new TaskProposalError('stale-proposal');
    const next = mutate(JSON.parse(row.document) as TaskProposal);
    const changed = this.db.prepare(`UPDATE task_proposals SET document = ?, revision = ?
      WHERE id = ? AND revision = ? AND document = ?`)
      .run(JSON.stringify(next), next.revision, id, expectedRevision, row.document);
    if (changed.changes !== 1) throw new TaskProposalError('stale-proposal');
    return structuredClone(next);
  }
}
