import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapCodexNotification, type CodexTurnState } from './codex-protocol.ts';

function state(): CodexTurnState {
  return { text: '', finalText: '', failure: undefined };
}

/**
 * The notification payloads below are trimmed copies of real `codex app-server`
 * output recorded while probing `codex-cli 0.154.0`.
 */
test('assistant text deltas become incremental message events', () => {
  const s = state();
  const first = mapCodexNotification(
    { method: 'item/agentMessage/delta', params: { delta: 'PON' } },
    s,
  );
  const second = mapCodexNotification(
    { method: 'item/agentMessage/delta', params: { delta: 'G' } },
    s,
  );

  assert.deepEqual(first.events, [{ type: 'message', text: 'PON', final: false }]);
  assert.deepEqual(second.events, [{ type: 'message', text: 'G', final: false }]);
  assert.equal(s.text, 'PONG');
});

test('a commandExecution item is reported as a tool call while it is still running', () => {
  const s = state();
  const outcome = mapCodexNotification(
    {
      method: 'item/started',
      params: {
        item: {
          type: 'commandExecution',
          id: 'exec-1',
          command: "/bin/zsh -lc 'echo hello-from-tool'",
          status: 'inProgress',
          commandActions: [{ type: 'unknown', command: 'echo hello-from-tool' }],
        },
      },
    },
    s,
  );

  assert.deepEqual(outcome.events, [
    { type: 'tool-call', name: 'shell', detail: 'echo hello-from-tool' },
  ]);
  assert.equal(outcome.finish, undefined, 'the turn is not finished by a tool call');
});

test('command output deltas are surfaced as tool output', () => {
  const s = state();
  const outcome = mapCodexNotification(
    { method: 'item/commandExecution/outputDelta', params: { delta: 'hello\n' } },
    s,
  );
  assert.deepEqual(outcome.events, [{ type: 'tool-output', text: 'hello\n' }]);
});

test('a completed agent message is the final message', () => {
  const s = state();
  const outcome = mapCodexNotification(
    {
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'msg_1', text: 'PONG', phase: 'final_answer' } },
    },
    s,
  );

  assert.deepEqual(outcome.events, [{ type: 'message', text: 'PONG', final: true }]);
  assert.equal(s.finalText, 'PONG');
});

test('turn/completed finishes the turn with the final text', () => {
  const s = state();
  mapCodexNotification(
    { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'PONG' } } },
    s,
  );
  const outcome = mapCodexNotification(
    { method: 'turn/completed', params: { turn: { id: 't1', status: 'completed', error: null } } },
    s,
  );

  assert.deepEqual(outcome.finish, { status: 'completed', text: 'PONG' });
});

test('an interrupted turn finishes as interrupted', () => {
  const s = state();
  const outcome = mapCodexNotification(
    {
      method: 'turn/completed',
      params: { turn: { id: 't1', status: 'interrupted', error: null } },
    },
    s,
  );

  assert.deepEqual(outcome.finish, { status: 'interrupted' });
});

test('a turn error finishes as failed with its message', () => {
  const s = state();
  const outcome = mapCodexNotification(
    {
      method: 'turn/completed',
      params: { turn: { id: 't1', status: 'failed', error: { message: 'sandbox denied' } } },
    },
    s,
  );

  assert.deepEqual(outcome.finish, { status: 'failed', message: 'sandbox denied' });
});

test('a protocol error notification finishes the turn as failed', () => {
  const s = state();
  const outcome = mapCodexNotification({ method: 'error', params: { message: 'bad request' } }, s);
  assert.deepEqual(outcome.finish, { status: 'failed', message: 'bad request' });
});

test('unrelated notifications are ignored rather than guessed at', () => {
  const s = state();
  const outcome = mapCodexNotification(
    { method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { totalTokens: 16_305 } } } },
    s,
  );
  assert.deepEqual(outcome.events, []);
  assert.equal(outcome.finish, undefined);
});

test('the recorded probe stream maps to the expected run events in order', () => {
  const s = state();
  const stream = [
    { method: 'item/agentMessage/delta', params: { delta: 'Running the requested' } },
    { method: 'item/agentMessage/delta', params: { delta: ' shell command now.' } },
    {
      method: 'item/started',
      params: {
        item: {
          type: 'commandExecution',
          command: "/bin/zsh -lc 'echo hello-from-tool'",
          commandActions: [{ command: 'echo hello-from-tool' }],
        },
      },
    },
    { method: 'item/commandExecution/outputDelta', params: { delta: 'hello-from-tool\n' } },
    {
      method: 'item/completed',
      params: { item: { type: 'commandExecution', aggregatedOutput: 'hello-from-tool\n', exitCode: 0 } },
    },
    { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done' } } },
    { method: 'turn/completed', params: { turn: { status: 'completed', error: null } } },
  ] as const;

  const types: string[] = [];
  let finish: unknown;
  for (const notification of stream) {
    const outcome = mapCodexNotification(notification, s);
    types.push(...outcome.events.map((event) => event.type));
    if (outcome.finish) finish = outcome.finish;
  }

  assert.deepEqual(types, [
    'message',
    'message',
    'tool-call',
    'tool-output',
    'tool-output',
    'message',
  ]);
  assert.deepEqual(finish, { status: 'completed', text: 'done' });
});

test('a transient codex error with willRetry does not settle the turn', () => {
  // Found live on Windows: the provider stream dropped and codex emitted
  // an error notification with willRetry: true, then completed the turn on
  // retry. Treating that as terminal would fail runs the engine recovers.
  const state: CodexTurnState = { text: '', finalText: '', failure: undefined };
  const outcome = mapCodexNotification({
    method: 'error',
    params: {
      error: { message: 'Reconnecting... 2/5', willRetry: true },
    },
  }, state);
  assert.deepEqual(outcome.events, []);
  assert.equal(outcome.finish, undefined);

  const done = mapCodexNotification({
    method: 'turn/completed',
    params: { turn: { status: 'completed', items: [{ type: 'agentMessage', text: 'ok' }] } },
  } as never, state);
  assert.equal(done.finish?.status, 'completed');
});
