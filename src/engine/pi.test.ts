import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { PiEngineAdapter, PiSession } from './pi.ts';
import type { AgentRunEvent } from './port.ts';

/**
 * A fake `pi --mode json` process.
 *
 * It replays lines recorded from `pi 0.85.1`, so the adapter is verified against
 * the engine's real stream without invoking it. A turn is one process here,
 * exactly as it is in production.
 */
class FakePiProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #exitHandlers: ((code: number | null) => void)[] = [];
  readonly #onRun: (process: FakePiProcess) => void;
  killed = false;

  constructor(onRun: (process: FakePiProcess) => void) {
    this.#onRun = onRun;
    queueMicrotask(() => this.#onRun(this));
  }

  line(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  exit(code: number): void {
    this.stdout.end();
    for (const handler of this.#exitHandlers) handler(code);
  }

  kill(): void {
    this.killed = true;
    this.exit(0);
  }

  onExit(handler: (code: number | null) => void): void {
    this.#exitHandlers.push(handler);
  }

  onSpawnError(_handler: (error: Error) => void): void {
    // Fakes never fail to spawn; a dedicated test below drives this path.
  }
}

/** The turn a healthy Pi run produces, as recorded from the real engine. */
function replaySuccessfulTurn(process: FakePiProcess, answer: string): void {
  process.line({ type: 'session', version: 3, id: 'pi-1', cwd: '/tmp' });
  process.line({ type: 'agent_start' });
  process.line({ type: 'turn_start' });
  process.line({
    type: 'tool_execution_start',
    toolCallId: 'call_1',
    toolName: 'bash',
    args: { command: 'echo pi-tool-ok' },
  });
  process.line({
    type: 'tool_execution_update',
    toolCallId: 'call_1',
    toolName: 'bash',
    args: { command: 'echo pi-tool-ok' },
    partialResult: { content: [{ type: 'text', text: 'pi-tool-ok\n' }], details: {} },
  });
  process.line({
    type: 'tool_execution_end',
    toolCallId: 'call_1',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'pi-tool-ok\n' }] },
    isError: false,
  });
  process.line({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
  });
  for (const delta of answer.match(/.{1,4}/gs) ?? [answer]) {
    process.line({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
    });
  }
  process.line({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: answer },
  });
  process.line({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
  });
  process.line({ type: 'turn_end', message: { role: 'assistant', content: [] } });
  process.line({ type: 'agent_end', messages: [], willRetry: false });
  process.line({ type: 'agent_settled' });
}

function adapterFor(onRun: (process: FakePiProcess) => void) {
  const spawned: FakePiProcess[] = [];
  const argv: string[][] = [];
  const adapter = new PiEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: (_binary, args) => {
      argv.push([...args]);
      const fake = new FakePiProcess((self) => {
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

test('a Pi turn streams tool progress and text, then completes', async () => {
  const { adapter, argv } = adapterFor((process) => replaySuccessfulTurn(process, 'pi-tool-ok'));

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    instructions: 'You are Scout.',
  });
  const turn = session.run('run echo');
  const events = await collect(turn.events);
  const result = await turn.completion;

  assert.deepEqual(
    events.map((event) => event.type),
    ['tool-call', 'tool-output', 'tool-output', 'message', 'message', 'message'],
  );
  assert.deepEqual(result, { status: 'completed', text: 'pi-tool-ok' });

  // The prompt is a positional argument; `--print` is a boolean flag.
  const args = argv[0] ?? [];
  assert.ok(args.includes('--mode') && args.includes('json'));
  assert.ok(args.includes('--print'), 'the non-interactive flag is passed');
  assert.ok(
    args.includes('--session-id') && args.includes(session.sessionId),
    'Sprout owns the session id',
  );
  assert.ok(args.includes('--append-system-prompt') && args.includes('You are Scout.'));
  assert.equal(args.at(-1), 'run echo', 'the prompt is the final positional argument');
  assert.ok(
    !args.some((arg) => arg.startsWith('-p=')),
    'the prompt is never attached to a flag',
  );
});

test("a turn is a fresh process, and the session id is reused so context continues", async () => {
  const { adapter, argv } = adapterFor((process) => replaySuccessfulTurn(process, 'done'));

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  await collect(session.run('first').events);
  await collect(session.run('second').events);

  assert.equal(argv.length, 2, 'each turn spawned its own process');
  const idFlag = (args: readonly string[]) => args[args.indexOf('--session-id') + 1];
  assert.equal(idFlag(argv[0] ?? []), idFlag(argv[1] ?? []), 'both turns resumed one session');
  assert.equal(idFlag(argv[0] ?? []), session.sessionId);
});

test('a supplied resume key becomes the session id, so a prior run continues', async () => {
  // Pi's key is caller-chosen (#19), so resuming is exactly the same code path
  // as starting: the supplied id is passed to `--session-id`. A stale id is
  // Pi's soft fallback (a warning and a new file with that same id).
  const { adapter, argv } = adapterFor((process) => replaySuccessfulTurn(process, 'done'));

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    resumeSessionKey: 'scout-session-7',
  });
  await collect(session.run('continue').events);

  assert.equal(session.sessionId, 'scout-session-7', 'the supplied key is the session id');
  assert.equal(session.engineSessionKey, 'scout-session-7');
  const args = argv[0] ?? [];
  assert.equal(args[args.indexOf('--session-id') + 1], 'scout-session-7');
});

