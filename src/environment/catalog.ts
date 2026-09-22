/**
 * The durable Environment catalog and its dynamic, instance-keyed admission
 * projection (E2, #116, ADR-0008, ADR-0009, ADR-0012).
 *
 * Enrolled Environment instances are the dynamic execution catalog. This Module
 * turns the durable enrollment authority plus the observed readiness facts into
 * one inspectable entry per **environment instance id**, and decides whether that
 * instance is currently eligible to admit automatic Project/run work.
 *
 * Two rules make the projection honest:
 *
 * - An instance is always a catalog entry while its enrollment exists, whatever
 *   the connectivity, compatibility, permission, archive, revocation, or
 *   recovery state. Offline never means deleted, and a revoked or archived
 *   instance keeps its identity and history even though it admits no new work.
 * - Eligibility is the conservative intersection of the independent facts:
 *   approved enrollment, current Worker connection epoch, protocol compatible,
 *   required capability permitted, work safe, and every required readiness fact
 *   established. `unknown` never counts as ready (ADR-0013).
 *
 * The entries are keyed by the **environment instance id** the enrollment names,
 * so a lookup by instance id always resolves the same object the execution port
 * and the lease registry use. The Worker's accepted connection is keyed the same
 * way, so an inbound connection never creates or dials a production Worker; it
 * only becomes visible as a live fact on an entry that already exists.
 *
 * This Module is deliberately pure: it owns no store, no transport, and no
 * lease. The runtime assembles the inputs and the pool consumes the eligible
 * membership, so the same projection runs over in-memory and SQLite facts.
 */

import type { EnvironmentDefinition, EnvironmentInstance, EnvironmentPlatform } from './model.ts';
import type { EnvironmentEnrollment } from './enrollment.ts';
import { normalizeEnrollment } from './enrollment.ts';
import type { ObservedReadiness } from './readiness-store.ts';
import {
  assembleEnvironmentReadiness,
  type AssembledReadiness,
} from './readiness-service.ts';
import type {
  ReadinessProbeFact,
  ProtocolVersionRange,
  WorkSafetyState,
} from './readiness.ts';

/**
 * The capability a run must be permitted to acquire for automatic admission.
 *
 * The lease-bearing `agent-run` capability is the one capability that gates
 * execution. A capability the enrollment never requested is not a fabricated
 * requirement (ADR-0008), but an instance whose `agent-run` permission is not
 * granted is not work-ready.
 */
export const ADMISSION_CAPABILITY = 'agent-run';

/** Why one environment instance can not currently admit new work. */
export type EnvironmentAdmissionRefusal =
  | 'unknown-instance'
  | 'revoked'
  | 'archived'
  | 'not-approved'
  | 'permission-incomplete'
  | 'unsupported-platform'
  | 'not-current-epoch'
  | 'work-unsafe'
  | 'readiness-unknown';

export type EnvironmentAdmission =
  | {
      readonly ok: true;
      readonly instanceId: string;
      readonly enrollmentId: string;
    }
  | {
      readonly ok: false;
      readonly instanceId: string;
      readonly reason: EnvironmentAdmissionRefusal;
      /** The decisive human-readable reason from the readiness projection. */
      readonly detail: string;
    };

/**
 * One catalog entry input: the durable enrollment plus the independent facts
 * that are supplied from outside this pure Module.
 *
 * `currentEpoch` is the accepted connection epoch the gateway currently holds
 * for the enrollment, or `undefined` when no live accepted connection exists.
 * A `undefined` epoch is not eligible: eligibility is never inferred from the
 * presence of a stored fact.
 */
export interface EnvironmentCatalogInput {
  readonly enrollment: EnvironmentEnrollment;
  readonly observed: ObservedReadiness | undefined;
  readonly workSafety: WorkSafetyState;
  readonly currentEpoch: number | undefined;
  readonly probe?: ReadinessProbeFact;
  readonly requiredEngines: readonly string[];
  readonly supportedProtocol: ProtocolVersionRange;
  readonly now: number;
  /**
   * The directory runs execute in, when the instance can state one.
   *
   * An enrolled instance usually leaves this to the Worker (the Project
   * workspace is the authority), so it is optional.
   */
  readonly workingDirectory?: string;
}

