import { createHash, randomUUID } from 'node:crypto';

/**
 * Node-only identity helpers for Environment enrollment (#87).
 *
 * Kept apart from `enrollment.ts` so the pure domain model stays free of
 * `node:crypto` and can be imported by the browser wire contract (`views.ts`)
 * without pulling a Node built-in into the Web build.
 *
 * A Worker's identity digest is a one-way digest of its **public** key, computed
 * on the Environment host. It is not a secret and it cannot authenticate as the
 * Worker; the private key never crosses this boundary.
 */

export function workerIdentityDigest(publicKey: string): string {
  return createHash('sha256').update(publicKey, 'utf8').digest('hex');
}

/** A durable, process-unique enrollment id. */
export function createEnrollmentId(): string {
  return `enroll-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
