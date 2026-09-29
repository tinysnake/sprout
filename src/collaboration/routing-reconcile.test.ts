/**
 * Restart reconciliation for wake-model-assisted routing (#97, ADR-0007).
 *
 * A real SQLite file is opened, closed, and reopened, so every assertion here
 * is a statement about durable state surviving a process restart:
 *
 * - an elapsed collection window is closed and judged after a restart without
 *   dropping its input;
 * - a batch interrupted between freezing and judgement resumes and settles;
 * - a batch wake interrupted before admission is admitted after a restart, and
 *   a second reconcile never duplicates a run, a wake, or a reply.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentRun } from '../run/model.ts';
import { buildCollaborationScopes } from './scope-harness.ts';
import { CollaborationCoordinator, type RunAdmitter } from './coordinator.ts';
import { SqliteCollaborationStore } from './sqlite-store.ts';
import type { RoutingModelPort } from './routing.ts';

const project = {
  id: 'project-sprout',
  goal: 'Ship Sprout',
  rules: ['Report what you observed.'],
  availableEnvironmentInstanceIds: ['mac-mini-1'],
  memberships: [{ agentId: 'scout', responsibilities: ['Investigate'], collaborationInstructions: '' }],
};

/** Select every batch input to the one fixture Agent. */
function selectAllModel(): RoutingModelPort {
  return {
    id: 'restart-model',
    async judge(request) {
      const inputIds = [...request.context.matchAll(/\[input \d+ \| id=([^ |]+) \|/g)].map(
        (match) => match[1]!,
      );
      return JSON.stringify({
        selections: [{ agentId: 'scout', inputIds, rationale: 'The investigator owns these.' }],
        suppressions: [],
      });
    },
  };
}

interface Runs {
  readonly submits: { readonly agentId: string; readonly prompt: string }[];
  readonly admitter: RunAdmitter;
}

function fakeRuns(options: { readonly failSubmit?: boolean } = {}): Runs {
  const submits: { agentId: string; prompt: string }[] = [];
  let runSequence = 0;
  return {
    submits,
    admitter: {
      async submit(request) {
        if (options.failSubmit === true) throw new Error('simulated capacity failure');
        submits.push({ agentId: request.agentId, prompt: request.prompt });
        return { id: `run-${(runSequence += 1)}` };
      },
      async waitFor(runId) {
        return {
          id: runId,
          agentId: 'scout',
          prompt: '',
          environmentInstanceId: 'mac-mini-1',
          status: 'completed',
          events: [],
          createdAt: 0,
          result: { status: 'completed', text: 'acknowledged' },
        } as AgentRun;
      },
    },
  };
}

/**
 * A store that simulates a crash between freezing a window and judging its
 * batch: the freeze succeeds durably, then the next batch read throws once.
 */
class CrashAfterFreezeStore extends SqliteCollaborationStore {
  #armed = false;
  #tripped = false;

  override async freezeRoutingWindow(
    input: Parameters<SqliteCollaborationStore['freezeRoutingWindow']>[0],
  ): ReturnType<SqliteCollaborationStore['freezeRoutingWindow']> {
    const result = await super.freezeRoutingWindow(input);
    this.#armed = true;
    return result;
  }

  override async listRoutingBatches(
    ...args: Parameters<SqliteCollaborationStore['listRoutingBatches']>
  ): ReturnType<SqliteCollaborationStore['listRoutingBatches']> {
    if (this.#armed && !this.#tripped) {
      this.#tripped = true;
      throw new Error('simulated crash after freeze');
    }
    return super.listRoutingBatches(...args);
  }
}

interface Harness {
  readonly coordinator: CollaborationCoordinator;
  readonly store: SqliteCollaborationStore;
  readonly runs: Runs;
  /** The Project's one channel scope (deterministic id, ensured on open). */
  readonly scopeId: string;
  now: number;
}

async function openHarness(
  store: SqliteCollaborationStore,
  options: { readonly model?: RoutingModelPort; readonly failSubmit?: boolean } = {},
): Promise<Harness> {
  const runs = fakeRuns(options.failSubmit === true ? { failSubmit: true } : {});
  const clock: { now: number } = { now: 0 };
  const scopes = buildCollaborationScopes({
    projects: [project],
    wakePolicy: 'wake-model-assisted',
    routingIntervalMs: 60_000,
  });
  const scopeId = await scopes.channel(project.id);
  const coordinator = new CollaborationCoordinator({
    scopes: scopes.scopes,
    store,
    runs: runs.admitter,
    ...(options.model !== undefined ? { routingModel: options.model } : {}),
    clock: { now: () => clock.now },
  });
  return {
    coordinator,
    store,
    runs,
    scopeId,
    get now() {
      return clock.now;
    },
    set now(value: number) {
      clock.now = value;
    },
  };
}

function withPath(run: (path: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-routing-restart-'));
  const path = join(directory, 'store.db');
  return run(path).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

test('an elapsed collection window is judged after a restart without dropping its input', async () => {
  await withPath(async (path) => {
    const first = new SqliteCollaborationStore({ filename: path });
    const before = await openHarness(first, { model: selectAllModel() });
    const delivered = await before.coordinator.deliver({
      scopeId: before.scopeId,
      author: { id: 'operator', kind: 'human' },
      body: 'needs routing after restart',
      deliveryKey: 'restart-1',
    });
    assert.equal((await before.coordinator.listRoutingWindows('project-sprout')).length, 1);
    assert.equal(
      (await before.coordinator.listRoutingBatches('project-sprout')).length,
      0,
      'the window has not elapsed yet; nothing is judged',
    );
    first.close();

    const second = new SqliteCollaborationStore({ filename: path });
    const after = await openHarness(second, { model: selectAllModel() });
    after.now = 120_000;
    await after.coordinator.reconcile();

    const batches = await after.coordinator.listRoutingBatches('project-sprout');
    assert.equal(batches.length, 1, 'the durable window closed into exactly one batch');
    assert.equal(batches[0]!.status, 'routed');
    const outcomes = await second.listRoutingOutcomes(batches[0]!.id);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.inputId),
      [delivered.message.id],
      'the durable input survived the restart and has a visible outcome',
    );
    assert.equal(outcomes[0]?.status, 'selected');
    assert.equal(after.runs.submits.length, 1, 'one run for the selected Agent');
    const wakeBatchIds = (await after.coordinator.listWakeRequests()).filter(
      (wake) => wake.batchId === batches[0]!.id,
    );
    assert.equal(wakeBatchIds.length, 1);
    assert.equal(wakeBatchIds[0]?.status, 'admitted');
    const replies = (await after.coordinator.listMessages({ scopeId: before.scopeId })).filter(
      (message) => message.author.kind === 'agent',
    );
    assert.equal(replies.length, 1, 'the batch reply was projected exactly once');

    // A second reconcile pass changes nothing.
    const again = await after.coordinator.reconcile();
    assert.deepEqual(again.admittedRunIds, []);
    assert.equal(after.runs.submits.length, 1, 'no duplicate run');
    const repliesAfter = (await after.coordinator.listMessages({ scopeId: before.scopeId })).filter(
      (message) => message.author.kind === 'agent',
    );
    assert.equal(repliesAfter.length, 1, 'no duplicate reply');
    second.close();
  });
});

test('a batch frozen by a crashed process resumes, judges, and settles after restart', async () => {
  await withPath(async (path) => {
    const crashing = new CrashAfterFreezeStore({ filename: path });
    const before = await openHarness(crashing, { model: selectAllModel() });
    const delivered = await before.coordinator.deliver({
      scopeId: before.scopeId,
      author: { id: 'operator', kind: 'human' },
      body: 'interrupted mid-route',
      deliveryKey: 'crash-1',
    });
    before.now = 120_000;
    await assert.rejects(
      before.coordinator.sweepRouting(),
      /simulated crash after freeze/,
      'the simulated crash interrupts the sweep after the durable freeze',
    );
    const frozenBatches = await crashing.listRoutingBatches();
    assert.equal(frozenBatches.length, 1);
    assert.equal(frozenBatches[0]!.status, 'frozen', 'the batch is durable but unjudged');
    assert.equal((await crashing.listRoutingAttempts(frozenBatches[0]!.id)).length, 0);
    crashing.close();

    const reopened = new SqliteCollaborationStore({ filename: path });
    const after = await openHarness(reopened, { model: selectAllModel() });
    after.now = 120_000;
    await after.coordinator.reconcile();

    const batches = await reopened.listRoutingBatches();
    assert.equal(batches[0]!.status, 'routed', 'the frozen batch resumed and settled');
    const attempts = await reopened.listRoutingAttempts(batches[0]!.id);
    assert.equal(attempts.length, 1, 'the resumed judgement ran once');
    assert.equal(attempts[0]?.status, 'succeeded');
    const outcomes = await reopened.listRoutingOutcomes(batches[0]!.id);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.inputId),
      [delivered.message.id],
      'the input that survived the crash was judged, not dropped',
    );
    const wakes = (await after.coordinator.listWakeRequests()).filter(
      (wake) => wake.batchId === batches[0]!.id,
    );
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.status, 'admitted');
    assert.equal(after.runs.submits.length, 1);
    reopened.close();
  });
});

