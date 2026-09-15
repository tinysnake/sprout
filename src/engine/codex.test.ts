import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexEngineAdapter, type CodexProcess } from './codex.ts';
import { EngineResumeRefusedError } from './port.ts';
import type { AgentRunEvent } from './port.ts';

interface WireMessage {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
}

type Script = (request: { id: number; method: string; params: unknown }, server: FakeCodexServer) => void;

/**
 * A fake `codex app-server`.
 *
 * Speaks the same line-framed JSON-RPC as the real process so the adapter can be
 * exercised end to end without launching Codex. Payloads mirror recorded
 * `codex-cli 0.154.0` output.
 */
class FakeCodexServer {
  readonly #in = new PassThrough();
  readonly #out = new PassThrough();
  readonly requests: { method: string; params: unknown }[] = [];
  readonly notifications: string[] = [];
  #buffer = '';
  #script: Script;
  #onExit: ((code: number | null) => void) | undefined;

  constructor(script: Script) {
    this.#script = script;
    this.#in.on('data', (chunk: Buffer) => {
      this.#buffer += chunk.toString();
      let newline = this.#buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        this.#dispatch(line);
        newline = this.#buffer.indexOf('\n');
      }
    });
  }

  get process(): CodexProcess {
    return {
      stdin: this.#in,
      stdout: this.#out,
      stderr: new PassThrough(),
      kill: () => {
        this.#out.end();
        this.#in.end();
        this.#onExit?.(0);
      },
      onExit: (handler) => {
        this.#onExit = handler;
      },
      onSpawnError: (_handler) => undefined,
    };
  }

  /** Simulates an unexpected daemon death: the stream ends, not a clean kill. */
  crash(): void {
    this.#out.end();
    this.#in.end();
    this.#onExit?.(1);
  }

  respond(id: number, result: unknown): void {
    this.#out.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  reject(id: number, message: string): void {
    this.#out.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32_601, message } })}\n`);
  }

  notify(method: string, params: unknown): void {
    this.#out.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  #dispatch(line: string): void {
    if (line.trim() === '') return;
    const message = JSON.parse(line) as WireMessage;
    if (typeof message.method !== 'string') return;
    if (message.id === undefined) {
      this.notifications.push(message.method);
      return;
    }
    this.requests.push({ method: message.method, params: message.params });
    this.#script({ id: message.id, method: message.method, params: message.params }, this);
  }
}

function startAdapter(server: FakeCodexServer, binaryPath = '/usr/bin/true') {
  return new CodexEngineAdapter({
    binaryPath,
    spawnProcess: () => server.process,
  });
}

async function collect(turn: { events: AsyncIterable<AgentRunEvent> }): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of turn.events) events.push(event);
  return events;
}

test('the adapter initialises, starts a thread, and launches the app-server transport', async () => {
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
  });

  const adapter = startAdapter(server);
  const session = await adapter.startSession({
    agentId: 'agent-scout',
    workingDirectory: '/tmp',
    model: 'codex-model',
    effort: 'high',
    instructions: 'You are Scout.',
  });

  assert.equal(session.sessionId, 'thread-1');
  assert.equal(session.engineSessionKey, 'thread-1');
  assert.deepEqual(
    server.requests.map((request) => request.method),
    ['initialize', 'thread/start'],
  );
  assert.deepEqual(server.notifications, ['initialized']);
  const start = server.requests[1]?.params as Record<string, unknown>;
  assert.equal(start.cwd, '/tmp');
  assert.equal(start.baseInstructions, 'You are Scout.');
  assert.equal(start.model, 'codex-model');
  assert.deepEqual(start.config, { model_reasoning_effort: 'high' });
  assert.equal(start.sandbox, 'read-only');
});

test('a stored key resumes the thread instead of starting a new one', async () => {
  // Codex assigns thread ids but `thread/resume` keeps the same id (#19), so a
  // stored key resumes the same thread. `thread/start` must not be called: a
  // resumed thread is the whole point of passing the key.
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/resume') self.respond(request.id, { thread: { id: 'thread-9' } });
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-new' } });
  });

  const adapter = startAdapter(server);
  const session = await adapter.startSession({
    agentId: 'agent-scout',
    workingDirectory: '/tmp',
    resumeSessionKey: 'thread-9',
  });

  assert.equal(session.engineSessionKey, 'thread-9');
  assert.deepEqual(
    server.requests.map((request) => request.method),
    ['initialize', 'thread/resume'],
  );
  const resume = server.requests[1]?.params as Record<string, unknown>;
  assert.equal(resume.threadId, 'thread-9');
  assert.equal(resume.cwd, '/tmp');
});

test('thread initialization omits model configuration when the Agent does not configure it', async () => {
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
  });

  await startAdapter(server).startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });

  const start = server.requests[1]?.params as Record<string, unknown>;
  assert.equal('model' in start, false);
  assert.equal('config' in start, false);
});

