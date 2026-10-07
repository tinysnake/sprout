/**
 * The additive routing-evidence API contract (#97, ADR-0007).
 *
 * The routes are read-only, return the durable causal chain (windows, frozen
 * batches, attempts, outcomes, wakes, replies), 404 on unknown ids instead of
 * fabricating rows, and expose only portable evidence fields — never a run
 * prompt, engine events, sessions, tool output, host facts, or raw reasoning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { definition, instance, projects } from './api-harness.ts';
import { createRunApi } from './api.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { CollaborationCoordinator } from '../collaboration/coordinator.ts';
import type { RoutingModelPort } from '../collaboration/routing.ts';
import { InMemoryCollaborationStore } from '../collaboration/store.ts';
import { buildCollaborationScopes } from '../collaboration/scope-harness.ts';

const selectScout: RoutingModelPort = {
  id: 'api-routing-model',
  async judge(request) {
    const inputIds = [...request.context.matchAll(/\[input \d+ \| id=([^ |]+) \|/g)].map(
      (match) => match[1]!,
    );
    return JSON.stringify({
      selections: [{ agentId: 'agent-scout', inputIds, rationale: 'The investigator owns these.' }],
      suppressions: [],
    });
  },
};

function buildRoutingApi() {
  const adapter = new ScriptedEngineAdapter({
    turns: [
      {
        events: [
          { type: 'tool-output', text: 'TOOL_OUTPUT_MUST_NOT_LEAK' },
          { type: 'message', text: 'Scout: routed reply.', final: true },
        ],
        result: { status: 'completed', text: 'Scout: routed reply.' },
      },
    ],
  });
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });
  const scopeHarness = buildCollaborationScopes({
    projects,
    wakePolicy: 'wake-model-assisted',
    routingIntervalMs: 30_000,
  });
  const clock: { now: number } = { now: 0 };
  const collaboration = new CollaborationCoordinator({
    scopes: scopeHarness.scopes,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
    routingModel: selectScout,
    clock: { now: () => clock.now },
  });
  const api = createRunApi({
    orchestrator,
    agents: registry,
    collaboration,
    conversationScopes: scopeHarness.scopes,
    projects,
  });
  return {
    api,
    collaboration,
    scopes: scopeHarness,
    advance(ms: number) {
      clock.now += ms;
    },
  };
}

async function withRoutingServer(
  fn: (base: string, context: ReturnType<typeof buildRoutingApi>) => Promise<void>,
): Promise<void> {
  const context = buildRoutingApi();
  const { port } = await context.api.listen(0);
  try {
    await fn(`http://127.0.0.1:${port}`, context);
  } finally {
    await context.api.close();
  }
}

test('the routing API reports the durable window, batch, and per-input causal chain', async () => {
  await withRoutingServer(async (base, context) => {
    const scopeId = await context.scopes.channel('project-sprout');

    // Before any input: empty, well-formed, never fabricated.
    const empty = await (await fetch(`${base}/api/projects/project-sprout/routing-batches`)).json();
    assert.deepEqual(empty, { windows: [], batches: [] });

    // An eligible unaddressed input joins the collection window on delivery.
    const delivered = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scopeId,
          authorId: 'operator',
          authorKind: 'human',
          body: 'please route this',
          deliveryKey: 'routing-api-1',
        }),
      })
    ).json()) as { message: { id: string }; wakes: unknown[] };
    assert.equal(delivered.wakes.length, 0, 'the window alone wakes nobody');

    const listed = (await (
      await fetch(`${base}/api/projects/project-sprout/routing-batches`)
    ).json()) as {
      windows: {
        id: string;
        deadlineAt: number;
        openedAt: number;
        intervalMs: number;
        cursor: string;
        inputCount: number;
        status: string;
      }[];
      batches: { id: string; status: string }[];
    };
    assert.equal(listed.windows.length, 1);
    assert.equal(listed.windows[0]?.inputCount, 1);
    assert.equal(listed.windows[0]?.cursor, delivered.message.id);
    assert.equal(listed.windows[0]?.deadlineAt, listed.windows[0]!.openedAt + 30_000);
    assert.equal(listed.batches.length, 0, 'the window has not elapsed yet');

    // Elapse the fixed window and let the sweep judge it.
    context.advance(30_000);
    await context.collaboration.sweepRouting();

    const after = (await (
      await fetch(`${base}/api/projects/project-sprout/routing-batches`)
    ).json()) as { windows: { status: string }[]; batches: { id: string; status: string }[] };
    assert.equal(after.windows[0]?.status, 'closed');
    assert.equal(after.batches.length, 1);
    assert.equal(after.batches[0]?.status, 'routed');

    // The batch detail carries the whole frozen evidence chain.
    const detail = (await (
      await fetch(`${base}/api/routing-batches/${after.batches[0]!.id}`)
    ).json()) as {
      routingBatch: {
        batch: {
          id: string;
          status: string;
          contextChars: number;
          manifest: { policy: string; exclusions: string[]; inputs: unknown[] };
          bounds: { totalContextChars: number };
        };
        window: { inputCount: number };
        inputs: { inputId: string; truncated: boolean }[];
        attempts: { status: string; modelId: string }[];
        outcomes: { inputId: string; status: string }[];
        wakes: { agentId: string; reason: string }[];
        replies: { messageId: string }[];
      };
    };
    const routed = detail.routingBatch;
    assert.equal(routed.batch.status, 'routed');
    assert.equal(routed.batch.manifest.policy, 'wake-model-assisted');
    assert.ok(routed.batch.manifest.exclusions.length >= 5, 'the privacy boundary is inspectable');
    assert.equal(routed.batch.contextChars > 0, true, 'only the frozen size, not the bytes, is exposed');
    assert.equal(routed.window.inputCount, 1);
    assert.equal(routed.inputs[0]?.inputId, delivered.message.id);
    assert.equal(routed.inputs[0]?.truncated, false);
    assert.deepEqual(
      routed.attempts.map((attempt) => attempt.status),
      ['succeeded'],
    );
    assert.equal(routed.attempts[0]?.modelId, 'api-routing-model');
    assert.deepEqual(
      routed.outcomes.map((outcome) => outcome.status),
      ['selected'],
    );
    assert.equal(routed.wakes[0]?.agentId, 'agent-scout');
    assert.equal(routed.wakes[0]?.reason, 'routing-model');
    assert.equal(routed.replies.length, 1, 'the projected reply is part of the chain');
    const replyId = routed.replies[0]!.messageId;
    assert.match(replyId, /:/, 'a projected reply carries a colon-bearing durable id');
    const replyResponse = await fetch(`${base}/api/messages/${encodeURIComponent(replyId)}/routing`);
    assert.equal(replyResponse.status, 200, 'the encoded reply id resolves to its evidence');
    const replyEvidence = (await replyResponse.json()) as {
      routing: { input: { kind: string; message: { id: string } }; batches: unknown[]; deterministicWakes: unknown[] };
    };
    assert.equal(replyEvidence.routing.input.kind, 'message');
    assert.equal(replyEvidence.routing.input.message.id, replyId);
    assert.deepEqual(replyEvidence.routing.batches, []);
    assert.deepEqual(replyEvidence.routing.deterministicWakes, []);
    assert.equal((await fetch(`${base}/api/messages/${encodeURIComponent(`${replyId}-absent`)}/routing`)).status, 404,
      'an unknown encoded id still returns 404');
    assert.equal((await fetch(`${base}/api/messages/${encodeURIComponent(encodeURIComponent(replyId))}/routing`)).status, 404,
      'one decode is enough; double-encoded ids cannot alias an existing reply');
    assert.equal((await fetch(`${base}/api/messages/%ZZ/routing`)).status, 400,
      'malformed escapes are refused without throwing from the dispatcher');

    // The Message-level causal route: window + batch, no deterministic wakes.
    const evidence = (await (
      await fetch(`${base}/api/messages/${delivered.message.id}/routing`)
    ).json()) as {
      routing: {
        input: { kind: string; message: { id: string } };
        window: { id: string };
        batches: { batch: { id: string } }[];
        deterministicWakes: unknown[];
        observations: unknown[];
      };
    };
    assert.equal(evidence.routing.input.kind, 'message');
    assert.equal(evidence.routing.input.message.id, delivered.message.id);
    assert.equal(evidence.routing.window.id, listed.windows[0]?.id);
    assert.equal(evidence.routing.batches.length, 1);
    assert.deepEqual(evidence.routing.deterministicWakes, []);
    assert.deepEqual(evidence.routing.observations, []);
  });
});

test('routing evidence responses expose only portable facts — never run or host internals', async () => {
  await withRoutingServer(async (base, context) => {
    const scopeId = await context.scopes.channel('project-sprout');
    const delivered = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scopeId,
          authorId: 'operator',
          authorKind: 'human',
          body: 'privacy check',
          deliveryKey: 'routing-api-privacy-1',
        }),
      })
    ).json()) as { message: { id: string } };
    context.advance(30_000);
    await context.collaboration.sweepRouting();

    const routes = [
      `${base}/api/projects/project-sprout/routing-batches`,
      `${base}/api/messages/${delivered.message.id}/routing`,
    ];
    const batches = (await (
      await fetch(`${base}/api/projects/project-sprout/routing-batches`)
    ).json()) as { batches: { id: string }[] };
    routes.push(`${base}/api/routing-batches/${batches.batches[0]!.id}`);

    for (const route of routes) {
      const text = await (await fetch(route)).text();
      assert.ok(!text.includes('TOOL_OUTPUT_MUST_NOT_LEAK'), 'tool output never reaches evidence');
      assert.ok(!text.includes('"prompt"'), 'run prompts are never exposed');
      assert.ok(!text.includes('"events"'), 'engine/run events are never exposed');
      assert.ok(!text.includes('resumeSessionKey'), 'engine sessions are never exposed');
      assert.ok(!text.includes('/srv/'), 'workspace/host paths are never exposed');
      assert.ok(
        !text.includes('/tmp'),
        'the fixture working directory never reaches evidence either — prompts stay internal',
      );
      // The context bytes themselves are not exposed — only their size.
      if (route.includes('routing-batches/bat')) {
        const parsed = JSON.parse(text) as { routingBatch: { batch: { manifest: Record<string, unknown> } } };
        assert.equal('context' in parsed.routingBatch.batch, false, 'frozen context is not served raw');
      }
    }

    // A deterministic (direct) input is served through the same route shape.
    const directScope = await context.scopes.openDirect('project-sprout', ['operator', 'agent-scout']);
    const direct = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scopeId: directScope,
          authorId: 'operator',
          authorKind: 'human',
          body: 'direct',
          recipients: ['agent-scout'],
          deliveryKey: 'routing-api-dm-1',
        }),
      })
    ).json()) as { message: { id: string } };
    const directEvidence = (await (
      await fetch(`${base}/api/messages/${direct.message.id}/routing`)
    ).json()) as {
      routing: { window?: unknown; batches: unknown[]; deterministicWakes: { agentId: string }[] };
    };
    assert.equal(directEvidence.routing.window, undefined, 'direct inputs never collect');
    assert.deepEqual(directEvidence.routing.batches, []);
    assert.equal(directEvidence.routing.deterministicWakes[0]?.agentId, 'agent-scout');
  });
});

test('unknown routing ids 404 and the evidence routes accept no commands', async () => {
  await withRoutingServer(async (base) => {
    const missing = await fetch(`${base}/api/routing-batches/bat-ghost`);
    assert.equal(missing.status, 404);
    assert.match((await missing.text()) as string, /unknown routing batch/);

    const missingMessage = await fetch(`${base}/api/messages/msg-ghost/routing`);
    assert.equal(missingMessage.status, 404);
    assert.match((await missingMessage.text()) as string, /unknown message/);

    const missingEvent = await fetch(`${base}/api/project-events/evt-ghost/routing`);
    assert.equal(missingEvent.status, 404);
    assert.match((await missingEvent.text()) as string, /unknown project event/);

    // No routing controls exist in the MVP: these are read-only GETs.
    for (const [path, body] of [
      ['/api/routing-batches/bat-ghost', { action: 'route-now' }],
      ['/api/projects/project-sprout/routing-batches', { action: 'sweep' }],
      ['/api/messages/msg-ghost/routing', { action: 'retry' }],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.ok(response.status >= 400, `POST ${path} is never accepted`);
    }
  });
});
