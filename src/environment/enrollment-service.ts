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
  type EnrollmentClaim,
  type EnrollmentConnectionOutcome,
} from './enrollment.ts';
import { createEnrollmentId, workerIdentityDigest } from './enrollment-identity.ts';
import { createClaimSecret, claimSecretDigest, verifyClaimSecret, DEFAULT_CLAIM_TTL_MS } from './enrollment-claim.ts';
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
import type {
  EnvironmentReadinessStore,
  ObservedReadiness,
  ReadinessWriteAuthority,
} from './readiness-store.ts';
import type { EnvironmentRecoveryPhase } from './recovery.ts';

function sanitizeEngineVersion(value: string): string | undefined {
  // Version is a structured semver fact, not free-form Worker output.  Generic
  // identifier redaction quite correctly treats dotted unknown text as a host;
  // accept only the pinned CLI-version shape here.
  return /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value) ? value : undefined;
}

function sanitizeProbeVersion(value: string): string | undefined {
  return /^(?:\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:, \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)*$/.test(value)
    ? value
    : undefined;
}

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
    // Enrollment ids are core-issued opaque authority keys, never Worker text.
    // Preserve them exactly so an epoch-bound observation can be compared with
    // its enrollment; they are not exposed in the readiness browser view.
    ...(observed.enrollmentId !== undefined ? { enrollmentId: observed.enrollmentId } : {}),
    ...(Number.isSafeInteger(observed.connectionEpoch) && (observed.connectionEpoch ?? 0) > 0
      ? { connectionEpoch: observed.connectionEpoch }
      : {}),
    connection: {
      state: observed.connection.state,
      ...(observed.connection.lastConfirmedAt !== undefined
        ? { lastConfirmedAt: observed.connection.lastConfirmedAt }
        : {}),
    },
    compatibility: {
      state: observed.compatibility.state,
      ...(protocolVersion !== undefined ? { workerProtocolVersion: protocolVersion } : {}),
      ...(observed.compatibility.detail !== undefined
        ? { detail: sanitizeOperatorText(observed.compatibility.detail, { fallback: DEFAULT_COMPATIBILITY_DETAIL }) }
        : {}),
    },
    engines: observed.engines.map((engine) => ({
      engine: sanitizeIdentifier(engine.engine, { fallback: 'unknown-engine', kind: 'engine' }),
      ...(engine.version !== undefined
        ? { version: sanitizeEngineVersion(engine.version) ?? 'unknown-version' }
        : {}),
      installed: engine.installed,
      readiness: engine.readiness,
      required: engine.required,
      models: {
        state: engine.models.state,
        models: engine.models.models.map((model) =>
          sanitizeIdentifier(model, { fallback: 'unknown-model', kind: 'model' }),
        ),
      },
      ...(engine.authenticated !== undefined ? { authenticated: engine.authenticated } : {}),
      ...(engine.authMode !== undefined ? { authMode: sanitizeIdentifier(engine.authMode, { fallback: 'unknown', kind: 'generic' }) } : {}),
      ...(engine.authType !== undefined ? { authType: sanitizeIdentifier(engine.authType, { fallback: 'unknown', kind: 'generic' }) } : {}),
      ...(engine.modelIdPresent !== undefined ? { modelIdPresent: engine.modelIdPresent } : {}),
      ...(engine.probedAt !== undefined ? { probedAt: engine.probedAt } : {}),
      ...(engine.probeExitCode !== undefined ? { probeExitCode: engine.probeExitCode } : {}),
      ...(engine.source !== undefined ? { source: sanitizeIdentifier(engine.source, { fallback: 'unknown', kind: 'generic' }) } : {}),
    })),
  };
}

function sanitizeProbe(probe: ProbeResultFact): ProbeResultFact {
  return {
    ...probe,
    // This is assigned from the locally resolved enrollment in recordProbe,
    // rather than accepted from Worker output, and remains internal to probe
    // history. It must stay exact for authority comparison.
    ...(probe.enrollmentId !== undefined ? { enrollmentId: probe.enrollmentId } : {}),
    ...(Number.isSafeInteger(probe.connectionEpoch) && (probe.connectionEpoch ?? 0) > 0
      ? { connectionEpoch: probe.connectionEpoch }
      : {}),
    ...(probe.version !== undefined ? { version: sanitizeProbeVersion(probe.version) ?? 'unknown-version' } : {}),
    summary: sanitizeOperatorText(probe.summary, { fallback: DEFAULT_PROBE_SUMMARY }),
  };
}

