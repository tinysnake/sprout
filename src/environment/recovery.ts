/**
 * Interrupted-work recovery vocabulary and safety rules (#88, ADR-0005, ADR-0009).
 *
 * Losing a Worker channel during an Agent run must never silently reassign an
 * Environment. This Module owns the durable vocabulary for that protection: one
 * recovery record per protected lease, the neutral retained evidence a
 * reconnecting Worker synchronizes, and the deterministic safety rules that
 * decide whether uncertain work is still *reconciling*, is blocked in *recovery*
 * awaiting an authorized decision, or has been *resolved*.
 *
 * Three distinctions are load-bearing and are deliberately impossible to
 * collapse here:
 *
 * - **Reconnect is not proof.** A verified same-identity reconnect only moves a
 *   record into `reconciling`; it never resolves it and never makes the
 *   Environment reassignable (ADR-0009).
 * - **Reconciling is not recovery.** `reconciling` means evidence is still being
 *   synchronized; `recovery` means the facts are in and an authorized Human or
 *   Task lead decision is required.
 * - **Unresolved facts are named, not implied.** Force Release and Task lead
 *   authority override are refused unless at least one concrete unresolved fact
 *   is recorded, so neither override is applied to an unexplained state.
 *
 * Like `readiness.ts`, this Module is free of `node:*` so the browser wire
 * contract can share its vocabulary.
 */

import { sanitizeOperatorText, DEFAULT_FORCE_RELEASE_REASON, DEFAULT_RECOVERY_REASON } from './privacy.ts';

/** Why an Environment's work became uncertain. */
export type EnvironmentRecoveryCause =
  | 'worker-channel-lost'
  | 'sprout-restart'
  | 'begin-failed'
  | 'lease-overdue'
  | 'cleanup-failed';

/**
 * The phase of one recovery record.
 *
 * `reconciling` is active evidence synchronization; `recovery` is a settled
 * uncertain state blocked on an authorized decision; `resolved` is terminal history.
 */
export type EnvironmentRecoveryPhase = 'reconciling' | 'recovery' | 'resolved';

/**
 * The neutral facts a reconnected Worker synchronizes about interrupted work.
 *
 * Every field is a Worker-observed fact, never a repairable claim: the core
 * records what the same identity proved rather than deciding on the Worker's
 * behalf. `undefined` is honest "not proven", which is exactly what keeps a fact
 * unresolved.
 */
export interface RetainedEvidence {
  /** How many events the Worker retained for the interrupted turn. */
  readonly retainedEventCount: number;
  /** Whether the interrupted turn reached a durable terminal settlement. */
  readonly turnSettlementObserved: boolean;
  /** The neutral terminal status, never the engine's result text. */
  readonly terminalStatus?: 'completed' | 'failed' | 'interrupted' | 'stopped';
  /** Whether the Worker proved the previous engine session stopped. */
  readonly engineSessionStopped: boolean;
  /** Whether the Worker confirmed the Task context was recycled. */
  readonly taskContextRecycled: boolean;
  /** Fresh Worker-side ownership-manifest check for the held Task context. */
  readonly taskContextPrepared?: boolean;
}

/** One durable reconciliation decision, retained in order for the whole record. */
export interface ReconciliationDecision {
  readonly kind:
    | 'interrupted'
    | 'reconnect-observed'
    | 'evidence-synchronized'
    | 'resumed'
    | 'discarded'
    | 'released'
    | 'force-released'
    | 'authority-override-released';
  /** `worker` proves identity; `system` is Sprout; `operator` is the Human; `task-lead` is the authorized lead. */
  readonly actor: 'worker' | 'system' | 'operator' | 'task-lead';
  readonly actorId?: string;
  readonly authorityTaskId?: string;
  readonly at: number;
  /** A bounded, sanitized explanation suitable for an operator. */
  readonly reason: string;
}

export interface RemoteWorkRecoveryEvidence {
  readonly journalAvailable: boolean;
  readonly workspaceOperations: {
    readonly running: number;
    readonly unknown: number;
    readonly cancelRequested: number;
    readonly recoveryRequired: number;
  };
  readonly projectMcpOperations: { readonly running: number; readonly uncertain: number };
  readonly projectMcpProcesses: {
    readonly starting: number;
    readonly running: number;
    readonly stopping: number;
    readonly uncertain: number;
  };
}

