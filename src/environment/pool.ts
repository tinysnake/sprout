import type {
  EnvironmentDefinition,
  EnvironmentInstance,
  EnvironmentLeaseMode,
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
export type LeaseMode = EnvironmentLeaseMode;

export const READ_ONLY_LEASE_SEMANTICS =
  'Read-only leases allow concurrent readers. Files may change while a lease is held; there is no snapshot or copy-on-write.';

export interface LeaseConflictHolder {
  readonly leaseId: string;
  readonly holderId: string;
  readonly state: 'active' | 'recovering';
}

export type AcquireLeaseConflict =
  | { readonly kind: 'reader-blocked-by-writer'; readonly writer: LeaseConflictHolder }
  | { readonly kind: 'writer-blocked-by-writer'; readonly writer: LeaseConflictHolder }
  | { readonly kind: 'writer-blocked-by-readers'; readonly readers: readonly LeaseConflictHolder[] }
  | { readonly kind: 'recovery'; readonly holders: readonly LeaseConflictHolder[] };

export interface EnvironmentLease {
  readonly id: string;
  readonly instanceId: string;
  readonly capability: string;
  readonly mode: LeaseMode;
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
  | 'mode-not-supported'
  | 'conflict';

export type AcquireLeaseResult =
  | { readonly ok: true; readonly lease: EnvironmentLease }
  | {
      readonly ok: false;
      readonly reason: AcquireLeaseFailure;
      readonly heldBy?: string;
      readonly state?: LeaseState;
      readonly leaseId?: string;
      readonly conflict?: AcquireLeaseConflict;
    };

export interface AcquireLeaseRequest {
  readonly instanceId: string;
  readonly capability: string;
  readonly mode: LeaseMode;
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
  /** Refuse incompatible live leases, then insert the Task-held lease. */
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
  /** Additional capability-specific eligibility for bounded non-inference services such as Project MCP. */
  readonly capabilityEligibleInstanceIds?: Readonly<Record<string, readonly string[]>>;
}

export class EnvironmentPool {
  readonly #definitions = new Map<string, EnvironmentDefinition>();
  readonly #instances = new Map<string, EnvironmentInstance>();
  readonly #leases = new Map<string, EnvironmentLease>();
  readonly #cleanupProtectedLeases = new Set<string>();
  readonly #store: LeaseStore | undefined;
  readonly #clock: Clock;
  readonly #idFactory: () => string;
  #revalidateTaskLease: ((lease: EnvironmentLease) => Promise<void>) | undefined;
  /**
   * The dynamic eligibility gate (E2). `undefined` means every present instance
   * is eligible; a set means exactly those instances are.
   */
  #eligibleInstanceIds: ReadonlySet<string> | undefined;
  #capabilityEligibleInstanceIds = new Map<string, ReadonlySet<string>>();

  constructor(options: EnvironmentPoolOptions) {
    for (const definition of options.definitions) {
      this.#definitions.set(definition.id, definition);
    }
    for (const instance of options.instances) {
      this.#instances.set(instance.id, instance);
    }
    this.#eligibleInstanceIds =
      options.eligibleInstanceIds === undefined ? undefined : new Set(options.eligibleInstanceIds);
    this.#capabilityEligibleInstanceIds = new Map(Object.entries(options.capabilityEligibleInstanceIds ?? {})
      .map(([capability, ids]) => [capability, new Set(ids)]));
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
    readonly capabilityEligibleInstanceIds?: Readonly<Record<string, readonly string[]>>;
  }): void {
    for (const definition of input.definitions) this.#definitions.set(definition.id, definition);
    for (const instance of input.instances) this.#instances.set(instance.id, instance);
    this.#eligibleInstanceIds =
      input.eligibleInstanceIds === undefined
        ? undefined
        : new Set(input.eligibleInstanceIds);
    this.#capabilityEligibleInstanceIds = new Map(Object.entries(input.capabilityEligibleInstanceIds ?? {})
      .map(([capability, ids]) => [capability, new Set(ids)]));
  }

  /** Whether an instance is currently eligible to admit new work. */
  isEligible(instanceId: string): boolean {
    return this.#eligibleInstanceIds === undefined || this.#eligibleInstanceIds.has(instanceId);
  }

  definition(instanceId: string): EnvironmentDefinition | undefined {
    const instance = this.#instances.get(instanceId);
    return instance === undefined ? undefined : this.#definitions.get(instance.definitionId);
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

  /** Whether a lease-bearing capability exists for an already-authorized bound operation. */
  requiresLeaseForBoundOperation(instanceId: string, capability: string): boolean | undefined {
    return this.#capability(instanceId, capability)?.requiresLease;
  }

  /**
   * Acquire a lease for work already authorized by a live bound operation route.
   * This deliberately bypasses model-admission eligibility only; callers must
   * revalidate the Worker authority, Project binding, permission, and epoch.
   */
  async acquireBoundOperationLeaseRevalidated(request: AcquireLeaseRequest): Promise<AcquireLeaseResult> {
    await this.revalidateTaskLease(request.instanceId);
    const recovering = this.#liveLeases(request.instanceId).filter((lease) => lease.state === 'recovering');
    if (recovering.length > 0) return this.#conflict(request.mode, recovering);
    return this.#acquireLease(request, true, true);
  }

  /** Whether a capability must be leased before it can be used. */
  requiresLease(instanceId: string, capability: string): boolean | undefined {
    const found = this.#lookup(instanceId, capability);
    return found ? found.requiresLease : undefined;
  }

  /**
   * Acquire access according to the capability's declared lease mode.
   *
   * Failure is returned rather than thrown so callers can surface a precise
   * observable state; a conflicting request never silently queues.
   */
  acquireLease(request: AcquireLeaseRequest): AcquireLeaseResult {
    return this.#acquireLease(request, true);
  }

  /** The Task lifecycle owns durable recovery; the pool never releases overdue Task work. */
  setTaskLeaseRevalidator(revalidate: (lease: EnvironmentLease) => Promise<void>): void {
    this.#revalidateTaskLease = revalidate;
  }

  /** Revalidate an overdue Task holder before admitting competing production work. */
  async revalidateTaskLease(instanceId: string): Promise<void> {
    const live = this.#liveLeases(instanceId);
    const lease = live.find((candidate) => candidate.holderKind === 'task' && candidate.state === 'active');
    if (lease !== undefined && lease.expiresAt <= this.#clock.now()) {
      await this.#revalidateTaskLease?.(lease);
    }
  }

  async acquireLeaseRevalidated(request: AcquireLeaseRequest): Promise<AcquireLeaseResult> {
    await this.revalidateTaskLease(request.instanceId);
    // Opening recovery can remove the instance from the eligible catalog. Keep
    // its decisive conflict rather than degrading it to unknown-capability.
    const recovering = this.#liveLeases(request.instanceId).filter((lease) => lease.state === 'recovering');
    if (recovering.length > 0) return this.#conflict(request.mode, recovering);
    return this.acquireLease(request);
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

  #acquireLease(request: AcquireLeaseRequest, persist: boolean, allowIneligible = false): AcquireLeaseResult {
    const found = allowIneligible ? this.#capability(request.instanceId, request.capability) : this.#lookup(request.instanceId, request.capability);
    if (!found) {
      return {
        ok: false,
        reason: this.#instances.has(request.instanceId) ? 'unknown-capability' : 'unknown-instance',
      };
    }
    if (!found.requiresLease) {
      return { ok: false, reason: 'lease-not-required' };
    }

    const declaredMode = found.leaseMode ?? 'read-write';
    const requestedMode = request.mode ?? declaredMode;
    if (requestedMode !== declaredMode) {
      return { ok: false, reason: 'mode-not-supported' };
    }

    const current = this.#liveLeases(request.instanceId);
    const blockers = current.filter((lease) =>
      lease.state === 'recovering' || requestedMode === 'read-write' || lease.mode === 'read-write');
    if (blockers.length > 0) return this.#conflict(requestedMode, blockers);

    const now = this.#clock.now();
    const lease: EnvironmentLease = {
      id: this.#idFactory(),
      instanceId: request.instanceId,
      capability: request.capability,
      mode: requestedMode,
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

  /** Attached process/workspace owners require cleanup proof even if renewal stops. */
  protectLeaseUntilCleanup(leaseId: string): void {
    const lease = this.#leases.get(leaseId);
    if (!lease || lease.state !== 'active') throw new Error('Active lease required for cleanup protection');
    this.#cleanupProtectedLeases.add(leaseId);
  }

  /** Renew a cleanup-protected owner using the same TTL-fraction policy at every attachment stage. */
  keepLeaseUntilCleanup(leaseId: string, ttlMs: number, onRenewalLoss: () => void = () => undefined): () => void {
    this.protectLeaseUntilCleanup(leaseId);
    const interval = setInterval(() => {
      if (this.extendLease(leaseId, ttlMs) !== undefined) return;
      clearInterval(interval);
      const lease = this.getLease(leaseId);
      if (lease?.state === 'released') return;
      this.markRecovering(leaseId);
      onRenewalLoss();
    }, Math.max(1, Math.floor(ttlMs / 3)));
    interval.unref?.();
    // Stopping renewal never removes cleanup protection. Only proven release does.
    return () => clearInterval(interval);
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
    this.#cleanupProtectedLeases.delete(leaseId);
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

  /** Complete a Task lease release after its durable Task transition commits. */
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
  resumeTaskLease(leaseId: string, ttlMs = 300_000): EnvironmentLease | undefined {
    const lease = this.#leases.get(leaseId);
    if (!lease || lease.holderKind !== 'task' || lease.state !== 'recovering') return undefined;
    const active: EnvironmentLease = { ...lease, state: 'active',
      expiresAt: this.#clock.now() + ttlMs };
    this.#leases.set(active.id, active);
    this.#store?.save(active);
    return active;
  }

  /** Restore a lease snapshot verbatim after a compensated lifecycle write. */
  restoreLease(lease: EnvironmentLease): EnvironmentLease {
    this.#leases.set(lease.id, lease);
    this.#store?.save(lease);
    return lease;
  }

  /** Look up any lease by id regardless of state. */
  getLease(leaseId: string): EnvironmentLease | undefined {
    return this.#leases.get(leaseId);
  }

  /** The active or recovering leases for an instance. */
  activeLeases(instanceId: string): readonly EnvironmentLease[] {
    return this.#liveLeases(instanceId);
  }

  /** The first active or recovering lease for legacy single-holder callers. */
  activeLease(instanceId: string): EnvironmentLease | undefined {
    return this.#liveLeases(instanceId)[0];
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
    if (!this.isEligible(instanceId) && !this.#capabilityEligibleInstanceIds.get(capability)?.has(instanceId)) return undefined;
    return this.#capability(instanceId, capability);
  }

  #capability(instanceId: string, capability: string) {
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
    if (this.#cleanupProtectedLeases.has(lease.id)) {
      this.markRecovering(lease.id);
      return undefined;
    }
    const expired: EnvironmentLease = { ...lease, state: 'expired' };
    this.#leases.set(lease.id, expired);
    this.#store?.save(expired);
    return undefined;
  }

  #conflict(mode: LeaseMode, holders: readonly EnvironmentLease[]): AcquireLeaseResult {
    const details: LeaseConflictHolder[] = holders.map((lease) => ({
      leaseId: lease.id,
      holderId: lease.holderId,
      state: lease.state === 'recovering' ? 'recovering' : 'active',
    }));
    const recovering = details.filter((holder) => holder.state === 'recovering');
    const conflict: AcquireLeaseConflict = recovering.length > 0
      ? { kind: 'recovery', holders: recovering }
      : mode === 'read-write'
        ? details.every((holder) => holders.find((lease) => lease.id === holder.leaseId)?.mode === 'read')
          ? { kind: 'writer-blocked-by-readers', readers: details }
          : { kind: 'writer-blocked-by-writer', writer: details[0]! }
        : { kind: 'reader-blocked-by-writer', writer: details[0]! };
    const first = details[0];
    return {
      ok: false,
      reason: 'conflict',
      ...(first !== undefined ? { heldBy: first.holderId, state: first.state, leaseId: first.leaseId } : {}),
      conflict,
    };
  }

  /** Resolve active or recovering holders, expiring overdue ordinary run leases. */
  #liveLeases(instanceId: string): EnvironmentLease[] {
    const live: EnvironmentLease[] = [];
    for (const lease of this.#leases.values()) {
      if (lease.instanceId !== instanceId) continue;
      if (lease.state === 'recovering') {
        live.push(lease);
        continue;
      }
      if (lease.state !== 'active') continue;
      if (lease.holderKind === 'task' || lease.expiresAt > this.#clock.now()) {
        live.push(lease);
        continue;
      }
      if (this.#cleanupProtectedLeases.has(lease.id)) {
        const recovering = this.markRecovering(lease.id);
        if (recovering !== undefined) live.push(recovering);
        continue;
      }
      const expired: EnvironmentLease = { ...lease, state: 'expired' };
      this.#leases.set(expired.id, expired);
      this.#store?.save(expired);
    }
    return live.sort((a, b) => a.acquiredAt - b.acquiredAt);
  }
}

/** Legacy rows predate holder_kind and lease mode, and stay exclusive Run leases. */
function normalizeLease(lease: EnvironmentLease): EnvironmentLease {
  return {
    ...lease,
    mode: lease.mode === 'read' ? 'read' : 'read-write',
    ...(lease.holderKind === undefined ? { holderKind: 'run' as const } : {}),
  };
}
