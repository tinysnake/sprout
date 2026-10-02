import assert from 'node:assert/strict';
import test from 'node:test';
import { runFailureReason } from './failure-reason.ts';

test('environment busy failures explain the retained holder without engine copy', () => {
  assert.equal(runFailureReason({ failureClass: 'environment', result: { status: 'failed', message: 'environment busy: env-local is leased by task-example' } }),
    'Environment busy: env-local is leased by task-example.');
  assert.equal(runFailureReason({ failureClass: 'environment', result: { status: 'failed', message: 'environment busy: env-local is in recovery (held by task-example)' } }),
    'Environment busy: env-local is in recovery (held by task-example). Human recovery is required.');
});

test('environment reasons sanitize ids and reject appended or arbitrary diagnostics', () => {
  assert.equal(runFailureReason({ failureClass: 'environment', result: { status: 'failed', message: 'environment busy: /private/work is leased by password=secret' } }),
    'Environment busy: <environment> is leased by <holder>.');
  for (const message of ['environment busy: env-local is leased by task-example\nPRIVATE_BODY', 'PRIVATE_BODY', 'pi turn failed: PRIVATE_BODY']) {
    const reason = runFailureReason({ failureClass: 'environment', result: { status: 'failed', message } });
    assert.match(reason, /^Environment failure/);
    assert.match(reason, /diagnostic withheld/);
    assert.doesNotMatch(reason, /PRIVATE_BODY|Engine failure/);
  }
});

test('engine failures cannot publish environment-shaped engine prose', () => {
  const reason = runFailureReason({ failureClass: 'execution', result: { status: 'failed', message: 'environment busy: env-local is leased by task-example' } });
  assert.match(reason, /^Engine failure/);
  assert.match(reason, /diagnostic withheld/);
  assert.doesNotMatch(reason, /task-example/);
});
