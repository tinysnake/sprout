import {
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
import type { EnvironmentReadinessStore, ObservedReadiness } from './readiness-store.ts';

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

export interface EnvironmentEnrollmentServiceOptions {
  readonly enrollments: EnrollmentStore;
  readonly readiness: EnvironmentReadinessStore;
  /** The leases that decide work safety. Optional: an Environment with no work. */
  readonly leases?: () => Promise<readonly LeaseSafetyFact[]> | readonly LeaseSafetyFact[];
  /** Engines the Environment's configured use requires. */
  readonly requiredEngines?: readonly string[];
  readonly supportedProtocol?: ProtocolVersionRange;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
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
  readonly #requiredEngines: readonly string[];
  readonly #supportedProtocol: ProtocolVersionRange;
  readonly #clock: () => number;
  readonly #idFactory: (() => string) | undefined;

  constructor(options: EnvironmentEnrollmentServiceOptions) {
    this.#enrollments = options.enrollments;
    this.#readiness = options.readiness;
    this.#leases = options.leases;
    this.#requiredEngines = options.requiredEngines ?? ['codex', 'pi'];
    this.#supportedProtocol = options.supportedProtocol ?? SUPPORTED_WORKER_PROTOCOL;
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory;
  }

  async list(): Promise<readonly EnvironmentEnrollment[]> {
    return this.#enrollments.list();
  }

  async get(enrollmentId: string): Promise<EnvironmentEnrollment | undefined> {
    return this.#enrollments.get(enrollmentId);
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
   * Reconcile a Worker connection attempt against the durable identity.
   *
   * The recorded identity observation and the returned outcome are both durable,
   * so a duplicate or revoked attempt is explained identically after a restart.
   */
  async connectWorker(input: {
    readonly enrollmentId: string;
    readonly identityDigest: string;
    readonly connection: ConnectionFact;
    readonly compatibility: CompatibilityFact;
    readonly engines: readonly EngineReadinessFact[];
  }): Promise<EnrollmentConnectionOutcome> {
    const enrollment = await this.#requireEnrollment(input.enrollmentId);
    const at = this.#clock();
    const outcome = reconcileWorkerConnection(enrollment, input.identityDigest, at);
    // Only an accepted connection can produce readiness: a refused attempt (a
    // revoked binding, or a new key against a decided one) is recorded as an
    // authority decision alone, so unapproved connections never overwrite the
    // observed facts of the enrolled Worker.
    if (outcome.outcome !== 'duplicate-new-key-refused' && outcome.outcome !== 'revoked-refused') {
      await this.#readiness.saveReadiness(enrollment.environmentInstanceId, {
        connection: input.connection,
        compatibility: input.compatibility,
        engines: input.engines,
      });
    }
    await this.#enrollments.save(outcome.enrollment);
    return outcome;
  }

  /** Record a fresh readiness observation without changing enrollment authority. */
  async observeReadiness(enrollmentId: string, observed: ObservedReadiness): Promise<void> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    await this.#readiness.saveReadiness(enrollment.environmentInstanceId, observed);
  }

  /** Append one readiness-probe result; prior probes are preserved. */
  async recordProbe(enrollmentId: string, probe: ProbeResultFact): Promise<ProbeResultFact> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    await this.#readiness.appendProbe(enrollment.environmentInstanceId, probe);
    return probe;
  }

  async listProbes(enrollmentId: string): Promise<readonly ProbeResultFact[]> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    return this.#readiness.listProbes(enrollment.environmentInstanceId);
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
    await this.#readiness.saveReadiness(enrollment.environmentInstanceId, observed);
  }

  /** Assemble the independent facts plus the deterministic summary. */
  async readiness(enrollmentId: string): Promise<AssembledReadiness & { readonly enrollment: EnvironmentEnrollment }> {
    const enrollment = await this.#requireEnrollment(enrollmentId);
    const [observed, probes, leases] = await Promise.all([
      this.#readiness.getReadiness(enrollment.environmentInstanceId),
      this.#readiness.listProbes(enrollment.environmentInstanceId),
      this.#currentLeases(),
    ]);
    const latestProbe = probes.length > 0 ? probes[probes.length - 1] : undefined;
    const assembled = assembleEnvironmentReadiness({
      enrollment,
      observed,
      leases,
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

  async #requireEnrollment(enrollmentId: string): Promise<EnvironmentEnrollment> {
    const enrollment = await this.#enrollments.get(enrollmentId);
    if (enrollment === undefined) {
      throw new EnrollmentError('unknown-enrollment', `Unknown enrollment: ${enrollmentId}`);
    }
    return enrollment;
  }
}
