import type { EnvironmentLease } from './pool.ts';
import {
  FORCE_RELEASE_CONFIRMATION,
  deriveUnresolvedFacts,
  phaseAfterEvidence,
  phaseAfterReconnect,
  sanitizeRecoveryReason,
  validateForceRelease,
  type EnvironmentRecoveryCause,
  type EnvironmentRecoveryRecord,
  type ForceReleaseRecord,
  type ForceReleaseRefusal,
  type RetainedEvidence,
  type ReconciliationDecision,
} from './recovery.ts';
import { DEFAULT_FORCE_RELEASE_REASON } from './privacy.ts';
import type { RecoveryStore } from './recovery-store.ts';

/**
 * The caller-facing Environment reconciliation and recovery capability
 * (#88, ADR-0005, ADR-0009).
 *
 * This Module owns exactly one thing: the durable recovery record that protects
 * an Environment lease whose work became uncertain, and the gates that decide
 * whether a protected lease may be resolved. It deliberately owns no Task
 * lifecycle and no lease SQL:
 *
 * - the *lease* it protects is read through the narrow `RecoveryLeasePort`, so
 *   the Environment pool remains the one owner of lease state; and
 * - the *holder* decision (ordinary Task resume/discard, emergency Task end, or
 *   a one-round run release) is performed through the `RecoveryHolderActions`
 *   port, so the Task lifecycle remains the one owner of Task context and the
 *   existing `TaskEnvironmentLifecycle` ordering is reused rather than copied.
 *
 * The safety rules live here, once:
 *
 * - a reconnect only moves a record to `reconciling` and never resolves it;
 * - retained evidence is synchronized before any ordinary decision;
 * - an interrupted run always requires a Human decision, so it is never
 *   auto-released;
 * - Force Release is available only in `recovery`, requires a concrete
 *   unresolved fact, risk acknowledgement, the exact typed confirmation, and a
 *   reason, and leaves a permanent outcome record.
 */

/** The narrow lease surface this service needs. `EnvironmentPool` satisfies it. */
export interface RecoveryLeasePort {
  getLease(leaseId: string): EnvironmentLease | undefined;
  activeLease(instanceId: string): EnvironmentLease | undefined;
  leases(): readonly EnvironmentLease[];
  markRecovering(leaseId: string): EnvironmentLease | undefined;
  releaseLease(leaseId: string): EnvironmentLease | undefined;
  resumeTaskLease(leaseId: string): EnvironmentLease | undefined;
  releaseTaskLease(leaseId: string): EnvironmentLease | undefined;
}

/**
 * The holder action one ordinary or emergency decision performs.
 *
 * Every method is optional so a build without the Task plane (and a run-only
 * test) can still recover one-round run leases. A decision whose action is
 * missing is refused rather than recorded as done.
 */
export interface RecoveryHolderActions {
  /** Restore an idle Task on its own retained lease, with no run replay. */
  clearIdleTask?(taskId: string): Promise<void>;
  /**
   * Ordinary Resume: keep the interrupted run as history and return the Task to
   * deliberate blocked work on the same Environment. Never reruns.
   */
  resumeTask?(taskId: string): Promise<void>;
  /**
   * Ordinary Discard: safe Task end that recycles Task context, releases the
   * lease, and only then marks the Task cancelled.
   */
  discardTask?(taskId: string): Promise<void>;
  /**
   * Emergency Task end for Force Release: abandon the Task, record the permanent
   * forced-release disposition, and preserve the Project workspace.
   */
  forceReleaseTask?(input: {
    readonly taskId: string;
    readonly actor: string;
    readonly reason: string;
    readonly unresolvedFacts: readonly string[];
    readonly at: number;
  }): Promise<readonly string[]>;
}

/** The verified connection facts a reconnect must present to this service. */
export interface VerifiedWorkerReconnect {
  readonly enrollmentId: string;
  readonly workerIdentityDigest?: string;
  /**
   * Attested by the enrollment authority (#171): the record's bound identity
   * was formally invalidated by an enrollment identity rotation (reset), and
   * this connection presents the Human-approved successor identity on the same
   * enrollment. Rotation is never inferred from a digest mismatch — only the
   * enrollment authority can attest it.
   */
  readonly identityRotated?: boolean;
  readonly environmentInstanceId: string;
  /** Always `true`: this service refuses a reconnect that was not authenticated. */
  readonly identityVerified: boolean;
  /** Whether the Worker protocol is inside the supported range. */
  readonly protocolCompatible: boolean;
  /** Whether every capability the record's use requires is permitted. */
  readonly permissionsAllowed: boolean;
  /** Whether an Agent run was active when the channel was lost. */
  readonly hadActiveRun: boolean;
  /** The retained evidence the Worker declared, when it declared any. */
  readonly evidence?: RetainedEvidence;
}

