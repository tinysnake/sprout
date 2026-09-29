import type {
  ConnectionFact,
  CompatibilityFact,
  EngineReadinessFact,
  ProbeResultFact,
  ModelAuthorizationFact,
  ReadinessReceipt,
  ReadinessRequirementScope,
} from './readiness.ts';
import { readReadinessObservation, type ReadinessObservation } from './readiness-observation.ts';
import type { ReadinessObservationAuthority } from './readiness-authority.ts';
export type { ReadinessObservation } from './readiness-observation.ts';
export type { ReadinessObservationAuthority } from './readiness-authority.ts';
export type { ReadinessReceipt, ReadinessRequirementScope } from './readiness.ts';

/**
 * Durable storage for the observed Environment readiness facts (#87) and
 * independent Human model authorization decisions (#138).
 *
 * Enrollment decisions are authority facts (see `enrollment-store.ts`). Worker
 * observations and probe receipts are immutable measured facts. The readiness
 * document is a current projection that can also carry independently recorded
 * authorization; neither authorization nor its revocation changes an observation.
 */
export interface ObservedReadiness {
  readonly requirements?: ReadinessRequirementScope;
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
  readonly workerObservedAt?: number;
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

/** A Human decision, never a Worker observation or probe receipt. Empty snapshots revoke current authority. */
export interface ModelAuthorizationEvidence {
  readonly evidenceId: string;
  readonly environmentInstanceId: string;
  readonly recordedAt: number;
  readonly enrollmentId?: string;
  readonly requirements?: ReadinessRequirementScope;
  readonly authorizations: readonly ModelAuthorizationFact[];
}

export function withModelAuthorizations(
  existing: ObservedReadiness | undefined,
  authorizations: readonly ModelAuthorizationFact[],
  context?: { readonly enrollmentId?: string; readonly connectionEpoch?: number; readonly requirements?: ReadinessRequirementScope },
): ObservedReadiness {
  const existingEngines = existing?.engines ?? [];
  const names = new Set([...existingEngines.map((e) => e.engine), ...authorizations.map((a) => a.engine)]);
  const engines = [...names].map((name) => {
    const previous = existingEngines.find((e) => e.engine === name);
    return {
      ...(previous ?? { engine: name, installed: false, readiness: 'unknown' as const,
        required: false, models: { state: 'unknown' as const, models: [] } }),
      modelAuthorizations: authorizations.filter((a) => a.engine === name),
    };
  });
  // A model authorization is a Human decision about usable models, not an
  // observation: attaching authorizations to an existing document must never
  // rebrand another enrollment's committed facts as this enrollment's
  // authority (#162). A new enrollment may never inherit another enrollment's
  // observations merely because its approval happened to run later; only an
  // unscoped or already-owned document takes the caller's enrollment/epoch.
  const foreignObservation =
    existing?.enrollmentId !== undefined &&
    context?.enrollmentId !== undefined &&
    existing.enrollmentId !== context.enrollmentId;
  return {
    ...(existing ?? { connection: { state: 'never-connected' }, compatibility: { state: 'unknown' } }),
    engines,
    ...(context?.requirements !== undefined ? { requirements: context.requirements } : {}),
    ...(!foreignObservation && context?.enrollmentId !== undefined ? { enrollmentId: context.enrollmentId } : {}),
    ...(!foreignObservation && context?.connectionEpoch !== undefined ? { connectionEpoch: context.connectionEpoch } : {}),
  };
}

export interface EnvironmentReadinessStore {
  /** Reserve a durable issue order before asking the Worker to collect facts. */
  issueAttempt(environmentInstanceId: string, authority: ReadinessWriteAuthority, bootstrap?: boolean, requiredModels?: readonly string[], requirements?: ReadinessRequirementScope): Promise<ReadinessAttempt | false>;
  getAttempt(environmentInstanceId: string, observationId: string): Promise<ReadinessAttempt | undefined>;
  /**
   * Commit only an opaque, canonically validated readiness + required probe pair.
   *
   * The exact authority object is bound when the observation is created. Adapters
   * must call readReadinessObservation immediately before mutation; raw/forged
   * objects, a changed scope, or a stale authority leave both documents untouched.
   * Returns the committed receipt on success, or false on refusal (#126).
   * For issued attempts, adapters fence against later committed issue order;
   * Worker timestamps are never ordering keys. Exact redelivery returns the
   * original receipt; conflicting content is refused without mutation.
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
  listModelAuthorizationEvidence(environmentInstanceId: string): Promise<readonly ModelAuthorizationEvidence[]>;
  recordModelAuthorizations(
    environmentInstanceId: string,
    authorizations: readonly import('./readiness.ts').ModelAuthorizationFact[],
    context?: {
      readonly enrollmentId?: string;
      readonly connectionEpoch?: number;
      readonly lifecycleGeneration?: number;
      /** Synchronous fence checked by the store immediately before mutation. */
      readonly isCurrent?: () => boolean;
      readonly connectionId?: string;
      readonly requirements?: ReadinessRequirementScope;
      readonly actor?: string;
    },
  ): Promise<void>;
}

