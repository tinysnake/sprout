import {
  normalizeEnrollment,
  approveEnrollment,
  createPendingEnrollment,
  reconcileWorkerConnection,
  resetEnrollment,
  revokeEnrollment,
  setCapabilityPermission,
  EnrollmentError,
  type CreatePendingEnrollmentInput,
  type EnvironmentEnrollment,
  type EnrollmentConnectionOutcome,
} from './enrollment.ts';
import { createEnrollmentId, workerIdentityDigest } from './enrollment-identity.ts';
import type { EnrollmentStore } from './enrollment-store.ts';
import { WorkerProofAuthority, WorkerProofError, type WorkerIdentityChallenge, type WorkerIdentityProof } from './worker-proof.ts';
import {
  assembleEnvironmentReadiness,
  type AssembledReadiness,
} from './readiness-service.ts';
import { observedFactsFromWorkerReadiness } from './readiness.ts';
import type {
  CompatibilityFact,
  ConnectionFact,
  EngineReadinessFact,
  LeaseSafetyFact,
  ProbeResultFact,
  ProtocolVersionRange,
} from './readiness.ts';
import { DEFAULT_COMPATIBILITY_DETAIL, DEFAULT_PROBE_SUMMARY, sanitizeIdentifier, sanitizeOperatorText, sanitizeProtocolVersion } from './privacy.ts';
import type { EnvironmentReadinessStore, ObservedReadiness } from './readiness-store.ts';
import type { EnvironmentRecoveryPhase } from './recovery.ts';

/**
 * The caller-facing Environment enrollment and readiness capability (#87).
 *
 * Every mutation is one durable decision written before it is observable, so an
 * approval, revocation, reset, or duplicate-identity outcome survives a restart.
 * A Worker connection is reconciled against the stored identity rather than
 * trusted, and readiness is assembled from the stored, independently observed
 * facts each time it is asked for.
 *
 * This Module owns no carrier, no engine, and no credential: it consumes neutral
 * Worker facts and produces product facts.
 */

export const SUPPORTED_WORKER_PROTOCOL: ProtocolVersionRange = { minMajor: 2, maxMajor: 2 };

function sanitizeObservedReadiness(observed: ObservedReadiness): ObservedReadiness {
  const protocolVersion = sanitizeProtocolVersion(observed.compatibility.workerProtocolVersion);
  return {
    ...observed,
    compatibility: {
      state: observed.compatibility.state,
      ...(protocolVersion !== undefined ? { workerProtocolVersion: protocolVersion } : {}),
      ...(observed.compatibility.detail !== undefined
        ? { detail: sanitizeOperatorText(observed.compatibility.detail, { fallback: DEFAULT_COMPATIBILITY_DETAIL }) }
        : {}),
    },
    engines: observed.engines.map((engine) => ({
      engine: sanitizeIdentifier(engine.engine, { fallback: 'unknown-engine', kind: 'engine' }),
      installed: engine.installed,
      readiness: engine.readiness,
      required: engine.required,
      models: {
        state: engine.models.state,
        models: engine.models.models.map((model) =>
          sanitizeIdentifier(model, { fallback: 'unknown-model', kind: 'model' }),
        ),
      },
    })),
  };
}

function sanitizeProbe(probe: ProbeResultFact): ProbeResultFact {
  return {
    ...probe,
    summary: sanitizeOperatorText(probe.summary, { fallback: DEFAULT_PROBE_SUMMARY }),
  };
}

