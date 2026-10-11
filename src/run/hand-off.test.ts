import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRun } from './model.ts';
import { buildHandOffContext, previousRun, renderHandOffPrompt, shouldAttachHandOff } from './hand-off.ts';

/**
 * Cross-environment hand-off context (O5, #21).
 *
 * The hand-off is a fixed, deterministic rule over persisted run *results*. It
 * must never read a run's `events` (another agent's raw output/reasoning), and it
 * must be token-restrained. These pin both properties directly.
 */

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    agentId: 'agent-scout',
    prompt: 'do the thing',
    environmentInstanceId: 'mac-mini-1',
    projectId: 'project-sprout',
    status: 'completed',
    events: [],
    result: { status: 'completed', text: 'first result' },
    createdAt: 1_000,
    ...overrides,
  };
}

const identity = {
  agentId: 'agent-scout',
  currentRunId: 'run-current',
  currentCreatedAt: 5_000,
};

test('a hand-off is attached exactly when the environment instance changed', () => {
  assert.equal(
    shouldAttachHandOff({
      previousEnvironmentInstanceId: 'mac-mini-1',
      currentEnvironmentInstanceId: 'container-1',
    }),
    true,
    'a different instance needs the durable facts re-presented',
  );
  assert.equal(
    shouldAttachHandOff({
      previousEnvironmentInstanceId: 'mac-mini-1',
      currentEnvironmentInstanceId: 'mac-mini-1',
    }),
    false,
    'the same instance already carries the context, so nothing is duplicated',
  );
  assert.equal(
    shouldAttachHandOff({
      previousEnvironmentInstanceId: undefined,
      currentEnvironmentInstanceId: 'mac-mini-1',
    }),
    false,
    'no previous run means there is nothing to hand off',
  );
});

test('Host-run hand-offs follow Engine host profile identity instead of Environment identity', () => {
  assert.equal(shouldAttachHandOff({
    previousEnvironmentInstanceId: '', currentEnvironmentInstanceId: '',
    previousExecutionMode: 'host-run', currentExecutionMode: 'host-run',
    previousEngineHostProfileId: 'profile-a', currentEngineHostProfileId: 'profile-a',
  }), false);
  assert.equal(shouldAttachHandOff({
    previousEnvironmentInstanceId: '', currentEnvironmentInstanceId: '',
    previousExecutionMode: 'host-run', currentExecutionMode: 'host-run',
    previousEngineHostProfileId: 'profile-a', currentEngineHostProfileId: 'profile-b',
  }), true);
  assert.equal(shouldAttachHandOff({
    previousEnvironmentInstanceId: 'container-1', currentEnvironmentInstanceId: '',
    previousExecutionMode: 'environment-hosted', currentExecutionMode: 'host-run',
    currentEngineHostProfileId: 'profile-a',
  }), true);

  const handOff = buildHandOffContext([run({
    executionMode: 'host-run', engineHostProfileId: 'profile-a', environmentInstanceId: '',
  })], { ...identity, currentCreatedAt: 2_000 });
  assert.match(handOff?.text ?? '', /Engine host profile profile-a/);
});

test('previousRun picks the agent\'s most recent run, across projects', () => {
  const history: readonly AgentRun[] = [
    run({ id: 'a', createdAt: 1_000, environmentInstanceId: 'mac-mini-1' }),
    run({ id: 'b', createdAt: 3_000, environmentInstanceId: 'container-1' }),
    run({ id: 'c', createdAt: 2_000, environmentInstanceId: 'mac-mini-1' }),
    run({ id: 'other-agent', createdAt: 4_000, agentId: 'agent-other' }),
    // A move between projects is still this agent's previous run: the agent is
    // the identity that persists, and the move loses the engine conversation.
    run({ id: 'other-project', createdAt: 4_500, projectId: 'project-other' }),
  ];

  const previous = previousRun(history, { ...identity, currentCreatedAt: 5_000 });
  assert.equal(previous?.id, 'other-project', 'newest run of this agent before the current one');
});

