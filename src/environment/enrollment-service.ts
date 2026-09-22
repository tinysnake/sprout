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
import { EnrollmentLifecycleAuthority } from './enrollment-authority.ts';
import { createClaimSecret, claimSecretDigest, verifyClaimSecret, DEFAULT_CLAIM_TTL_MS } from './enrollment-claim.ts';
import type { EnrollmentStore } from './enrollment-store.ts';
import { WorkerProofAuthority, WorkerProofError, type WorkerIdentityChallenge, type WorkerIdentityProof } from './worker-proof.ts';
import {
  assembleEnvironmentReadiness,
  type AssembledReadiness,
} from './readiness-service.ts';
import {
  allowlistedReadinessValue,
  observedFactsFromWorkerReadiness,
  READINESS_AUTH_MODES,
  READINESS_AUTH_TYPES,
  READINESS_SOURCES,
} from './readiness.ts';
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
    engines: observed.engines.map((engine) => {
      // The auth/source fields are a closed-world product enum: a legacy or
      // bypassing document that stored a provider/account identity in one of
      // them is dropped rather than echoed (#114 C6, R118-BOUNDARY-003).
      const authMode = allowlistedReadinessValue(engine.authMode, READINESS_AUTH_MODES);
      const authType = allowlistedReadinessValue(engine.authType, READINESS_AUTH_TYPES);
      const source = allowlistedReadinessValue(engine.source, READINESS_SOURCES);
      return {
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
        ...(authMode !== undefined ? { authMode } : {}),
        ...(authType !== undefined ? { authType } : {}),
        ...(engine.modelIdPresent !== undefined ? { modelIdPresent: engine.modelIdPresent } : {}),
        ...(engine.probedAt !== undefined ? { probedAt: engine.probedAt } : {}),
        ...(engine.probeExitCode !== undefined ? { probeExitCode: engine.probeExitCode } : {}),
        ...(source !== undefined ? { source } : {}),
      };
    }),
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
    // Probe provenance is a closed-world fact just like engine provenance.
    // JSON-RPC is runtime input, so its TypeScript union cannot prevent a
    // proven but malicious Worker from attempting to retain an account or
    // provider identifier here.
    ...(probe.source === 'worker' ? { source: 'worker' as const } : {}),
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
   * The shared synchronous lifecycle authority fence (R118-EPOCH-001).
   *
   * When the runtime composes one instance, the enrollment service, the archive
   * service, and the Worker gateway share it, so revocation/reset is ordered
   * with epoch acceptance. Defaults to a private instance for callers that do
   * not need to coordinate.
   */
  readonly lifecycleAuthority?: EnrollmentLifecycleAuthority;
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
  readonly #authority: EnrollmentLifecycleAuthority;

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
    this.#authority = options.lifecycleAuthority ?? new EnrollmentLifecycleAuthority();
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
    // Capture the lifecycle generation before any await that can interleave a
    // revoke/reset. Reconciliation appends a durable decision but must never
    // overwrite a lifecycle decision that crossed this window (R118-EPOCH-001).
    const lifecycleGeneration = this.#authority.generation(enrollment.id);
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
    //
    // Save through the durable revision CAS so a slow pre-epoch reconciliation
    // can never clobber a newer revoke/reset. Re-read the lifecycle first: if a
    // Human decision landed while the proof verified, this reconciliation is
    // history that must not be published at all.
    await this.#requireEnrollment(enrollment.id);
    if (this.#authority.generation(enrollment.id) !== lifecycleGeneration) {
      return { ...outcome, authoritySuperseded: true };
    }
    // The candidate was derived from `enrollment`, not from the re-read above.
    // Binding its CAS to that source revision makes a newer durable document
    // unwriteable even when its revision happens to equal the candidate's
    // revision shape (for example a concurrent permission edit).
    const saved = await this.#enrollments.saveIfRevision(outcome.enrollment, enrollment.revision);
    if (saved === undefined) {
      return { ...outcome, authoritySuperseded: true };
    }
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
    return this.#mutateWithCas(enrollmentId, (current) => approveEnrollment(current, {
      capabilityPermissions: input.capabilityPermissions,
      at: this.#clock(),
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
    })).then((enrollment) => {
      this.#announce(enrollment);
      return { enrollment };
    });
  }

  async revoke(enrollmentId: string, reason: string): Promise<EnvironmentEnrollment> {
    this.#loseAuthority(enrollmentId);
    const at = this.#clock();
    const revoked = await this.#mutateWithCas(enrollmentId, (current) => revokeEnrollment(current, at, reason));
    this.#announce(revoked);
    return revoked;
  }

  async reset(enrollmentId: string, reason: string): Promise<EnvironmentEnrollment> {
    this.#loseAuthority(enrollmentId);
    const at = this.#clock();
    const reset = await this.#mutateWithCas(enrollmentId, (current) => resetEnrollment(current, at, reason));
    this.#announce(reset);
    return reset;
  }

  async setCapabilityPermission(
    enrollmentId: string,
    capability: string,
    allowed: boolean,
  ): Promise<EnvironmentEnrollment> {
    // Capability permission changes whether the currently accepted Worker may
    // exercise authority. Fence an in-flight pre-epoch reconciliation before
    // publishing the durable decision, exactly as revoke/reset do.
    this.#loseAuthority(enrollmentId);
    const at = this.#clock();
    const updated = await this.#mutateWithCas(
      enrollmentId,
      (current) => setCapabilityPermission(current, capability, allowed, at),
    );
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

  /**
   * Assemble the independent facts plus the deterministic summary.
   *
   * Readiness and the current-epoch probe history are returned as **one**
   * lifecycle/epoch snapshot. The caller must not read them separately, or a
   * lifecycle decision that crosses an await could pair an approved readiness
   * document with a differently-scoped probe list (R118-EPOCH-001).
   */
  async readiness(
    enrollmentId: string,
  ): Promise<AssembledReadiness & { readonly enrollment: EnvironmentEnrollment; readonly probes: readonly ProbeResultFact[] }> {
    // Capture authority before the durable reads and re-check it synchronously
    // after them. A revoke/reset/archive bumps this generation before its own
    // save, so an observed change means the lifecycle moved across the reads and
    // no fact from before that move may be projected as current.
    const generation = this.#authority.generation(enrollmentId);
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
    const readEnrollment = await this.#requireEnrollment(enrollmentId);
    // Synchronous authority check: no await separates it from the reads above.
    // The durable status is always the freshest read; the *facts* are suppressed
    // whenever a lifecycle decision crossed the reads, so an in-flight revoke can
    // never be paired with stale current readiness or probes.
    const authorityStable = this.#authority.generation(enrollmentId) === generation;
    const currentEnrollment = readEnrollment;
    const lifecycleCurrent = authorityStable && currentEnrollment.status === 'approved';
    const currentEpoch = this.#currentConnectionEpoch(currentEnrollment.id);
    // Durable history remains inspectable, but only facts bound to the live
    // accepted epoch may look current in the readiness/API projection.
    const observed = lifecycleCurrent && rawObserved !== undefined &&
      rawObserved.enrollmentId === currentEnrollment.id &&
      rawObserved.connectionEpoch === currentEpoch
      ? sanitizeObservedReadiness(rawObserved)
      : undefined;
    // The probe *history* is durable audit across reconnects; like the original
    // `listProbes` it is projected whenever the lifecycle is still approved and
    // is emptied by revoke/reset. Only the *latest current* probe (the one that
    // can make a summary Green) is epoch-scoped.
    const probes = lifecycleCurrent ? rawProbes.map(sanitizeProbe) : [];
    const currentProbes = lifecycleCurrent ? probes.filter((probe) =>
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
    return { ...assembled, enrollment: currentEnrollment, probes };
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

  /**
   * The shared lifecycle authority fence, exposed so the gateway can compare a
   * generation captured at acceptance with the current generation synchronously.
   */
  get lifecycleAuthority(): EnrollmentLifecycleAuthority {
    return this.#authority;
  }

  /** Combine the caller's connection token with the service's live resolver. */
  #acceptedAuthority(
    enrollment: EnvironmentEnrollment,
    authority: ReadinessWriteAuthority,
  ): ReadinessWriteAuthority | undefined {
    const enrollmentId = enrollment.id;
    const generation = this.#authority.generation(enrollmentId);
    if (
      // An epoch resolver alone is not enrollment authority. In particular, a
      // pending enrollment must never write merely because it has a number.
      enrollment.status !== 'approved' ||
      authority.enrollmentId !== enrollmentId ||
      !Number.isSafeInteger(authority.connectionEpoch) ||
      authority.connectionEpoch <= 0
    ) return undefined;
    const isCurrent = (): boolean =>
      this.#authority.generation(enrollmentId) === generation &&
      authority.isCurrent() &&
      this.#currentConnectionEpoch(enrollmentId) === authority.connectionEpoch;
    return isCurrent()
      ? { enrollmentId, connectionEpoch: authority.connectionEpoch, isCurrent }
      : undefined;
  }

  /**
   * Apply one lifecycle mutation through the durable revision CAS.
   *
   * The mutation is recomputed against the freshest durable document and saved
   * only when the revision it was derived from is still current, retrying if a
   * concurrent writer moved it. This makes every lifecycle write monotonic: two
   * revokes cannot lose one another, and a slow reconciliation that captured an
   * older revision can never overwrite the result (R118-EPOCH-001).
   */
  async #mutateWithCas(
    enrollmentId: string,
    mutate: (current: EnvironmentEnrollment) => EnvironmentEnrollment,
  ): Promise<EnvironmentEnrollment> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.#requireEnrollment(enrollmentId);
      const saved = await this.#enrollments.saveIfRevision(mutate(current), current.revision);
      if (saved !== undefined) return saved;
    }
    throw new EnrollmentError(
      'duplicate-identity',
      'The enrollment changed concurrently; retry the lifecycle decision.',
    );
  }

  /** Fence local lifecycle authority before the durable decision is published. */
  #loseAuthority(enrollmentId: string): void {
    this.#authority.bump(enrollmentId);
    this.#onAuthorityLost?.(enrollmentId);
  }
}
