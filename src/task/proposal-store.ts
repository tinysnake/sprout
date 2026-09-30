import { TaskProposalError, type TaskProposal } from './proposal-model.ts';

/**
 * Storage owns atomic optimistic revision fencing; service owns authority and transitions.
 * Copies isolate callers and already admitted run snapshots. No save/delete escape hatch.
 */
export interface TaskProposalStore {
  create(proposal: TaskProposal): Promise<void>;
  get(id: string): Promise<TaskProposal | undefined>;
  listForProject(projectId: string): Promise<readonly TaskProposal[]>;
  change(id: string, expectedRevision: number, mutate: (current: TaskProposal) => TaskProposal): Promise<TaskProposal>;
}
export class InMemoryTaskProposalStore implements TaskProposalStore {
  readonly #records = new Map<string, TaskProposal>();
  async create(proposal: TaskProposal): Promise<void> {
    if (this.#records.has(proposal.id)) throw new TaskProposalError('stale-proposal');
    this.#records.set(proposal.id, structuredClone(proposal));
  }
  async get(id: string): Promise<TaskProposal | undefined> {
    const record = this.#records.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }
  async listForProject(projectId: string): Promise<readonly TaskProposal[]> {
    return structuredClone([...this.#records.values()].filter(p => p.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
  }
  async change(id: string, expectedRevision: number, mutate: (current: TaskProposal) => TaskProposal): Promise<TaskProposal> {
    const prior = this.#records.get(id);
    if (!prior) throw new TaskProposalError('unknown-proposal');
    if (prior.revision !== expectedRevision) throw new TaskProposalError('stale-proposal');
    const next = mutate(structuredClone(prior));
    if (this.#records.get(id) !== prior) throw new TaskProposalError('stale-proposal');
    this.#records.set(id, structuredClone(next));
    return structuredClone(next);
  }
}