test('a standalone binding transition is a Sprout fact and prior results keep their source binding', () => {
  const previous = run({
    id: 'binding-a',
    environmentInstanceId: 'environment-a',
    workspaceBinding: {
      environmentInstanceId: 'environment-a', bindingId: 'binding-a', generation: 4,
      workspaceId: 'workspace-a', kind: 'relative', path: 'repos/a', operations: ['read'],
    },
    result: { status: 'completed', text: 'Changed the parser.' },
  });
  const currentBinding = {
    environmentInstanceId: 'environment-b', bindingId: 'binding-b', generation: 2,
    workspaceId: 'workspace-b', kind: 'relative' as const, path: 'repos/b', operations: ['read', 'edit'] as const,
  };
  const handOff = buildHandOffContext([previous], {
    ...identity,
    currentCreatedAt: 2_000,
    projectId: 'project-sprout',
    currentEnvironmentInstanceId: 'environment-b',
    currentWorkspaceBinding: currentBinding,
  });

  assert.ok(handOff);
  assert.equal(handOff.bindingChange,
    'Sprout switched the current Work Environment from environment-a to environment-b.');
  assert.match(handOff.text, /environment-a, relative workspace at binding generation 4: Changed the parser/);
  assert.deepEqual(handOff.previousWorkspaceBinding, previous.workspaceBinding);
  assert.equal(shouldAttachHandOff({
    previousEnvironmentInstanceId: handOff.previousEnvironmentInstanceId,
    currentEnvironmentInstanceId: 'environment-b',
    previousWorkspaceBinding: handOff.previousWorkspaceBinding,
    currentWorkspaceBinding: currentBinding,
  }), true);
  const prompt = renderHandOffPrompt(handOff, 'Continue the work.');
  assert.match(prompt, /Sprout switched the current Work Environment from environment-a to environment-b/);
  assert.match(prompt, /## Task\nContinue the work\./);
});

test('a changed tool catalog gets a Sprout-produced change fact even when the workspace grant is stable', () => {
  const previous = run({
    id: 'catalog-before', environmentInstanceId: 'environment-a',
    workspaceBinding: {
      environmentInstanceId: 'environment-a', bindingId: 'binding-a', generation: 3,
      workspaceId: 'workspace-a', kind: 'default', operations: ['read', 'search'],
      projectMcpTools: ['lookup'], catalogIdentity: 'a'.repeat(64),
    },
  });
  const currentWorkspaceBinding = {
    environmentInstanceId: 'environment-a', bindingId: 'binding-a', generation: 3,
    workspaceId: 'workspace-a', kind: 'default' as const, operations: ['read'] as const,
    projectMcpTools: ['lookup', 'inspect'] as const, catalogIdentity: 'b'.repeat(64),
  };
  const handOff = buildHandOffContext([previous], {
    ...identity, currentCreatedAt: 2_000, projectId: 'project-sprout',
    currentEnvironmentInstanceId: 'environment-a', currentWorkspaceBinding,
  });
  assert.equal(handOff?.bindingChange,
    'Sprout refreshed the current tool catalog. Available operations: workspace operations read; Project MCP tools lookup, inspect.');
  assert.equal(shouldAttachHandOff({
    previousEnvironmentInstanceId: 'environment-a', currentEnvironmentInstanceId: 'environment-a',
    previousWorkspaceBinding: previous.workspaceBinding, currentWorkspaceBinding,
  }), true);
});

test('a project scoped hand-off ignores results from another Project', () => {
  const history = [
    run({ id: 'same-project', createdAt: 1_000, result: { status: 'completed', text: 'same project fact' } }),
    run({ id: 'other-project', projectId: 'project-other', createdAt: 1_500,
      result: { status: 'completed', text: 'cross project secret' } }),
  ];
  const handOff = buildHandOffContext(history, {
    ...identity, currentCreatedAt: 2_000, projectId: 'project-sprout',
    currentEnvironmentInstanceId: 'container-1',
  });
  assert.match(handOff?.text ?? '', /same project fact/);
  assert.doesNotMatch(handOff?.text ?? '', /cross project secret/);
  assert.deepEqual(handOff?.sourceRunIds, ['same-project']);
});

test('the summary states facts from results and never reads a run\'s events', () => {
  const history: readonly AgentRun[] = [
    run({
      id: 'prior',
      createdAt: 1_000,
      environmentInstanceId: 'mac-mini-1',
      status: 'completed',
      result: { status: 'completed', text: 'built the parser and ran the tests' },
      // Events carry another agent's raw reasoning and tool output. If the rule
      // ever read them, these strings would appear in the hand-off.
      events: [
        { type: 'tool-output', text: 'SECRET_TOOL_OUTPUT_do_not_leak' },
        { type: 'message', text: 'SECRET_REASONING_do_not_leak', final: true },
      ],
    }),
  ];

  const handOff = buildHandOffContext(history, identity);
  assert.ok(handOff);
  assert.match(handOff.text, /built the parser and ran the tests/);
  assert.doesNotMatch(handOff.text, /SECRET_TOOL_OUTPUT_do_not_leak/);
  assert.doesNotMatch(handOff.text, /SECRET_REASONING_do_not_leak/);
  assert.doesNotMatch(handOff.text, /tool-output|tool-call|reasoning/);
  assert.deepEqual(handOff.sourceRunIds, ['prior']);
});

test('a failed prior run is summarised as a fact, not as its transcript', () => {
  const history: readonly AgentRun[] = [
    run({
      id: 'prior',
      environmentInstanceId: 'container-1',
      status: 'failed',
      result: { status: 'failed', message: 'compile error in module foo' },
      events: [{ type: 'tool-output', text: 'VERBATIM_TRANSCRIPT_DO_NOT_LEAK' }],
    }),
  ];

  const handOff = buildHandOffContext(history, identity);
  assert.ok(handOff);
  assert.equal(handOff.previousEnvironmentInstanceId, 'container-1');
  assert.match(handOff.text, /Failed in container-1: compile error in module foo/);
  assert.doesNotMatch(handOff.text, /VERBATIM_TRANSCRIPT_DO_NOT_LEAK/);
});

test('the summary is deterministic: identical history produces identical text', () => {
  const history: readonly AgentRun[] = [
    run({ id: 'a', createdAt: 1_000, result: { status: 'completed', text: 'one' } }),
    run({ id: 'b', createdAt: 2_000, result: { status: 'completed', text: 'two' } }),
    run({ id: 'c', createdAt: 3_000, result: { status: 'completed', text: 'three' } }),
  ];

  const first = buildHandOffContext(history, identity);
  const second = buildHandOffContext([...history].reverse(), identity);
  assert.ok(first && second);
  assert.equal(first.text, second.text, 'store iteration order must not change the hand-off');
  assert.deepEqual(first.sourceRunIds, second.sourceRunIds);
});

test('the summary is token-restrained in both entry count and characters', () => {
  const history: readonly AgentRun[] = Array.from({ length: 20 }, (_value, index) =>
    run({
      id: `prior-${String(index)}`,
      createdAt: 1_000 + index,
      result: { status: 'completed', text: `result number ${String(index)}` },
    }),
  );

  const fewRuns = buildHandOffContext(history, identity, { maxRuns: 2 });
  assert.ok(fewRuns);
  assert.equal(fewRuns.sourceRunIds.length, 2, 'at most maxRuns entries are summarised');

  const small = buildHandOffContext(history, identity, { maxRuns: 20, maxCharacters: 60 });
  assert.ok(small);
  assert.ok(small.text.length <= 60, `summary is bounded, got ${String(small.text.length)} chars`);

  // Already bounded by default, so an unbounded history cannot blow the budget.
  const byDefault = buildHandOffContext(history, identity);
  assert.ok(byDefault);
  assert.ok(byDefault.text.length <= 1_200);
});

test('a single very long result is bounded, so one run cannot dominate', () => {
  const history: readonly AgentRun[] = [
    run({
      id: 'prior',
      result: { status: 'completed', text: 'x'.repeat(10_000) },
    }),
  ];

  const handOff = buildHandOffContext(history, identity, { maxCharacters: 5_000 });
  assert.ok(handOff);
  // The per-entry bound caps one verbose result to a few hundred characters,
  // well under the 10,000 it actually produced. The small remainder is the
  // fact-line prefix ("- Completed in …").
  assert.ok(
    handOff.text.length <= 500,
    `a single result is bounded, got ${String(handOff.text.length)} chars`,
  );
  assert.match(handOff.text, /…$/);
});

test('a prior run with no terminal result still reports the environment move', () => {
  const history: readonly AgentRun[] = [
    run({
      id: 'prior',
      environmentInstanceId: 'mac-mini-1',
      status: 'interrupted',
      result: { status: 'interrupted' },
      events: [{ type: 'notice', text: 'IRRELEVANT' }],
    }),
  ];

  const handOff = buildHandOffContext(history, identity);
  assert.ok(handOff);
  assert.equal(handOff.previousEnvironmentInstanceId, 'mac-mini-1');
  assert.match(handOff.text, /Interrupted in mac-mini-1/);
});

test('intentional stop is distinct from unexpected interruption in later hand-off context', () => {
  const history: readonly AgentRun[] = [run({
    id: 'prior', status: 'stopped', result: { status: 'interrupted' },
  })];
  const handOff = buildHandOffContext(history, identity);
  assert.ok(handOff);
  assert.match(handOff.text, /Stopped in mac-mini-1/);
  assert.doesNotMatch(handOff.text, /Interrupted in/);
});

test('the no-result notice still respects an unusually small character bound', () => {
  // A prior run with no terminal result at all produces the notice rather than a
  // fact line. It needs its own bound: an unusually small budget must be honoured
  // rather than exceeded.
  const { result: _result, ...withoutResult } = run({ id: 'prior', status: 'running' });
  const history: readonly AgentRun[] = [withoutResult];

  for (const limit of [1, 5, 20, 120]) {
    const handOff = buildHandOffContext(history, identity, { maxCharacters: limit });
    assert.ok(handOff);
    assert.ok(
      handOff.text.length <= limit,
      `notice is bounded to ${String(limit)}, got ${String(handOff.text.length)}`,
    );
  }
});

test('no prior run produces no hand-off at all', () => {
  assert.equal(buildHandOffContext([], identity), undefined);
  // A run by another agent is not this agent's prior work.
  assert.equal(
    buildHandOffContext([run({ id: 'other', agentId: 'agent-other' })], identity),
    undefined,
  );
});

test('the rendered prompt marks the hand-off clearly and keeps the task separate', () => {
  const handOff = { previousEnvironmentInstanceId: 'mac-mini-1', text: '- Completed in mac-mini-1: done', sourceRunIds: ['prior'] };
  const rendered = renderHandOffPrompt(handOff, 'continue the parser work');

  assert.match(rendered, /## Hand-off context/);
  assert.match(rendered, /## Task\ncontinue the parser work/);
  assert.ok(rendered.indexOf('## Hand-off context') < rendered.indexOf('## Task'));
});
