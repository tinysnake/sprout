import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { AgyEngineAdapter } from './agy.ts';
import { AGY_CONTRACT_PAYLOAD_ENV } from './agy-contract-hook.ts';
import { PiEngineAdapter } from './pi.ts';
import { OpenCodeEngineAdapter } from './opencode.ts';
import { OPENCODE_CONFIG_CONTENT_ENV } from './opencode-instructions.ts';
import { renderProjectContract, assembleProjectContract } from '../project/contract.ts';
import { CONTRACT_FILE_MARKER, CONTRACT_FILE_NAME } from './contract-file.ts';

/**
 * Contract delivery through the engine fakes, for engines with **different**
 * instruction channels (#21 acceptance).
 *
 * Pi takes standing instructions out-of-band on argv (`--append-system-prompt`);
 * `agy` takes them out-of-band as an injected system message through its config
 * hook (it has no system-prompt flag); `opencode` has no system-prompt surface at
 * all and reads `AGENTS.md` from the working directory. All must receive the
 * *same* assembled contract, each through its own channel, which is what proves
 * the seam delivers per-engine rather than assuming one uniform surface (the fog
 * #17 exists to resolve).
 */

/** The real assembled contract, not a hand-written stand-in. */
const PROJECT_CONTRACT = renderProjectContract(
  assembleProjectContract({
    project: {
      id: 'project-sprout',
      goal: 'Ship a portable project context',
      rules: ['Report what you observed'],
      availableEnvironmentInstanceIds: ['mac-mini-1'],
      memberships: [
        {
          agentId: 'scout',
          responsibilities: ['Own the contract seam'],
          collaborationInstructions: 'Tell the channel what changed.',
        },
      ],
    },
    agentId: 'scout',
    agentInstructions: 'You are Scout.',
  }),
);

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

test('a working-directory engine leaves a user AGENTS.md intact and registers its fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-oc-user-'));
  const userContent = '# Repo AGENTS.md\nUser-owned.\n';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'AGENTS.md'), userContent);

  let spawnedEnv: NodeJS.ProcessEnv | undefined;
  const adapter = new OpenCodeEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: (_binary, _args, env) => {
      spawnedEnv = env;
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
  session.run('go');
  await session.close();

  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), userContent, 'user file untouched');
  const fallbackPath = join(dir, CONTRACT_FILE_NAME);
  assert.ok(existsSync(fallbackPath), 'the contract went to Sprout\'s own file');
  // A fallback is a successful delivery, and it is reported as a distinct
  // mechanism so a user can tell the contract did not go to the primary file.
  assert.equal(session.contractDelivery?.mechanism, 'sprout-contract-file');
  assert.equal(session.contractDelivery?.agentsMdSkipped, 'user-owned');

  // C21-004: writing the file is not a delivery unless the engine reads it.
  // `opencode` discovers `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` only, so the
  // adapter must point the engine at Sprout's fallback through the engine's own
  // config `instructions` list, which travels in the spawned process env.
  const overlay = spawnedEnv?.[OPENCODE_CONFIG_CONTENT_ENV];
  assert.ok(overlay, 'the run is spawned with the config overlay that registers the fallback');
  const registered = (JSON.parse(overlay) as { instructions?: string[] }).instructions ?? [];
  assert.ok(
    registered.includes(fallbackPath),
    `the fallback path is registered with the engine (${registered.join(', ')})`,
  );
});

