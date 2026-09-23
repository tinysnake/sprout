/**
 * The one application-level Environment readiness workflow (#124, #123).
 *
 * Before this Module, readiness observation was orchestrated in three separate
 * places: Runtime's accept-time observer (startup / automatic target probe /
 * empty-target bootstrap), the Worker-layer `createWorkerProbeRequester`
 * (Human-requested probe), and the transitional `runtime.observeWorkerReadiness`
 * entry point. Each re-derived accepted authority, re-validated the untrusted
 * Worker result, and re-checked the lifecycle fence, so a later fix had to be
 * applied at every interface.
 *
 * This Module owns the whole trigger lifecycle in one processing contract:
 *
 * 1. resolve the accepted Worker connection and its current lifecycle/epoch
 *    authority (`isCurrent`);
 * 2. reserve an immutable, durable attempt identity/order before collection;
 * 3. **collect** the untrusted Worker result over the already-authenticated
 *    channel — an explicit target probe or the `worker/info` bootstrap fallback;
 * 4. **canonically validate and privacy-reduce** it through the shared ingress
 *    guard, so a missing/malformed/non-Worker/contradictory probe never reaches
 *    persistence;
 * 5. **persist** it atomically through the enrollment service's accepted-write
 *    primitive, which re-checks the same authority at the mutation boundary;
 * 6. **confirm response authority** before reporting a committed probe.
 *
 * Startup, automatic target probing, empty-target bootstrap, and Human-requested
 * probes are trigger modes of this one workflow. Target presence changes only
 * which collection command is used, never the validation or authority path.
 *
 * The Module owns no transport and no store. The gateway, the Worker collector,
 * and the enrollment service arrive as explicit
 * dependencies, so the same logic runs in production and in the accepted-Worker
 * acceptance harness. It supersedes the former Worker-layer
 * `createWorkerProbeRequester`, whose explicit-probe orchestration is now the
 * `request()` trigger of this one workflow.
 */

import type { EnvironmentEnrollmentService } from './enrollment-service.ts';
import { EnrollmentError } from './enrollment.ts';
import type { ReadinessReceipt, ReadinessRequirementScope } from './readiness.ts';
import type { ReadinessAttempt } from './readiness-store.ts';
import type { ReadinessObservationAuthority } from './readiness-authority.ts';
import { validateWorkerReadinessProbeResult } from '../worker/readiness-ingress.ts';
import type {
  WorkerInfo,
  WorkerReadinessProbeResult,
} from '../worker/protocol.ts';

/**
 * The trigger modes that reach this one workflow.
 *
 * `startup` and `automatic-target` are both observed on a newly accepted
 * connection; `empty-target-bootstrap` is the same observation when no core-owned
 * target model is configured. `human-request` is a browser-requested probe.
 */
export type ReadinessTriggerKind =
  | 'startup'
  | 'automatic-target'
  | 'empty-target-bootstrap'
  | 'human-request';

/** The minimal accepted-connection shape this workflow needs. */
export interface ReadinessAcceptance {
  readonly enrollment: { readonly id: string; readonly environmentInstanceId: string };
  readonly epoch: { readonly connectionId: string; readonly epoch: number };
  /** Core-owned target models to compare locally; never browser input. */
  readonly requiredModels: readonly string[];
  authorizeObservation?(): ReadinessObservationAuthority | undefined;
}

/** The accepted live connection for one instance, as the gateway reports it. */
export interface ReadinessLiveConnection {
  readonly enrollment: { readonly id: string };
  readonly epoch: { readonly connectionId: string; readonly epoch: number };
  /** Core-owned target models, so the transitional entry point probes the same way. */
  readonly requiredModels: readonly string[];
}

export interface ReadinessLiveGateway {
  liveFor(environmentInstanceId: string): ReadinessLiveConnection | undefined;
  authorizeObservation?(environmentInstanceId: string): ReadinessObservationAuthority | undefined;
}