/** One inspectable catalog entry, with the deterministic readiness projection. */
export interface EnvironmentCatalogEntry {
  readonly instanceId: string;
  readonly enrollmentId: string;
  readonly enrollment: EnvironmentEnrollment;
  readonly definition: EnvironmentDefinition;
  readonly instance: EnvironmentInstance;
  readonly observed: ObservedReadiness | undefined;
  readonly readiness: AssembledReadiness;
  readonly currentEpoch: number | undefined;
  readonly eligible: boolean;
}

/** The platform-specific definition id an enrolled instance declares. */
export function enrolledDefinitionId(platform: EnvironmentPlatform): string {
  return `enrolled-${platform}`;
}

/** Narrow a Worker-reported platform to a durable Environment platform. */
function asEnvironmentPlatform(value: string): EnvironmentPlatform {
  return value === 'macos' || value === 'container' || value === 'windows' ? value : 'unknown';
}

/**
 * The one definition every enrolled instance of a platform shares.
 *
 * Capabilities and their lease rules are the same everywhere (ADR-0003), which
 * is why the lease registry needs no platform-specific rule; the platform is the
 * only difference and it is recorded on the definition.
 */
export function enrolledEnvironmentDefinition(platform: EnvironmentPlatform): EnvironmentDefinition {
  return {
    id: enrolledDefinitionId(platform),
    platform,
    capabilities: [
      { name: 'agent-run', requiresLease: true },
      { name: 'read-only-investigation', requiresLease: false },
    ],
  };
}

/** Build the catalog entry for one input, computing eligibility once. */
export function projectCatalogEntry(input: EnvironmentCatalogInput): EnvironmentCatalogEntry {
  const enrollment = normalizeEnrollment(input.enrollment);
  const currentEpochReadiness =
    enrollment.status === 'approved' &&
    input.currentEpoch !== undefined &&
    input.observed?.enrollmentId === enrollment.id &&
    input.observed.connectionEpoch === input.currentEpoch;
  // A pending/revoked/reset enrollment may have inspectable durable history,
  // but it has no current fact projection. Keep lifecycle authority and Worker
  // epoch as one boundary here as well as in the enrollment service/API.
  const authoritativeObserved = currentEpochReadiness ? input.observed : undefined;
  const platform = asEnvironmentPlatform(enrollment.worker.platform);
  const readiness = assembleEnvironmentReadiness({
    enrollment,
    observed: authoritativeObserved,
    // The work-safety fact is supplied by the runtime from the lease registry
    // and the open recovery records. It is projected back into the independent
    // readiness assembly through the same narrow facts, so the summary and the
    // admission gate can never describe a different safety state.
    leases:
      input.workSafety === 'held'
        ? [{ instanceId: enrollment.environmentInstanceId, state: 'active' }]
        : input.workSafety === 'recovery'
          ? [{ instanceId: enrollment.environmentInstanceId, state: 'recovering' }]
          : [],
    ...(input.workSafety === 'reconciling'
      ? { recoveryRecords: [{ environmentInstanceId: enrollment.environmentInstanceId, phase: 'reconciling' as const }] }
      : {}),
    requiredEngines: input.requiredEngines,
    ...(input.probe !== undefined ? { probe: input.probe } : {}),
    supportedProtocol: input.supportedProtocol,
    now: input.now,
  });
  // The run gate: the lease-bearing capability must be explicitly permitted.
  // A capability the enrollment never requested is not fabricated as required
  // (ADR-0008), but `agent-run` is the one capability every automatic Project/
  // run resolution needs, so it is checked here as well as inside the summary.
  const permissionSatisfied = enrollment.capabilityPermissions[ADMISSION_CAPABILITY] === true;
  const workSafety = readiness.readiness.workSafety.state;
  const workSafe = workSafety === 'clear' || workSafety === 'held';
  const connectionReady = readiness.readiness.connection.state === 'online';
  const protocolCompatible = readiness.readiness.compatibility.state === 'compatible';
  // Connection/readiness observations are authority-scoped facts, not durable
  // properties of an instance. A reconnect/replacement must re-establish them:
  // an observation from a prior epoch is inspectable but non-authoritative.
  // Every *required* engine must have established (non-unknown) readiness and
  // an available model. An unrequired engine stays an honestly non-blocking
  // fact. Strict probe-driven admission for the remaining dimensions arrives
  // with E4 (#118); E2 admits only what its independent facts establish.
  const requiredReadinessEstablished = readiness.readiness.engines
    .filter((engine) => engine.required)
    .every(
      (engine) =>
        engine.installed &&
        engine.readiness === 'ready' &&
        engine.models.state === 'available',
    );
  const eligible =
    enrollment.status === 'approved' &&
    platform !== 'unknown' &&
    permissionSatisfied &&
    input.currentEpoch !== undefined &&
    currentEpochReadiness &&
    workSafe &&
    connectionReady &&
    protocolCompatible &&
    requiredReadinessEstablished;
  return {
    instanceId: enrollment.environmentInstanceId,
    enrollmentId: enrollment.id,
    enrollment,
    definition: enrolledEnvironmentDefinition(platform),
    instance: {
      id: enrollment.environmentInstanceId,
      definitionId: enrolledDefinitionId(platform),
      ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
    },
    observed: input.observed,
    readiness,
    currentEpoch: input.currentEpoch,
    eligible,
  };
}

