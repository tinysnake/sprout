import type { EnvironmentEnrollment } from './enrollment.ts';

/**
 * Durable storage for Environment enrollment decisions (#87).
 *
 * A seam, not a SQLite detail (ADR-0002): the enrollment service reads and writes
 * through this interface, so the same rules run over the in-memory adapter in
 * tests and the SQLite adapter in production. The record is stored as one JSON
 * document keyed by id, the same way Projects are, because its decisions and
 * capability permissions belong to the enrollment as a whole.
 */
export interface EnrollmentStore {
  /**
   * Atomically create the one durable enrollment authority for an Environment
   * instance. `false` means an existing authority owns that instance.
   */
  createIfInstanceAbsent(enrollment: EnvironmentEnrollment): Promise<boolean>;
  /**
   * Save an enrollment document unconditionally (lifecycle decisions).
   *
   * Callers that already hold the latest durable revision use this; a slow
   * reconciliation must use {@link saveIfRevision} instead so its save cannot
   * overwrite a newer lifecycle decision (R118-EPOCH-001).
   */
  save(enrollment: EnvironmentEnrollment): Promise<void>;
  /**
   * Compare-and-set one enrollment document on its durable `revision`.
   *
   * Applies only when the stored document's revision still equals
   * `expectedRevision`; returns the saved document when it applied, or
   * `undefined` when a concurrent writer moved the revision first (or the
   * record is gone). The store is the serialization point, so two concurrent
   * saves cannot both apply and a stale pre-epoch reconciliation can never
   * overwrite a later revoke/reset.
   */
  saveIfRevision(enrollment: EnvironmentEnrollment, expectedRevision: number): Promise<EnvironmentEnrollment | undefined>;
  get(enrollmentId: string): Promise<EnvironmentEnrollment | undefined>;
  list(): Promise<readonly EnvironmentEnrollment[]>;
  /**
   * Atomically consume the live one-use claim, if and only if it is still live.
   *
   * The store is the serialization point that makes claim consumption
   * exactly-once (#115): it applies a compare-and-set on the stored claim, so
   * two concurrent claimants with the same valid secret can never both succeed.
   * The presented secret is verified by the service first; this method takes the
   * already-verified stored digest so the store never sees the raw secret.
   *
   * Returns the updated record when the CAS applied, or `undefined` when the
   * claim was already consumed, missing, or differed from `expectedDigest`.
   */
  consumeClaim(
    enrollmentId: string,
    expectedDigest: string,
    consumedAt: number,
  ): Promise<EnvironmentEnrollment | undefined>;
}

export class InMemoryEnrollmentStore implements EnrollmentStore {
  readonly #enrollments = new Map<string, EnvironmentEnrollment>();

  async createIfInstanceAbsent(enrollment: EnvironmentEnrollment): Promise<boolean> {
    if ([...this.#enrollments.values()].some(
      (existing) => existing.environmentInstanceId === enrollment.environmentInstanceId,
    )) {
      return false;
    }
    this.#enrollments.set(enrollment.id, enrollment);
    return true;
  }

  async save(enrollment: EnvironmentEnrollment): Promise<void> {
    this.#enrollments.set(enrollment.id, enrollment);
  }

  /**
   * Compare-and-set on the stored revision.
   *
   * The body reads and writes synchronously (no `await` between them), so it is
   * atomic with respect to any other microtask in this process.
   */
  async saveIfRevision(
    enrollment: EnvironmentEnrollment,
    expectedRevision: number,
  ): Promise<EnvironmentEnrollment | undefined> {
    const current = this.#enrollments.get(enrollment.id);
    if (current === undefined || current.revision !== expectedRevision) return undefined;
    this.#enrollments.set(enrollment.id, enrollment);
    return enrollment;
  }

  async get(enrollmentId: string): Promise<EnvironmentEnrollment | undefined> {
    return this.#enrollments.get(enrollmentId);
  }

  /**
   * Compare-and-set on the stored claim.
   *
   * The body reads and writes synchronously (no `await` between them), so it is
   * atomic with respect to any other microtask in this process: two concurrent
   * claims cannot both observe an unconsumed claim.
   */
  async consumeClaim(
    enrollmentId: string,
    expectedDigest: string,
    consumedAt: number,
  ): Promise<EnvironmentEnrollment | undefined> {
    const current = this.#enrollments.get(enrollmentId);
    if (current === undefined) return undefined;
    const claim = current.claim;
    if (claim === undefined || claim.consumedAt !== undefined || claim.secretDigest !== expectedDigest) {
      return undefined;
    }
    const consumed: EnvironmentEnrollment = {
      ...current,
      claim: { ...claim, consumedAt },
      updatedAt: consumedAt,
      revision: (current.revision ?? 0) + 1,
    };
    this.#enrollments.set(enrollmentId, consumed);
    return consumed;
  }

  async list(): Promise<readonly EnvironmentEnrollment[]> {
    return [...this.#enrollments.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}