export interface EnvironmentEnrollmentServiceOptions {
  readonly enrollments: EnrollmentStore;
  readonly readiness: EnvironmentReadinessStore;
  /** Current accepted epoch, or undefined while the enrollment is offline. */
  readonly currentConnectionEpoch: (enrollmentId: string) => number | undefined;
  /** Fence the accepted Worker before revoke/reset is durably published. */
  readonly onAuthorityLost?: (enrollmentId: string) => void;
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
  /** Generates a one-use host claim secret. Injectable for deterministic tests. */
  readonly claimSecretFactory?: () => string;
  /** How long a host claim stays usable. Defaults to 15 minutes. */
  readonly claimTtlMs?: number;
  /**
   * Invoked after a durable enrollment authority decision is written (E2, #116).
   *
   * The dynamic Environment catalog observes approval, revocation, reset, and
   * permission changes through this hook, so a newly approved or revoked instance
   * becomes eligible or ineligible without a process restart. The hook is an
   * observation only: a failure in it must never roll back the durable decision,
   * so callers must not throw from it.
   */
  readonly onMutation?: (enrollment: EnvironmentEnrollment) => void;
}
/** A new pending enrollment request plus the host bootstrap guidance it unlocks. */
export interface PendingEnrollmentResult {
  readonly enrollment: EnvironmentEnrollment;
  /**
   * The Web-created one-use host claim (#115), when none was pre-supplied.
   *
   * The raw secret is returned exactly once, at creation, and is never retained,
   * echoed, or carried in a list view. `undefined` for a pre-provisioned
   * enrollment whose identity was already known.
   */
  readonly claim: { readonly secret: string; readonly expiresAt: number } | undefined;
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
  readonly #claimSecretFactory: () => string;
  readonly #claimTtlMs: number;
  readonly #onMutation: ((enrollment: EnvironmentEnrollment) => void) | undefined;
  readonly #currentConnectionEpoch: (enrollmentId: string) => number | undefined;
  readonly #onAuthorityLost: ((enrollmentId: string) => void) | undefined;
  /** Local lifecycle generation checked at the store mutation boundary. */
  readonly #authorityGenerations = new Map<string, number>();

