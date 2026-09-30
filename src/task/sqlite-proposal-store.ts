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
      revision INTEGER NOT NULL CHECK (revision >= 1),
      working_group_id TEXT, source_message_id TEXT
    );
    CREATE INDEX IF NOT EXISTS task_proposals_project ON task_proposals(project_id);`);
    this.#addColumnIfMissing('working_group_id');
    this.#addColumnIfMissing('source_message_id');
  }
  async create(proposal: TaskProposal): Promise<void> {
    const inserted = this.db.prepare(`INSERT INTO task_proposals
      (id, project_id, document, revision, working_group_id, source_message_id)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(proposal.id, proposal.projectId, JSON.stringify(proposal), proposal.revision,
        proposal.origin?.workingGroupId ?? null, proposal.origin?.sourceMessageId ?? null);
    if (inserted.changes !== 1) throw new TaskProposalError('stale-proposal');
  }
  async get(id: string): Promise<TaskProposal | undefined> {
    const row = this.db.prepare(`SELECT document, working_group_id, source_message_id
      FROM task_proposals WHERE id = ?`).get(id) as ProposalRow | undefined;
    return row ? proposalFromRow(row) : undefined;
  }
  async listForProject(projectId: string): Promise<readonly TaskProposal[]> {
    const rows = this.db.prepare(`SELECT document, working_group_id, source_message_id FROM task_proposals
      WHERE project_id = ? ORDER BY json_extract(document, '$.createdAt'), id`).all(projectId) as unknown as ProposalRow[];
    return rows.map(proposalFromRow);
  }
  async change(id: string, expectedRevision: number, mutate: (current: TaskProposal) => TaskProposal): Promise<TaskProposal> {
    // Synchronous read/mutate/CAS: no await permits an interleaving in this process;
    // document + revision fence also protects against a writer on another connection.
    const row = this.db.prepare(`SELECT document, revision, working_group_id, source_message_id
      FROM task_proposals WHERE id = ?`).get(id) as (ProposalRow & { revision: number }) | undefined;
    if (!row) throw new TaskProposalError('unknown-proposal');
    if (row.revision !== expectedRevision) throw new TaskProposalError('stale-proposal');
    const next = mutate(proposalFromRow(row));
    const changed = this.db.prepare(`UPDATE task_proposals
      SET document = ?, revision = ?, working_group_id = ?, source_message_id = ?
      WHERE id = ? AND revision = ? AND document = ?
        AND working_group_id IS ? AND source_message_id IS ?`)
      .run(JSON.stringify(next), next.revision, next.origin?.workingGroupId ?? null,
        next.origin?.sourceMessageId ?? null, id, expectedRevision, row.document, row.working_group_id, row.source_message_id);
    if (changed.changes !== 1) throw new TaskProposalError('stale-proposal');
    return structuredClone(next);
  }
  #addColumnIfMissing(column: 'working_group_id' | 'source_message_id'): void {
    const columns = this.db.prepare('PRAGMA table_info(task_proposals)').all() as unknown as readonly { name: string }[];
    if (!columns.some(existing => existing.name === column)) this.db.exec(`ALTER TABLE task_proposals ADD COLUMN ${column} TEXT;`);
  }
}

interface ProposalRow {
  readonly document: string;
  readonly working_group_id: string | null;
  readonly source_message_id: string | null;
}

function proposalFromRow(row: ProposalRow): TaskProposal {
  const proposal = JSON.parse(row.document) as Omit<TaskProposal, 'origin'> & { readonly origin?: TaskProposal['origin'] };
  if (row.working_group_id === null && row.source_message_id === null) return { ...proposal, origin: null };
  if (row.working_group_id === null || row.source_message_id === null) {
    throw new Error('Task proposal provenance columns are inconsistent');
  }
  return { ...proposal, origin: { workingGroupId: row.working_group_id, sourceMessageId: row.source_message_id } };
}
