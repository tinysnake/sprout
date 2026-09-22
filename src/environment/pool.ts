import type {
  EnvironmentDefinition,
  EnvironmentInstance,
} from './model.ts';
import { randomUUID } from 'node:crypto';
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
export type LeaseHolderKind = 'run' | 'task';

export interface EnvironmentLease {
  readonly id: string;
  readonly instanceId: string;
  readonly capability: string;
  readonly holderId: string;
  /** Task-held vs run-held; absent only on a legacy persisted run lease (run). */
  readonly holderKind?: LeaseHolderKind;
  readonly runId?: string;
  readonly taskId?: string;
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
  readonly taskId?: string;
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

/**
 * The Task-held lease statements a Task's atomic begin/end boundary needs.
 *
 * A Task lifecycle commits its Task row and its Task-held lease in one shared
 * transaction. The environment domain owns the lease SQL, so the Task store
 * opens the boundary through the shared `TransactionCoordinator` and runs only
 * the lease-specific statements through this port; neither statement begins or
 * ends a transaction of its own, so the shared boundary stays exact.
 */
export interface TaskLeaseBinding {
  /** Refuse a live lease on the instance, then insert the Task-held lease. */
  insertTaskHeldLease(lease: EnvironmentLease): void;
  /** Refuse a lease that is not this Task's, then mark it released. */
  markTaskLeaseReleased(leaseId: string, taskId: string): void;
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
  /**
   * The instances currently eligible to admit new work (E2, #116).
   *
   * When supplied, `requiresLease` and therefore environment resolution treat
   * every other instance as unusable, so an ineligible catalog entry remains an
   * inspectable instance without admitting Project/run work. When omitted, every
   * present instance is eligible, which preserves the static M1 behaviour for
   * tests and callers that never opted into the dynamic catalog.
   */
  readonly eligibleInstanceIds?: readonly string[];
}

export class EnvironmentPool {
  readonly #definitions = new Map<string, EnvironmentDefinition>();
  readonly #instances = new Map<string, EnvironmentInstance>();
  readonly #leases = new Map<string, EnvironmentLease>();
  readonly #store: LeaseStore | undefined;
  readonly #clock: Clock;
  readonly #idFactory: () => string;
  /**
   * The dynamic eligibility gate (E2). `undefined` means every present instance
   * is eligible; a set means exactly those instances are.
   */
  #eligibleInstanceIds: ReadonlySet<string> | undefined;