export type RecoveryRefusalCode =
  | ForceReleaseRefusal
  | 'unknown-recovery'
  | 'unknown-lease'
  | 'not-reconciling'
  | 'evidence-not-synchronized'
  | 'identity-not-verified'
  | 'protocol-incompatible'
  | 'permissions-denied'
  | 'holder-action-unavailable'
  | 'holder-mismatch';

export class EnvironmentRecoveryError extends Error {
  readonly code: RecoveryRefusalCode;

  constructor(code: RecoveryRefusalCode, message: string) {
    super(message);
    this.name = 'EnvironmentRecoveryError';
    this.code = code;
  }
}

export interface EnvironmentRecoveryServiceOptions {
  readonly store: RecoveryStore;
  readonly leases: RecoveryLeasePort;
  readonly holders?: RecoveryHolderActions;
  /** Every run linked to a Task, so the Force Release outcome names them all. */
  readonly taskRuns?: (taskId: string) => Promise<readonly string[]>;
  readonly workerIdentityForInstance?: (instanceId: string) => Promise<{
    readonly enrollmentId: string; readonly identityDigest: string;
  } | undefined>;
  readonly activeRunForTask?: (taskId: string) => Promise<string | undefined>;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  /** The operator identity recorded on a Force Release outcome. */
  readonly operatorActor?: string;
  /**
   * Invoked after any recovery record change (E2, #116).
   *
   * The dynamic Environment catalog observes open recovery, reconnect, evidence
   * synchronization, and resolution through this hook, so an instance's work
   * safety and eligibility follow the recovery state without a restart. An
   * observation only; it must never throw or be awaited as authority.
   */
  readonly onMutation?: () => void;
}

export interface OpenRecoveryInput {
  readonly leaseId: string;
  readonly cause: EnvironmentRecoveryCause;
  /** Whether an Agent run was active when the work was interrupted. */
  readonly hadActiveRun: boolean;
  readonly runId?: string;
  readonly enrollmentId?: string;
  readonly workerIdentityDigest?: string;
}

export interface RecoveryDecisionInput {
  readonly actor?: string;
  readonly reason?: string;
}

export class EnvironmentRecoveryService {
  readonly #store: RecoveryStore;
  readonly #leases: RecoveryLeasePort;
  readonly #holders: RecoveryHolderActions;
  readonly #taskRuns: ((taskId: string) => Promise<readonly string[]>) | undefined;
  readonly #workerIdentityForInstance: EnvironmentRecoveryServiceOptions['workerIdentityForInstance'];
  readonly #activeRunForTask: ((taskId: string) => Promise<string | undefined>) | undefined;
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #operatorActor: string;
  readonly #onMutation: (() => void) | undefined;

