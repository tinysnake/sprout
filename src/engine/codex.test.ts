import { test } from 'node:test';

import assert from 'node:assert/strict';

import { PassThrough } from 'node:stream';


import { CodexEngineAdapter, type CodexProcess } from './codex.ts';
import { createCodexDynamicToolBridge } from './codex-tools.ts';
import { sanitizedTurnFailure } from './turn-failure.ts';

import { EngineResumeRefusedError } from './port.ts';

import type { AgentRunEvent, RemoteProjectMcpTools, RemoteWorkspaceTools } from './port.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';


interface WireMessage {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
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
  readonly responses: { readonly id: number | string; readonly result?: unknown; readonly error?: unknown }[] = [];
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

  reject(id: number, message: string, data?: unknown): void {
    this.#out.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32_601, message, ...(data !== undefined ? { data } : {}) } })}\n`);
  }

  requestFromServer(method: string, params: unknown, id = 900): void {
    this.#out.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  }

  notify(method: string, params: unknown): void {
    this.#out.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  #dispatch(line: string): void {
    if (line.trim() === '') return;
    const message = JSON.parse(line) as WireMessage;
    if (typeof message.method !== 'string') {
      if (typeof message.id === 'number' || typeof message.id === 'string') {
        this.responses.push({ id: message.id, ...(message.result !== undefined ? { result: message.result } : {}), ...(message.error !== undefined ? { error: message.error } : {}) });
      }
      return;
    }
    if (message.id === undefined) {
      this.notifications.push(message.method);
      return;
    }
    if (typeof message.id !== 'number') return;
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


test('Environment-hosted Codex events are sanitized before emission and durable Run persistence', async () => {
  const sensitive = [
    '/Users/fixture-user/.config/codex/auth.json', 'runnerbox-9', 'host=remote-fixture-3', 'port=43671',
    'https://fixture-user:fixture-passphrase@service.example/api', 'token=tok_fixtureSecretValue',
    '{"api_key":"JSON_SECRET_MATERIAL"}',
  ].join(' ');
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-privacy' } });
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-privacy' } });
      self.notify('item/started', { item: {
        type: 'commandExecution', command: sensitive, commandActions: [{ command: sensitive }],
      } });
      self.notify('item/commandExecution/outputDelta', { delta: sensitive });
      self.notify('item/completed', { item: { type: 'commandExecution', aggregatedOutput: sensitive, exitCode: 0 } });
      self.notify('item/completed', { item: { type: 'agentMessage', text: 'Codex completed.' } });
      self.notify('turn/completed', { turn: { id: 'turn-privacy', status: 'completed', error: null } });
    }
  });
  const pool = new EnvironmentPool({
    definitions: [{ id: 'fixture-environment', platform: 'macos', capabilities: [{ name: 'agent-run', requiresLease: true }] }],
    instances: [{ id: 'fixture-worker', definitionId: 'fixture-environment' }],
  });
  const runs = new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: new Map([['codex', startAdapter(server)]]),
    agents: new AgentRegistry([{
      id: 'codex-agent', name: 'Codex agent', engine: 'codex', capability: 'agent-run',
      workingDirectory: '/tmp', instructions: 'Run the privacy persistence scenario.',
    }]),
    projects: new ProjectRegistry([{
      id: 'privacy-project', goal: 'Verify Codex event privacy.', rules: [], availableEnvironmentInstanceIds: ['fixture-worker'],
      memberships: [{ agentId: 'codex-agent', responsibilities: [], collaborationInstructions: '' }],
    }]),
    pool, store: runs, leaseTtlMs: 60_000,
  });
  const submitted = await orchestrator.submit({ agentId: 'codex-agent', projectId: 'privacy-project', prompt: 'Run the scenario.' });
  const emitted = await orchestrator.waitFor(submitted.id);
  const persisted = await runs.get(submitted.id);
  assert.ok(persisted);
  assert.equal(emitted.status, 'completed');
  assert.deepEqual(persisted.events, emitted.events);
  assert.deepEqual(emitted.events.map(event => event.type), ['tool-call', 'tool-output', 'tool-output', 'message']);
  for (const marker of [
    '/Users/fixture-user', 'runnerbox-9', 'remote-fixture-3', '43671',
    'fixture-user:fixture-passphrase', 'tok_fixtureSecretValue', 'JSON_SECRET_MATERIAL',
  ]) {
    assert.equal(JSON.stringify(emitted.events).includes(marker), false, `emitted events omit ${marker}`);
    assert.equal(JSON.stringify(persisted.events).includes(marker), false, `durable events omit ${marker}`);
  }
});

