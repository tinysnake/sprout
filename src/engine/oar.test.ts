import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OarEngineAdapter, type OarRunnerProcess } from './oar.ts';
import { createOarMcpBridge } from './oar-mcp-bridge.ts';
import { assertSupportedNodeVersion, parseNodeMajor } from './oar-node-support.ts';
import { EngineResumeRefusedError, EngineStartError, type EngineAdapter } from './port.ts';
import type { RunnerCommand, RunnerMessage } from './oar-runner-protocol.ts';
import { WorkerRecoveryJournal } from '../worker/recovery-journal.ts';
import { EnvironmentWorker } from '../worker/server.ts';

class FakeOarRunner implements OarRunnerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly pid = 98765;

  readonly receivedCommands: RunnerCommand[] = [];
  #exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  #errorListeners: ((err: Error) => void)[] = [];
  #buffer = '';

  killHandler?: ((signal?: NodeJS.Signals) => void) | undefined;
  ignoreDispose = false;
  readonly #onCommand: ((command: RunnerCommand, runner: FakeOarRunner) => void) | undefined;

  constructor(
    onCommand?: (command: RunnerCommand, runner: FakeOarRunner) => void,
  ) {
    this.#onCommand = onCommand;
    this.stdin.on('data', (chunk: Buffer) => {
      this.#buffer += chunk.toString('utf8');
      let newline = this.#buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line) {
          const cmd = JSON.parse(line) as RunnerCommand;
          this.receivedCommands.push(cmd);
          if (this.#onCommand) {
            this.#onCommand(cmd, this);
          }
          if (cmd.op === 'dispose' && !this.ignoreDispose) {
            this.send({ kind: 'disposed' });
            this.exit(0);
          }
        }
        newline = this.#buffer.indexOf('\n');
      }
    });
  }

  send(msg: RunnerMessage): void {
    if (this.stdout.writable && !this.stdout.destroyed) {
      this.stdout.write(`${JSON.stringify(msg)}\n`);
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.killHandler) {
      this.killHandler(signal);
      return true;
    }
    this.exit(0, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdin.end();
    this.stdout.end();
    for (const listener of this.#exitListeners) {
      listener(code, signal);
    }
  }

  emitError(err: Error): void {
    for (const listener of this.#errorListeners) {
      listener(err);
    }
  }

  on(event: 'exit' | 'error', listener: (...args: any[]) => void): this {
    if (event === 'exit') {
      this.#exitListeners.push(listener);
    } else if (event === 'error') {
      this.#errorListeners.push(listener);
    }
    return this;
  }
}

test('AC1: Node.js 24+ version enforcement refuses unsupported versions with actionable guidance', () => {
  assert.equal(parseNodeMajor('v26.11.1'), 26);
  assert.equal(parseNodeMajor('24.0.0'), 24);
  assert.equal(parseNodeMajor('23.9.0'), 23);

  // Supported version
  assert.doesNotThrow(() => assertSupportedNodeVersion('24.0.0'));
  assert.doesNotThrow(() => assertSupportedNodeVersion('26.11.1'));

  // Unsupported version refuses work before admission
  assert.throws(
    () => assertSupportedNodeVersion('22.12.0'),
    (err: Error) => {
      return (
        err.message.includes('Node.js 24+ is required by OAR') &&
        err.message.includes('detected Node.js 22.12.0') &&
        err.message.includes('upgrade Node.js to version 24.0.0 or later')
      );
    },
  );
});

