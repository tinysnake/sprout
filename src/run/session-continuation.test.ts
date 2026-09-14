import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import type { AgentRunEvent } from '../engine/port.ts';
import { AgentRegistry, type AgentDefinition } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';
import { InMemoryRunStore } from './store.ts';
import { InMemorySessionKeyStore } from './session-key-store.ts';
import { RunOrchestrator } from './orchestrator.ts';

/**
 * Cross-run continuation through the durable session-key store.
 *
 * These exercise the core's half of the contract: which key a run is handed and
 * which key it persists. The engine's half (how a real CLI resumes, and how it
 * behaves on a stale key) is documented in #19 and modelled by the scripted
 * fake's `knownSessionKeys`/`staleResumeKey` options.
 */

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

/**
 * The project that grants Scout its environment access (O5, #18).
 *
 * An agent names no environment instance: a run's instance comes from the
 * project it is a member of, so the instance dimension of the session-key
 * identity is a membership fact rather than an agent fact. The primary project
 * grants `mac-mini-1`; a test that needs another instance changes the pool set
 * here instead of the agent.
 */
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-sprout',
    goal: 'Continue a conversation across runs',
    rules: ['Stay inside the working directory'],
    availableEnvironmentInstanceIds: ['mac-mini-1'],
    memberships: [
      {
        agentId: 'agent-scout',
        responsibilities: ['Run the task'],
        collaborationInstructions: 'Report what you observed',
      },
    ],
    ...overrides,
  };
}

const events: readonly AgentRunEvent[] = [{ type: 'message', text: 'done', final: true }];
const completed = { status: 'completed', text: 'done' } as const;

function build(options: {
  agent?: Partial<AgentDefinition>;
  turns?: ConstructorParameters<typeof ScriptedEngineAdapter>[0]['turns'];
  knownSessionKeys?: readonly string[];
  staleResumeKey?: 'fresh' | 'fail' | 'fail-turn';
  failStart?: string;
  sessionKeys?: InMemorySessionKeyStore;
  store?: InMemoryRunStore;
  projects?: readonly Project[];
  instances?: readonly EnvironmentInstance[];
}) {
  const agent: AgentDefinition = {
    id: 'agent-scout',
    name: 'Scout',
    engine: 'scripted',
    capability: 'agent-run',
    // No environment instance on the agent (#18): the project decides which
    // pool instance a run resolves to. This value is only the fallback working
    // directory for an instance that declares none, which is exactly the
    // dimension the directory test varies.
    workingDirectory: '/srv/work',
    ...options.agent,
  };
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: options.instances ?? [
      instance,
      { id: 'mac-mini-2', definitionId: 'macos-workstation' },
      { id: 'other-def', definitionId: 'some-other-definition' },
    ],
    clock: { now: () => 1_000 },
  });
  const adapter = new ScriptedEngineAdapter({
    turns: options.turns ?? [{ events, result: completed }],
    ...(options.failStart !== undefined ? { failStart: options.failStart } : {}),
    ...(options.knownSessionKeys !== undefined
      ? { knownSessionKeys: options.knownSessionKeys }
      : {}),
    ...(options.staleResumeKey !== undefined ? { staleResumeKey: options.staleResumeKey } : {}),
  });
  const sessionKeys = options.sessionKeys ?? new InMemorySessionKeyStore();
  const store = options.store ?? new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: new AgentRegistry([agent]),
    projects: new ProjectRegistry(options.projects ?? [project()]),
    pool,
    store,
    sessionKeys,
    leaseTtlMs: 60_000,
    clock: { now: () => 5_000 },
  });
  return { orchestrator, adapter, sessionKeys, store, agent };
}

