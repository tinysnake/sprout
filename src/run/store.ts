import type { AgentRun } from './model.ts';

/**
 * Durable storage for agent runs.
 *
 * A seam, not a detail of SQLite: the orchestrator never issues a query, and the
 * store can be swapped for the in-memory implementation in tests or for a server
 * database later (ADR-0002).
 */
export interface RunStore {
  save(run: AgentRun): Promise<void>;
  get(runId: string): Promise<AgentRun | undefined>;
  list(): Promise<readonly AgentRun[]>;
}

export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<string, AgentRun>();
  /** Every state this store was ever asked to persist, in order. */
  readonly writes: AgentRun[] = [];

  async save(run: AgentRun): Promise<void> {
    this.#runs.set(run.id, run);
    this.writes.push(run);
  }

  async get(runId: string): Promise<AgentRun | undefined> {
    return this.#runs.get(runId);
  }

  async list(): Promise<readonly AgentRun[]> {
    return [...this.#runs.values()];
  }
}