test('AC2: OAR adapter maps cwd, instructions, model, effort, and resume correctly', async () => {
  let startedCommand: RunnerCommand | undefined;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      startedCommand = cmd;
      r.send({ kind: 'ready', sessionId: 'sess-123', engineSessionKey: 'native-codex-thread-1' });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    sandbox: 'read-only',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp/project-work',
    projectWorkspacePath: 'src/sub',
    instructions: 'Always use strict typing.',
    model: 'gpt-6.1-sol',
    effort: 'high',
    resumeSessionKey: 'prior-thread-99',
  });

  assert.equal(session.sessionId, 'sess-123');
  assert.equal(session.engineSessionKey, 'native-codex-thread-1');
  assert.ok(startedCommand);
  if (startedCommand.op === 'start') {
    assert.equal(startedCommand.runtimeId, 'codex');
    assert.equal(startedCommand.options.cwd, '/tmp/project-work');
    assert.deepEqual(startedCommand.options.additionalDirectories, ['src/sub']);
    assert.equal(startedCommand.options.appendSystemPrompt, 'Always use strict typing.');
    assert.equal(startedCommand.options.model, 'gpt-6.1-sol');
    assert.equal(startedCommand.options.effort, 'high');
    assert.equal(startedCommand.options.resume, 'prior-thread-99');
    assert.equal(startedCommand.hostPolicy?.sandbox, 'read-only');
  }

  await session.close();
});

test('AC2: Missing working directory is rejected at session start', async () => {
  const adapter = new OarEngineAdapter({ runtimeId: 'codex' });
  await assert.rejects(
    () => adapter.startSession({ agentId: 'scout', workingDirectory: '' }),
    EngineStartError,
  );
});

test('AC2: Resume refusal error is properly classified so core can retry from a fresh session', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'error', message: 'no rollout found for thread id stale-thread-1' });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  await assert.rejects(
    () => adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp', resumeSessionKey: 'stale-thread-1' }),
    (err: Error) => {
      assert.ok(err instanceof EngineResumeRefusedError);
      assert.equal(err.sessionKey, 'stale-thread-1');
      return true;
    },
  );
});

test('AC3 & AC4: Root turn completion persists correct terminal answer and filters commentary/reasoning/child events', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-root', engineSessionKey: 'sess-root' });
    } else if (cmd.op === 'prompt') {
      // 1. Tool call
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_started',
          callId: 'call-1',
          tool: 'read',
          input: '{"path":"file.txt"}',
          sessionId: 'sess-root',
          agentPath: [],
          seq: 1,
          receivedAt: Date.now(),
        },
      });
      // 2. Tool output
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_ended',
          callId: 'call-1',
          content: [{ type: 'text', text: 'file content' }],
          result: 'ok',
          sessionId: 'sess-root',
          agentPath: [],
          seq: 2,
          receivedAt: Date.now(),
        },
      });
      // 3. Private reasoning (MUST BE EXCLUDED)
      r.send({
        kind: 'event',
        event: {
          kind: 'reasoning',
          content: { kind: 'text', text: 'internal secret thoughts' },
          sessionId: 'sess-root',
          agentPath: [],
          seq: 3,
          receivedAt: Date.now(),
        },
      });
      // 4. Subagent / child turn text (agentPath: ['subagent'], MUST BE EXCLUDED from root reply)
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'child subagent commentary',
          sessionId: 'sess-root',
          agentPath: ['subagent'],
          seq: 4,
          receivedAt: Date.now(),
        },
      });
      // 5. Root assistant response text
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'The terminal answer.',
          sessionId: 'sess-root',
          agentPath: [],
          seq: 5,
          receivedAt: Date.now(),
        },
      });
      // 6. Root turn ended
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
        usage: {
          total: { input: 120, output: 40, reasoning: 10, cacheRead: 20, cacheWrite: 0 },
        },
      });
      // 7. Late runner event after turn ended (MUST BE IGNORED)
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'late leaked text',
          sessionId: 'sess-root',
          agentPath: [],
          seq: 6,
          receivedAt: Date.now(),
        },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('Hello');

  const observedEvents: any[] = [];
  for await (const ev of turn.events) {
    observedEvents.push(ev);
  }

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'The terminal answer.');
  assert.equal(result.source, 'oar');

  // Assert events streamed
  assert.deepEqual(observedEvents, [
    { type: 'tool-call', name: 'read', detail: '{"path":"<redacted-host>"}' },
    { type: 'tool-output', text: 'file content' },
    { type: 'message', text: 'The terminal answer.', final: false },
  ]);

  // Assert reasoning and child commentary never leaked into result or events
  assert.ok(!observedEvents.some(e => JSON.stringify(e).includes('internal secret thoughts')));
  assert.ok(!observedEvents.some(e => JSON.stringify(e).includes('child subagent commentary')));
  assert.ok(!observedEvents.some(e => JSON.stringify(e).includes('late leaked text')));
  assert.ok(!result.text.includes('internal secret thoughts'));
  assert.ok(!result.text.includes('child subagent commentary'));
  assert.ok(!result.text.includes('late leaked text'));

  await session.close();
});

