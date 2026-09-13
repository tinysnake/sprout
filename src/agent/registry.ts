/**
 * Agent identity and configuration.
 *
 * An agent is a persistent worker identity owned by Sprout. It names the engine
 * *kind* it runs on and the environment instance it is scheduled to, but it does
 * not own either: the engine installation and the environment are independent
 * facts (#7, M1 outcome 4). Nothing here reads from a CLI installation.
 */

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  /** The engine kind, resolved to an adapter at run time. */
  readonly engine: string;
  readonly environmentInstanceId: string;
  /** The lease-requiring capability this agent's runs must hold. */
  readonly capability: string;
  /** The working directory for runs inside that environment. */
  readonly workingDirectory: string;
  /** Standing instructions assembled by the project contract. */
  readonly instructions?: string;
}

export class AgentRegistry {
  readonly #agents = new Map<string, AgentDefinition>();

  constructor(agents: readonly AgentDefinition[]) {
    for (const agent of agents) this.#agents.set(agent.id, agent);
  }

  get(agentId: string): AgentDefinition | undefined {
    return this.#agents.get(agentId);
  }

  list(): readonly AgentDefinition[] {
    return [...this.#agents.values()];
  }
}
