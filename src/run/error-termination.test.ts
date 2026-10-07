import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';

import { PiEngineAdapter } from '../engine/pi.ts';
import { CodexEngineAdapter, type CodexProcess } from '../engine/codex.ts';
import { sanitizedTurnFailure } from '../engine/turn-failure.ts';
import { runFailureEventInput } from '../collaboration/run-failure-events.ts';
import { sanitizeEngineTurnResult } from '../worker/diagnostics.ts';
import type { EngineAdapter } from '../engine/port.ts';

import { AgentRegistry } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';

import { InMemoryRunStore } from './store.ts';
import { RunOrchestrator } from './orchestrator.ts';

/**
 * Contract: an engine turn that ends in error settles its run as **failed**
 * with a sanitized reason — never as `completed` with empty text (#182).
 *
 * The failure signature this ticket was written from was observed live: an
 * errored Pi turn (`stopReason: "error"` after an upstream 400) settled the
 * run as `status: completed` with `text: ""`, no events, and zero usage, so
 * the operator saw neither a reply nor a failure. These tests pin the
 * settlement contract at the run seam for **both** adapters:
 *
 * - error termination → persisted `status: "failed"` with a failure field that
 *   contains only the stable failure class (engine identity), never the raw
 *   upstream body, prompt, contract, or tool content;
 * - a genuinely successful turn that produced no text still completes.
 *
 * The projected-reply refusal on failed runs is covered by the coordinator's
 * own contract (`a failed run produces no reply` in
 * `src/collaboration/coordinator.test.ts`); this file proves the settlement
 * that refusal keys on is actually durable here.
 */

// Diagnosis F2: the preview Worker had loaded the pre-#182 mapper. Replay the
// content-free shape of its native session failure, not a new startup failure.
test('bad-model zero-usage Pi failure reaches the run-failure projection', async () => {
  const adapter = piAdapter((process) => {
    process.line({ type: 'session', version: 3, id: 'isolated-bad-model' });
    process.line({ type: 'agent_start' });
    process.line({ type: 'turn_start' });
    process.line({
      type: 'message_end',
      message: {
        role: 'assistant', content: [], stopReason: 'error',
        errorMessage: UPSTREAM_BODY,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      },
    });
    process.line({ type: 'turn_end', message: { role: 'assistant', content: [], stopReason: 'error' } });
    process.line({ type: 'agent_end', messages: [], willRetry: false });
    process.line({ type: 'agent_settled' });
    process.kill();
  });
  const { orchestrator, store } = buildFor('pi', adapter, 'agent-bad-model');
  const started = await orchestrator.submit({ agentId: 'agent-bad-model', prompt: PROMPT_MARKER });
  const run = await orchestrator.waitFor(started.id);
  assert.equal(run.status, 'failed', 'errored native session must not persist completed empty zero-usage success');
  assert.equal((await store.get(run.id))?.failureClass, 'execution');
  assert.equal(run.failure, sanitizedTurnFailure('pi', 'error-stop-reason'));
  assert.deepEqual(run.events, []);
  const result = sanitizeEngineTurnResult(run.result!);
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.message, sanitizedTurnFailure('pi', 'error-stop-reason'));
  assert.match(runFailureEventInput({ ...run, result })?.detail ?? '', /the engine ended the turn with an error stop reason/);
  const event = runFailureEventInput(run);
  assert.equal(event?.kind, 'agent-run-failure');
  assert.equal(event?.disposition, 'informational');
  assert.ok(!JSON.stringify(event).includes(UPSTREAM_BODY));
});

test('a configured bogus model reaches a persisted actionable failure through the local Pi harness', async () => {
  const adapter = piAdapter((process) => {
    process.line({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error',
      model: 'ENGINE-MODEL-MUST-NOT-SURFACE',
      errorMessage: '400 {"error":{"code":"model_not_found","message":"UPSTREAM-BODY-DO-NOT-PERSIST"}}',
    } });
    process.kill();
  });
  const { orchestrator, store } = buildFor('pi', adapter, 'agent-configured-model', 'provider/bogus-model');
  const admitted = await orchestrator.submit({ agentId: 'agent-configured-model', prompt: PROMPT_MARKER });
  const run = await orchestrator.waitFor(admitted.id);
  const stored = await store.get(run.id);
  assertSanitizedFailure(run, sanitizedTurnFailure('pi', 'model-rejected'));
  assert.equal(stored?.result?.status, 'failed');
  assert.equal(stored?.workOption?.workModel, 'provider/bogus-model');
  assert.match(runFailureEventInput(stored!)?.detail ?? '', /pi turn failed for model provider\/bogus-model: the engine rejected the model/);
  assert.doesNotMatch(JSON.stringify({ result: stored?.result, failure: stored?.failure }), /ENGINE-MODEL|UPSTREAM-BODY/);
});

