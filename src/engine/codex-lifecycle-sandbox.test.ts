import { test } from 'node:test';

import assert from 'node:assert/strict';

import { PassThrough } from 'node:stream';

import { mkdtempSync, symlinkSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { CodexEngineAdapter, type CodexProcess } from './codex.ts';


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
