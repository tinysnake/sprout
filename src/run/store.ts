import type { AgentRun } from './model.ts';

/** The latest durable write position for one run snapshot. */
export interface RunReplaySnapshot {
  readonly sequence: number;
  readonly run: AgentRun;
}

/**
 * Durable storage for agent runs.
 *
 * A seam, not a detail of SQLite: the orchestrator never issues a query, and the
 * store can be swapped for the in-memory implementation in tests or for a server
 * database later (ADR-0002).
 */
export interface RunStore {
  /** Persist one state and return its store-wide monotonic write position. */
  save(run: AgentRun): Promise<number>;
  get(runId: string): Promise<AgentRun | undefined>;
  list(): Promise<readonly AgentRun[]>;
  /** Latest state per run, ordered by durable write position. */
  replaySnapshots(): Promise<readonly RunReplaySnapshot[]>;
}

export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<string, AgentRun>();
  readonly #replaySequences = new Map<string, number>();
  #nextReplaySequence = 1;
  /** Every state this store was ever asked to persist, in order. */
  readonly writes: AgentRun[] = [];

  async save(run: AgentRun): Promise<number> {
    const sequence = this.#nextReplaySequence++;
    this.#runs.set(run.id, run);
    this.#replaySequences.set(run.id, sequence);
    this.writes.push(run);
    return sequence;
  }

  async get(runId: string): Promise<AgentRun | undefined> {
    return this.#runs.get(runId);
  }

  async list(): Promise<readonly AgentRun[]> {
    return [...this.#runs.values()];
  }

  async replaySnapshots(): Promise<readonly RunReplaySnapshot[]> {
    return [...this.#runs.values()]
      .map((run) => ({ run, sequence: this.#replaySequences.get(run.id)! }))
      .sort((left, right) => left.sequence - right.sequence);
  }
}
