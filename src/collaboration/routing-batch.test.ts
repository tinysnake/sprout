/**
 * Wake-model-assisted routing batches (#97, ADR-0007).
 *
 * These tests exercise the batch path through the real coordinator and the
 * in-memory collaboration store: fixed collection windows with durable
 * cursors, chronological split batches with deterministic truncation, one
 * frozen attempt that accounts for every input, at most one WakeRequest/run
 * per selected Agent, one retry on the identical snapshot, and fail-closed
 * settlement with visible per-input outcomes. Privacy is asserted on the
 * frozen context itself: only bounded Project-shared facts enter it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { CollaborationCoordinator } from './coordinator.ts';
import { InMemoryCollaborationStore } from './store.ts';
import { buildCollaborationScopes } from './scope-harness.ts';
import { parseRoutingJudgement } from './routing-judgement.ts';
import type { RoutingBounds, RoutingModelPort, RoutingTaskFact } from './routing.ts';

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

const project: Project = {
  id: 'project-sprout',
  goal: 'Ship Sprout',
  rules: ['Report what you observed.'],
  availableEnvironmentInstanceIds: ['mac-mini-1'],
  memberships: [
    { agentId: 'scout', responsibilities: ['Investigate'], collaborationInstructions: 'Ask first.' },
    { agentId: 'forge', responsibilities: ['Build'], collaborationInstructions: '' },
  ],
};

/** Extract the batch input ids from a frozen context (test-side parsing). */
function inputIdsFromContext(context: string): readonly string[] {
  return [...context.matchAll(/\[input \d+ \| id=([^ |]+) \|/g)].map((match) => match[1]!);
}

/** A model that suppresses every input it is shown. */
function suppressAllModel(): RoutingModelPort {
  return {
    id: 'test-suppress-all',
    async judge(request) {
      const suppressions = inputIdsFromContext(request.context).map((inputId) => ({
        inputId,
        rationale: 'conversational chatter',
      }));
      return JSON.stringify({ selections: [], suppressions });
    },
  };
}

interface Harness {
  readonly coordinator: CollaborationCoordinator;
  readonly store: InMemoryCollaborationStore;
  readonly scopes: Awaited<ReturnType<typeof buildCollaborationScopes>>;
  readonly submits: { readonly agentId: string; readonly prompt: string }[];
  readonly modelCalls: { readonly attempt: number; readonly context: string }[];
  readonly observations: { readonly inputId: string; readonly detail: string }[];
  now: number;
  advance(ms: number): void;
}

function build(options: {
  routingModel?: RoutingModelPort;
  routingAttemptTimeoutMs?: number;
  wakePolicy?: 'explicit-only' | 'wake-model-assisted';
  routingIntervalMs?: number;
  bounds?: Partial<RoutingBounds>;
  taskFacts?: readonly RoutingTaskFact[];
} = {}): Harness {
  const engine = new ScriptedEngineAdapter({
    turns: [
      {
        events: [{ type: 'message', text: 'handled', final: true }],
        result: { status: 'completed', text: 'handled' },
      },
    ],
  });
  const projects = new ProjectRegistry([project]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', engine]]),
    agents: new AgentRegistry([
      { id: 'scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
      { id: 'forge', name: 'Forge', engine: 'scripted', capability: 'agent-run', workingDirectory: '/srv/work' },
    ]),
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
  });
  const store = new InMemoryCollaborationStore();
  const scopes = buildCollaborationScopes({
    projects,
    wakePolicy: options.wakePolicy ?? 'wake-model-assisted',
    routingIntervalMs: options.routingIntervalMs ?? 60_000,
  });
  const submits: { agentId: string; prompt: string }[] = [];
  const modelCalls: { attempt: number; context: string }[] = [];
  const observations: { inputId: string; detail: string }[] = [];
  const harness: { now: number } = { now: 0 };
  const model = options.routingModel;
  const wrappedModel: RoutingModelPort | undefined =
    model === undefined
      ? undefined
      : {
          id: model.id,
          async judge(request) {
            modelCalls.push({ attempt: request.attempt, context: request.context });
            return model.judge(request);
          },
        };
  const coordinator = new CollaborationCoordinator({
    scopes: scopes.scopes,
    store,
    runs: orchestrator,
    ...(wrappedModel !== undefined ? { routingModel: wrappedModel } : {}),
    ...(options.routingAttemptTimeoutMs !== undefined
      ? { routingAttemptTimeoutMs: options.routingAttemptTimeoutMs }
      : {}),
    ...(options.bounds !== undefined ? { routingBounds: options.bounds } : {}),
    clock: { now: () => harness.now },
    onObservation: ({ inputId, observation }) => {
      observations.push({ inputId, detail: observation.detail });
    },
  });
  // Track admissions through the orchestrator's store for run assertions.
  const originalSubmit = orchestrator.submit.bind(orchestrator);
  orchestrator.submit = async (request) => {
    const result = await originalSubmit(request);
    submits.push({ agentId: request.agentId, prompt: request.prompt });
    return result;
  };
  return {
    coordinator,
    store,
    scopes,
    submits,
    modelCalls,
    observations,
    get now() {
      return harness.now;
    },
    set now(value: number) {
      harness.now = value;
    },
    advance(ms: number) {
      harness.now += ms;
    },
  };
}

async function channel(harness: Harness): Promise<string> {
  return harness.scopes.channel('project-sprout');
}

test('the first eligible input opens one fixed window and later inputs join without resetting it', async () => {
  const harness = build();
  const scopeId = await channel(harness);

  const first = await harness.coordinator.deliver({
    scopeId,
    author: { id: 'operator', kind: 'human' },
    body: 'needs a look',
    deliveryKey: 'u1',
  });
  assert.equal(first.wakes.length, 0, 'an unaddressed input wakes nobody by itself');
  const windows = await harness.coordinator.listRoutingWindows('project-sprout');
  assert.equal(windows.length, 1);
  const window = windows[0]!;
  assert.equal(window.status, 'open');
  assert.equal(window.deadlineAt, window.openedAt + 60_000, 'the deadline is fixed at open time');
  assert.equal(window.cursor, first.message.id);
  assert.equal(window.inputCount, 1);

  harness.advance(10_000);
  const second = await harness.coordinator.deliver({
    scopeId,
    author: { id: 'human-lead', kind: 'human' },
    body: 'also this',
    deliveryKey: 'u2',
  });
  const after = await harness.coordinator.listRoutingWindows('project-sprout');
  assert.equal(after.length, 1, 'later inputs join the open window, never a second one');
  assert.equal(after[0]!.deadlineAt, window.deadlineAt, 'the deadline never moves (no debounce)');
  assert.equal(after[0]!.cursor, second.message.id);
  assert.equal(after[0]!.inputCount, 2);

  // Durable membership: both inputs are recorded in the window.
  const membership = await harness.store.listRoutingWindowInputs(window.id);
  assert.deepEqual([...membership], [first.message.id, second.message.id]);

  // No suppressed observation yet: the batch outcome is this input's evidence.
  assert.deepEqual(await harness.store.listObservations(first.message.id), []);
});

test('explicit-only routing never opens a window and records the durable suppression instead', async () => {
  const harness = build({ wakePolicy: 'explicit-only' });
  const scopeId = await channel(harness);
  const delivered = await harness.coordinator.deliver({
    scopeId,
    author: { id: 'operator', kind: 'human' },
    body: 'quiet please',
    deliveryKey: 'e1',
  });
  assert.deepEqual(await harness.coordinator.listRoutingWindows('project-sprout'), []);
  const observations = await harness.store.listObservations(delivered.message.id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.status, 'suppressed');
  assert.equal(observations[0]?.reason, 'unaddressed');
});

test('deterministically addressed inputs bypass the window entirely', async () => {
  const harness = build();
  const scopeId = await channel(harness);
  const mentioned = await harness.coordinator.deliver({
    scopeId,
    author: { id: 'operator', kind: 'human' },
    body: '@forge take this',
    deliveryKey: 'a1',
  });
  assert.equal(mentioned.wakes.length, 1);
  const broadcast = await harness.coordinator.deliver({
    scopeId,
    author: { id: 'operator', kind: 'human' },
    body: 'standup @all',
    deliveryKey: 'a2',
  });
  assert.ok(broadcast.wakes.length > 0);
  assert.deepEqual(
    await harness.coordinator.listRoutingWindows('project-sprout'),
    [],
    'explicit addresses never enter a collection window (ADR-0007)',
  );
});

test('one frozen attempt accounts for every input and coalesces each selected Agent to one wake and run', async () => {
  const harness = build({
    routingModel: {
      id: 'test-model',
      async judge(request) {
        const [first, second, third] = inputIdsFromContext(request.context);
        return JSON.stringify({
          selections: [
            { agentId: 'scout', inputIds: [first!, second!, third!], rationale: 'Investigation fits.' },
            { agentId: 'forge', inputIds: [second!], rationale: 'Build work too.' },
          ],
          suppressions: [],
        });
      },
    },
  });
  const scopeId = await channel(harness);
  const ids: string[] = [];
  for (const [index, body] of ['first ask', 'second ask', 'third ask'].entries()) {
    const delivered = await harness.coordinator.deliver({
      scopeId,
      author: { id: 'operator', kind: 'human' },
      body,
      deliveryKey: `c${index}`,
    });
    ids.push(delivered.message.id);
  }

  harness.advance(60_000);
  await harness.coordinator.sweepRouting();

  const batches = await harness.coordinator.listRoutingBatches('project-sprout');
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.status, 'routed');
  assert.equal(batches[0]!.splitCount, 1);

  const outcomes = await harness.store.listRoutingOutcomes(batches[0]!.id);
  assert.equal(outcomes.length, 3, 'every input has exactly one explicit outcome');
  assert.ok(outcomes.every((outcome) => outcome.status === 'selected'));

  const wakes = (await harness.coordinator.listWakeRequests()).filter(
    (wake) => wake.batchId === batches[0]!.id,
  );
  assert.deepEqual(
    wakes.map((wake) => wake.agentId).sort(),
    ['forge', 'scout'],
    'one WakeRequest per selected Agent per batch',
  );
  assert.ok(wakes.every((wake) => wake.reason === 'routing-model' && wake.status === 'admitted'));
  assert.ok(wakes.every((wake) => wake.inputId === batches[0]!.id));

  assert.equal(harness.submits.length, 2, 'one run per selected Agent, never one per input');
  const scout = harness.submits.find((submit) => submit.agentId === 'scout');
  assert.ok(scout);
  const positions = ids.map((id) => scout.prompt.indexOf(id));
  assert.ok(positions.every((position) => position >= 0), 'the run receives its assigned inputs');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'in chronological order');

  const attempts = await harness.store.listRoutingAttempts(batches[0]!.id);
  assert.equal(attempts.length, 1, 'a valid judgement is not retried');
  assert.equal(attempts[0]?.status, 'succeeded');
  assert.equal(attempts[0]?.modelId, 'test-model');
});