export interface EnvironmentEnrollmentServiceOptions {
  readonly enrollments: EnrollmentStore;
  readonly readiness: EnvironmentReadinessStore;
  /** The leases that decide work safety. Optional: an Environment with no work. */
  readonly leases?: () => Promise<readonly LeaseSafetyFact[]> | readonly LeaseSafetyFact[];
  /**
   * The open recovery records that decide work safety (#88).
   *
   * When supplied, these are authoritative over the lease projection, so
   * `reconciling` and `recovery` stay distinct in the readiness summary. A
   * reconnect alone never proves the Environment is safe to reassign, and this
   * is the seam that keeps that fact visible to the Web summary.
   */
  readonly recoveryRecords?: () =>
    | Promise<readonly { readonly environmentInstanceId: string; readonly phase: EnvironmentRecoveryPhase }[]>
    | readonly { readonly environmentInstanceId: string; readonly phase: EnvironmentRecoveryPhase }[];
  /**
   * Engines the Environment's configured use requires.
   *
   * There is deliberately no default pair: ADR-0008 says M2 requires Codex and Pi
   * across the product, not both on every Environment instance. A caller that
   * genuinely requires an engine must name it here; an empty configuration
   * requires nothing and must not fabricate a dual-engine requirement.
   */
  readonly requiredEngines?: readonly string[];
  readonly supportedProtocol?: ProtocolVersionRange;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  /** Mints and verifies Worker identity challenges. */
  readonly proofAuthority?: WorkerProofAuthority;
}

/** A new pending enrollment request plus the host bootstrap guidance it unlocks. */
export interface PendingEnrollmentResult {
  readonly enrollment: EnvironmentEnrollment;
  readonly bootstrap: {
    /** Host bootstrap steps; host-local actions are never performed by Web. */
    readonly instructions: readonly string[];
  };
}

export interface ApproveEnrollmentResult {
  readonly enrollment: EnvironmentEnrollment;
}

export class EnvironmentEnrollmentService {
  readonly #enrollments: EnrollmentStore;
  readonly #readiness: EnvironmentReadinessStore;
  readonly #leases: (() => Promise<readonly LeaseSafetyFact[]> | readonly LeaseSafetyFact[]) | undefined;
  readonly #recoveryRecords:
    | (() =>
        | Promise<readonly { readonly environmentInstanceId: string; readonly phase: EnvironmentRecoveryPhase }[]>
        | readonly { readonly environmentInstanceId: string; readonly phase: EnvironmentRecoveryPhase }[])
    | undefined;
  readonly #requiredEngines: readonly string[];
  readonly #supportedProtocol: ProtocolVersionRange;
  readonly #clock: () => number;
  readonly #idFactory: (() => string) | undefined;
  readonly #proofAuthority: WorkerProofAuthority;

