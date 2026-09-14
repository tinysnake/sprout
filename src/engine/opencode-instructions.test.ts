import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENCODE_CONFIG_CONTENT_ENV,
  registerOpenCodeInstructionPath,
} from './opencode-instructions.ts';

/**
 * Making Sprout's fallback contract file readable by `opencode`.
 *
 * `opencode run` discovers only `AGENTS.md`, `CLAUDE.md`, and `CONTEXT.md`, so a
 * bare `SPROUT-PROJECT-CONTRACT.md` is not a channel. The config `instructions`
 * list is, and `OPENCODE_CONFIG_CONTENT` is a merge-over overlay rather than a
 * replacement. These tests pin the overlay's rules — in particular that an
 * operator's own config is preserved and never rewritten if Sprout cannot
 * understand it.
 */

test('with no operator config, a fresh overlay registers the path', () => {
  const registration = registerOpenCodeInstructionPath({
    env: undefined,
    path: '/tmp/work/SPROUT-PROJECT-CONTRACT.md',
  });

  assert.ok(registration.env);
  const document = JSON.parse(registration.env[OPENCODE_CONFIG_CONTENT_ENV] ?? '') as {
    instructions: string[];
  };
  assert.deepEqual(document.instructions, ['/tmp/work/SPROUT-PROJECT-CONTRACT.md']);
});

test('an operator config is preserved and Sprout\'s path is appended', () => {
  const existing = JSON.stringify({ instructions: ['/home/user/rules.md'], model: 'x/y' });
  const registration = registerOpenCodeInstructionPath({
    env: { [OPENCODE_CONFIG_CONTENT_ENV]: existing },
    path: '/tmp/work/SPROUT-PROJECT-CONTRACT.md',
  });

  assert.ok(registration.env);
  const document = JSON.parse(registration.env[OPENCODE_CONFIG_CONTENT_ENV] ?? '') as {
    instructions: string[];
    model: string;
  };
  assert.deepEqual(document.instructions, [
    '/home/user/rules.md',
    '/tmp/work/SPROUT-PROJECT-CONTRACT.md',
  ]);
  assert.equal(document.model, 'x/y', 'an unrelated key survives the merge');
});

test('an already-registered path is not duplicated', () => {
  const path = '/tmp/work/SPROUT-PROJECT-CONTRACT.md';
  const registration = registerOpenCodeInstructionPath({
    env: { [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify({ instructions: [path] }) },
    path,
  });

  assert.ok(registration.env);
  const document = JSON.parse(registration.env[OPENCODE_CONFIG_CONTENT_ENV] ?? '') as {
    instructions: string[];
  };
  assert.deepEqual(document.instructions, [path]);
});

test('a relative path is registered as an absolute one', () => {
  const registration = registerOpenCodeInstructionPath({
    env: undefined,
    path: 'work/SPROUT-PROJECT-CONTRACT.md',
  });

  assert.ok(registration.env);
  const document = JSON.parse(registration.env[OPENCODE_CONFIG_CONTENT_ENV] ?? '') as {
    instructions: string[];
  };
  assert.ok(document.instructions[0]?.startsWith('/'), 'the entry is absolute');
});

test('an operator config that is not an object is never rewritten', () => {
  const original = '{ not json';
  const registration = registerOpenCodeInstructionPath({
    env: { [OPENCODE_CONFIG_CONTENT_ENV]: original },
    path: '/tmp/work/SPROUT-PROJECT-CONTRACT.md',
  });

  assert.equal(registration.env, undefined, 'Sprout declines rather than replacing it');
  assert.match(registration.reason ?? '', /OPENCODE_CONFIG_CONTENT/);
});

test('a non-array instructions key is never rewritten', () => {
  const registration = registerOpenCodeInstructionPath({
    env: { [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify({ instructions: 'one.md' }) },
    path: '/tmp/work/SPROUT-PROJECT-CONTRACT.md',
  });

  assert.equal(registration.env, undefined);
  assert.match(registration.reason ?? '', /non-array/);
});

test('an instruction entry Sprout does not understand is carried through unchanged', () => {
  const registration = registerOpenCodeInstructionPath({
    env: {
      [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify({ instructions: [{ url: 'x' }, 'one.md'] }),
    },
    path: '/tmp/work/SPROUT-PROJECT-CONTRACT.md',
  });

  assert.ok(registration.env);
  const document = JSON.parse(registration.env[OPENCODE_CONFIG_CONTENT_ENV] ?? '') as {
    instructions: unknown[];
  };
  assert.deepEqual(document.instructions, [
    { url: 'x' },
    'one.md',
    '/tmp/work/SPROUT-PROJECT-CONTRACT.md',
  ]);
});

test('an empty operator config is treated as absent', () => {
  const registration = registerOpenCodeInstructionPath({
    env: { [OPENCODE_CONFIG_CONTENT_ENV]: '   ' },
    path: '/tmp/work/SPROUT-PROJECT-CONTRACT.md',
  });

  assert.ok(registration.env);
  const document = JSON.parse(registration.env[OPENCODE_CONFIG_CONTENT_ENV] ?? '') as {
    instructions: string[];
  };
  assert.deepEqual(document.instructions, ['/tmp/work/SPROUT-PROJECT-CONTRACT.md']);
});
