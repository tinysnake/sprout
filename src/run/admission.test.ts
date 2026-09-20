import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import type { AgentRunEvent } from '../engine/port.ts';
import { AgentRegistry, type AgentDefinition } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { InMemoryRunStore } from './store.ts';
import { RunOrchestrator } from './orchestrator.ts';
import type { AgentWorkOptionEngineFact } from '../agent/admission.ts';

/**
 * Run admission under ordered work options (#90, ADR-0008).
 *
 * The acceptance rule under test: admission picks the first option compatible
 * with the resolved Environment's current facts **before** any engine accepts
 * the work, records the option and configuration version it used on the durable
 * run, and never replays an accepted run through a lower-priority option.
 */

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

const successEvents: readonly AgentRunEvent[] = [{ type: 'message', text: 'done', final: true }];
const completed = { status: 'completed', text: 'done' } as const;

const readyCodex: AgentWorkOptionEngineFact = {
  engine: 'codex',
  installed: true,
  readiness: 'ready',
  models: { state: 'available', models: ['gpt-5.2-codex'] },
};
const readyPi: AgentWorkOptionEngineFact = {
  engine: 'pi',
  installed: true,
  readiness: 'ready',
  models: { state: 'available', models: ['glm-5'] },
};
const missingCodex: AgentWorkOptionEngineFact = {
  engine: 'codex',
  installed: false,
  readiness: 'missing',
  models: { state: 'none', models: [] },
};

function build(options: {
  turns?: ConstructorParameters<typeof ScriptedEngineAdapter>[0]['turns'];
  agent?: AgentDefinition;
  engineFacts?: (environmentInstanceId: string) => Promise<readonly AgentWorkOptionEngineFact[]>;
  /** Adapters for the ordered options' engines; `scripted` is always present. */
  extraEngines?: ReadonlyMap<string, ScriptedEngineAdapter>;
} = {}) {
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    clock: { now: () => 1_000 },
  });
  const adapter = new ScriptedEngineAdapter({ turns: options.turns ?? [{ events: successEvents, result: completed }] });
  const adapters = new Map<string, ScriptedEngineAdapter>([
    ['scripted', adapter],
    ['codex', adapter],
    ['pi', adapter],
    ...(options.extraEngines ?? []),
  ]);
  const registry = new AgentRegistry([
    options.agent ?? {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);
  const store = new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: adapters,
    agents: registry,
    projects: new ProjectRegistry([
      {
        id: 'project-sprout',
        goal: 'Ship Sprout',
        rules: [],
        availableEnvironmentInstanceIds: ['mac-mini-1'],
        memberships: [
          { agentId: 'agent-scout', responsibilities: [], collaborationInstructions: '' },
        ],
      },
    ]),
    pool,
    store,
    ...(options.engineFacts !== undefined ? { engineFacts: options.engineFacts } : {}),
    leaseTtlMs: 60_000,
  });
  return { orchestrator, adapters, store };
}

const orderedAgent: AgentDefinition = {
  id: 'agent-scout',
  name: 'Scout',
  engine: 'codex',
  capability: 'agent-run',
  workingDirectory: '/tmp',
  configurationVersion: 3,
  workOptions: [
    { id: 'opt-1', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' },
    { id: 'opt-2', engine: 'pi', workModel: 'glm-5', effort: 'medium' },
  ],
};

test('admission records the first compatible option and its configuration version', async () => {
  const { orchestrator } = build({
    agent: orderedAgent,
    engineFacts: async () => [readyCodex, readyPi],
  });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hi' });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.status, 'completed', `run failure: ${run.failure ?? 'none'}`);
  assert.deepEqual(run.workOption, {
    id: 'opt-1',
    engine: 'codex',
    workModel: 'gpt-5.2-codex',
    effort: 'high',
  });
  assert.equal(run.configurationVersion, 3);
});

test('admission walks past an unsupported option to the first compatible one', async () => {
  const piAdapter = new ScriptedEngineAdapter({
    turns: [{ events: successEvents, result: completed }],
  });
  const { orchestrator, adapters } = build({
    agent: orderedAgent,
    engineFacts: async () => [missingCodex, readyPi],
    extraEngines: new Map([['pi', piAdapter]]),
  });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hi' });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.status, 'completed');
  assert.equal(run.workOption?.engine, 'pi');
  assert.equal(adapters.get('pi')!.requests[0]!.model, 'glm-5');
  assert.equal(adapters.get('pi')!.requests[0]!.effort, 'medium');
});

test('admission refuses explicitly when no option is compatible', async () => {
  const { orchestrator } = build({
    agent: orderedAgent,
    engineFacts: async () => [missingCodex],
  });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hi' });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /no compatible work option/);
});

test('an Environment with no observations yet admits the first option unchanged', async () => {
  const { orchestrator, adapters } = build({
    agent: orderedAgent,
    engineFacts: async () => [],
  });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hi' });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.status, 'completed');
  assert.equal(run.workOption?.engine, 'codex');
  assert.equal(adapters.get('codex')!.requests[0]!.model, 'gpt-5.2-codex');
  assert.equal(adapters.get('codex')!.requests[0]!.effort, 'high');
});

test('a definition-era agent without options keeps its pre-#90 behaviour and attribution', async () => {
  const { orchestrator } = build({
    agent: {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'codex',
      capability: 'agent-run',
      workingDirectory: '/tmp',
      model: 'gpt-5.2-codex',
      effort: 'low',
    },
    engineFacts: async () => [readyCodex, readyPi],
  });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hi' });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.workOption, {
    id: 'primary',
    engine: 'codex',
    workModel: 'gpt-5.2-codex',
    effort: 'low',
  });
  assert.equal(run.configurationVersion, 1);
});

test('a failed turn is reported as-is and never replayed through a lower option', async () => {
  // The primary engine accepts the run and then its turn fails. A second
  // adapter for the fallback engine exists; it must never be started.
  const piAdapter = new ScriptedEngineAdapter({
    turns: [{ events: successEvents, result: completed }],
  });
  const { orchestrator, adapters } = build({
    agent: orderedAgent,
    engineFacts: async () => [readyCodex, readyPi],
    turns: [{ events: successEvents, result: { status: 'failed', message: 'engine exploded mid-turn' } }],
    extraEngines: new Map([['codex', new ScriptedEngineAdapter({
      turns: [{ events: successEvents, result: { status: 'failed', message: 'engine exploded mid-turn' } }],
    })]]),
  });
  const { id } = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'hi' });
  const run = await orchestrator.waitFor(id);
  assert.equal(run.status, 'failed');
  assert.match(run.failure ?? '', /engine exploded mid-turn/);
  // Post-acceptance no-replay: the run stayed on its admitted option.
  assert.equal(run.workOption?.engine, 'codex');
  assert.equal(piAdapter.requests.length, 0, 'the fallback engine was never started after acceptance');
  assert.equal(adapters.get('pi')!.requests.length, 0);
});