test('a stale thread id is a hard failure at session start, not a silent fresh session', async () => {
  // Codex documents `no rollout found for thread id …` and does not fall back
  // (#19). Surfacing that at session start is what lets the orchestrator decide
  // to forget the key and retry; swallowing it here would hide the stale key.
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/resume') {
      self.reject(request.id, 'no rollout found for thread id thread-gone');
    }
  });

  const adapter = startAdapter(server);
  await assert.rejects(
    adapter.startSession({
      agentId: 'agent-scout',
      workingDirectory: '/tmp',
      resumeSessionKey: 'thread-gone',
    }),
    /no rollout found for thread id/,
  );
});

test('a refused resume is classified so the core retries only for a real refusal', async () => {
  // SK-001: the core's retry is gated on this neutral classification, not on
  // "any start failure with a stored key". Codex's rejection of `thread/resume`
  // is a refusal; a failed initialization is not.
  const refusing = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/resume') self.reject(request.id, 'no rollout found for thread id gone');
  });
  await assert.rejects(
    startAdapter(refusing).startSession({
      agentId: 'agent-scout',
      workingDirectory: '/tmp',
      resumeSessionKey: 'gone',
    }),
    (error: unknown) => {
      assert.ok(error instanceof EngineResumeRefusedError);
      assert.equal(error.sessionKey, 'gone');
      return true;
    },
  );

  // An initialization failure is not a resume refusal, even when a key was
  // supplied: there was never a chance for the engine to refuse it.
  const failingInit = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.reject(request.id, 'protocol mismatch');
  });
  await assert.rejects(
    startAdapter(failingInit).startSession({
      agentId: 'agent-scout',
      workingDirectory: '/tmp',
      resumeSessionKey: 'gone',
    }),
    (error: unknown) => {
      assert.ok(!(error instanceof EngineResumeRefusedError));
      return true;
    },
  );

  // An authentication failure on the resume request is NOT a stale key: the
  // thread may be perfectly good, so the key must survive for a later attempt.
  const authFailure = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/resume') self.reject(request.id, '401 Unauthorized');
  });
  await assert.rejects(
    startAdapter(authFailure).startSession({
      agentId: 'agent-scout',
      workingDirectory: '/tmp',
      resumeSessionKey: 'thread-good',
    }),
    (error: unknown) => {
      assert.ok(!(error instanceof EngineResumeRefusedError));
      return true;
    },
  );
});

test('a turn streams assistant text, tool calls, and tool output before completing', async () => {
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-1' } });
      queueMicrotask(() => {
        self.notify('item/agentMessage/delta', { delta: 'Running ' });
        self.notify('item/agentMessage/delta', { delta: 'the command.' });
        self.notify('item/started', {
          item: {
            type: 'commandExecution',
            command: "/bin/zsh -lc 'echo hello-from-tool'",
            commandActions: [{ command: 'echo hello-from-tool' }],
          },
        });
        self.notify('item/commandExecution/outputDelta', { delta: 'hello-from-tool\n' });
        self.notify('item/completed', {
          item: { type: 'commandExecution', aggregatedOutput: 'hello-from-tool\n', exitCode: 0 },
        });
        self.notify('item/completed', { item: { type: 'agentMessage', text: 'done' } });
        self.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } });
      });
    }
  });

  const adapter = startAdapter(server);
  const session = await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });
  const turn = session.run('run echo');
  const events = await collect(turn);
  const result = await turn.completion;

  assert.deepEqual(
    events.map((event) => event.type),
    ['message', 'message', 'tool-call', 'tool-output', 'tool-output', 'message'],
  );
  assert.deepEqual(events[2], {
    type: 'tool-call',
    name: 'shell',
    detail: 'echo hello-from-tool',
  });
  assert.deepEqual(result, { status: 'completed', text: 'done' });
});

test('a turn attaches the per-turn Codex token usage notification on completion', async () => {
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-usage' } });
      queueMicrotask(() => {
        self.notify('thread/tokenUsage/updated', {
          threadId: 'thread-1',
          turnId: 'turn-usage',
          tokenUsage: {
            // `total` is cumulative for a resumed thread, whereas `last` is
            // exactly this turn and therefore exactly this AgentRun.
            total: { inputTokens: 999, outputTokens: 99, totalTokens: 1_098 },
            last: {
              inputTokens: 120,
              outputTokens: 30,
              reasoningOutputTokens: 10,
              totalTokens: 160,
            },
          },
        });
        self.notify('turn/completed', {
          turn: { id: 'turn-usage', status: 'completed', error: null },
        });
      });
    }
  });

  const session = await startAdapter(server).startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });
  const turn = session.run('count tokens');
  await collect(turn);

  assert.deepEqual(await turn.completion, {
    status: 'completed',
    text: '',
    tokenUsage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
  });
});

