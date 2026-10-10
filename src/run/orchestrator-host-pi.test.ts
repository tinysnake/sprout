import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentDefinition } from '../agent/registry.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import type { HostPiEngineAdapter } from '../engine/pi-host.ts';
import type { HostCodexEngineAdapter } from '../engine/codex-host.ts';
import { createExecutionStrategy } from '../execution-mode.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import type { Project } from '../project/model.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { InMemoryRunStore } from './store.ts';
import { InMemorySessionKeyStore } from './session-key-store.ts';
import { RunOrchestrator } from './orchestrator.ts';

const profileId = 'host-profile-test';
const model = 'provider/model-test';
const project: Project = {
  id: 'project-chat',
  goal: 'Answer project messages under these rules',
  rules: ['Keep replies concise'],
  availableEnvironmentInstanceIds: [],
  memberships: [{ agentId: 'agent-pi', responsibilities: ['Reply to messages'], collaborationInstructions: 'Be direct.' }],
};
const agent: AgentDefinition = {
  id: 'agent-pi',
  name: 'Pi agent',
  engine: 'pi',
  model,
  effort: 'medium',
  capability: 'agent-run',
  configurationVersion: 4,
};

function readyHostPi(engine: ScriptedEngineAdapter, readiness: 'ready' | 'unavailable' = 'ready') {
  let readinessChecks = 0;
  const host = {
    id: 'pi',
    profileId,
    authorizedModel: model,
    capabilities: engine.capabilities,
    readiness: async () => {
      readinessChecks += 1;
      return { status: readiness };
    },
    startSession: engine.startSession.bind(engine),
  } as unknown as HostPiEngineAdapter;
  return { host, readinessChecks: () => readinessChecks };
}

function setup(options: { readonly readiness?: 'ready' | 'unavailable'; readonly agent?: AgentDefinition } = {}) {
  const engine = new ScriptedEngineAdapter({
    turns: [{ events: [{ type: 'message', text: 'Reply from Pi', final: true }], result: {
      status: 'completed', text: 'Reply from Pi',
      tokenUsage: { promptTokens: 17, completionTokens: 8, totalTokens: 25 },
      detailedTokens: { inputTokens: 17, outputTokens: 8, totalTokens: 25 },
      source: 'pi-protocol:message_end', sourceVersion: 'pi 1.0.4', billingBasis: 'unknown',
    } }],
  });
  const { host, readinessChecks } = readyHostPi(engine, options.readiness);
  let environmentAdapterLookups = 0;
  const pool = new EnvironmentPool({ definitions: [], instances: [] });
  const sessionKeys = new InMemorySessionKeyStore();
  const store = new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: async () => { environmentAdapterLookups += 1; throw new Error('Environment adapter lookup must not run'); },
    hostPi: host,
    agents: new AgentRegistry([options.agent ?? agent]),
    projects: new ProjectRegistry([project]),
    pool,
    store,
    sessionKeys,
    executionStrategy: createExecutionStrategy('host-run', true),
    clock: { now: () => 10_000 },
  });
  return { orchestrator, engine, pool, store, sessionKeys, readinessChecks, environmentAdapterLookups: () => environmentAdapterLookups };
}

test('Host-run Message uses the authorized local Pi profile without an Environment lookup or lease', async () => {
  const context = setup();
  const request = {
    agentId: agent.id, projectId: project.id, prompt: 'Please reply.',
    sessionKeyScope: { kind: 'conversation' as const, id: 'project-chat-channel' },
  };
  const { id } = await context.orchestrator.submit(request);
  const run = await context.orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  assert.equal(run.executionMode, 'host-run');
  assert.equal(run.engineHostProfileId, profileId);
  assert.equal(run.environmentInstanceId, '');
  assert.equal(run.workOption?.engine, 'pi');
  assert.equal(run.workOption?.workModel, model);
  assert.deepEqual(run.tokenUsage, { promptTokens: 17, completionTokens: 8, totalTokens: 25 });
  assert.equal(context.engine.requests.length, 1);
  assert.equal(context.engine.requests[0]?.model, model);
  assert.match(context.engine.requests[0]?.instructions ?? '', /Answer project messages under these rules/);
  assert.equal(context.environmentAdapterLookups(), 0);
  assert.deepEqual(context.pool.leases(), []);
  assert.equal(context.readinessChecks(), 1);
  assert.deepEqual(await context.sessionKeys.list().then(rows => rows.map(row => ({
    executionMode: row.executionPlacement.mode,
    engineHostProfileId: row.executionPlacement.engineHost.id,
    environmentInstanceId: row.environmentInstanceId,
  }))), [{ executionMode: 'host-run', engineHostProfileId: profileId, environmentInstanceId: '' }]);
  const key = context.engine.sessions[0]?.engineSessionKey;
  const next = await context.orchestrator.submit(request);
  assert.equal((await context.orchestrator.waitFor(next.id)).status, 'completed');
  assert.equal(context.engine.requests[1]?.resumeSessionKey, key, 'the authorized conversation resumes its native key');
  const other = await context.orchestrator.submit({ ...request, sessionKeyScope: { kind: 'conversation', id: 'other-channel' } });
  assert.equal((await context.orchestrator.waitFor(other.id)).status, 'completed');
  assert.equal(context.engine.requests[2]?.resumeSessionKey, undefined, 'another conversation starts fresh');
  const unscoped = await context.orchestrator.submit({ agentId: agent.id, projectId: project.id, prompt: 'No continuation scope.' });
  assert.equal((await context.orchestrator.waitFor(unscoped.id)).status, 'completed');
  assert.equal(context.engine.requests[3]?.resumeSessionKey, undefined);
  assert.equal((await context.sessionKeys.list()).length, 2, 'unscoped work saves no native key');
});

