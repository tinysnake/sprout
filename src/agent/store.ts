import type { Agent } from './model.ts';

/**
 * Durable storage for portable Agent identities (#90).
 *
 * A seam, not a SQLite detail (ADR-0002): the Agent service reads and writes
 * through this interface, so the same rules run over the in-memory adapter in
 * tests and the SQLite adapter in production. The record is stored as one JSON
 * document keyed by the Agent's stable id — including its append-only
 * configuration history — the same way an enrollment is, because the versions
 * belong to the identity as a whole and must never be rewritten piecemeal.
 *
 * There is deliberately no delete: archiving is a status (ADR-0008), so the
 * only removal this seam supports is a caller dropping the store itself.
 */
export interface AgentStore {
  save(agent: Agent): Promise<void>;
  get(agentId: string): Promise<Agent | undefined>;
  list(): Promise<readonly Agent[]>;
}

export class InMemoryAgentStore implements AgentStore {
  readonly #agents = new Map<string, Agent>();

  async save(agent: Agent): Promise<void> {
    this.#agents.set(agent.id, agent);
  }

  async get(agentId: string): Promise<Agent | undefined> {
    return this.#agents.get(agentId);
  }

  async list(): Promise<readonly Agent[]> {
    return [...this.#agents.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}
