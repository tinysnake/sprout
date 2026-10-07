/**
 * End-to-end wake-model-assisted routing over durable storage (#97).
 *
 * The full chain runs through the real RunOrchestrator and the scripted
 * engine on a real SQLite file: eligible unaddressed inputs collect into a
 * window, the frozen batch is judged, the coalesced wake admits exactly one
 * run, and the run's reply lands back on the Project channel — without
 * re-entering the window. Direct conversations keep their deterministic
 * route, and Working-group routing keeps the participant bounds from #96.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter, type ScriptedTurn } from '../engine/scripted.ts';
import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { buildCollaborationScopes } from './scope-harness.ts';
import { CollaborationCoordinator } from './coordinator.ts';
import { SqliteCollaborationStore } from './sqlite-store.ts';
import type { RoutingModelPort } from './routing.ts';

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
    { agentId: 'agent-scout', responsibilities: ['Investigate'], collaborationInstructions: '' },
    { agentId: 'agent-forge', responsibilities: ['Build'], collaborationInstructions: '' },
  ],
};

function completedTurn(text: string): ScriptedTurn {
  return { events: [{ type: 'message', text, final: true }], result: { status: 'completed', text } };
}

function modelSelecting(agentId: string): RoutingModelPort {
  return {
    id: 'integration-model',
    async judge(request) {
      const inputIds = [...request.context.matchAll(/\[input \d+ \| id=([^ |]+) \|/g)].map(
        (match) => match[1]!,
      );
      return JSON.stringify({
        selections: [{ agentId, inputIds, rationale: `${agentId} owns these inputs.` }],
        suppressions: [],
      });
    },
  };
}

interface Harness {
  readonly coordinator: CollaborationCoordinator;
  readonly store: SqliteCollaborationStore;
  readonly engine: ScriptedEngineAdapter;
  readonly scopes: Awaited<ReturnType<typeof buildCollaborationScopes>>;
  readonly channelScopeId: string;
  now: number;
}

async function openHarness(
  store: SqliteCollaborationStore,
  model: RoutingModelPort,
): Promise<Harness> {
  const engine = new ScriptedEngineAdapter({ turns: [completedTurn('Scout: handled it.')] });
  const projects = new ProjectRegistry([project]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', engine]]),
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
      { id: 'agent-forge', name: 'Forge', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
  });
  const scopes = buildCollaborationScopes({
    projects,
    wakePolicy: 'wake-model-assisted',
    routingIntervalMs: 30_000,
  });
  const channelScopeId = await scopes.channel(project.id);
  const clock: { now: number } = { now: 0 };
  const coordinator = new CollaborationCoordinator({
    scopes: scopes.scopes,
    store,
    runs: orchestrator,
    routingModel: model,
    clock: { now: () => clock.now },
  });
  return {
    coordinator,
    store,
    engine,
    scopes,
    channelScopeId,
    get now() {
      return clock.now;
    },
    set now(value: number) {
      clock.now = value;
    },
  };
}

test('the full assisted chain: inputs → window → batch → one wake → run → channel reply', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-routing-e2e-'));
  const path = join(directory, 'store.db');
  const store = new SqliteCollaborationStore({ filename: path });
  try {
    const harness = await openHarness(store, modelSelecting('agent-scout'));
    const first = await harness.coordinator.deliver({
      scopeId: harness.channelScopeId,
      author: { id: 'operator', kind: 'human' },
      body: 'first unaddressed ask',
      deliveryKey: 'e2e-1',
    });
    const second = await harness.coordinator.deliver({
      scopeId: harness.channelScopeId,
      author: { id: 'human-lead', kind: 'human' },
      body: 'second unaddressed ask',
      deliveryKey: 'e2e-2',
    });
    assert.equal(first.wakes.length, 0);
    assert.equal(second.wakes.length, 0);
    assert.equal(harness.engine.requests.length, 0, 'the window alone never wakes an Agent');

    harness.now = 30_000;
    await harness.coordinator.sweepRouting();

    // Exactly one run, receiving both inputs chronologically.
    assert.equal(harness.engine.requests.length, 1, 'one coalesced run per selected Agent');
    const prompt = harness.engine.sessions[0]?.prompts[0] ?? '';
    const firstAt = prompt.indexOf(first.message.id);
    const secondAt = prompt.indexOf(second.message.id);
    assert.ok(firstAt >= 0 && secondAt >= 0, 'the run receives both assigned inputs');
    assert.ok(firstAt < secondAt, 'in chronological order');

    // The reply lands on the Project channel and never re-enters a window.
    const channelMessages = await harness.coordinator.listMessages({
      scopeId: harness.channelScopeId,
    });
    const reply = channelMessages.find((message) => message.author.kind === 'agent');
    assert.ok(reply, 'the batch reply was projected');
    assert.equal(reply.author.id, 'agent-scout');
    assert.equal(reply.body, 'Scout: handled it.');
    assert.equal(
      (await harness.coordinator.listRoutingWindows(project.id)).length,
      1,
      'the reply bypassed collection: still exactly the original window',
    );
    assert.equal(
      (await harness.coordinator.listRoutingWindows(project.id))[0]!.inputCount,
      2,
      'only the two original inputs were collected',
    );

    // The complete human-inspectable evidence chain.
    const batches = await harness.coordinator.listRoutingBatches(project.id);
    assert.equal(batches.length, 1);
    const evidence = await harness.coordinator.getRoutingBatchEvidence(batches[0]!.id);
    assert.ok(evidence);
    assert.equal(evidence.window?.inputCount, 2);
    assert.equal(evidence.inputs.length, 2);
    assert.equal(evidence.attempts.length, 1);
    assert.equal(evidence.attempts[0]?.status, 'succeeded');
    assert.deepEqual(
      evidence.outcomes.map((outcome) => outcome.status),
      ['selected', 'selected'],
    );
    assert.equal(evidence.wakes.length, 1, 'at most one WakeRequest per selected Agent');
    assert.equal(evidence.wakes[0]?.idempotencyKey, `${batches[0]!.id}:agent-scout`);
    assert.equal(evidence.replies.length, 1, 'the projected reply is part of the evidence');
    assert.equal(evidence.replies[0]?.messageId, reply.id);

    const inputEvidence = await harness.coordinator.routingEvidenceForInput(first.message.id);
    assert.ok(inputEvidence);
    assert.equal(inputEvidence.window?.id, batches[0]!.windowId);
    assert.equal(inputEvidence.batches.length, 1);
    assert.equal(inputEvidence.deterministicWakes.length, 0);
    assert.equal(inputEvidence.observations.length, 0, 'a routed input needs no suppressed note');

    // Restart-safe: a fresh reconcile pass changes nothing.
    const runsBefore = harness.engine.requests.length;
    await harness.coordinator.reconcile();
    assert.equal(harness.engine.requests.length, runsBefore, 'no duplicate run on reconcile');
    assert.equal(
      (await harness.coordinator.listMessages({ scopeId: harness.channelScopeId })).filter(
        (message) => message.author.kind === 'agent',
      ).length,
      1,
      'no duplicate reply on reconcile',
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('direct conversations keep their deterministic route and never collect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-routing-dm-'));
  const store = new SqliteCollaborationStore({ filename: join(directory, 'store.db') });
  try {
    const harness = await openHarness(store, modelSelecting('agent-scout'));
    const directScopeId = await harness.scopes.openDirect('project-sprout', [
      'operator',
      'agent-scout',
    ]);
    const delivered = await harness.coordinator.deliver({
      scopeId: directScopeId,
      author: { id: 'operator', kind: 'human' },
      body: 'direct status question',
      recipients: ['agent-scout'],
      deliveryKey: 'dm-e2e-1',
    });
    assert.equal(delivered.wakes.length, 1, 'a direct recipient wakes deterministically');
    assert.equal(delivered.wakes[0]?.reason, 'direct-recipient');
    assert.equal(delivered.admittedRunIds.length, 1);
    assert.deepEqual(
      await harness.coordinator.listRoutingWindows(project.id),
      [],
      'direct Messages never enter a routing window (ADR-0007 privacy boundary)',
    );
    const replies = (await harness.coordinator.listMessages({ scopeId: directScopeId })).filter(
      (message) => message.author.kind === 'agent',
    );
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.inReplyTo, delivered.message.id);

    const evidence = await harness.coordinator.routingEvidenceForInput(delivered.message.id);
    assert.ok(evidence);
    assert.equal(evidence.window, undefined);
    assert.equal(evidence.batches.length, 0);
    assert.equal(evidence.deterministicWakes.length, 1, 'the deterministic wake is the evidence');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Working-group inputs keep the #96 participant bounds inside the batch path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-routing-wg-'));
  const store = new SqliteCollaborationStore({ filename: join(directory, 'store.db') });
  try {
    const harness = await openHarness(store, modelSelecting('agent-forge'));
    const group = await harness.scopes.scopes.createWorkingGroup({
      projectId: project.id,
      displayName: 'Core Crew',
      creator: { memberId: 'operator', kind: 'human' },
      memberIds: ['agent-scout'],
      goal: 'Owned by the group.',
    });

    // A mention inside the group cannot reach an Agent outside the group: the
    // deterministic route fails durably per target and opens no window.
    const mentioned = await harness.coordinator.deliver({
      scopeId: group.id,
      author: { id: 'operator', kind: 'human' },
      body: '@agent-forge are you in this group?',
      deliveryKey: 'wg-mention-1',
    });
    const forgeFailure = (
      await harness.coordinator.listObservations(mentioned.message.id)
    ).find((observation) => observation.agentId === 'agent-forge');
    assert.ok(forgeFailure, 'the invalid target fails durably and visibly, not silently');
    assert.equal(forgeFailure.status, 'failed');
    assert.equal(forgeFailure.reason, 'agent-mention');
    assert.equal(mentioned.wakes.length, 0, 'no valid target woke');
    assert.deepEqual(await harness.coordinator.listRoutingWindows(project.id), []);

    // An unaddressed group message collects, and the frozen manifest's
    // candidate set is gated to current group participants.
    const unaddressed = await harness.coordinator.deliver({
      scopeId: group.id,
      author: { id: 'operator', kind: 'human' },
      body: 'the group needs to pick this up',
      deliveryKey: 'wg-unaddressed-1',
    });
    harness.now = 30_000;
    await harness.coordinator.sweepRouting();

    const batches = await harness.coordinator.listRoutingBatches(project.id);
    assert.equal(batches.length, 1);
    const evidence = await harness.coordinator.getRoutingBatchEvidence(batches[0]!.id);
    assert.ok(evidence);
    assert.deepEqual(
      evidence.batch.manifest.inputs[0]?.candidates,
      ['agent-scout'],
      'candidates are the current group participants; outsiders and the author are excluded',
    );

    // The model tried to select an outsider: both attempts failed closed.
    assert.equal(batches[0]!.status, 'failed');
    const attempts = await harness.store.listRoutingAttempts(batches[0]!.id);
    assert.deepEqual(
      attempts.map((attempt) => attempt.errorKind),
      ['unknown-agent', 'unknown-agent'],
    );
    const outcomes = await harness.store.listRoutingOutcomes(batches[0]!.id);
    assert.equal(outcomes[0]?.inputId, unaddressed.message.id);
    assert.equal(outcomes[0]?.status, 'failed', 'a visible per-input outcome, never silent');
    assert.deepEqual(
      (await harness.coordinator.listWakeRequests()).filter(
        (wake) => wake.batchId === batches[0]!.id,
      ),
      [],
      'failing closed wakes nobody outside the participant bounds',
    );
    assert.equal(harness.engine.requests.length, 0, 'the mention attempt admitted no run either');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
