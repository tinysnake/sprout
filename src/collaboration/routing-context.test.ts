/**
 * The bounded routing context builder (#97, ADR-0007).
 *
 * Pure and deterministic: chronological partition with no dropped input,
 * bounded excerpts with an explicit truncation marker, a stable manifest, and
 * a frozen privacy boundary the Human can inspect rather than trust.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  curateOpenTaskFacts,
  DEFAULT_ROUTING_BOUNDS,
  ROUTING_CONTEXT_EXCLUSIONS,
  type RoutingTaskFact,
  type RoutingWindow,
} from './routing.ts';
import {
  freezeRoutingBatches,
  ROUTING_CONTEXT_TASK_CAP,
  truncateRoutingContent,
  type FreezeRoutingBatchesInput,
  type RoutingContextMessage,
  type RoutingInputFact,
} from './routing-context.ts';

const window: RoutingWindow = {
  id: 'win-1',
  projectId: 'project-sprout',
  openedAt: 1_000,
  deadlineAt: 31_000,
  intervalMs: 30_000,
  status: 'open',
  cursor: 'msg-1',
  inputCount: 3,
};

const contract = {
  projectId: 'project-sprout',
  goal: 'Ship Sprout',
  rules: ['Report what you observed.'],
  candidates: [
    { agentId: 'scout', responsibilities: ['Investigate'], collaborationInstructions: 'Ask first.' },
    { agentId: 'forge', responsibilities: ['Build'], collaborationInstructions: '' },
  ],
};

function input(inputId: string, overrides: Partial<RoutingInputFact> = {}): RoutingInputFact {
  return {
    inputId,
    kind: 'message',
    authorId: 'operator',
    createdAt: 1_000,
    scopeId: 'channel-project-sprout',
    content: `body of ${inputId}`,
    candidates: ['scout', 'forge'],
    ...overrides,
  };
}

function freeze(inputs: readonly RoutingInputFact[], overrides: Partial<FreezeRoutingBatchesInput> = {}) {
  let counter = 0;
  return freezeRoutingBatches({
    window,
    inputs,
    contract,
    recentContext: [],
    messageById: () => undefined,
    now: 31_000,
    createBatchId: () => `bat-${(counter += 1)}`,
    ...overrides,
  });
}

test('truncateRoutingContent leaves short content untouched and marks long content explicitly', () => {
  const short = truncateRoutingContent('short body', 100);
  assert.deepEqual(short, { excerpt: 'short body', truncated: false, contentChars: 10 });

  const long = 'x'.repeat(101);
  const truncated = truncateRoutingContent(long, 100);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.contentChars, 101);
  assert.equal(truncated.excerpt.slice(0, 100), 'x'.repeat(100));
  assert.match(truncated.excerpt, /\[truncated: first 100 of 101 characters/);
  assert.match(truncated.excerpt, /the complete content remains durable/);

  // Exactly at the bound is not truncated.
  assert.equal(truncateRoutingContent('x'.repeat(100), 100).truncated, false);
});

test('one bounded window with room freezes into exactly one chronological batch', () => {
  const plans = freeze([input('msg-1'), input('msg-2'), input('msg-3')]);
  assert.equal(plans.length, 1);
  const plan = plans[0]!;
  assert.equal(plan.splitIndex, 0);
  assert.equal(plan.splitCount, 1);
  assert.deepEqual(
    plan.manifest.inputs.map((entry) => entry.inputId),
    ['msg-1', 'msg-2', 'msg-3'],
  );
  assert.deepEqual(
    plan.inputs.map((entry) => entry.position),
    [0, 1, 2],
    'positions are dense and chronological',
  );
  assert.equal(plan.manifest.contextChars, plan.context.length);
  assert.equal(plan.cutoffAt, window.deadlineAt);
});

test('an over-budget window splits chronologically and never drops an input', () => {
  const inputs = Array.from({ length: 8 }, (_, index) =>
    input(`msg-${index + 1}`, { content: `body ${'y'.repeat(120)} ${index + 1}` }),
  );
  const total = 700;
  const plans = freeze(inputs, { bounds: { totalContextChars: total } });
  assert.ok(plans.length > 1, 'the window splits rather than overflowing the bound');

  // The fixed shared prefix (contract, judgement contract, goal, rules,
  // candidates, exclusions) always counts toward the bound; measure it once
  // from a generous freeze so the assertion states the real rule.
  const probe = freeze([input('msg-probe')], { bounds: { totalContextChars: 1_000_000 } });
  const prefixLength = probe[0]!.context.indexOf('\n--- Batch inputs');
  assert.ok(prefixLength > 0, 'the shared prefix renders first');
  const effectiveBound = Math.max(total, prefixLength + 48);

  const covered: string[] = [];
  plans.forEach((plan, splitIndex) => {
    assert.equal(plan.splitIndex, splitIndex, 'splits are indexed in order');
    assert.equal(plan.splitCount, plans.length);
    for (const entry of plan.manifest.inputs) covered.push(entry.inputId);
    // Sections beyond the packed input bytes: the batch header, per-input
    // blank lines, and the closing reminder line — fixed render overhead that
    // is accounted as a bounded constant, not as unbounded growth.
    assert.ok(
      plan.context.length <= effectiveBound + 512,
      `batch context ${plan.context.length} stays within the effective bound ${effectiveBound}`,
    );
  });
  assert.deepEqual(covered, inputs.map((entry) => entry.inputId), 'exactly once, in order');
});

test('the first input of an oversized window is always accepted, even past the bound', () => {
  const huge = input('msg-huge', { content: 'z'.repeat(5_000) });
  const plans = freeze([huge], { bounds: { totalContextChars: 300, inputContentChars: 50 } });
  assert.equal(plans.length, 1, 'one input is always accepted; nothing durable is dropped');
  const entry = plans[0]!.manifest.inputs[0]!;
  assert.equal(entry.truncated, true);
  assert.equal(entry.contentChars, 5_000);
  assert.equal(entry.excerptChars, plans[0]!.inputs[0]!.excerpt.length);
  assert.match(plans[0]!.inputs[0]!.excerpt, /\[truncated: first 50 of 5000 characters/);
});

test('freezing is deterministic: identical facts produce identical plans and context bytes', () => {
  const inputs = [input('msg-1'), input('msg-2'), input('msg-3')];
  const recentContext: RoutingContextMessage[] = [
    { id: 'ctx-1', authorId: 'operator', authorKind: 'human', createdAt: 900, body: 'earlier note' },
  ];
  const first = freeze(inputs, { recentContext });
  const second = freeze(inputs, { recentContext });
  const strip = (plans: ReturnType<typeof freeze>) =>
    plans.map((plan) => ({
      splitIndex: plan.splitIndex,
      inputs: plan.inputs,
      manifest: plan.manifest,
      context: plan.context,
    }));
  assert.deepEqual(strip(first), strip(second), 'only batch ids differ between identical freezes');
});

test('the frozen context carries the project contract, candidates, and privacy boundary', () => {
  const plan = freeze([input('msg-1')]);
  const context = plan[0]!.context;
  assert.match(context, /Ship Sprout/);
  assert.match(context, /Report what you observed\./);
  assert.match(context, /- scout: responsibilities: Investigate \| collaboration instructions: Ask first\./);
  assert.match(context, /- forge: responsibilities: Build/);
  assert.match(context, /Privacy boundary — this context deliberately excludes:/);
  for (const exclusion of ROUTING_CONTEXT_EXCLUSIONS) {
    assert.ok(context.includes(exclusion), `exclusion listed: ${exclusion}`);
  }
  assert.deepEqual(plan[0]!.manifest.exclusions, [...ROUTING_CONTEXT_EXCLUSIONS]);
});

test('manifest candidate sets are the input-local gate the judgement is validated against', () => {
  const plans = freeze([
    input('msg-1', { candidates: ['forge'] }),
    input('msg-2', { candidates: ['scout'] }),
    input('msg-3', { candidates: [] }),
  ]);
  const [one, two, three] = plans[0]!.manifest.inputs;
  assert.deepEqual(one?.candidates, ['forge']);
  assert.deepEqual(two?.candidates, ['scout']);
  assert.deepEqual(three?.candidates, [], 'an input with no eligible candidate still gets a batch');
});

test('thread ancestors are preferred over recent context and batch inputs never repeat as context', () => {
  const ancestors: Record<string, RoutingContextMessage> = {
    'msg-parent': {
      id: 'msg-parent',
      authorId: 'operator',
      authorKind: 'human',
      createdAt: 100,
      body: 'the original question',
    },
  };
  const recentContext: RoutingContextMessage[] = [
    { id: 'ctx-1', authorId: 'operator', authorKind: 'human', createdAt: 500, body: 'ambient chatter' },
  ];
  const plans = freeze([input('msg-1', { inReplyTo: 'msg-parent' })], {
    recentContext: [...recentContext, { ...ancestors['msg-parent']!, id: 'msg-1' }],
    messageById: (id) => ancestors[id],
  });
  const context = plans[0]!.context;
  const ancestorAt = context.indexOf('the original question');
  const recentAt = context.indexOf('ambient chatter');
  assert.ok(ancestorAt >= 0, 'the thread ancestor is included');
  assert.ok(recentAt > ancestorAt, 'ancestors render before recent context');
  assert.ok(!context.includes(`[input 1 | id=msg-parent`), 'an ancestor is never a batch input');
  assert.deepEqual(plans[0]!.manifest.ancestorContextIds, ['msg-parent']);
});

test('recent context is bounded to the configured message count', () => {
  const recent: RoutingContextMessage[] = Array.from({ length: 10 }, (_, index) => ({
    id: `ctx-${index + 1}`,
    authorId: 'operator',
    authorKind: 'human',
    createdAt: index,
    body: `note ${index + 1}`,
  }));
  const plans = freeze([input('msg-1')], { recentContext: recent, bounds: { recentContextMessages: 3 } });
  assert.equal(plans[0]!.manifest.recentContextIds.length, 3, 'the most recent N only');
  assert.deepEqual(plans[0]!.manifest.recentContextIds, ['ctx-8', 'ctx-9', 'ctx-10']);
  assert.ok(!plans[0]!.context.includes('note 7'), 'older context is out of the snapshot');
});

test('default bounds and the exclusion list are the documented ones', () => {
  assert.deepEqual(DEFAULT_ROUTING_BOUNDS, {
    inputContentChars: 4_000,
    contextMessageChars: 1_000,
    recentContextMessages: 12,
    totalContextChars: 48_000,
  });
  assert.ok(ROUTING_CONTEXT_EXCLUSIONS.includes('direct Messages and their replies'));
  assert.ok(ROUTING_CONTEXT_EXCLUSIONS.includes('credentials, tokens, and secrets'));
  assert.ok(ROUTING_CONTEXT_EXCLUSIONS.includes('raw reasoning and thinking traces'));
  assert.ok(ROUTING_CONTEXT_EXCLUSIONS.includes('tool output'));
  assert.ok(ROUTING_CONTEXT_EXCLUSIONS.includes('host identity and private network facts'));
});

test('curated Task facts keep only open lifecycle state, lead, and blocker, deterministically ordered', () => {
  const curated = curateOpenTaskFacts([
    { id: 'task-b', title: 'Second', status: 'blocked', blockerReason: 'Waiting on approval', createdAt: 200 },
    { id: 'task-done', title: 'Finished', status: 'done', createdAt: 50 },
    { id: 'task-failed', title: 'Failed one', status: 'failed', createdAt: 60 },
    { id: 'task-cancelled', title: 'Cancelled', status: 'cancelled', createdAt: 70 },
    {
      id: 'task-a',
      title: 'First',
      status: 'in-progress',
      assignedAgentId: 'scout',
      createdAt: 100,
      // Fields that must never survive curation:
      environmentInstanceId: 'mac-mini-9',
      environmentLeaseId: 'lease-secret',
      activeRunId: 'run-private',
      constraints: ['internal constraint'],
    } as never,
  ]);
  assert.deepEqual(
    curated.map((task) => task.taskId),
    ['task-a', 'task-b'],
    'terminal states are excluded and remaining facts are deterministically ordered',
  );
  assert.equal(curated[0]?.status, 'in-progress');
  assert.equal(curated[0]?.leadAgentId, 'scout');
  assert.equal(curated[1]?.blockerReason, 'Waiting on approval');
  assert.equal('environmentInstanceId' in curated[0]!, false);
  assert.equal('environmentLeaseId' in curated[0]!, false);
  assert.equal('activeRunId' in curated[0]!, false);
  assert.equal('constraints' in curated[0]!, false);
});

test('the frozen context presents curated Task state, capped and bounded', () => {
  const tasks: RoutingTaskFact[] = Array.from({ length: ROUTING_CONTEXT_TASK_CAP + 2 }, (_, index) => ({
    taskId: `task-${index + 1}`,
    title: `Task ${index + 1}`,
    status: index % 2 === 0 ? 'todo' : 'blocked',
    ...(index % 2 === 1 ? { blockerReason: `blocked reason ${index + 1}` } : {}),
    leadAgentId: 'scout',
    createdAt: index + 1,
  }));
  const withTasks = freeze([input('msg-1')], { contract: { ...contract, tasks } });
  const context = withTasks[0]!.context;
  assert.match(context, /Open Tasks \(curated public state, lead, and blocker summary/);
  assert.match(context, /- task task-1 \| todo \| Task 1 \| lead: scout/);
  assert.match(context, /- task task-2 \| blocked \| Task 2 \| lead: scout \| blocker: blocked reason 2/);
  assert.equal(
    context.split('\n').filter((line) => line.startsWith('- task ')).length,
    ROUTING_CONTEXT_TASK_CAP,
    'the Task section is capped',
  );
  assert.equal(withTasks[0]!.manifest.tasks.length, ROUTING_CONTEXT_TASK_CAP);
  assert.ok(!context.includes(`task-${ROUTING_CONTEXT_TASK_CAP + 1}`), 'tasks past the cap are out');

  const withoutTasks = freeze([input('msg-1')]);
  assert.match(withoutTasks[0]!.context, /- \(no open Tasks\)/);
  assert.deepEqual(withoutTasks[0]!.manifest.tasks, []);
});
