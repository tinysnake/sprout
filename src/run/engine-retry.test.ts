import test from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import type { AgentRunEvent } from '../engine/port.ts';
import { ScriptedEngineAdapter, type ScriptedTurn } from '../engine/scripted.ts';
import { classifyEngineTurnFailure, isRetryableEngineTurnFailure } from '../engine/turn-failure.ts';
import { mapPiEvent, newPiTurnState } from '../engine/pi-protocol.ts';
import { AgentRegistry, type AgentDefinition } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';
import { InMemoryRunStore } from './store.ts';
import { RunOrchestrator } from './orchestrator.ts';

const definition: EnvironmentDefinition = {
  id: 'test-environment', platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = { id: 'test-instance', definitionId: definition.id };

function project(): Project {
  return {
    id: 'test-project', goal: 'Retry an infrastructure failure', rules: [],
    availableEnvironmentInstanceIds: [instance.id],
    memberships: [{ agentId: 'agent-scout', responsibilities: [], collaborationInstructions: '' }],
  };
}

function build(turns: readonly ScriptedTurn[], workOptions?: AgentDefinition['workOptions']) {
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance], clock: { now: () => 1_000 } });
  const adapter = new ScriptedEngineAdapter({ turns });
  const agent: AgentDefinition = {
    id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp',
    ...(workOptions !== undefined ? { workOptions } : {}),
  };
  const orchestrator = new RunOrchestrator({
    engines: new Map([[adapter.id, adapter]]), agents: new AgentRegistry([agent]),
    projects: new ProjectRegistry([project()]), pool, store: new InMemoryRunStore(),
    retryBackoff: async () => undefined,
  });
  return { orchestrator, adapter };
}

function failedTurn(message: string, retryable = false): ScriptedTurn {
  return {
    events: [],
    result: { status: 'failed', message, ...(retryable ? { retryable: true as const } : {}) },
  };
}

const completed = { status: 'completed', text: 'recovered' } as const;
const retryNotice = 'Engine request failed temporarily; retrying (attempt 2 of 3).';

test('structured 502/503, DNS, connection and timeout failures are retryable; auth and unknown failures are terminal', () => {
  const infraSignals = [
    { statusCode: 502 }, { httpStatusCode: 503 }, { code: 'ENOTFOUND' },
    { cause: { code: 'ECONNREFUSED' } }, { error: { code: 'ECONNRESET' } },
    { error: { code: 'ETIMEDOUT' } },
  ];
  for (const signal of infraSignals) {
    const cause = classifyEngineTurnFailure(signal);
    assert.equal(isRetryableEngineTurnFailure(cause), true, JSON.stringify(signal));
  }
  for (const signal of [{ statusCode: 401 }, { status: 403 }, { statusCode: 400 }, { message: '502 upstream failed' }]) {
    const cause = classifyEngineTurnFailure(signal);
    assert.equal(isRetryableEngineTurnFailure(cause), false, JSON.stringify(signal));
  }

  const result = mapPiEvent({ type: 'error', statusCode: 503, message: 'PRIVATE_UPSTREAM_BODY' }, newPiTurnState()).finish;
  assert.equal(result?.status, 'failed');
  if (result?.status === 'failed') {
    assert.equal(result.retryable, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_UPSTREAM_BODY/);
  }
});

test('an infra-class engine failure retries and succeeds on the second attempt with a sanitized run event', async () => {
  const { orchestrator, adapter } = build([failedTurn('pi turn failed: the upstream service was unavailable', true), {
    events: [], result: completed,
  }]);
  const submitted = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'continue' });
  const run = await orchestrator.waitFor(submitted.id);

  assert.equal(run.status, 'completed');
  assert.equal(adapter.requests.length, 2);
  assert.deepEqual(run.events, [{ type: 'notice', text: retryNotice }]);
  assert.doesNotMatch(JSON.stringify(run.events), /PRIVATE|502|api\.|host/i);
});

test('authentication failure settles immediately without retry', async () => {
  const { orchestrator, adapter } = build([
    failedTurn('pi turn failed: authentication was rejected'),
    { events: [], result: completed },
  ]);
  const submitted = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'continue' });
  const run = await orchestrator.waitFor(submitted.id);

  assert.equal(run.status, 'failed');
  assert.equal(adapter.requests.length, 1);
  assert.deepEqual(run.events, []);
  assert.equal(run.failure, 'pi turn failed: authentication was rejected');
});

test('infra failures stop at three total attempts and preserve the bounded original reason', async () => {
  const reason = 'pi turn failed: the upstream service was unavailable';
  const { orchestrator, adapter } = build([failedTurn(reason, true)]);
  const submitted = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'continue' });
  const run = await orchestrator.waitFor(submitted.id);

  assert.equal(run.status, 'failed');
  assert.equal(adapter.requests.length, 3);
  assert.equal(run.failure, reason);
  assert.equal(run.result?.status === 'failed' ? run.result.retryable : undefined, undefined);
  assert.deepEqual(run.events, [
    { type: 'notice', text: retryNotice },
    { type: 'notice', text: 'Engine request failed temporarily; retrying (attempt 3 of 3).' },
  ] satisfies readonly AgentRunEvent[]);
});

test('a configured alternative Agent option is not treated as a provider model-group member', async () => {
  const options: NonNullable<AgentDefinition['workOptions']> = [
    { id: 'first', engine: 'scripted', workModel: 'magpie/group/example', effort: 'low' },
    { id: 'second', engine: 'other-engine', workModel: 'other-model', effort: 'low' },
  ];
  const { orchestrator, adapter } = build([failedTurn('pi turn failed: the upstream service was unavailable', true)], options);
  const submitted = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'continue' });
  const run = await orchestrator.waitFor(submitted.id);

  assert.equal(run.status, 'failed');
  assert.equal(adapter.requests.length, 3);
  assert.equal(run.workOption?.id, 'first');
  assert.equal(run.workOption?.workModel, 'magpie/group/example');
});

test('a failure after engine progress is not retried, avoiding duplicate work', async () => {
  const progress: AgentRunEvent = { type: 'tool-call', name: 'shell', detail: 'write a file' };
  const { orchestrator, adapter } = build([{
    events: [progress],
    result: { status: 'failed', message: 'pi turn failed: the upstream service was unavailable', retryable: true },
  }]);
  const submitted = await orchestrator.submit({ agentId: 'agent-scout', prompt: 'continue' });
  const run = await orchestrator.waitFor(submitted.id);

  assert.equal(run.status, 'failed');
  assert.equal(adapter.requests.length, 1);
  assert.deepEqual(run.events, [progress]);
});