test('opencode delivery falls back to unavailable when the operator config cannot be merged', async () => {
  // The engine cannot be pointed at Sprout's fallback file without rewriting the
  // operator's config overlay, and Sprout refuses to rewrite what it cannot
  // parse. The run must then report `unavailable` rather than a successful
  // delivery the engine never receives.
  const dir = mkdtempSync(join(tmpdir(), 'sprout-oc-unmergeable-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'AGENTS.md'), '# user AGENTS.md\n');

  const adapter = new OpenCodeEngineAdapter({
    binaryPath: '/usr/bin/true',
    env: { [OPENCODE_CONFIG_CONTENT_ENV]: '{ not json' },
    spawnProcess: () => {
      const stdout = new PassThrough();
      queueMicrotask(() => stdout.end());
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

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: dir,
    instructions: PROJECT_CONTRACT,
  });
  await session.close();

  assert.equal(session.contractDelivery?.mechanism, 'unavailable');
  assert.match(session.contractDelivery?.reason ?? '', /registered with opencode/);
  assert.equal(session.contractDelivery?.agentsMdSkipped, 'user-owned');
});

test('an operator shell config overlay is merged with, not replaced by, Sprout\'s registration', async () => {
  // With no explicit adapter env the spawned process inherits `process.env`, so
  // registration must read that too: otherwise an operator's shell-level
  // `OPENCODE_CONFIG_CONTENT` would be silently discarded by Sprout's overlay.
  const dir = mkdtempSync(join(tmpdir(), 'sprout-oc-inherit-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'AGENTS.md'), '# user AGENTS.md\n');
  const operatorPath = '/tmp/operator-rules.md';
  const previous = process.env[OPENCODE_CONFIG_CONTENT_ENV];
  process.env[OPENCODE_CONFIG_CONTENT_ENV] = JSON.stringify({ instructions: [operatorPath] });

  let spawnedEnv: NodeJS.ProcessEnv | undefined;
  const adapter = new OpenCodeEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: (_binary, _args, env) => {
      spawnedEnv = env;
      const stdout = new PassThrough();
      queueMicrotask(() => stdout.end());
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

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: dir,
    instructions: PROJECT_CONTRACT,
  });
  session.run('go');
  // The overlay is applied when the process is spawned, which is the turn; the
  // inherited variable can be restored once that has happened.
  if (previous === undefined) delete process.env[OPENCODE_CONFIG_CONTENT_ENV];
  else process.env[OPENCODE_CONFIG_CONTENT_ENV] = previous;
  await session.close();

  const registered =
    (JSON.parse(spawnedEnv?.[OPENCODE_CONFIG_CONTENT_ENV] ?? '{}') as { instructions?: string[] })
      .instructions ?? [];
  assert.ok(registered.includes(operatorPath), 'the operator entry survives');
  assert.ok(
    registered.includes(join(dir, CONTRACT_FILE_NAME)),
    'and Sprout\'s fallback is appended to it',
  );
});

test('agy receives the same contract out-of-band through its config hook', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'sprout-agy-config-'));
  const payloadDirectory = mkdtempSync(join(tmpdir(), 'sprout-agy-payload-'));
  let spawnedEnv: NodeJS.ProcessEnv | undefined;
  const adapter = new AgyEngineAdapter({
    binaryPath: '/usr/bin/true',
    configDirectory,
    payloadDirectory,
    spawnProcess: (_binary, _args, env) => {
      spawnedEnv = env;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      queueMicrotask(() => {
        stdout.write(
          `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } })}\n`,
        );
        stdout.end();
      });
      return {
        stdout,
        stderr,
        kill: () => undefined,
        onExit: (handler: (code: number | null) => void) => queueMicrotask(() => handler(0)),
        onSpawnError: () => undefined,
      };
    },
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    instructions: PROJECT_CONTRACT,
  });
  await session.run('go').completion;

  // Out-of-band: the contract is injected as a system message, not in argv.
  assert.equal(session.contractDelivery?.mechanism, 'engine-hook');
  // The spawned agy process is handed the env var that makes its hook select
  // THIS run's contract payload — the fact that makes the channel work.
  const payloadPath = spawnedEnv?.[AGY_CONTRACT_PAYLOAD_ENV];
  assert.ok(payloadPath, 'the agy process is spawned with the payload env var');
  const payload = JSON.parse(readFileSync(payloadPath, 'utf8')) as {
    injectSteps: { ephemeralMessage: string }[];
  };
  assert.equal(payload.injectSteps[0]?.ephemeralMessage, PROJECT_CONTRACT);
  // Closing the session removes the per-run payload.
  await session.close();
  assert.equal(existsSync(payloadPath), false, 'the per-run payload is cleaned up on close');
});

test('every channel receives the same contract content, so delivery is per-engine but not per-content', async () => {
  const collected: string[] = [];
  let agyEnv: NodeJS.ProcessEnv | undefined;

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

  const agy = new AgyEngineAdapter({
    binaryPath: '/usr/bin/true',
    configDirectory: mkdtempSync(join(tmpdir(), 'sprout-agy-config-')),
    payloadDirectory: mkdtempSync(join(tmpdir(), 'sprout-agy-payload-')),
    spawnProcess: (_binary, _args, env) => {
      agyEnv = env;
      const stdout = new PassThrough();
      queueMicrotask(() => {
        stdout.write(
          `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } })}\n`,
        );
        stdout.end();
      });
      return {
        stdout,
        stderr: new PassThrough(),
        kill: () => undefined,
        onExit: (handler: (code: number | null) => void) => queueMicrotask(() => handler(0)),
        onSpawnError: () => undefined,
      };
    },
  });
  const agySession = await agy.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    instructions: PROJECT_CONTRACT,
  });
  await agySession.run('go').completion;

  collected.push((piArgv[0] ?? [])[((piArgv[0] ?? []).indexOf('--append-system-prompt') + 1)] ?? '');
  collected.push(readFileSync(join(dir, 'AGENTS.md'), 'utf8'));
  const agyPayloadPath = agyEnv?.[AGY_CONTRACT_PAYLOAD_ENV] ?? '';
  collected.push(
    (JSON.parse(readFileSync(agyPayloadPath, 'utf8')) as {
      injectSteps: { ephemeralMessage: string }[];
    }).injectSteps[0]?.ephemeralMessage ?? '',
  );
  await agySession.close();

  assert.equal(collected[0], PROJECT_CONTRACT);
  assert.ok(collected[1]?.includes(PROJECT_CONTRACT));
  assert.equal(collected[2], PROJECT_CONTRACT);
});
