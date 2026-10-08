import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapPiEvent, newPiTurnState, type PiTurnState } from './pi-protocol.ts';
import { sanitizedTurnFailure } from './turn-failure.ts';
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

test('a remote tool call is attributable without persisting its arguments', () => {
  const state = newPiTurnState();
  const outcome = mapPiEvent(
    {
      type: 'tool_execution_start',
      toolCallId: 'call_2888666',
      toolName: 'remote_edit',
      args: {
        path: '/srv/synthetic-host/private/sentinel.txt',
        newText: 'api_key=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    },
    state,
  );

  assert.deepEqual(outcome.events, [
    { type: 'tool-call', name: 'remote_edit', detail: 'Remote operation requested.' },
  ]);
  assert.ok(!JSON.stringify(outcome.events).includes('synthetic-host'));
  assert.ok(!JSON.stringify(outcome.events).includes('API_KEY_3okwisn7'));
});

test('remote progress is sanitized before becoming a Run output event', () => {
  const state = newPiTurnState();
  const outcome = mapPiEvent({
    type: 'tool_execution_update',
    toolName: 'remote_command',
    partialResult: { content: [{ type: 'text', text: 'testing files\n/srv/synthetic-host/private/test.log\napi_key=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }], details: {} },
  }, state);

  assert.equal(outcome.events[0]?.type, 'tool-output');
  const text = outcome.events[0]?.type === 'tool-output' ? outcome.events[0].text : '';
  assert.match(text, /testing files/);
  assert.ok(!text.includes('/Users/synthetic-host'));
  assert.ok(!text.includes('API_KEY_3okwisn7'));
});

test('remote terminal statuses are visible independently of the assistant summary', () => {
  const state = newPiTurnState();
  const statuses = ['completed', 'failed', 'cancelled', 'recovery-required'] as const;
  for (const status of statuses) {
    const outcome = mapPiEvent({
      type: 'tool_execution_end',
      toolName: 'remote_command',
      isError: status !== 'completed',
      result: { content: [], details: { operation: 'command', status } },
    }, state);
    assert.deepEqual(outcome.events, [{ type: 'notice', text: `Remote command ${status}.` }]);
  }
});

test('tool execution updates and terminal results are visible', () => {
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

  assert.deepEqual(partial.events, [{ type: 'tool-output', text: 'pi-tool-ok' }]);
  assert.deepEqual(ended.events, [{ type: 'tool-output', text: 'pi-tool-ok' }]);
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
    detailedTokens: {
      inputTokens: 100,
      uncachedInputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 20,
      totalTokens: 120,
    },
    billingBasis: 'unknown',
    source: 'pi-protocol:message_end',
    sourceVersion: 'pi 0.85.1',
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

test('an error event fails the turn with a sanitized reason, never the engine text', () => {
  const state = newPiTurnState();
  const raw = '400 Model is unavailable raw-upstream-body';
  const outcome = mapPiEvent({ type: 'error', message: raw }, state);
  const expected = sanitizedTurnFailure('pi', 'engine-error');
  assert.deepEqual(outcome.finish, { status: 'failed', message: expected });
  assert.equal(state.failure, expected, 'state keeps the class, not the detail');
  assert.ok(!JSON.stringify(outcome).includes(raw));
});

test('an assistant message ending with an error stop reason fails the turn', () => {
  // The observed live failure signature (#182): the engine reports the error
  // as the message's stop reason, with the raw upstream body in `errorMessage`.
  const state = newPiTurnState();
  const raw = '400 Model is unavailable raw-upstream-body';
  const outcome = mapPiEvent(
    {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: raw },
    },
    state,
  );
  const expected = sanitizedTurnFailure('pi', 'error-stop-reason');
  assert.deepEqual(outcome.finish, { status: 'failed', message: expected });
  assert.equal(state.failure, expected);
  assert.ok(!JSON.stringify(outcome).includes(raw));
});

test('a turn_end carrying an error stop reason fails the turn', () => {
  const state = newPiTurnState();
  const outcome = mapPiEvent(
    {
      type: 'turn_end',
      message: { role: 'assistant', content: [], stopReason: 'error' },
    },
    state,
  );
  assert.deepEqual(outcome.finish, {
    status: 'failed',
    message: sanitizedTurnFailure('pi', 'error-stop-reason'),
  });
});

test('an agent_settled after a classified error settles as failed, not completed', () => {
  const state = newPiTurnState();
  mapPiEvent({ type: 'error', message: 'ignored raw detail' }, state);
  const outcome = mapPiEvent({ type: 'agent_settled' }, state);
  assert.deepEqual(outcome.finish, {
    status: 'failed',
    message: sanitizedTurnFailure('pi', 'engine-error'),
  });
});

test('a successful turn that produced no text still completes with empty text', () => {
  // The other half of the #182 contract: a genuinely empty-but-successful
  // turn (no error stop reason) is not reclassified as a failure.
  const state = newPiTurnState();
  mapPiEvent(
    { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } },
    state,
  );
  const outcome = mapPiEvent({ type: 'agent_settled' }, state);
  assert.deepEqual(outcome.finish, { status: 'completed', text: '' });
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
    detail: '',
  });
  // Tool progress is visible *before* the turn settles, which is what the M1
  // observability policy requires.
  assert.deepEqual(finish, { status: 'completed', text: 'pi-tool-ok' });
});
