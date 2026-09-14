import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { AgyEngineAdapter, AgySession } from './agy.ts';
import { AGY_CONTRACT_HOOK_NAME, AGY_CONTRACT_PAYLOAD_ENV } from './agy-contract-hook.ts';
import type { AgentRunEvent } from './port.ts';

/**
 * Frames recorded from `agy 1.2.2` on this host, trimmed to what the mapping
 * needs, so the adapter is checked against the engine's real stream.
 */
function replaySuccessfulTurn(process: { line(value: unknown): void }, answer: string): void {
  process.line({
    event: 'init',
    conversation_id: '1354d8d5-7266-479c-88cc-83abd1282acc',
    init: { cwd: '/tmp/agy-probe', tools: ['run_command'] },
  });
  process.line({
    event: 'step_update',
    step_update: { conversation_id: 'c', step_index: 0, state: 'DONE', step_type: 'user_input' },
  });
  process.line({
    event: 'step_update',
    step_update: {
      conversation_id: 'c',
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'echo agy-probe-ok' },
      },
    },
  });
  // The tool's output arrives on the DONE frame, inside tool_info, and only once.
  process.line({
    event: 'step_update',
    step_update: {
      conversation_id: 'c',
      step_index: 1,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'echo agy-probe-ok' },
        output: 'agy-probe-ok\n',
      },
    },
  });
  process.line({
    event: 'step_update',
    step_update: {
      conversation_id: 'c',
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'agy-',
    },
  });
  process.line({
    event: 'step_update',
    step_update: {
      conversation_id: 'c',
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'probe-ok\n',
    },
  });
  process.line({
    event: 'result',
    result: {
      conversation_id: 'c',
      status: 'SUCCESS',
      response: answer,
      duration_seconds: 1.2,
      num_turns: 1,
    },
  });
}

class FakeAgyProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #exitHandlers: ((code: number | null) => void)[] = [];
  readonly #onRun: (process: FakeAgyProcess) => void;
  killed = false;

  constructor(onRun: (process: FakeAgyProcess) => void) {
    this.#onRun = onRun;
    queueMicrotask(() => this.#onRun(this));
  }

  line(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  raw(text: string): void {
    this.stdout.write(text);
  }

  exit(code: number): void {
    this.stdout.end();
    for (const handler of this.#exitHandlers) handler(code);
  }

  kill(): void {
    this.killed = true;
    this.exit(0);
  }

  onSpawnError(_handler: (error: Error) => void): void {
    // Fakes never fail to spawn.
  }

  onExit(handler: (code: number | null) => void): void {
    this.#exitHandlers.push(handler);
  }
}

function adapterFor(onRun: (process: FakeAgyProcess) => void, options: Record<string, unknown> = {}) {
  const spawned: FakeAgyProcess[] = [];
  const argv: string[][] = [];
  const adapter = new AgyEngineAdapter({
    binaryPath: '/usr/bin/true',
    // Tests never touch the operator's real agy configuration.
    configDirectory: mkdtempSync(join(tmpdir(), 'sprout-agy-config-')),
    payloadDirectory: mkdtempSync(join(tmpdir(), 'sprout-agy-payload-')),
    ...(options.skipPermissions === true ? { skipPermissions: true } : {}),
    spawnProcess: (_binary, args) => {
      argv.push([...args]);
      const fake = new FakeAgyProcess((self) => {
        spawned.push(self);
        onRun(self);
      });
      return fake;
    },
  });
  return { adapter, spawned, argv };
}

async function collect(events: AsyncIterable<AgentRunEvent>): Promise<AgentRunEvent[]> {
  const collected: AgentRunEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

test('an agy turn streams tool progress and text, then completes', async () => {
  const { adapter, argv } = adapterFor((process) => replaySuccessfulTurn(process, 'agy-probe-ok\n'));

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('run echo');
  const events = await collect(turn.events);
  const result = await turn.completion;

  // Two text deltas stream the answer; the tool call and its output precede them.
  assert.deepEqual(
    events.map((event) => event.type),
    ['tool-call', 'tool-output', 'message', 'message'],
  );
  assert.equal(
    (events[0] as { detail?: string }).detail,
    'echo agy-probe-ok',
    'the tool invocation is shown, not just its name',
  );
  assert.deepEqual((events[1] as { text?: string }).text, 'agy-probe-ok\n');
  assert.deepEqual(result, { status: 'completed', text: 'agy-probe-ok\n' });

  // The prompt must be attached to --print, and every other flag must precede it.
  const args = argv[0] ?? [];
  assert.ok(args.includes('--dangerously-skip-permissions') === false);
  // stream-json is what makes the output a protocol at all.
  assert.ok(args.includes('--output-format') && args.includes('stream-json'));
  assert.equal(args.at(-1), '--print=run echo');
});

test('the prompt is attached to --print, because a bare --print swallows the next flag', async () => {
  const { adapter, argv } = adapterFor((process) => replaySuccessfulTurn(process, 'ok'));
  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  await collect(session.run('my prompt').events);

  const args = argv[0] ?? [];
  assert.equal(args.at(-1), '--print=my prompt');
  assert.equal(args.filter((arg) => arg === '--print=my prompt').length, 1);
});

test('skipPermissions is opt-in and comes before --print', async () => {
  const { adapter, argv } = adapterFor(
    (process) => replaySuccessfulTurn(process, 'ok'),
    { skipPermissions: true },
  );
  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  await collect(session.run('go').events);

  const args = argv[0] ?? [];
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.indexOf('--dangerously-skip-permissions') < args.indexOf('--print=go'));
});

test('agy has no system-prompt flag, so the contract is injected through its config hook', async () => {
  // `agy 1.2.2` has no system-prompt surface (`--append-system-prompt` does not
  // exist) *and* does not read a project `AGENTS.md` in headless mode, so the
  // adapter installs a `SessionStart` hook in agy's global customization root
  // that injects the contract as an ephemeral system message. Nothing
  // contract-shaped ever reaches argv or the prompt.
  const configDirectory = mkdtempSync(join(tmpdir(), 'sprout-agy-config-'));
  const payloadDirectory = mkdtempSync(join(tmpdir(), 'sprout-agy-payload-'));
  const argv: string[][] = [];
  let spawnedEnv: NodeJS.ProcessEnv | undefined;
  const adapter = new AgyEngineAdapter({
    binaryPath: '/usr/bin/true',
    configDirectory,
    payloadDirectory,
    spawnProcess: (_binary, args, env) => {
      argv.push([...args]);
      spawnedEnv = env;
      return new FakeAgyProcess((process) => replaySuccessfulTurn(process, 'ok'));
    },
  });
  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    instructions: 'You are Scout.',
  });
  await collect(session.run('go').events);

  const args = argv[0] ?? [];
  assert.ok(
    !args.includes('--append-system-prompt'),
    'agy does not define --append-system-prompt',
  );
  assert.ok(!args.includes('You are Scout.'), 'instructions are not injected into argv');

  // The hook is installed and carries the contract payload; the run is spawned
  // with the env var that selects that payload.
  const hooks = JSON.parse(readFileSync(join(configDirectory, 'hooks.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.ok(hooks[AGY_CONTRACT_HOOK_NAME], 'the Sprout contract hook is registered');
  assert.equal(session.contractDelivery?.mechanism, 'engine-hook');
  const payloadPath = spawnedEnv?.[AGY_CONTRACT_PAYLOAD_ENV];
  assert.ok(payloadPath, 'the run is spawned with the env var selecting its contract payload');
  assert.match(
    readFileSync(payloadPath, 'utf8'),
    /You are Scout\./,
    'the payload carries the assembled contract',
  );

  await session.close();
});

test('the agy adapter installs the hook command its platform actually runs', async () => {
  // C21-005: `agy` runs hook commands through `sh -c` on Unix and `cmd /c` on
  // Windows, and Windows is a supported environment target (O2, #5). The adapter
  // must pass the platform through so a Windows environment gets a batch entry
  // rather than a `sh` invocation that does not exist there.
  const configDirectory = mkdtempSync(join(tmpdir(), 'sprout-agy-config-'));
  const adapter = new AgyEngineAdapter({
    binaryPath: '/usr/bin/true',
    configDirectory,
    payloadDirectory: mkdtempSync(join(tmpdir(), 'sprout-agy-payload-')),
    hookPlatform: 'windows',
    spawnProcess: () => new FakeAgyProcess((process) => replaySuccessfulTurn(process, 'ok')),
  });
  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    instructions: 'You are Scout.',
  });

  const hooks = JSON.parse(readFileSync(join(configDirectory, 'hooks.json'), 'utf8')) as Record<
    string,
    { SessionStart?: { command?: string }[] }
  >;
  const command = hooks[AGY_CONTRACT_HOOK_NAME]?.SessionStart?.[0]?.command ?? '';
  assert.match(command, /sprout-project-contract\.cmd/, 'the Windows entry is a batch file');
  assert.ok(!/^\s*sh\b/.test(command), 'the Windows entry never invokes sh');
  assert.equal(session.contractDelivery?.mechanism, 'engine-hook');
  await session.close();
});

test('the contract hook is inert without the payload env var', async () => {
  // The hook always runs for agy; it must do nothing unless Sprout set the env
  // var for this run, so installing it cannot affect agy runs Sprout did not
  // start.
  const configDirectory = mkdtempSync(join(tmpdir(), 'sprout-agy-config-'));
  const adapter = new AgyEngineAdapter({
    binaryPath: '/usr/bin/true',
    configDirectory,
    payloadDirectory: mkdtempSync(join(tmpdir(), 'sprout-agy-payload-')),
    spawnProcess: () => new FakeAgyProcess((process) => replaySuccessfulTurn(process, 'ok')),
  });
  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  await collect(session.run('go').events);

  assert.equal(session.contractDelivery, undefined, 'no contract, no delivery reported');
  assert.equal(
    existsSync(join(configDirectory, 'hooks.json')),
    false,
    'no hook is installed when there is no contract',
  );
  await session.close();
});

test('the conversation id from the init frame is reused on the next turn', async () => {
  const { adapter, argv, spawned } = adapterFor((process) => replaySuccessfulTurn(process, 'ok'));

  const session: AgySession = (await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
  })) as AgySession;
  await collect(session.run('first').events);
  assert.equal(session.conversationId, '1354d8d5-7266-479c-88cc-83abd1282acc');

  await collect(session.run('second').events);
  assert.equal(argv.length, 2);
  const idFlag = (args: readonly string[]) => args[args.indexOf('--conversation') + 1];
  assert.equal(
    idFlag(argv[1] ?? []),
    '1354d8d5-7266-479c-88cc-83abd1282acc',
    'the second turn resumes the conversation agy assigned',
  );
  // agy assigns the id; Sprout does not choose one. Both facts are worth recording.
  assert.equal(spawned[0] !== spawned[1], true, 'each turn is its own process');
});

