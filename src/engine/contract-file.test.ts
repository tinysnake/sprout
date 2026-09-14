import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENTS_FILE_NAME,
  CONTRACT_FILE_MARKER,
  CONTRACT_FILE_NAME,
  deliverContractToWorkingDirectory,
} from './contract-file.ts';

/**
 * Working-directory contract delivery (`agy`, `opencode`).
 *
 * The engines in this channel read a file from the run's working directory. The
 * rule this module exists to guarantee is that Sprout writes its own file and
 * never silently replaces a user's.
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

  assert.equal(delivery?.mechanism, 'sprout-contract-file');
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

test('an unwritable working directory is reported as skipped instead of throwing', () => {
  const delivery = deliverContractToWorkingDirectory({
    workingDirectory: join(tempDir(), 'does-not-exist'),
    instructions: 'contract',
  });
  assert.equal(delivery?.mechanism, 'skipped-user-owned');
});