test('AC5: Refused / busy prompt fails immediately without implicit queueing', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-busy', engineSessionKey: 'sess-busy' });
    } else if (cmd.op === 'prompt') {
      r.send({ kind: 'prompt_rejected', code: 'busy', reason: 'Session is currently running another turn' });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('Second prompt');

  const result = await turn.completion;
  assert.equal(result.status, 'failed');
  assert.match(result.status === 'failed' ? result.message : '', /OAR prompt rejected \(busy\)/);

  await session.close();
});

test('AC5: Empty successful output settles cleanly without hanging', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-empty', engineSessionKey: 'sess-empty' });
    } else if (cmd.op === 'prompt') {
      // Completed with no text_delta
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('Silent turn');

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '');

  await session.close();
});

test('AC5: Empty error output settles with sanitized failure text', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-err', engineSessionKey: 'sess-err' });
    } else if (cmd.op === 'prompt') {
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'failed', failure: 'provider', reason: '' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('Fail turn');

  const result = await turn.completion;
  assert.equal(result.status, 'failed');
  assert.equal(result.status === 'failed' ? result.message : '', 'OAR turn failed');

  await session.close();
});

test('AC5: Spawn or early-exit failure settles turn without hanging', async () => {
  let currentRunner: FakeOarRunner | undefined;
  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => {
      currentRunner = new FakeOarRunner((cmd, r) => {
        if (cmd.op === 'start') {
          r.send({ kind: 'ready', sessionId: 'sess-crash', engineSessionKey: 'sess-crash' });
        } else if (cmd.op === 'prompt') {
          // Process crashes mid-turn without sending turn_ended
          queueMicrotask(() => {
            r.exit(1);
          });
        }
      });
      return currentRunner;
    },
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('Crash turn');

  const result = await turn.completion;
  assert.equal(result.status, 'failed');
  assert.match(result.status === 'failed' ? result.message : '', /OAR runner connection was lost/);

  await session.close();
});

test('AC6: Bounded abort and close preserve uncertainty and settle turns as interrupted', async () => {
  let abortReceived = false;
  let disposeReceived = false;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-int', engineSessionKey: 'sess-int' });
    } else if (cmd.op === 'prompt') {
      // Running indefinitely
    } else if (cmd.op === 'abort') {
      abortReceived = true;
      r.send({ kind: 'abort_delivered' });
      r.send({ kind: 'turn_ended', outcome: { kind: 'aborted' } });
    } else if (cmd.op === 'dispose') {
      disposeReceived = true;
      r.send({ kind: 'disposed' });
      r.exit(0);
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('Long run');

  const interrupted = await session.interrupt();
  assert.equal(interrupted, true);
  assert.equal(abortReceived, true);

  const result = await turn.completion;
  assert.equal(result.status, 'interrupted');

  await session.close();
  assert.equal(disposeReceived, true);
  assert.equal(runner.exitCode, 0);
});

