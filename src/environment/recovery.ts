/**
 * Interrupted-work recovery vocabulary and safety rules (#88, ADR-0005, ADR-0009).
 *
 * Losing a Worker channel during an Agent run must never silently reassign an
 * Environment. This Module owns the durable vocabulary for that protection: one
 * recovery record per protected lease, the neutral retained evidence a
 * reconnecting Worker synchronizes, and the deterministic safety rules that
 * decide whether uncertain work is still *reconciling*, is blocked in *recovery*
 * awaiting a Human decision, or has been *resolved*.
 *
 * Three distinctions are load-bearing and are deliberately impossible to
 * collapse here:
 *
 * - **Reconnect is not proof.** A verified same-identity reconnect only moves a
 *   record into `reconciling`; it never resolves it and never makes the
 *   Environment reassignable (ADR-0009).
 * - **Reconciling is not recovery.** `reconciling` means evidence is still being
 *   synchronized; `recovery` means the facts are in and a Human must decide.
 * - **Unresolved facts are named, not implied.** Force Release is refused unless
 *   at least one concrete unresolved fact is recorded, so the override can never
 *   be applied to a state nobody can explain.
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
  | 'cleanup-failed';

/**
 * The phase of one recovery record.
 *
 * `reconciling` is active evidence synchronization; `recovery` is a settled
 * uncertain state blocked on a Human decision; `resolved` is terminal history.
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
  /** Whether the Worker proved the previous engine session stopped. */
  readonly engineSessionStopped: boolean;
  /** Whether the Worker confirmed the Task context was recycled. */
  readonly taskContextRecycled: boolean;
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
    | 'force-released';
  /** `worker` proves identity; `system` is Sprout; `operator` is the Human. */
  readonly actor: 'worker' | 'system' | 'operator';
  readonly at: number;
  /** A bounded, sanitized explanation suitable for an operator. */
  readonly reason: string;
}

/** One durable recovery record protecting one lease. */
export interface EnvironmentRecoveryRecord {
  readonly id: string;
  readonly environmentInstanceId: string;
  readonly leaseId: string;
  readonly holderKind: 'task' | 'run';
  /** The holder identity, so ordinary decisions can prove they match it. */
  readonly holderId: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly cause: EnvironmentRecoveryCause;
  readonly phase: EnvironmentRecoveryPhase;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** When the same Worker identity was last verified against this record. */
  readonly reconnectObservedAt?: number;
  /** The evidence the reconnecting Worker synchronized, once it has. */
  readonly evidence?: RetainedEvidence;
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
  'The Task context has not been confirmed recycled on the Environment host.';
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
  /** True once the same Worker identity reconnected and synchronized evidence. */
  readonly evidenceSynchronized: boolean;
}): readonly string[] {
  if (!input.evidenceSynchronized || input.evidence === undefined) {
    return [UNRESOLVED_FACT_WORKER_OFFLINE];
  }
  const facts: string[] = [];
  if (!input.evidence.engineSessionStopped) facts.push(UNRESOLVED_FACT_ENGINE_SESSION);
  if (!input.evidence.turnSettlementObserved || input.evidence.retainedEventCount === 0) {
    facts.push(UNRESOLVED_FACT_SETTLEMENT);
  }
  if (input.holderKind === 'task' && !input.evidence.taskContextRecycled) {
    facts.push(UNRESOLVED_FACT_TASK_CONTEXT);
  }
  return facts;
}

/**
 * Whether a record with synchronized evidence may resolve to `clear`.
 *
 * ADR-0009 is explicit: only the case where **no Agent run was active** may
 * return to clear automatically, and only after the Worker proved there is no
 * leftover engine session and its Task context and lease agree. An interrupted
 * run always settles into `recovery` because a Human must decide Resume or
 * Discard; it is never auto-released.
 */
export function canAutoResolve(input: {
  readonly hadActiveRun: boolean;
  readonly holderKind: 'task' | 'run';
  readonly evidence: RetainedEvidence;
}): boolean {
  if (input.hadActiveRun) return false;
  if (!input.evidence.engineSessionStopped) return false;
  if (input.holderKind === 'task' && !input.evidence.taskContextRecycled) return false;
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
 * demands a Human Resume, Discard, Release, or Force Release.
 */
export function phaseAfterEvidence(input: {
  readonly hadActiveRun: boolean;
  readonly holderKind: 'task' | 'run';
  readonly evidence: RetainedEvidence;
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