/**
 * Why one entry is not currently eligible, in a fixed decisive order.
 *
 * The order matches the readiness projection so the pool membership gate and the
 * operator-visible summary never disagree about the blocking dimension.
 */
export function admissionRefusal(entry: EnvironmentCatalogEntry): EnvironmentAdmission {
  if (entry.eligible) {
    return { ok: true, instanceId: entry.instanceId, enrollmentId: entry.enrollmentId };
  }
  const status = entry.enrollment.status;
  if (status === 'revoked') {
    return refusal(entry, 'revoked', entry.readiness.summary.reason);
  }
  if (status === 'archived') {
    return refusal(entry, 'archived', entry.readiness.summary.reason);
  }
  if (status !== 'approved') {
    return refusal(entry, 'not-approved', entry.readiness.summary.reason);
  }
  if (entry.enrollment.capabilityPermissions[ADMISSION_CAPABILITY] !== true) {
    return refusal(
      entry,
      'permission-incomplete',
      `Required capability "${ADMISSION_CAPABILITY}" is not permitted.`,
    );
  }
  if (entry.definition.platform === 'unknown') {
    return refusal(
      entry,
      'unsupported-platform',
      'The Worker platform is unknown or unsupported; Sprout cannot safely admit work.',
    );
  }
  if (entry.readiness.readiness.workSafety.state === 'recovery') {
    return refusal(entry, 'work-unsafe', entry.readiness.summary.reason);
  }
  if (entry.readiness.readiness.workSafety.state === 'reconciling') {
    return refusal(entry, 'work-unsafe', entry.readiness.summary.reason);
  }
  if (entry.currentEpoch === undefined) {
    return refusal(entry, 'not-current-epoch', 'No current Worker connection epoch is accepted.');
  }
  if (
    entry.observed?.enrollmentId !== entry.enrollmentId ||
    entry.observed.connectionEpoch !== entry.currentEpoch
  ) {
    return refusal(
      entry,
      'not-current-epoch',
      'Readiness facts were not established by the current Worker connection epoch.',
    );
  }
  if (entry.readiness.readiness.compatibility.state !== 'compatible') {
    return refusal(entry, 'readiness-unknown', entry.readiness.summary.reason);
  }
  if (entry.readiness.readiness.connection.state !== 'online') {
    return refusal(entry, 'readiness-unknown', entry.readiness.summary.reason);
  }
  return refusal(entry, 'readiness-unknown', entry.readiness.summary.reason);
}

function refusal(
  entry: EnvironmentCatalogEntry,
  reason: EnvironmentAdmissionRefusal,
  detail: string,
): EnvironmentAdmission {
  return { ok: false, instanceId: entry.instanceId, reason, detail };
}

/** Resolve the enrollment that currently owns an environment instance id. */
export function selectInstanceEnrollment(
  enrollments: readonly EnvironmentEnrollment[],
): EnvironmentEnrollment | undefined {
  const candidates = enrollments.filter((enrollment) => enrollment.environmentInstanceId !== '');
  if (candidates.length === 0) return undefined;
  // An eligible/approved enrollment of the same instance is preferred over a
  // superseded pending or revoked sibling, then the most recently updated wins.
  return [...candidates].sort((a, b) => {
    const rank = (enrollment: EnvironmentEnrollment): number =>
      enrollment.status === 'approved' ? 3 : enrollment.status === 'pending' ? 2 : 1;
    const byRank = rank(b) - rank(a);
    if (byRank !== 0) return byRank;
    return b.updatedAt - a.updatedAt;
  })[0];
}