export const EMPTY_REMOTE_WORK_RECOVERY_EVIDENCE: RemoteWorkRecoveryEvidence = {
  journalAvailable: true,
  workspaceOperations: { running: 0, unknown: 0, cancelRequested: 0, recoveryRequired: 0 },
  projectMcpOperations: { running: 0, uncertain: 0 },
  projectMcpProcesses: { starting: 0, running: 0, stopping: 0, uncertain: 0 },
};

export function remoteWorkHasUnresolvedFacts(evidence: RemoteWorkRecoveryEvidence): boolean {
  return !evidence.journalAvailable || Object.values(evidence.workspaceOperations).some(count => count > 0) ||
    Object.values(evidence.projectMcpOperations).some(count => count > 0) ||
    Object.values(evidence.projectMcpProcesses).some(count => count > 0);
}

/** One durable recovery record protecting one lease. */
export interface EnvironmentRecoveryRecord {
  readonly id: string;
  readonly environmentInstanceId: string;
  /** The enrolled Worker identity that owned the lost channel, never a browser claim. */
  readonly enrollmentId?: string;
  readonly workerIdentityDigest?: string;
  readonly leaseId: string;
  readonly holderKind: 'task' | 'run';
  /** The holder identity, so ordinary decisions can prove they match it. */
  readonly holderId: string;
  readonly taskId?: string;
  readonly runId?: string;
  /** Durable interruption classification; unknown is conservatively active. */
  readonly interruptedRunActive?: boolean;
  readonly cause: EnvironmentRecoveryCause;
  readonly phase: EnvironmentRecoveryPhase;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** When the same Worker identity was last verified against this record. */
  readonly reconnectObservedAt?: number;
  /** The evidence the reconnecting Worker synchronized, once it has. */
  readonly evidence?: RetainedEvidence;
  /** Core-reconciled remote outcomes, separate from Worker engine evidence. */
  readonly remoteWorkEvidence?: RemoteWorkRecoveryEvidence;
  /** Every concrete fact still unproven, computed from the evidence. */
  readonly unresolvedFacts: readonly string[];
  readonly decisions: readonly ReconciliationDecision[];
}

/**
 * One permanent Force Release outcome.
 *
 * ADR-0009 makes the override durable history: it names the actor, time, reason,
 * unresolved facts, Environment, lease, Task, and runs, and the work record it
 * leaves behind survives the Environment becoming Green again.
 */
export interface ForceReleaseRecord {
  readonly id: string;
  readonly environmentInstanceId: string;
  readonly leaseId: string;
  readonly holderKind: 'task' | 'run';
  readonly holderId: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly actor: string;
  readonly at: number;
  readonly reason: string;
  readonly risksAcknowledged: true;
  /** The exact typed confirmation the Human supplied. */
  readonly typedConfirmation: string;
  readonly unresolvedFacts: readonly string[];
  /** Every run affected by the override, so none is silently forgotten. */
  readonly affectedRunIds: readonly string[];
  /** ADR-0009: the Project workspace is never deleted by an override. */
  readonly projectWorkspacePreserved: true;
  /** Unrecycled Task context is recorded as leftover data, never implied clean. */
  readonly unrecycledTaskContext: boolean;
}

export interface TaskLeadAuthorityOverrideReleaseRecord {
  readonly id: string;
  readonly action: 'task-lead-authority-override-release';
  readonly environmentInstanceId: string;
  readonly leaseId: string;
  readonly holderKind: 'run';
  readonly holderId: string;
  readonly runId: string;
  readonly authorityTaskId: string;
  readonly actorId: string;
  readonly actorKind: 'human' | 'agent';
  readonly at: number;
  readonly reason: string;
  readonly risksAcknowledged: true;
  readonly unresolvedFacts: readonly string[];
  /** Snapshot keeps remote outcomes explicitly unconfirmed after the lease is gone. */
  readonly remoteWorkEvidence: RemoteWorkRecoveryEvidence;
}

/** The exact phrase a Human must type to authorize Force Release. */
export const FORCE_RELEASE_CONFIRMATION = 'FORCE RELEASE';

export type ForceReleaseRefusal =
  | 'not-in-recovery'
  | 'no-unresolved-facts'
  | 'risks-not-acknowledged'
  | 'typed-confirmation-mismatch'
  | 'reason-required';

