import type {
  ConnectionFact,
  CompatibilityFact,
  EngineReadinessFact,
  ProbeResultFact,
  ReadinessReceipt,
  ReadinessRequirementScope,
} from './readiness.ts';
import { readReadinessObservation, type ReadinessObservation } from './readiness-observation.ts';
import type { ReadinessObservationAuthority } from './readiness-authority.ts';
export type { ReadinessObservation } from './readiness-observation.ts';
export type { ReadinessObservationAuthority } from './readiness-authority.ts';
export type { ReadinessReceipt, ReadinessRequirementScope } from './readiness.ts';

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
  /** The opaque non-sensitive observation identity (#126). */
  readonly observationId?: string;
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

/** One durable, canonically validated observation with its receipt and provenance (#126). */
export interface StoredReadinessObservation {
  readonly observationId: string;
  readonly environmentInstanceId: string;
  readonly enrollmentId?: string | undefined;
  readonly connectionEpoch?: number | undefined;
  readonly sequence: number;
  readonly committedAt: number;
  readonly readiness: ObservedReadiness;
  readonly probe: ProbeResultFact;
  readonly receipt: ReadinessReceipt;
  readonly authorityScope: import('./readiness-observation.ts').ReadinessAuthorityScope;
  readonly requirements?: ReadinessRequirementScope | undefined;
}

/** Parameters for querying historical observation records (#126). */
export interface ReadinessHistoricalQuery {
  readonly enrollmentId?: string;
  readonly connectionEpoch?: number;
  readonly limit?: number;
}

export interface EnvironmentReadinessStore {
  /**
   * Commit only an opaque, canonically validated readiness + required probe pair.
   *
   * The exact authority object is bound when the observation is created. Adapters
   * must call readReadinessObservation immediately before mutation; raw/forged
   * objects, a changed scope, or a stale authority leave both documents untouched.
   * Returns the committed receipt on success, or false on refusal (#126).
   */
  commitObservation(
    environmentInstanceId: string,
    observation: ReadinessObservation,
    authority: ReadinessWriteAuthority,
  ): Promise<ReadinessReceipt | false>;
  getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined>;
  listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]>;
  getCurrentObservation(
    environmentInstanceId: string,
  ): Promise<StoredReadinessObservation | undefined>;
  getObservation(
    environmentInstanceId: string,
    observationId: string,
  ): Promise<StoredReadinessObservation | undefined>;
  getReceipt(
    environmentInstanceId: string,
    observationId: string,
  ): Promise<ReadinessReceipt | undefined>;
  listObservations(
    environmentInstanceId: string,
    query?: ReadinessHistoricalQuery,
  ): Promise<readonly StoredReadinessObservation[]>;
}

export class InMemoryEnvironmentReadinessStore implements EnvironmentReadinessStore {
  readonly #readiness = new Map<string, ObservedReadiness>();
  readonly #probes = new Map<string, ProbeResultFact[]>();
  readonly #observations = new Map<string, StoredReadinessObservation>();
  readonly #instanceObservations = new Map<string, string[]>();
  readonly #currentObservations = new Map<string, string>();
  readonly #sequences = new Map<string, number>();

  async commitObservation(
    environmentInstanceId: string,
    observation: ReadinessObservation,
    authority: ReadinessWriteAuthority,
  ): Promise<ReadinessReceipt | false> {
    const pair = readReadinessObservation(environmentInstanceId, observation, authority);
    if (pair === undefined) return false;

    // JavaScript's run-to-completion rule makes this an atomic in-memory commit.
    const sequence = (this.#sequences.get(environmentInstanceId) ?? 0) + 1;
    this.#sequences.set(environmentInstanceId, sequence);
    const committedAt = Date.now();

    const receipt: ReadinessReceipt = {
      observationId: pair.observationId,
      environmentInstanceId,
      enrollmentId: pair.readiness.enrollmentId!,
      connectionEpoch: pair.readiness.connectionEpoch!,
      sequence,
      committedAt,
      probe: pair.probe,
      authorityScope: pair.authorityScope,
      readiness: pair.readiness,
      at: pair.probe.at,
      latencyMs: pair.probe.latencyMs,
      protocolOk: pair.probe.protocolOk,
      enginesOk: pair.probe.enginesOk,
      summary: pair.probe.summary,
      ...(pair.probe.source !== undefined ? { source: pair.probe.source } : {}),
      ...(pair.probe.version !== undefined ? { version: pair.probe.version } : {}),
      ...(pair.requirements !== undefined ? { requirements: pair.requirements } : {}),
    };

    const storedObservation: StoredReadinessObservation = {
      observationId: pair.observationId,
      environmentInstanceId,
      enrollmentId: pair.readiness.enrollmentId,
      connectionEpoch: pair.readiness.connectionEpoch,
      sequence,
      committedAt,
      readiness: pair.readiness,
      probe: pair.probe,
      receipt,
      authorityScope: pair.authorityScope,
      ...(pair.requirements !== undefined ? { requirements: pair.requirements } : {}),
    };

    this.#observations.set(pair.observationId, structuredClone(storedObservation));
    const instObs = this.#instanceObservations.get(environmentInstanceId) ?? [];
    instObs.push(pair.observationId);
    this.#instanceObservations.set(environmentInstanceId, instObs);

    this.#currentObservations.set(environmentInstanceId, pair.observationId);
    this.#readiness.set(environmentInstanceId, structuredClone(pair.readiness));

    const history = this.#probes.get(environmentInstanceId) ?? [];
    history.push(structuredClone(pair.probe));
    this.#probes.set(environmentInstanceId, history);

    return structuredClone(receipt);
  }

  async getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined> {
    return structuredClone(this.#readiness.get(environmentInstanceId));
  }

  async listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]> {
    return structuredClone(this.#probes.get(environmentInstanceId) ?? []).sort((a, b) => a.at - b.at);
  }

  async getCurrentObservation(
    environmentInstanceId: string,
  ): Promise<StoredReadinessObservation | undefined> {
    const observationId = this.#currentObservations.get(environmentInstanceId);
    if (observationId === undefined) return undefined;
    return structuredClone(this.#observations.get(observationId));
  }

  async getObservation(
    environmentInstanceId: string,
    observationId: string,
  ): Promise<StoredReadinessObservation | undefined> {
    const obs = this.#observations.get(observationId);
    if (obs === undefined || obs.environmentInstanceId !== environmentInstanceId) return undefined;
    return structuredClone(obs);
  }

  async getReceipt(
    environmentInstanceId: string,
    observationId: string,
  ): Promise<ReadinessReceipt | undefined> {
    const obs = await this.getObservation(environmentInstanceId, observationId);
    return obs ? structuredClone(obs.receipt) : undefined;
  }

  async listObservations(
    environmentInstanceId: string,
    query?: ReadinessHistoricalQuery,
  ): Promise<readonly StoredReadinessObservation[]> {
    const ids = this.#instanceObservations.get(environmentInstanceId) ?? [];
    const results: StoredReadinessObservation[] = [];
    for (const id of ids) {
      const obs = this.#observations.get(id);
      if (!obs) continue;
      if (query?.enrollmentId !== undefined && obs.enrollmentId !== query.enrollmentId) continue;
      if (query?.connectionEpoch !== undefined && obs.connectionEpoch !== query.connectionEpoch) continue;
      results.push(structuredClone(obs));
      if (query?.limit !== undefined && results.length >= query.limit) break;
    }
    return results;
  }
}