test("the second run receives the first run's engine session key", async () => {
  // No `knownSessionKeys`: the fake accepts any supplied key, i.e. a healthy resume.
  const { orchestrator, adapter } = build({});

  const first = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'one' });
  await orchestrator.waitFor(first.id);
  const second = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'two' });
  await orchestrator.waitFor(second.id);

  assert.equal(adapter.requests.length, 2, 'each run is its own bounded activation');
  const firstKey = adapter.sessions[0]?.engineSessionKey;
  assert.ok(firstKey, 'the first run produced a key');
  assert.equal(adapter.requests[0]?.resumeSessionKey, undefined, 'the first run starts fresh');
  assert.equal(
    adapter.requests[1]?.resumeSessionKey,
    firstKey,
    "the second run is handed the first run's key",
  );
  // The key the first run persisted is the key the second run resumed.
  assert.equal(adapter.sessions[1]?.engineSessionKey, firstKey, 'the same session continued');
});

test('a completed run persists its key under the full identity', async () => {
  const { orchestrator, sessionKeys } = build({});
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'one' });
  await orchestrator.waitFor(id);

  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
  });
  assert.equal(stored?.key, 'scripted-key-1');
  assert.equal(stored?.updatedAt, 5_000);
});

test('a run in a different working directory does not receive the old key', async () => {
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'key-from-other-directory',
    updatedAt: 1_000,
  });

  const { orchestrator, adapter } = build({
    agent: { workingDirectory: '/srv/elsewhere' },
    sessionKeys,
  });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'one' });
  await orchestrator.waitFor(id);

  assert.equal(adapter.requests[0]?.resumeSessionKey, undefined);
});

/**
 * The working-directory dimension of the identity is the directory the run
 * actually executes in, which the resolved instance owns and the agent only
 * fallbacks to (ADR-0003, #18). The next two tests pin both halves: the
 * instance value is what gets stored, and a *different* instance directory is a
 * different continuation slot even when the agent's fallback is unchanged.
 */
test('the stored key records the instance-resolved working directory, not the agent fallback', async () => {
  const { orchestrator, adapter, sessionKeys } = build({
    // The agent's fallback differs from the instance's own directory, so only
    // the instance value can be the one the run used and stored.
    agent: { workingDirectory: '/srv/agent-fallback' },
    instances: [
      { id: 'mac-mini-1', definitionId: 'macos-workstation', workingDirectory: '/srv/instance' },
    ],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'one' });
  await orchestrator.waitFor(id);

  assert.equal(adapter.requests[0]?.workingDirectory, '/srv/instance');
  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/instance',
  });
  assert.equal(stored?.key, 'scripted-key-1', 'the key is stored under the instance directory');
  const underFallback = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/agent-fallback',
  });
  assert.equal(underFallback, undefined, 'the agent fallback is not a continuation slot');
});

test('a run on an instance with a different directory does not receive the old key', async () => {
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/instance-one',
    key: 'key-from-another-instance-directory',
    updatedAt: 1_000,
  });

  const { orchestrator, adapter } = build({
    // Same agent fallback, same engine, same instance id — only the directory
    // the resolved instance declares moved, and that alone must miss the key.
    agent: { workingDirectory: '/srv/agent-fallback' },
    instances: [
      { id: 'mac-mini-1', definitionId: 'macos-workstation', workingDirectory: '/srv/instance-two' },
    ],
    sessionKeys,
  });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'one' });
  await orchestrator.waitFor(id);

  assert.equal(adapter.requests[0]?.resumeSessionKey, undefined);
});

test('a run in a different environment instance does not receive the old key', async () => {
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'key-from-other-environment',
    updatedAt: 1_000,
  });

  const { orchestrator, adapter } = build({
    // A different resolved instance, reached through the project's available
    // set rather than an agent-pinned device (#18).
    projects: [project({ availableEnvironmentInstanceIds: ['mac-mini-2'] })],
    sessionKeys,
  });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'one' });
  await orchestrator.waitFor(id);

  assert.equal(adapter.requests[0]?.resumeSessionKey, undefined);
});

test('a run on a different engine does not receive the old key', async () => {
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'pi',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'key-from-another-engine',
    updatedAt: 1_000,
  });

  const { orchestrator, adapter } = build({ sessionKeys });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'one' });
  await orchestrator.waitFor(id);

  assert.equal(adapter.requests[0]?.resumeSessionKey, undefined);
});