test('interrupting a turn is reported as interrupted, not as a failure', async () => {
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-1' } });
      queueMicrotask(() => {
        self.notify('item/agentMessage/delta', { delta: 'working' });
      });
    }
    if (request.method === 'turn/interrupt') {
      self.respond(request.id, {});
      self.notify('turn/completed', {
        turn: { id: 'turn-1', status: 'interrupted', error: null },
      });
    }
  });

  const adapter = startAdapter(server);
  const session = await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });
  const turn = session.run('long job');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const interrupted = await session.interrupt();
  const result = await turn.completion;

  assert.equal(interrupted, true);
  assert.deepEqual(result, { status: 'interrupted' });
  assert.ok(server.requests.some((request) => request.method === 'turn/interrupt'));
});

test('a turn error from the engine becomes a failed terminal state', async () => {
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-1' } });
      queueMicrotask(() => {
        self.notify('turn/completed', {
          turn: { id: 'turn-1', status: 'failed', error: { message: 'sandbox denied' } },
        });
      });
    }
  });

  const adapter = startAdapter(server);
  const session = await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });
  const turn = session.run('boom');
  await collect(turn);
  const result = await turn.completion;

  assert.deepEqual(result, { status: 'failed', message: 'sandbox denied' });
});

test('a failure to initialise the daemon is reported when the session starts', async () => {
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.reject(request.id, 'protocol mismatch');
  });

  const adapter = startAdapter(server);
  await assert.rejects(
    adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' }),
    /failed to initialise: initialize: protocol mismatch/,
  );
});

test('a server-initiated approval request is declined rather than left hanging', async () => {
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-1' } });
      queueMicrotask(() => {
        self.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } });
      });
    }
  });

  const adapter = startAdapter(server);
  const session = await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });
  const turn = session.run('go');
  await collect(turn);
  await turn.completion;
  await session.close();
  assert.ok(true);
});

test('the binary path is resolved with realpath before launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-codex-'));
  const link = join(dir, 'codex-link');
  symlinkSync('/usr/bin/true', link);

  let launched = '';
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
  });

  const adapter = new CodexEngineAdapter({
    binaryPath: link,
    spawnProcess: (binaryPath) => {
      launched = binaryPath;
      return server.process;
    },
  });
  await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });

  assert.equal(launched, '/usr/bin/true', 'the symlink target is resolved, not the link path');
});

test('a daemon that dies mid-turn fails the turn instead of hanging it', async () => {
  // Regression found in the live UI: with the process gone and no
  // `turn/completed`, the turn never settled, so stopping the run waited forever.
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-1' } });
      // The daemon dies before reporting anything about the turn.
      queueMicrotask(() => {
        self.process.kill('SIGTERM');
        self.crash();
      });
    }
  });

  const adapter = startAdapter(server);
  const session = await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });
  const turn = session.run('go');
  const result = await turn.completion;

  assert.equal(result.status, 'failed');
  assert.match(
    result.status === 'failed' ? result.message : '',
    /codex app-server closed unexpectedly/,
  );
});

test('interrupting settles the turn even when the engine never confirms it', async () => {
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-1' } });
      // Deliberately never sends turn/completed.
    }
    if (request.method === 'turn/interrupt') {
      // Deliberately never answers the interrupt either.
    }
  });

  const adapter = startAdapter(server);
  const session = await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });
  const turn = session.run('long job');
  await new Promise((resolve) => setTimeout(resolve, 10));

  // The engine answers neither the interrupt nor a completion.
  await session.interrupt();
  const result = await turn.completion;

  assert.deepEqual(result, { status: 'interrupted' });
});

test('closing a session settles an in-flight turn as interrupted', async () => {
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-1' } });
    }
  });

  const adapter = startAdapter(server);
  const session = await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });
  const turn = session.run('long job');
  await session.close();

  assert.deepEqual(await turn.completion, { status: 'interrupted' });
});

test('the sandbox posture is configurable, because a container is its own boundary', async () => {
  // A container cannot create the user namespace Codex's sandbox needs, so every
  // turn fails inside one unless Codex's own sandbox is disabled there. The
  // environment decides this, so the adapter must accept it rather than hard-code
  // the shared-host posture.
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
  });

  const adapter = new CodexEngineAdapter({
    binaryPath: '/usr/bin/true',
    sandbox: 'danger-full-access',
    spawnProcess: () => server.process,
  });
  await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/sprout' });

  const start = server.requests.find((request) => request.method === 'thread/start');
  assert.equal((start?.params as Record<string, unknown>).sandbox, 'danger-full-access');
});

test('the default sandbox posture keeps Codex bounded on a shared host', async () => {
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
  });

  const adapter = startAdapter(server);
  await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });

  const start = server.requests.find((request) => request.method === 'thread/start');
  assert.equal((start?.params as Record<string, unknown>).sandbox, 'read-only');
});
