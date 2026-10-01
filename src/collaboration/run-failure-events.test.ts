/**
 * The system run-lifecycle failure producer (#180).
 *
 * Three properties are held to here:
 *
 * 1. **Projection shape** — one Project-scoped terminal failure projects one
 *    `informational` `agent-run-failure` input attributed to the system
 *    producer, keyed by the run id.
 * 2. **Privacy** — only identifiers, failure class, and exact product-owned
 *    outcome reasons cross the projection: never arbitrary failure text,
 *    prompt, raw events, tool output, or host facts.
 * 3. **Exactly-once** — the coordinator publishes it live (covered end-to-end
 *    in `integration.test.ts`) and again from restart reconciliation over the
 *    same delivery key, so a missed publication is repaired without a duplicate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';
import type { AgentRun } from '../run/model.ts';
import { InMemoryCollaborationStore } from './store.ts';
import { CollaborationCoordinator, type RunAdmitter } from './coordinator.ts';
import { buildCollaborationScopes } from './scope-harness.ts';
import {
  RUN_FAILURE_EVENT_KIND,
  runFailureDeliveryKey,
  runFailureEventInput,
} from './run-failure-events.ts';

const project: Project = {
  id: 'project-sprout',
  goal: 'Ship Sprout',
  rules: [],
  availableEnvironmentInstanceIds: ['mac-mini-1'],
  memberships: [{ agentId: 'architect', responsibilities: ['Investigate'], collaborationInstructions: '' }],
};

function failedRun(
  overrides: Omit<Partial<AgentRun>, 'projectId' | 'failure'> & {
    readonly projectId?: string | undefined;
    readonly failure?: string | undefined;
  } = {},
): AgentRun {
  const { projectId, failure, ...rest } = overrides;
  return {
    id: 'run-42',
    agentId: 'architect',
    prompt: 'SECRET_PROMPT the full operator request with private context',
    environmentInstanceId: 'mac-mini-1',
    status: 'failed',
    failureClass: 'environment',
    events: [{ type: 'tool-output', text: 'SECRET_TOOL_OUTPUT from the engine transcript' }],
    createdAt: 1_000,
    ...rest,
    ...('failure' in overrides
      ? failure !== undefined
        ? { failure }
        : {}
      : { failure: 'no available environment for capability: agent-run' }),
    ...('projectId' in overrides
      ? projectId !== undefined
        ? { projectId }
        : {}
      : { projectId: 'project-sprout' }),
  };
}

/** The same durable run with its Project scope absent — not Project-scoped. */
function withoutProjectScope(run: AgentRun): AgentRun {
  const clone = { ...run } as { projectId?: string };
  delete clone.projectId;
  return clone as unknown as AgentRun;
}

test('a Project-scoped terminal failure projects an informational system event with identifiers only', () => {
  const input = runFailureEventInput(failedRun());
  assert.ok(input);
  assert.equal(input.kind, RUN_FAILURE_EVENT_KIND);
  assert.equal(input.projectId, 'project-sprout');
  assert.equal(input.disposition, 'informational', 'no wake, no fan-out: the disposition is declared');
  assert.deepEqual(input.producer, { id: 'sprout', kind: 'system' }, 'attributed to the system producer');
  assert.equal(input.deliveryKey, runFailureDeliveryKey('run-42'), 'one event per terminal transition');
  assert.equal(input.awaitReply, false);
  assert.equal(input.responsibleAgentIds, undefined, 'only addressed events name responsible Agents');
  assert.match(input.summary, /Agent run failed \(environment\) for architect/);
  assert.doesNotMatch(input.summary, /no available environment for capability: agent-run/);
  assert.equal(input.detail, 'run run-42 · agent architect · No error outcome was recorded.');

  // Privacy: prompt, raw events, and tool output are structurally absent.
  const serialized = JSON.stringify(input);
  assert.doesNotMatch(serialized, /SECRET_PROMPT/);
  assert.doesNotMatch(serialized, /SECRET_TOOL_OUTPUT/);
  assert.equal('prompt' in input, false);
  assert.equal('events' in input, false);
});

