import type { ContractDelivery, EngineTurnResult } from '../engine/port.ts';

/**
 * Product-owned Worker diagnostic categories (ADR-0009).
 *
 * Values crossing a Worker log or protocol failure boundary come only from
 * this allowlist. They deliberately contain no endpoint, network fact, host
 * path, engine stderr, provider/account text, or caught Error message.
 */
export const WORKER_DIAGNOSTICS = {
  noEngine: 'no supported engine is available on this Environment host',
  startupFailed: 'the Environment Worker could not be started',
  identityReady: 'the host-local Worker identity is ready',
  outboundConnected: 'the outbound Worker connection is ready',
  outboundFailed: 'the outbound Worker connection could not be established',
  enrollmentUnavailable: 'the Worker enrollment is unavailable',
  enrollmentRevoked: 'the Worker enrollment is revoked',
  enrollmentClaimRefused: 'the one-use Worker enrollment claim was refused',
  identityProofRefused: 'the Worker identity proof was refused',
  enrollmentRefused: 'the Worker enrollment was refused',
  connectionRefused: 'the Worker connection was refused',
  transportReady: 'the Worker transport is ready',
  identificationSucceeded: 'the enrollment-backed Worker connection was identified',
  identificationFailed: 'the enrollment-backed Worker connection could not be identified',
  connectionUnavailable: 'no accepted enrollment-backed Worker connection is available',
  methodUnsupported: 'the requested Worker method is not supported',
  requestFailed: 'the Worker request could not be completed',
  sessionStartFailed: 'the engine session could not be started',
  resumeRefused: 'the engine refused the saved session',
  turnFailed: 'the engine turn failed',
  channelClosed: 'the Environment Worker channel closed',
  contractAgentsMd: 'project contract delivery: engine instruction file',
  contractSproutFile: 'project contract delivery: Sprout-owned instruction file',
  contractEngineHook: 'project contract delivery: engine configuration hook',
  contractUserOwned: 'project contract not delivered: existing user-owned instruction file',
  contractUnreadable: 'project contract not delivered: existing instruction file is unreadable',
  contractUnavailable: 'project contract not delivered: no supported delivery channel is available',
} as const;

export type WorkerDiagnostic = typeof WORKER_DIAGNOSTICS[keyof typeof WORKER_DIAGNOSTICS];

/** Replace an engine-owned failure message before it crosses Worker JSON-RPC. */
export function sanitizeEngineTurnResult(result: EngineTurnResult): EngineTurnResult {
  if (result.status !== 'failed') return result;
  return {
    ...result,
    message: result.resumeRefused === true
      ? WORKER_DIAGNOSTICS.resumeRefused
      : WORKER_DIAGNOSTICS.turnFailed,
  };
}

/** Report contract delivery semantics without forwarding host paths or reasons. */
export function contractDeliveryDiagnostic(delivery: ContractDelivery): WorkerDiagnostic {
  switch (delivery.mechanism) {
    case 'agents.md':
      return WORKER_DIAGNOSTICS.contractAgentsMd;
    case 'sprout-contract-file':
      return WORKER_DIAGNOSTICS.contractSproutFile;
    case 'engine-hook':
      return WORKER_DIAGNOSTICS.contractEngineHook;
    case 'skipped-user-owned':
      return WORKER_DIAGNOSTICS.contractUserOwned;
    case 'skipped-unreadable':
      return WORKER_DIAGNOSTICS.contractUnreadable;
    case 'unavailable':
      return WORKER_DIAGNOSTICS.contractUnavailable;
  }
}