test('AC5: Multiple events sharing a single record sequence are all processed without deduplication', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-multi-seq', engineSessionKey: 'sess-multi-seq' });
    } else if (cmd.op === 'prompt') {
      // Frame containing multiple readings sharing seq 42
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_ended',
          callId: 'call-1',
          content: [{ type: 'text', text: 'finished tool' }],
          sessionId: 'sess-multi-seq',
          agentPath: [],
          seq: 42,
          receivedAt: 100,
        },
      });
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'shared seq text',
          sessionId: 'sess-multi-seq',
          agentPath: [],
          seq: 42,
          receivedAt: 100,
        },
      });
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('Multi seq test');

  const events: any[] = [];
  for await (const ev of turn.events) {
    events.push(ev);
  }

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'shared seq text');
  assert.deepEqual(events, [
    { type: 'tool-output', text: 'finished tool' },
    { type: 'message', text: 'shared seq text', final: false },
  ]);

  await session.close();
});

test('AC2 & Substrate: Remote workspace tools are exposed over MCP bridge to OAR session', async () => {
  let attachedMcpServers: readonly any[] | undefined;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      attachedMcpServers = cmd.options.mcpServers;
      r.send({ kind: 'ready', sessionId: 'sess-mcp', engineSessionKey: 'sess-mcp' });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    remoteWorkspace: {
      binding: {
        projectId: 'proj-1',
        environmentInstanceId: 'env-1',
        bindingId: 'bind-1',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'ws-1',
      },
      read: async (path) => ({
        operationId: 'op-1',
        projectId: 'proj-1',
        environmentInstanceId: 'env-1',
        bindingId: 'bind-1',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'ws-1',
        operation: 'read',
        status: 'completed',
        content: `file content for ${path}`,
      }),
      search: async () => ({
        operationId: 'op-2',
        projectId: 'proj-1',
        environmentInstanceId: 'env-1',
        bindingId: 'bind-1',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'ws-1',
        operation: 'search',
        status: 'completed',
      }),
      inspect: async () => ({ status: 'completed' }),
      cancel: async () => ({ accepted: true, status: 'cancelled' }),
    },
  });

  assert.ok(attachedMcpServers);
  assert.equal(attachedMcpServers.length, 1);
  assert.equal(attachedMcpServers[0].name, 'sprout_workspace');
  assert.equal(attachedMcpServers[0].type, 'http');
  assert.ok(attachedMcpServers[0].headers?.authorization, 'MCP server must configure authorization header for OAR');

  const authHeaders = {
    'Content-Type': 'application/json',
    authorization: attachedMcpServers[0].headers.authorization,
  };

  try {
    // Query the MCP server over HTTP to prove it functions
    const mcpUrl = attachedMcpServers[0].url;
    const initRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const initJson = await initRes.json() as any;
    assert.equal(initJson.result?.serverInfo?.name, 'sprout_workspace');

    const listRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const listJson = await listRes.json() as any;
    const toolNames = listJson.result?.tools?.map((t: any) => t.name);
    assert.ok(toolNames.includes('read'));

    const callRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: 'hello.txt' } },
      }),
    });
    const callJson = await callRes.json() as any;
    assert.equal(callJson.result?.isError, false);
    assert.ok(callJson.result?.content?.[0]?.text?.includes('file content for hello.txt'));
  } finally {
    await session.close();
  }
});