test('engine-error text and host-shaped facts are excluded, not pattern-redacted', () => {
  // Construct synthetic names rather than recording any real machine identity.
  const numberedHost = ['fixture', 'node', '12345'].join('');
  const bareHost = ['fixture', 'machine'].join('');
  const marker = 'ARBITRARY_OUTPUT_MARKER';
  const input = runFailureEventInput(failedRun({
    failure: `engine error: ${marker} on ${numberedHost} and ${bareHost}`,
    failureClass: 'execution',
  }));
  assert.ok(input);
  assert.equal(input.summary, 'Agent run failed (execution) for architect');
  assert.equal(input.detail, 'run run-42 · agent architect · No error outcome was recorded.');
  assert.equal(input.deliveryKey, 'run-failure:run-42');
  const projected = JSON.stringify(input);
  for (const unsafe of [marker, numberedHost, bareHost, 'engine error']) {
    assert.equal(projected.includes(unsafe), false);
  }

  const known = runFailureEventInput(failedRun({
    failure: `no available environment for capability: agent-run; ${marker} ${numberedHost}`,
  }));
  assert.ok(known);
  assert.equal(known.summary, 'Agent run failed (environment) for architect');
  assert.equal(JSON.stringify(known).includes(marker), false);
  assert.equal(JSON.stringify(known).includes(numberedHost), false);
});

test('failure notices explain persisted error messages, message-less errors, and missing outcomes safely', () => {
  const cases: readonly [Partial<AgentRun>, RegExp][] = [
    [{ result: { status: 'failed', message: 'the engine refused the saved session' } }, /the engine refused the saved session/],
    [{ result: { status: 'failed', message: '' } }, /code: failed/],
    [{ result: { status: 'failed', message: '', stopReason: 'error' } }, /stopReason: error/],
    [{}, /No error outcome was recorded/],
    [{ result: { status: 'failed', message: '<script>HOSTILE_DIAGNOSTIC</script>'.repeat(1000) } }, /diagnostic withheld/],
  ];
  for (const [outcome, reason] of cases) {
    const input = runFailureEventInput(failedRun(outcome));
    assert.match(input?.detail ?? '', reason);
    assert.doesNotMatch(JSON.stringify(input), /HOSTILE_DIAGNOSTIC|<script>/);
    assert.ok((input?.detail?.length ?? 0) < 500, 'notice reason is bounded by product-owned vocabulary');
  }
});

test('only Project-scoped terminal failures project an event', () => {
  assert.equal(runFailureEventInput(failedRun({ status: 'completed' })), undefined);
  assert.equal(
    runFailureEventInput(failedRun({ status: 'interrupted' })),
    undefined,
    'an intentional Human stop settles interrupted and is never reported as a failure',
  );
  assert.equal(runFailureEventInput(failedRun({ status: 'running' })), undefined);
  assert.equal(runFailureEventInput(failedRun({ status: 'queued' })), undefined);
  assert.equal(
    runFailureEventInput(withoutProjectScope(failedRun())),
    undefined,
    'a run with no Project has no timeline authoritative for the event',
  );
});

test('only structured classes determine the event; prefix spoofs and legacy text default to execution', () => {
  const spoofed = [
    'no available environment: engine output',
    'no available environmentXYZ engine output',
    'unknown agent: unrelated engine output',
    'No Available Environment: engine output',
    ' no available environment: engine output',
    'no available environment! engine output',
    'UNKNOWN AGENT: engine output',
    'unknown  agent: engine output',
    'interrupted by a Sprout restart before this run finished',
  ];
  for (const failure of spoofed) {
    const legacy = failedRun({ failure });
    const { failureClass: _class, ...untyped } = legacy;
    assert.equal(runFailureEventInput(untyped)?.summary, 'Agent run failed (execution) for architect');
    assert.equal(runFailureEventInput({ ...legacy, failureClass: 'execution' })?.summary,
      'Agent run failed (execution) for architect');
  }
  for (const failureClass of ['admission', 'environment', 'restart'] as const) {
    assert.equal(runFailureEventInput(failedRun({ failure: 'unrelated text', failureClass }))?.summary,
      `Agent run failed (${failureClass}) for architect`);
  }
});

function harness(admitter: RunAdmitter) {
  const projects = new ProjectRegistry([project]);
  const scopes = buildCollaborationScopes({ projects });
  const coordinator = new CollaborationCoordinator({
    scopes: scopes.scopes,
    store: new InMemoryCollaborationStore(),
    runs: admitter,
  });
  return coordinator;
}

/** A minimal admitter with no settlement stream: restart scan is its only producer. */
function streamlessAdmitter(runs: readonly AgentRun[]): RunAdmitter {
  return {
    async submit() {
      throw new Error('not used: this admitter admits nothing');
    },
    async waitFor(runId) {
      const run = runs.find((candidate) => candidate.id === runId);
      if (run === undefined) throw new Error(`unknown run: ${runId}`);
      return run;
    },
    async load(runId) {
      return runs.find((candidate) => candidate.id === runId);
    },
    async list() {
      return runs;
    },
  };
}

