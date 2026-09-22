/**
 * Worker connection epochs (#115, ADR-0012, CONTEXT.md).
 *
 * One Worker identity has exactly one authoritative connection epoch. Only the
 * current epoch may report Worker facts or run events; a newer epoch invalidates
 * the old one, and stale-epoch facts and events are rejected or ignored
 * deterministically. This Module owns that monotonic generation count so the
 * gateway, the service, and their tests cannot disagree about authority.
 *
 * The registry is deliberately in-memory: an epoch is the authority generation
 * of a live transport, so it has no meaning across a restart. After a restart the
 * first accepted connection is the new epoch and any old transport is already
 * gone, which fails closed rather than resurrecting authority.
 */

import { randomUUID } from 'node:crypto';

/** One accepted connection generation for an enrollment. */
export interface WorkerConnectionEpoch {
  /** Monotonic per enrollment, starting at 1 for the first accepted connection. */
  readonly epoch: number;
  /** The opaque id of the accepted connection this epoch names. */
  readonly connectionId: string;
  /** When this epoch was accepted. */
  readonly acceptedAt: number;
}

export type WorkerEpochDenial =
  | 'unknown-enrollment'
  | 'stale-epoch'
  | 'superseded'
  | 'not-current';

export type WorkerEpochDecision =
  | { readonly accepted: true; readonly epoch: WorkerConnectionEpoch }
  | { readonly accepted: false; readonly reason: WorkerEpochDenial };

export interface WorkerConnectionRegistryOptions {
  readonly clock?: () => number;
  readonly idFactory?: () => string;
}

/**
 * Tracks the current connection epoch per enrollment and invalidates the old one
 * when a newer connection is accepted.
 */
export class WorkerConnectionRegistry {
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  /** Current epoch per enrollment id. */
  readonly #current = new Map<string, WorkerConnectionEpoch>();
  /** Highest epoch ever accepted per enrollment, so a reconnect stays monotonic. */
  readonly #highWater = new Map<string, number>();
  /** Superseded connections, so a stale event can be classified deterministically. */
  readonly #superseded = new Set<string>();

  constructor(options: WorkerConnectionRegistryOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory ?? (() => `conn-${randomUUID()}`);
  }

  /**
   * Accept a new connection, invalidating any prior epoch.
   *
   * The returned epoch is strictly greater than the previous one for the same
   * enrollment, which is what makes "a newer epoch invalidates the old one"
   * observable.
   */
  accept(enrollmentId: string): WorkerConnectionEpoch {
    const previous = this.#current.get(enrollmentId);
    if (previous !== undefined) {
      // The old connection is now stale. Track it so a late event from it can be
      // named `superseded` instead of silently vanishing.
      this.#superseded.add(previous.connectionId);
    }
    // The high-water mark never decreases, so a connection that ends and is
    // replaced still receives a strictly greater epoch (monotonic authority).
    const next = (this.#highWater.get(enrollmentId) ?? 0) + 1;
    this.#highWater.set(enrollmentId, next);
    const epoch: WorkerConnectionEpoch = {
      epoch: next,
      connectionId: this.#idFactory(),
      acceptedAt: this.#clock(),
    };
    this.#current.set(enrollmentId, epoch);
    return epoch;
  }

  /** Whether a connection id is still the current authority for its enrollment. */
  isCurrent(enrollmentId: string, connectionId: string): boolean {
    return this.#current.get(enrollmentId)?.connectionId === connectionId;
  }

  /**
   * Decide whether this connection may report a fact or event right now.
   *
   * A caller that uses a superseded connection gets a typed denial, so it can
   * ignore the stale input rather than apply it.
   */
  decide(enrollmentId: string, connectionId: string): WorkerEpochDecision {
    const current = this.#current.get(enrollmentId);
    if (current !== undefined && current.connectionId === connectionId) {
      return { accepted: true, epoch: current };
    }
    if (this.#superseded.has(connectionId)) return { accepted: false, reason: 'superseded' };
    if (current === undefined) return { accepted: false, reason: 'unknown-enrollment' };
    return { accepted: false, reason: 'stale-epoch' };
  }

  /** Invalidate the current epoch without accepting a replacement. */
  invalidate(enrollmentId: string, connectionId: string): boolean {
    const current = this.#current.get(enrollmentId);
    if (current === undefined || current.connectionId !== connectionId) return false;
    this.#superseded.add(connectionId);
    this.#current.delete(enrollmentId);
    return true;
  }

  /** The current epoch for an enrollment, or `undefined` when none is accepted. */
  current(enrollmentId: string): WorkerConnectionEpoch | undefined {
    return this.#current.get(enrollmentId);
  }
}