const PROMPT_MARKER = 'PROMPT-DO-NOT-PERSIST-8f2a';
const CONTRACT_MARKER = 'CONTRACT-DO-NOT-PERSIST-3b7c';
const UPSTREAM_BODY = '400 Model is unavailable UPSTREAM-BODY-DO-NOT-PERSIST';
const TOOL_MARKER = 'TOOL-OUTPUT-DO-NOT-PERSIST-9d1e';

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [
    { name: 'agent-run', requiresLease: true },
    { name: 'read-only-investigation', requiresLease: false },
  ],
};

const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

function project(agentId: string): Project {
  return {
    id: 'project-sprout',
    goal: 'Ship Sprout',
    rules: [CONTRACT_MARKER],
    availableEnvironmentInstanceIds: ['mac-mini-1'],
    memberships: [
      {
        agentId,
        responsibilities: ['Investigate'],
        collaborationInstructions: 'Keep it short',
      },
    ],
  };
}

function buildFor(engine: string, adapter: EngineAdapter, agentId: string, model?: string) {
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    clock: { now: () => 1_000 },
  });
  const registry = new AgentRegistry([
    {
      id: agentId,
      name: 'Scout',
      engine,
      ...(model !== undefined ? { workOptions: [{ id: 'configured', engine, workModel: model, effort: 'standard' }] } : {}),
      capability: 'agent-run',
      workingDirectory: '/tmp',
      instructions: `You are Scout. ${CONTRACT_MARKER}`,
    },
  ]);
  const store = new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: new Map([[engine, adapter]]),
    agents: registry,
    projects: new ProjectRegistry([project(agentId)]),
    pool,
    store,
    leaseTtlMs: 60_000,
  });
  return { orchestrator, store };
}

/** Assert the persisted failure carries the class and nothing content-bearing. */
function assertSanitizedFailure(
  run: { readonly status: string; readonly failure?: string; readonly result?: unknown },
  expected: string,
): void {
  assert.equal(run.status, 'failed');
  assert.equal(run.failure, expected);
  const recorded = JSON.stringify({ failure: run.failure, result: run.result });
  for (const marker of [UPSTREAM_BODY, PROMPT_MARKER, CONTRACT_MARKER, TOOL_MARKER]) {
    assert.ok(!recorded.includes(marker), `failure field must not carry ${marker}`);
  }
}

/** A fake `pi --mode json` process, replaying recorded engine lines. */
class FakePiProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #exitHandlers: ((code: number | null) => void)[] = [];
  readonly #onRun: (process: FakePiProcess) => void;

  constructor(onRun: (process: FakePiProcess) => void) {
    this.#onRun = onRun;
    queueMicrotask(() => this.#onRun(this));
  }

  line(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(): void {
    this.stdout.end();
    for (const handler of this.#exitHandlers) handler(0);
  }

  onExit(handler: (code: number | null) => void): void {
    this.#exitHandlers.push(handler);
  }

  onSpawnError(_handler: (error: Error) => void): void {}
}

function piAdapter(onRun: (process: FakePiProcess) => void): PiEngineAdapter {
  return new PiEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: () => new FakePiProcess(onRun),
  });
}

/**
 * The observed live failure stream: a tool turn succeeds, then the assistant
 * message ends with `stopReason: "error"` carrying the raw upstream body, and
 * the agent loop settles the turn.
 */
function replayPiErrorTermination(process: FakePiProcess): void {
  process.line({ type: 'session', version: 3, id: 'pi-err', cwd: '/tmp' });
  process.line({ type: 'agent_start' });
  process.line({ type: 'turn_start' });
  process.line({
    type: 'tool_execution_start',
    toolCallId: 'call_err',
    toolName: 'bash',
    args: { command: `echo ${TOOL_MARKER}` },
  });
  process.line({
    type: 'tool_execution_end',
    toolCallId: 'call_err',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: `${TOOL_MARKER}\n` }] },
    isError: false,
  });
  process.line({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }], stopReason: 'toolUse' },
  });
  process.line({ type: 'turn_start' });
  process.line({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: UPSTREAM_BODY,
    },
  });
  process.line({
    type: 'turn_end',
    message: { role: 'assistant', content: [], stopReason: 'error' },
  });
  process.line({ type: 'agent_end', messages: [], willRetry: false });
  process.line({ type: 'agent_settled' });
}

/** A successful Pi turn whose assistant message is legitimately empty. */
function replayPiEmptySuccess(process: FakePiProcess): void {
  process.line({ type: 'session', version: 3, id: 'pi-empty', cwd: '/tmp' });
  process.line({ type: 'agent_start' });
  process.line({ type: 'turn_start' });
  process.line({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } });
  process.line({ type: 'turn_end', message: { role: 'assistant', content: [], stopReason: 'stop' } });
  process.line({ type: 'agent_end', messages: [], willRetry: false });
  process.line({ type: 'agent_settled' });
}

