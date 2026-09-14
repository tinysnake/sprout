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
 * Lifecycle for M1: `active → (extend)* → expired | released`, with `recovering`
 * entered when a leaseholder or process dies mid-flight (#4, O4). A recovering
 * lease blocks subsequent acquisition until recovery resolves.
 */

export type LeaseState = 'active' | 'recovering' | 'expired' | 'released';

export interface EnvironmentLease {
  readonly id: string;
  readonly instanceId: string;
  readonly capability: string;
  readonly holderId: string;
  readonly runId?: string;
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
  | {
      readonly ok: false;
      readonly reason: AcquireLeaseFailure;
      readonly heldBy?: string;
      readonly state?: LeaseState;
      readonly leaseId?: string;
    };

export interface AcquireLeaseRequest {
  readonly instanceId: string;
  readonly capability: string;
  readonly holderId: string;
  readonly runId?: string;
  readonly ttlMs: number;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface LeaseStore {
  save(lease: EnvironmentLease): Promise<void> | void;
  get(leaseId: string): Promise<EnvironmentLease | undefined> | EnvironmentLease | undefined;
  list(): Promise<readonly EnvironmentLease[]> | readonly EnvironmentLease[];
}

export class InMemoryLeaseStore implements LeaseStore {
  readonly #leases = new Map<string, EnvironmentLease>();

  save(lease: EnvironmentLease): void {
    this.#leases.set(lease.id, lease);
  }

  get(leaseId: string): EnvironmentLease | undefined {
    return this.#leases.get(leaseId);
  }

  list(): readonly EnvironmentLease[] {
    return [...this.#leases.values()].sort((a, b) => b.acquiredAt - a.acquiredAt);
  }
}

export interface EnvironmentPoolOptions {
  readonly definitions: readonly EnvironmentDefinition[];
  readonly instances: readonly EnvironmentInstance[];
  readonly store?: LeaseStore;
  readonly leases?: readonly EnvironmentLease[];
  readonly clock?: Clock;
  /** Injected so tests get deterministic ids; production uses unique ids. */
  readonly idFactory?: () => string;
}

export class EnvironmentPool {
  readonly #definitions = new Map<string, EnvironmentDefinition>();
  readonly #instances = new Map<string, EnvironmentInstance>();
  readonly #leases = new Map<string, EnvironmentLease>();
  readonly #store: LeaseStore | undefined;
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
    this.#store = options.store;

    if (options.leases) {
      for (const lease of options.leases) {
        this.#leases.set(lease.id, lease);
      }
    }
    if (this.#store) {
      const stored = this.#store.list();
      if (Array.isArray(stored)) {
        for (const lease of stored) {
          if (!this.#leases.has(lease.id)) {
            this.#leases.set(lease.id, lease);
          }
        }
      }
    }
  }

  /** Reload leases from store (for stores with async list). */
  async load(): Promise<readonly EnvironmentLease[]> {
    if (!this.#store) return this.leases();
    const stored = await this.#store.list();
    for (const lease of stored) {
      if (!this.#leases.has(lease.id)) {
        this.#leases.set(lease.id, lease);
      }
    }
    return this.leases();
  }

  /**
   * One environment instance by id.
   *
   * Lets a run read instance-local facts (its working directory) without the
   * orchestrator holding its own copy of the instance table.
   */
  instance(instanceId: string): EnvironmentInstance | undefined {
    return this.#instances.get(instanceId);
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
      return {
        ok: false,
        reason: 'conflict',
        heldBy: current.holderId,
        state: current.state,
        leaseId: current.id,
      };
    }

    const now = this.#clock.now();
    const lease: EnvironmentLease = {
      id: this.#idFactory(),
      instanceId: request.instanceId,
      capability: request.capability,
      holderId: request.holderId,
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      acquiredAt: now,
      expiresAt: now + request.ttlMs,
      state: 'active',
    };
    this.#leases.set(lease.id, lease);
    this.#store?.save(lease);
    return { ok: true, lease };
  }

  /** Extend an active lease. Returns undefined when it is no longer active. */
  extendLease(leaseId: string, ttlMs: number): EnvironmentLease | undefined {
    const lease = this.#byId(leaseId);
    if (!lease || lease.state !== 'active') return undefined;
    const extended: EnvironmentLease = {
      ...lease,
      expiresAt: this.#clock.now() + ttlMs,
    };
    this.#leases.set(extended.id, extended);
    this.#store?.save(extended);
    return extended;
  }

  /** Release a lease; the instance immediately becomes acquirable again. */
  releaseLease(leaseId: string): EnvironmentLease | undefined {
    const lease = this.#byId(leaseId);
    if (!lease) return undefined;
    const released: EnvironmentLease = { ...lease, state: 'released' };
    this.#leases.set(released.id, released);
    this.#store?.save(released);
    return released;
  }

  /** Transition an active lease to recovering when its holder or process dies. */
  markRecovering(leaseId: string): EnvironmentLease | undefined {
    const lease = this.#leases.get(leaseId);
    if (!lease) return undefined;
    if (lease.state === 'recovering') return lease;
    if (lease.state !== 'active') return undefined;
    const recovering: EnvironmentLease = { ...lease, state: 'recovering' };
    this.#leases.set(recovering.id, recovering);
    this.#store?.save(recovering);
    return recovering;
  }

  /** Resolve recovery for a lease, releasing the instance. */
  resolveRecovery(leaseId: string): EnvironmentLease | undefined {
    const lease = this.#leases.get(leaseId);
    if (!lease || lease.state !== 'recovering') return undefined;
    return this.releaseLease(leaseId);
  }

  /** Look up any lease by id regardless of state. */
  getLease(leaseId: string): EnvironmentLease | undefined {
    return this.#leases.get(leaseId);
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

  /** Resolve a lease by id, returning active or recovering leases. */
  #byId(leaseId: string): EnvironmentLease | undefined {
    const lease = this.#leases.get(leaseId);
    if (!lease) return undefined;
    if (lease.state === 'released') return undefined;
    if (lease.state === 'recovering') return lease;
    if (lease.state !== 'active') return undefined;
    if (lease.expiresAt > this.#clock.now()) return lease;
    const expired: EnvironmentLease = { ...lease, state: 'expired' };
    this.#leases.set(lease.id, expired);
    this.#store?.save(expired);
    return undefined;
  }

  /**
   * Resolve the live lease for an instance. Expiry is evaluated lazily against
   * the clock so that a dead holder cannot block an instance forever.
   * A lease in recovery blocks acquisition until explicitly resolved.
   */
  #lease(instanceId: string): EnvironmentLease | undefined {
    for (const lease of this.#leases.values()) {
      if (lease.instanceId !== instanceId) continue;
      if (lease.state === 'recovering') return lease;
      if (lease.state !== 'active') continue;
      if (lease.expiresAt > this.#clock.now()) return lease;
      const expired: EnvironmentLease = { ...lease, state: 'expired' };
      this.#leases.set(lease.id, expired);
      this.#store?.save(expired);
    }
    return undefined;
  }
}
