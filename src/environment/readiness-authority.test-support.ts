/** Test-only authority seam. Never import from production composition or scripts. */
import type {
  AuthorityScopeBinding,
  ObservationAuthorityVerifier,
  ReadinessObservationAuthority,
} from './readiness-authority.ts';

export interface ReadinessAuthorityTestSeam {
  readonly verify: ObservationAuthorityVerifier;
  mint(scope: Partial<AuthorityScopeBinding> & Pick<AuthorityScopeBinding, 'environmentInstanceId' | 'enrollmentId'> & { readonly isCurrent?: () => boolean }): ReadinessObservationAuthority;
}

export function createReadinessAuthorityTestSeam(): ReadinessAuthorityTestSeam {
  const registry = new WeakMap<object, AuthorityScopeBinding>();
  const verify: ObservationAuthorityVerifier = (authority, expected = {}) => {
    if (typeof authority !== 'object' || authority === null) return undefined;
    const scope = registry.get(authority);
    if (scope === undefined ||
      (expected.environmentInstanceId !== undefined && scope.environmentInstanceId !== expected.environmentInstanceId) ||
      (expected.enrollmentId !== undefined && scope.enrollmentId !== expected.enrollmentId) ||
      (expected.connectionId !== undefined && scope.connectionId !== expected.connectionId) ||
      (expected.connectionEpoch !== undefined && scope.connectionEpoch !== expected.connectionEpoch) ||
      (expected.lifecycleGeneration !== undefined && scope.lifecycleGeneration !== expected.lifecycleGeneration)) return undefined;
    return scope;
  };
  return {
    verify,
    mint(scope) {
      const { isCurrent = () => true } = scope;
      const binding: AuthorityScopeBinding = {
        environmentInstanceId: scope.environmentInstanceId, enrollmentId: scope.enrollmentId,
        connectionId: scope.connectionId ?? 'test-connection', connectionEpoch: scope.connectionEpoch ?? 1,
        lifecycleGeneration: scope.lifecycleGeneration ?? 0,
      };
      const authority: ReadinessObservationAuthority = Object.freeze({ ...binding, isCurrent });
      registry.set(authority, binding);
      return authority;
    },
  };
}