/** The neutral Worker fact/probe collector over an accepted channel. */
export interface ReadinessWorkerCollector {
  info?(environmentInstanceId: string): Promise<WorkerInfo | undefined>;
  probeReadiness?(environmentInstanceId: string, attemptId?: string, requirements?: ReadinessRequirementScope): Promise<WorkerReadinessProbeResult | undefined>;
}

export interface EnvironmentReadinessWorkflowOptions {
  readonly enrollments: EnvironmentEnrollmentService;
  readonly workerGateway: ReadinessLiveGateway;
  readonly environment: ReadinessWorkerCollector;
  /** Re-project the catalog after a committed observation. */
  readonly refreshEnvironmentCatalog: () => Promise<unknown>;
  readonly resolveRequirements?: () => ReadinessRequirementScope | Promise<ReadinessRequirementScope>;
  /**
   * Schedule one bounded bootstrap retry. Injectable so a test needs no timers;
   * defaults to an unreferenced 10ms timer, exactly as before.
   */
  readonly scheduleRetry?: (run: () => void, delayMs: number) => void;
}

/** How one trigger collected its untrusted Worker result. */
type CollectionMode = 'target-probe' | 'worker-info';

/** The outcome of one untrusted collection attempt. */
type CollectionOutcome =
  | { readonly kind: 'collected'; readonly result: WorkerReadinessProbeResult }
  | { readonly kind: 'not-ready' }
  | { readonly kind: 'refused' };

export class EnvironmentReadinessWorkflow {
  readonly #enrollments: EnvironmentEnrollmentService;
  readonly #workerGateway: ReadinessLiveGateway;
  readonly #environment: ReadinessWorkerCollector;
  readonly #refreshEnvironmentCatalog: () => Promise<unknown>;
  readonly #resolveRequirements: () => ReadinessRequirementScope | Promise<ReadinessRequirementScope>;
  readonly #hasRequirementResolver: boolean;
  readonly #scheduleRetry: (run: () => void, delayMs: number) => void;
  readonly #collectingBootstrap = new Set<string>();
  readonly #acceptanceReservations = new Map<string, Promise<ReadinessAttempt | false>>();

