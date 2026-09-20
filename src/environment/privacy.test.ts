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
  // A path or token typed into an identifier is reduced to identifier characters.
  assert.equal(sanitizeIdentifier('/Users/example/secret', { fallback: 'unknown-engine' }), 'Usersexamplesecret');
  assert.equal(sanitizeIdentifier('///', { fallback: 'unknown-engine' }), 'unknown-engine');
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
