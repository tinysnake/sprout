/**
 * One-use host claim secrets for Environment enrollment (#115, ADR-0012).
 *
 * A Human creates a pending enrollment in Web without supplying a Worker public
 * key, host address, or engine credential. The host then claims that pending
 * enrollment with a short-lived, one-use secret read outside the command line,
 * and only *after* proving possession of its generated key is an identity bound.
 *
 * The raw secret is shown to the operator once and is never retained: Sprout
 * stores only a one-way digest and compares timing-safely. This Module owns the
 * secret shape and its digest so the domain model, the service, and the machine
 * routes cannot disagree about what "one-use" means.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A one-use claim secret's default lifetime: short-lived by design. */
export const DEFAULT_CLAIM_TTL_MS = 15 * 60_000;

/** A short, high-entropy, URL-safe claim secret. */
export function createClaimSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The one-way digest of a claim secret.
 *
 * The `claim` record stores this value and never the secret itself, so a leaked
 * durable document cannot be replayed as a claim.
 */
export function claimSecretDigest(secret: string): string {
  return createHash('sha256').update(`sprout-enrollment-claim:v1:${secret}`, 'utf8').digest('hex');
}

/** Timing-safe equality over the digest of a presented secret. */
export function verifyClaimSecret(secret: string, expectedDigest: string): boolean {
  const actual = Buffer.from(claimSecretDigest(secret), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  if (actual.length !== expected.length || actual.length === 0) return false;
  return timingSafeEqual(actual, expected);
}