test('failure notice follows the real Message → wake → run into its originating direct chat', async () => {
  const scopes = buildCollaborationScopes({ projects: [project] });
  const scopeId = await scopes.openDirect(project.id, ['operator', 'architect']);
  const run = failedRun();
  const coordinator = new CollaborationCoordinator({
    scopes: scopes.scopes,
    store: new InMemoryCollaborationStore(),
    runs: { ...streamlessAdmitter([run]), async submit() { return run; } },
  });
  const delivered = await coordinator.deliver({
    scopeId, author: { id: 'operator', kind: 'human' }, body: 'Please investigate',
    recipients: ['architect'], deliveryKey: 'origin-failure',
  });
  assert.equal(delivered.wakes[0]?.runId, run.id);
  await coordinator.reconcile();
  const events = await coordinator.listEvents(project.id);
  assert.deepEqual((events[0] as unknown as { originScopeIds: string[] }).originScopeIds, [scopeId]);
  assert.equal(events.length, 1, 'the same durable Project event is exposed, not a fabricated reply');
  assert.equal((await coordinator.listMessages()).length, 1);
  assert.equal((await coordinator.listWakeRequests()).length, 1, 'failure notice never wakes an Agent');
  await coordinator.reconcile();
  assert.equal((await coordinator.listEvents(project.id)).length, 1);
});

test('restart reconciliation publishes a missed failure event exactly once', async () => {
  const marker = 'ARBITRARY_RECONCILIATION_OUTPUT';
  const run = failedRun({ failure: `engine failed: ${marker} at ${['fixture', 'node', '12345'].join('')}`, failureClass: 'execution' });
  const coordinator = harness(streamlessAdmitter([run, { ...run, id: 'run-done', status: 'completed' }]));

  const first = await coordinator.reconcile();
  assert.deepEqual(first.failureEventRunIds, ['run-42'], 'work done, not work inspected');
  const second = await coordinator.reconcile();
  assert.deepEqual(second.failureEventRunIds, [], 'the durable event short-circuits the duplicate');
  const events = await coordinator.listEvents('project-sprout');
  assert.equal(events.length, 1, 'one event per run terminal transition across restarts');
  assert.equal(events[0]?.deliveryKey, 'run-failure:run-42');
  assert.equal(events[0]?.summary, 'Agent run failed (execution) for architect');
  assert.equal(JSON.stringify(events).includes(marker), false, 'durable event excludes engine text');
});

test('reconciliation preserves a genuine admission class from the durable run fact', async () => {
  const run = failedRun({ failure: 'unknown agent: scout', failureClass: 'admission' });
  const coordinator = harness(streamlessAdmitter([run]));
  assert.deepEqual((await coordinator.reconcile()).failureEventRunIds, ['run-42']);
  assert.equal((await coordinator.listEvents('project-sprout'))[0]?.summary,
    'Agent run failed (admission) for architect');
  assert.deepEqual((await coordinator.reconcile()).failureEventRunIds, []);
});

test('reconciliation survives an unprojectable run and never fabricates an event for it', async () => {
  const run = failedRun();
  const coordinator = harness(
    streamlessAdmitter([
      run,
      { ...run, id: 'run-ghost', projectId: 'project-does-not-exist' },
      { ...run, id: 'run-other-project', projectId: 'project-unknown' },
    ]),
  );

  const result = await coordinator.reconcile();
  assert.deepEqual(result.failureEventRunIds, ['run-42']);
  assert.equal((await coordinator.listEvents('project-sprout')).length, 1);
  assert.equal((await coordinator.listEvents('project-does-not-exist')).length, 0);
});

test('existing identifier-only failure events acquire safe outcome evidence on read without duplication', async () => {
  const run = failedRun({ result: { status: 'failed', message: 'the engine refused the saved session' } });
  const coordinator = harness(streamlessAdmitter([run]));
  const input = runFailureEventInput(run)!;
  await coordinator.publishEvent({ ...input, detail: 'run run-42 · agent architect' });
  assert.equal(await coordinator.publishRunFailure(run), 'duplicate');
  const events = await coordinator.listEvents(project.id);
  assert.equal(events.length, 1);
  assert.match(events[0]?.detail ?? '', /the engine refused the saved session/);
});

test('publishRunFailure reports published, duplicate, and skipped distinctly', async () => {
  const run = failedRun();
  const coordinator = harness(streamlessAdmitter([run]));

  assert.equal(await coordinator.publishRunFailure(run), 'published');
  assert.equal(await coordinator.publishRunFailure(run), 'duplicate');
  assert.equal(await coordinator.publishRunFailure({ ...run, status: 'completed' }), 'skipped');
  assert.equal(await coordinator.publishRunFailure(withoutProjectScope(run)), 'skipped');
  assert.equal((await coordinator.listEvents('project-sprout')).length, 1);
});