test('a valid zero-selection judgement is deliberate suppression, durable and visible', async () => {
  const harness = build({ routingModel: suppressAllModel() });
  const scopeId = await channel(harness);
  const delivered = await harness.coordinator.deliver({
    scopeId,
    author: { id: 'operator', kind: 'human' },
    body: 'just chatting',
    deliveryKey: 's1',
  });
  harness.advance(60_000);
  await harness.coordinator.sweepRouting();

  const batches = await harness.coordinator.listRoutingBatches('project-sprout');
  assert.equal(batches[0]!.status, 'suppressed');
  assert.equal(harness.submits.length, 0, 'suppression wakes nobody');
  const outcomes = await harness.store.listRoutingOutcomes(batches[0]!.id);
  assert.equal(outcomes[0]?.status, 'suppressed');
  assert.equal(outcomes[0]?.rationale, 'conversational chatter');
  const observations = await harness.store.listObservations(delivered.message.id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.status, 'suppressed');
  assert.equal(observations[0]?.reason, 'routing-model');
});

test('malformed output retries once on the identical frozen snapshot and then fails closed', async () => {
  const seen: string[] = [];
  const harness = build({
    routingModel: {
      id: 'broken-model',
      async judge(request) {
        seen.push(request.context);
        return request.attempt === 1 ? 'not json {' : '{still not json';
      },
    },
  });
  const scopeId = await channel(harness);
  const delivered = await harness.coordinator.deliver({
    scopeId,
    author: { id: 'operator', kind: 'human' },
    body: 'route me',
    deliveryKey: 'f1',
  });
  harness.advance(60_000);
  await harness.coordinator.sweepRouting();

  assert.equal(seen.length, 2, 'exactly one automatic retry');
  assert.equal(seen[0], seen[1], 'the retry judges the byte-identical frozen snapshot');
  assert.equal(harness.modelCalls[0]?.attempt, 1);
  assert.equal(harness.modelCalls[1]?.attempt, 2);

  const batches = await harness.coordinator.listRoutingBatches('project-sprout');
  assert.equal(batches[0]!.status, 'failed');
  assert.match(batches[0]!.error ?? '', /failed after 2 attempts/);
  const attempts = await harness.store.listRoutingAttempts(batches[0]!.id);
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((attempt) => attempt.errorKind),
    ['malformed-output', 'malformed-output'],
  );

  const outcomes = await harness.store.listRoutingOutcomes(batches[0]!.id);
  assert.equal(outcomes.length, 1, 'every input has a visible failed outcome');
  assert.equal(outcomes[0]?.status, 'failed');
  const observations = await harness.store.listObservations(delivered.message.id);
  assert.equal(observations[0]?.status, 'failed');
  assert.equal(observations[0]?.reason, 'routing-model');

  assert.equal(harness.submits.length, 0, 'failing closed wakes nobody');
  assert.deepEqual(await harness.coordinator.listWakeRequests(), []);
  // The original input stays intact and durable.
  const messages = await harness.coordinator.listMessages({ scopeId });
  assert.ok(messages.some((message) => message.id === delivered.message.id && message.body === 'route me'));
});