test('a key stored by a previous process is used after a restart', async () => {
  // The first orchestrator stands in for the process that ran before the
  // restart; the store is the only thing that carries over (ADR-0002).
  const sessionKeys = new InMemorySessionKeyStore();
  const store = new InMemoryRunStore();

  const first = build({ sessionKeys, store });
  const run = await first.orchestrator.submit({ agentId: 'agent-scout', prompt: 'before restart' });
  await first.orchestrator.waitFor(run.id);
  const keyBeforeRestart = first.adapter.sessions[0]?.engineSessionKey;

  // A brand-new orchestrator with no in-memory run state, sharing only the store.
  const second = build({ sessionKeys, store });
  const next = await second.orchestrator.submit({ agentId: 'agent-scout', prompt: 'after restart' });
  await second.orchestrator.waitFor(next.id);

  assert.equal(second.adapter.requests[0]?.resumeSessionKey, keyBeforeRestart);
});

test('an unknown stored key degrades to a fresh session instead of failing the run', async () => {
  // Codex and opencode hard-fail on a stale key (#19). The core must not surface
  // that as a failed run: it forgets the refused key and retries once, fresh.
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'stale-key',
    updatedAt: 1_000,
  });
  const { orchestrator, adapter } = build({
    sessionKeys,
    knownSessionKeys: ['some-other-key'],
    staleResumeKey: 'fail',
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed', 'the run succeeds despite the stale key');
  assert.deepEqual(run.result, completed);
  assert.equal(adapter.requests.length, 2, 'the stale attempt was followed by a fresh one');
  assert.equal(adapter.requests[0]?.resumeSessionKey, 'stale-key');
  assert.equal(adapter.requests[1]?.resumeSessionKey, undefined, 'the retry starts fresh');
  // The stale key is gone and the fresh key is what will continue next time.
  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
  });
  assert.equal(stored?.key, 'scripted-key-1');
});

test('a stale key that fails the turn is also degraded to a fresh session', async () => {
  // opencode exits 1 on a stale `--session` without settling the turn (#19), so
  // the refusal surfaces as a failed turn that emitted nothing, not as a
  // rejected session start. The core must treat both shapes the same.
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'stale-key',
    updatedAt: 1_000,
  });
  const { orchestrator, adapter } = build({
    sessionKeys,
    knownSessionKeys: ['some-other-key'],
    staleResumeKey: 'fail-turn',
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal(adapter.requests.length, 2);
  assert.equal(adapter.requests[0]?.resumeSessionKey, 'stale-key');
  assert.equal(adapter.requests[1]?.resumeSessionKey, undefined);
});

test('a mid-turn failure with a valid key is not retried and does not delete the key', async () => {
  // Retrying a run that already emitted events would repeat work with side
  // effects (tools already ran). And a failure after a *successful* resume is not
  // a refused key, so the stored key must survive — deleting it here would
  // discard a perfectly good continuation key because of an unrelated failure.
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'a-key',
    updatedAt: 1_000,
  });
  const { orchestrator, adapter } = build({
    sessionKeys,
    // Any supplied key is a healthy resume: `knownSessionKeys` is omitted. The
    // engine nonetheless fails mid-turn, which is not a refusal.
    turns: [
      {
        events: [{ type: 'tool-call', name: 'shell', detail: 'rm -rf /' }],
        result: { status: 'failed', message: 'engine exploded mid-turn' },
      },
    ],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /engine exploded mid-turn/);
  assert.equal(adapter.requests.length, 1, 'the failed attempt was not repeated');
  assert.equal(adapter.requests[0]?.resumeSessionKey, 'a-key', 'the stored key was offered');
  assert.ok(
    run.events.some((event) => event.type === 'tool-call'),
    'the events the engine already emitted are kept',
  );
  // SK-001: the unrelated failure must not discard the key.
  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
  });
  assert.equal(stored?.key, 'a-key', 'a mid-turn failure does not delete a valid stored key');
});

