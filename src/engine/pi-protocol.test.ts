import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapPiEvent, newPiTurnState, type PiTurnState } from './pi-protocol.ts';
import type { AgentRunEvent } from './port.ts';

/**
 * The lines below are trimmed copies of real `pi 0.85.1` output captured on this
 * host, so the mapping is checked against what the engine actually emits.
 */
function kinds(events: readonly AgentRunEvent[]): string[] {
  return events.map((event) => event.type);
}

test('assistant text deltas become incremental message events', () => {
  const state = newPiTurnState();
  const first = mapPiEvent(
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'pi-' },
    },
    state,
  );
  const second = mapPiEvent(
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'tool-ok' },
    },
    state,
  );

  assert.deepEqual(first.events, [{ type: 'message', text: 'pi-', final: false }]);
  assert.deepEqual(second.events, [{ type: 'message', text: 'tool-ok', final: false }]);
  assert.equal(state.text, 'pi-tool-ok');
});

test('a tool call is reported from tool_execution_start with its arguments', () => {
  const state = newPiTurnState();
  const outcome = mapPiEvent(
    {
      type: 'tool_execution_start',
      toolCallId: 'call_2888666',
      toolName: 'bash',
      args: { command: 'echo pi-tool-ok' },
    },
    state,
  );

  assert.deepEqual(outcome.events, [
    { type: 'tool-call', name: 'bash', detail: 'echo pi-tool-ok' },
  ]);
});

test('tool output is visible while the tool runs, not only when it ends', () => {
  const state = newPiTurnState();
  const partial = mapPiEvent(
    {
      type: 'tool_execution_update',
      toolCallId: 'call_2888666',
      toolName: 'bash',
      args: { command: 'echo pi-tool-ok' },
      partialResult: { content: [{ type: 'text', text: 'pi-tool-ok\n' }], details: {} },
    },
    state,
  );
  const ended = mapPiEvent(
    {
      type: 'tool_execution_end',
      toolCallId: 'call_2888666',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'pi-tool-ok\n' }] },
      isError: false,
    },
    state,
  );

  assert.deepEqual(partial.events, [{ type: 'tool-output', text: 'pi-tool-ok\n' }]);
  assert.deepEqual(ended.events, [{ type: 'tool-output', text: 'pi-tool-ok\n' }]);
});

test('streaming tool-call deltas are not reported as tool calls', () => {
  // The deltas carry partial JSON; reporting them would duplicate the call that
  // `tool_execution_start` reports completely.
  const state = newPiTurnState();
  const outcome = mapPiEvent(
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{"command":"echo pi-',
      },
    },
    state,
  );
  assert.deepEqual(outcome.events, []);
});

test('a completed assistant message becomes the turn text', () => {
  const state = newPiTurnState();
  mapPiEvent(
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'pi-tool-ok' }],
      },
    },
    state,
  );
  assert.equal(state.finalText, 'pi-tool-ok');
});

test('agent_settled terminates the turn with the final text', () => {
  const state = newPiTurnState();
  mapPiEvent(
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'pi-tool-ok' },
    },
    state,
  );
  mapPiEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'pi-tool-ok' }] } }, state);
  const outcome = mapPiEvent({ type: 'agent_settled' }, state);

  assert.deepEqual(outcome.finish, { status: 'completed', text: 'pi-tool-ok' });
});

test('assistant usage is captured once from a completed message', () => {
  const state = newPiTurnState();
  mapPiEvent(
    {
      type: 'message_update',
      usage: { input: 100, output: 20, totalTokens: 120 },
      assistantMessageEvent: { type: 'text_delta', delta: 'done' },
    },
    state,
  );
  mapPiEvent(
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        usage: { input: 100, output: 20, totalTokens: 120 },
      },
    },
    state,
  );

  assert.deepEqual(mapPiEvent({ type: 'agent_settled' }, state).finish, {
    status: 'completed',
    text: 'done',
    tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  });
});

test('a user message end is not treated as the turn answer', () => {
  const state = newPiTurnState();
  const outcome = mapPiEvent(
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    state,
  );
  assert.deepEqual(outcome.events, []);
  assert.equal(state.finalText, '');
});

test('session and turn framing is ignored rather than guessed at', () => {
  const state = newPiTurnState();
  for (const line of [
    { type: 'session', version: 3, id: 'pi-ref', cwd: '/tmp' },
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'turn_end', message: { role: 'assistant', content: [] } },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'entry_appended', entry: { type: 'custom', customType: 'tps' } },
  ]) {
    const outcome = mapPiEvent(line, state);
    assert.deepEqual(outcome.events, [], `unexpected events for ${String(line.type)}`);
    assert.equal(outcome.finish, undefined);
  }
});

test('a malformed line does not break the mapping', () => {
  const state = newPiTurnState();
  assert.deepEqual(mapPiEvent('not an object', state).events, []);
  assert.deepEqual(mapPiEvent(null, state).events, []);
  assert.deepEqual(mapPiEvent({}, state).events, []);
});

test('an error event fails the turn with its message', () => {
  const state = newPiTurnState();
  const outcome = mapPiEvent({ type: 'error', message: 'model unavailable' }, state);
  assert.deepEqual(outcome.finish, { status: 'failed', message: 'model unavailable' });
});

test('the recorded probe stream maps to tool progress before the final answer', () => {
  const state: PiTurnState = newPiTurnState();
  const stream = [
    { type: 'session', id: 'pi-ref' },
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, toolName: 'bash' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"command":' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolName: 'bash' },
    },
    {
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'echo pi-tool-ok' },
    },
    {
      type: 'tool_execution_end',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'pi-tool-ok\n' }] },
      isError: false,
    },
    {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'pi-tool-ok' }] },
    },
    { type: 'turn_end', message: { role: 'assistant', content: [] } },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled' },
  ];

  const collected: AgentRunEvent[] = [];
  let finish: unknown;
  for (const line of stream) {
    const outcome = mapPiEvent(line, state);
    collected.push(...outcome.events);
    if (outcome.finish) finish = outcome.finish;
  }

  assert.deepEqual(kinds(collected), ['tool-call', 'tool-output']);
  assert.deepEqual(collected[0], {
    type: 'tool-call',
    name: 'bash',
    detail: 'echo pi-tool-ok',
  });
  // Tool progress is visible *before* the turn settles, which is what the M1
  // observability policy requires.
  assert.deepEqual(finish, { status: 'completed', text: 'pi-tool-ok' });
});
