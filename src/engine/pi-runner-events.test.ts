import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSessionEventProgressState,
  sanitizeAssistantContent,
  sanitizeToolArgs,
  sanitizeUsage,
  sessionEventDisposition,
} from './pi-runner-events.ts';

const idle = { settled: false, remoteToolNames: [
  'remote_read', 'remote_search', 'remote_edit', 'remote_patch', 'remote_command', 'remote_inspect',
] } as const;

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
    sessionEventDisposition({
      type: 'tool_execution_start', toolName: 'remote_read',
      args: { path: '/srv/synthetic-host/private/sentinel.txt' },
    }, idle),
    { action: 'pi-event', event: { type: 'tool_execution_start', toolName: 'remote_read', args: {} } },
  );
  // Progress and terminal outcomes from authorized remote calls reach the parent.
  assert.deepEqual(
    sessionEventDisposition({
      type: 'tool_execution_update', toolName: 'remote_command', toolCallId: 'call-1',
      partialResult: { content: [{ type: 'text', text: 'stdout line\n' }], details: { sequence: 1, stream: 'stdout' } },
    }, { ...idle, progress: createSessionEventProgressState() }),
    {
      action: 'pi-event',
      event: { type: 'tool_execution_update', toolName: 'remote_command',
        partialResult: { content: [{ type: 'text', text: 'stdout line' }], details: {} } },
    },
  );
  assert.deepEqual(
    sessionEventDisposition({
      type: 'tool_execution_end', toolName: 'remote_read', isError: false,
      result: { content: [{ type: 'text', text: 'raw result with path' }], details: {
        status: 'completed', operation: 'read', operationId: 'secret-id', path: '/srv/synthetic-host/private/file',
      } },
    }, idle),
    {
      action: 'pi-event',
      event: { type: 'tool_execution_end', toolName: 'remote_read',
        result: { content: [{ type: 'text', text: 'Remote read completed.' }], details: { operation: 'read', status: 'completed' } },
        isError: false },
    },
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

test('remote command progress is sanitized, de-duplicated, and bounded per turn', () => {
  const progress = createSessionEventProgressState();
  const state = { ...idle, progress };
  const pathSentinel = '/srv/synthetic-host/private/remote-output.txt';
  const credentialSentinel = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const first = sessionEventDisposition({
    type: 'tool_execution_update', toolName: 'remote_command', toolCallId: 'call-bounded',
    partialResult: { content: [{ type: 'text', text: `first line\n${pathSentinel}\n` }], details: { sequence: 1, stream: 'stdout' } },
  }, state);
  assert.equal(first.action, 'pi-event');
  if (first.action === 'pi-event') {
    const serialized = JSON.stringify(first.event);
    assert.ok(!serialized.includes(pathSentinel));
    assert.match(serialized, /first line/);
  }
  const repeated = sessionEventDisposition({
    type: 'tool_execution_update', toolName: 'remote_command', toolCallId: 'call-bounded',
    partialResult: { content: [{ type: 'text', text: `first line\n${pathSentinel}\nsecond ${credentialSentinel}\n` }], details: { sequence: 2, stream: 'stdout' } },
  }, state);
  assert.equal(repeated.action, 'pi-event');
  if (repeated.action === 'pi-event') {
    const serialized = JSON.stringify(repeated.event);
    assert.ok(!serialized.includes(credentialSentinel));
    assert.match(serialized, /second/);
    assert.ok(!serialized.includes('first line'), 'cumulative SDK progress is reduced to its new suffix');
  }
  const oversized = sessionEventDisposition({
    type: 'tool_execution_update', toolName: 'remote_command', toolCallId: 'call-bounded',
    partialResult: { content: [{ type: 'text', text: `first line\n${pathSentinel}\nsecond ${credentialSentinel}\n${'output '.repeat(10_000)}` }], details: {} },
  }, state);
  if (oversized.action === 'pi-event') {
    const output = JSON.stringify(oversized.event);
    assert.ok(Buffer.byteLength(output, 'utf8') <= 2_200);
    assert.ok(!output.includes(pathSentinel));
  }
  for (let index = 0; index < 32 && progress.emittedBytes < 32 * 1024; index += 1) {
    const before = progress.emittedBytes;
    const disposition = sessionEventDisposition({
      type: 'tool_execution_update', toolName: 'remote_command', toolCallId: `budget-${index}`,
      partialResult: { content: [{ type: 'text', text: 'z'.repeat(2_048) }], details: {} },
    }, state);
    assert.equal(disposition.action, 'pi-event');
    assert.ok(progress.emittedBytes > before);
    assert.ok(progress.emittedBytes <= 32 * 1024);
  }
  assert.equal(progress.emittedBytes, 32 * 1024, 'all forwarded command progress stays within the per-turn byte budget');
  assert.deepEqual(sessionEventDisposition({
    type: 'tool_execution_update', toolName: 'remote_command', toolCallId: 'call-bounded',
    partialResult: { content: [{ type: 'text', text: 'later output' }], details: {} },
  }, state), { action: 'ignore' });
});

test('remote operation terminal statuses are retained without result payloads', () => {
  const statuses = ['completed', 'failed', 'cancelled', 'recovery-required'] as const;
  for (const status of statuses) {
    const disposition = sessionEventDisposition({
      type: 'tool_execution_end', toolName: 'remote_edit', isError: status !== 'completed',
      result: { details: { operation: 'edit', status, operationId: 'private-identity', newText: 'secret-value' } },
    }, idle);
    assert.equal(disposition.action, 'pi-event');
    if (disposition.action === 'pi-event') {
      const serialized = JSON.stringify(disposition.event);
      assert.match(serialized, new RegExp(`Remote edit ${status}`));
      assert.ok(!serialized.includes('private-identity'));
      assert.ok(!serialized.includes('secret-value'));
    }
  }
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
  assert.deepEqual(sanitizeToolArgs({
    path: '/srv/synthetic-host/private/sentinel.txt',
    oldText: 'private key sentinel',
    newText: 'api_key=ghp_sentinelCredentialValueThatMustNeverPersist123',
  }), {});
  assert.deepEqual(sanitizeToolArgs({ blob: 'x'.repeat(4096) }), {});
  assert.deepEqual(sanitizeToolArgs(() => undefined), {});
});