test('an omitted input is an incomplete judgement, not a partial acceptance', async () => {
  const harness = build({
    routingModel: {
      id: 'omitting-model',
      async judge(request) {
        const [first] = inputIdsFromContext(request.context);
        return JSON.stringify({
          selections: [{ agentId: 'scout', inputIds: [first!] }],
          suppressions: [],
        });
      },
    },
  });
  const scopeId = await channel(harness);
  for (const [index, body] of ['one', 'two'].entries()) {
    await harness.coordinator.deliver({
      scopeId,
      author: { id: 'operator', kind: 'human' },
      body,
      deliveryKey: `o${index}`,
    });
  }
  harness.advance(60_000);
  await harness.coordinator.sweepRouting();

  const batches = await harness.coordinator.listRoutingBatches('project-sprout');
  const attempts = await harness.store.listRoutingAttempts(batches[0]!.id);
  assert.equal(attempts[0]?.errorKind, 'incomplete-output');
  assert.equal(batches[0]!.status, 'failed', 'the whole attempt fails, never a salvaged subset');
  assert.equal(harness.submits.length, 0);
});

test('selecting a non-candidate Agent fails closed after one retry', async () => {
  const harness = build({
    routingModel: {
      id: 'wide-model',
      async judge(request) {
        const ids = inputIdsFromContext(request.context);
        return JSON.stringify({
          selections: [{ agentId: 'stranger', inputIds: [...ids] }],
          suppressions: [],
        });
      },
    },
  });
  const scopeId = await channel(harness);
  await harness.coordinator.deliver({
    scopeId,
    author: { id: 'operator', kind: 'human' },
    body: 'who handles this?',
    deliveryKey: 'x1',
  });
  harness.advance(60_000);
  await harness.coordinator.sweepRouting();

  const batches = await harness.coordinator.listRoutingBatches('project-sprout');
  const attempts = await harness.store.listRoutingAttempts(batches[0]!.id);
  assert.deepEqual(attempts.map((attempt) => attempt.errorKind), ['unknown-agent', 'unknown-agent']);
  assert.equal(batches[0]!.status, 'failed');
  assert.equal(harness.submits.length, 0);
});