export interface ReadinessAttempt {
  readonly observationId: string;
  readonly sequence: number;
  readonly environmentInstanceId: string;
  readonly enrollmentId: string;
  readonly connectionEpoch: number;
  readonly connectionId: string;
  readonly lifecycleGeneration: number;
  readonly requiredModels?: readonly string[];
  readonly requirements?: ReadinessRequirementScope;
}

export function attemptMatches(attempt: ReadinessAttempt, authority: ReadinessWriteAuthority, instance: string): boolean {
  return attempt.environmentInstanceId === instance && attempt.enrollmentId === authority.enrollmentId &&
    attempt.connectionEpoch === authority.connectionEpoch && attempt.connectionId === authority.connectionId &&
    attempt.lifecycleGeneration === authority.lifecycleGeneration && Number.isSafeInteger(attempt.sequence) && attempt.sequence > 0;
}

/** The core observation clock is not Worker content on a redelivery. */
export function sameObservationContent(left: ObservedReadiness, right: ObservedReadiness): boolean {
  const withoutClock = (value: ObservedReadiness) => ({ ...value, connection: { ...value.connection, lastConfirmedAt: undefined } });
  return JSON.stringify(withoutClock(left)) === JSON.stringify(withoutClock(right));
}

export class InMemoryEnvironmentReadinessStore implements EnvironmentReadinessStore {
  readonly #readiness = new Map<string, ObservedReadiness>();
  readonly #probes = new Map<string, ProbeResultFact[]>();
  readonly #observations = new Map<string, StoredReadinessObservation>();
  readonly #instanceObservations = new Map<string, string[]>();
  readonly #currentObservations = new Map<string, string>();
  readonly #sequences = new Map<string, number>();
  readonly #issued = new Map<string, ReadinessAttempt>();
  readonly #bootstraps = new Map<string, ReadinessAttempt>();
  readonly #authorizationEvidence = new Map<string, ModelAuthorizationEvidence[]>();

