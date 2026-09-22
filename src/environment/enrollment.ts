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

import {
  sanitizeOperatorText,
  sanitizeIdentifier,
  sanitizeProtocolVersion,
  DEFAULT_DECISION_REASON,
  DEFAULT_RESET_REASON,
  DEFAULT_REVOKE_REASON,
  DEFAULT_ARCHIVE_REASON,
  DEFAULT_RESTORE_REASON,
} from './privacy.ts';

export type EnrollmentStatus = 'pending' | 'approved' | 'revoked' | 'archived';

export type EnrollmentDecisionKind =
  | 'requested'
  | 'approved'
  | 'revoked'
  | 'reset'
  | 'archived'
  | 'restored'
  | 'duplicate-same-key'
  | 'identity-claimed'
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
 * A one-use, short-lived host claim for a pending enrollment (#115).
 *
 * A Human creates the pending enrollment in Web without a Worker public key;
 * the host claims it with the raw secret, and only a proof of key possession
 * binds an identity. Sprout retains only the one-way digest, so a leaked
 * durable document cannot be replayed as a claim.
 */
export interface EnrollmentClaim {
  /** The one-way digest of the one-use secret. The raw secret is never stored. */
  readonly secretDigest: string;
  readonly issuedAt: number;
  /** The first instant the claim is no longer usable. */
  readonly expiresAt: number;
  /** Set when the secret is consumed; a consumed claim can never be reused. */
  readonly consumedAt?: number;
}

/**
 * The portable Worker facts an enrollment presents.
 *
 * `identityDigest` is the one-way digest of the Worker's public key, computed on
 * the Environment host and used only for identity comparison. It is not a
 * secret and carries no key material that could authenticate as the Worker.
 * It is empty until a claimed identity proves key possession.
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
  /**
   * Digests invalidated by a fresh reset. An old Worker key in this list can
   * never reconnect and can never be approved again (ADR-0008: an unenrolled
   * Environment requires fresh Human approval with a fresh identity).
   */
  readonly invalidatedIdentityDigests: readonly string[];
  /**
   * `true` after a fresh reset until a newly generated Worker key claims this
   * pending request. Approval is refused while no current identity is claimed.
   */
  readonly requiresFreshIdentity: boolean;
  /**
   * The one-use claim that lets a host claim this pending enrollment (#115).
   * Present on a Web-created pending enrollment; cleared once claimed or
   * superseded by a reset. `undefined` for a legacy record or a reset that
   * requires a fresh identity.
   */
  readonly claim: EnrollmentClaim | undefined;
  readonly capabilityPermissions: Readonly<Record<string, boolean>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * Monotonic durable authority revision of this enrollment document.
   *
   * Every mutation that appends a decision or changes lifecycle state bumps it.
   * It is the compare-and-set token a slow pre-epoch reconciliation uses so its
   * durable save can never overwrite a newer revoke/reset (R118-EPOCH-001).
   * Older documents without the field normalize to 0.
   */
  readonly revision: number;
  readonly decisions: readonly EnrollmentDecision[];
}

export type EnrollmentOutcome =
  | 'requested'
  | 'reconnected'
  | 'duplicate-same-key'
  | 'identity-claimed'
  | 'stale-identity-refused'
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
  /**
   * True when a concurrent revoke/reset/archive invalidated this attempt before
   * its durable reconciliation could be saved (R118-EPOCH-001).
   *
   * The stale save is discarded rather than overwriting the newer lifecycle
   * decision, so a gateway must treat this as a refusal instead of accepting an
   * epoch for the superseded connection.
   */
  readonly authoritySuperseded?: boolean;
}

