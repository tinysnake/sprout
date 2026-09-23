import type { ConnectionFact, CompatibilityFact, EngineReadinessFact, ProbeResultFact } from './readiness.ts';
import { readReadinessObservation, type ReadinessObservation } from './readiness-observation.ts';
import type { ReadinessObservationAuthority } from './readiness-authority.ts';
export type { ReadinessObservation } from './readiness-observation.ts';
export type { ReadinessObservationAuthority } from './readiness-authority.ts';

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
 * An owner-issued scoped capability evaluated by the store immediately before
 * its one atomic mutation (#125).
 *
 * Checking before an asynchronous store call is insufficient: a replacement
 * Worker can be accepted while that call is suspended. The store owns this
 * final synchronous check so a stale epoch or forged capability cannot cross
 * the mutation boundary.
 */
export type ReadinessWriteAuthority = ReadinessObservationAuthority;

export interface EnvironmentReadinessStore {
  /**
   * Commit only an opaque, canonically validated readiness + required probe pair.
   *
   * The exact authority object is bound when the observation is created. Adapters
   * must call readReadinessObservation immediately before mutation; raw/forged
   * objects, a changed scope, or a stale authority leave both documents untouched.
   */
  commitObservation(
    environmentInstanceId: string,
    observation: ReadinessObservation,
    authority: ReadinessWriteAuthority,
  ): Promise<boolean>;
  getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined>;
  listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]>;
}

export class InMemoryEnvironmentReadinessStore implements EnvironmentReadinessStore {
  readonly #readiness = new Map<string, ObservedReadiness>();
  readonly #probes = new Map<string, ProbeResultFact[]>();

  async commitObservation(
    environmentInstanceId: string,
    observation: ReadinessObservation,
    authority: ReadinessWriteAuthority,
  ): Promise<boolean> {
    const pair = readReadinessObservation(environmentInstanceId, observation, authority);
    if (pair === undefined) return false;
    // No await may separate this check from these mutations. JavaScript's
    // run-to-completion rule makes readiness + probe one in-memory commit.
    this.#readiness.set(environmentInstanceId, pair.readiness);
    const history = this.#probes.get(environmentInstanceId) ?? [];
    history.push(pair.probe);
    this.#probes.set(environmentInstanceId, history);
    return true;
  }

  async getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined> {
    return structuredClone(this.#readiness.get(environmentInstanceId));
  }

  async listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]> {
    return structuredClone(this.#probes.get(environmentInstanceId) ?? []).sort((a, b) => a.at - b.at);
  }
}
