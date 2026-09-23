/**
 * Types shared by the readiness write boundary and the authenticated Worker
 * gateway. Capability issuance intentionally does not live here: only
 * `WorkerGateway` owns the registry which can mint a production authority.
 */

export interface ReadinessObservationAuthority {
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
}

/**
 * Validates an authority against the private registry of its issuer. Production
 * composition supplies the authenticated WorkerGateway's verifier. Tests may
 * inject a verifier from a test-only harness; there is no general issuer here.
 */
export type ObservationAuthorityVerifier = (
  authority: unknown,
  expectedScope?: {
    readonly environmentInstanceId?: string;
    readonly enrollmentId?: string;
    readonly connectionEpoch?: number;
    readonly connectionId?: string;
    readonly lifecycleGeneration?: number;
  },
) => AuthorityScopeBinding | undefined;

/** Fail closed before Runtime has composed the authenticated gateway. */
export const refuseObservationAuthority: ObservationAuthorityVerifier = () => undefined;
