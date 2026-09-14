import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import type { AgentRunEvent } from '../engine/port.ts';
import { AgentRegistry, type AgentDefinition } from '../agent/registry.ts';
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

const events: readonly AgentRunEvent[] = [{ type: 'message', text: 'done', final: true }];
const completed = { status: 'completed', text: 'done' } as const;

function build(options: {
  agent?: Partial<AgentDefinition>;
  knownSessionKeys?: readonly string[];
  staleResumeKey?: 'fresh' | 'fail' | 'fail-turn';
  sessionKeys?: InMemorySessionKeyStore;
  store?: InMemoryRunStore;
}) {
  const agent: AgentDefinition = {
    id: 'agent-scout',
    name: 'Scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    capability: 'agent-run',
    workingDirectory: '/srv/work',
    ...options.agent,
  };
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [
      instance,
      { id: 'mac-mini-2', definitionId: 'macos-workstation' },
      { id: 'other-def', definitionId: 'some-other-definition' },
    ],
    clock: { now: () => 1_000 },
  });
  const adapter = new ScriptedEngineAdapter({
    turns: [{ events, result: completed }],
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
    agent: { environmentInstanceId: 'mac-mini-2' },
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

test('a mid-turn failure is not retried, because work was already done', async () => {
  // Retrying a run that already emitted events would repeat work with side
  // effects (tools already ran). Only a refusal that did nothing is retried.
  const adapter = new ScriptedEngineAdapter({
    turns: [
      {
        events: [{ type: 'tool-call', name: 'shell', detail: 'rm -rf /' }],
        result: { status: 'failed', message: 'engine exploded mid-turn' },
      },
    ],
  });
  const sessionKeys = new InMemorySessionKeyStore();
  await sessionKeys.save({
    agentId: 'agent-scout',
    engine: 'scripted',
    environmentInstanceId: 'mac-mini-1',
    workingDirectory: '/srv/work',
    key: 'a-key',
    updatedAt: 1_000,
  });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: new AgentRegistry([
      {
        id: 'agent-scout',
        name: 'Scout',
        engine: 'scripted',
        environmentInstanceId: 'mac-mini-1',
        capability: 'agent-run',
        workingDirectory: '/srv/work',
      },
    ]),
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
    sessionKeys,
  });

  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'go' });
  const run = await orchestrator.waitFor(id);

  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /engine exploded mid-turn/);
  assert.equal(adapter.requests.length, 1, 'the failed attempt was not repeated');
  assert.ok(
    run.events.some((event) => event.type === 'tool-call'),
    'the events the engine already emitted are kept',
  );
});

test('a run without a stored key is not retried when the engine fails', async () => {
  // Nothing was refused, so a failure is a real failure and retrying would
  // double the work.
  const sessionKeys = new InMemorySessionKeyStore();
  const adapter = new ScriptedEngineAdapter({
    turns: [{ events: [], result: { status: 'failed', message: 'engine exploded' } }],
  });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: new AgentRegistry([
      {
        id: 'agent-scout',
        name: 'Scout',
        engine: 'scripted',
        environmentInstanceId: 'mac-mini-1',
        capability: 'agent-run',
        workingDirectory: '/srv/work',
      },
    ]),
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
    sessionKeys,
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
        environmentInstanceId: 'mac-mini-1',
        capability: 'agent-run',
        workingDirectory: '/srv/work',
      },
    ]),
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
        environmentInstanceId: 'mac-mini-1',
        capability: 'agent-run',
        workingDirectory: '/srv/work',
      },
    ]),
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