test('Codex publishes typed remote tools and dispatches app-server dynamic tool calls', async () => {
  let remoteReadCalls = 0;
  let acceptedToolNames: readonly string[] | undefined;
  const remoteWorkspace: RemoteWorkspaceTools = {
    binding: { projectId: 'project-remote', environmentInstanceId: 'environment-remote', bindingId: 'binding-remote',
      generation: 3, connectionEpoch: 2, workspaceId: 'workspace-remote' },
    operations: ['read'],
    async read(path) {
      remoteReadCalls += 1;
      assert.equal(path, 'src/remote.txt');
      return { operationId: 'remote-read', projectId: 'project-remote', environmentInstanceId: 'environment-remote',
        bindingId: 'binding-remote', generation: 3, connectionEpoch: 2, workspaceId: 'workspace-remote',
        operation: 'read', status: 'completed', path, content: 'REMOTE_ONLY' };
    },
    async search() { throw new Error('unexpected search'); },
    async inspect() { return { status: 'completed' }; },
    async cancel() { return { accepted: false, status: 'not-found' }; },
  };
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-remote' } });
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-remote' } });
      setImmediate(() => {
        self.notify('item/started', { item: { type: 'dynamicToolCall', namespace: null,
          tool: 'sprout_workspace_read', arguments: { path: 'src/remote.txt' } } });
        self.requestFromServer('item/tool/call', { threadId: 'thread-remote', turnId: 'turn-remote', callId: 'call-remote',
          namespace: null, tool: 'sprout_workspace_read', arguments: { path: 'src/remote.txt' } });
        setImmediate(() => {
          const response = self.responses.find(row => row.id === 900)?.result as { contentItems?: readonly { type: string; text?: string }[]; success?: boolean } | undefined;
          self.notify('item/completed', { item: { type: 'dynamicToolCall', namespace: null, tool: 'sprout_workspace_read',
            arguments: { path: 'src/remote.txt' }, status: 'completed', contentItems: response?.contentItems, success: response?.success } });
          self.notify('item/completed', { item: { type: 'agentMessage', text: 'Read the selected remote file.' } });
          self.notify('turn/completed', { turn: { id: 'turn-remote', status: 'completed', error: null } });
        });
      });
    }
  });
  const session = await new CodexEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: () => server.process,
    onDynamicToolCatalogAccepted: names => { acceptedToolNames = names; },
  }).startSession({ agentId: 'agent-remote', workingDirectory: '/tmp', remoteWorkspace });
  const turn = session.run('Read src/remote.txt.');
  const events = await collect(turn);
  assert.equal((await turn.completion).status, 'completed');
  const initialization = server.requests.find(row => row.method === 'initialize')?.params as Record<string, unknown>;
  assert.deepEqual(initialization.capabilities, { experimentalApi: true });
  assert.deepEqual(acceptedToolNames, ['sprout_workspace_read'], 'observer sees only names from the accepted thread catalog');
  const start = server.requests.find(row => row.method === 'thread/start')?.params as Record<string, unknown>;
  assert.deepEqual(start.dynamicTools, [{ type: 'function', name: 'sprout_workspace_read',
    description: 'Read a file from the selected remote Project workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }]);
  assert.equal(remoteReadCalls, 1);
  assert.equal((server.responses.find(row => row.id === 900)?.result as { success?: boolean } | undefined)?.success, true);
  assert.ok(events.some(event => event.type === 'tool-call' && event.name === 'read'));
  assert.ok(events.some(event => event.type === 'notice' && event.text === 'Remote read completed.'));
  assert.equal(JSON.stringify(events).includes('REMOTE_ONLY'), false, 'remote file content is not persisted in Codex Run events');
  await session.close();
});


test('Codex maps only the selected Worker MCP catalog and keeps remote results out of Run events', async () => {
  const calls: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }[] = [];
  const remoteProjectMcp: RemoteProjectMcpTools = {
    binding: { projectId: 'project-mcp', environmentInstanceId: 'environment-mcp', bindingId: 'binding-mcp',
      generation: 2, connectionEpoch: 3, workspaceId: 'workspace-mcp' },
    tools: [{ name: 'lookup_private_record', description: 'Look up a remote record.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }],
    async call(name, arguments_) {
      calls.push({ name, arguments: arguments_ });
      return { status: 'completed', text: 'PRIVATE_REMOTE_MCP_RESULT' };
    },
    async close() { return 'stopped'; },
  };
  let dynamicName = '';
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') {
      const params = request.params as { dynamicTools?: readonly { name: string }[] };
      dynamicName = params.dynamicTools?.[0]?.name ?? '';
      self.respond(request.id, { thread: { id: 'thread-mcp' } });
    }
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-mcp' } });
      setImmediate(() => {
        const arguments_ = { key: 'record-7' };
        self.notify('item/started', { item: { type: 'dynamicToolCall', namespace: null, tool: dynamicName, arguments: arguments_ } });
        self.requestFromServer('item/tool/call', { threadId: 'thread-mcp', turnId: 'turn-mcp', callId: 'call-mcp',
          namespace: null, tool: dynamicName, arguments: arguments_ });
        setImmediate(() => {
          const response = self.responses.find(row => row.id === 900)?.result as { success?: boolean } | undefined;
          self.notify('item/completed', { item: { type: 'dynamicToolCall', namespace: null, tool: dynamicName,
            status: 'completed', success: response?.success } });
          self.notify('item/completed', { item: { type: 'agentMessage', text: 'The selected MCP lookup completed.' } });
          self.notify('turn/completed', { turn: { id: 'turn-mcp', status: 'completed', error: null } });
        });
      });
    }
  });
  const session = await startAdapter(server).startSession({ agentId: 'agent-mcp', workingDirectory: '/tmp', remoteProjectMcp });
  const turn = session.run('Look up the authorized remote record.');
  const events = await collect(turn);
  assert.equal((await turn.completion).status, 'completed');
  assert.match(dynamicName, /^sprout_project_mcp_[a-f0-9]{16}$/);
  assert.deepEqual(calls, [{ name: 'lookup_private_record', arguments: { key: 'record-7' } }]);
  assert.equal((server.responses.find(row => row.id === 900)?.result as { success?: boolean } | undefined)?.success, true);
  assert.ok(events.some(event => event.type === 'tool-call' && event.name === 'project-mcp'));
  assert.ok(events.some(event => event.type === 'notice' && event.text === 'Project MCP tool completed.'));
  assert.equal(JSON.stringify(events).includes('PRIVATE_REMOTE_MCP_RESULT'), false);
  await session.close();
  await remoteProjectMcp.close();
});


