/**
 * The system run-lifecycle failure producer (#180).
 *
 * Three properties are held to here:
 *
 * 1. **Projection shape** — one Project-scoped terminal failure projects one
 *    `informational` `agent-run-failure` input attributed to the system
 *    producer, keyed by the run id.
 * 2. **Privacy** — the projection carries the sanitized failure class and
 *    reason plus run identifiers only: never the run prompt, raw events, tool
 *    output, or host facts.
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
  classifyRunFailure,
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
  assert.match(input.summary, /no available environment for capability: agent-run/);
  assert.equal(input.detail, 'run run-42 · agent architect');

  // Privacy: prompt, raw events, and tool output are structurally absent.
  const serialized = JSON.stringify(input);
  assert.doesNotMatch(serialized, /SECRET_PROMPT/);
  assert.doesNotMatch(serialized, /SECRET_TOOL_OUTPUT/);
  assert.equal('prompt' in input, false);
  assert.equal('events' in input, false);
});

test('a failure reason carrying host facts is redacted before it can become a durable event', () => {
  const input = runFailureEventInput(
    failedRun({ failure: 'worker failed to spawn /Users/operator/.local/bin/engine (host7)' }),
  );
  assert.ok(input);
  assert.match(input.summary, /<redacted-path>/);
  assert.doesNotMatch(input.summary, /\/Users\//);
  assert.doesNotMatch(input.summary, /operator/);
  assert.match(input.summary, /Agent run failed \(execution\) for architect/);

  const credential = runFailureEventInput(failedRun({ failure: 'authentication failed: api_key = sk-abcdef1234567890' }));
  assert.ok(credential);
  assert.doesNotMatch(credential.summary, /sk-abcdef1234567890/);
  assert.match(credential.summary, /<redacted-credential>/);
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

test('failure classes come from Sprout-owned reason shapes, with a decisive fallback', () => {
  assert.equal(classifyRunFailure('interrupted by a Sprout restart before this run finished'), 'restart');
  assert.equal(classifyRunFailure('no available environment for capability: agent-run'), 'environment');
  assert.equal(
    classifyRunFailure('no project grants agent scout access to an environment for capability: agent-run'),
    'environment',
  );
  assert.equal(classifyRunFailure('unknown agent: ghost'), 'admission');
  assert.equal(classifyRunFailure('agent scout is not a member of project project-sprout'), 'admission');
  assert.equal(classifyRunFailure('no compatible work option for agent scout'), 'admission');
  assert.equal(classifyRunFailure('engine turn exploded'), 'execution', 'unknown engine text never guesses finer');
  assert.equal(classifyRunFailure(undefined), 'execution');
  assert.equal(classifyRunFailure('   '), 'execution');

  const reasonless = runFailureEventInput(failedRun({ failure: undefined }));
  assert.ok(reasonless);
  assert.equal(reasonless.summary, 'Agent run failed (execution) for architect');
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

test('restart reconciliation publishes a missed failure event exactly once', async () => {
  const run = failedRun();
  const coordinator = harness(streamlessAdmitter([run, { ...run, id: 'run-done', status: 'completed' }]));

  const first = await coordinator.reconcile();
  assert.deepEqual(first.failureEventRunIds, ['run-42'], 'work done, not work inspected');
  const second = await coordinator.reconcile();
  assert.deepEqual(second.failureEventRunIds, [], 'the durable event short-circuits the duplicate');
  const events = await coordinator.listEvents('project-sprout');
  assert.equal(events.length, 1, 'one event per run terminal transition across restarts');
  assert.equal(events[0]?.deliveryKey, 'run-failure:run-42');
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

test('publishRunFailure reports published, duplicate, and skipped distinctly', async () => {
  const run = failedRun();
  const coordinator = harness(streamlessAdmitter([run]));

  assert.equal(await coordinator.publishRunFailure(run), 'published');
  assert.equal(await coordinator.publishRunFailure(run), 'duplicate');
  assert.equal(await coordinator.publishRunFailure({ ...run, status: 'completed' }), 'skipped');
  assert.equal(await coordinator.publishRunFailure(withoutProjectScope(run)), 'skipped');
  assert.equal((await coordinator.listEvents('project-sprout')).length, 1);
});