  constructor(options: EnvironmentReadinessWorkflowOptions) {
    this.#enrollments = options.enrollments;
    this.#workerGateway = options.workerGateway;
    this.#environment = options.environment;
    this.#refreshEnvironmentCatalog = options.refreshEnvironmentCatalog;
    this.#resolveRequirements = options.resolveRequirements ?? (() => ({ requiredModels: [] }));
    this.#hasRequirementResolver = options.resolveRequirements !== undefined;
    this.#scheduleRetry =
      options.scheduleRetry ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        timer.unref();
      });
  }

  /** Begin the issue-order reservation at acceptance, before the Worker server starts. */
  reserveAccepted(acceptance: ReadinessAcceptance): void {
    const authority = acceptance.authorizeObservation?.() ??
      this.#workerGateway.authorizeObservation?.(acceptance.enrollment.environmentInstanceId);
    if (!authority || !authority.isCurrent()) return;
    const reservation = Promise.resolve(this.#resolveRequirements()).then((requirements) =>
      this.#enrollments.issueReadinessAttempt(
        acceptance.enrollment.id, authority, true, requirements.requiredModels ?? [], requirements,
      )).catch(() => false as const);
    this.#acceptanceReservations.set(acceptance.epoch.connectionId, reservation);
  }

  releaseAccepted(connectionId: string): void {
    this.#acceptanceReservations.delete(connectionId);
  }

  /**
   * Observe the readiness of a newly accepted Worker connection.
   *
   * This is the shared startup / automatic-target / empty-target-bootstrap
   * trigger. It never dials a Worker: the accepted connection is already
   * authenticated, and one of its collection modes is used.
   */
  async observeAccepted(acceptance: ReadinessAcceptance, attempt = 0, issued?: ReadinessAttempt): Promise<void> {
    if (this.#environment.info === undefined && this.#environment.probeReadiness === undefined) return;
    const { enrollment, epoch } = acceptance;
    if (!this.#isCurrent(enrollment.id, enrollment.environmentInstanceId, epoch.connectionId)) return;
    const currentEnrollment = await this.#enrollments.get(enrollment.id);
    if (
      currentEnrollment === undefined ||
      currentEnrollment.status !== 'approved' ||
      !this.#isCurrent(enrollment.id, enrollment.environmentInstanceId, epoch.connectionId)
    ) return;
    const authority = acceptance.authorizeObservation?.() ??
      this.#workerGateway.authorizeObservation?.(enrollment.environmentInstanceId);
    if (authority === undefined || !authority.isCurrent()) return;
    const requirements = await this.#resolveRequirements();
    const mode: CollectionMode =
      this.#targeted(requirements.requiredModels ?? []) ? 'target-probe' : 'worker-info';
    const ticket = issued ?? await (this.#acceptanceReservations.get(epoch.connectionId) ??
      this.#enrollments.issueReadinessAttempt(enrollment.id, authority, true, requirements.requiredModels ?? [], requirements));
    if (!ticket) return;
    // A bootstrap is one adoption per acceptance, even across Runtime restart.
    // A reread is inspection, not another measurement.
    if (await this.#enrollments.getReceipt(enrollment.id, ticket.observationId)) return;
    const current = (await this.#enrollments.readiness(enrollment.id)).currentObservation;
    if (current !== undefined && current.sequence > ticket.sequence) return;
    if (this.#collectingBootstrap.has(ticket.observationId)) return;
    this.#collectingBootstrap.add(ticket.observationId);
    let outcome: CollectionOutcome;
    try {
      outcome = await this.#collect(enrollment.environmentInstanceId, mode, ticket.observationId, ticket.requirements ?? requirements);
    } catch {
      this.#collectingBootstrap.delete(ticket.observationId);
      // A channel that cannot identify itself is already offline; the close
      // listener re-projects. A just-accepted Worker may also still be starting
      // its JSON-RPC server, so retry against this epoch only.
      this.#retry(acceptance, attempt, ticket);
      return;
    }
    this.#collectingBootstrap.delete(ticket.observationId);
    if (outcome.kind === 'not-ready') {
      this.#retry(acceptance, attempt, ticket);
      return;
    }
    // Missing, malformed, non-Worker, disallowed, or contradictory probe copies
    // are refused before any mutation.
    if (outcome.kind === 'refused') return;
    if (!authority.isCurrent()) return;
    await this.#persist(
      enrollment.id,
      authority,
      outcome.result,
      ticket,
    );
    await this.#refreshEnvironmentCatalog();
  }

  /**
   * Transitional public entry point: observe the live accepted Worker for one
   * enrollment. Delegates entirely to the one workflow; it is retained only for
   * callers that hold an enrollment id instead of an acceptance.
   */
  async observeEnrollment(enrollmentId: string): Promise<void> {
    const enrollment = await this.#enrollments.get(enrollmentId);
    if (enrollment === undefined) return;
    const live = this.#workerGateway.liveFor(enrollment.environmentInstanceId);
    if (live === undefined) return;
    if (live.enrollment.id !== enrollmentId) return;
    await this.observeAccepted({
      enrollment: { id: enrollmentId, environmentInstanceId: enrollment.environmentInstanceId },
      epoch: live.epoch,
      // Preserve the accepted connection's core-owned target models, so this
      // transitional entry point uses the same collection mode as acceptance.
      requiredModels: live.requiredModels,
      authorizeObservation: () => this.#workerGateway.authorizeObservation?.(enrollment.environmentInstanceId),
    });
  }

  /**
   * The Human-requested probe trigger.
   *
   * Resolves the live accepted Worker epoch, collects one explicit target probe
   * over the authenticated channel, persists it through the same contract, and
   * returns the committed receipt (#126). It throws on pending/revoked/reset/
   * offline/superseded states rather than reporting a stale probe, so the HTTP
   * layer maps every refusal to a non-success response.
   */
  async request(enrollmentId: string): Promise<ReadinessReceipt> {
    const enrollment = await this.#enrollments.get(enrollmentId);
    if (enrollment === undefined) throw new EnrollmentError('unknown-enrollment', 'Unknown enrollment.');
    if (enrollment.status !== 'approved') {
      throw new EnrollmentError('not-approved', 'The Environment enrollment is not approved.');
    }
    const authority = this.#workerGateway.authorizeObservation?.(enrollment.environmentInstanceId);
    if (authority === undefined || !authority.isCurrent()) {
      throw new Error('the Environment Worker is offline');
    }
    const live = this.#workerGateway.liveFor(enrollment.environmentInstanceId);
    if (live?.epoch.connectionId !== authority.connectionId) throw new Error('the Environment Worker is offline');
    const reservation = this.#acceptanceReservations.get(authority.connectionId);
    if (reservation) await reservation;
    if (!authority.isCurrent()) throw new Error('the Environment Worker is offline');
    const requirements = await this.#resolveRequirements();
    const ticket = await this.#enrollments.issueReadinessAttempt(enrollment.id, authority, false, requirements.requiredModels ?? [], requirements);
    if (!ticket) throw new Error('the Environment Worker is offline');
    const rawResult = await this.#environment.probeReadiness?.(enrollment.environmentInstanceId, ticket.observationId,
      this.#hasRequirementResolver ? ticket.requirements : undefined);
    if (rawResult === undefined) throw new Error('the Environment Worker is offline');
    const result = validateWorkerReadinessProbeResult(rawResult);
    if (result === undefined) {
      throw new Error('the Environment Worker returned an invalid readiness probe result');
    }
    const delivery = result.attemptId !== undefined && result.attemptId !== ticket.observationId
      ? await this.#enrollments.getReadinessAttempt(enrollment.id, result.attemptId, authority)
      : ticket;
    if (!delivery || !delivery.requirements || JSON.stringify(delivery.requirements) !== JSON.stringify(ticket.requirements)) {
      throw new Error('the Environment Worker returned an unknown readiness attempt');
    }
    if (!authority.isCurrent()) {
      throw new Error('the readiness probe result belongs to a superseded Worker connection epoch');
    }
    const receipt = await this.#persist(enrollment.id, authority, result, delivery);
    if (!receipt && authority.isCurrent()) {
      const prior = await this.#enrollments.getReceipt(enrollment.id, delivery.observationId);
      if (prior && authority.isCurrent()) {
        throw new EnrollmentError('conflicting-observation', 'The Worker changed content for an issued readiness attempt.');
      }
      const current = (await this.#enrollments.readiness(enrollment.id)).currentObservation;
      if (current && current.sequence > delivery.sequence && authority.isCurrent()) {
        throw new EnrollmentError('superseded-observation', 'A later-issued readiness observation superseded this attempt.');
      }
    }
    if (!receipt || !authority.isCurrent()) {
      throw new EnrollmentError('superseded-observation', 'The readiness receipt is no longer current.');
    }
    await this.#refreshEnvironmentCatalog();
    if (!authority.isCurrent()) {
      throw new Error('the readiness probe result belongs to a superseded Worker connection epoch');
    }
    // Direct retrieval of the exact canonical committed observation by its receipt (#126):
    const committed = await this.#enrollments.getReceipt(enrollment.id, receipt.observationId);
    const current = await this.#enrollments.readiness(enrollment.id);
    // Final authority check after the catalog refresh: a revoke/reset can land
    // inside that await, and a response must never carry a probe from an epoch
    // the lifecycle has since invalidated.
    if (!authority.isCurrent() || committed === undefined || current.readiness.observationId !== receipt.observationId) {
      if (authority.isCurrent() && committed !== undefined) {
        throw new EnrollmentError('superseded-observation', 'The readiness receipt is no longer current.');
      }
      throw new Error('the readiness probe result belongs to a superseded Worker connection epoch');
    }
    return committed;
  }

  /**
   * Whether an accepted connection should collect an explicit target probe.
   *
   * Target *presence* selects a collection command, never a weaker validation
   * path: both modes cross the same canonical ingress guard and authority fence.
   * A connection with a required model falls back to `worker/info` when this
   * Worker exposes no probe method.
   */
  #targeted(requiredModels: readonly string[]): boolean {
    return requiredModels.length > 0 && this.#environment.probeReadiness !== undefined;
  }

  /** Whether one accepted connection still owns the current instance authority. */
  #isCurrent(enrollmentId: string, environmentInstanceId: string, connectionId: string): boolean {
    return (
      this.#workerGateway.liveFor(environmentInstanceId)?.enrollment.id === enrollmentId &&
      this.#workerGateway.liveFor(environmentInstanceId)?.epoch.connectionId === connectionId
    );
  }

  /**
   * Collect one untrusted Worker result using one of the workflow's collection
   * modes.
   *
   * `not-ready` means the bootstrap `worker/info` fact is not available yet and a
   * bounded retry is appropriate; `refused` means the result crossed the wire but
   * was missing or malformed and must never mutate readiness.
   */
  async #collect(
    environmentInstanceId: string,
    mode: CollectionMode,
    attemptId: string,
    requirements?: ReadinessRequirementScope,
  ): Promise<CollectionOutcome> {
    if (mode === 'target-probe') {
      const rawProbe = await this.#environment.probeReadiness?.(environmentInstanceId, attemptId, requirements);
      const result = validateWorkerReadinessProbeResult(rawProbe);
      return result === undefined || (result.attemptId !== undefined && result.attemptId !== attemptId)
        ? { kind: 'refused' } : { kind: 'collected', result };
    }
    const info = await this.#environment.info?.(environmentInstanceId);
    if (info?.readiness === undefined) return { kind: 'not-ready' };
    // With no configured target model the startup observation comes from the
    // authenticated `worker/info` fallback. Reconstruct its complete probe
    // result from the embedded fact so it crosses the exact same closed-shape
    // validator and sanitizer as an explicit POST.
    const result = validateWorkerReadinessProbeResult(info.readiness.protocolVersion === '3'
      ? info.readiness : { readiness: info.readiness, probe: info.readiness.probe });
    return result === undefined ? { kind: 'refused' } : { kind: 'collected', result };
  }

  /**
   * The one persistence coordination point.
   *
   * The enrollment service re-validates the complete result, binds it to the
   * owner-issued capability, and commits readiness plus its required probe
   * atomically; the store re-checks the live authority at its mutation
   * boundary, so a replacement/disconnect cannot cross the check/write window.
   */
  async #persist(
    enrollmentId: string,
    authority: ReadinessObservationAuthority,
    result: WorkerReadinessProbeResult,
    attempt: ReadinessAttempt,
  ): Promise<ReadinessReceipt | undefined> {
    return this.#enrollments.recordReadinessObservation(enrollmentId, result, authority, { attempt });
  }

  /** Schedule one bounded bootstrap retry against the same accepted epoch. */
  #retry(acceptance: ReadinessAcceptance, attempt: number, issued: ReadinessAttempt): void {
    const { enrollment, epoch } = acceptance;
    if (attempt >= 2_000) return;
    if (!this.#isCurrent(enrollment.id, enrollment.environmentInstanceId, epoch.connectionId)) return;
    this.#scheduleRetry(() => {
      void this.observeAccepted(acceptance, attempt + 1, issued).catch(() => undefined);
    }, 10);
  }
}