export interface ForceReleaseRequestInput {
  readonly phase: EnvironmentRecoveryPhase;
  readonly unresolvedFacts: readonly string[];
  readonly acknowledgedRisks: boolean;
  readonly typedConfirmation: string;
  readonly reason: string;
}

export type ForceReleaseValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ForceReleaseRefusal; readonly message: string };

/**
 * Validate a Force Release authorization.
 *
 * The checks run in the order ADR-0009 states them, and every refusal names the
 * missing condition. Force Release is available **only** for a lease already in
 * `recovery`: a `reconciling` record is still synchronizing evidence, so the
 * ordinary path has not been exhausted and the override is refused.
 */
export function validateForceRelease(input: ForceReleaseRequestInput): ForceReleaseValidation {
  if (input.phase !== 'recovery') {
    return {
      ok: false,
      code: 'not-in-recovery',
      message: 'Force Release is available only for a lease already in recovery.',
    };
  }
  if (input.unresolvedFacts.length === 0) {
    return {
      ok: false,
      code: 'no-unresolved-facts',
      message: 'Force Release requires at least one recorded unresolved fact.',
    };
  }
  if (input.acknowledgedRisks !== true) {
    return {
      ok: false,
      code: 'risks-not-acknowledged',
      message: 'Force Release requires explicit risk acknowledgement.',
    };
  }
  if (input.typedConfirmation !== FORCE_RELEASE_CONFIRMATION) {
    return {
      ok: false,
      code: 'typed-confirmation-mismatch',
      message: `Force Release requires the typed confirmation "${FORCE_RELEASE_CONFIRMATION}".`,
    };
  }
  if (input.reason.trim() === '') {
    return {
      ok: false,
      code: 'reason-required',
      message: 'Force Release requires a written reason.',
    };
  }
  return { ok: true };
}

/** Product-owned text for each unresolved fact, so the list is deterministic. */
export const UNRESOLVED_FACT_ENGINE_SESSION =
  'The Worker has not proved the interrupted engine session stopped.';
export const UNRESOLVED_FACT_SETTLEMENT =
  'The interrupted run has no durable terminal settlement and no retained events.';
export const UNRESOLVED_FACT_TASK_CONTEXT =
  'The Task context has not been proved owned by this lease or safely recycled on the Environment host.';
export const UNRESOLVED_FACT_WORKER_OFFLINE =
  'The Worker channel is lost; no retained evidence has been synchronized.';

/**
 * Derive the concrete unresolved facts from retained evidence.
 *
 * A record with no evidence yet is unresolved for the decisive reason that
 * nothing was synchronized, which is what keeps a reconnect-only state from
 * looking safe. Pure and deterministic: the same facts always name the same
 * reasons, so the Force Release manifest cannot drift from the state it explains.
 */
export function deriveUnresolvedFacts(input: {
  readonly holderKind: 'task' | 'run';
  readonly evidence?: RetainedEvidence;
  readonly remoteWorkEvidence?: RemoteWorkRecoveryEvidence;
  /** True once the same Worker identity reconnected and synchronized evidence. */
  readonly evidenceSynchronized: boolean;
}): readonly string[] {
  const facts: string[] = [];
  if (!input.evidenceSynchronized || input.evidence === undefined) {
    facts.push(UNRESOLVED_FACT_WORKER_OFFLINE);
  } else {
    if (!input.evidence.engineSessionStopped) facts.push(UNRESOLVED_FACT_ENGINE_SESSION);
    if (!input.evidence.turnSettlementObserved) facts.push(UNRESOLVED_FACT_SETTLEMENT);
    if (input.holderKind === 'task' && !input.evidence.taskContextRecycled && !input.evidence.taskContextPrepared) {
      facts.push(UNRESOLVED_FACT_TASK_CONTEXT);
    }
  }
  const remote = input.remoteWorkEvidence;
  if (remote !== undefined) {
    if (!remote.journalAvailable) facts.push('The remote operation journal could not be checked; operation and process outcomes remain unverified.');
    const workspaceCount = Object.values(remote.workspaceOperations).reduce((sum, count) => sum + count, 0);
    if (workspaceCount > 0) facts.push(`${workspaceCount} remote workspace operation(s) do not have a confirmed terminal outcome.`);
    const mcpOperationCount = Object.values(remote.projectMcpOperations).reduce((sum, count) => sum + count, 0);
    if (mcpOperationCount > 0) facts.push(`${mcpOperationCount} Project MCP tool call(s) do not have a confirmed terminal outcome.`);
    const mcpProcessCount = Object.values(remote.projectMcpProcesses).reduce((sum, count) => sum + count, 0);
    if (mcpProcessCount > 0) facts.push(`${mcpProcessCount} Project MCP process(es) have not been confirmed stopped.`);
  }
  return facts;
}