/** A fake `codex app-server` speaking line-framed JSON-RPC over stdio. */
class FakeCodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #onTurnStart: () => void;
  #buffer = '';

  constructor(onTurnStart: () => void) {
    this.#onTurnStart = onTurnStart;
    this.stdin.on('data', (chunk: Buffer | string) => {
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
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      kill: () => {
        this.stdout.end();
        this.stdin.end();
      },
      onExit: (_handler: (code: number | null) => void) => undefined,
      onSpawnError: (_handler: (error: Error) => void) => undefined,
    };
  }

  respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  #dispatch(line: string): void {
    if (line.trim() === '') return;
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (message.id === undefined || typeof message.method !== 'string') return;
    switch (message.method) {
      case 'initialize':
        this.respond(message.id, {});
        return;
      case 'thread/start':
        this.respond(message.id, { thread: { id: 'thread-1' } });
        return;
      case 'turn/start':
        this.respond(message.id, { turn: { id: 'turn-1' } });
        queueMicrotask(() => this.#onTurnStart());
        return;
      default:
        this.respond(message.id, {});
    }
  }
}

function codexAdapter(onTurnStart: (server: FakeCodexProcess) => void): {
  adapter: CodexEngineAdapter;
  server: FakeCodexProcess;
} {
  const server = new FakeCodexProcess(() => onTurnStart(server));
  const adapter = new CodexEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: () => server.process,
  });
  return { adapter, server };
}

test('#182 a Pi turn that ends with an error stop reason settles the run as failed', async () => {
  const { orchestrator, store } = buildFor(
    'pi',
    piAdapter(replayPiErrorTermination),
    'agent-scout-pi',
  );

  const { id } = await orchestrator.submit({
    agentId: 'agent-scout-pi',
    prompt: `do the work ${PROMPT_MARKER}`,
  });
  const run = await orchestrator.waitFor(id);

  assertSanitizedFailure(run, sanitizedTurnFailure('pi', 'error-stop-reason'));
  assert.deepEqual(run.result, {
    status: 'failed',
    message: sanitizedTurnFailure('pi', 'error-stop-reason'),
  });
  assert.equal(run.tokenUsage, undefined, 'an errored turn records no invented usage');
  // The failed row is durable and visible to evidence inspection.
  const stored = await store.get(id);
  assert.equal(stored?.status, 'failed');
  assert.equal(stored?.failure, sanitizedTurnFailure('pi', 'error-stop-reason'));
  // Progress observed before the error stays in the run's event history.
  assert.deepEqual(
    run.events.map((event) => event.type),
    ['tool-call', 'tool-output'],
  );
});

test('#182 a successful Pi turn with no text still completes the run', async () => {
  const { orchestrator, store } = buildFor('pi', piAdapter(replayPiEmptySuccess), 'agent-scout-pi');

  const { id } = await orchestrator.submit({
    agentId: 'agent-scout-pi',
    prompt: `say nothing ${PROMPT_MARKER}`,
  });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal(run.failure, undefined);
  assert.deepEqual(run.result, { status: 'completed', text: '' });
  assert.equal((await store.get(id))?.status, 'completed');
});

test('#182 a Codex turn settled as failed records a failed run with a sanitized reason', async () => {
  const { adapter } = codexAdapter((server) => {
    server.notify('turn/completed', {
      turn: { id: 'turn-1', status: 'failed', error: { message: UPSTREAM_BODY } },
    });
  });
  const { orchestrator, store } = buildFor('codex', adapter, 'agent-scout-codex');

  const { id } = await orchestrator.submit({
    agentId: 'agent-scout-codex',
    prompt: `do the work ${PROMPT_MARKER}`,
  });
  const run = await orchestrator.waitFor(id);

  assertSanitizedFailure(run, sanitizedTurnFailure('codex', 'turn-error'));
  assert.deepEqual(run.result, {
    status: 'failed',
    message: sanitizedTurnFailure('codex', 'turn-error'),
  });
  assert.equal(run.tokenUsage, undefined, 'an errored turn records no invented usage');
  const stored = await store.get(id);
  assert.equal(stored?.status, 'failed');
  assert.equal(stored?.failure, sanitizedTurnFailure('codex', 'turn-error'));
});

test('#182 a successful Codex turn with no message still completes the run', async () => {
  const { adapter } = codexAdapter((server) => {
    server.notify('turn/completed', {
      turn: { id: 'turn-1', status: 'completed', error: null },
    });
  });
  const { orchestrator, store } = buildFor('codex', adapter, 'agent-scout-codex');

  const { id } = await orchestrator.submit({
    agentId: 'agent-scout-codex',
    prompt: `say nothing ${PROMPT_MARKER}`,
  });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal(run.failure, undefined);
  assert.deepEqual(run.result, { status: 'completed', text: '' });
  assert.equal((await store.get(id))?.status, 'completed');
});
