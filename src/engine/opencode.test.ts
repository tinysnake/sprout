import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { OpenCodeEngineAdapter, OpenCodeSession } from './opencode.ts';
import { mapOpenCodeEvent, newOpenCodeTurnState } from './opencode-protocol.ts';
import type { AgentRunEvent } from './port.ts';

/**
 * Frames shaped as `opencode 1.18.x` emits them, contract-verified. The engine
 * could not be exercised live on this host (its default provider account has no
 * balance, and no alternative provider was usable), so these tests are the
 * evidence the adapter is correct against the protocol, and the live check is
 * recorded as blocked rather than faked.
 */
function adapterFor(
  onRun: (process: FakeOpenCodeProcess) => void,
  options: { exitCode?: number } = {},
) {
  const spawned: FakeOpenCodeProcess[] = [];
  const argv: string[][] = [];
  const adapter = new OpenCodeEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: (_binary, args) => {
      argv.push([...args]);
      const fake = new FakeOpenCodeProcess((self) => {
        spawned.push(self);
        onRun(self);
      }, options.exitCode ?? 0);
      return fake;
    },
  });
  return { adapter, spawned, argv };
}

class FakeOpenCodeProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  #exitCode: number;
  readonly #exitHandlers: ((code: number | null) => void)[] = [];
  readonly #onRun: (process: FakeOpenCodeProcess) => void;
  killed = false;

  constructor(onRun: (process: FakeOpenCodeProcess) => void, exitCode: number) {
    this.#onRun = onRun;
    this.#exitCode = exitCode;
    queueMicrotask(() => this.#onRun(this));
  }

  line(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  writeStdin(text: string): void {
    this.written.push(text);
  }

  endStdin(): void {
    // The prompt has been delivered; a real engine starts working here.
    void this.#exitCode;
  }

  settle(code: number): void {
    this.stdout.end();
    for (const handler of this.#exitHandlers) handler(code);
  }

  kill(): void {
    this.killed = true;
    this.settle(this.#exitCode);
  }

  onSpawnError(_handler: (error: Error) => void): void {
    // Fakes never fail to spawn.
  }

  onExit(handler: (code: number | null) => void): void {
    this.#exitHandlers.push(handler);
  }
}

async function collect(events: AsyncIterable<AgentRunEvent>): Promise<AgentRunEvent[]> {
  const collected: AgentRunEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

test('a turn reports text as one block per hop and completes from process exit', async () => {
  const { adapter, argv } = adapterFor((process) => {
    process.line({ type: 'step_start', sessionID: 'ses_1', part: {} });
    process.line({
      type: 'tool_use',
      sessionID: 'ses_1',
      part: { type: 'tool', name: 'bash', title: 'echo oc-probe-ok' },
    });
    process.line({
      type: 'text',
      sessionID: 'ses_1',
      part: { type: 'text', text: 'oc-probe-ok' },
    });
    process.line({ type: 'step_finish', sessionID: 'ses_1', part: { tokens: { output: 12 } } });
    process.settle(0);
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('run echo');
  const events = await collect(turn.events);
  const result = await turn.completion;

  // One whole text block per hop: there is no delta, and tool output is not
  // visible. This is the non-streaming behaviour the adapter declares.
  assert.deepEqual(
    events.map((event) => event.type),
    ['tool-call', 'message'],
  );
  assert.equal(events[0]?.type === 'tool-call' && events[0].name, 'bash');
  assert.equal(events[0]?.type === 'tool-call' && events[0].detail, 'echo oc-probe-ok');
  assert.deepEqual(events[1], { type: 'message', text: 'oc-probe-ok', final: true });
  assert.deepEqual(result, { status: 'completed', text: 'oc-probe-ok' });

  // The prompt travels on stdin, never argv.
  const args = argv[0] ?? [];
  assert.equal(args[0], 'run', 'the subcommand must be present');
  assert.ok(args.includes('--format') && args.includes('json'));
  assert.ok(args.includes('--auto'), 'headless runs need tools permitted');
  assert.ok(!args.includes('run echo'), 'the prompt is not in argv');
});

test('the engine-assigned session id is captured and reused on the next turn', async () => {
  const { adapter, argv } = adapterFor((process) => {
    process.line({ type: 'text', sessionID: 'ses_abc', part: { type: 'text', text: 'ok' } });
    process.settle(0);
  });

  const session: OpenCodeSession = (await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
  })) as OpenCodeSession;
  await collect(session.run('first').events);
  await collect(session.run('second').events);

  assert.equal(argv.length, 2, 'one process per turn');
  const sessionFlag = (args: readonly string[]) => args[args.indexOf('--session') + 1];
  assert.equal(sessionFlag(argv[1] ?? []), 'ses_abc', 'the second turn resumes it');
});

test('an error frame fails the turn', async () => {
  const { adapter } = adapterFor((process) => {
    process.line({
      type: 'error',
      sessionID: 'ses_1',
      error: { name: 'APIError', data: { message: 'Insufficient balance' } },
    });
    process.settle(1);
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('go');
  await collect(turn.events);
  const result = await turn.completion;

  assert.deepEqual(result, { status: 'failed', message: 'Insufficient balance' });
});

test('a non-zero exit fails the turn through the events stream', async () => {
  // Text is delivered whole, but the engine reporting a non-zero exit means the
  // turn did not succeed, so the events stream throws. That is how the other
  // adapters report failure too, and it is what makes `opencode` consistent.
  const { adapter } = adapterFor((process) => {
    process.line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'partial' } });
    process.settle(1);
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('go');

  await assert.rejects(collect(turn.events), /opencode exited without settling the turn/);
  const result = await turn.completion;
  assert.equal(result.status, 'failed');
});

test('a process that exits zero without any text completes empty rather than hanging', async () => {
  const { adapter } = adapterFor((process) => {
    process.settle(0);
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('go');
  await collect(turn.events);
  const result = await turn.completion;

  assert.deepEqual(result, { status: 'completed', text: '' });
});

test('stopping kills the process and settles the turn', async () => {
  const { adapter, spawned } = adapterFor(() => undefined, { exitCode: 1 });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('long job');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const interrupted = await session.interrupt();
  const result = await turn.completion;

  assert.equal(interrupted, true);
  assert.deepEqual(result, { status: 'interrupted' });
  assert.equal(spawned[0]?.killed, true);
});

test('opencode declares turn-level streaming, not incremental', () => {
  const { adapter } = adapterFor(() => undefined);
  assert.equal(adapter.id, 'opencode');
  // This is the adapter that makes the declared-granularity policy real.
  assert.equal(adapter.capabilities.streaming, 'turn');
  assert.equal(adapter.capabilities.supportsInterrupt, true);
});

test('stderr never contributes session state or an error', async () => {
  // opencode's protocol is stdout-only; a chatty stderr must not be mistaken for
  // a provider error.
  const { adapter } = adapterFor((process) => {
    process.stderr.write('Error: something that looks like a failure\n');
    process.line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'ok' } });
    process.settle(0);
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('go');
  await collect(turn.events);
  const result = await turn.completion;

  assert.deepEqual(result, { status: 'completed', text: 'ok' });
});

test('non-JSON lines on stdout do not fail a healthy turn', () => {
  const state = newOpenCodeTurnState();
  const outcome = mapOpenCodeEvent('not json', state);
  assert.deepEqual(outcome.events, []);
  assert.equal(outcome.ignored, true);
  assert.deepEqual(mapOpenCodeEvent({ no: 'type' }, state).events, []);
});
