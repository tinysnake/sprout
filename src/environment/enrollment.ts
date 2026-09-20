/**
 * Durable Environment enrollment facts (#87, ADR-0008, ADR-0009).
 *
 * Enrollment is the Human-approved binding between one Environment instance, one
 * Sprout instance, and a Worker whose private key remains on the Environment
 * host. This Module owns the durable enrollment decision and its append-only
 * authority history; it deliberately owns none of the independent readiness
 * facts (see `readiness.ts`).
 *
 * Privacy is structural, not a filter applied later: the records here hold an
 * opaque Worker identity and a one-way digest of the Worker's public key. No
 * private key, engine credential, hostname, address, or absolute path has a
 * field to be stored in.
 */

export type EnrollmentStatus = 'pending' | 'approved' | 'revoked';

export type EnrollmentDecisionKind =
  | 'requested'
  | 'approved'
  | 'revoked'
  | 'reset'
  | 'duplicate-same-key'
  | 'duplicate-new-key-refused';

/** One durable authority decision, retained in order for the whole lifecycle. */
export interface EnrollmentDecision {
  readonly kind: EnrollmentDecisionKind;
  readonly actor: string;
  readonly at: number;
  /** A bounded, sanitized explanation suitable for an operator. */
  readonly reason: string;
}

/**
 * The portable Worker facts an enrollment presents.
 *
 * `identityDigest` is the one-way digest of the Worker's public key, computed on
 * the Environment host and used only for identity comparison. It is not a
 * secret and carries no key material that could authenticate as the Worker.
 */
export interface EnrollmentWorkerFacts {
  readonly identityDigest: string;
  readonly platform: string;
  readonly protocolVersion?: string;
  readonly capabilityRequests: readonly string[];
  readonly engineFacts: readonly EnrollmentEngineFact[];
}

export interface EnrollmentEngineFact {
  /** A neutral engine id (`codex`, `pi`, …). */
  readonly engine: string;
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly models: readonly string[];
}

export interface EnvironmentEnrollment {
  readonly id: string;
  readonly environmentInstanceId: string;
  readonly displayName: string;
  readonly status: EnrollmentStatus;
  /** `true` once a Human has approved this identity at least once. */
  readonly everApproved: boolean;
  readonly worker: EnrollmentWorkerFacts;
  readonly capabilityPermissions: Readonly<Record<string, boolean>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly decisions: readonly EnrollmentDecision[];
}

export type EnrollmentOutcome =
  | 'requested'
  | 'reconnected'
  | 'duplicate-same-key'
  | 'duplicate-new-key-refused'
  | 'revoked-refused'
  | 'approved'
  | 'revoked'
  | 'reset';

/** The result of recording a Worker's connection attempt against enrollment. */
export interface EnrollmentConnectionOutcome {
  readonly outcome: EnrollmentOutcome;
  readonly enrollment: EnvironmentEnrollment;
  /** True only when this attempt requires a Human decision before work. */
  readonly requiresHumanApproval: boolean;
}

export type EnrollmentErrorCode =
  | 'unknown-enrollment'
  | 'revoked-enrollment'
  | 'duplicate-identity'
  | 'not-pending'
  | 'not-approved'
  | 'unsupported-platform';

/** A typed enrollment refusal whose message is safe to show an operator. */
export class EnrollmentError extends Error {
  readonly code: EnrollmentErrorCode;

  constructor(code: EnrollmentErrorCode, message: string) {
    super(message);
    this.name = 'EnrollmentError';
    this.code = code;
  }
}

const SUPPORTED_PLATFORMS = new Set(['macos', 'windows', 'container']);

export interface CreatePendingEnrollmentInput {
  readonly environmentInstanceId: string;
  readonly displayName: string;
  /** The one-way digest of the Worker's host-generated public key. */
  readonly identityDigest: string;
  readonly platform: string;
  readonly protocolVersion?: string;
  readonly capabilityRequests: readonly string[];
  readonly engineFacts: readonly EnrollmentEngineFact[];
  readonly at: number;
  readonly id: string;
}

/**
 * Create a pending enrollment from a Worker's already-digested public key.
 *
 * The private key never crosses this boundary, and the digest is computed on the
 * Environment host; this Module receives only the digest. An unsupported
 * platform is refused rather than recorded as a broken enrollment.
 */
export function createPendingEnrollment(input: CreatePendingEnrollmentInput): EnvironmentEnrollment {
  if (!SUPPORTED_PLATFORMS.has(input.platform)) {
    throw new EnrollmentError(
      'unsupported-platform',
      `Environment platform "${input.platform}" is not supported for enrollment.`,
    );
  }
  return {
    id: input.id,
    environmentInstanceId: input.environmentInstanceId,
    displayName: input.displayName,
    status: 'pending',
    everApproved: false,
    worker: {
      identityDigest: input.identityDigest,
      platform: input.platform,
      ...(input.protocolVersion !== undefined ? { protocolVersion: input.protocolVersion } : {}),
      capabilityRequests: [...input.capabilityRequests],
      engineFacts: input.engineFacts.map((engine) => ({ ...engine, models: [...engine.models] })),
    },
    capabilityPermissions: Object.fromEntries(
      input.capabilityRequests.map((capability) => [capability, false]),
    ),
    createdAt: input.at,
    updatedAt: input.at,
    decisions: [
      {
        kind: 'requested',
        actor: 'operator',
        at: input.at,
        reason: 'Pending enrollment created in Web; awaiting Worker proof and Human approval.',
      },
    ],
  };
}

