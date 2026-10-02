import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentRun } from '../run/model.ts';
import {
  RUN_INTERRUPTION_EVENT_KIND,
  runInterruptionDeliveryKey,
  runInterruptionEventInput,
} from './run-interruption-events.ts';

const humanStoppedRun: AgentRun = {
  id: 'run-chat-1',
  agentId: 'agent-scout',
  prompt: 'PRIVATE_PROMPT',
  environmentInstanceId: 'env-1',
  projectId: 'project-1',
  status: 'interrupted',
  interruptionReason: 'human-stop',
  events: [{ type: 'tool-output', text: 'PRIVATE_ENGINE_OUTPUT' }],
  createdAt: 1,
  completedAt: 2,
};

test('a Human-stopped Chat run projects one private, informational Project event', () => {
  const input = runInterruptionEventInput(humanStoppedRun);

  assert.ok(input);
  assert.equal(input.kind, RUN_INTERRUPTION_EVENT_KIND);
  assert.equal(input.projectId, 'project-1');
  assert.equal(input.summary, 'Agent run interrupted for agent-scout');
  assert.equal(input.detail, 'run run-chat-1 · agent agent-scout · Reason: stopped by Human');
  assert.equal(input.deliveryKey, runInterruptionDeliveryKey('run-chat-1'));
  assert.equal(input.disposition, 'informational');
  assert.deepEqual(input.producer, { id: 'sprout', kind: 'system' });
  assert.equal(input.awaitReply, false);
  assert.doesNotMatch(JSON.stringify(input), /PRIVATE_PROMPT|PRIVATE_ENGINE_OUTPUT/);
});

test('unexpected interruption and failures do not use the Human stop event', () => {
  const { interruptionReason: _reason, ...unexpectedInterruption } = humanStoppedRun;
  const { projectId: _projectId, ...unscopedRun } = humanStoppedRun;
  assert.equal(runInterruptionEventInput(unexpectedInterruption), undefined);
  assert.equal(runInterruptionEventInput({ ...humanStoppedRun, status: 'failed' }), undefined);
  assert.equal(runInterruptionEventInput(unscopedRun), undefined);
});
