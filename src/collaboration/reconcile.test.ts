/**
 * Restart reconciliation for the collaboration write path (#26).
 *
 * The gap this covers is the one the #25 prototype recorded as residual: a core
 * process can die after a run completed but before its reply was projected, and
 * a wake can be persisted but never admitted. Both are recoverable from durable
 * state, and both must recover **idempotently** — a restart may not duplicate a
 * run or a reply.
 *
 * These tests use a real SQLite file and reopen it, so "restart" means a fresh
 * store and coordinator over the same on-disk state, not a simulated flag.
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
import type { AgentRun } from '../run/model.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { SqliteStore } from '../store/db.ts';
import { CollaborationCoordinator } from './coordinator.ts';
import type { Message } from './model.ts';

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = {
  id: 'mac-mini-1',
  definitionId: 'macos-workstation',
  workingDirectory: '/srv/work',
};
const project: Project = {
  id: 'project-sprout',
  goal: 'Ship Sprout',
  rules: [],
  availableEnvironmentInstanceIds: ['mac-mini-1'],
  memberships: [
    { agentId: 'scout', responsibilities: [], collaborationInstructions: '' },
  ],
};

function completedTurn(text: string): ScriptedTurn {
  return {
    events: [{ type: 'message', text, final: true }],
    result: { status: 'completed', text },
  };
}

interface Harness {
  readonly sqlite: SqliteStore;
  readonly projects: ProjectRegistry;
  readonly coordinator: CollaborationCoordinator;
  readonly orchestrator: RunOrchestrator;
}

/**
 * Build a coordinator over an existing database file.
 *
 * Called twice over the same path to model a restart. The scripted engine is
 * fresh each time, exactly as a new process would have one.
 */
function reopen(filename: string, turns: readonly ScriptedTurn[] = []): Harness {
  const sqlite = new SqliteStore({ filename });
  const engine = new ScriptedEngineAdapter({ turns });
  const projects = new ProjectRegistry([project]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', engine]]),
    agents: new AgentRegistry([
      {
        id: 'scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/srv/work',
      },
    ]),
    projects,
    pool: new EnvironmentPool({
      definitions: [definition],
      instances: [instance],
      store: sqlite.leases,
    }),
    store: sqlite.runs,
  });
  const coordinator = new CollaborationCoordinator({
    projects,
    store: sqlite.collaboration,
    runs: orchestrator,
  });
  return { sqlite, projects, coordinator, orchestrator };
}

function inputMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-input',
    projectId: 'project-sprout',
    channel: 'direct',
    author: { id: 'human-lead', kind: 'human' },
    body: 'status?',
    recipients: ['scout'],
    deliveryKey: 'delivery-1',
    createdAt: 1,
    ...overrides,
  };
}

function completedRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    agentId: 'scout',
    prompt: 'status?',
    environmentInstanceId: 'mac-mini-1',
    projectId: 'project-sprout',
    status: 'completed',
    events: [],
    result: { status: 'completed', text: 'All clear.' },
    createdAt: 1,
    completedAt: 2,
    ...overrides,
  };
}

/**
 * Seed the exact state a crash can leave behind: a durable input, an admitted
 * wake naming a completed run, and no reply. This is the state the #25
 * prototype's residual gap described, written directly so the test does not
 * depend on winning a race.
 */
async function seedUnprojectedCompleteRun(sqlite: SqliteStore): Promise<void> {
  const message = inputMessage();
  await sqlite.collaboration.postMessage({
    message,
    plan: {
      messageId: message.id,
      decisions: [{ agentId: 'scout', reason: 'direct-recipient' }],
      observations: [],
    },
    now: 1,
  });
  await sqlite.collaboration.admitWake({
    idempotencyKey: 'msg-input:scout',
    runId: 'run-1',
    now: 2,
  });
  await sqlite.runs.save(completedRun());
}

