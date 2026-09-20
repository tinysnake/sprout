/**
 * Host-side Worker identity fixture for enrollment tests and probes (#87).
 *
 * The enrollment service requires a real private-key possession proof, so a test
 * or an independent probe needs a genuine Worker identity and a way to answer a
 * challenge. This Module keeps that construction in one place instead of
 * repeating key generation and signing in every suite.
 *
 * It is a test/probe double in the same sense as `src/engine/scripted.ts`: it
 * contains no product authority, and the private key never reaches Sprout.
 */

import type { EnvironmentEnrollmentService } from './enrollment-service.ts';
import {
  generateWorkerIdentity,
  signWorkerChallenge,
  type WorkerIdentityProof,
} from './worker-proof.ts';
import { workerIdentityDigest } from './enrollment-identity.ts';

export interface WorkerIdentityFixture {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly digest: string;
  /** Sign an already-issued challenge, producing a proof the service can verify. */
  sign(challenge: { readonly id: string; readonly enrollmentId: string; readonly nonce: string }): WorkerIdentityProof;
  /**
   * Answer a challenge from the given service, producing a proof the service can
   * verify. The caller passes the service it is driving so the fixture owns no
   * hidden global.
   */
  prove(service: EnvironmentEnrollmentService, enrollmentId: string): Promise<WorkerIdentityProof>;
}

export function workerIdentityFixture(): WorkerIdentityFixture {
  const { publicKey, privateKey } = generateWorkerIdentity();
  return {
    publicKey,
    privateKey,
    digest: workerIdentityDigest(publicKey),
    sign(challenge): WorkerIdentityProof {
      return {
        challengeId: challenge.id,
        publicKey,
        signature: signWorkerChallenge(privateKey, challenge),
      };
    },
    async prove(service, enrollmentId): Promise<WorkerIdentityProof> {
      const challenge = await service.issueChallenge(enrollmentId);
      return {
        challengeId: challenge.id,
        publicKey,
        signature: signWorkerChallenge(privateKey, challenge),
      };
    },
  };
}

/**
 * Build a proof for an arbitrary private key against a challenge the caller
 * already holds. Used by probes that deliberately forge a mismatched signature.
 */
export function proveChallenge(
  privateKey: string,
  publicKey: string,
  challenge: { readonly id: string; readonly enrollmentId: string; readonly nonce: string },
): WorkerIdentityProof {
  return {
    challengeId: challenge.id,
    publicKey,
    signature: signWorkerChallenge(privateKey, challenge),
  };
}
