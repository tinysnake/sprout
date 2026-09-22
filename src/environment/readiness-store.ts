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
  /**
   * The durable enrollment authority whose accepted Worker produced these facts.
   *
   * Readiness documents are keyed by Environment instance for inspection, but
   * a new enrollment may never inherit another enrollment's observations merely
   * because their per-enrollment epoch numbers happen to be equal. Older
   * unscoped documents remain inspectable and deliberately cannot admit work.
   */
  readonly enrollmentId?: string;
  /**
   * The accepted Worker connection epoch that produced these facts.
   *
   * Older rows have no epoch and remain inspectable, but cannot establish
   * admission for a live enrolled Worker. This is deliberately optional for
   * additive reads of pre-E2 records; catalog admission requires an exact match
   * with its current epoch.
   */
  readonly connectionEpoch?: number;
  readonly connection: ConnectionFact;
  readonly compatibility: CompatibilityFact;
  readonly engines: readonly EngineReadinessFact[];
}

/**
 * A live authority fence evaluated by the store immediately before mutation.
 *
 * Checking before an asynchronous store call is insufficient: a replacement
 * Worker can be accepted while that call is suspended.  The store owns this
 * final check so a stale epoch cannot cross the check/write boundary.
 */
export interface ReadinessWriteGuard {
  readonly isCurrent?: () => boolean;
}

export interface EnvironmentReadinessStore {
  saveReadiness(
    environmentInstanceId: string,
    observed: ObservedReadiness,
    guard?: ReadinessWriteGuard,
  ): Promise<boolean>;
  getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined>;
  /** Append one probe result, preserving every prior observation. */
  appendProbe(
    environmentInstanceId: string,
    probe: ProbeResultFact,
    guard?: ReadinessWriteGuard,
  ): Promise<boolean>;
  listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]>;
}

export class InMemoryEnvironmentReadinessStore implements EnvironmentReadinessStore {
  readonly #readiness = new Map<string, ObservedReadiness>();
  readonly #probes = new Map<string, ProbeResultFact[]>();

  async saveReadiness(
    environmentInstanceId: string,
    observed: ObservedReadiness,
    guard: ReadinessWriteGuard = {},
  ): Promise<boolean> {
    if (guard.isCurrent !== undefined && !guard.isCurrent()) return false;
    this.#readiness.set(environmentInstanceId, observed);
    return true;
  }

  async getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined> {
    return this.#readiness.get(environmentInstanceId);
  }

  async appendProbe(
    environmentInstanceId: string,
    probe: ProbeResultFact,
    guard: ReadinessWriteGuard = {},
  ): Promise<boolean> {
    if (guard.isCurrent !== undefined && !guard.isCurrent()) return false;
    const history = this.#probes.get(environmentInstanceId) ?? [];
    history.push(probe);
    this.#probes.set(environmentInstanceId, history);
    return true;
  }

  async listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]> {
    return [...(this.#probes.get(environmentInstanceId) ?? [])].sort((a, b) => a.at - b.at);
  }
}