test('a stored conversation id resumes the conversation on the first turn', async () => {
  // agy assigns conversation ids, so a stored one is a *hint*: it is offered
  // via --conversation and the engine reports which conversation it actually
  // used in its init frame.
  const { adapter, argv } = adapterFor((process) => replaySuccessfulTurn(process, 'ok'));

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    resumeSessionKey: 'prior-conversation-id',
  });
  await collect(session.run('continue').events);

  const args = argv[0] ?? [];
  assert.equal(args[args.indexOf('--conversation') + 1], 'prior-conversation-id');
});

test('a stale conversation id is replaced by the id agy actually used', async () => {
  // agy soft-falls-back on a stale id (#19): it warns and starts a fresh
  // conversation with a NEW id. Sprout must then continue that new conversation
  // on later turns, not re-offer the id agy refused, and must report the new id
  // so the core persists it.
  const { adapter, argv } = adapterFor((process) => {
    // Every turn reports the engine-assigned id, ignoring the stale hint.
    replaySuccessfulTurn(process, 'ok');
  });

  const session: AgySession = (await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    resumeSessionKey: 'stale-id-that-agy-refused',
  })) as AgySession;
  assert.equal(session.engineSessionKey, 'stale-id-that-agy-refused', 'the hint is all that is known yet');

  await collect(session.run('first').events);
  assert.equal(session.engineSessionKey, '1354d8d5-7266-479c-88cc-83abd1282acc');

  await collect(session.run('second').events);
  const idFlag = (args: readonly string[]) => args[args.indexOf('--conversation') + 1];
  assert.equal(
    idFlag(argv[1] ?? []),
    '1354d8d5-7266-479c-88cc-83abd1282acc',
    'the second turn uses the id agy assigned, not the stale one',
  );
});

test('stopping an agy turn kills the process and settles the turn', async () => {
  const { adapter, spawned } = adapterFor(() => undefined);
  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('long job');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const interrupted = await session.interrupt();
  const result = await turn.completion;

  assert.equal(interrupted, true);
  assert.deepEqual(result, { status: 'interrupted' });
  assert.equal(spawned[0]?.killed, true);
});

test('a process that exits without a result frame fails the turn instead of hanging it', async () => {
  const { adapter } = adapterFor((process) => {
    process.line({
      event: 'step_update',
      step_update: { conversation_id: 'c', step_index: 0, state: 'ACTIVE', step_type: 'agent_response' },
    });
    process.exit(1);
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('boom');
  await collect(turn.events);
  const result = await turn.completion;

  assert.equal(result.status, 'failed');
  assert.match(result.status === 'failed' ? result.message : '', /exited without settling the turn/);
});

test('a non-success result fails the turn', async () => {
  const { adapter } = adapterFor((process) => {
    process.line({ event: 'init', conversation_id: 'c', init: { cwd: '/tmp' } });
    process.line({ event: 'result', result: { status: 'DENIED', response: 'no' } });
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('go');
  await collect(turn.events);
  const result = await turn.completion;

  assert.equal(result.status, 'failed');
  assert.match(result.status === 'failed' ? result.message : '', /did not succeed/);
});

test('non-JSON output on the protocol channel does not fail a healthy turn', async () => {
  const { adapter } = adapterFor((process) => {
    process.raw('agy-probe-ok\n');
    replaySuccessfulTurn(process, 'agy-probe-ok\n');
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('go');
  await collect(turn.events);
  const result = await turn.completion;

  assert.deepEqual(result, { status: 'completed', text: 'agy-probe-ok\n' });
});

test('agy declares incremental streaming and its own id', () => {
  const { adapter } = adapterFor(() => undefined);
  assert.equal(adapter.id, 'agy');
  assert.equal(adapter.capabilities.streaming, 'incremental');
  assert.equal(adapter.capabilities.supportsInterrupt, true);
  // `agy` has no system-prompt flag, but it does take instructions through its
  // config hook as an injected system message, which is out-of-band, not a file
  // the engine discovers.
  assert.equal(adapter.capabilities.standingInstructions, 'out-of-band');
});