/**
 * Reconcile a Worker connection attempt with the durable enrollment identity.
 *
 * The duplicate-identity rules are the ADR-0008 settled outcomes:
 *
 * - the same Worker key is an idempotent reconnect, never a second Environment;
 * - a new key while an approved binding is active is refused and requires an
 *   explicit Human reset and fresh approval;
 * - a revoked enrollment stays revoked and bars reconnection.
 */
export function reconcileWorkerConnection(
  enrollment: EnvironmentEnrollment,
  identityDigest: string,
  at: number,
): EnrollmentConnectionOutcome {
  if (enrollment.status === 'revoked') {
    return {
      outcome: 'revoked-refused',
      enrollment: recordDecision(enrollment, {
        kind: 'duplicate-new-key-refused',
        actor: 'worker',
        at,
        reason: 'The enrollment is revoked; a fresh reset and Human approval are required.',
      }),
      requiresHumanApproval: true,
    };
  }

  if (identityDigest === enrollment.worker.identityDigest) {
    return {
      outcome: enrollment.status === 'approved' ? 'reconnected' : 'duplicate-same-key',
      enrollment: recordDecision(enrollment, {
        kind: 'duplicate-same-key',
        actor: 'worker',
        at,
        reason:
          enrollment.status === 'approved'
            ? 'The enrolled Worker reconnected with its known identity.'
            : 'The known Worker identity reconnected while approval is still pending.',
      }),
      requiresHumanApproval: enrollment.status !== 'approved',
    };
  }

  // A different key. While a decided binding is active, refuse rather than
  // silently transfer ownership; a pending request may simply be a repeat
  // attempt that the Human has not decided yet, so a reset is also required.
  return {
    outcome: 'duplicate-new-key-refused',
    enrollment: recordDecision(enrollment, {
      kind: 'duplicate-new-key-refused',
      actor: 'worker',
      at,
      reason:
        enrollment.status === 'approved'
          ? 'A different Worker key cannot replace an approved binding; reset the enrollment first.'
          : 'A different Worker key cannot replace a pending request; reset the enrollment first.',
    }),
    requiresHumanApproval: true,
  };
}

export interface ApprovalInput {
  readonly capabilityPermissions: Readonly<Record<string, boolean>>;
  readonly at: number;
  readonly actor?: string;
}

/** Approve a pending enrollment and record the Human decision. */
export function approveEnrollment(
  enrollment: EnvironmentEnrollment,
  input: ApprovalInput,
): EnvironmentEnrollment {
  if (enrollment.status === 'revoked') {
    throw new EnrollmentError('revoked-enrollment', 'A revoked enrollment cannot be approved; reset it first.');
  }
  if (enrollment.status !== 'pending') {
    throw new EnrollmentError('not-pending', 'Only a pending enrollment can be approved.');
  }
  const permissions: Record<string, boolean> = { ...enrollment.capabilityPermissions };
  for (const [capability, allowed] of Object.entries(input.capabilityPermissions)) {
    if (capability in permissions) permissions[capability] = allowed === true;
  }
  return {
    ...recordDecision(enrollment, {
      kind: 'approved',
      actor: input.actor ?? 'operator',
      at: input.at,
      reason: 'Human approved the Worker identity and its capability permissions.',
    }),
    status: 'approved',
    everApproved: true,
    capabilityPermissions: permissions,
    updatedAt: input.at,
  };
}

/** Revoke an enrollment. The record and its history are preserved. */
export function revokeEnrollment(enrollment: EnvironmentEnrollment, at: number, reason: string): EnvironmentEnrollment {
  return {
    ...recordDecision(enrollment, {
      kind: 'revoked',
      actor: 'operator',
      at,
      reason: reason.trim() === '' ? 'Human revoked the Worker identity and reconnection authority.' : reason,
    }),
    status: 'revoked',
    updatedAt: at,
  };
}

/**
 * Fresh reset: invalidate the old identity so only a newly generated Worker key
 * can enroll (ADR-0008: an unenrolled Environment requires fresh Human approval).
 */
export function resetEnrollment(enrollment: EnvironmentEnrollment, at: number, reason: string): EnvironmentEnrollment {
  return {
    ...recordDecision(enrollment, {
      kind: 'reset',
      actor: 'operator',
      at,
      reason:
        reason.trim() === ''
          ? 'Human reset the enrollment; the old Worker identity can no longer reconnect.'
          : reason,
    }),
    status: 'pending',
    everApproved: false,
    capabilityPermissions: Object.fromEntries(
      Object.keys(enrollment.capabilityPermissions).map((capability) => [capability, false]),
    ),
    updatedAt: at,
  };
}

/** Change one capability permission on an approved enrollment. */
export function setCapabilityPermission(
  enrollment: EnvironmentEnrollment,
  capability: string,
  allowed: boolean,
  at: number,
): EnvironmentEnrollment {
  if (enrollment.status !== 'approved') {
    throw new EnrollmentError('not-approved', 'Capability permissions can only change on an approved enrollment.');
  }
  if (!(capability in enrollment.capabilityPermissions)) {
    throw new EnrollmentError('unknown-enrollment', `Unknown capability "${capability}".`);
  }
  return {
    ...enrollment,
    capabilityPermissions: { ...enrollment.capabilityPermissions, [capability]: allowed },
    updatedAt: at,
  };
}

function recordDecision(enrollment: EnvironmentEnrollment, decision: EnrollmentDecision): EnvironmentEnrollment {
  return { ...enrollment, decisions: [...enrollment.decisions, decision] };
}
