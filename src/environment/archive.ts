/**
 * Non-destructive Environment archive and restore (ADR-0008, #89).
 *
 * ADR-0008 settles that M2 offers archive and restore, not hard deletion: an
 * Environment instance cannot be archived while an active run, unfinished bound
 * Task, held or recovering lease, or recovery depends on it, and archive bars
 * new work while retaining enrollment, history, and decisions. A restored
 * archived instance may reuse its still-valid enrollment; an unenrolled one
 * requires fresh Human approval (that path is #87's reset, not this Module).
 *
 * This Module owns the archive vocabulary and its one decision rule set. It
 * deliberately owns no lease table and no Task lifecycle:
 *
 * - the work-safety facts it checks arrive through a narrow read-only port, so
 *   the Environment pool remains the one owner of lease state; and
 * - the enrollment decision history is extended, not rewritten, so an archive
 *   and a restore are ordinary durable authority decisions like approval or
 *   revocation.
 *
 * Archived is a status, not a delete: the Worker identity, capability
 * permissions, and the whole decision history are preserved verbatim.
 */

import { EnrollmentError, type EnvironmentEnrollment } from './enrollment.ts';
import { sanitizeOperatorText, DEFAULT_ARCHIVE_REASON, DEFAULT_RESTORE_REASON } from './privacy.ts';
import type { EnrollmentStore } from './enrollment-store.ts';

/** The caller-facing archive/restore capability (see the service class below). */
export type EnvironmentArchivePort = EnvironmentArchiveService;

/**
 * The narrow read-only surface this Module needs to prove no active work
 * depends on the Environment. `EnvironmentPool` satisfies it.
 */
export interface ArchiveLeasePort {
  leases(): readonly {
    readonly instanceId: string;
    readonly state: string;
    readonly taskId?: string;
  }[];
}

/** Open recovery records that still protect this Environment. */
export interface ArchiveRecoveryPort {
  listForEnvironment(environmentInstanceId: string): Promise<
    readonly { readonly phase: string }[]
  >;
}

export type ArchiveErrorCode =
  | 'unknown-enrollment'
  | 'not-archived'
  | 'already-archived'
  | 'active-work-depends-on-environment'
  | 'recovery-depends-on-environment';

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;

  constructor(code: ArchiveErrorCode, message: string) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

export interface EnvironmentArchiveServiceOptions {
  readonly enrollments: EnrollmentStore;
  readonly leases: ArchiveLeasePort;
  readonly recovery?: ArchiveRecoveryPort;
  readonly clock?: () => number;
}

/**
 * The caller-facing archive/restore capability.
 *
 * Every decision is one durable enrollment decision written before it is
 * observable, so an archive and a restore survive a restart exactly like an
 * approval or revocation does.
 */
export class EnvironmentArchiveService {
  readonly #enrollments: EnrollmentStore;
  readonly #leases: ArchiveLeasePort;
  readonly #recovery: ArchiveRecoveryPort | undefined;
  readonly #clock: () => number;

  constructor(options: EnvironmentArchiveServiceOptions) {
    this.#enrollments = options.enrollments;
    this.#leases = options.leases;
    this.#recovery = options.recovery;
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * Archive one enrollment's Environment (ADR-0008).
   *
   * Refused while an active or recovering lease, an unfinished Task binding, or
   * an open recovery record still depends on the instance. The decision reason
   * passes the operator privacy boundary like every other free-text field.
   */
  async archive(enrollmentId: string, reason = ''): Promise<EnvironmentEnrollment> {
    const enrollment = await this.#require(enrollmentId);
    if (enrollment.status === 'archived') {
      throw new ArchiveError('already-archived', 'This Environment is already archived.');
    }
    await this.#requireNoDependentWork(enrollment.environmentInstanceId);
    const at = this.#clock();
    const archived: EnvironmentEnrollment = {
      ...enrollment,
      status: 'archived',
      updatedAt: at,
      decisions: [
        ...enrollment.decisions,
        {
          kind: 'archived',
          actor: 'operator',
          at,
          reason: sanitizeOperatorText(reason, { fallback: DEFAULT_ARCHIVE_REASON }),
        },
      ],
    };
    await this.#enrollments.save(archived);
    return archived;
  }

  /**
   * Restore one archived Environment (ADR-0008).
   *
   * A restored instance may reuse its still-valid enrollment: an approved
   * binding stays approved, a pending request stays pending. Only an archived
   * record can be restored, so restore can never resurrect a revoked identity.
   */
  async restore(enrollmentId: string, reason = ''): Promise<EnvironmentEnrollment> {
    const enrollment = await this.#require(enrollmentId);
    if (enrollment.status !== 'archived') {
      throw new ArchiveError('not-archived', 'Only an archived Environment can be restored.');
    }
    const at = this.#clock();
    const previous = enrollment.decisions.filter((decision) => decision.kind !== 'archived');
    const restoreDecision = previous[previous.length - 1];
    const restored: EnvironmentEnrollment = {
      ...enrollment,
      status: restoreDecision?.kind === 'approved' ? 'approved' : 'pending',
      updatedAt: at,
      decisions: [
        ...enrollment.decisions,
        {
          kind: 'restored',
          actor: 'operator',
          at,
          reason: sanitizeOperatorText(reason, { fallback: DEFAULT_RESTORE_REASON }),
        },
      ],
    };
    await this.#enrollments.save(restored);
    return restored;
  }

  async #require(enrollmentId: string): Promise<EnvironmentEnrollment> {
    const enrollment = await this.#enrollments.get(enrollmentId);
    if (enrollment === undefined) {
      throw new ArchiveError('unknown-enrollment', `Unknown enrollment: ${enrollmentId}`);
    }
    return enrollment;
  }

  async #requireNoDependentWork(environmentInstanceId: string): Promise<void> {
    for (const lease of this.#leases.leases()) {
      if (lease.instanceId !== environmentInstanceId) continue;
      if (lease.state === 'active' || lease.state === 'recovering') {
        throw new ArchiveError(
          'active-work-depends-on-environment',
          'An active run, Task lease, or recovery still depends on this Environment; end that work first.',
        );
      }
    }
    if (this.#recovery !== undefined) {
      const records = await this.#recovery.listForEnvironment(environmentInstanceId);
      if (
        records.some(
          (record: { readonly phase: string }) =>
            record.phase === 'reconciling' || record.phase === 'recovery',
        )
      ) {
        throw new ArchiveError(
          'recovery-depends-on-environment',
          'An open recovery record still protects this Environment; resolve it first.',
        );
      }
    }
  }
}

export { EnrollmentError };