  constructor(options: EnvironmentPoolOptions) {
    for (const definition of options.definitions) {
      this.#definitions.set(definition.id, definition);
    }
    for (const instance of options.instances) {
      this.#instances.set(instance.id, instance);
    }
    this.#eligibleInstanceIds =
      options.eligibleInstanceIds === undefined ? undefined : new Set(options.eligibleInstanceIds);
    this.#clock = options.clock ?? systemClock;
    // A lease is persisted, so a per-process counter would collide with a
    // released historical lease after Sprout restarts.  The default is durable
    // identity, while deterministic tests continue to inject `idFactory`.
    this.#idFactory = options.idFactory ?? (() => `lease-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
    this.#store = options.store;

    if (options.leases) {
      for (const lease of options.leases) {
        this.#leases.set(lease.id, normalizeLease(lease));
      }
    }
    if (this.#store) {
      const stored = this.#store.list();
      if (Array.isArray(stored)) {
        for (const lease of stored) {
          if (!this.#leases.has(lease.id)) {
            this.#leases.set(lease.id, normalizeLease(lease));
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
        this.#leases.set(lease.id, normalizeLease(lease));
      }
    }
    return this.leases();
  }

  /**
   * Replace the dynamic membership of this pool without touching lease state.
   *
   * Enrolled Environment instances are the dynamic execution catalog (E2,
   * ADR-0012), so the pool must observe catalog additions and state changes
   * while every existing active, recovering, expired, and released lease — and
   * every run or Task that historically named an instance — stays untouched and
   * readable. Only the instance/definition projection and the eligibility gate
   * are replaced; the lease map is never rebuilt or filtered by membership, so
   * a historical instance reference remains resolvable after the instance stops
   * being eligible.
   */
  synchronize(input: {
    readonly definitions: readonly EnvironmentDefinition[];
    readonly instances: readonly EnvironmentInstance[];
    readonly eligibleInstanceIds?: readonly string[];
  }): void {
    for (const definition of input.definitions) this.#definitions.set(definition.id, definition);
    for (const instance of input.instances) this.#instances.set(instance.id, instance);
    this.#eligibleInstanceIds =
      input.eligibleInstanceIds === undefined
        ? undefined
        : new Set(input.eligibleInstanceIds);
  }

  /** Whether an instance is currently eligible to admit new work. */
  isEligible(instanceId: string): boolean {
    return this.#eligibleInstanceIds === undefined || this.#eligibleInstanceIds.has(instanceId);
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
    return this.#acquireLease(request, true);
  }

  /** Reserve a Task lease for the lifecycle's atomic begin transaction. */
  reserveTaskLease(request: AcquireLeaseRequest): AcquireLeaseResult {
    if (request.taskId === undefined) throw new Error('only a Task lifecycle may reserve a Task lease');
    return this.#acquireLease(request, false);
  }

  /** Make a transactionally persisted Task lease visible in this pool. */
  adoptLease(lease: EnvironmentLease): void {
    this.#leases.set(lease.id, normalizeLease(lease));
  }

  /** Undo an unpersisted reservation after its enclosing transaction fails. */
  abandonReservation(leaseId: string): void {
    this.#leases.delete(leaseId);
  }

  #acquireLease(request: AcquireLeaseRequest, persist: boolean): AcquireLeaseResult {
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
      holderKind: request.taskId !== undefined ? 'task' : 'run',
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      acquiredAt: now,
      expiresAt: now + request.ttlMs,
      state: 'active',
    };
    // A lifecycle reservation is only a candidate until its Task binding and
    // lease row commit together. Keeping it out of observable pool state avoids
    // exposing an unowned live Task lease in the begin crash window.
    if (persist) {
      this.#leases.set(lease.id, lease);
      this.#store?.save(lease);
    }
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
    if (!lease || lease.holderKind === 'task') return undefined;
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
    if (!lease || lease.holderKind === 'task' || lease.state !== 'recovering') return undefined;
    return this.releaseLease(leaseId);
  }

  /** Complete a Task lifecycle release already committed with its terminal Task. */
  releaseTaskLease(leaseId: string): EnvironmentLease | undefined {
    const lease = this.#leases.get(leaseId);
    if (!lease || lease.holderKind !== 'task') return undefined;
    if (lease.state === 'released') return lease;
    if (lease.state !== 'active' && lease.state !== 'recovering') return undefined;
    const released: EnvironmentLease = { ...lease, state: 'released' };
    this.#leases.set(released.id, released);
    return released;
  }

  /** Resume a retained Task lease. Run leases must resolve recovery by release. */
  resumeTaskLease(leaseId: string): EnvironmentLease | undefined {
    const lease = this.#leases.get(leaseId);
    if (!lease || lease.holderKind !== 'task' || lease.state !== 'recovering') return undefined;
    const active: EnvironmentLease = { ...lease, state: 'active' };
    this.#leases.set(active.id, active);
    this.#store?.save(active);
    return active;
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
    // An ineligible instance is retained as an inspectable catalog entry, but it
    // cannot serve a capability for new work (E2). Returning `undefined` is the
    // same "cannot be used" signal the resolution seam already understands, so
    // lease acquisition and run resolution fail closed without a new branch.
    if (!this.isEligible(instanceId)) return undefined;
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
    if (lease.holderKind === 'task' || lease.expiresAt > this.#clock.now()) return lease;
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
      if (lease.holderKind === 'task' || lease.expiresAt > this.#clock.now()) return lease;
      const expired: EnvironmentLease = { ...lease, state: 'expired' };
      this.#leases.set(lease.id, expired);
      this.#store?.save(expired);
    }
    return undefined;
  }
}

/** Legacy rows predate holder_kind and are explicitly one-round Run leases. */
function normalizeLease(lease: EnvironmentLease): EnvironmentLease {
  return lease.holderKind === undefined ? { ...lease, holderKind: 'run' } : lease;
}