test('an initialization failure with a stored key is not retried fresh and keeps the key', async () => {
  // SK-001: a start failure that is *not* a refused resume — a missing binary,
  // a failed initialization, an authentication failure — must be reported as-is.
  // Retrying it fresh would hide the real problem, and deleting the key would
  // throw away a continuation key the engine never refused.
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'a-valid-key',
    updatedAt: 1_000,
  });
  const { orchestrator, adapter } = build({ sessionKeys, failStart: 'codex binary missing' });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed', 'an unrelated start failure is a real failure');
  assert.match(run.failure ?? '', /codex binary missing/);
  assert.equal(adapter.requests.length, 1, 'the unrelated start failure was not retried');
  assert.equal(adapter.requests[0]?.resumeSessionKey, 'a-valid-key');
  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
  });
  assert.equal(stored?.key, 'a-valid-key', 'the key survives an unrelated start failure');
});

test('an empty-turn failure with a stored key is not retried and keeps the key', async () => {
  // SK-001: a valid resume whose first turn fails before emitting any event is
  // *not* a refusal. The engine never said the key was bad, so the key must not
  // be deleted and the run must not be silently retried fresh.
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'a-valid-key',
    updatedAt: 1_000,
  });
  const { orchestrator, adapter } = build({
    sessionKeys,
    // Any supplied key is accepted (healthy resume), but the turn fails with no
    // events and no refusal classification.
    turns: [
      {
        events: [],
        result: { status: 'failed', message: 'provider authentication failed' },
      },
    ],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /provider authentication failed/);
  assert.equal(adapter.requests.length, 1, 'an empty non-refusal turn is not retried fresh');
  assert.equal(adapter.requests[0]?.resumeSessionKey, 'a-valid-key');
  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
  });
  assert.equal(stored?.key, 'a-valid-key', 'the key survives an empty non-refusal failure');
});

test('a run without a stored key is not retried when the engine fails', async () => {
  // Nothing was refused, so a failure is a real failure and retrying would
  // double the work.
  const sessionKeys = new InMemorySessionKeyStore();
  const { orchestrator, adapter } = build({
    sessionKeys,
    turns: [{ events: [], result: { status: 'failed', message: 'engine exploded' } }],
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.equal(adapter.requests.length, 1, 'a fresh failure is reported, not retried');
});

test('a soft-fallback engine is not retried, because it never fails', async () => {
  // Pi and agy warn and start fresh themselves (#19), so the core hands them the
  // key once and takes whatever session the engine reports.
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'stale-key',
    updatedAt: 1_000,
  });
  const { orchestrator, adapter } = build({
    sessionKeys,
    knownSessionKeys: ['some-other-key'],
    staleResumeKey: 'fresh',
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal(adapter.requests.length, 1, 'no retry was needed');
  assert.equal(adapter.requests[0]?.resumeSessionKey, 'stale-key');
  const stored = await sessionKeys.get({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
  });
  assert.equal(stored?.key, 'scripted-key-1', 'the fresh key replaces the stale one');
});

test('a key is not persisted for a run that never completed', async () => {
  const sessionKeys = new InMemorySessionKeyStore();
  const adapter = new ScriptedEngineAdapter({
    turns: [{ events, result: { status: 'failed', message: 'engine exploded' } }],
  });
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: new AgentRegistry([
      {
        id: 'agent-scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/srv/work',
      },
    ]),
    projects: new ProjectRegistry([project()]),
    pool,
    store: new InMemoryRunStore(),
    sessionKeys,
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'boom' });
  await orchestrator.waitFor(id);

  assert.equal((await sessionKeys.list()).length, 0);
});

test('runs without a session-key store keep their old fresh-session behaviour', async () => {
  const adapter = new ScriptedEngineAdapter({
    turns: [{ events, result: completed }],
  });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: new AgentRegistry([
      {
        id: 'agent-scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/srv/work',
      },
    ]),
    projects: new ProjectRegistry([project()]),
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
  });

  const first = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'one' });
  await orchestrator.waitFor(first.id);
  const second = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'two' });
  await orchestrator.waitFor(second.id);

  assert.equal(adapter.requests[0]?.resumeSessionKey, undefined);
  assert.equal(adapter.requests[1]?.resumeSessionKey, undefined);
});
