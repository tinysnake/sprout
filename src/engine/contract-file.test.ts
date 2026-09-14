import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENTS_FILE_NAME,
  CONTRACT_FILE_MARKER,
  CONTRACT_FILE_NAME,
  deliverContractToWorkingDirectory,
} from './contract-file.ts';

/**
 * Working-directory contract delivery (`opencode`).
 *
 * The engine in this channel reads a file from the run's working directory. The
 * rules this module exists to guarantee are that Sprout writes its own file,
 * never silently replaces a user's, and reports where the contract actually
 * went — including a successful fallback, which is not a silent outcome.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sprout-contract-'));
}

test('with no AGENTS.md, the contract is written there and marked Sprout-owned', () => {
  const dir = tempDir();
  const delivery = deliverContractToWorkingDirectory({
    workingDirectory: dir,
    instructions: '# Project contract\nGoal: ship it',
  });

  assert.equal(delivery?.mechanism, 'agents.md');
  const written = readFileSync(join(dir, AGENTS_FILE_NAME), 'utf8');
  assert.ok(written.startsWith(CONTRACT_FILE_MARKER));
  assert.match(written, /Goal: ship it/);
});

test('a user-owned AGENTS.md is never clobbered; the contract goes to Sprout\'s own file', () => {
  const dir = tempDir();
  const userContent = '# Repo instructions\nDo not touch this.\n';
  writeFileSync(join(dir, AGENTS_FILE_NAME), userContent);

  const delivery = deliverContractToWorkingDirectory({
    workingDirectory: dir,
    instructions: '# Project contract\nGoal: ship it',
  });

  // A fallback is a *successful* delivery, reported distinctly: the contract was
  // written, just not to the engine's primary file.
  assert.equal(delivery?.mechanism, 'sprout-contract-file');
  assert.equal(delivery.path, join(dir, CONTRACT_FILE_NAME));
  assert.equal(delivery.agentsMdSkipped, 'user-owned', 'the skip is reported, not silent');
  assert.equal(
    readFileSync(join(dir, AGENTS_FILE_NAME), 'utf8'),
    userContent,
    'the user file is byte-identical after delivery',
  );
  assert.match(readFileSync(join(dir, CONTRACT_FILE_NAME), 'utf8'), /Goal: ship it/);
});

test('a file Sprout previously wrote is replaced rather than treated as a user file', () => {
  const dir = tempDir();
  const first = deliverContractToWorkingDirectory({
    workingDirectory: dir,
    instructions: 'first contract',
  });
  const second = deliverContractToWorkingDirectory({
    workingDirectory: dir,
    instructions: 'second contract',
  });

  assert.equal(first?.mechanism, 'agents.md');
  assert.equal(second?.mechanism, 'agents.md');
  const written = readFileSync(join(dir, AGENTS_FILE_NAME), 'utf8');
  assert.match(written, /second contract/);
  assert.doesNotMatch(written, /first contract/);
});

test('no instructions means no file is created', () => {
  const dir = tempDir();
  assert.equal(deliverContractToWorkingDirectory({ workingDirectory: dir }), undefined);
  assert.equal(
    deliverContractToWorkingDirectory({ workingDirectory: dir, instructions: '' }),
    undefined,
  );
  assert.equal(existsSync(join(dir, AGENTS_FILE_NAME)), false);
});

test('an unwritable working directory is reported unavailable instead of throwing', () => {
  const delivery = deliverContractToWorkingDirectory({
    workingDirectory: join(tempDir(), 'does-not-exist'),
    instructions: 'contract',
  });
  assert.equal(delivery?.mechanism, 'unavailable');
  assert.match(delivery.reason ?? '', /could not write/);
});

test('an existing AGENTS.md that cannot be read falls back instead of being overwritten', () => {
  // The important case: a file that *exists* but cannot be read. Treating the
  // read error as absence and then writing would destroy content Sprout never
  // saw. The file must be left alone and the fallback used.
  const dir = tempDir();
  const unreadable = join(dir, AGENTS_FILE_NAME);
  writeFileSync(unreadable, '# private user file\n');
  chmodSync(unreadable, 0o000);

  // Root can read anything, so this test is only meaningful where the mode is
  // enforced. Skip cleanly rather than asserting a false negative.
  let readable = true;
  try {
    readFileSync(unreadable, 'utf8');
  } catch {
    readable = false;
  }
  if (readable) {
    chmodSync(unreadable, 0o644);
    return;
  }

  const delivery = deliverContractToWorkingDirectory({
    workingDirectory: dir,
    instructions: '# Project contract\nGoal: ship it',
  });

  chmodSync(unreadable, 0o644);
  assert.equal(delivery?.mechanism, 'sprout-contract-file', 'the contract went elsewhere');
  assert.equal(delivery.agentsMdSkipped, 'unreadable', 'why the primary file was passed over');
  assert.equal(
    readFileSync(unreadable, 'utf8'),
    '# private user file\n',
    'the unreadable file was not overwritten',
  );
  assert.match(readFileSync(join(dir, CONTRACT_FILE_NAME), 'utf8'), /Goal: ship it/);
});

test('an unreadable Sprout fallback file is reported, not overwritten', () => {
  const dir = tempDir();
  writeFileSync(join(dir, AGENTS_FILE_NAME), '# user file\n');
  const sproutFile = join(dir, CONTRACT_FILE_NAME);
  writeFileSync(sproutFile, 'preexisting sprout-named content\n');
  chmodSync(sproutFile, 0o000);

  let readable = true;
  try {
    readFileSync(sproutFile, 'utf8');
  } catch {
    readable = false;
  }
  if (readable) {
    chmodSync(sproutFile, 0o644);
    return;
  }

  const delivery = deliverContractToWorkingDirectory({
    workingDirectory: dir,
    instructions: 'contract',
  });

  chmodSync(sproutFile, 0o644);
  assert.equal(delivery?.mechanism, 'skipped-unreadable');
  assert.equal(
    readFileSync(sproutFile, 'utf8'),
    'preexisting sprout-named content\n',
    'the unreadable file was not overwritten',
  );
});
