import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isActiveIntentTaskStatus, isEndedTaskStatus, TASK_STATUSES } from './model.ts';

test('Task status families partition the product status data', () => {
  const active = TASK_STATUSES.filter(isActiveIntentTaskStatus);
  const ended = TASK_STATUSES.filter(isEndedTaskStatus);

  assert.deepEqual(active, ['todo', 'in-progress', 'blocked', 'stopped']);
  assert.deepEqual(ended, ['done', 'failed', 'cancelled']);
  assert.equal(new Set([...active, ...ended]).size, TASK_STATUSES.length);
  assert.equal(active.some(status => ended.includes(status as never)), false);
});