test('ordinary Codex Host-run Message uses the local profile without contacting an Environment', async () => {
  const model = 'provider/model-codex-host';
  const codexAgent: AgentDefinition = { ...agent, id: 'agent-codex', engine: 'codex', model };
  const codexProject: Project = {
    ...project,
    memberships: [{ agentId: codexAgent.id, responsibilities: ['Reply to messages'], collaborationInstructions: 'Be direct.' }],
  };
  const engine = new ScriptedEngineAdapter({ turns: [{
    events: [{ type: 'message', text: 'Reply from Codex', final: true }],
    result: {
      status: 'completed', text: 'Reply from Codex',
      tokenUsage: { promptTokens: 11, completionTokens: 4, totalTokens: 15 },
      detailedTokens: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
      source: 'codex-app-server', sourceVersion: 'codex-cli 0.159.3', billingBasis: 'unknown',
    },
  }] });
  let environmentAdapterLookups = 0;
  let readinessChecks = 0;
  const hostCodex = {
    id: 'codex', profileId: 'host-codex-message-profile', authorizedModel: model,
    capabilities: engine.capabilities, supportsEffort: (effort: string) => effort === 'medium',
    async readiness() {
      readinessChecks += 1;
      return { profileId: 'host-codex-message-profile', engine: 'codex', status: 'ready', installation: 'ready',
        authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready',
        version: '0.159.3', supportedEfforts: ['medium'], observedAt: 10_000 };
    },
    async startSession(request: import('../engine/port.ts').StartSessionRequest) {
      assert.equal(request.remoteWorkspace, undefined);
      assert.equal(request.remoteProjectMcp, undefined);
      return engine.startSession(request);
    },
  } as unknown as HostCodexEngineAdapter;
  const pool = new EnvironmentPool({ definitions: [], instances: [] });
  const orchestrator = new RunOrchestrator({
    engines: async () => { environmentAdapterLookups += 1; throw new Error('Environment adapter lookup must not run'); },
    hostCodex,
    agents: new AgentRegistry([codexAgent]),
    projects: new ProjectRegistry([codexProject]),
    pool,
    store: new InMemoryRunStore(),
    sessionKeys: new InMemorySessionKeyStore(),
    executionStrategy: createExecutionStrategy('host-run', true),
    clock: { now: () => 10_000 },
  });

  const submitted = await orchestrator.submit({ agentId: codexAgent.id, projectId: codexProject.id, prompt: 'Reply locally.' });
  const run = await orchestrator.waitFor(submitted.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.executionMode, 'host-run');
  assert.equal(run.workOption?.engine, 'codex');
  assert.equal(run.engineHostProfileId, 'host-codex-message-profile');
  assert.deepEqual(run.tokenUsage, { promptTokens: 11, completionTokens: 4, totalTokens: 15 });
  assert.equal(environmentAdapterLookups, 0);
  assert.equal(readinessChecks, 1);
  assert.deepEqual(pool.leases(), []);
});

test('Host-run admission refuses unauthorized models, unready profiles, and Task bindings before the engine starts', async () => {
  const wrongModel = { ...agent, model: 'provider/other-model' };
  const unauthorized = setup({ agent: wrongModel });
  const wrongModelRun = await unauthorized.orchestrator.submit({ agentId: agent.id, projectId: project.id, prompt: 'Reply.' });
  assert.equal((await unauthorized.orchestrator.waitFor(wrongModelRun.id)).status, 'failed');
  assert.equal(unauthorized.readinessChecks(), 0);
  assert.equal(unauthorized.engine.requests.length, 0);

  const unready = setup({ readiness: 'unavailable' });
  const unreadyRun = await unready.orchestrator.submit({ agentId: agent.id, projectId: project.id, prompt: 'Reply.' });
  assert.equal((await unready.orchestrator.waitFor(unreadyRun.id)).status, 'failed');
  assert.equal(unready.engine.requests.length, 0);
  assert.equal(unready.environmentAdapterLookups(), 0);

  const taskBound = setup();
  const taskRun = await taskBound.orchestrator.submit({ agentId: agent.id, projectId: project.id, taskId: 'task-1', prompt: 'Continue work.' });
  assert.equal((await taskBound.orchestrator.waitFor(taskRun.id)).status, 'failed');
  assert.equal(taskBound.engine.requests.length, 0);
  assert.equal(taskBound.environmentAdapterLookups(), 0);
});

test('Host-run fails Project membership checks before accepting work', async () => {
  const context = setup();
  const { id } = await context.orchestrator.submit({ agentId: agent.id, projectId: 'other-project', prompt: 'Reply.' });
  const run = await context.orchestrator.waitFor(id);
  assert.equal(run.status, 'failed');
  assert.equal(run.failureClass, 'admission');
  assert.equal(context.readinessChecks(), 0);
  assert.equal(context.engine.requests.length, 0);
});

// Keep the public Project object read-only to make the fixture's authority
// boundary explicit to tests that reuse it.
void (project satisfies Project);
void (agent satisfies AgentDefinition);