  constructor(options: EnvironmentEnrollmentServiceOptions) {
    this.#enrollments = options.enrollments;
    this.#readiness = options.readiness;
    this.#leases = options.leases;
    this.#recoveryRecords = options.recoveryRecords;
    this.#requiredEngines = options.requiredEngines ?? [];
    this.#supportedProtocol = options.supportedProtocol ?? SUPPORTED_WORKER_PROTOCOL;
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory;
    this.#proofAuthority =
      options.proofAuthority ?? new WorkerProofAuthority({ clock: this.#clock });
  }

  async list(): Promise<readonly EnvironmentEnrollment[]> {
    return (await this.#enrollments.list()).map(normalizeEnrollment);
  }

  async get(enrollmentId: string): Promise<EnvironmentEnrollment | undefined> {
    const enrollment = await this.#enrollments.get(enrollmentId);
    return enrollment === undefined ? undefined : normalizeEnrollment(enrollment);
  }

  /** Create a short-lived pending enrollment and its host bootstrap guidance. */
  async requestEnrollment(
    input: Omit<CreatePendingEnrollmentInput, 'at' | 'id' | 'identityDigest'> & {
      /** The Worker's host-generated public key; only its digest is retained. */
      readonly publicKey: string;
    },
  ): Promise<PendingEnrollmentResult> {
    const at = this.#clock();
    const { publicKey, ...rest } = input;
    const enrollment = createPendingEnrollment({
      ...rest,
      identityDigest: workerIdentityDigest(publicKey),
      at,
      id: (this.#idFactory ?? createEnrollmentId)(),
    });
    await this.#enrollments.save(enrollment);
    return {
      enrollment,
      bootstrap: {
        instructions: [
          'Install the Sprout Worker and the engines you intend to use in the signed-in user context.',
          'Generate the Worker key pair on the Environment host; the private key never leaves that host.',
          'Register the Worker to start after sign-in, then start it once so it connects to Sprout.',
        ],
      },
    };
  }

  /**
   * Issue a fresh, single-use, enrollment-bound proof challenge.
   *
   * The Worker signs the nonce with its host-generated private key and returns
   * the public key plus signature to `connectWorker`. Only a verified signature
   * can reconcile an identity, so a bare public key or digest is refused.
   */
  async issueChallenge(enrollmentId: string): Promise<WorkerIdentityChallenge> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    // A revoked enrollment is still challenged, deliberately: the subsequent
    // connect is recorded as a durable `revoked-refused` authority decision
    // rather than disappearing as an untraceable pre-flight error. The challenge
    // itself grants nothing, so this does not weaken revocation.
    return this.#proofAuthority.issue(enrollment.id);
  }

  /**
   * Reconcile a Worker connection attempt against the durable identity.
   *
   * The proof must contain a live challenge response signed by the Worker's
   * private key; the public key digest is derived only after the signature
   * verifies. The recorded identity observation and the returned outcome are both
   * durable, so a duplicate or revoked attempt is explained identically after a
   * restart.
   */
  async connectWorker(input: {
    readonly enrollmentId: string;
    /** The signed challenge response proving possession of the Worker's key. */
    readonly proof: WorkerIdentityProof;
    readonly connection: ConnectionFact;
    readonly compatibility: CompatibilityFact;
    readonly engines: readonly EngineReadinessFact[];
  }): Promise<EnrollmentConnectionOutcome> {
    const enrollment = await this.#requireEnrollment(input.enrollmentId);
    const at = this.#clock();
    // The proof is verified before any identity is derived: an unverified public
    // key cannot be reconciled as `reconnected`, so a stolen digest/key alone is
    // never sufficient to connect.
    let verifiedPublicKey: string;
    try {
      verifiedPublicKey = this.#proofAuthority.verify({
        enrollmentId: enrollment.id,
        proof: input.proof,
      }).publicKey;
    } catch (error) {
      if (error instanceof WorkerProofError) {
        throw new EnrollmentError('invalid-proof', `The Worker identity proof is not valid: ${error.message}`);
      }
      throw error;
    }
    const identityDigest = workerIdentityDigest(verifiedPublicKey);
    const outcome = reconcileWorkerConnection(enrollment, identityDigest, at);
    // Only an accepted connection can produce readiness: a refused attempt (a
    // revoked binding, an invalidated identity, or a new key against a decided
    // one) is recorded as an authority decision alone, so unapproved connections
    // never overwrite the observed facts of the enrolled Worker.
    if (outcome.outcome !== 'duplicate-new-key-refused' && outcome.outcome !== 'revoked-refused' && outcome.outcome !== 'stale-identity-refused') {
      await this.#readiness.saveReadiness(
        enrollment.environmentInstanceId,
        sanitizeObservedReadiness({
          connection: input.connection,
          compatibility: input.compatibility,
          engines: input.engines,
        }),
      );
    }
    await this.#enrollments.save(outcome.enrollment);
    return outcome;
  }