test('AC7: Usage attribution preserves deltas across multiple turns and redacts sensitive paths/credentials', async () => {
  let turnNumber = 0;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-usage', engineSessionKey: 'sess-usage' });
    } else if (cmd.op === 'prompt') {
      turnNumber++;
      if (turnNumber === 1) {
        r.send({
          kind: 'event',
          event: { kind: 'text_delta', text: 'turn 1 answer', sessionId: 'sess-usage', agentPath: [], seq: 1, receivedAt: Date.now() },
        });
        r.send({
          kind: 'turn_ended',
          outcome: { kind: 'completed' },
          usage: {
            total: { input: 100, output: 20, reasoning: 5, cacheRead: 10, cacheWrite: 0 },
          },
        });
      } else {
        r.send({
          kind: 'event',
          event: { kind: 'text_delta', text: 'turn 2 answer', sessionId: 'sess-usage', agentPath: [], seq: 2, receivedAt: Date.now() },
        });
        // Cumulative totals reported by OAR across the session
        r.send({
          kind: 'turn_ended',
          outcome: { kind: 'completed' },
          usage: {
            total: { input: 250, output: 70, reasoning: 15, cacheRead: 30, cacheWrite: 0 },
          },
        });
      }
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });

  // Turn 1
  const turn1 = session.run('First');
  const result1 = await turn1.completion;
  assert.equal(result1.status, 'completed');
  assert.deepEqual(result1.tokenUsage, { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  assert.deepEqual(result1.detailedTokens, { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cachedInputTokens: 10 });

  // Turn 2: verify delta attribution, not cumulative sum
  const turn2 = session.run('Second');
  const result2 = await turn2.completion;
  assert.equal(result2.status, 'completed');
  assert.deepEqual(result2.tokenUsage, { promptTokens: 150, completionTokens: 50, totalTokens: 200 });
  assert.deepEqual(result2.detailedTokens, { inputTokens: 150, outputTokens: 50, reasoningTokens: 10, cachedInputTokens: 20 });

  await session.close();
});

test('AC4 (F1): Background or stale root turn_ended during admitted prompt neither settles nor contributes text', async () => {
  let promptCmd: any;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-interleave', engineSessionKey: 'sess-interleave' });
    } else if (cmd.op === 'prompt') {
      promptCmd = cmd;
      // 1. Runner accepts the prompt and binds spanId
      r.send({
        kind: 'prompt_accepted',
        activationId: cmd.activationId,
        seq: 1,
        spanId: 'admitted-span-1',
      });
      // 2. Injected interleaving: background root text delta with different spanId
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'stale background text',
          sessionId: 'sess-interleave',
          agentPath: [],
          spanId: 'background-stale-span-99',
          seq: 2,
          receivedAt: Date.now(),
        },
      });
      // 3. Injected interleaving: background root turn_ended with different spanId
      r.send({
        kind: 'turn_ended',
        spanId: 'background-stale-span-99',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('Prompt with background interference');

  // Verify the turn is NOT settled by the background turn_ended
  let settledPrematurely = false;
  turn.completion.then(() => { settledPrematurely = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settledPrematurely, false, 'Admitted turn must not be settled by background root turn_ended');

  // Now emit the real admitted turn events
  runner.send({
    kind: 'event',
    event: {
      kind: 'text_delta',
      text: 'Admitted terminal answer.',
      sessionId: 'sess-interleave',
      agentPath: [],
      spanId: 'admitted-span-1',
      seq: 3,
      receivedAt: Date.now(),
    },
  });
  runner.send({
    kind: 'turn_ended',
    activationId: promptCmd.activationId,
    spanId: 'admitted-span-1',
    outcome: { kind: 'completed' },
  });

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Admitted terminal answer.');
  assert.ok(!result.text.includes('stale background text'), 'Stale text must not be in reply');

  await session.close();
});

test('AC5 (F6): Spawn failure (runner process emits error before ready) rejects startSession and cleans up resources', async () => {
  let killCalled = false;
  const runner = new FakeOarRunner();
  runner.killHandler = () => {
    killCalled = true;
    runner.exit(1);
  };

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => {
      // Runner emits spawn error (e.g. ENOENT / EACCES) before emitting ready
      queueMicrotask(() => {
        runner.emitError(new Error('spawn ENOENT'));
      });
      return runner;
    },
  });

  await assert.rejects(
    () => adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' }),
    (err: Error) => {
      assert.ok(err instanceof EngineStartError);
      assert.match(err.message, /Failed to spawn OAR runner: spawn ENOENT/);
      return true;
    },
  );

  assert.equal(killCalled, true, 'Spawn failure must trigger process cleanup');
});

