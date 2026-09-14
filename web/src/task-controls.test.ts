import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  eligibleTaskAgents,
  taskActivity,
  taskContextState,
  taskControlActions,
  taskFailureMessage,
} from './task-controls.ts';

test('Task presentation distinguishes an active idle Task from an unbegun todo Task', () => {
  assert.equal(taskActivity({}), 'Unbegun');
  assert.equal(taskActivity({ environmentLifecycleState: 'idle' }), 'Task active · Agent idle');
  assert.equal(taskContextState({ environmentLifecycleState: 'idle' }), 'Ready');
});

test('Task presentation offers only Project Agents', () => {
  assert.deepEqual(
    eligibleTaskAgents(
      { memberIds: ['pi-agent', 'codex-agent'] },
      [{ id: 'pi-agent' }, { id: 'outside-agent' }, { id: 'codex-agent' }],
    ).map((agent) => agent.id),
    ['pi-agent', 'codex-agent'],
  );
});

test('Task presentation keeps a stopped run lease-visible and permits corrected advance', () => {
  assert.equal(taskActivity({ environmentLifecycleState: 'blocked' }), 'Task active · Agent idle');
  assert.deepEqual(taskControlActions({ environmentLifecycleState: 'blocked' }), ['advance', 'await-validation', 'end']);
});

test('Task presentation preserves the precise owning-Task begin conflict', () => {
  const conflict = 'environment mac-1 is unavailable: held by task-owner (recovering)';
  assert.equal(taskFailureMessage(conflict), conflict);
  assert.match(taskFailureMessage(conflict), /task-owner.*recovering/);
});

test('Task presentation exposes owning-Task recovery and never offers transfer', () => {
  assert.deepEqual(
    taskControlActions({ environmentLifecycleState: 'recovery', recoveryState: 'running' }),
    ['resume', 'preserve-discard-and-end'],
  );
  assert.equal(taskActivity({ environmentLifecycleState: 'recovery' }), 'Task recovery');
});

test('Task presentation reports cleanup before lease release', () => {
  assert.equal(
    taskContextState({ environmentLifecycleState: 'recovery', recoveryState: 'ending' }),
    'Cleanup needs recovery',
  );
  assert.equal(taskContextState({ environmentLifecycleState: 'ended' }), 'Recycled');
  assert.deepEqual(taskControlActions({ environmentLifecycleState: 'ended' }), []);
});
