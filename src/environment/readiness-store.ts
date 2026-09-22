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
 * A live accepted-connection authority fence evaluated by the store immediately
 * before its one atomic mutation.
 *
 * Checking before an asynchronous store call is insufficient: a replacement
 * Worker can be accepted while that call is suspended.  The store owns this
 * final check so a stale epoch cannot cross the check/write boundary.
 */
export interface ReadinessWriteAuthority {
  readonly enrollmentId: string;
  readonly connectionEpoch: number;
  readonly isCurrent: () => boolean;
}

/** One all-or-nothing durable observation from an accepted Worker epoch. */
export interface ReadinessObservation {
  readonly readiness: ObservedReadiness;
  readonly probe?: ProbeResultFact;
}

export interface EnvironmentReadinessStore {
  /**
   * Replace readiness and optionally append its probe as one atomic commit.
   *
   * The authority is mandatory. Implementations must evaluate it immediately
   * before mutation and leave both documents untouched when it is stale.
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
    if (!validAuthority(observation, authority) || !authority.isCurrent()) return false;
    // No await may separate this check from these mutations. JavaScript's
    // run-to-completion rule makes readiness + probe one in-memory commit.
    this.#readiness.set(environmentInstanceId, observation.readiness);
    if (observation.probe !== undefined) {
      const history = this.#probes.get(environmentInstanceId) ?? [];
      history.push(observation.probe);
      this.#probes.set(environmentInstanceId, history);
    }
    return true;
  }

  async getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined> {
    return this.#readiness.get(environmentInstanceId);
  }

  async listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]> {
    return [...(this.#probes.get(environmentInstanceId) ?? [])].sort((a, b) => a.at - b.at);
  }
}

/** Refuse a store caller that tries to mix facts from two authority epochs. */
export function validAuthority(
  observation: ReadinessObservation,
  authority: ReadinessWriteAuthority,
): boolean {
  const { readiness, probe } = observation;
  return Number.isSafeInteger(authority.connectionEpoch) && authority.connectionEpoch > 0 &&
    readiness.enrollmentId === authority.enrollmentId &&
    readiness.connectionEpoch === authority.connectionEpoch &&
    (probe === undefined || (
      probe.enrollmentId === authority.enrollmentId &&
      probe.connectionEpoch === authority.connectionEpoch &&
      // Store adapters are the last durable boundary. A raw/bypassing caller
      // may omit provenance, but no runtime value other than exact `worker`
      // may ever become durable probe source text (R118-BOUNDARY-003).
      (probe.source === undefined || probe.source === 'worker')
    ));
}