test('a failed first attempt retries once on the identical snapshot and can still route', async () => {
  const harness = build({
    routingModel: {
      id: 'flaky-model',
      async judge(request) {
        if (request.attempt === 1) throw new Error('transient provider hiccup');
        const ids = inputIdsFromContext(request.context);
        return JSON.stringify({
          selections: [{ agentId: 'scout', inputIds: [...ids], rationale: 'Retry succeeded.' }],
          suppressions: [],
        });
      },
    },
  });
  const scopeId = await channel(harness);
  await harness.coordinator.deliver({
    scopeId,
    author: { id: 'operator', kind: 'human' },
    body: 'retry me',
    deliveryKey: 'r1',
  });
  harness.advance(60_000);
  await harness.coordinator.sweepRouting();

  const batches = await harness.coordinator.listRoutingBatches('project-sprout');
  assert.equal(batches[0]!.status, 'routed');
  const attempts = await harness.store.listRoutingAttempts(batches[0]!.id);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.errorKind, 'model-unavailable');
  assert.equal(attempts[1]?.status, 'succeeded');
  assert.equal(harness.modelCalls[0]?.context, harness.modelCalls[1]?.context);
  assert.equal(harness.submits.length, 1);
});

test('provider error prose and adapter credential-shaped identity never enter routing evidence', async () => {
  const opaque = 'SYNTHETIC_OPAQUE_PROVIDER_VALUE_ABC123';
  const harness = build({
    routingModel: {
      id: `api_key=${opaque}`,
      async judge() { throw new Error(`request failed: ${opaque}`); },
    },
  });
  const scopeId = await channel(harness);
  const delivered = await harness.coordinator.deliver({
    scopeId, author: { id: 'operator', kind: 'human' }, body: 'route safely', deliveryKey: 'opaque-error',
  });
  harness.advance(60_000);
  await harness.coordinator.sweepRouting();
  const batch = (await harness.coordinator.listRoutingBatches('project-sprout'))[0]!;
  const attempts = await harness.store.listRoutingAttempts(batch.id);
  const outcomes = await harness.store.listRoutingOutcomes(batch.id);
  const observations = await harness.store.listObservations(delivered.message.id);
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((attempt) => attempt.modelId === 'unknown-model' && attempt.errorDetail === 'wake model request failed'));
  assert.equal(batch.status, 'failed');
  assert.ok(!JSON.stringify({ attempts, outcomes, observations, batch }).includes(opaque));
});

