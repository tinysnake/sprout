/**
 * The ticket #25 probe: one addressed collaboration input produces one durable
 * Agent-authored reply through the selected engine-neutral write path, across a
 * **real Sprout worker process boundary**, with persistence-before-wake and an
 * idempotent retry.
 *
 * What is real here and what is faked, stated explicitly (the ticket permits a
 * fake engine but not a faked worker/persistence pair):
 *
 * - **Real worker process.** The worker is a separate OS process reached over a
 *   loopback TCP endpoint by `EndpointCarrier`, exactly as production reaches a
 *   local macOS environment. It hosts the scripted engine adapter, which is the
 *   permitted fake engine: it isolates the transport question from any model.
 * - **Real core run orchestration.** `RunOrchestrator` resolves the project's
 *   environment, acquires a lease, starts a session through the worker, streams
 *   the turn, and settles the run.
 * - **Real SQLite persistence.** Messages, wake requests, observations, runs,
 *   and leases all go through `SqliteCollaborationStore` / `SqliteStore` on a
 *   real database file, not the in-memory store.
 * - **Real collaboration coordinator.** The selected write path — automatic
 *   final-result projection — is exercised unmodified.
 *
 * The probe is a test rather than a script so it runs in `npm test`, and it
 * writes its database to a temporary file that is deleted afterwards. No local
 * identity, host path, or network detail is printed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { SqliteStore } from '../run/sqlite-store.ts';
import { EndpointCarrier, type WorkerConnection } from '../worker/carrier.ts';
import { CollaborationCoordinator } from './coordinator.ts';
import { SqliteCollaborationStore } from './sqlite-store.ts';

/**
 * A worker process definition hosting the scripted engine.
 *
 * Mirrors `src/worker/carrier.test.ts`'s worker script: one scripted turn that
 * emits a tool call and a final message. The final message is the only thing the
 * selected write path projects, so it is the "one durable Agent-authored reply".
 */
function workerScript(): string {
  const workerServer = new URL('../worker/server.ts', import.meta.url).pathname;
  const scripted = new URL('../engine/scripted.ts', import.meta.url).pathname;
  const carrier = new URL('../worker/carrier.ts', import.meta.url).pathname;
  const scriptedClass = 'ScriptedEngineAdapter';
  return `
    import { ScriptedEngineAdapter } from ${JSON.stringify(scripted)};
    import { EnvironmentWorker } from ${JSON.stringify(workerServer)};
    import { serveWorkerEndpoint, WORKER_READY_PREFIX } from ${JSON.stringify(carrier)};
    const engines = new Map([['scripted', new ${scriptedClass}({ turns: [
      { events: [
        { type: 'tool-call', name: 'shell', detail: 'grep -r wake src' },
        { type: 'tool-output', text: 'TOOL_OUTPUT_MUST_NOT_LEAK' },
        { type: 'notice', text: 'PRIVATE_REASONING_MUST_NOT_LEAK' },
        { type: 'message', text: 'Scout here: the wake contract prefers an extra wake.', final: true },
      ], result: { status: 'completed', text: 'Scout here: the wake contract prefers an extra wake.' } },
    ] })]]);
    const endpoint = await serveWorkerEndpoint({
      serve: (socket) => { new EnvironmentWorker({
        environmentInstanceId: 'probe-macos', engines, input: socket, output: socket,
      }); socket.on('error', () => undefined); },
    });
    process.stdout.write(WORKER_READY_PREFIX + JSON.stringify({ host: endpoint.ready.host, port: endpoint.ready.port }) + '\\n');
  `;
}

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = {
  id: 'probe-macos',
  definitionId: 'macos-workstation',
  workingDirectory: '/sprout-work',
};
const project: Project = {
  id: 'project-sprout',
  goal: 'Ship Sprout',
  rules: [],
  availableEnvironmentInstanceIds: ['probe-macos'],
  memberships: [
    { agentId: 'scout', responsibilities: [], collaborationInstructions: '' },
  ],
};

interface Probe {
  readonly connection: WorkerConnection;
  readonly coordinator: CollaborationCoordinator;
  readonly store: SqliteCollaborationStore;
  readonly sqlite: SqliteStore;
  readonly dbPath: string;
  close(): Promise<void>;
}

/**
 * Build the probe: a real worker process, a real SQLite database, and the
 * coordinator wired to a real `RunOrchestrator`.
 */