  constructor(options: EnvironmentRecoveryServiceOptions) {
    this.#store = options.store;
    this.#leases = options.leases;
    this.#holders = options.holders ?? {};
    this.#taskRuns = options.taskRuns;
    this.#workerIdentityForInstance = options.workerIdentityForInstance;
    this.#activeRunForTask = options.activeRunForTask;
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory ?? (() => `recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    this.#operatorActor = options.operatorActor ?? 'operator';
    this.#onMutation = options.onMutation;
  }

  /** Announce a durable recovery change to the catalog observer, never throwing. */
  #announce(): void {
    try {
      this.#onMutation?.();
    } catch {
      // Observation must never turn a durable recovery decision into a failure.
    }
  }

  /** Open (or reopen) the recovery record protecting one lease. */
  async open(input: OpenRecoveryInput): Promise<EnvironmentRecoveryRecord> {
    const lease = this.#requireLease(input.leaseId);
    const existing = await this.#store.forLease(input.leaseId);
    const identity = existing?.enrollmentId !== undefined ? undefined :
      await this.#workerIdentityForInstance?.(lease.instanceId);
    const enrollmentId = input.enrollmentId ?? identity?.enrollmentId;
    const workerIdentityDigest = input.workerIdentityDigest ?? identity?.identityDigest;
    const at = this.#clock();
    // The lease registry and the recovery record must agree. Marking the lease
    // recovering is what stops an ordinary acquisition from racing ahead of the
    // record; the record is written first so a crash between the two leaves the
    // stricter state (a record with no lease) rather than a reassignable lease.
    const record = this.#buildRecord(lease, { ...input,
      ...(enrollmentId !== undefined ? { enrollmentId } : {}),
      ...(workerIdentityDigest !== undefined ? { workerIdentityDigest } : {}),
    }, at, existing);
    await this.#store.save(record);
    this.#leases.markRecovering(input.leaseId);
    this.#announce();
    return record;
  }

  /**
   * Reopen protection for every lease a restart left uncertain.
   *
   * Called once during restart reconciliation. It never resolves anything: a
   * process restart is not proof that interrupted work is safe, so each
   * affected lease keeps (or gains) a `recovery` record until a Human decides.
   */
  async reconcileAfterRestart(): Promise<readonly EnvironmentRecoveryRecord[]> {
    const reopened: EnvironmentRecoveryRecord[] = [];
    for (const lease of this.#leases.leases()) {
      if (lease.state !== 'recovering' && lease.state !== 'active') continue;
      // A Task lease remains active after an earlier resolved Resume or idle
      // clear. A new restart is new uncertainty on that SAME held lease; old
      // resolved history must never suppress its new protective record.
      const existing = await this.#store.forLease(lease.id);
      if (existing !== undefined) {
        if (existing.evidence !== undefined || existing.phase === 'reconciling') {
          reopened.push(await this.open({ leaseId: lease.id, cause: 'sprout-restart',
            hadActiveRun: existing.interruptedRunActive !== false,
            ...(existing.runId !== undefined ? { runId: existing.runId } : {}) }));
        }
        continue;
      }
      const runId = lease.taskId !== undefined ? await this.#activeRunForTask?.(lease.taskId) : undefined;
      reopened.push(await this.open({ leaseId: lease.id, cause: 'sprout-restart', hadActiveRun: runId !== undefined || lease.holderKind !== 'task',
        ...(runId !== undefined ? { runId } : {}) }));
    }
    return reopened;
  }

  /** The open record protecting one lease, if any. */
  async forLease(leaseId: string): Promise<EnvironmentRecoveryRecord | undefined> {
    return this.#store.forLease(leaseId);
  }

  /** Every recovery record, newest first, including resolved history. */
  async list(): Promise<readonly EnvironmentRecoveryRecord[]> {
    return this.#store.list();
  }

  /** The recovery records for one Environment, newest first. */
  async listForEnvironment(environmentInstanceId: string): Promise<readonly EnvironmentRecoveryRecord[]> {
    return (await this.#store.list()).filter(
      (record) => record.environmentInstanceId === environmentInstanceId,
    );
  }

  /** Every permanent Force Release outcome for one Environment, newest first. */
  async forceReleaseHistory(environmentInstanceId: string): Promise<readonly ForceReleaseRecord[]> {
    return this.#store.listForceReleases(environmentInstanceId);
  }

  /**
   * Record a verified same-identity Worker reconnect.
   *
   * The reconnect is re-authenticated, checked for protocol compatibility and
   * capability permission, and then — only when every check passes — the record
   * moves to `reconciling`. Nothing here resolves the record, replays the run, or
   * releases the lease: a reconnect is never proof that the Environment is safe
   * to reassign (ADR-0009).
   */
  async observeReconnect(
    leaseId: string,
    reconnect: VerifiedWorkerReconnect,
  ): Promise<EnvironmentRecoveryRecord> {
    const record = await this.#requireRecord(leaseId);
    if (reconnect.identityVerified !== true) {
      throw new EnvironmentRecoveryError(
        'identity-not-verified',
        'A reconnect must re-authenticate the same enrolled Worker identity.',
      );
    }
    if (reconnect.environmentInstanceId !== record.environmentInstanceId) {
      throw new EnvironmentRecoveryError(
        'holder-mismatch',
        'The reconnecting Worker does not serve the Environment this recovery record protects.',
      );
    }
    if (record.enrollmentId !== undefined && reconnect.enrollmentId !== record.enrollmentId) {
      throw new EnvironmentRecoveryError('identity-not-verified', 'Recovery requires the original enrolled Worker identity.');
    }
    // #171: a formally rotated identity on the SAME enrollment can never return
    // to prove anything — the predecessor key is durably invalidated by the
    // enrollment reset, so demanding it would pin a no-run record unresolvably.
    // The enrollment authority attests the rotation (`identityRotated`); an
    // unexplained digest mismatch is still refused exactly as before.
    const identityRotated =
      reconnect.identityRotated === true &&
      record.workerIdentityDigest !== undefined &&
      reconnect.workerIdentityDigest !== undefined &&
      reconnect.workerIdentityDigest !== record.workerIdentityDigest;
    if (record.workerIdentityDigest !== undefined &&
        reconnect.workerIdentityDigest !== record.workerIdentityDigest &&
        !identityRotated) {
      throw new EnvironmentRecoveryError('identity-not-verified', 'Recovery requires the original enrolled Worker identity.');
    }
    if (!reconnect.protocolCompatible) {
      throw new EnvironmentRecoveryError(
        'protocol-incompatible',
        'The Worker protocol is not compatible; the Environment remains in recovery and admits no work.',
      );
    }
    if (!reconnect.permissionsAllowed) {
      throw new EnvironmentRecoveryError(
        'permissions-denied',
        'A required capability is not permitted; the Environment remains in recovery.',
      );
    }
    const at = this.#clock();
    const next: EnvironmentRecoveryRecord = {
      ...record,
      // A reconnect after a `recovery` record is progress, never resolution.
      phase: record.phase === 'resolved' ? 'resolved' : phaseAfterReconnect(),
      reconnectObservedAt: at,
      updatedAt: at,
      unresolvedFacts: deriveUnresolvedFacts({
        holderKind: record.holderKind,
        evidenceSynchronized: false,
      }),
      decisions: [
        ...record.decisions,
        {
          kind: 'reconnect-observed',
          actor: 'worker',
          at,
          reason: identityRotated
            ? 'The superseded Worker identity was formally rotated; the Human-approved successor reconnected and was re-authenticated; evidence synchronization is required before any decision.'
            : 'The enrolled Worker reconnected and was re-authenticated; evidence synchronization is required before any decision.',
        },
      ],
    };
    await this.#store.save(next);
    this.#announce();
    return next;
  }

  /**
   * Synchronize the retained evidence a reconnected Worker proved.
   *
   * This is the only path that can move a `reconciling` record to `resolved` or
   * `recovery`. A no-active-run record whose facts all check out returns to
   * `clear`; everything else becomes `recovery` and waits for a Human. The
   * interrupted run is never replayed, and no lease is released here.
   */
  async synchronizeEvidence(
    leaseId: string,
    input: { readonly evidence: RetainedEvidence; readonly hadActiveRun: boolean },
  ): Promise<EnvironmentRecoveryRecord> {
    const record = await this.#requireRecord(leaseId);
    if (record.phase !== 'reconciling') {
      throw new EnvironmentRecoveryError(
        'not-reconciling',
        'Retained evidence can only be synchronized after a verified Worker reconnect.',
      );
    }
    const at = this.#clock();
    const next: EnvironmentRecoveryRecord = {
      ...record,
      phase: phaseAfterEvidence({
        hadActiveRun: input.hadActiveRun,
        holderKind: record.holderKind,
        evidence: input.evidence,
      }),
      evidence: input.evidence,
      updatedAt: at,
      unresolvedFacts: deriveUnresolvedFacts({
        holderKind: record.holderKind,
        evidence: input.evidence,
        evidenceSynchronized: true,
      }),
      decisions: [
        ...record.decisions,
        {
          kind: 'evidence-synchronized',
          actor: 'worker',
          at,
          reason: 'The Worker synchronized its retained events and settlement evidence; no run was replayed.',
        },
      ],
    };
    if (next.phase === 'resolved' && record.holderKind === 'task' && record.taskId !== undefined) {
      if (this.#holders.clearIdleTask === undefined) throw new EnvironmentRecoveryError(
        'holder-action-unavailable', 'The idle Task cannot be restored without its retained lease.');
      await this.#holders.clearIdleTask(record.taskId);
    }
    await this.#store.save(next);
    this.#announce();
    return next;
  }

  /**
   * Ordinary Resume: keep the interrupted run as history and return the holder
   * to deliberate work on the same Environment/lease.
   *
   * Requires the record to be in `recovery` with synchronized evidence and, for
   * a Task-held lease, performs the existing Task resume action so the lease
   * holder and the Task lifecycle ordering are preserved.
   */
  async resume(leaseId: string, decision: RecoveryDecisionInput = {}): Promise<EnvironmentRecoveryRecord> {
    const record = await this.#requireDecidable(leaseId);
    const taskId = record.taskId;
    if (record.holderKind !== 'task' || taskId === undefined) {
      throw new EnvironmentRecoveryError(
        'holder-action-unavailable',
        'Only a Task-held lease can be resumed; a one-round run is released instead.',
      );
    }
    const resumeTask = this.#holders.resumeTask?.bind(this.#holders);
    if (resumeTask === undefined) {
      throw new EnvironmentRecoveryError(
        'holder-action-unavailable',
        'Task resume is not configured on this build.',
      );
    }
    return this.#resolveOrdinary(
      record,
      'resumed',
      decision,
      'Human resumed the interrupted Task on its retained lease.',
      () => resumeTask(taskId),
    );
  }

  /**
   * Ordinary Discard: safe Task end. Recycles Task context, releases the lease,
   * and only then records the Task cancelled — via the existing Task lifecycle,
   * so the ordering is reused rather than re-implemented here.
   */
  async discard(leaseId: string, decision: RecoveryDecisionInput = {}): Promise<EnvironmentRecoveryRecord> {
    const record = await this.#requireDecidable(leaseId);
    const taskId = record.taskId;
    if (record.holderKind !== 'task' || taskId === undefined) {
      throw new EnvironmentRecoveryError(
        'holder-action-unavailable',
        'Only a Task-held lease can be discarded; a one-round run is released instead.',
      );
    }
    const discardTask = this.#holders.discardTask?.bind(this.#holders);
    if (discardTask === undefined) {
      throw new EnvironmentRecoveryError(
        'holder-action-unavailable',
        'Task discard is not configured on this build.',
      );
    }
    return this.#resolveOrdinary(
      record,
      'discarded',
      decision,
      'Human discarded the interrupted Task; context was recycled before release.',
      () => discardTask(taskId),
    );
  }

  /**
   * Ordinary Release of a one-round run-held lease.
   *
   * ADR-0009 keeps the run `interrupted`; the Human confirms Release once the
   * evidence exists. This is the only ordinary decision available to a run
   * holder, and it still requires synchronized evidence.
   */
  async release(leaseId: string, decision: RecoveryDecisionInput = {}): Promise<EnvironmentRecoveryRecord> {
    const record = await this.#requireDecidable(leaseId);
    if (record.holderKind !== 'run') {
      throw new EnvironmentRecoveryError(
        'holder-mismatch',
        'A Task-held lease is resumed or discarded, not released.',
      );
    }
    return this.#resolveOrdinary(
      record,
      'released',
      decision,
      'Human released the interrupted one-round run after evidence was synchronized.',
      async () => {
        const released = this.#leases.releaseLease(leaseId);
        if (released === undefined) {
          throw new EnvironmentRecoveryError('unknown-lease', `Lease ${leaseId} is not a releasable run lease.`);
        }
      },
    );
  }

  /**
   * Human-only emergency Force Release.
   *
   * Available only in `recovery`, requires a concrete unresolved fact, risk
   * acknowledgement, the exact typed confirmation, and a reason. It records the
   * actor, time, reason, unresolved facts, affected Environment, lease, Task, and
   * runs permanently; the Project workspace is never deleted and unrecycled Task
   * context is recorded as leftover data.
   */
  async forceRelease(
    leaseId: string,
    input: {
      readonly acknowledgedRisks: boolean;
      readonly typedConfirmation: string;
      readonly reason: string;
      /** True only when the caller confirmed the Human authority explicitly. */
      readonly actor?: string;
    },
  ): Promise<ForceReleaseRecord> {
    const record = await this.#requireRecord(leaseId);
    const validation = validateForceRelease({
      phase: record.phase,
      unresolvedFacts: record.unresolvedFacts,
      acknowledgedRisks: input.acknowledgedRisks,
      typedConfirmation: input.typedConfirmation,
      reason: input.reason,
    });
    if (!validation.ok) throw new EnvironmentRecoveryError(validation.code, validation.message);

    const at = this.#clock();
    const actor = input.actor ?? this.#operatorActor;
    const reason = sanitizeRecoveryReason(input.reason, DEFAULT_FORCE_RELEASE_REASON);

    // Ordinary interruption, reconciliation, and cleanup are attempted before the
    // override. A Task release performs the emergency Task end (recording the
    // permanent disposition); a run lease is released directly. Only when that
    // cannot finish does the override become the recorded outcome.
    let affectedRunIds: readonly string[] = record.runId !== undefined ? [record.runId] : [];
    let unrecycledTaskContext = record.evidence?.taskContextRecycled !== true;
    if (record.holderKind === 'task' && record.taskId !== undefined) {
      if (this.#holders.forceReleaseTask !== undefined) {
        affectedRunIds = await this.#holders.forceReleaseTask({
          taskId: record.taskId,
          actor,
          reason,
          unresolvedFacts: record.unresolvedFacts,
          at,
        });
      } else if (this.#taskRuns !== undefined) {
        affectedRunIds = await this.#taskRuns(record.taskId);
      }
      // The Task lifecycle's emergency end commits the Task's cancelled status
      // with its lease release in one transaction; if it is configured the lease
      // is already released. Otherwise the lease registry is the last resort.
      if (this.#leases.getLease(leaseId)?.state !== 'released') {
        this.#leases.releaseTaskLease(leaseId);
      }
    } else {
      this.#leases.releaseLease(leaseId);
    }
    unrecycledTaskContext = record.evidence?.taskContextRecycled !== true;

    const outcome: ForceReleaseRecord = {
      id: this.#idFactory(),
      environmentInstanceId: record.environmentInstanceId,
      leaseId,
      holderKind: record.holderKind,
      holderId: record.holderId,
      ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
      ...(record.runId !== undefined ? { runId: record.runId } : {}),
      actor,
      at,
      reason,
      risksAcknowledged: true,
      typedConfirmation: FORCE_RELEASE_CONFIRMATION,
      unresolvedFacts: [...record.unresolvedFacts],
      affectedRunIds: [...affectedRunIds],
      projectWorkspacePreserved: true,
      unrecycledTaskContext,
    };
    await this.#store.appendForceRelease(outcome);
    this.#announce();
    await this.#resolve(record, 'force-released', { actor, reason }, `EMERGENCY FORCE RELEASE authorized: ${reason}`);
    return outcome;
  }

  async #requireRecord(leaseId: string): Promise<EnvironmentRecoveryRecord> {
    const record = await this.#store.forLease(leaseId);
    if (record === undefined) {
      throw new EnvironmentRecoveryError('unknown-recovery', `No open recovery record protects lease ${leaseId}.`);
    }
    return record;
  }

  /** A record that may be resolved by an ordinary decision. */
  async #requireDecidable(leaseId: string): Promise<EnvironmentRecoveryRecord> {
    const record = await this.#requireRecord(leaseId);
    if (record.phase !== 'recovery') {
      throw new EnvironmentRecoveryError(
        'evidence-not-synchronized',
        'An ordinary decision requires a verified reconnect and synchronized evidence first.',
      );
    }
    if (record.evidence === undefined) {
      throw new EnvironmentRecoveryError(
        'evidence-not-synchronized',
        'An ordinary decision requires synchronized retained evidence.',
      );
    }
    if (!record.evidence.engineSessionStopped || !record.evidence.turnSettlementObserved ||
        (record.runId !== undefined && record.evidence.terminalStatus === undefined) ||
        (record.holderKind === 'task' && record.evidence.taskContextPrepared !== true)) {
      throw new EnvironmentRecoveryError(
        'evidence-not-synchronized',
        'Ordinary recovery requires an acknowledged terminal outcome, engine fence, and safe held context.',
      );
    }
    return record;
  }

  /**
   * Revalidate the ADR-0009 evidence gate, then use resolve-first ordering.
   * The recovery write must finish before an independent Task/lease owner can
   * commit holder changes, so a failed recovery write cannot leave partial
   * holder state. If the holder action refuses, restore the original open
   * record; if the process stops between the two writes, the recovering lease
   * still blocks admission and restart reconciliation can reopen recovery.
   */
  async #resolveOrdinary(
    record: EnvironmentRecoveryRecord,
    kind: ReconciliationDecision['kind'],
    decision: RecoveryDecisionInput,
    defaultReason: string,
    mutateHolder: () => Promise<void>,
  ): Promise<EnvironmentRecoveryRecord> {
    const current = await this.#requireDecidable(record.leaseId);
    if (current.id !== record.id) {
      throw new EnvironmentRecoveryError(
        'evidence-not-synchronized',
        'The recovery record changed while the ordinary decision was being prepared; synchronize evidence and retry.',
      );
    }
    const resolved = await this.#resolve(current, kind, decision, defaultReason, false);
    try {
      await mutateHolder();
    } catch (error) {
      // Keep the protective recovery record open when its holder action refuses.
      // If restoration itself fails, surface both errors: the lease remains
      // protected by its existing recovering state, and startup reconciliation
      // can rebuild an open record from that lease.
      try {
        await this.#store.save(record);
        this.#announce();
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'The recovery decision failed and its protective record could not be restored.',
        );
      }
      throw error;
    }
    this.#announce();
    return resolved;
  }

  /** Mark a record resolved and append the permanent decision. */
  async #resolve(
    record: EnvironmentRecoveryRecord,
    kind: ReconciliationDecision['kind'],
    decision: RecoveryDecisionInput,
    defaultReason: string,
    announce = true,
  ): Promise<EnvironmentRecoveryRecord> {
    const at = this.#clock();
    const resolved: EnvironmentRecoveryRecord = {
      ...record,
      phase: 'resolved',
      updatedAt: at,
      decisions: [
        ...record.decisions,
        {
          kind,
          actor: 'operator',
          at,
          // A caller-supplied reason is sanitized; no reason falls back to the
          // product-owned text for the decision. The reason is never echoed
          // verbatim, so a leaked path or credential cannot reach the record.
          reason: sanitizeRecoveryReason(decision.reason, defaultReason),
        },
      ],
    };
    await this.#store.save(resolved);
    if (announce) this.#announce();
    return resolved;
  }

  #requireLease(leaseId: string): EnvironmentLease {
    const lease = this.#leases.getLease(leaseId);
    if (lease === undefined || lease.state === 'released') {
      throw new EnvironmentRecoveryError('unknown-lease', `Unknown or released lease: ${leaseId}`);
    }
    return lease;
  }

  #buildRecord(
    lease: EnvironmentLease,
    input: OpenRecoveryInput,
    at: number,
    existing: EnvironmentRecoveryRecord | undefined,
  ): EnvironmentRecoveryRecord {
    const holderKind = lease.holderKind ?? 'run';
    const base: EnvironmentRecoveryRecord = {
      id: existing?.id ?? this.#idFactory(),
      environmentInstanceId: lease.instanceId,
      ...(existing?.enrollmentId !== undefined || input.enrollmentId !== undefined
        ? { enrollmentId: existing?.enrollmentId ?? input.enrollmentId } : {}),
      ...(existing?.workerIdentityDigest !== undefined || input.workerIdentityDigest !== undefined
        ? { workerIdentityDigest: existing?.workerIdentityDigest ?? input.workerIdentityDigest } : {}),
      leaseId: lease.id,
      holderKind,
      holderId: lease.holderId,
      interruptedRunActive: input.hadActiveRun,
      ...(lease.taskId !== undefined ? { taskId: lease.taskId } : {}),
      ...(input.runId !== undefined || lease.runId !== undefined ? { runId: input.runId ?? lease.runId } : {}),
      cause: input.cause,
      phase: 'recovery',
      startedAt: existing?.startedAt ?? at,
      updatedAt: at,
      // A new channel loss invalidates prior connection proof. Keep the
      // historical decisions, but never authorize a Human action from an old
      // epoch's settlement/fence or context observation.
      unresolvedFacts: deriveUnresolvedFacts({ holderKind, evidenceSynchronized: false }),
      decisions: [
        ...(existing?.decisions ?? []),
        {
          kind: 'interrupted',
          actor: 'system',
          at,
          reason:
            input.hadActiveRun
              ? 'An Agent run was active when the Worker channel was lost; the run is interrupted and the lease is protected.'
              : 'The Environment restarted with unfinished work; the lease is protected until its facts agree.',
        },
      ],
    };
    return base;
  }
}