test('a missing wake model fails closed with two visible unavailable attempts', async () => {
  const harness = build();
  const scopeId = await channel(harness);
  const delivered = await harness.coordinator.deliver({
    scopeId,
    author: { id: 'operator', kind: 'human' },
    body: 'no model here',
    deliveryKey: 'm1',
  });
  harness.advance(60_000);
  await harness.coordinator.sweepRouting();

  const batches = await harness.coordinator.listRoutingBatches('project-sprout');
  assert.equal(batches[0]!.status, 'failed');
  const attempts = await harness.store.listRoutingAttempts(batches[0]!.id);
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((attempt) => attempt.errorKind === 'model-unavailable'));
  assert.ok(attempts.every((attempt) => attempt.modelId === 'unavailable'));
  const outcomes = await harness.store.listRoutingOutcomes(batches[0]!.id);
  assert.equal(outcomes[0]?.status, 'failed');
  assert.equal(harness.submits.length, 0);
  const observations = await harness.store.listObservations(delivered.message.id);
  assert.equal(observations[0]?.status, 'failed');
});

test('a timed-out judgement fails closed after one timeout retry', async () => {
  const harness = build({
    routingAttemptTimeoutMs: 5,
    routingModel: {
      id: 'hanging-model',
      judge: () => new Promise<string>(() => undefined),
    },
  });
  const scopeId = await channel(harness);
  await harness.coordinator.deliver({
    scopeId,
    author: { id: 'operator', kind: 'human' },
    body: 'never answers',
    deliveryKey: 't1',
  });
  harness.advance(60_000);
  await harness.coordinator.sweepRouting();

  const batches = await harness.coordinator.listRoutingBatches('project-sprout');
  assert.equal(batches[0]!.status, 'failed');
  const attempts = await harness.store.listRoutingAttempts(batches[0]!.id);
  assert.deepEqual(attempts.map((attempt) => attempt.errorKind), ['timeout', 'timeout']);
  assert.equal(harness.submits.length, 0);
});

