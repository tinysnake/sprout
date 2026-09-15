/**
 * Agent identity and configuration.
 *
 * An agent is a persistent worker identity owned by Sprout. It names the engine
 * *kind* it runs on and the capability its runs must hold, but it does not own
 * either: the engine installation and the environment are independent facts
 * (#7, M1 outcome 4). In particular an agent names **no environment instance** —
 * its run's environment is resolved from the project it is a member of, which is
 * what lets the same agent work across environments (`CONTEXT.md`, O5).
 * Nothing here reads from a CLI installation.
 */

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  /** The engine kind, resolved to an adapter at run time. */
  readonly engine: string;
  /** The lease-requiring capability this agent's runs must hold. */
  readonly capability: string;
  /** The engine-neutral model this Agent uses, when configured. */
  readonly model?: string;
  /** The engine-neutral reasoning effort this Agent uses, when configured. */
  readonly effort?: string;
  /**
   * A fallback working directory for runs whose resolved instance declares none.
   *
   * The directory is a fact about the environment (ADR-0003), so an instance's
   * own `workingDirectory` wins when it has one; this exists only for
   * environments that cannot state it. An agent therefore names no single path
   * it is pinned to.
   */
  readonly workingDirectory?: string;
  /**
   * The agent's own standing configuration, woven into the project contract.
   *
   * This is not the whole contract any more: the orchestrator assembles the
   * contract from the project plus this value and hands the result to the engine
   * as its standing instructions (O5, `src/project/contract.ts`).
   */
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