  constructor(options: EnvironmentEnrollmentServiceOptions) {
    this.#enrollments = options.enrollments;
    this.#readiness = options.readiness;
    this.#currentConnectionEpoch = options.currentConnectionEpoch;
    this.#onAuthorityLost = options.onAuthorityLost;
    this.#leases = options.leases;
    this.#recoveryRecords = options.recoveryRecords;
    this.#requiredEngines = options.requiredEngines ?? [];
    this.#supportedProtocol = options.supportedProtocol ?? SUPPORTED_WORKER_PROTOCOL;
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory;
    this.#proofAuthority =
      options.proofAuthority ?? new WorkerProofAuthority({ clock: this.#clock });
    this.#claimSecretFactory = options.claimSecretFactory ?? createClaimSecret;
    this.#claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.#onMutation = options.onMutation;
  }

  /** Announce a durable decision to the catalog observer, never throwing. */
  #announce(enrollment: EnvironmentEnrollment): void {
    try {
      this.#onMutation?.(enrollment);
    } catch {
      // Observation must never turn a durable authority decision into a failure.
    }
  }

  async list(): Promise<readonly EnvironmentEnrollment[]> {
    return (await this.#enrollments.list()).map(normalizeEnrollment);
  }

  async get(enrollmentId: string): Promise<EnvironmentEnrollment | undefined> {
    const enrollment = await this.#enrollments.get(enrollmentId);
    return enrollment === undefined ? undefined : normalizeEnrollment(enrollment);
  }

  /**
   * Create a short-lived, identity-free pending enrollment and its host claim.
   *
   * Web supplies no Worker public key, host address, or engine credential: the
   * response separates the public bootstrap guidance from the one-use secret,
   * and the Worker identity is bound only after a claim proves key possession
   * (#115, ADR-0012).
   */
  async requestEnrollment(
    input: Omit<CreatePendingEnrollmentInput, 'at' | 'id' | 'identityDigest' | 'claim'> & {
      /**
       * The Worker's host-generated public key, when a caller already knows it
       * (a pre-provisioned host or an independent probe). A caller with no key —
       * the production Web path (#115) — omits it and receives a one-use claim
       * instead.
       */
      readonly publicKey?: string;
    },
  ): Promise<PendingEnrollmentResult> {
    const at = this.#clock();
    const { publicKey, ...rest } = input;
    // An Environment instance has one durable enrollment authority. Identity
    // rotation uses the existing reset/reapproval lifecycle on that record;
    // creating a sibling record would split epoch, readiness, and transport
    // ownership for one physical Environment.
    // A pre-known identity needs no claim: there is nothing to bind. Web, which
    // never supplies a key, gets a one-use secret so the identity is bound only
    // after the host claims it and proves key possession (ADR-0012).
    const claimSecret = publicKey !== undefined ? undefined : this.#claimSecretFactory();
    const claim: EnrollmentClaim | undefined = claimSecret === undefined
      ? undefined
      : {
          secretDigest: claimSecretDigest(claimSecret),
          issuedAt: at,
          expiresAt: at + this.#claimTtlMs,
        };
    const enrollment = createPendingEnrollment({
      ...rest,
      ...(publicKey !== undefined ? { identityDigest: workerIdentityDigest(publicKey) } : {}),
      ...(claim !== undefined ? { claim } : {}),
      at,
      id: (this.#idFactory ?? createEnrollmentId)(),
    });
    if (!(await this.#enrollments.createIfInstanceAbsent(enrollment))) {
      throw new EnrollmentError(
        'duplicate-instance',
        'This Environment instance already has an enrollment; reset and reapprove that enrollment to rotate its Worker identity.',
      );
    }
    this.#announce(enrollment);
    return {
      enrollment,
      claim:
        claimSecret === undefined || claim === undefined
          ? undefined
          : { secret: claimSecret, expiresAt: claim.expiresAt },
      bootstrap: {
        instructions: [
          'Install the Sprout Worker and the engines you intend to use in the signed-in user context.',
          'Generate the Worker key pair on the Environment host; the private key never leaves that host.',
          'Start the Worker with the one-use enrollment claim secret read from the environment, not the command line.',
          'The Worker connects outbound to Sprout and proves key possession; a Human then approves the identity.',
        ],
      },
    };
  }

  /**
   * Claim a pending enrollment with the one-use host secret (#115).
   *
   * The secret is consumed exactly once and expires cleanly. A successful claim
   * does not bind an identity and cannot approve itself; it only admits this
   * host to the challenge/connect proof step. The response never echoes the
   * secret, and a revoked, consumed, expired, or unknown claim fails closed.
   */
  async claimEnrollment(
    enrollmentId: string,
    claimSecret: string,
  ): Promise<EnvironmentEnrollment> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    const at = this.#clock();
    if (enrollment.status === 'revoked') {
      throw new EnrollmentError('revoked-enrollment', 'This enrollment is revoked and cannot be claimed.');
    }
    const claim = enrollment.claim;
    if (claim === undefined || claim.consumedAt !== undefined) {
      throw new EnrollmentError('invalid-claim', 'The enrollment has no live one-use claim.');
    }
    if (at >= claim.expiresAt) {
      throw new EnrollmentError('invalid-claim', 'The one-use enrollment claim has expired.');
    }
    if (!verifyClaimSecret(claimSecret, claim.secretDigest)) {
      throw new EnrollmentError('invalid-claim', 'The one-use enrollment claim is not valid.');
    }
    // Consumption is exactly-once and durable: the store compare-and-sets the
    // stored claim, so two concurrent claimants with the same valid secret can
    // never both succeed. The loser observes an already-consumed claim and is
    // refused deterministically rather than reporting a second success (#115).
    const consumed = await this.#enrollments.consumeClaim(enrollmentId, claim.secretDigest, at);
    if (consumed === undefined) {
      throw new EnrollmentError('invalid-claim', 'The one-use enrollment claim is not valid.');
    }
    return normalizeEnrollment(consumed);
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
    // A claimed-but-unconsumed enrollment must not accept an identity proof: the
    // one-use secret is the host's admission to the proof step, so proof alone
    // cannot bind an identity to a Web-created pending enrollment (#115).
    if (enrollment.claim !== undefined && enrollment.claim.consumedAt === undefined) {
      throw new EnrollmentError(
        'invalid-claim',
        'The enrollment must be claimed with its one-use secret before its Worker identity can be proven.',
      );
    }
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
    // Identity reconciliation happens before the gateway accepts an epoch.
    // Consequently this method must not persist `online` or any Worker facts:
    // only an accepted epoch may mint the mandatory readiness authority below.
    await this.#enrollments.save(outcome.enrollment);
    return outcome;
  }

  /** Record one accepted-epoch observation as a single durable commit. */
  async observeReadiness(
    enrollmentId: string,
    observed: ObservedReadiness,
    authority: ReadinessWriteAuthority,
    probe?: Omit<ProbeResultFact, 'enrollmentId' | 'connectionEpoch'>,
  ): Promise<boolean> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    const accepted = this.#acceptedAuthority(enrollment, authority);
    if (accepted === undefined) return false;
    const readiness = sanitizeObservedReadiness({
      ...observed,
      enrollmentId: enrollment.id,
      connectionEpoch: accepted.connectionEpoch,
    });
    const sanitizedProbe = probe === undefined
      ? undefined
      : sanitizeProbe({
          ...probe,
          enrollmentId: enrollment.id,
          connectionEpoch: accepted.connectionEpoch,
        });
    return this.#readiness.commitObservation(
      enrollment.environmentInstanceId,
      { readiness, ...(sanitizedProbe !== undefined ? { probe: sanitizedProbe } : {}) },
      accepted,
    );
  }

  async listProbes(enrollmentId: string): Promise<readonly ProbeResultFact[]> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    // Historical rows remain durable for audit, but a pending/revoked/reset
    // enrollment has no current Worker authority. Do not present those rows as
    // current facts through the API projection.
    if (enrollment.status !== 'approved') return [];
    const probes = await this.#readiness.listProbes(enrollment.environmentInstanceId);
    // Re-check lifecycle after the asynchronous history read: revoke/reset may
    // have crossed the API read while the store was busy.
    const current = await this.#requireEnrollment(enrollmentId);
    return current.status === 'approved' ? probes.map(sanitizeProbe) : [];
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
    this.#announce(approved);
    return { enrollment: approved };
  }

