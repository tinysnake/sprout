/**
 * In-memory lifecycle authority generations for one enrollment (R118-EPOCH-001).
 *
 * A Worker connection is accepted against a durable `approved` enrollment, but
 * acceptance spans awaits while a Human can revoke or reset concurrently. The
 * durable revision alone cannot fence that window: a revoke and an accepting
 * gateway can both observe the same approved revision before either has finished
 * writing.
 *
 * This Module is the synchronous tie-breaker. Every lifecycle decision bumps the
 * generation for its enrollment *before* it awaits its durable save, so an
 * accepting gateway can compare a generation captured at connect time with the
 * current generation in one run-to-completion step and refuse if a lifecycle
 * decision crossed the interval. It owns no durable state: it is a fence, not a
 * record, and it is deliberately shared by the enrollment service, the archive
 * service, and the gateway so they cannot disagree about which decision is newer.
 */

export class EnrollmentLifecycleAuthority {
  readonly #generations = new Map<string, number>();

  /** The current lifecycle generation for one enrollment (0 when untouched). */
  generation(enrollmentId: string): number {
    return this.#generations.get(enrollmentId) ?? 0;
  }

  /**
   * Record a lifecycle decision, returning the new generation.
   *
   * The mutation is synchronous and therefore ordered with the gateway's final
   * synchronous authority check, whichever runs first.
   */
  bump(enrollmentId: string): number {
    const next = this.generation(enrollmentId) + 1;
    this.#generations.set(enrollmentId, next);
    return next;
  }
}
