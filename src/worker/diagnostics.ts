import type { ContractDelivery, EngineTurnResult } from '../engine/port.ts';
import { classifyEngineTurnFailure, sanitizedTurnFailure, trustedTurnFailureMessage } from '../engine/turn-failure.ts';
import { PROTOCOL_INCOMPATIBLE_DETAIL } from '../environment/readiness.ts';
import { WORKER_TRANSPORT_REFUSAL_REASON } from '../environment/worker-transport.ts';

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
  protocolIncompatible: PROTOCOL_INCOMPATIBLE_DETAIL,
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

/**
 * The finite set of server refusal reasons that are static, product-owned,
 * secret-free strings.
 *
 * A refusal crosses the CLI boundary only when its reason is exactly one of
 * these. Any other server-supplied text is treated as untrusted, because it
 * could echo identity key material, an absolute host path, or a token-bearing
 * URL; those paths keep the caller-supplied sanitized fallback.
 */
const STATIC_REFUSAL_REASONS: readonly string[] = [
  WORKER_TRANSPORT_REFUSAL_REASON,
  WORKER_DIAGNOSTICS.enrollmentUnavailable,
  WORKER_DIAGNOSTICS.enrollmentRevoked,
  WORKER_DIAGNOSTICS.enrollmentClaimRefused,
  WORKER_DIAGNOSTICS.identityProofRefused,
  WORKER_DIAGNOSTICS.enrollmentRefused,
  WORKER_DIAGNOSTICS.connectionRefused,
  WORKER_DIAGNOSTICS.protocolIncompatible,
  'the Worker identity is not approved for work',
  'a newer Worker connection epoch superseded this connection',
];

/**
 * The reason itself when it is a known, static refusal string, else `undefined`.
 *
 * This is the allowlist gate for server-supplied refusal text: only strings that
 * this build authored may leave the process.
 */
export function staticRefusalReason(reason: string): string | undefined {
  return STATIC_REFUSAL_REASONS.includes(reason) ? reason : undefined;
}

/** Replace an engine-owned failure message before it crosses Worker JSON-RPC. */
export function sanitizeEngineTurnResult(result: EngineTurnResult, engine?: string): EngineTurnResult {
  if (result.status !== 'failed') return result;
  const cause = classifyEngineTurnFailure(result);
  const message = result.resumeRefused === true
    ? WORKER_DIAGNOSTICS.resumeRefused
    : cause !== undefined && engine !== undefined
      ? trustedTurnFailureMessage(sanitizedTurnFailure(engine, cause)) ?? WORKER_DIAGNOSTICS.turnFailed
      : trustedTurnFailureMessage(result.message) ?? WORKER_DIAGNOSTICS.turnFailed;
  // Select the neutral result fields explicitly. Never spread a decoded engine
  // error, response body, code or diagnostic into Worker JSON-RPC/journal data.
  return {
    status: 'failed', message,
    ...(result.stopReason === 'error' ? { stopReason: result.stopReason } : {}),
    ...(result.resumeRefused === true ? { resumeRefused: true } : {}),
    ...(result.tokenUsage !== undefined ? { tokenUsage: result.tokenUsage } : {}),
    ...(result.detailedTokens !== undefined ? { detailedTokens: result.detailedTokens } : {}),
    ...(result.engineTurnDurationMs !== undefined ? { engineTurnDurationMs: result.engineTurnDurationMs } : {}),
    ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {}),
    ...(result.billingBasis !== undefined ? { billingBasis: result.billingBasis } : {}),
    ...(result.source !== undefined ? { source: result.source } : {}),
    ...(result.sourceVersion !== undefined ? { sourceVersion: result.sourceVersion } : {}),
    ...(result.pricingContext !== undefined ? { pricingContext: result.pricingContext } : {}),
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
