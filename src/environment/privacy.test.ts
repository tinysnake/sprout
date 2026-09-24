import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  redactSensitiveText,
  sanitizeIdentifier,
  sanitizeOperatorText,
  sanitizeProtocolVersion,
  DEFAULT_PROBE_SUMMARY,
} from './privacy.ts';

/**
 * The structured privacy boundary (#87 M77-PRIV-001).
 *
 * Each case asserts that a sensitive category is removed from free text while a
 * decisive operator phrase survives, so the boundary is neither leaky nor a
 * blanket deletion.
 */

test('absolute paths are removed across macOS, Linux, Windows, and UNC forms', () => {
  for (const path of [
    '/Users/example/secret/workspace',
    '/home/example/secret',
    '/var/tmp/example',
    'C:\\Users\\Example\\secret',
    '\\\\server\\share\\secret',
  ]) {
    const redacted = redactSensitiveText(`failed at ${path} please retry`);
    assert.equal(redacted.includes(path), false, `${path} leaked`);
    assert.match(redacted, /failed at/);
    assert.match(redacted, /please retry/);
  }
});

test('credentials and tokens are removed', () => {
  for (const secret of [
    'sk-live-abcdefghijklmnopqrst',
    'ghp_abcdefghijklmnopqrstuvwx',
    'glpat-abcdefghijklmnopqrst',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-1234567890-abcdefghij',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  ]) {
    const redacted = redactSensitiveText(`token ${secret} rejected`);
    assert.equal(redacted.includes(secret), false, `${secret} leaked`);
    assert.match(redacted, /rejected/);
  }
});

test('private key material and PEM blocks are removed, not partially exposed', () => {
  const body = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretbodyAAAA\n-----END OPENSSH PRIVATE KEY-----';
  const redacted = redactSensitiveText(`could not read ${body}`);
  assert.equal(redacted.includes('secretbody'), false);
  assert.equal(/BEGIN OPENSSH PRIVATE KEY/.test(redacted), false);
});

test('network identity is removed: addresses, URLs, user@host, and private suffixes', () => {
  const redacted = redactSensitiveText(
    'dial 192.168.1.10 and 10.0.0.5 via https://internal.corp.example as ops@box.local from box.local',
  );
  assert.equal(/192\.168\.1\.10/.test(redacted), false);
  assert.equal(/10\.0\.0\.5/.test(redacted), false);
  assert.equal(/https:\/\/internal/.test(redacted), false);
  assert.equal(/ops@box\.local/.test(redacted), false);
  assert.equal(/box\.local/.test(redacted), false);
});

test('IPv6 addresses are removed while ordinary time-like colons are left alone', () => {
  const redacted = redactSensitiveText('peer fe80::1 and 2001:db8:85a3::8a2e:370:7334 at 12:30:45');
  assert.equal(/fe80::1/.test(redacted), false);
  assert.equal(/2001:db8/.test(redacted), false);
  assert.equal(redacted.includes('12:30:45'), true, 'an ordinary time must not be mistaken for an address');
});

test('raw diagnostics are removed', () => {
  const redacted = redactSensitiveText('boom\n    at Object.<anonymous> (/tmp/x.ts:1:2)\nnode:internal/fs/y raw stderr');
  assert.equal(/node:internal/.test(redacted), false);
  assert.equal(/raw stderr/i.test(redacted), false);
});

test('the boundary is general for paths, not a list of known host roots', () => {
  // Regression for M77-PRIV-001 rework 2: `/srv/...` and `/data/...` are not
  // system roots, but they are still absolute host paths.
  for (const path of ['/srv/sprout/worker', '/data/volumes/secret', '/opt/app/conf', '/secret']) {
    const redacted = redactSensitiveText(`failed at ${path} please retry`);
    assert.equal(redacted.includes(path), false, `${path} leaked`);
    assert.match(redacted, /failed at/);
    assert.match(redacted, /please retry/);
  }
});

test('ordinary and machine hostnames are removed, without eating a decisive reason', () => {
  for (const host of ['buildbox-07', 'worker.node1.tailnet.example', 'app.internal', 'somehost.local']) {
    const redacted = redactSensitiveText(`connect to ${host} refused`);
    assert.equal(redacted.includes(host), false, `${host} leaked`);
    assert.match(redacted, /refused/);
  }
  // A decisive reason that merely mentions a host is still decisive afterwards.
  const retired = sanitizeOperatorText('host retired after water damage', { fallback: 'fallback' });
  assert.equal(retired, 'host retired after water damage');
});

test('named credential assignments are removed whatever the secret characters are', () => {
  for (const secret of [
    'password=hunter2correcthorse',
    'password is hunter2correcthorse',
    'password: hunter2correcthorse',
    'passwd=hunter2',
    'pwd=hunter2',
    'token=abc123def456ghi789',
    'api_key=ABCDEF0123456789',
    'api key = ABCDEF0123456789',
    'secret: supersecretvalue123',
    'client_secret=0123456789abcdef',
    'client secret is abcdefghijkl',
    'auth token: abcdefghijklmnop',
    'private_key=AAAAbbbbccccdddd',
    'passphrase=correct horse',
    'credentials=abcdefghijklmnop',
  ]) {
    const redacted = redactSensitiveText(`auth failed ${secret}`);
    assert.match(redacted, /auth failed/);
    assert.equal(redacted.includes(secret), false, `${secret} leaked`);
    assert.equal(
      /hunter2|abc123def456|ABCDEF0123456789|supersecretvalue123|0123456789abcdef|AAAAbbbb|correct horse|abcdefghijklmnop/.test(redacted),
      false,
      `${secret} value leaked`,
    );
  }
});

test('an ordinary decisive sentence is not eaten by the credential rules', () => {
  for (const reason of [
    'host retired after water damage',
    'the worker is offline',
    'token bucket exhausted',
    'password rotation required',
    'the api key file was missing',
    'kept secret from the operator',
  ]) {
    assert.equal(sanitizeOperatorText(reason, { fallback: 'fallback' }), reason);
  }
});

test('a model identifier is not mistaken for a hostname', () => {
  // Regression for M77-PRIV-001 rework 3: the earlier dotted-host rule ate the
  // vendor/version part of a model id. A model id must survive free text and the
  // structured model field while a real hostname still does not.
  for (const model of ['gpt-5-codex', 'gpt-5.1-codex', 'claude-3-5-sonnet', 'gemini-1.5-flash', 'gpt-5.6-terra']) {
    assert.equal(redactSensitiveText(`engine ${model} ready`), `engine ${model} ready`);
  }
  assert.equal(redactSensitiveText('connect to app.internal refused').includes('app.internal'), false);
});

test('a named host assignment is removed as a topology fact', () => {
  const redacted = redactSensitiveText('target host=worker-01 port=5174');
  assert.equal(/worker-01/.test(redacted), false);
  assert.equal(/5174/.test(redacted), false);
});

test('a decisive operator reason is preserved while sensitive parts are removed', () => {
  const sanitized = sanitizeOperatorText(
    'host retired after water damage; log at /Users/example/secret and token sk-live-abcdefghijklmnopqrst',
    { fallback: 'Human revoked the Worker identity.' },
  );
  assert.match(sanitized, /host retired after water damage/);
  assert.equal(/\/Users\//.test(sanitized), false);
  assert.equal(/sk-live-/.test(sanitized), false);
});

test('an empty or all-sensitive value falls back to the product-owned reason', () => {
  assert.equal(sanitizeOperatorText('', { fallback: 'fallback' }), 'fallback');
  assert.equal(sanitizeOperatorText('   ', { fallback: 'fallback' }), 'fallback');
  assert.equal(
    sanitizeOperatorText('/Users/example/secret', { fallback: 'fallback' }),
    'fallback',
  );
  assert.equal(
    sanitizeOperatorText('192.168.1.10:5174', { fallback: 'fallback' }),
    'fallback',
  );
});

test('a probe summary keeps its decisive text and drops the sensitive remainder', () => {
  const sanitized = sanitizeOperatorText('codex login required on 10.1.2.3', {
    fallback: DEFAULT_PROBE_SUMMARY,
  });
  assert.match(sanitized, /codex login required/);
  assert.equal(/10\.1\.2\.3/.test(sanitized), false);
});

test('long text is bounded rather than persisted unbounded', () => {
  const sanitized = sanitizeOperatorText('x'.repeat(2_000), { fallback: 'fallback', maxLength: 64 });
  assert.ok(sanitized.length <= 64);
});

test('an identifier keeps only the characters an identifier may contain', () => {
  assert.equal(sanitizeIdentifier('codex', { fallback: 'unknown-engine' }), 'codex');
  assert.equal(sanitizeIdentifier('gpt-5.1-codex', { fallback: 'unknown-model' }), 'gpt-5.1-codex');
  // A path or token typed into an identifier is refused outright, never reduced
  // to its punctuation-stripped characters.
  assert.equal(sanitizeIdentifier('/Users/example/secret', { fallback: 'unknown-engine' }), 'unknown-engine');
  assert.equal(sanitizeIdentifier('///', { fallback: 'unknown-engine' }), 'unknown-engine');
});

test('a structured identifier is category-aware, so a bypass by punctuation stripping is impossible', () => {
  // M77-PRIV-001 rework 3: removing punctuation alone left the credential value
  // intact (`password=hunter2correcthorse` -> `passwordhunter2correcthorse`) and
  // a machine hostname in the structured fields. Each category now has a
  // positive safe shape, and the structural boundary rejects the rest.
  assert.equal(
    sanitizeIdentifier('password=hunter2correcthorse', { fallback: 'unknown-model' }),
    'unknown-model',
    'a credential assignment never survives as an identifier',
  );
  assert.equal(
    sanitizeIdentifier('token:abc123def456', { fallback: 'unknown-model' }),
    'unknown-model',
    'a credential assignment never survives as an identifier',
  );
  for (const host of ['buildbox-07', 'somehost.local', 'worker.node1.tailnet.example']) {
    assert.equal(sanitizeIdentifier(host, { fallback: 'unknown-engine' }), 'unknown-engine', `${host} must not be an engine`);
    assert.equal(sanitizeIdentifier(host, { fallback: 'unknown-capability' }), 'unknown-capability', `${host} must not be a capability`);
  }
  // An engine and a capability are lowercase word enums; a hostname-shaped token
  // (`buildbox-07`) is not, but a real one is.
  assert.equal(sanitizeIdentifier('codex', { fallback: 'unknown-engine', kind: 'engine' }), 'codex');
  assert.equal(sanitizeIdentifier('agent-run', { fallback: 'unknown-capability', kind: 'capability' }), 'agent-run');
  assert.equal(sanitizeIdentifier('buildbox-07', { fallback: 'unknown-engine', kind: 'engine' }), 'unknown-engine');
  // A model id keeps its vendor/version characters; a hostname or credential does not.
  assert.equal(sanitizeIdentifier('gpt-5.1-codex', { fallback: 'unknown-model', kind: 'model' }), 'gpt-5.1-codex');
  assert.equal(sanitizeIdentifier('somehost.local', { fallback: 'unknown-model', kind: 'model' }), 'unknown-model');
  assert.equal(sanitizeIdentifier('sk-live-abcdefghijklmnopqrst', { fallback: 'unknown-model', kind: 'model' }), 'unknown-model');
  // A digest is opaque hex only, so legacy PEM/key material cannot pass.
  assert.equal(sanitizeIdentifier('a'.repeat(64), { fallback: '', kind: 'digest' }), 'a'.repeat(64));
  assert.equal(
    sanitizeIdentifier('-----BEGIN OPENSSH PRIVATE KEY-----AAAAsecretbodyAAAA-----END OPENSSH PRIVATE KEY-----', {
      fallback: '',
      kind: 'digest',
    }),
    '',
    'a legacy PEM body must not survive as an identity digest',
  );
  assert.equal(sanitizeIdentifier('legacy-digest', { fallback: '', kind: 'digest' }), '', 'a non-hex digest is refused');
});

test('a short bare-space or copula credential still loses its value', () => {
  // M77-PRIV-001 rework 4: the bare-space and copula rules previously required a
  // quoted value or one at least twelve characters long, so `password was abc`
  // and `private key AAAA` left the secret in place. A separator (`=`, `:`, a
  // copula) is an assignment whatever follows, and a bare space is an assignment
  // unless the next word is ordinary decisive prose.
  for (const [text, value] of [
    ['password hunter2', 'hunter2'],
    ['password was abc', 'abc'],
    ['token is xyz', 'xyz'],
    ['secret was qrs', 'qrs'],
    ['api_key is abcdef', 'abcdef'],
    ['api key was abcdef', 'abcdef'],
    ['private key AAAA', 'AAAA'],
    ['private key was AAAA', 'AAAA'],
    ['private_key=A1B2', 'A1B2'],
    ['client_secret abcdef', 'abcdef'],
    ['client secret was abcdef', 'abcdef'],
    ['passphrase abcdef', 'abcdef'],
    ['pwd was abc', 'abc'],
    ['auth_token was abc', 'abc'],
    ['credentials is abc', 'abc'],
    ['signing_key was abc', 'abc'],
    ['encryption_key is abc', 'abc'],
    ['access_key was abc', 'abc'],
    ['secret_key is abc', 'abc'],
  ] as const) {
    const redacted = redactSensitiveText(text);
    assert.equal(redacted.includes(value), false, `${text} leaked its value`);
  }
  // The decisive sentences the review named must survive intact.
  for (const reason of ['token bucket exhausted', 'password rotation required']) {
    assert.equal(redactSensitiveText(reason), reason);
  }
});

test('a one-digit machine host is removed while a versioned model id survives', () => {
  // M77-PRIV-001 rework 4: a one-digit-suffix host (`buildbox-7`, `host9`) passed
  // the model/generic shape, while the `gpt-4` positive control forbids simply
  // rejecting every version-shaped token. The host rules now use one model-family
  // allowlist, so the real ids stay and the hosts do not.
  for (const host of ['buildbox-7', 'node-1', 'host9', 'worker-7', 'mac-mini-1']) {
    for (const kind of ['engine', 'model', 'capability', 'digest', 'generic'] as const) {
      assert.equal(
        sanitizeIdentifier(host, { fallback: 'safe-placeholder', kind }).includes(host),
        false,
        `${host} must not survive as a ${kind} identifier`,
      );
    }
  }
  for (const model of ['gpt-4', 'gpt-5.1-codex', 'claude-3-5-sonnet', 'gemini-1.5-flash', 'o3-mini']) {
    assert.equal(sanitizeIdentifier(model, { fallback: 'unknown-model', kind: 'model' }), model);
    assert.equal(redactSensitiveText(`engine ${model} ready`), `engine ${model} ready`);
  }
  assert.equal(sanitizeIdentifier('codex', { fallback: 'x', kind: 'engine' }), 'codex');
  assert.equal(sanitizeIdentifier('pi', { fallback: 'x', kind: 'engine' }), 'pi');
  assert.equal(sanitizeIdentifier('agent-run', { fallback: 'x', kind: 'capability' }), 'agent-run');
  assert.equal(redactSensitiveText('connect to buildbox-7 refused'), 'connect to <redacted-host> refused');
});

test('a protocol version is a bounded token or nothing', () => {
  assert.equal(sanitizeProtocolVersion('2'), '2');
  assert.equal(sanitizeProtocolVersion('v2.1'), 'v2.1');
  assert.equal(sanitizeProtocolVersion('2.1.0-rc1'), '2.1.0-rc1');
  assert.equal(sanitizeProtocolVersion(undefined), undefined);
  // Arbitrary text is refused rather than echoed into an operator reason.
  assert.equal(sanitizeProtocolVersion('2.1 /Users/example/secret'), undefined);
  assert.equal(sanitizeProtocolVersion('sk-live-abcdefghijklmnop'), undefined);
});

/**
 * The one-use enrollment claim's durable shape is privacy-safe (#115).
 *
 * The raw secret must never survive into a durable document, its digest must not
 * be a reversible encoding of the secret, and a legacy/bypassing writer that
 * stored key material in the digest field must not have it echoed on read.
 */
test('a claim document stores only a one-way digest, never the raw secret', async () => {
  const { EnvironmentEnrollmentService } = await import('./enrollment-service.ts');
  const { InMemoryEnrollmentStore } = await import('./enrollment-store.ts');
  const { InMemoryEnvironmentReadinessStore } = await import('./readiness-store.ts');
  const { normalizeEnrollment } = await import('./enrollment.ts');

  const store = new InMemoryEnrollmentStore();
  const service = new EnvironmentEnrollmentService({
    enrollments: store,
    readiness: new InMemoryEnvironmentReadinessStore(),
    currentConnectionEpoch: () => undefined,
    idFactory: () => 'enroll-1',
    claimSecretFactory: () => 'super-secret-claim-value',
  });
  const result = await service.requestEnrollment({
    environmentInstanceId: 'local-macos',
    displayName: 'Local Mac',
    platform: 'macos',
    capabilityRequests: [],
    engineFacts: [],
  });
  const serialized = JSON.stringify(result.enrollment);
  assert.equal(serialized.includes('super-secret-claim-value'), false);
  assert.match(result.enrollment.claim?.secretDigest ?? '', /^[a-f0-9]{64}$/);

  // A legacy row that stored a private key body in the digest field is reduced
  // to no claim at all rather than echoing the material.
  const poisoned = normalizeEnrollment({
    ...result.enrollment,
    claim: {
      secretDigest: '-----BEGIN PRIVATE KEY-----AAAA-----END PRIVATE KEY-----',
      issuedAt: 0,
      expiresAt: 1,
    },
  });
  assert.equal(poisoned.claim, undefined);
});