/**
 * The whole catalog: every enrolled instance, keyed by its instance id.
 *
 * `update` is total: it replaces the projection with exactly the supplied
 * inputs, so an instance whose enrollment vanished (never a product operation,
 * but possible over a damaged store) is not left as a stale eligible entry.
 */
export class EnvironmentCatalog {
  #entries = new Map<string, EnvironmentCatalogEntry>();
  #inputs = new Map<string, EnvironmentCatalogInput>();

  update(inputs: readonly EnvironmentCatalogInput[]): readonly EnvironmentCatalogEntry[] {
    const byInstance = new Map<string, EnvironmentCatalogInput>();
    for (const input of inputs) {
      const instanceId = normalizeEnrollment(input.enrollment).environmentInstanceId;
      if (instanceId === '') continue;
      const existing = byInstance.get(instanceId);
      byInstance.set(instanceId, existing === undefined ? input : preferInput(existing, input));
    }
    this.#inputs = byInstance;
    return this.#reproject();
  }

  /**
   * Record the accepted connection epoch for one enrollment without a full
   * store re-read. Acceptance synchronously discards the previous observed
   * facts before publishing the new epoch: facts from a prior connection or
   * enrollment are inspectable in durable storage, but cannot bridge this
   * authority transition in the catalog/pool.
   */
  setEpoch(enrollmentId: string, epoch: number | undefined): void {
    for (const [instanceId, input] of this.#inputs) {
      if (input.enrollment.id !== enrollmentId) continue;
      this.#inputs.set(instanceId, { ...input, observed: undefined, currentEpoch: epoch });
      this.#reproject();
      return;
    }
  }

  /**
   * Fence one closing epoch without allowing an old close event to evict a
   * newer replacement that is already current.
   */
  clearEpoch(enrollmentId: string, closingEpoch: number): boolean {
    for (const [instanceId, input] of this.#inputs) {
      if (input.enrollment.id !== enrollmentId || input.currentEpoch !== closingEpoch) continue;
      this.#inputs.set(instanceId, { ...input, currentEpoch: undefined });
      this.#reproject();
      return true;
    }
    return false;
  }

  #reproject(): readonly EnvironmentCatalogEntry[] {
    const next = new Map<string, EnvironmentCatalogEntry>();
    for (const [instanceId, input] of this.#inputs) {
      next.set(instanceId, projectCatalogEntry(input));
    }
    this.#entries = next;
    return this.entries();
  }

  entry(instanceId: string): EnvironmentCatalogEntry | undefined {
    return this.#entries.get(instanceId);
  }

  entries(): readonly EnvironmentCatalogEntry[] {
    return [...this.#entries.values()];
  }

  /** Every catalog instance id, eligible or not, for inspection. */
  instanceIds(): readonly string[] {
    return [...this.#entries.keys()];
  }

  /** The eligible instance ids, in deterministic order. */
  eligibleInstanceIds(): readonly string[] {
    return this.entries()
      .filter((entry) => entry.eligible)
      .map((entry) => entry.instanceId);
  }

  admission(instanceId: string): EnvironmentAdmission {
    const entry = this.#entries.get(instanceId);
    if (entry === undefined) {
      return {
        ok: false,
        instanceId,
        reason: 'unknown-instance',
        detail: `Environment instance "${instanceId}" is not in the durable catalog.`,
      };
    }
    return admissionRefusal(entry);
  }
}

/** Prefer an eligible sibling over an ineligible one for the same instance id. */
function preferInput(
  a: EnvironmentCatalogInput,
  b: EnvironmentCatalogInput,
): EnvironmentCatalogInput {
  const rank = (input: EnvironmentCatalogInput): number =>
    input.enrollment.status === 'approved' ? 3 : input.enrollment.status === 'pending' ? 2 : 1;
  const byRank = rank(b) - rank(a);
  if (byRank !== 0) return byRank > 0 ? b : a;
  return b.enrollment.updatedAt >= a.enrollment.updatedAt ? b : a;
}