  async issueAttempt(instance: string, authority: ReadinessWriteAuthority, bootstrap = false, requiredModels: readonly string[] = [], requirements?: ReadinessRequirementScope): Promise<ReadinessAttempt | false> {
    if (!authority.isCurrent() || authority.environmentInstanceId !== instance) return false;
    const key = JSON.stringify([instance, authority.enrollmentId, authority.connectionId, requirements ?? requiredModels]);
    if (bootstrap && this.#bootstraps.has(key)) return structuredClone(this.#bootstraps.get(key)!);
    const sequence = (this.#sequences.get(instance) ?? 0) + 1;
    this.#sequences.set(instance, sequence);
    const attempt = { observationId: `obs-${crypto.randomUUID()}`, sequence, environmentInstanceId: instance,
      enrollmentId: authority.enrollmentId, connectionEpoch: authority.connectionEpoch,
      connectionId: authority.connectionId, lifecycleGeneration: authority.lifecycleGeneration, requiredModels: [...requiredModels],
      ...(requirements !== undefined ? { requirements: structuredClone(requirements) } : {}) };
    this.#issued.set(attempt.observationId, attempt);
    if (bootstrap) this.#bootstraps.set(key, attempt);
    return structuredClone(attempt);
  }

  async getAttempt(instance: string, id: string): Promise<ReadinessAttempt | undefined> {
    const attempt = this.#issued.get(id);
    return attempt?.environmentInstanceId === instance ? structuredClone(attempt) : undefined;
  }

  async commitObservation(
    environmentInstanceId: string,
    observation: ReadinessObservation,
    authority: ReadinessWriteAuthority,
  ): Promise<ReadinessReceipt | false> {
    const pair = readReadinessObservation(environmentInstanceId, observation, authority);
    if (pair === undefined) return false;

    // JavaScript's run-to-completion rule makes this an atomic in-memory commit.
    const issued = this.#issued.get(pair.observationId);
    if (!pair.attempt || !issued || !attemptMatches(issued, authority, environmentInstanceId) ||
        issued.sequence !== pair.attempt.sequence ||
        JSON.stringify(issued.requirements) !== JSON.stringify(pair.requirements) ||
        JSON.stringify(issued.requiredModels) !== JSON.stringify(pair.attempt.requiredModels) ||
        JSON.stringify(issued.requirements) !== JSON.stringify(pair.attempt.requirements)) return false;
    const previous = this.#observations.get(pair.observationId);
    if (previous) return previous.workerObservedAt === pair.workerObservedAt &&
      sameObservationContent(previous.readiness, pair.readiness) &&
      JSON.stringify(previous.probe) === JSON.stringify(pair.probe) ? structuredClone(previous.receipt) : false;
    const current = this.#currentObservations.get(environmentInstanceId);
    if (pair.attempt && current && this.#observations.get(current)!.sequence > pair.attempt.sequence) return false;
    const sequence = pair.attempt?.sequence ?? (this.#sequences.get(environmentInstanceId) ?? 0) + 1;
    this.#sequences.set(environmentInstanceId, Math.max(this.#sequences.get(environmentInstanceId) ?? 0, sequence));
    const committedAt = Date.now();

    const previousReadiness = this.#readiness.get(environmentInstanceId);
    const authorizations = previousReadiness?.engines.flatMap((e) => e.modelAuthorizations ?? []).filter((a) =>
      a.requirementRevision === undefined || a.requirementRevision ===
        (pair.requirements?.revisionsByEngine?.[a.engine] ?? pair.requirements?.revision)) ?? [];
    // Receipts and observations contain only the Worker pair; authorization is a separate decision.
    const effectiveReadiness = pair.readiness;

    const receipt: ReadinessReceipt = {
      observationId: pair.observationId,
      environmentInstanceId,
      enrollmentId: effectiveReadiness.enrollmentId!,
      connectionEpoch: effectiveReadiness.connectionEpoch!,
      sequence,
      committedAt,
      probe: pair.probe,
      authorityScope: pair.authorityScope,
      readiness: effectiveReadiness,
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
      ...(pair.workerObservedAt !== undefined ? { workerObservedAt: pair.workerObservedAt } : {}),
      observationId: pair.observationId,
      environmentInstanceId,
      enrollmentId: effectiveReadiness.enrollmentId,
      connectionEpoch: effectiveReadiness.connectionEpoch,
      sequence,
      committedAt,
      readiness: effectiveReadiness,
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
    this.#readiness.set(environmentInstanceId, structuredClone(withModelAuthorizations(effectiveReadiness, authorizations)));

    const history = this.#probes.get(environmentInstanceId) ?? [];
    history.push(structuredClone(pair.probe));
    this.#probes.set(environmentInstanceId, history);

    return structuredClone(receipt);
  }

  async getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined> {
    return structuredClone(this.#readiness.get(environmentInstanceId));
  }

  async listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]> {
    return structuredClone(this.#probes.get(environmentInstanceId) ?? []);
  }

  async getCurrentObservation(
    environmentInstanceId: string,
  ): Promise<StoredReadinessObservation | undefined> {
    const observationId = this.#currentObservations.get(environmentInstanceId);
    if (observationId === undefined) return undefined;
    return structuredClone(this.#observations.get(observationId));
  }

  async recordModelAuthorizations(
    instance: string,
    authorizations: readonly import('./readiness.ts').ModelAuthorizationFact[],
    context?: {
      readonly enrollmentId?: string;
      readonly connectionEpoch?: number;
      readonly lifecycleGeneration?: number;
      readonly isCurrent?: () => boolean;
      readonly connectionId?: string;
      readonly requirements?: ReadinessRequirementScope;
      readonly actor?: string;
    },
  ): Promise<void> {
    if (context?.isCurrent?.() === false) return;
    const existing = this.#readiness.get(instance);
    if (!existing && authorizations.length === 0) return;
    const updated = withModelAuthorizations(existing, authorizations, context);
    this.#readiness.set(instance, structuredClone(updated));
    const history = this.#authorizationEvidence.get(instance) ?? [];
    history.push(structuredClone({ evidenceId: `auth-${crypto.randomUUID()}`, environmentInstanceId: instance,
      recordedAt: Date.now(), ...(context?.enrollmentId !== undefined ? { enrollmentId: context.enrollmentId } : {}),
      ...(context?.requirements !== undefined ? { requirements: context.requirements } : {}), authorizations }));
    this.#authorizationEvidence.set(instance, history);
  }

  async listModelAuthorizationEvidence(instance: string): Promise<readonly ModelAuthorizationEvidence[]> {
    return structuredClone(this.#authorizationEvidence.get(instance) ?? []);
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
    return results.sort((a, b) => a.sequence - b.sequence);
  }
}
