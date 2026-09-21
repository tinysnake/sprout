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
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #operatorActor: string;
  readonly #onMutation: (() => void) | undefined;

  constructor(options: EnvironmentRecoveryServiceOptions) {
    this.#store = options.store;
    this.#leases = options.leases;
    this.#holders = options.holders ?? {};
    this.#taskRuns = options.taskRuns;
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
    const at = this.#clock();
    // The lease registry and the recovery record must agree. Marking the lease
    // recovering is what stops an ordinary acquisition from racing ahead of the
    // record; the record is written first so a crash between the two leaves the
    // stricter state (a record with no lease) rather than a reassignable lease.
    const record = this.#buildRecord(lease, input, at, existing);
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
    const all = await this.#store.list();
    for (const lease of this.#leases.leases()) {
      if (lease.state !== 'recovering' && lease.state !== 'active') continue;
      // A Human already resolved this lease; a restart must not reopen a decided
      // outcome. `forLease` returns only open records, so the resolved history is
      // checked explicitly here.
      const resolved = all.some((record) => record.leaseId === lease.id && record.phase === 'resolved');
      if (resolved) continue;
      const existing = await this.#store.forLease(lease.id);
      if (existing !== undefined) continue;
      reopened.push(
        await this.open({ leaseId: lease.id, cause: 'sprout-restart', hadActiveRun: true }),
      );
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
          reason: 'The enrolled Worker reconnected and was re-authenticated; evidence synchronization is required before any decision.',
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
    if (record.holderKind !== 'task' || record.taskId === undefined) {
      throw new EnvironmentRecoveryError(
        'holder-action-unavailable',
        'Only a Task-held lease can be resumed; a one-round run is released instead.',
      );
    }
    if (this.#holders.resumeTask === undefined) {
      throw new EnvironmentRecoveryError(
        'holder-action-unavailable',
        'Task resume is not configured on this build.',
      );
    }
    await this.#holders.resumeTask(record.taskId);
    return this.#resolve(record, 'resumed', decision, 'Human resumed the interrupted Task on its retained lease.');
  }

  /**
   * Ordinary Discard: safe Task end. Recycles Task context, releases the lease,
   * and only then records the Task cancelled — via the existing Task lifecycle,
   * so the ordering is reused rather than re-implemented here.
   */
  async discard(leaseId: string, decision: RecoveryDecisionInput = {}): Promise<EnvironmentRecoveryRecord> {
    const record = await this.#requireDecidable(leaseId);
    if (record.holderKind !== 'task' || record.taskId === undefined) {
      throw new EnvironmentRecoveryError(
        'holder-action-unavailable',
        'Only a Task-held lease can be discarded; a one-round run is released instead.',
      );
    }
    if (this.#holders.discardTask === undefined) {
      throw new EnvironmentRecoveryError(
        'holder-action-unavailable',
        'Task discard is not configured on this build.',
      );
    }
    await this.#holders.discardTask(record.taskId);
    return this.#resolve(record, 'discarded', decision, 'Human discarded the interrupted Task; context was recycled before release.');
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
    const released = this.#leases.releaseLease(leaseId);
    if (released === undefined) {
      throw new EnvironmentRecoveryError('unknown-lease', `Lease ${leaseId} is not a releasable run lease.`);
    }
    return this.#resolve(record, 'released', decision, 'Human released the interrupted one-round run after evidence was synchronized.');
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
    return record;
  }

  /** Mark a record resolved and append the permanent decision. */
  async #resolve(
    record: EnvironmentRecoveryRecord,
    kind: ReconciliationDecision['kind'],
    decision: RecoveryDecisionInput,
    defaultReason: string,
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
    this.#announce();
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
    const evidenceSynchronized = existing?.evidence !== undefined;
    const base: EnvironmentRecoveryRecord = {
      id: existing?.id ?? this.#idFactory(),
      environmentInstanceId: lease.instanceId,
      leaseId: lease.id,
      holderKind,
      holderId: lease.holderId,
      ...(lease.taskId !== undefined ? { taskId: lease.taskId } : {}),
      ...(lease.runId !== undefined ? { runId: lease.runId } : {}),
      cause: input.cause,
      phase: 'recovery',
      startedAt: existing?.startedAt ?? at,
      updatedAt: at,
      ...(existing?.reconnectObservedAt !== undefined
        ? { reconnectObservedAt: existing.reconnectObservedAt }
        : {}),
      ...(existing?.evidence !== undefined ? { evidence: existing.evidence } : {}),
      unresolvedFacts: deriveUnresolvedFacts({ holderKind, evidenceSynchronized }),
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