test('a batch wake interrupted before admission is admitted after restart, once', async () => {
  await withPath(async (path) => {
    const first = new SqliteCollaborationStore({ filename: path });
    const before = await openHarness(first, { model: selectAllModel(), failSubmit: true });
    await before.coordinator.deliver({
      scopeId: before.scopeId,
      author: { id: 'operator', kind: 'human' },
      body: 'wake admission fails first',
      deliveryKey: 'pending-1',
    });
    before.now = 120_000;
    await before.coordinator.sweepRouting();

    const batches = await first.listRoutingBatches();
    assert.equal(batches[0]!.status, 'routed', 'the judgement settled even though admission failed');
    const wakes = await first.listWakeRequests();
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.status, 'pending', 'the wake waits visibly, never expiring silently');
    assert.equal(before.runs.submits.length, 0);
    first.close();

    const second = new SqliteCollaborationStore({ filename: path });
    const after = await openHarness(second, { model: selectAllModel() });
    after.now = 120_000;
    const result = await after.coordinator.reconcile();

    const wakesAfter = await second.listWakeRequests();
    assert.equal(wakesAfter[0]?.status, 'admitted');
    assert.equal(result.admittedRunIds.length, 1, 'the pending wake was admitted by reconcile');
    assert.equal(after.runs.submits.length, 1, 'exactly one run for the coalesced wake');
    const replies = (await after.coordinator.listMessages({ scopeId: before.scopeId })).filter(
      (message) => message.author.kind === 'agent',
    );
    assert.equal(replies.length, 1);

    const secondPass = await after.coordinator.reconcile();
    assert.deepEqual(secondPass.admittedRunIds, []);
    assert.equal(after.runs.submits.length, 1, 'reconcile never re-runs an admitted wake');
    assert.equal(
      (await after.coordinator.listMessages({ scopeId: before.scopeId })).filter(
        (message) => message.author.kind === 'agent',
      ).length,
      1,
      'reconcile never double-projects a reply',
    );
    second.close();
  });
});
