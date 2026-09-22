/**
 * The enrollment-backed Worker gateway handshake (#115, ADR-0012).
 *
 * A Worker initiates exactly one outbound WS/WSS connection to the Sprout
 * instance. Before that connection carries any Worker command, the Worker claims
 * its pending enrollment with a one-use secret (read outside the command line)
 * and proves possession of its generated key. Only then does the same
 * bidirectional channel carry the existing neutral, line-framed Worker JSON-RPC.
 *
 * This Module owns only the handshake frames. The JSON-RPC payloads stay in
 * `protocol.ts`, so no engine or Worker command detail leaks into authentication.
 */

import type { WorkerIdentityProof } from '../environment/worker-proof.ts';
import type { EnrollmentEngineFact } from '../environment/enrollment.ts';

/** The first frame a Worker sends after the transport is established. */
export interface WorkerGatewayHello {
  readonly type: 'worker/hello';
  readonly enrollmentId: string;
  /**
   * The one-use host claim secret. Sent only on the first connection after a
   * pending enrollment was created; a reconnect omits it. The separate
   * `worker/claim` frame carries it when the core asks for it.
   */
  readonly claimSecret?: string;
}

/** The Worker presents the one-use secret the core requested. */
export interface WorkerGatewayClaim {
  readonly type: 'worker/claim';
  readonly claimSecret: string;
}

/** The Worker signs the core's nonce to prove key possession. */
export interface WorkerGatewayProve {
  readonly type: 'worker/prove';
  readonly proof: WorkerIdentityProof;
  readonly platform: string;
  /**
   * Untrusted JSON evidence retained with its original type.
   *
   * The decoder must distinguish an omitted version from a present value of
   * the wrong JSON type so the gateway can fail the latter closed. Consumers
   * may validate a string token, but must never repeat the raw value in an
   * operator-visible or durable diagnostic.
   */
  readonly protocolVersion?: unknown;
  readonly capabilityRequests?: readonly string[];
  readonly engineFacts?: readonly EnrollmentEngineFact[];
}

/**
 * The Worker confirms it received `worker/accepted` and is switching to JSON-RPC.
 *
 * This is the ordering barrier that keeps the handshake and the neutral JSON-RPC
 * from interleaving: the core starts its JSON-RPC only after this frame, so no
 * `worker/info` request can arrive in the same chunk as `worker/accepted` and be
 * mistaken for a handshake frame.
 */
export interface WorkerGatewayReady {
  readonly type: 'worker/ready';
}

/** Any frame a Worker may send during the handshake. */
export type WorkerGatewayClientFrame = WorkerGatewayHello | WorkerGatewayClaim | WorkerGatewayProve | WorkerGatewayReady;

/** The core asks the Worker for its one-use claim secret. */
export interface WorkerGatewayClaimRequired {
  readonly type: 'worker/claim-required';
  readonly enrollmentId: string;
}

/** The core issues a short-lived, single-use identity challenge. */
export interface WorkerGatewayChallenged {
  readonly type: 'worker/challenged';
  readonly challenge: { readonly id: string; readonly enrollmentId: string; readonly nonce: string };
}

/** The core accepted the connection; the JSON-RPC channel now has this epoch. */
export interface WorkerGatewayAccepted {
  readonly type: 'worker/accepted';
  readonly enrollmentId: string;
  readonly environmentInstanceId: string;
  readonly epoch: number;
  readonly connectionId: string;
}

/**
 * The core has registered the JSON-RPC channel and the Worker may now return.
 *
 * This is the second handshake barrier: after `worker/accepted` the Worker sends
 * `worker/ready`, and only when the core answers `worker/listening` is the
 * accepted connection registered and safe for the caller to use. It keeps the
 * core's acceptance observable to the Worker rather than racing it.
 */
export interface WorkerGatewayListening {
  readonly type: 'worker/listening';
  readonly epoch: number;
}

/** The identity is proven but a Human has not approved work yet. */
export interface WorkerGatewayPending {
  readonly type: 'worker/pending';
  readonly enrollmentId: string;
  readonly outcome: string;
  /**
   * The environment instance the proven identity belongs to, when known.
   *
   * The Worker CLI persists it so a later `start` and its LaunchAgent can be
   * installed before a Human approves, without inventing a host identity (#117).
   */
  readonly environmentInstanceId?: string;
}

/** The core refused the connection before any Worker command was accepted. */
export interface WorkerGatewayRefused {
  readonly type: 'worker/refused';
  readonly reason: string;
  /**
   * A neutral, machine-readable refusal category (#117).
   *
   * The Worker CLI uses it to distinguish an `incompatible` protocol from a
   * `revoked` identity so `status` can report the right state instead of a bare
   * `stopped`. It carries no host or credential detail.
   */
  readonly code?: 'refused' | 'incompatible' | 'revoked';
}

export type WorkerGatewayServerFrame =
  | WorkerGatewayClaimRequired
  | WorkerGatewayChallenged
  | WorkerGatewayAccepted
  | WorkerGatewayListening
  | WorkerGatewayPending
  | WorkerGatewayRefused;

/** One newline-delimited JSON frame. */
export function encodeGatewayFrame(frame: WorkerGatewayServerFrame | WorkerGatewayClientFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function decodeGatewayFrame(line: string): WorkerGatewayClientFrame | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const frame = parsed as Record<string, unknown>;
  if (frame.type === 'worker/hello' && typeof frame.enrollmentId === 'string') {
    return {
      type: 'worker/hello',
      enrollmentId: frame.enrollmentId,
      ...(typeof frame.claimSecret === 'string' ? { claimSecret: frame.claimSecret } : {}),
    };
  }
  if (frame.type === 'worker/claim' && typeof frame.claimSecret === 'string') {
    return { type: 'worker/claim', claimSecret: frame.claimSecret };
  }
  if (frame.type === 'worker/ready') {
    return { type: 'worker/ready' };
  }
  if (frame.type === 'worker/prove' && typeof frame.proof === 'object' && frame.proof !== null) {
    const proof = frame.proof as Record<string, unknown>;
    if (
      typeof proof.challengeId !== 'string' ||
      typeof proof.publicKey !== 'string' ||
      typeof proof.signature !== 'string'
    ) {
      return undefined;
    }
    return {
      type: 'worker/prove',
      proof: {
        challengeId: proof.challengeId,
        publicKey: proof.publicKey,
        signature: proof.signature,
      },
      platform: typeof frame.platform === 'string' ? frame.platform : '',
      // Preserve both presence and JSON type. Dropping a present non-string to
      // `undefined` would make malformed evidence look like an older Worker
      // that simply did not report a version, allowing it through admission.
      ...(Object.prototype.hasOwnProperty.call(frame, 'protocolVersion')
        ? { protocolVersion: frame.protocolVersion }
        : {}),
      ...(Array.isArray(frame.capabilityRequests)
        ? { capabilityRequests: frame.capabilityRequests.filter((value): value is string => typeof value === 'string') }
        : {}),
      ...(Array.isArray(frame.engineFacts) ? { engineFacts: frame.engineFacts as readonly EnrollmentEngineFact[] } : {}),
    };
  }
  return undefined;
}
