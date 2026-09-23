const readinessAuthorityBrand = Symbol('readinessAuthorityBrand');

/**
 * An owner-issued scoped capability binding Environment instance, enrollment,
 * accepted connection identity/epoch, and lifecycle generation (#125).
 *
 * Forged objects, copies, modified capabilities, scope substitution, and
 * caller-provided always-current callbacks cannot authorize observations. Only
 * the authenticated Worker connection / lifecycle owner may mint this capability.
 */
export interface ReadinessObservationAuthority {
  readonly [readinessAuthorityBrand]: true;
  readonly environmentInstanceId: string;
  readonly enrollmentId: string;
  readonly connectionId: string;
  readonly connectionEpoch: number;
  readonly lifecycleGeneration: number;
  isCurrent(): boolean;
}

export interface AuthorityScopeBinding {
  readonly environmentInstanceId: string;
  readonly enrollmentId: string;
  readonly connectionId: string;
  readonly connectionEpoch: number;
  readonly lifecycleGeneration: number;
  readonly checkLiveAuthority: () => boolean;
}

// A WeakMap private to this Module stores the immutable binding and the
// owner-bound synchronous verifier. Neither caller-provided callbacks nor
// copied/forged object literals can forge or reuse an entry here.
const authorityRegistry = new WeakMap<object, AuthorityScopeBinding>();

/**
 * Mint an authentic owner-issued observation capability.
 *
 * Internal to Sprout's connection and lifecycle owners; application-facing
 * callers cannot mint equivalent authority via raw epoch issuers.
 */
export function mintObservationAuthority(
  binding: AuthorityScopeBinding,
): ReadinessObservationAuthority {
  const authority: ReadinessObservationAuthority = Object.freeze({
    [readinessAuthorityBrand]: true as const,
    get environmentInstanceId() {
      return binding.environmentInstanceId;
    },
    get enrollmentId() {
      return binding.enrollmentId;
    },
    get connectionId() {
      return binding.connectionId;
    },
    get connectionEpoch() {
      return binding.connectionEpoch;
    },
    get lifecycleGeneration() {
      return binding.lifecycleGeneration;
    },
    isCurrent() {
      return binding.checkLiveAuthority();
    },
  });
  authorityRegistry.set(authority, binding);
  return authority;
}

/**
 * Validate an owner-issued capability and verify its exact scope binding.
 *
 * Refuses forged objects, shallow/deep copies, tampered properties, and scope
 * substitution (different instance, enrollment, connection id, epoch, or
 * lifecycle generation).
 */
export function verifyObservationAuthority(
  authority: unknown,
  expectedScope?: {
    readonly environmentInstanceId?: string;
    readonly enrollmentId?: string;
    readonly connectionEpoch?: number;
    readonly connectionId?: string;
    readonly lifecycleGeneration?: number;
  },
): AuthorityScopeBinding | undefined {
  if (typeof authority !== 'object' || authority === null) return undefined;
  const binding = authorityRegistry.get(authority);
  if (binding === undefined) return undefined;
  if (expectedScope !== undefined) {
    if (
      expectedScope.environmentInstanceId !== undefined &&
      binding.environmentInstanceId !== expectedScope.environmentInstanceId
    ) {
      return undefined;
    }
    if (
      expectedScope.enrollmentId !== undefined &&
      binding.enrollmentId !== expectedScope.enrollmentId
    ) {
      return undefined;
    }
    if (
      expectedScope.connectionEpoch !== undefined &&
      binding.connectionEpoch !== expectedScope.connectionEpoch
    ) {
      return undefined;
    }
    if (
      expectedScope.connectionId !== undefined &&
      binding.connectionId !== expectedScope.connectionId
    ) {
      return undefined;
    }
    if (
      expectedScope.lifecycleGeneration !== undefined &&
      binding.lifecycleGeneration !== expectedScope.lifecycleGeneration
    ) {
      return undefined;
    }
  }
  return binding;
}

/**
 * Internal/test-only helper for composition injection.
 *
 * Not exposed on SproutRuntime or any production API surface. Allows unit
 * tests to exercise storage and observation boundaries without running a full
 * WebSocket gateway.
 */
export function mintTestObservationAuthority(scope: {
  readonly environmentInstanceId: string;
  readonly enrollmentId: string;
  readonly connectionId?: string;
  readonly connectionEpoch?: number;
  readonly lifecycleGeneration?: number;
  readonly isCurrent?: () => boolean;
}): ReadinessObservationAuthority {
  const connectionId = scope.connectionId ?? 'test-conn-1';
  const connectionEpoch = scope.connectionEpoch ?? 1;
  const lifecycleGeneration = scope.lifecycleGeneration ?? 0;
  const isCurrent = scope.isCurrent ?? (() => true);
  return mintObservationAuthority({
    environmentInstanceId: scope.environmentInstanceId,
    enrollmentId: scope.enrollmentId,
    connectionId,
    connectionEpoch,
    lifecycleGeneration,
    checkLiveAuthority: isCurrent,
  });
}
