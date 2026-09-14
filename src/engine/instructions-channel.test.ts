import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { PiEngineAdapter } from './pi.ts';
import { OpenCodeEngineAdapter } from './opencode.ts';
import { CONTRACT_FILE_MARKER, CONTRACT_FILE_NAME } from './contract-file.ts';

/**
 * Contract delivery through the engine fakes, for two engines with **different**
 * instruction channels (#21 acceptance).
 *
 * Pi takes standing instructions out-of-band (`--append-system-prompt`); opencode
 * has no system-prompt flag and reads `AGENTS.md` from the working directory.
 * Both must receive the *same* assembled contract, each through its own channel,
 * which is what proves the seam delivers per-engine rather than assuming one
 * uniform surface (the fog #17 exists to resolve).
 */

const PROJECT_CONTRACT = [
  '# Project contract: project-sprout',
  '',
  'Goal: Ship a portable project context',
  '',
  'Rules:',
  '- Report what you observed',
].join('\n');

/** Pi streams a terminal `agent_settled`; the fake only needs to settle the turn. */
function fakePiProcess(onRun: (line: (value: unknown) => void) => void) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdout,
    stderr,
    kill: () => undefined,
    onExit: () => undefined,
    onSpawnError: () => undefined,
    emit: () => {
      onRun((value) => stdout.write(`${JSON.stringify(value)}\n`));
      stdout.write(
        `${JSON.stringify({ type: 'agent_settled' })}\n`,
      );
    },
  };
}

test('Pi receives the assembled contract out-of-band, never in the prompt', async () => {
  const argv: string[][] = [];
  const adapter = new PiEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: (_binary, args) => {
      argv.push([...args]);
      const process = fakePiProcess(() => undefined);
      queueMicrotask(() => process.emit());
      return process;
    },
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    instructions: PROJECT_CONTRACT,
  });
  session.run('do the task');
  await session.close();

  const args = argv[0] ?? [];
  assert.ok(args.includes('--append-system-prompt'), 'Pi delivers out-of-band');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], PROJECT_CONTRACT);
  assert.equal(
    args.at(-1),
    'do the task',
    'the contract is not duplicated into the prompt it is delivered out-of-band from',
  );
  assert.ok(!args.includes(PROJECT_CONTRACT) || args.indexOf(PROJECT_CONTRACT) !== args.length - 1);
});

test('opencode receives the assembled contract through the working directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-oc-contract-'));
  const argv: string[][] = [];
  const adapter = new OpenCodeEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: (_binary, args) => {
      argv.push([...args]);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      queueMicrotask(() => {
        stdout.write(
          `${JSON.stringify({ type: 'step_finish', part: { reason: 'stop' }, sessionID: 'ses_x' })}\n`,
        );
        stdout.end();
      });
      return {
        stdout,
        stderr,
        writeStdin: () => undefined,
        endStdin: () => undefined,
        kill: () => undefined,
        onExit: (handler: (code: number | null) => void) => queueMicrotask(() => handler(0)),
        onSpawnError: () => undefined,
      };
    },
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: dir,
    instructions: PROJECT_CONTRACT,
  });
  session.run('do the task');
  await session.close();

  // opencode has no system-prompt flag, so nothing contract-shaped is in argv.
  const args = argv[0] ?? [];
  assert.ok(!args.includes('--append-system-prompt'), 'opencode has no such flag');
  assert.ok(!args.includes(PROJECT_CONTRACT), 'the contract is not passed on argv');

  // The contract reached the engine's actual channel: the working directory.
  const contractPath = join(dir, 'AGENTS.md');
  assert.ok(existsSync(contractPath), 'the contract was written for the engine to read');
  const written = readFileSync(contractPath, 'utf8');
  assert.ok(written.startsWith(CONTRACT_FILE_MARKER), 'the file is Sprout-owned');
  assert.ok(written.includes(PROJECT_CONTRACT), 'the assembled contract is what was written');
});

test('a working-directory engine leaves a user AGENTS.md intact and reports the skip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-oc-user-'));
  const userContent = '# Repo AGENTS.md\nUser-owned.\n';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'AGENTS.md'), userContent);

  const adapter = new OpenCodeEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      queueMicrotask(() => {
        stdout.write(
          `${JSON.stringify({ type: 'step_finish', part: { reason: 'stop' }, sessionID: 'ses_x' })}\n`,
        );
        stdout.end();
      });
      return {
        stdout,
        stderr,
        writeStdin: () => undefined,
        endStdin: () => undefined,
        kill: () => undefined,
        onExit: (handler: (code: number | null) => void) => queueMicrotask(() => handler(0)),
        onSpawnError: () => undefined,
      };
    },
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: dir,
    instructions: PROJECT_CONTRACT,
  });
  await session.close();

  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), userContent, 'user file untouched');
  assert.ok(existsSync(join(dir, CONTRACT_FILE_NAME)), 'the contract went to Sprout\'s own file');
  assert.equal(session.contractDelivery?.mechanism, 'sprout-contract-file');
  assert.equal(session.contractDelivery?.agentsMdSkipped, 'user-owned');
});

test('both channels receive the same contract content, so delivery is per-engine but not per-content', async () => {
  const collected: string[] = [];

  const piArgv: string[][] = [];
  const pi = new PiEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: (_binary, args) => {
      piArgv.push([...args]);
      const process = fakePiProcess(() => undefined);
      queueMicrotask(() => process.emit());
      return process;
    },
  });
  const piSession = await pi.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    instructions: PROJECT_CONTRACT,
  });
  piSession.run('go');
  await piSession.close();

  const dir = mkdtempSync(join(tmpdir(), 'sprout-same-contract-'));
  const oc = new OpenCodeEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: () => {
      const stdout = new PassThrough();
      queueMicrotask(() => {
        stdout.write(
          `${JSON.stringify({ type: 'step_finish', part: { reason: 'stop' }, sessionID: 'ses_x' })}\n`,
        );
        stdout.end();
      });
      return {
        stdout,
        stderr: new PassThrough(),
        writeStdin: () => undefined,
        endStdin: () => undefined,
        kill: () => undefined,
        onExit: (handler: (code: number | null) => void) => queueMicrotask(() => handler(0)),
        onSpawnError: () => undefined,
      };
    },
  });
  const ocSession = await oc.startSession({
    agentId: 'scout',
    workingDirectory: dir,
    instructions: PROJECT_CONTRACT,
  });
  await ocSession.close();

  collected.push((piArgv[0] ?? [])[((piArgv[0] ?? []).indexOf('--append-system-prompt') + 1)] ?? '');
  collected.push(readFileSync(join(dir, 'AGENTS.md'), 'utf8'));

  assert.equal(collected[0], PROJECT_CONTRACT);
  assert.ok(collected[1]?.includes(PROJECT_CONTRACT));
});