  /** Record a fresh readiness observation without changing enrollment authority. */
  async observeReadiness(enrollmentId: string, observed: ObservedReadiness): Promise<void> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    await this.#readiness.saveReadiness(
      enrollment.environmentInstanceId,
      sanitizeObservedReadiness(observed),
    );
  }

  /** Append one readiness-probe result; prior probes are preserved. */
  async recordProbe(enrollmentId: string, probe: ProbeResultFact): Promise<ProbeResultFact> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    const sanitized = sanitizeProbe(probe);
    await this.#readiness.appendProbe(enrollment.environmentInstanceId, sanitized);
    return sanitized;
  }

  async listProbes(enrollmentId: string): Promise<readonly ProbeResultFact[]> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    return (await this.#readiness.listProbes(enrollment.environmentInstanceId)).map(sanitizeProbe);
  }

  async approve(
    enrollmentId: string,
    input: { readonly capabilityPermissions: Readonly<Record<string, boolean>>; readonly actor?: string },
  ): Promise<ApproveEnrollmentResult> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    const approved = approveEnrollment(enrollment, {
      capabilityPermissions: input.capabilityPermissions,
      at: this.#clock(),
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
    });
    await this.#enrollments.save(approved);
    return { enrollment: approved };
  }

  async revoke(enrollmentId: string, reason: string): Promise<EnvironmentEnrollment> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    const revoked = revokeEnrollment(enrollment, this.#clock(), reason);
    await this.#enrollments.save(revoked);
    return revoked;
  }

  async reset(enrollmentId: string, reason: string): Promise<EnvironmentEnrollment> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    const reset = resetEnrollment(enrollment, this.#clock(), reason);
    await this.#enrollments.save(reset);
    return reset;
  }

  async setCapabilityPermission(
    enrollmentId: string,
    capability: string,
    allowed: boolean,
  ): Promise<EnvironmentEnrollment> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    const updated = setCapabilityPermission(enrollment, capability, allowed, this.#clock());
    await this.#enrollments.save(updated);
    return updated;
  }

  /**
   * Record the readiness a connected Worker declared on `worker/info`.
   *
   * This is the core-side half of the Worker proof: the Worker reports what it
   * verified, and this maps it onto the durable observed facts without inventing
   * an installation, login, or model state the Worker did not state.
   */
  async observeWorkerReadiness(
    enrollmentId: string,
    readiness: {
      readonly protocolVersion: string;
      readonly engines: readonly {
        readonly engine: string;
        readonly installed: boolean;
        readonly readiness: string;
        readonly modelAvailability: string;
        readonly models: readonly string[];
      }[];
    },
  ): Promise<void> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    const observed = observedFactsFromWorkerReadiness({
      ...readiness,
      at: this.#clock(),
      supported: this.#supportedProtocol,
    });
    await this.#readiness.saveReadiness(
      enrollment.environmentInstanceId,
      sanitizeObservedReadiness(observed),
    );
  }

  /** Assemble the independent facts plus the deterministic summary. */
  async readiness(enrollmentId: string): Promise<AssembledReadiness & { readonly enrollment: EnvironmentEnrollment }> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    const [rawObserved, rawProbes, leases, recoveryRecords] = await Promise.all([
      this.#readiness.getReadiness(enrollment.environmentInstanceId),
      this.#readiness.listProbes(enrollment.environmentInstanceId),
      this.#currentLeases(),
      this.#currentRecoveryRecords(),
    ]);
    // Sanitize on the way out as well as on the way in: a document written by an
    // earlier build (or by an adapter that bypassed this service) must not leak
    // free text through the readiness projection either.
    const observed = rawObserved === undefined ? undefined : sanitizeObservedReadiness(rawObserved);
    const probes = rawProbes.map(sanitizeProbe);
    const latestProbe = probes.length > 0 ? probes[probes.length - 1] : undefined;
    const assembled = assembleEnvironmentReadiness({
      enrollment,
      observed,
      leases,
      ...(recoveryRecords !== undefined ? { recoveryRecords } : {}),
      requiredEngines: this.#requiredEngines,
      ...(latestProbe !== undefined ? { probe: latestProbe } : {}),
      supportedProtocol: this.#supportedProtocol,
      now: this.#clock(),
    });
    return { ...assembled, enrollment };
  }

  async #currentLeases(): Promise<readonly LeaseSafetyFact[]> {
    if (this.#leases === undefined) return [];
    return this.#leases();
  }

  async #currentRecoveryRecords(): Promise<
    readonly { readonly environmentInstanceId: string; readonly phase: EnvironmentRecoveryPhase }[] | undefined
  > {
    if (this.#recoveryRecords === undefined) return undefined;
    const records = await this.#recoveryRecords();
    return records.filter((record) => record.phase !== 'resolved');
  }

  async #requireEnrollment(enrollmentId: string): Promise<EnvironmentEnrollment> {
    const enrollment = await this.#enrollments.get(enrollmentId);
    if (enrollment === undefined) {
      throw new EnrollmentError('unknown-enrollment', `Unknown enrollment: ${enrollmentId}`);
    }
    return normalizeEnrollment(enrollment);
  }
}
