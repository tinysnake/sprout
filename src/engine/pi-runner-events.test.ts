import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeAssistantContent,
  sanitizeToolArgs,
  sanitizeUsage,
  sessionEventDisposition,
} from './pi-runner-events.ts';

const idle = { settled: false, remoteToolNames: ['remote_read', 'remote_search'] } as const;

test('session framing and unknown events are ignored without throwing', () => {
  const framing = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'turn_end', message: {}, toolResults: [] },
    { type: 'message_start', message: { role: 'user' } },
    { type: 'entry_appended' },
    { type: 'queue_update', steering: [], followUp: [] },
    { type: 'compaction_start' },
    { type: 'compaction_end', result: {} },
    { type: 'thinking_level_changed' },
    { type: 'agent_end', messages: [] },
    { type: 'some_future_event_type' },
    { type: 7 },
    { noType: true },
    'not-an-event',
    null,
    undefined,
    42,
  ];
  for (const event of framing) {
    assert.deepEqual(sessionEventDisposition(event, idle), { action: 'ignore' }, `ignores ${JSON.stringify(event)}`);
    assert.deepEqual(sessionEventDisposition(event, { settled: true, remoteToolNames: [] }), { action: 'ignore' });
  }
});

test('only the authorized remote workspace tools pass the execution gate', () => {
  assert.deepEqual(
    sessionEventDisposition({ type: 'tool_execution_start', toolName: 'remote_read', args: { path: 'sentinel.txt' } }, idle),
    { action: 'pi-event', event: { type: 'tool_execution_start', toolName: 'remote_read', args: { path: 'sentinel.txt' } } },
  );
  // Later phases of an authorized call continue the turn instead of aborting it.
  assert.deepEqual(
    sessionEventDisposition({ type: 'tool_execution_update', toolName: 'remote_search', partialResult: 'x' }, idle),
    { action: 'ignore' },
  );
  assert.deepEqual(
    sessionEventDisposition({ type: 'tool_execution_end', toolName: 'remote_read', result: 'ok', isError: false }, idle),
    { action: 'ignore' },
  );
  for (const event of [
    { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } },
    { type: 'tool_execution_start', toolName: 'write' },
    { type: 'tool_execution_end', toolName: 'bash', result: 'ok', isError: false },
    { type: 'bash_execution_update', partialResult: 'x' },
    { type: 'tool_execution_start' },
  ]) {
    assert.deepEqual(sessionEventDisposition(event, idle), { action: 'violation' }, `gates ${JSON.stringify(event)}`);
  }
  // A session with no remote workspace may not execute any tool.
  assert.deepEqual(
    sessionEventDisposition({ type: 'tool_execution_start', toolName: 'remote_read', args: {} }, { settled: false, remoteToolNames: [] }),
    { action: 'violation' },
  );
});

test('the terminal settle forwards once, and only before it has settled', () => {
  assert.deepEqual(sessionEventDisposition({ type: 'agent_settled' }, idle), { action: 'settle' });
  assert.deepEqual(sessionEventDisposition({ type: 'agent_settled' }, { settled: true, remoteToolNames: idle.remoteToolNames }), { action: 'ignore' });
});

test('assistant streaming maps to allowlisted parent events with sanitized payload', () => {
  assert.deepEqual(
    sessionEventDisposition({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'PONG' } }, idle),
    { action: 'pi-event', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'PONG' } } },
  );
  assert.deepEqual(
    sessionEventDisposition({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', partial: '{}' } }, idle),
    { action: 'ignore' },
  );
  assert.deepEqual(
    sessionEventDisposition({ type: 'message_end', message: { role: 'user', content: 'hi' } }, idle),
    { action: 'ignore' },
  );
  const errored = sessionEventDisposition(
    { type: 'message_end', message: { role: 'assistant', content: '', stopReason: 'error', usage: { input: 'secret' } } },
    idle,
  );
  assert.deepEqual(errored, {
    action: 'pi-event',
    event: { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error' } },
  });
  const completed = sessionEventDisposition(
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'PONG' }, { type: 'image', source: {} }],
        usage: { input: 12, output: 5, totalTokens: 17, cost: { input: 1, bogus: 'x' }, agent: 'internal' },
      },
    },
    idle,
  );
  assert.deepEqual(completed, {
    action: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'PONG' }],
        usage: { input: 12, output: 5, totalTokens: 17, cost: { input: 1 } },
      },
    },
  });
});

test('sanitizers keep only bounded, typed fields', () => {
  assert.deepEqual(sanitizeUsage(undefined), undefined);
  assert.deepEqual(sanitizeUsage({ reasoning: -1, output: 'x' }), undefined);
  assert.deepEqual(sanitizeUsage({ cacheRead: 3, cost: {} }), { cacheRead: 3 });
  assert.deepEqual(sanitizeAssistantContent('text'), [{ type: 'text', text: 'text' }]);
  assert.deepEqual(sanitizeAssistantContent([{ type: 'text' }, { type: 'text', text: 'ok' }]), [{ type: 'text', text: 'ok' }]);
  assert.deepEqual(sanitizeToolArgs(undefined), {});
  assert.deepEqual(sanitizeToolArgs({ path: 'sentinel.txt' }), { path: 'sentinel.txt' });
  assert.deepEqual(sanitizeToolArgs({ blob: 'x'.repeat(4096) }), {});
  assert.deepEqual(sanitizeToolArgs(() => undefined), {});
});
