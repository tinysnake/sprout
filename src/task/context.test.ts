/**
 * Context-assembly evidence for Task runs (ticket #28).
 *
 * The context is a pure function of the Task and its linked run summaries, so
 * these tests assert it exactly. The property that matters most is the one that
 * keeps token use bounded: the input is the curated *summary*, never a run's raw
 * `events` stream.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTaskContext, renderTaskPrompt } from './context.ts';
import type { Task, TaskRunLink } from './model.ts';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-sprout',
    title: 'Durable Task entity',
    goal: 'Persist multi-run work.',
    constraints: ['Do not commit personal data'],
    status: 'in-progress',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function link(runId: string, sequence: number, summary?: string, status = 'completed'): TaskRunLink {
  return {
    taskId: 'task-1',
    runId,
    agentId: 'agent-scout',
    sequence,
    linkedAt: sequence,
    ...(summary !== undefined
      ? { summary: { runId, agentId: 'agent-scout', status: status as 'completed', summary, recordedAt: sequence } }
      : {}),
  };
}

test('context states the goal and constraints even with no settled runs', () => {
  const context = buildTaskContext(task(), []);
  assert.equal(context.goal, 'Persist multi-run work.');
  assert.deepEqual(context.constraints, ['Do not commit personal data']);
  assert.deepEqual(context.sourceRunIds, []);
  assert.equal(context.text, '');
});

test('context accumulates prior run summaries in work order', () => {
  const context = buildTaskContext(task(), [
    link('run-a', 1, 'Wrote the schema.'),
    link('run-b', 2, 'Added the store tests.'),
  ]);
  assert.deepEqual(context.sourceRunIds, ['run-a', 'run-b']);
  assert.equal(
    context.text,
    [
      '- Run 1 (agent-scout, completed): Wrote the schema.',
      '- Run 2 (agent-scout, completed): Added the store tests.',
    ].join('\n'),
  );
});

test('unsettled runs contribute no summary and no source id', () => {
  const context = buildTaskContext(task(), [link('run-a', 1, 'Done.'), link('run-b', 2)]);
  assert.deepEqual(context.sourceRunIds, ['run-a']);
});

test('the newest prior runs are kept when the run budget is exceeded', () => {
  const runs = [1, 2, 3].map((n) => link(`run-${n}`, n, `Step ${n}.`));
  const context = buildTaskContext(task(), runs, { maxPriorRuns: 2 });
  assert.deepEqual(context.sourceRunIds, ['run-2', 'run-3']);
  assert.equal(
    context.text,
    ['- Run 2 (agent-scout, completed): Step 2.', '- Run 3 (agent-scout, completed): Step 3.'].join('\n'),
  );
});

test('the character budget bounds the assembled text', () => {
  const runs = [
    link('run-1', 1, 'x'.repeat(500)),
    link('run-2', 2, 'y'.repeat(500)),
  ];
  const context = buildTaskContext(task(), runs, { maxCharacters: 600 });
  // Newest-first budget: exactly one line fits, and it is the most recent one.
  assert.deepEqual(context.sourceRunIds, ['run-2']);
  assert.ok(context.text.length <= 600);
});

test('the rendered prompt marks the Task section and keeps prior work distinct from the request', () => {
  const context = buildTaskContext(task(), [link('run-a', 1, 'Did the first step.')]);
  const prompt = renderTaskPrompt(context, 'Do the next step.');
  assert.match(prompt, /## Task\nTitle: Durable Task entity/);
  assert.match(prompt, /Goal: Persist multi-run work\./);
  assert.match(prompt, /- Do not commit personal data/);
  assert.match(prompt, /## Prior work on this Task/);
  assert.match(prompt, /- Run 1 \(agent-scout, completed\): Did the first step\./);
  assert.match(prompt, /## Request\nDo the next step\./);
});

test('a Task with no constraints says so rather than rendering nothing', () => {
  const context = buildTaskContext(task({ constraints: [] }), []);
  assert.match(renderTaskPrompt(context, 'Go.'), /Constraints:\n\(none declared\)/);
  assert.match(renderTaskPrompt(context, 'Go.'), /No prior run has settled for this Task yet\./);
});

test('context never reads a run event stream', () => {
  // A run link carries only a summary by construction; this asserts the assembled
  // text cannot contain anything else even if a caller passes an extra field.
  const withExtra = {
    ...link('run-a', 1, 'Clean summary.'),
    events: [{ type: 'tool-output', text: 'SECRET TOOL OUTPUT' }],
  } as unknown as TaskRunLink;
  const context = buildTaskContext(task(), [withExtra]);
  assert.equal(context.text.includes('SECRET TOOL OUTPUT'), false);
});
