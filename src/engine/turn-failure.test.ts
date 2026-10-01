import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPiEvent, newPiTurnState } from './pi-protocol.ts';
import { mapCodexNotification } from './codex-protocol.ts';
import { sanitizeEngineTurnResult } from '../worker/diagnostics.ts';
import { runFailureReason } from '../run/failure-reason.ts';
import { runFailureEventInput } from '../collaboration/run-failure-events.ts';
import type { AgentRun } from '../run/model.ts';

// Risk → test: specific machine signals disappear before persistence; only
// authored classifications may survive; model attribution must use run config.
const cases = [
  [{ error: { code: 'model_not_found', message: 'PRIVATE_BODY' } }, 'the engine rejected the model'],
  [{ errorCode: 'invalid_model' }, 'the engine rejected the model'],
  [{ statusCode: 401 }, 'authentication was rejected'],
  [{ error: { status: 403 } }, 'authentication was rejected'],
  [{ error: { code: 'rate_limit_exceeded' } }, 'the engine rate limit was reached'],
  [{ status: 429 }, 'the engine rate limit was reached'],
  [{ cause: { code: 'ETIMEDOUT' } }, 'the engine request timed out'],
  [{ error: { code: 'ECONNRESET' } }, 'the engine connection was lost'],
  [{ error: { code: 'context_length_exceeded' } }, 'the context exceeded the model limit'],
  [{ error: { codexErrorInfo: 'ContextWindowExceeded' } }, 'the context exceeded the model limit'],
  [{ error: { codexErrorInfo: { HttpConnectionFailed: { httpStatusCode: 504 } } } }, 'the engine request timed out'],
  [{ errorMessage: '400 {"error":{"code":"model_not_found","message":"PRIVATE_BODY"}}' }, 'the engine rejected the model'],
] as const;

test('Pi and Codex classify structured error signals before dropping private diagnostics', () => {
  for (const [signal, reason] of cases) {
    for (const type of ['message_end', 'turn_end', 'agent_settled', 'error']) {
      const raw = type === 'message_end' || type === 'turn_end'
        ? { type, message: { role: 'assistant', stopReason: 'error', ...signal } }
        : { type, stopReason: 'error', ...signal };
      const result = mapPiEvent(raw, newPiTurnState()).finish;
      assert.equal(result?.status, 'failed');
      if (result?.status === 'failed') assert.equal(result.message, `pi turn failed: ${reason}`, JSON.stringify(raw));
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY|model_not_found|codexErrorInfo/);
    }
    const result = mapCodexNotification({ method: 'turn/completed', params: { turn: { status: 'failed', error: signal } } }, { text: '', finalText: '', failure: undefined }).finish;
    if (result?.status === 'failed') assert.equal(result.message, `codex turn failed: ${reason}`);
    else assert.fail('Codex must fail');
  }
});

test('Worker classifies signals and never forwards their raw fields or prefix-spoofed prose', () => {
  for (const [signal, reason] of cases) {
    const incoming = { status: 'failed' as const, message: 'PRIVATE_BODY', error: signal };
    const result = sanitizeEngineTurnResult(incoming, 'pi');
    if (result.status === 'failed') assert.equal(result.message, `pi turn failed: ${reason}`);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY|model_not_found|errorMessage|codexErrorInfo/);
  }
  const result = sanitizeEngineTurnResult({ status: 'failed', message: 'pi turn failed: the engine rejected the model PRIVATE_BODY' }, 'pi');
  if (result.status === 'failed') assert.equal(result.message, 'the engine turn failed');
});

test('failure projection renders each authored cause with the configured model and preserves explicit fallbacks', () => {
  for (const [, reason] of cases) {
    const run: AgentRun = { id: 'failed-run', agentId: 'scout', projectId: 'project', status: 'failed', events: [],
      prompt: '', environmentInstanceId: 'isolated', createdAt: 1,
      workOption: { id: 'option', engine: 'pi', workModel: 'provider/bogus-model', effort: 'standard' },
      result: { status: 'failed', message: `pi turn failed: ${reason}` },
    };
    assert.equal(runFailureReason(run), `pi turn failed for model provider/bogus-model: ${reason}`);
    assert.match(runFailureEventInput(run)?.detail ?? '', /provider\/bogus-model/);
  }
  assert.match(runFailureReason({ result: { status: 'failed', message: '', stopReason: 'error' } }), /Engine failure \(stopReason: error\).*No error message was recorded/);
  assert.match(runFailureReason({ result: { status: 'failed', message: 'PRIVATE_BODY' } }), /diagnostic withheld/);
  assert.equal(runFailureReason({}), 'No error outcome was recorded.');
  assert.equal(runFailureReason({ workOption: { id: 'option', engine: 'pi', workModel: 'provider/bogus-model', effort: 'standard' } }),
    'No error outcome was recorded. Configured model: provider/bogus-model.');
});

test('prose alone, generic bad requests, and engine model identities cannot invent a cause or escape projection', () => {
  for (const signal of [
    { errorMessage: '400 Model is unavailable PRIVATE_BODY', model: 'ENGINE_MODEL' },
    { error: { message: 'invalid model PRIVATE_BODY' }, statusCode: 400 },
    { errorMessage: '{"error":{"message":"invalid model PRIVATE_BODY"}}' },
    { content: [{ code: 'model_not_found' }] },
  ]) {
    const result = mapPiEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', ...signal } }, newPiTurnState()).finish;
    if (result?.status === 'failed') assert.equal(result.message, 'pi turn failed: the engine ended the turn with an error stop reason');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY|ENGINE_MODEL/);
  }
  for (const model of ['https://private.invalid/token', '../secret', 'name@example.invalid', 'PRIVATE_BODY\nmore', 'private.invalid', 'synthetic-host-42', ['10', '23', '45', '67'].join('.')]) {
    const reason = runFailureReason({ workOption: { id: 'option', engine: 'pi', workModel: model, effort: 'standard' }, result: { status: 'failed', message: '' } });
    assert.ok(!reason.includes(model));
  }
});
