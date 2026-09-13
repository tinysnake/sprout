import type {
  EnvironmentDefinition,
  EnvironmentInstance,
} from './model.ts';
import { findCapability } from './model.ts';

/**
 * Environment lease registry.
 *
 * The runtime provides no mutual exclusion of its own (#4: Docker enforces
 * unique names only), so the registry is what stops two runs from holding the
 * same capacity-intensive instance at once.
 *
 * Lifecycle for M1: `active → (extend)* → expired | released`. The `recovering`
 * state from #4 is deliberately absent: dirty work cannot exist yet because no
 * slice mutates an environment. It arrives with O4.
 */

export type LeaseState = 'active' | 'expired' | 'released';

export interface EnvironmentLease {
  readonly id: string;
  readonly instanceId: string;
  readonly capability: string;
  readonly holderId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly state: LeaseState;
}

export type AcquireLeaseFailure =
  | 'unknown-instance'
  | 'unknown-capability'
  | 'lease-not-required'
  | 'conflict';

export type AcquireLeaseResult =
  | { readonly ok: true; readonly lease: EnvironmentLease }
  | { readonly ok: false; readonly reason: AcquireLeaseFailure; readonly heldBy?: string };

export interface AcquireLeaseRequest {
  readonly instanceId: string;
  readonly capability: string;
  readonly holderId: string;
  readonly ttlMs: number;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface EnvironmentPoolOptions {
  readonly definitions: readonly EnvironmentDefinition[];
  readonly instances: readonly EnvironmentInstance[];
  readonly clock?: Clock;
  /** Injected so tests get deterministic ids; production uses unique ids. */
  readonly idFactory?: () => string;
}

export class EnvironmentPool {
  readonly #definitions = new Map<string, EnvironmentDefinition>();
  readonly #instances = new Map<string, EnvironmentInstance>();
  readonly #leases = new Map<string, EnvironmentLease>();
  readonly #clock: Clock;
  readonly #idFactory: () => string;
  #counter = 0;

  constructor(options: EnvironmentPoolOptions) {
    for (const definition of options.definitions) {
      this.#definitions.set(definition.id, definition);
    }
    for (const instance of options.instances) {
      this.#instances.set(instance.id, instance);
    }
    this.#clock = options.clock ?? systemClock;
    this.#idFactory = options.idFactory ?? (() => `lease-${++this.#counter}`);
  }

  /** Whether a capability must be leased before it can be used. */
  requiresLease(instanceId: string, capability: string): boolean | undefined {
    const found = this.#lookup(instanceId, capability);
    return found ? found.requiresLease : undefined;
  }

  /**
   * Acquire exclusive use of one instance for one capability.
   *
   * Failure is returned rather than thrown so callers can surface a precise
   * observable state; a conflicting request never silently queues.
   */
  acquireLease(request: AcquireLeaseRequest): AcquireLeaseResult {
    const found = this.#lookup(request.instanceId, request.capability);
    if (!found) {
      return {
        ok: false,
        reason: this.#instances.has(request.instanceId) ? 'unknown-capability' : 'unknown-instance',
      };
    }
    if (!found.requiresLease) {
      return { ok: false, reason: 'lease-not-required' };
    }

    const current = this.#lease(request.instanceId);
    if (current) {
      return { ok: false, reason: 'conflict', heldBy: current.holderId };
    }

    const now = this.#clock.now();
    const lease: EnvironmentLease = {
      id: this.#idFactory(),
      instanceId: request.instanceId,
      capability: request.capability,
      holderId: request.holderId,
      acquiredAt: now,
      expiresAt: now + request.ttlMs,
      state: 'active',
    };
    this.#leases.set(lease.id, lease);
    return { ok: true, lease };
  }

  /** Extend an active lease. Returns undefined when it is no longer active. */
  extendLease(leaseId: string, ttlMs: number): EnvironmentLease | undefined {
    const lease = this.#byId(leaseId);
    if (!lease) return undefined;
    const extended: EnvironmentLease = {
      ...lease,
      expiresAt: this.#clock.now() + ttlMs,
    };
    this.#leases.set(extended.id, extended);
    return extended;
  }

  /** Release a lease; the instance immediately becomes acquirable again. */
  releaseLease(leaseId: string): EnvironmentLease | undefined {
    const lease = this.#byId(leaseId);
    if (!lease) return undefined;
    const released: EnvironmentLease = { ...lease, state: 'released' };
    this.#leases.set(released.id, released);
    return released;
  }

  /** The active lease for an instance, if any. */
  activeLease(instanceId: string): EnvironmentLease | undefined {
    return this.#lease(instanceId);
  }

  /** Every lease ever acquired, newest state first. */
  leases(): readonly EnvironmentLease[] {
    return [...this.#leases.values()].sort((a, b) => b.acquiredAt - a.acquiredAt);
  }

  #lookup(instanceId: string, capability: string) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return undefined;
    const definition = this.#definitions.get(instance.definitionId);
    if (!definition) return undefined;
    return findCapability(definition, capability);
  }

  /** Resolve a lease by id, expiring it lazily. */
  #byId(leaseId: string): EnvironmentLease | undefined {
    const lease = this.#leases.get(leaseId);
    if (!lease || lease.state !== 'active') return undefined;
    if (lease.expiresAt > this.#clock.now()) return lease;
    this.#leases.set(lease.id, { ...lease, state: 'expired' });
    return undefined;
  }

  /**
   * Resolve the live lease for an instance. Expiry is evaluated lazily against
   * the clock so that a dead holder cannot block an instance forever.
   */
  #lease(instanceId: string): EnvironmentLease | undefined {
    for (const lease of this.#leases.values()) {
      if (lease.instanceId !== instanceId || lease.state !== 'active') continue;
      if (lease.expiresAt > this.#clock.now()) return lease;
      this.#leases.set(lease.id, { ...lease, state: 'expired' });
    }
    return undefined;
  }
}