test('oversized windows split chronologically and truncate a single oversized input deterministically', async () => {
  const harness = build({
    routingModel: suppressAllModel(),
    bounds: { totalContextChars: 900, inputContentChars: 40, recentContextMessages: 0 },
  });
  const scopeId = await channel(harness);
  const ids: string[] = [];
  const longBody = `${'filler '.repeat(50)}COMPLETE_DURABLE_CONTENT_MARKER`;
  for (const [index, body] of ['alpha', 'beta', 'gamma', longBody, 'omega'].entries()) {
    const delivered = await harness.coordinator.deliver({
      scopeId,
      author: { id: 'operator', kind: 'human' },
      body,
      deliveryKey: `sp${index}`,
    });
    ids.push(delivered.message.id);
  }

  harness.advance(60_000);
  await harness.coordinator.sweepRouting();

  const batches = [...(await harness.coordinator.listRoutingBatches('project-sprout'))].sort(
    (a, b) => a.splitIndex - b.splitIndex,
  );
  assert.ok(batches.length > 1, 'the window splits rather than dropping or overflowing');
  assert.ok(batches.every((batch) => batch.status === 'suppressed'));

  // Chronological split: positions across batches preserve input order.
  const covered: string[] = [];
  for (const batch of batches) {
    assert.equal(batch.splitCount, batches.length);
    const inputs = await harness.store.listRoutingBatchInputs(batch.id);
    for (const input of inputs) covered.push(input.inputId);
  }
  assert.deepEqual(covered, ids, 'every durable input appears exactly once, in order');

  // Deterministic truncation: the oversized input is excerpted with a marker
  // while its complete content stays durable on the Message.
  const withTruncation = batches
    .map((batch) => batch)
    .find((batch) => batch.manifest.inputs.some((input) => input.inputId === ids[3]));
  assert.ok(withTruncation, 'the oversized input is marked truncated');
  const truncatedFact = withTruncation.manifest.inputs.find((input) => input.inputId === ids[3])!;
  assert.equal(truncatedFact.truncated, true);
  assert.ok(truncatedFact.contentChars > truncatedFact.excerptChars);
  const batchInputs = await harness.store.listRoutingBatchInputs(withTruncation.id);
  const row = batchInputs.find((input) => input.inputId === truncatedFact.inputId)!;
  assert.match(row.excerpt, /\[truncated: first 40 of \d+ characters/);
  const message = (await harness.coordinator.listMessages({ scopeId })).find(
    (candidate) => candidate.id === truncatedFact.inputId,
  )!;
  assert.equal(message.body, longBody, 'the complete durable content is never destroyed');

  // Splitting is deterministic: the same facts produce the same batch shapes.
  const again = [...(await harness.coordinator.listRoutingBatches('project-sprout'))].sort(
    (a, b) => a.splitIndex - b.splitIndex,
  );
  assert.deepEqual(
    again.map((batch) => batch.manifest.inputs.map((input) => input.inputId)),
    batches.map((batch) => batch.manifest.inputs.map((input) => input.inputId)),
  );
});

test('a wake-eligible Project event joins the window; other dispositions never do', async () => {
  const harness = build({ routingModel: suppressAllModel() });
  const eligible = await harness.coordinator.publishEvent({
    projectId: 'project-sprout',
    kind: 'build-ready',
    summary: 'A build finished.',
    disposition: 'wake-eligible',
    deliveryKey: 'ev1',
  });
  assert.equal(eligible.wakes.length, 0);
  const windows = await harness.coordinator.listRoutingWindows('project-sprout');
  assert.equal(windows.length, 1, 'wake-eligible is consumed by the batch path (#96 follow-up)');
  assert.equal(windows[0]!.inputCount, 1);

  await harness.coordinator.publishEvent({
    projectId: 'project-sprout',
    kind: 'note',
    summary: 'Informational.',
    disposition: 'informational',
    deliveryKey: 'ev2',
  });
  assert.equal(
    (await harness.coordinator.listRoutingWindows('project-sprout'))[0]!.inputCount,
    1,
    'informational events never open or join a window',
  );

  harness.advance(60_000);
  await harness.coordinator.sweepRouting();
  const batches = await harness.coordinator.listRoutingBatches('project-sprout');
  assert.equal(batches.length, 1);
  const outcomes = await harness.store.listRoutingOutcomes(batches[0]!.id);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.inputId),
    [eligible.event.id],
  );
});