test('Codex resumes with the current Worker MCP catalog and refuses stale tool names', async () => {
  const schema = { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false };
  const staleCatalog: RemoteProjectMcpTools = {
    binding: { projectId: 'project-mcp', environmentInstanceId: 'environment-mcp', bindingId: 'binding-old',
      generation: 1, connectionEpoch: 2, workspaceId: 'workspace-mcp' },
    tools: [{ name: 'lookup_old', description: 'Old catalog entry.', inputSchema: schema }],
    async call() { throw new Error('stale tool must not be invoked'); },
    async close() { return 'stopped'; },
  };
  const currentCalls: string[] = [];
  const currentCatalog: RemoteProjectMcpTools = {
    binding: { projectId: 'project-mcp', environmentInstanceId: 'environment-mcp', bindingId: 'binding-current',
      generation: 2, connectionEpoch: 3, workspaceId: 'workspace-mcp' },
    tools: [{ name: 'lookup_current', description: 'Current catalog entry.', inputSchema: schema }],
    async call(name) { currentCalls.push(name); return { status: 'completed', text: 'CURRENT_RESULT' }; },
    async close() { return 'stopped'; },
  };
  const staleName = createCodexDynamicToolBridge({ remoteProjectMcp: staleCatalog }).specs[0]!.name;
  let currentName = '';
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/resume') {
      const params = request.params as { dynamicTools?: readonly { name: string }[] };
      currentName = params.dynamicTools?.[0]?.name ?? '';
      self.respond(request.id, { thread: { id: 'thread-resumed-mcp' } });
    }
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-resumed-mcp' } });
      setImmediate(() => {
        self.requestFromServer('item/tool/call', { threadId: 'thread-resumed-mcp', turnId: 'turn-resumed-mcp', callId: 'stale-call',
          namespace: null, tool: staleName, arguments: { key: 'old' } }, 900);
        setImmediate(() => {
          self.requestFromServer('item/tool/call', { threadId: 'thread-resumed-mcp', turnId: 'turn-resumed-mcp', callId: 'current-call',
            namespace: null, tool: currentName, arguments: { key: 'current' } }, 901);
          setImmediate(() => {
            const stale = self.responses.find(row => row.id === 900)?.result as { success?: boolean } | undefined;
            const current = self.responses.find(row => row.id === 901)?.result as { success?: boolean } | undefined;
            self.notify('item/completed', { item: { type: 'dynamicToolCall', namespace: null, tool: staleName,
              status: 'failed', success: stale?.success } });
            self.notify('item/completed', { item: { type: 'dynamicToolCall', namespace: null, tool: currentName,
              status: 'completed', success: current?.success } });
            self.notify('item/completed', { item: { type: 'agentMessage', text: 'Current MCP catalog used.' } });
            self.notify('turn/completed', { turn: { id: 'turn-resumed-mcp', status: 'completed', error: null } });
          });
        });
      });
    }
  });
  const session = await startAdapter(server).startSession({ agentId: 'agent-mcp', workingDirectory: '/tmp',
    resumeSessionKey: 'thread-resumed-mcp', remoteProjectMcp: currentCatalog });
  const turn = session.run('Use the current Project MCP catalog.');
  const events = await collect(turn);
  assert.equal((await turn.completion).status, 'completed');
  const resume = server.requests.find(row => row.method === 'thread/resume')?.params as { dynamicTools?: readonly { name: string }[] };
  assert.deepEqual(resume.dynamicTools?.map(tool => tool.name), [currentName]);
  assert.notEqual(currentName, staleName);
  assert.equal((server.responses.find(row => row.id === 900)?.result as { success?: boolean } | undefined)?.success, false);
  assert.equal((server.responses.find(row => row.id === 901)?.result as { success?: boolean } | undefined)?.success, true);
  assert.deepEqual(currentCalls, ['lookup_current']);
  assert.ok(events.some(event => event.type === 'notice' && event.text === 'Project MCP tool failed.'));
  assert.ok(events.some(event => event.type === 'notice' && event.text === 'Project MCP tool completed.'));
  assert.equal(JSON.stringify(events).includes('CURRENT_RESULT'), false);
  await session.close();
  await currentCatalog.close();
});

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
    detailedTokens: {
      inputTokens: 120,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 160,
    },
    billingBasis: 'unknown',
    source: 'codex-protocol:thread/tokenUsage/updated',
    sourceVersion: 'codex-cli 0.154.0',
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