function withDatabase(run: (filename: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-collab-reconcile-'));
  const filename = join(directory, 'sprout.db');
  return run(filename).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test('a completed run whose reply was lost to a restart is projected on reconcile', async () => {
  await withDatabase(async (filename) => {
    const crashed = reopen(filename);
    await seedUnprojectedCompleteRun(crashed.sqlite);
    crashed.sqlite.close();

    // A fresh process over the same database: the run result is durable, the
    // reply is not, and reconciliation must reconstruct exactly one.
    const restarted = reopen(filename);
    try {
      assert.equal(
        (await restarted.sqlite.collaboration.listMessages()).length,
        1,
        'only the input is durable before reconciliation',
      );

      const result = await restarted.coordinator.reconcile();
      assert.deepEqual(result.projectedMessageIds, ['msg-input']);

      const messages = await restarted.sqlite.collaboration.listMessages();
      const replies = messages.filter((message) => message.author.kind === 'agent');
      assert.equal(replies.length, 1, 'exactly one projected reply');
      assert.equal(replies[0]?.author.id, 'scout');
      assert.equal(replies[0]?.body, 'All clear.');
      assert.equal(replies[0]?.inReplyTo, 'msg-input');
    } finally {
      restarted.sqlite.close();
    }
  });
});

test('reconciliation is idempotent: a second pass neither re-admits nor re-projects', async () => {
  await withDatabase(async (filename) => {
    const crashed = reopen(filename);
    await seedUnprojectedCompleteRun(crashed.sqlite);
    crashed.sqlite.close();

    const restarted = reopen(filename);
    try {
      const first = await restarted.coordinator.reconcile();
      assert.equal(first.projectedMessageIds.length, 1);
      const second = await restarted.coordinator.reconcile();
      assert.deepEqual(second, { admittedRunIds: [], projectedMessageIds: [] });

      const replies = (await restarted.sqlite.collaboration.listMessages()).filter(
        (message) => message.author.kind === 'agent',
      );
      assert.equal(replies.length, 1, 'a repeated pass posts no second reply');
    } finally {
      restarted.sqlite.close();
    }
  });
});

test('a pending wake persisted before a crash is admitted on reconcile', async () => {
  await withDatabase(async (filename) => {
    const crashed = reopen(filename);
    const message = inputMessage({ id: 'msg-pending', deliveryKey: 'delivery-pending' });
    await crashed.sqlite.collaboration.postMessage({
      message,
      plan: {
        messageId: message.id,
        decisions: [{ agentId: 'scout', reason: 'direct-recipient' }],
        observations: [],
      },
      now: 1,
    });
    crashed.sqlite.close();

    const restarted = reopen(filename, [completedTurn('Recovered.')]);
    try {
      const result = await restarted.coordinator.reconcile();
      assert.equal(result.admittedRunIds.length, 1, 'the pending wake admitted a run');
      assert.deepEqual(result.projectedMessageIds, ['msg-pending']);

      const wake = await restarted.sqlite.collaboration.getWakeRequest('msg-pending:scout');
      assert.equal(wake?.status, 'admitted');
      assert.equal(wake?.runId, result.admittedRunIds[0]);

      const replies = (await restarted.sqlite.collaboration.listMessages()).filter(
        (candidate) => candidate.author.kind === 'agent',
      );
      assert.equal(replies.length, 1);
      assert.equal(replies[0]?.body, 'Recovered.');
    } finally {
      restarted.sqlite.close();
    }
  });
});

test('a run a restart settled as failed produces no reply during reconcile', async () => {
  await withDatabase(async (filename) => {
    const crashed = reopen(filename);
    await seedUnprojectedCompleteRun(crashed.sqlite);
    crashed.sqlite.close();

    // The restarted orchestrator marks the in-flight run failed before
    // reconciliation, exactly as `main.ts` orders it. Reconciliation then sees a
    // failed run and must not fabricate an answer.
    const restarted = reopen(filename);
    try {
      const stored = await restarted.sqlite.runs.get('run-1');
      assert.ok(stored);
      await restarted.sqlite.runs.save({
        ...stored,
        status: 'failed',
        failure: 'interrupted by a Sprout restart before this run finished',
        result: {
          status: 'failed',
          message: 'interrupted by a Sprout restart before this run finished',
        },
      });

      const result = await restarted.coordinator.reconcile();
      assert.deepEqual(result.projectedMessageIds, []);
      const replies = (await restarted.sqlite.collaboration.listMessages()).filter(
        (message) => message.author.kind === 'agent',
      );
      assert.equal(replies.length, 0, 'a failed run never yields a reply');
    } finally {
      restarted.sqlite.close();
    }
  });
});

test('an interrupted run produces no reply during reconcile', async () => {
  await withDatabase(async (filename) => {
    const crashed = reopen(filename);
    await seedUnprojectedCompleteRun(crashed.sqlite);
    crashed.sqlite.close();

    const restarted = reopen(filename);
    try {
      const stored = await restarted.sqlite.runs.get('run-1');
      assert.ok(stored);
      await restarted.sqlite.runs.save({
        ...stored,
        status: 'interrupted',
        result: { status: 'interrupted' },
      });

      const result = await restarted.coordinator.reconcile();
      assert.deepEqual(result.projectedMessageIds, []);
      const replies = (await restarted.sqlite.collaboration.listMessages()).filter(
        (message) => message.author.kind === 'agent',
      );
      assert.equal(replies.length, 0);
    } finally {
      restarted.sqlite.close();
    }
  });
});

test('a wake naming a run that no longer exists does not abort reconciliation', async () => {
  await withDatabase(async (filename) => {
    const crashed = reopen(filename);
    // An admitted wake whose run record is absent: the input and the wake are
    // durable, but there is nothing to project from. Reconciliation must treat it
    // as "no reply", not crash startup or fabricate an answer.
    await crashed.sqlite.collaboration.postMessage({
      message: inputMessage({ id: 'msg-orphan', deliveryKey: 'delivery-orphan' }),
      plan: {
        messageId: 'msg-orphan',
        decisions: [{ agentId: 'scout', reason: 'direct-recipient' }],
        observations: [],
      },
      now: 1,
    });
    await crashed.sqlite.collaboration.admitWake({
      idempotencyKey: 'msg-orphan:scout',
      runId: 'run-gone',
      now: 2,
    });
    crashed.sqlite.close();

    const restarted = reopen(filename);
    try {
      assert.deepEqual(await restarted.coordinator.reconcile(), {
        admittedRunIds: [],
        projectedMessageIds: [],
      });
      const replies = (await restarted.sqlite.collaboration.listMessages()).filter(
        (message) => message.author.kind === 'agent',
      );
      assert.equal(replies.length, 0);
    } finally {
      restarted.sqlite.close();
    }
  });
});

test('a suppressed-only message has no wake to admit or project', async () => {
  await withDatabase(async (filename) => {
    const store = reopen(filename);
    try {
      await store.sqlite.collaboration.postMessage({
        message: inputMessage({ id: 'msg-none', deliveryKey: 'delivery-none' }),
        plan: {
          messageId: 'msg-none',
          decisions: [],
          observations: [
            { agentId: '*', status: 'suppressed', reason: 'wake-model', detail: 'nothing to do' },
          ],
        },
        now: 1,
      });
      // A wake request is never created for a suppressed-only plan, so there is
      // nothing to admit or project: reconciliation must be a no-op, not an error.
      assert.deepEqual(await store.coordinator.reconcile(), {
        admittedRunIds: [],
        projectedMessageIds: [],
      });
      assert.equal(store.sqlite.collaboration.observations('msg-none').length, 1);
    } finally {
      store.sqlite.close();
    }
  });
});
