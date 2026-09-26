import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateWorkerIdentity } from '../environment/worker-proof.ts';
import { loadOrCreateWorkerIdentity } from './enrollment-connector.ts';
import type { PrivateFileSecurityDependencies } from './host-files.ts';
import { WorkerRecoveryJournal } from './recovery-journal.ts';

function windowsSecurity(acl: 'restricted' | 'permissive' | 'unverifiable'): PrivateFileSecurityDependencies {
  return {
    platform: 'win32',
    run: (program, args) => {
      if (program === 'whoami') return 'EXAMPLE\\worker';
      if (acl === 'unverifiable') return '';
      if (acl === 'permissive') return `${args[0]} EXAMPLE\\worker:(F)\nEveryone:(R)`;
      return `${args[0]} EXAMPLE\\worker:(F)\n  BUILTIN\\Administrators:(F)\n  NT AUTHORITY\\SYSTEM:(F)`;
    },
  };
}

test('identity loading accepts restricted Windows ACLs and refuses permissive or unverifiable ACLs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'private-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pem = generateWorkerIdentity().privateKey;
  const path = join(dir, 'identity.pem');
  writeFileSync(path, pem, { mode: 0o600 });
  assert.equal(loadOrCreateWorkerIdentity(path, windowsSecurity('restricted')).privateKey, pem);
  for (const acl of ['permissive', 'unverifiable'] as const) {
    assert.throws(() => loadOrCreateWorkerIdentity(path, windowsSecurity(acl)), /invalid permissions/);
  }
});

test('identity loading requires exact 0600 on POSIX', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'private-identity-posix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'identity.pem');
  writeFileSync(path, generateWorkerIdentity().privateKey, { mode: 0o600 });
  const posix = { platform: 'linux', run: () => '' } as PrivateFileSecurityDependencies;
  assert.equal(loadOrCreateWorkerIdentity(path, posix).generated, false);
  chmodSync(path, 0o666);
  assert.throws(() => loadOrCreateWorkerIdentity(path, posix), /invalid permissions/);
});

test('recovery journal enforces its byte bound with restricted POSIX and Windows security', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'private-journal-size-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, security, mode] of [
    ['posix', { platform: 'linux', run: () => '' } as PrivateFileSecurityDependencies, 0o600],
    ['windows', windowsSecurity('restricted'), 0o666],
  ] as const) {
    const path = join(dir, name);
    writeFileSync(path, 'x'.repeat(4 * 1024 * 1024 + 1), { mode });
    assert.throws(() => new WorkerRecoveryJournal(path, 1, security), /cannot be opened/);
  }
});