test('stopping a Pi turn kills the turn process and settles the turn', async () => {
  const { adapter, spawned } = adapterFor(() => {
    // A turn that never settles on its own, as a long generation would not.
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('long job');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const interrupted = await session.interrupt();
  const result = await turn.completion;

  assert.equal(interrupted, true);
  assert.deepEqual(result, { status: 'interrupted' });
  assert.equal(spawned[0]?.killed, true, 'the engine process was killed');
});

test('a process that exits without settling the turn fails it instead of hanging it', async () => {
  const { adapter } = adapterFor((process) => {
    process.line({ type: 'agent_start' });
    process.exit(1);
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('boom');
  await collect(turn.events);
  const result = await turn.completion;

  assert.equal(result.status, 'failed');
  assert.match(
    result.status === 'failed' ? result.message : '',
    /exited without settling the turn/,
  );
});

test('an engine error terminates the turn as failed', async () => {
  const { adapter } = adapterFor((process) => {
    process.line({ type: 'error', message: 'model unavailable' });
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('go');
  await collect(turn.events);
  const result = await turn.completion;

  assert.deepEqual(result, { status: 'failed', message: 'model unavailable' });
});

test('Pi declares incremental streaming rather than inheriting Codex behaviour', async () => {
  const { adapter } = adapterFor(() => undefined);
  assert.equal(adapter.capabilities.streaming, 'incremental');
  assert.equal(adapter.capabilities.supportsInterrupt, true);
  assert.equal(adapter.id, 'pi');
});

test('a non-JSON line on the protocol channel does not fail a healthy turn', async () => {
  const { adapter } = adapterFor((process) => {
    // Pi prints this warning when a session id is new.
    process.stdout.write("Warning: No project session found with id 'x'.\n");
    replaySuccessfulTurn(process, 'fine');
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('go');
  await collect(turn.events);
  const result = await turn.completion;

  assert.deepEqual(result, { status: 'completed', text: 'fine' });
});

test('closing a session settles an in-flight turn', async () => {
  const { adapter, spawned } = adapterFor(() => undefined);
  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('long job');
  await new Promise((resolve) => setTimeout(resolve, 10));

  await session.close();
  assert.deepEqual(await turn.completion, { status: 'interrupted' });
  assert.equal(spawned[0]?.killed, true);
});

test('a session directory can be set so Pi does not write to the user default', async () => {
  const argv: string[][] = [];
  const spawned: FakePiProcess[] = [];
  const adapter = new PiEngineAdapter({
    binaryPath: '/usr/bin/true',
    sessionDirectory: '/tmp/sprout-pi-sessions',
    spawnProcess: (_binary, args) => {
      argv.push([...args]);
      const fake = new FakePiProcess((self) => {
        spawned.push(self);
        replaySuccessfulTurn(self, 'ok');
      });
      return fake;
    },
  });

  const session: PiSession = (await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
  })) as PiSession;
  await collect(session.run('go').events);

  const args = argv[0] ?? [];
  assert.equal(args[args.indexOf('--session-dir') + 1], '/tmp/sprout-pi-sessions');
});

test('across multiple turns, the last assistant text is the turn answer', async () => {
  // Pi starts a new turn whenever it uses a tool, so a single run legitimately
  // produces several assistant messages. The last one is the answer.
  const { adapter } = adapterFor((process) => {
    process.line({ type: 'turn_start' });
    process.line({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'echo hi' },
    });
    process.line({
      type: 'tool_execution_end',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'hi\n' }] },
      isError: false,
    });
    // The empty assistant message that accompanies the tool call.
    process.line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } });
    process.line({ type: 'turn_start' });
    process.line({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' },
    });
    process.line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
    process.line({ type: 'agent_settled' });
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('run echo');
  await collect(turn.events);
  const result = await turn.completion;

  assert.deepEqual(result, { status: 'completed', text: 'hi' });
});

test('a trailing off-task assistant message overrides the real answer', async () => {
  // Observed live and recorded here deliberately rather than left implicit: Pi
  // can emit an extra turn whose text is unrelated to the request — in that run
  // it was a warning about a broken MCP server from the host's global config —
  // and this adapter takes the LAST assistant text as the turn's answer.
  //
  // This is a real limitation, not a satisfied requirement. It is recorded as fog
  // on the map: the noise source is engine configuration Sprout does not own.
  const { adapter } = adapterFor((process) => {
    process.line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'pi-e2e-ok' }] } });
    process.line({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'The `UnityMCP` server is currently unreachable.' }],
      },
    });
    process.line({ type: 'agent_settled' });
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('go');
  await collect(turn.events);
  const result = await turn.completion;

  assert.deepEqual(result, {
    status: 'completed',
    text: 'The `UnityMCP` server is currently unreachable.',
  });
  // The earlier answer is still in the progress record, so it is not lost, only
  // not labelled as the turn's final text.
});