/**
 * Whether a record with synchronized evidence may resolve to `clear`.
 *
 * ADR-0009 is explicit: only the case where **no Agent run was active** may
 * return to clear automatically, and only after the Worker proved there is no
 * leftover engine session and its Task context and lease agree. An interrupted
 * run always settles into `recovery` because an authorized Human decision is
 * required for ordinary Resume or Discard, or a Task lead may explicitly
 * authority-override release another Agent run lease; it is never auto-released.
 */
export function canAutoResolve(input: {
  readonly hadActiveRun: boolean;
  readonly holderKind: 'task' | 'run';
  readonly evidence: RetainedEvidence;
  readonly remoteWorkEvidence?: RemoteWorkRecoveryEvidence;
}): boolean {
  if (input.hadActiveRun) return false;
  if (input.holderKind !== 'task') return false;
  if (input.remoteWorkEvidence !== undefined && remoteWorkHasUnresolvedFacts(input.remoteWorkEvidence)) return false;
  if (!input.evidence.engineSessionStopped) return false;
  if (!input.evidence.taskContextPrepared) return false;
  return true;
}

/**
 * The phase after a verified same-identity reconnect.
 *
 * Always `reconciling`. A reconnect is not proof that an Environment is safe to
 * reassign (ADR-0009), so no reconnect path returns `resolved`.
 */
export function phaseAfterReconnect(): EnvironmentRecoveryPhase {
  return 'reconciling';
}

/**
 * The phase after retained evidence is synchronized.
 *
 * `resolved` only for the no-active-run case above; otherwise `recovery`, which
 * requires an authorized Human decision, including a Task lead's bounded
 * authority override for another Agent run lease.
 */
export function phaseAfterEvidence(input: {
  readonly hadActiveRun: boolean;
  readonly holderKind: 'task' | 'run';
  readonly evidence: RetainedEvidence;
  readonly remoteWorkEvidence?: RemoteWorkRecoveryEvidence;
}): EnvironmentRecoveryPhase {
  return canAutoResolve(input) ? 'resolved' : 'recovery';
}

/** The minimal lease fact work safety needs, so this Module stays lease-free. */
export interface RecoverySafetyFact {
  readonly instanceId: string;
  readonly state: string;
}

/**
 * Project recovery records **and** the lease registry into work safety.
 *
 * A recovery record is authoritative: a `reconciling` or `recovery` record wins
 * over a lease that merely looks active, so a stale lease row can never make
 * uncertain work appear safe. The lease is consulted only when no recovery
 * record exists for the instance.
 */
export function workSafetyFromRecovery(
  records: readonly {
    readonly environmentInstanceId: string;
    readonly phase: EnvironmentRecoveryPhase;
  }[],
  leases: readonly RecoverySafetyFact[],
  environmentId: string,
): 'clear' | 'held' | 'reconciling' | 'recovery' {
  let reconciling = false;
  for (const record of records) {
    if (record.environmentInstanceId !== environmentId) continue;
    if (record.phase === 'recovery') return 'recovery';
    if (record.phase === 'reconciling') reconciling = true;
  }
  if (reconciling) return 'reconciling';
  let held = false;
  for (const lease of leases) {
    if (lease.instanceId !== environmentId) continue;
    if (lease.state === 'recovering') return 'recovery';
    if (lease.state === 'active') held = true;
  }
  return held ? 'held' : 'clear';
}

/** Sanitize one durable recovery decision or force-release reason. */
export function sanitizeRecoveryReason(value: string | undefined, fallback: string): string {
  return sanitizeOperatorText(value, { fallback });
}

export { DEFAULT_FORCE_RELEASE_REASON, DEFAULT_RECOVERY_REASON };