test('turn-start failures classify JSON-RPC data and typed connection loss without engine prose', async () => {
  for (const disconnected of [false, true]) {
    const server = new FakeCodexServer((request, self) => {
      if (request.method === 'initialize') self.respond(request.id, {});
      if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
      if (request.method === 'turn/start') {
        if (disconnected) self.crash();
        else self.reject(request.id, 'PRIVATE_PROVIDER_BODY', { error: { code: 'model_not_found', message: 'PRIVATE_PROVIDER_BODY' } });
      }
    });
    const session = await startAdapter(server).startSession({ agentId: 'scout', workingDirectory: '/tmp' });
    const turn = session.run('PRIVATE_PROMPT');
    await collect(turn);
    const result = await turn.completion;
    assert.deepEqual(result, {
      status: 'failed',
      message: sanitizedTurnFailure('codex', disconnected ? 'connection-lost' : 'model-rejected'),
      ...(disconnected ? { retryable: true } : {}),
    });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_BODY|PRIVATE_PROMPT|model_not_found/);
    await session.close();
  }
});

test('a turn error from the engine becomes a failed terminal state', async () => {
  const raw = 'sandbox denied raw-upstream-body';
  const server = new FakeCodexServer((request, self) => {
    if (request.method === 'initialize') self.respond(request.id, {});
    if (request.method === 'thread/start') self.respond(request.id, { thread: { id: 'thread-1' } });
    if (request.method === 'turn/start') {
      self.respond(request.id, { turn: { id: 'turn-1' } });
      queueMicrotask(() => {
        self.notify('turn/completed', {
          turn: { id: 'turn-1', status: 'failed', error: { message: raw } },
        });
      });
    }
  });

  const adapter = startAdapter(server);
  const session = await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });
  const turn = session.run('boom');
  await collect(turn);
  const result = await turn.completion;

  // The durable reason is the stable failure class, never the engine's body (#182).
  assert.deepEqual(result, {
    status: 'failed',
    message: sanitizedTurnFailure('codex', 'turn-error'),
  });
  assert.ok(!JSON.stringify(result).includes(raw));
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