  async revoke(enrollmentId: string, reason: string): Promise<EnvironmentEnrollment> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    this.#loseAuthority(enrollment.id);
    const revoked = revokeEnrollment(enrollment, this.#clock(), reason);
    await this.#enrollments.save(revoked);
    this.#announce(revoked);
    return revoked;
  }

  async reset(enrollmentId: string, reason: string): Promise<EnvironmentEnrollment> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    this.#loseAuthority(enrollment.id);
    const reset = resetEnrollment(enrollment, this.#clock(), reason);
    await this.#enrollments.save(reset);
    this.#announce(reset);
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
    this.#announce(updated);
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
      readonly observedAt?: number;
      readonly probe?: {
        readonly at: number;
        readonly latencyMs: number;
        readonly protocolOk: boolean;
        readonly enginesOk: boolean;
        readonly source: 'worker';
        readonly version: string;
        readonly summary: string;
      };
      readonly engines: readonly {
        readonly engine: string;
        readonly installed: boolean;
        readonly readiness: string;
        readonly modelAvailability: string;
        readonly models: readonly string[];
        readonly version?: string;
        readonly authenticated?: boolean;
        readonly authMode?: string;
        readonly authType?: string;
        readonly modelIdPresent?: boolean;
        readonly probedAt?: number;
        readonly probeExitCode?: number;
        readonly source?: string;
      }[];
    },
    authority: ReadinessWriteAuthority,
  ): Promise<boolean> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    const accepted = this.#acceptedAuthority(enrollment, authority);
    if (accepted === undefined) return false;
    const observed = observedFactsFromWorkerReadiness({
      ...readiness,
      at: this.#clock(),
      supported: this.#supportedProtocol,
    });
    const storedReadiness = sanitizeObservedReadiness({
      ...observed,
      enrollmentId: enrollment.id,
      connectionEpoch: accepted.connectionEpoch,
    });
    const probe = readiness.probe === undefined
      ? undefined
      : sanitizeProbe({
          ...readiness.probe,
          enrollmentId: enrollment.id,
          connectionEpoch: accepted.connectionEpoch,
        });
    // Readiness and its startup/explicit probe cross exactly one store call.
    // Store adapters check the live guard at their mutation boundary and commit
    // both documents atomically, so there is no partial-readiness race.
    return this.#readiness.commitObservation(
      enrollment.environmentInstanceId,
      { readiness: storedReadiness, ...(probe !== undefined ? { probe } : {}) },
      accepted,
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
    // Re-read after the durable reads. This closes the API projection race in
    // which revoke/reset completes while the readiness store is being read.
    const currentEnrollment = await this.#requireEnrollment(enrollmentId);
    const currentEpoch = this.#currentConnectionEpoch(currentEnrollment.id);
    // Durable history remains inspectable, but only facts bound to the live
    // accepted epoch may look current in the readiness/API projection.
    const observed = currentEnrollment.status === 'approved' && rawObserved !== undefined &&
      rawObserved.enrollmentId === currentEnrollment.id &&
      rawObserved.connectionEpoch === currentEpoch
      ? sanitizeObservedReadiness(rawObserved)
      : undefined;
    const probes = rawProbes.map(sanitizeProbe);
    const currentProbes = currentEnrollment.status === 'approved' ? probes.filter((probe) =>
      probe.enrollmentId === currentEnrollment.id && probe.connectionEpoch === currentEpoch,
    ) : [];
    const latestProbe = currentProbes.length > 0 ? currentProbes[currentProbes.length - 1] : undefined;
    const assembled = assembleEnvironmentReadiness({
      enrollment: currentEnrollment,
      observed,
      leases,
      ...(recoveryRecords !== undefined ? { recoveryRecords } : {}),
      requiredEngines: this.#requiredEngines,
      ...(latestProbe !== undefined ? { probe: latestProbe } : {}),
      supportedProtocol: this.#supportedProtocol,
      now: this.#clock(),
    });
    return { ...assembled, enrollment: currentEnrollment };
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

  /** Combine the caller's connection token with the service's live resolver. */
  #acceptedAuthority(
    enrollment: EnvironmentEnrollment,
    authority: ReadinessWriteAuthority,
  ): ReadinessWriteAuthority | undefined {
    const enrollmentId = enrollment.id;
    const generation = this.#authorityGenerations.get(enrollmentId) ?? 0;
    if (
      // An epoch resolver alone is not enrollment authority. In particular, a
      // pending enrollment must never write merely because it has a number.
      enrollment.status !== 'approved' ||
      authority.enrollmentId !== enrollmentId ||
      !Number.isSafeInteger(authority.connectionEpoch) ||
      authority.connectionEpoch <= 0
    ) return undefined;
    const isCurrent = (): boolean =>
      (this.#authorityGenerations.get(enrollmentId) ?? 0) === generation &&
      authority.isCurrent() &&
      this.#currentConnectionEpoch(enrollmentId) === authority.connectionEpoch;
    return isCurrent()
      ? { enrollmentId, connectionEpoch: authority.connectionEpoch, isCurrent }
      : undefined;
  }

  /** Fence local lifecycle authority before the durable decision is published. */
  #loseAuthority(enrollmentId: string): void {
    this.#authorityGenerations.set(
      enrollmentId,
      (this.#authorityGenerations.get(enrollmentId) ?? 0) + 1,
    );
    this.#onAuthorityLost?.(enrollmentId);
  }
}
