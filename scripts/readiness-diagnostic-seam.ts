/** Offline diagnostic seam; production Runtime never imports this file. */
import type {
  AuthorityScopeBinding,
  ObservationAuthorityVerifier,
  ReadinessObservationAuthority,
} from '../src/environment/readiness-authority.ts';

const registry = new WeakMap<object, AuthorityScopeBinding>();
export const verifyDiagnosticObservationAuthority: ObservationAuthorityVerifier = (authority, expected = {}) => {
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
export function diagnosticObservationAuthority(scope: Partial<AuthorityScopeBinding> & Pick<AuthorityScopeBinding, 'environmentInstanceId' | 'enrollmentId'>): ReadinessObservationAuthority {
  const binding: AuthorityScopeBinding = {
    environmentInstanceId: scope.environmentInstanceId, enrollmentId: scope.enrollmentId,
    connectionId: scope.connectionId ?? 'diagnostic-connection', connectionEpoch: scope.connectionEpoch ?? 1,
    lifecycleGeneration: scope.lifecycleGeneration ?? 0,
  };
  const authority: ReadinessObservationAuthority = Object.freeze({ ...binding, isCurrent: () => true });
  registry.set(authority, binding);
  return authority;
}