test('AC6 (F3): Non-cooperative runner failure to exit preserves stop uncertainty and keeps recovery fenced', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-fence-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const journal = new WorkerRecoveryJournal(join(dir, 'journal'), 1);

  // Uncooperative runner that ignores dispose and ignore kill
  const uncooperativeRunner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-uncoop', engineSessionKey: 'sess-uncoop' });
    }
  });
  uncooperativeRunner.ignoreDispose = true;
  // Refuses to exit on kill
  uncooperativeRunner.killHandler = () => {
    // Does NOT call exit()
  };

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => uncooperativeRunner,
  });

  const input = new PassThrough();
  const output = new PassThrough();
  const workerWithIO = new EnvironmentWorker({
    environmentInstanceId: 'inst-1',
    engines: new Map<string, EngineAdapter>([['codex', adapter]]),
    input,
    output,
    recoveryJournal: journal,
  });

  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/start', params: { engine: 'codex', agentId: 'scout', workingDirectory: '/tmp' } })}\n`);
  await new Promise<void>((resolve) => output.once('data', () => resolve()));

  // Worker shutdown with uncooperative runner: close throws, fenced remains false
  await workerWithIO.shutdown();

  // Recovery journal MUST NOT record engineStopped: stop uncertainty is preserved!
  assert.equal(journal.snapshot().engineStopped, false, 'Recovery must remain fenced when process did not exit');
});

test('AC7 (F5): Synthetic absolute paths and credentials in tool input and output are redacted from progress events', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-privacy', engineSessionKey: 'sess-privacy' });
    } else if (cmd.op === 'prompt') {
      // 1. Tool call started containing host absolute path and bearer token
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_started',
          callId: 'call-priv-1',
          tool: 'read',
          input: '{"path":"/Users/user/secret-repo/config.json","token":"Bearer test-secret-token-token-12345"}',
          sessionId: 'sess-privacy',
          agentPath: [],
          seq: 1,
          receivedAt: Date.now(),
        },
      });
      // 2. Tool call ended containing Windows host path and secret auth key
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_ended',
          callId: 'call-priv-1',
          content: [{ type: 'text', text: 'Error in C:\\Users\\user\\project: authorization token=test-auth-key-key-98765 failed' }],
          result: 'failed',
          sessionId: 'sess-privacy',
          agentPath: [],
          seq: 2,
          receivedAt: Date.now(),
        },
      });
      // 3. Root answer
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'Clean final reply.',
          sessionId: 'sess-privacy',
          agentPath: [],
          seq: 3,
          receivedAt: Date.now(),
        },
      });
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('Privacy test prompt');

  const events: any[] = [];
  for await (const ev of turn.events) {
    events.push(ev);
  }

  const result = await turn.completion;
  assert.equal(result.status, 'completed');

  const serializedEvents = JSON.stringify(events);

  // Strengthen F5 (non-blocking suggestion 1): positive presence assertions with redaction markers
  const toolCallEvent = events.find((e) => e.type === 'tool-call');
  assert.ok(toolCallEvent, 'tool-call event must be present on wire');
  assert.match(toolCallEvent.detail, /<redacted-(?:path|credential)>/, 'tool-call detail must contain redaction marker');

  const toolOutputEvent = events.find((e) => e.type === 'tool-output');
  assert.ok(toolOutputEvent, 'tool-output event must be present on wire');
  assert.match(toolOutputEvent.text, /<redacted-(?:path|credential)>/, 'tool-output text must contain redaction marker');

  // Assert absolute paths and credentials are scrubbed from events
  assert.ok(!serializedEvents.includes('/Users/user'), 'POSIX user directory must not cross wire');
  assert.ok(!serializedEvents.includes('C:\\Users\\user'), 'Windows user directory must not cross wire');
  assert.ok(!serializedEvents.includes('test-secret-token-token-12345'), 'Secret key must not cross wire');
  assert.ok(!serializedEvents.includes('test-auth-key-key-98765'), 'Auth token must not cross wire');

  await session.close();
});

