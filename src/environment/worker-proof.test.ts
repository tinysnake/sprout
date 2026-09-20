import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkerProofAuthority,
  WorkerProofError,
  generateWorkerIdentity,
  signWorkerChallenge,
  workerChallengeMessage,
  type WorkerIdentityProof,
} from './worker-proof.ts';

/**
 * Worker identity proof (#87 M77-AUTH-003).
 *
 * These are the adversarial cases: a bare key, a wrong nonce, a mismatched key
 * pair, an expired challenge, a cross-enrollment challenge, and a replay. A
 * correct proof is the positive control, so over-blocking is visible too.
 */

function sign(privateKey: string, publicKey: string, challenge: { readonly id: string; readonly enrollmentId: string; readonly nonce: string }): WorkerIdentityProof {
  return { challengeId: challenge.id, publicKey, signature: signWorkerChallenge(privateKey, challenge) };
}

test('a valid, live challenge response verifies and consumes the challenge', () => {
  const authority = new WorkerProofAuthority({ clock: () => 1_000, idFactory: () => 'c1', nonceFactory: () => 'n1' });
  const identity = generateWorkerIdentity();
  const challenge = authority.issue('enroll-1');
  assert.equal(challenge.id, 'c1');
  assert.equal(challenge.nonce, 'n1');

  const verified = authority.verify({ enrollmentId: 'enroll-1', proof: sign(identity.privateKey, identity.publicKey, challenge) });
  assert.equal(verified.publicKey, identity.publicKey);

  // The same challenge cannot be used twice.
  assert.throws(
    () => authority.verify({ enrollmentId: 'enroll-1', proof: sign(identity.privateKey, identity.publicKey, challenge) }),
    (error: unknown) => error instanceof WorkerProofError && error.reason === 'unknown-challenge',
  );
});

test('a signature over the wrong message is refused', () => {
  const authority = new WorkerProofAuthority({ clock: () => 1_000, idFactory: () => 'c1', nonceFactory: () => 'n1' });
  const identity = generateWorkerIdentity();
  const challenge = authority.issue('enroll-1');
  const forged = sign(identity.privateKey, identity.publicKey, { ...challenge, nonce: 'tampered' });
  assert.throws(
    () => authority.verify({ enrollmentId: 'enroll-1', proof: forged }),
    (error: unknown) => error instanceof WorkerProofError && error.reason === 'invalid-signature',
  );
});

test('a key pair mismatch is refused', () => {
  const authority = new WorkerProofAuthority({ clock: () => 1_000, idFactory: () => 'c1', nonceFactory: () => 'n1' });
  const signer = generateWorkerIdentity();
  const claimed = generateWorkerIdentity();
  const challenge = authority.issue('enroll-1');
  const forged = sign(signer.privateKey, claimed.publicKey, challenge);
  assert.throws(
    () => authority.verify({ enrollmentId: 'enroll-1', proof: forged }),
    (error: unknown) => error instanceof WorkerProofError && error.reason === 'invalid-signature',
  );
});

test('a challenge bound to another enrollment is refused', () => {
  const authority = new WorkerProofAuthority({ clock: () => 1_000, idFactory: () => 'c1', nonceFactory: () => 'n1' });
  const identity = generateWorkerIdentity();
  const challenge = authority.issue('enroll-1');
  const proof = sign(identity.privateKey, identity.publicKey, challenge);
  assert.throws(
    () => authority.verify({ enrollmentId: 'enroll-2', proof }),
    (error: unknown) => error instanceof WorkerProofError && error.reason === 'enrollment-mismatch',
  );
});

test('an expired challenge is refused', () => {
  let now = 1_000;
  const authority = new WorkerProofAuthority({ clock: () => now, ttlMs: 100, idFactory: () => 'c1', nonceFactory: () => 'n1' });
  const identity = generateWorkerIdentity();
  const challenge = authority.issue('enroll-1');
  now = 1_200;
  assert.throws(
    () => authority.verify({ enrollmentId: 'enroll-1', proof: sign(identity.privateKey, identity.publicKey, challenge) }),
    (error: unknown) => error instanceof WorkerProofError && error.reason === 'expired-challenge',
  );
});

test('the exact expiry instant is refused, one tick before it is accepted', () => {
  // M77-AUTH-003 rework 2: `now === expiresAt` is the first non-live instant, so
  // it must be refused rather than accepted for one extra tick.
  let now = 1_000;
  const authority = new WorkerProofAuthority({ clock: () => now, ttlMs: 100, idFactory: () => 'c1', nonceFactory: () => 'n1' });
  const identity = generateWorkerIdentity();
  const challenge = authority.issue('enroll-1');

  // One millisecond before expiry the challenge is still live, so this must not
  // over-block: it is the positive control for the boundary change.
  now = challenge.expiresAt - 1;
  const accepted = authority.verify({
    enrollmentId: 'enroll-1',
    proof: sign(identity.privateKey, identity.publicKey, challenge),
  });
  assert.equal(accepted.publicKey, identity.publicKey);

  // At exactly `expiresAt` a fresh challenge of the same shape is refused.
  const boundaryAuthority = new WorkerProofAuthority({ clock: () => now, ttlMs: 100, idFactory: () => 'c2', nonceFactory: () => 'n2' });
  const boundary = boundaryAuthority.issue('enroll-1');
  now = boundary.expiresAt;
  assert.throws(
    () => boundaryAuthority.verify({
      enrollmentId: 'enroll-1',
      proof: sign(identity.privateKey, identity.publicKey, boundary),
    }),
    (error: unknown) => error instanceof WorkerProofError && error.reason === 'expired-challenge',
  );
});

test('an unknown challenge and a malformed key are refused', () => {
  const authority = new WorkerProofAuthority({ clock: () => 1_000 });
  const identity = generateWorkerIdentity();
  assert.throws(
    () => authority.verify({ enrollmentId: 'enroll-1', proof: { challengeId: 'nope', publicKey: identity.publicKey, signature: 'AAAA' } }),
    (error: unknown) => error instanceof WorkerProofError && error.reason === 'unknown-challenge',
  );

  const authority2 = new WorkerProofAuthority({ clock: () => 1_000, idFactory: () => 'c1', nonceFactory: () => 'n1' });
  const challenge = authority2.issue('enroll-1');
  assert.throws(
    () => authority2.verify({ enrollmentId: 'enroll-1', proof: { challengeId: challenge.id, publicKey: 'not-a-key', signature: 'AAAA' } }),
    (error: unknown) => error instanceof WorkerProofError && error.reason === 'malformed-public-key',
  );
  assert.throws(
    () => authority2.verify({ enrollmentId: 'enroll-1', proof: { challengeId: challenge.id, publicKey: identity.publicKey, signature: '' } }),
    (error: unknown) => error instanceof WorkerProofError && error.reason === 'invalid-signature',
  );
});

test('the signed message binds the enrollment id and the nonce', () => {
  assert.notEqual(
    workerChallengeMessage({ enrollmentId: 'a', nonce: 'n' }),
    workerChallengeMessage({ enrollmentId: 'b', nonce: 'n' }),
  );
  assert.notEqual(
    workerChallengeMessage({ enrollmentId: 'a', nonce: 'n1' }),
    workerChallengeMessage({ enrollmentId: 'a', nonce: 'n2' }),
  );
  // A tampered nonce changes the signed message, which is why the signature over
  // the wrong nonce cannot verify.
  assert.notEqual(
    workerChallengeMessage({ enrollmentId: 'a', nonce: 'n' }),
    workerChallengeMessage({ enrollmentId: 'a', nonce: 'm' }),
  );
});
