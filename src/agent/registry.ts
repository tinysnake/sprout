/**
 * Agent identity and configuration.
 *
 * An agent is a persistent worker identity owned by Sprout. It names the engine
 * *kinds* its work options run on and the capability its runs must hold, but it
 * does not own either: the engine installation and the environment are
 * independent facts (#7, M1 outcome 4). In particular an agent names **no
 * environment instance** — its run's environment is resolved from the project it
 * is a member of, which is what lets the same agent work across environments
 * (`CONTEXT.md`, O5).
 *
 * Since #90 an agent carries its ordered work options (engine, work model, and
 * effort per option, in priority order) and a configuration version. At run
 * admission the orchestrator takes the first option compatible with the
 * selected Environment's current facts, before any engine accepts the work;
 * it records the option and version it used on the durable run and never
 * replays an accepted run through a lower-priority option (ADR-0008). Nothing
 * here reads from a CLI installation, and no field may carry a host path or an
 * engine credential.
 */

import type { AgentWorkOption } from './model.ts';

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  /**
   * The agent's primary engine kind, resolved to an adapter at run time.
   *
   * This is the first (and definition-era only) work option's engine; ordered
   * options carry their own engine per option since #90.
   */
  readonly engine: string;
  /** The lease-requiring capability this agent's runs must hold. */
  readonly capability: string;
  /** The engine-neutral model this Agent uses, when configured. */
  readonly model?: string;
  /** The engine-neutral reasoning effort this Agent uses, when configured. */
  readonly effort?: string;
  /**
   * The ordered work options (#90, ADR-0008).
   *
   * At least one option is required; the list is evaluated in order at run
   * admission. When absent, the definition's single `engine`/`model`/`effort`
   * is projected as its one option, preserving every pre-#90 definition.
   */
  readonly workOptions?: readonly AgentWorkOption[];
  /**
   * The configuration version this definition was loaded as (#90).
   *
   * Recorded on every run admitted under it so the engine, work model, and
   * effort a run actually used stay historically attributable. Absent on a
   * pre-#90 definition, where the run records version 1.
   */
  readonly configurationVersion?: number;
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