async function startProbe(): Promise<Probe> {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-collab-probe-'));
  const dbPath = join(directory, 'probe.db');

  const connection = await EndpointCarrier.start({
    command: process.execPath,
    args: ['--input-type=module', '-e', workerScript()],
    label: 'collab-probe-worker',
    readyTimeoutMs: 20_000,
  });

  const sqlite = new SqliteStore({ filename: dbPath });
  const store = new SqliteCollaborationStore({ db: sqlite.db });
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    store: sqlite.leases,
  });
  const projects = new ProjectRegistry([project]);
  const orchestrator = new RunOrchestrator({
    // A function, exactly as production: adapters are resolved for the instance
    // the run resolved and leased, and they come from the worker process.
    engines: async () => connection.adapters,
    agents: new AgentRegistry([
      {
        id: 'scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/sprout-work',
        instructions: 'You are Scout.',
      },
    ]),
    projects,
    pool,
    store: sqlite.runs,
    leaseTtlMs: 60_000,
  });

  const coordinator = new CollaborationCoordinator({
    projects,
    store,
    runs: orchestrator,
  });

  return {
    connection,
    coordinator,
    store,
    sqlite,
    dbPath,
    close: async () => {
      await connection.close();
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Open an independent connection to the same file, to prove data is on disk. */
function readFromDisk<T>(dbPath: string, query: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(dbPath);
  try {
    // `node:sqlite` returns null-prototype rows; spread them so assertions
    // compare plain objects.
    return (db.prepare(query).all(...params) as unknown as T[]).map(
      (row) => ({ ...(row as object) }) as T,
    );
  } finally {
    db.close();
  }
}

test('one addressed input produces one durable Agent-authored reply across a real worker process', async (t) => {
  const probe = await startProbe();
  t.after(() => probe.close());

  assert.notEqual(probe.connection.info.pid, process.pid, 'the worker is a different process');

  const delivered = await probe.coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'What does the wake contract prefer?',
    recipients: ['scout'],
    deliveryKey: 'delivery-1',
  });

  // Persistence-before-wake: the input and its wake request are durable, and the
  // wake names the run it admitted.
  assert.equal(delivered.duplicate, false);
  assert.equal(delivered.wakes.length, 1);
  assert.equal(delivered.admittedRunIds.length, 1);
  const wake = delivered.wakes[0]!;
  assert.equal(wake.agentId, 'scout');
  assert.equal(wake.reason, 'direct-recipient');
  assert.equal(wake.status, 'admitted');
  const runId = delivered.admittedRunIds[0]!;
  assert.equal(wake.runId, runId);

  // The run really executed through the worker process; its final text is the reply.
  const run = await probeRun(probe, runId);
  assert.equal(run.status, 'completed');

  const replies = (await probe.store.listMessages()).filter(
    (message) => message.author.kind === 'agent',
  );
  assert.equal(replies.length, 1, 'exactly one Agent-authored reply');
  const reply = replies[0]!;
  assert.equal(reply.author.id, 'scout');
  assert.equal(reply.inReplyTo, delivered.message.id);
  assert.match(reply.body, /the wake contract prefers an extra wake/);

  // Private run events and raw reasoning are excluded from the reply.
  assert.doesNotMatch(reply.body, /TOOL_OUTPUT_MUST_NOT_LEAK/);
  assert.doesNotMatch(reply.body, /PRIVATE_REASONING_MUST_NOT_LEAK/);
  for (const event of run.events) {
    if (event.type === 'tool-output' || event.type === 'notice') {
      assert.ok(
        !reply.body.includes(event.text),
        'a private run event never becomes conversation',
      );
    }
  }

  // Everything is on disk, readable by an independent connection.
  const messageRows = readFromDisk<{ id: string }>(
    probe.dbPath,
    'SELECT id FROM collaboration_messages',
  );
  assert.equal(messageRows.length, 2, 'the input and the reply are both durable');
  const wakeRows = readFromDisk<{ status: string; run_id: string }>(
    probe.dbPath,
    'SELECT status, run_id FROM collaboration_wake_requests',
  );
  assert.deepEqual(wakeRows, [{ status: 'admitted', run_id: runId }]);
});

test('a duplicate delivery key produces one durable input and at most one wake admission', async (t) => {
  const probe = await startProbe();
  t.after(() => probe.close());

  const request = {
    projectId: 'project-sprout',
    channel: 'direct' as const,
    author: { id: 'human-lead', kind: 'human' as const },
    body: 'Do the thing.',
    recipients: ['scout'],
    deliveryKey: 'delivery-retry',
  };

  const first = await probe.coordinator.deliver(request);
  const second = await probe.coordinator.deliver(request);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true, 'the retry is recognised as a duplicate');
  assert.equal(second.message.id, first.message.id, 'the same durable input is reused');
  assert.equal(second.admittedRunIds.length, 0, 'the retry admits no run');

  const wakeRows = readFromDisk<{ status: string; run_id: string }>(
    probe.dbPath,
    'SELECT status, run_id FROM collaboration_wake_requests',
  );
  assert.equal(wakeRows.length, 1, 'one durable wake request');
  assert.equal(wakeRows[0]?.status, 'admitted');
  assert.equal(wakeRows[0]?.run_id, first.admittedRunIds[0]);

  const messages = await probe.store.listMessages();
  assert.equal(messages.length, 2, 'one input and one reply, despite two deliveries');
});

test('a lost acknowledgement is recoverable: the wake is durable before its run exists', async (t) => {
  const probe = await startProbe();
  t.after(() => probe.close());

  const delivered = await probe.coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'Answer this even if my client never hears back.',
    recipients: ['scout'],
    deliveryKey: 'delivery-lost-ack',
  });
  const runId = delivered.admittedRunIds[0]!;

  // Simulate the acknowledgement being lost and the caller retrying with the
  // same key: the durable input exists, so no second input or run is created.
  const retried = await probe.coordinator.deliver({
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'Answer this even if my client never hears back.',
    recipients: ['scout'],
    deliveryKey: 'delivery-lost-ack',
  });
  assert.equal(retried.duplicate, true);
  assert.equal(retried.admittedRunIds.length, 0);
  assert.equal(retried.wakes[0]?.runId, runId, 'the durable wake still names its one run');
});

/** Read a run's persisted terminal record from the same durable store. */
async function probeRun(probe: Probe, runId: string) {
  const runs = await probe.sqlite.runs.list();
  const run = runs.find((candidate) => candidate.id === runId);
  assert.ok(run, `run ${runId} was persisted`);
  return run;
}