export type EnrollmentErrorCode =
  | 'unknown-enrollment'
  /** An existing enrollment owns this Environment instance; reset it instead. */
  | 'duplicate-instance'
  | 'revoked-enrollment'
  | 'duplicate-identity'
  | 'not-pending'
  | 'not-approved'
  | 'fresh-identity-required'
  /** The enrollment has no proven Worker identity to approve yet (#115). */
  | 'identity-not-claimed'
  | 'invalid-proof'
  | 'unsupported-platform'
  /** The enrollment has no live one-use claim (missing, consumed, or expired). */
  | 'invalid-claim';

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
  /**
   * The one-way digest of the Worker's host-generated public key, when a legacy
   * caller already knows it. Web creation supplies none: the identity is bound
   * only after a claim proves possession of the key (#115).
   */
  readonly identityDigest?: string;
  readonly platform: string;
  readonly protocolVersion?: string;
  readonly capabilityRequests: readonly string[];
  readonly engineFacts: readonly EnrollmentEngineFact[];
  /** The one-use host claim attached to a Web-created pending enrollment. */
  readonly claim?: EnrollmentClaim;
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
  const protocolVersion = sanitizeProtocolVersion(input.protocolVersion);
  return {
    id: input.id,
    environmentInstanceId: input.environmentInstanceId,
    // The display name is a Human label, but it still lives in the durable
    // Environment health record, so it passes the same privacy boundary: a path
    // or credential typed into a label is redacted rather than persisted.
    displayName: sanitizeOperatorText(input.displayName, { fallback: 'Environment', maxLength: 120 }),
    status: 'pending',
    everApproved: false,
    worker: {
      identityDigest: input.identityDigest ?? '',
      platform: input.platform,
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      // Capability, engine, and model names are structured identifiers, not free
      // text: a path or token typed into one is dropped rather than preserved in
      // the durable record or the readiness reason.
      capabilityRequests: input.capabilityRequests.map((capability) =>
        sanitizeIdentifier(capability, { fallback: 'unknown-capability', kind: 'capability' }),
      ),
      engineFacts: input.engineFacts.map((engine) => ({
        installed: engine.installed,
        authenticated: engine.authenticated,
        models: engine.models.map((model) =>
          sanitizeIdentifier(model, { fallback: 'unknown-model', kind: 'model' }),
        ),
        engine: sanitizeIdentifier(engine.engine, { fallback: 'unknown-engine', kind: 'engine' }),
      })),
    },
    invalidatedIdentityDigests: [],
    requiresFreshIdentity: false,
    claim: input.claim === undefined ? undefined : { ...input.claim },
    capabilityPermissions: Object.fromEntries(
      input.capabilityRequests.map((capability) => [
        sanitizeIdentifier(capability, { fallback: 'unknown-capability', kind: 'capability' }),
        false,
      ]),
    ),
    createdAt: input.at,
    updatedAt: input.at,
    revision: 0,
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
 * - a revoked enrollment stays revoked and bars reconnection;
 * - a key invalidated by a fresh reset can never reconnect or be approved again;
 * - after a fresh reset, a newly generated key claims the pending request and
 *   still needs a fresh Human approval before work.
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

  // A pending enrollment that has never bound an identity accepts the first
  // proven key as its claimed identity. This is the claim path (#115): the
  // proof has already verified, so the key may be recorded, but the Human still
  // decides approval and the enrollment cannot approve itself.
  if (enrollment.status === 'pending' && enrollment.worker.identityDigest === '' && !enrollment.requiresFreshIdentity) {
    return {
      outcome: 'identity-claimed',
      enrollment: recordDecision(
        { ...enrollment, worker: { ...enrollment.worker, identityDigest } },
        {
          kind: 'identity-claimed',
          actor: 'worker',
          at,
          reason: 'A claimed Worker identity proved key possession; Human approval is required before work.',
        },
      ),
      requiresHumanApproval: true,
    };
  }

  // A key invalidated by a fresh reset is permanently barred. This is checked
  // before anything else so an old key cannot reclaim the pending request, even
  // though the reset made the enrollment pending again.
  if (enrollment.invalidatedIdentityDigests.includes(identityDigest)) {
    return {
      outcome: 'stale-identity-refused',
      enrollment: recordDecision(enrollment, {
        kind: 'duplicate-new-key-refused',
        actor: 'worker',
        at,
        reason: 'This Worker identity was invalidated by a fresh reset and cannot reconnect; generate a new key.',
      }),
      requiresHumanApproval: true,
    };
  }

  // A fresh reset cleared the current identity. The first new key claims the
  // pending request; it is recorded so the Human approves a known identity.
  if (enrollment.requiresFreshIdentity) {
    return {
      outcome: 'identity-claimed',
      enrollment: recordDecision(
        {
          ...enrollment,
          worker: { ...enrollment.worker, identityDigest },
          requiresFreshIdentity: false,
        },
        {
          kind: 'identity-claimed',
          actor: 'worker',
          at,
          reason: 'A newly generated Worker identity claimed the reset enrollment; fresh Human approval is required.',
        },
      ),
      requiresHumanApproval: true,
    };
  }

  if (identityDigest === enrollment.worker.identityDigest && identityDigest !== '') {
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
  // A fresh reset clears the claimed identity; the Human approves a *fresh*
  // Worker identity, never the one the reset invalidated. This is checked before
  // the empty-identity refusal so a reset reports its own specific reason.
  if (enrollment.requiresFreshIdentity) {
    throw new EnrollmentError(
      'fresh-identity-required',
      'This enrollment was reset; a newly generated Worker identity must claim it before approval.',
    );
  }
  // Approval binds the Human decision to a *proven* Worker identity. A
  // Web-created pending enrollment starts identity-free (#115): the one-use
  // claim and the signed challenge bind an identity, and only then can a Human
  // approve it. Approving an empty identity would create an approved record no
  // Worker key can ever satisfy, permanently bricking the enrollment.
  if (enrollment.worker.identityDigest === '') {
    throw new EnrollmentError(
      'identity-not-claimed',
      'This enrollment has no proven Worker identity yet; the host must claim it and prove key possession before approval.',
    );
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
    revision: (enrollment.revision ?? 0) + 1,
  };
}

/** Revoke an enrollment. The record and its history are preserved. */
export function revokeEnrollment(enrollment: EnvironmentEnrollment, at: number, reason: string): EnvironmentEnrollment {
  return {
    ...recordDecision(enrollment, {
      kind: 'revoked',
      actor: 'operator',
      at,
      reason: sanitizeOperatorText(reason, { fallback: DEFAULT_REVOKE_REASON }),
    }),
    status: 'revoked',
    updatedAt: at,
    revision: (enrollment.revision ?? 0) + 1,
  };
}

/**
 * Fresh reset: invalidate the old identity so only a newly generated Worker key
 * can enroll (ADR-0008: an unenrolled Environment requires fresh Human approval).
 */
/**
 * Fresh reset: invalidate the old identity so only a newly generated Worker key
 * can enroll (ADR-0008: an unenrolled Environment requires fresh Human approval).
 *
 * The previous digest is moved to `invalidatedIdentityDigests`, the current
 * identity is cleared, and `requiresFreshIdentity` is set, so the old key can
 * neither reconnect nor be approved and a fresh key must claim the request.
 */
export function resetEnrollment(enrollment: EnvironmentEnrollment, at: number, reason: string): EnvironmentEnrollment {
  const previousDigest = enrollment.worker.identityDigest;
  const invalidated =
    previousDigest !== '' && !enrollment.invalidatedIdentityDigests.includes(previousDigest)
      ? [...enrollment.invalidatedIdentityDigests, previousDigest]
      : [...enrollment.invalidatedIdentityDigests];
  return {
    ...recordDecision(enrollment, {
      kind: 'reset',
      actor: 'operator',
      at,
      reason: sanitizeOperatorText(reason, { fallback: DEFAULT_RESET_REASON }),
    }),
    status: 'pending',
    everApproved: false,
    worker: { ...enrollment.worker, identityDigest: '' },
    invalidatedIdentityDigests: invalidated,
    requiresFreshIdentity: true,
    claim: undefined,
    capabilityPermissions: Object.fromEntries(
      Object.keys(enrollment.capabilityPermissions).map((capability) => [capability, false]),
    ),
    updatedAt: at,
    revision: (enrollment.revision ?? 0) + 1,
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
    revision: (enrollment.revision ?? 0) + 1,
  };
}

function recordDecision(enrollment: EnvironmentEnrollment, decision: EnrollmentDecision): EnvironmentEnrollment {
  return {
    ...enrollment,
    revision: (enrollment.revision ?? 0) + 1,
    decisions: [...enrollment.decisions, decision],
  };
}

/**
 * Read a durable enrollment document additively and defensively.
 *
 * Older documents written before the identity-proof rework lack the
 * `invalidatedIdentityDigests` and `requiresFreshIdentity` fields. Defaulting
 * them here keeps an upgrade additive instead of turning a valid record into
 * `undefined`-shaped breakage; the stored document is not rewritten on read.
 *
 * Reading also re-applies the privacy boundary. A row written by an earlier
 * build, or by an adapter that bypassed the service, can hold an unsanitized
 * `displayName`, identity field, or decision reason; returning it verbatim would
 * leak exactly the categories ADR-0009 forbids. The free text is therefore
 * re-sanitized here as well as on write, an invalid protocol version is dropped
 * rather than echoed, and an opaque digest/identifier is reduced to the
 * characters such a value may contain. The product-owned fallback keeps the
 * decisive fact when the whole value was sensitive.
 */
export function normalizeEnrollment(enrollment: EnvironmentEnrollment): EnvironmentEnrollment {
  const protocolVersion = sanitizeProtocolVersion(enrollment.worker.protocolVersion);
  // Destructure the version out so an invalid one is dropped rather than left
  // in place by the spread; an arbitrary string is refused, not echoed.
  const { protocolVersion: _rawProtocolVersion, ...workerRest } = enrollment.worker;
  return {
    ...enrollment,
    revision: Number.isSafeInteger(enrollment.revision) && enrollment.revision >= 0 ? enrollment.revision : 0,
    displayName: sanitizeOperatorText(enrollment.displayName, { fallback: 'Environment', maxLength: 120 }),
    worker: {
      ...workerRest,
      platform: SUPPORTED_PLATFORMS.has(enrollment.worker.platform) ? enrollment.worker.platform : 'unknown',
      identityDigest: sanitizeIdentifier(enrollment.worker.identityDigest, {
        fallback: '',
        maxLength: 200,
        kind: 'digest',
      }),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      capabilityRequests: (enrollment.worker.capabilityRequests ?? []).map((capability) =>
        sanitizeIdentifier(capability, { fallback: 'unknown-capability', kind: 'capability' }),
      ),
      engineFacts: (enrollment.worker.engineFacts ?? []).map((engine) => ({
        installed: engine.installed === true,
        authenticated: engine.authenticated === true,
        models: (engine.models ?? []).map((model) =>
          sanitizeIdentifier(model, { fallback: 'unknown-model', kind: 'model' }),
        ),
        engine: sanitizeIdentifier(engine.engine, { fallback: 'unknown-engine', kind: 'engine' }),
      })),
    },
    capabilityPermissions: Object.fromEntries(
      Object.entries(enrollment.capabilityPermissions ?? {}).map(([capability, allowed]) => [
        sanitizeIdentifier(capability, { fallback: 'unknown-capability', kind: 'capability' }),
        allowed === true,
      ]),
    ),
    invalidatedIdentityDigests: Array.isArray(enrollment.invalidatedIdentityDigests)
      ? enrollment.invalidatedIdentityDigests
          .map((digest) => sanitizeIdentifier(digest, { fallback: '', maxLength: 200, kind: 'digest' }))
          .filter((digest) => digest !== '')
      : [],
    requiresFreshIdentity: enrollment.requiresFreshIdentity === true,
    claim: normalizeClaim(enrollment.claim),
    decisions: (enrollment.decisions ?? []).map(sanitizeDecision),
  };
}

/**
 * The product-owned reason for each decision kind.
 *
 * A legacy or bypassing writer can leave a decision reason empty or entirely
 * sensitive. Falling back to the kind's own product text keeps the decision
 * explainable without weakening the redaction.
 */
const DECISION_REASON_FALLBACKS: Readonly<Record<EnrollmentDecisionKind, string>> = {
  requested: 'Pending enrollment created in Web; awaiting Worker proof and Human approval.',
  approved: 'Human approved the Worker identity and its capability permissions.',
  revoked: DEFAULT_REVOKE_REASON,
  reset: DEFAULT_RESET_REASON,
  archived: DEFAULT_ARCHIVE_REASON,
  restored: DEFAULT_RESTORE_REASON,
  'duplicate-same-key': 'The known Worker identity reconnected.',
  'identity-claimed': 'A newly generated Worker identity claimed the reset enrollment; fresh Human approval is required.',
  'duplicate-new-key-refused': 'A different Worker key cannot replace the existing binding; reset the enrollment first.',
};

/** Re-apply the privacy boundary to one durable decision reason and actor. */
function sanitizeDecision(decision: EnrollmentDecision): EnrollmentDecision {
  const fallback = DECISION_REASON_FALLBACKS[decision.kind] ?? DEFAULT_DECISION_REASON;
  return {
    ...decision,
    // The actor is a structured enum (`operator`, `worker`), never free text: a
    // legacy row that stored a host path, credential, or address in it is
    // replaced by the product-owned actor rather than partially echoed.
    actor: sanitizeIdentifier(decision.actor ?? '', { fallback: 'operator', maxLength: 64 }),
    reason: sanitizeOperatorText(decision.reason, { fallback }),
  };
}

/**
 * Read one durable claim defensively.
 *
 * The secret digest is a one-way hash: an earlier build (or a bypassing writer)
 * could have stored a raw secret or key material in that field, so it is reduced
 * to the digest shape or dropped. A claim whose digest is not a digest is no
 * claim at all, which fails closed.
 */
function normalizeClaim(claim: EnrollmentClaim | undefined): EnrollmentClaim | undefined {
  if (claim === undefined || typeof claim !== 'object') return undefined;
  const secretDigest = sanitizeIdentifier(claim.secretDigest ?? '', {
    fallback: '',
    maxLength: 200,
    kind: 'digest',
  });
  if (secretDigest === '') return undefined;
  return {
    secretDigest,
    issuedAt: typeof claim.issuedAt === 'number' ? claim.issuedAt : 0,
    expiresAt: typeof claim.expiresAt === 'number' ? claim.expiresAt : 0,
    ...(typeof claim.consumedAt === 'number' ? { consumedAt: claim.consumedAt } : {}),
  };
}
