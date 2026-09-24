/**
 * Worker identity proof for Environment enrollment (#87, ADR-0008/0009).
 *
 * A Worker proves possession of its host-generated private key before its
 * connection is reconciled against a durable enrollment. Presenting a public key
 * is not a proof: anyone who read the key (or the digest) could replay it. This
 * Module implements the smallest additive challenge/response that fits the
 * existing Worker carrier:
 *
 * 1. the core issues a short-lived, single-use, enrollment-bound nonce;
 * 2. the Worker signs the nonce with its private key (Ed25519) and returns the
 *    public key plus the signature;
 * 3. the core verifies the signature over the nonce, then reconciles the digest.
 *
 * The private key never crosses this boundary. The challenge is bound to one
 * enrollment id so a signature cannot be replayed against another Environment,
 * and it is consumed on first use so a captured response cannot reconnect twice.
 * An outstanding challenge is intentionally not durable: a restart invalidates
 * it and the Worker requests a new one, which is safer than accepting a proof
 * whose nonce outlived the process that minted it.
 */

import { createPublicKey, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';

/** One short-lived, single-use proof challenge. */
export interface WorkerIdentityChallenge {
  readonly id: string;
  readonly enrollmentId: string;
  /** Unpredictable nonce, signed by the Worker's private key. */
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** What a Worker returns to prove possession of its private key. */
export interface WorkerIdentityProof {
  readonly challengeId: string;
  /** The Worker's public key, PEM-encoded (SPKI). Never retained. */
  readonly publicKey: string;
  /** Base64 signature over the challenge's signed message. */
  readonly signature: string;
}

export type WorkerProofFailureReason =
  | 'unknown-challenge'
  | 'expired-challenge'
  | 'enrollment-mismatch'
  | 'malformed-public-key'
  | 'invalid-signature';

export class WorkerProofError extends Error {
  readonly reason: WorkerProofFailureReason;

  constructor(reason: WorkerProofFailureReason, message: string) {
    super(message);
    this.name = 'WorkerProofError';
    this.reason = reason;
  }
}

/** The exact bytes a Worker signs, so the core and the Worker cannot disagree. */
export function workerChallengeMessage(challenge: { readonly enrollmentId: string; readonly nonce: string }): string {
  return `sprout-enrollment-proof:v1:${challenge.enrollmentId}:${challenge.nonce}`;
}

export interface WorkerProofAuthorityOptions {
  readonly clock?: () => number;
  /** How long an issued challenge stays usable. Defaults to 2 minutes. */
  readonly ttlMs?: number;
  readonly idFactory?: () => string;
  readonly nonceFactory?: () => string;
}

/**
 * Mints and verifies Worker identity challenges for the enrollment service.
 *
 * It is deliberately a small, stateful, in-memory authority: challenges are
 * short-lived and single-use, so a durable store would add a table without
 * adding recovery value. Restart safety comes from refusing an unknown
 * challenge, not from resurrecting one.
 */
export class WorkerProofAuthority {
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #idFactory: () => string;
  readonly #nonceFactory: () => string;
  readonly #challenges = new Map<string, WorkerIdentityChallenge>();

  constructor(options: WorkerProofAuthorityOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 120_000;
    this.#idFactory = options.idFactory ?? (() => `challenge-${randomUUID()}`);
    this.#nonceFactory = options.nonceFactory ?? (() => randomBytes(32).toString('base64url'));
  }

  /** Issue a fresh, enrollment-bound challenge. */
  issue(enrollmentId: string): WorkerIdentityChallenge {
    const at = this.#clock();
    // Drop expired challenges so an outstanding-challenge map cannot grow without
    // bound on a long-lived process; an expired challenge is refused anyway.
    for (const [id, existing] of this.#challenges) {
      if (existing.expiresAt <= at) this.#challenges.delete(id);
    }
    const challenge: WorkerIdentityChallenge = {
      id: this.#idFactory(),
      enrollmentId,
      nonce: this.#nonceFactory(),
      issuedAt: at,
      expiresAt: at + this.#ttlMs,
    };
    this.#challenges.set(challenge.id, challenge);
    return challenge;
  }

  /**
   * Verify a proof, consuming its challenge on success.
   *
   * A challenge is consumed only after the signature verifies, so a failed
   * attempt does not deny a legitimate retry; a successful attempt is single-use.
   *
   * Expiry is refused at the exact boundary: `expiresAt` is the first instant the
   * challenge is no longer live, so a proof presented at `now === expiresAt` is
   * refused rather than accepted for one extra tick.
   */
  verify(input: { readonly enrollmentId: string; readonly proof: WorkerIdentityProof }): {
    readonly publicKey: string;
  } {
    const { enrollmentId, proof } = input;
    const challenge = this.#challenges.get(proof.challengeId);
    if (challenge === undefined) {
      throw new WorkerProofError('unknown-challenge', 'The Worker identity challenge is unknown or already used.');
    }
    if (challenge.enrollmentId !== enrollmentId) {
      throw new WorkerProofError(
        'enrollment-mismatch',
        'The Worker identity challenge was issued for a different enrollment.',
      );
    }
    if (this.#clock() >= challenge.expiresAt) {
      throw new WorkerProofError('expired-challenge', 'The Worker identity challenge has expired; request a new one.');
    }

    const message = workerChallengeMessage(challenge);
    let signature: Buffer;
    try {
      signature = Buffer.from(proof.signature, 'base64');
    } catch {
      throw new WorkerProofError('invalid-signature', 'The Worker identity signature is not valid base64.');
    }
    if (signature.length === 0) {
      throw new WorkerProofError('invalid-signature', 'The Worker identity signature is empty.');
    }

    let publicKeyObject;
    try {
      publicKeyObject = createPublicKey(proof.publicKey);
    } catch {
      throw new WorkerProofError('malformed-public-key', 'The Worker public key is not a valid key.');
    }

    let ok = false;
    try {
      ok = verify(null, Buffer.from(message, 'utf8'), publicKeyObject, signature);
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new WorkerProofError('invalid-signature', 'The Worker identity signature does not match its public key.');
    }

    // Consumption *is* deletion: a verified challenge is removed, so the next
    // attempt on it fails as `unknown-challenge`. Verification is synchronous, so
    // no separate consumed set is needed and nothing grows without bound.
    this.#challenges.delete(proof.challengeId);
    return { publicKey: proof.publicKey };
  }
}

/** Host-side helpers: generate a Worker identity and sign a challenge.
 *
 * ADR-0009 keeps key generation host-local, so these helpers exist for the host
 * bootstrap, the Worker entry point, and the independent probes. The private key
 * is returned only to the host that generated it.
 */
export function generateWorkerIdentity(): { readonly publicKey: string; readonly privateKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Validate the exact host identity key format before it is reused. */
export function validateWorkerIdentityPrivateKey(privateKeyPem: string): void {
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('unsupported key type');
  } catch {
    throw new Error('the host-local Worker identity key is not a valid Ed25519 private key');
  }
}

export function signWorkerChallenge(privateKeyPem: string, challenge: { readonly enrollmentId: string; readonly nonce: string }): string {
  const privateKey = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(workerChallengeMessage(challenge), 'utf8'), privateKey).toString('base64');
}