test('Authority boundary (F8): MCP bridge authenticates caller, rejects unauthenticated requests, and preserves binding fence', async () => {
  let workspaceReadCalled = false;
  let bindingCurrent = true;

  const bridge = await createOarMcpBridge({
    remoteWorkspace: {
      binding: {
        projectId: 'auth-proj',
        environmentInstanceId: 'auth-env',
        bindingId: 'auth-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'auth-ws',
      },
      bindingFence: {
        generation: 1,
        isCurrent: () => bindingCurrent,
      },
      operations: ['read'],
      read: async () => {
        workspaceReadCalled = true;
        return {
          operationId: 'op-auth-read',
          projectId: 'auth-proj',
          environmentInstanceId: 'auth-env',
          bindingId: 'auth-bind',
          generation: 1,
          connectionEpoch: 1,
          workspaceId: 'auth-ws',
          operation: 'read',
          status: 'completed',
          content: 'SECRET_PROTECTED_DATA',
        };
      },
      search: async () => ({
        operationId: 'op-search',
        projectId: 'auth-proj',
        environmentInstanceId: 'auth-env',
        bindingId: 'auth-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'auth-ws',
        operation: 'search',
        status: 'completed',
      }),
      inspect: async () => ({ status: 'completed' }),
      cancel: async () => ({ accepted: true, status: 'cancelled' }),
    },
  });

  assert.ok(bridge);
  assert.ok(bridge.mcpServer);
  assert.ok('type' in bridge.mcpServer && bridge.mcpServer.type === 'http');
  assert.ok(bridge.mcpServer.headers?.authorization, 'MCP server must configure authorization header for OAR client');

  const mcpUrl = bridge.mcpServer.url;
  const validAuthHeader = bridge.mcpServer.headers.authorization;

  try {
    // 1. Unauthenticated requests MUST return 401 Unauthorized
    const unauthInit = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(unauthInit.status, 401, 'Unauthenticated initialize must return 401');

    const unauthList = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(unauthList.status, 401, 'Unauthenticated tools/list must return 401');
    const unauthListBody = await unauthList.json() as any;
    assert.equal(unauthListBody.error?.message, 'Unauthorized');

    const unauthCall = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: 'file.txt' } },
      }),
    });
    assert.equal(unauthCall.status, 401, 'Unauthenticated tools/call must return 401');
    assert.equal(workspaceReadCalled, false, 'Unauthenticated call must never invoke workspace callback');

    // 2. Request with forged or invalid authorization header MUST return 401
    const invalidAuthCall = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer forged-invalid-token' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: 'file.txt' } },
      }),
    });
    assert.equal(invalidAuthCall.status, 401, 'Forged authorization token must return 401');
    assert.equal(workspaceReadCalled, false, 'Forged call must never invoke workspace callback');

    // 3. Authenticated request with configured OAR credentials MUST succeed
    const authList = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: validAuthHeader },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    });
    assert.equal(authList.status, 200, 'Authenticated tools/list must return 200');
    const authListBody = await authList.json() as any;
    assert.ok(authListBody.result?.tools?.some((t: any) => t.name === 'read'));

    const authCall = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: validAuthHeader },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: 'file.txt' } },
      }),
    });
    assert.equal(authCall.status, 200, 'Authenticated tools/call must return 200');
    const authCallBody = await authCall.json() as any;
    assert.equal(authCallBody.result?.isError, false);
    assert.equal(workspaceReadCalled, true, 'Authenticated call must invoke workspace callback');

    // 4. Stale binding fence MUST reject tool call even with valid authorization
    workspaceReadCalled = false;
    bindingCurrent = false; // Close / invalidate fence

    const staleFenceCall = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: validAuthHeader },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: 'file.txt' } },
      }),
    });
    assert.equal(staleFenceCall.status, 200);
    const staleFenceBody = await staleFenceCall.json() as any;
    assert.equal(staleFenceBody.result?.isError, true, 'Stale fence must return isError: true');
    assert.match(staleFenceBody.result?.content?.[0]?.text ?? '', /no longer available/);
    assert.equal(workspaceReadCalled, false, 'Stale fence must never invoke workspace callback');
  } finally {
    await bridge.close();
  }
});