test('the frozen routing context contains only bounded Project-shared facts and excludes private ones', async () => {
  const harness = build({
    routingModel: suppressAllModel(),
    taskFacts: [
      {
        taskId: 'task-triage',
        title: 'Triage incoming reports',
        status: 'blocked',
        blockerReason: 'Waiting for the operator decision',
        leadAgentId: 'scout',
        createdAt: 500,
      },
    ],
  });
  const channelScope = await channel(harness);
  const directScope = await harness.scopes.openDirect('project-sprout', ['operator', 'scout']);

  // Private facts that must never reach the wake model.
  await harness.coordinator.deliver({
    scopeId: directScope,
    author: { id: 'operator', kind: 'human' },
    body: 'SECRET_DIRECT_MESSAGE_TOKEN',
    recipients: ['scout'],
    deliveryKey: 'dm1',
  });
  await harness.coordinator.deliver({
    scopeId: channelScope,
    author: { id: 'operator', kind: 'human' },
    body: 'the goal moves forward',
    deliveryKey: 'pc1',
  });
  await harness.coordinator.deliver({
    scopeId: channelScope,
    author: { id: 'operator', kind: 'human' },
    body: 'please triage this location:/home/example/PRIVATE_PATH_ALPHA location:C:/Users/Example/PRIVATE_PATH_BETA Authorization: Basic SYNTHETIC_BASIC_SECRET',
    deliveryKey: 'pc2',
  });

  harness.advance(60_000);
  await harness.coordinator.sweepRouting();

  const batches = await harness.coordinator.listRoutingBatches('project-sprout');
  const context = batches[0]!.context;
  assert.equal(harness.modelCalls[0]?.context, context, 'the model receives the stored frozen snapshot');
  for (const marker of ['PRIVATE_PATH_ALPHA', 'PRIVATE_PATH_BETA', 'SYNTHETIC_BASIC_SECRET']) {
    assert.ok(!context.includes(marker), `${marker} reached the model`);
  }
  assert.ok(!context.includes('SECRET_DIRECT_MESSAGE_TOKEN'), 'direct Messages are excluded');
  assert.ok(context.includes('please triage this'), 'the batch input is included');
  assert.ok(context.includes('the goal moves forward'), 'bounded recent channel context is included');
  assert.ok(context.includes('Ship Sprout'), 'the Project goal is included');
  assert.ok(context.includes('Report what you observed.'), 'the Project rules are included');
  assert.ok(context.includes('Investigate'), 'candidate responsibilities are included');
  assert.ok(!context.includes('Triage incoming reports'), 'unrelated Tasks never enter model context');
  assert.deepEqual(batches[0]!.manifest.tasks, []);
  assert.ok(
    context.includes('source selection provides no routing-context source for') &&
      context.includes('structured credential records, host and private-network records') &&
      context.includes('recognized sensitive patterns in admitted text are redacted') &&
      context.includes('unlabelled opaque values in admitted prose may still be present'),
    'the model context describes source exclusions and the recognized-pattern limit',
  );
  assert.deepEqual(batches[0]!.manifest.exclusions, [
    'direct Messages and their replies',
    'credentials, tokens, and secrets',
    'Agent-private memory',
    'raw reasoning and thinking traces',
    'engine sessions and run transcripts',
    'tool output',
    'host identity and private network facts',
    'transient Environment availability',
  ]);
  // The context is bounded by construction.
  assert.ok(context.length <= batches[0]!.bounds.totalContextChars + 2_000);
});

test('a projected reply never opens a window even when its text mentions Agents', async () => {
  const harness = build({ routingModel: suppressAllModel() });
  const scopeId = await channel(harness);
  await harness.coordinator.deliver({
    scopeId,
    author: { id: 'operator', kind: 'human' },
    body: '@forge build this',
    deliveryKey: 'pr1',
  });
  const replies = (await harness.coordinator.listMessages({ scopeId })).filter(
    (message) => message.author.kind === 'agent',
  );
  assert.ok(replies.length > 0, 'the addressed run projected a reply');
  assert.deepEqual(
    await harness.coordinator.listRoutingWindows('project-sprout'),
    [],
    'loop prevention: projection bypasses the window path entirely, even under assisted routing',
  );
});

test('a duplicate delivery does not double-count window membership', async () => {
  const harness = build();
  const scopeId = await channel(harness);
  const request = {
    scopeId,
    author: { id: 'operator' as const, kind: 'human' as const },
    body: 'once only',
    deliveryKey: 'dup1',
  };
  const first = await harness.coordinator.deliver(request);
  const second = await harness.coordinator.deliver(request);
  assert.equal(second.duplicate, true);
  const window = (await harness.coordinator.listRoutingWindows('project-sprout'))[0]!;
  assert.equal(window.inputCount, 1);
  assert.equal(window.cursor, first.message.id);
});

// Keeps the typed interface of `parseRoutingJudgement` honest for consumers
// that validate a judgement outside the coordinator (contract reference).
test('the judgement validator rejects a suppression that names an unknown input', () => {
  const result = parseRoutingJudgement(
    JSON.stringify({ selections: [], suppressions: [{ inputId: 'msg-ghost' }] }),
    { inputIds: ['msg-real'], candidatesByInput: new Map([['msg-real', ['scout']]]) },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, 'unknown-input');
});
