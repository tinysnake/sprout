import type { ConnectionFact, CompatibilityFact, EngineReadinessFact, ProbeResultFact } from './readiness.ts';

/**
 * Durable storage for the observed Environment readiness facts (#87).
 *
 * Enrollment decisions are authority facts (see `enrollment-store.ts`); these are
 * the Worker-observed facts that must survive a restart without being recomputed
 * into a different state. The latest observation is a document per environment,
 * and probe results are an append-only history so a newer probe supersedes a
 * value without erasing what was observed before.
 */
export interface ObservedReadiness {
  readonly connection: ConnectionFact;
  readonly compatibility: CompatibilityFact;
  readonly engines: readonly EngineReadinessFact[];
}

export interface EnvironmentReadinessStore {
  saveReadiness(environmentInstanceId: string, observed: ObservedReadiness): Promise<void>;
  getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined>;
  /** Append one probe result, preserving every prior observation. */
  appendProbe(environmentInstanceId: string, probe: ProbeResultFact): Promise<void>;
  listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]>;
}

export class InMemoryEnvironmentReadinessStore implements EnvironmentReadinessStore {
  readonly #readiness = new Map<string, ObservedReadiness>();
  readonly #probes = new Map<string, ProbeResultFact[]>();

  async saveReadiness(environmentInstanceId: string, observed: ObservedReadiness): Promise<void> {
    this.#readiness.set(environmentInstanceId, observed);
  }

  async getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined> {
    return this.#readiness.get(environmentInstanceId);
  }

  async appendProbe(environmentInstanceId: string, probe: ProbeResultFact): Promise<void> {
    const history = this.#probes.get(environmentInstanceId) ?? [];
    history.push(probe);
    this.#probes.set(environmentInstanceId, history);
  }

  async listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]> {
    return [...(this.#probes.get(environmentInstanceId) ?? [])].sort((a, b) => a.at - b.at);
  }
}
