import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ScriptedEngineAdapter } from './engine/scripted.ts';
import type { HostPiEngineAdapter, HostPiReadiness } from './engine/pi-host.ts';
import { build, scriptedTurn, agent, project, PROJECT_ID, INSTANCE_ID } from './runtime-test-harness.ts';
import { projectHostPiCompatibility } from './runtime.ts';

test('Host-run compatibility marks unsupported isolation controls unavailable', () => {
  const host = { authorizedModel: 'provider/model-host' } as HostPiEngineAdapter;
  const readiness: HostPiReadiness = {
    profileId: 'profile-compatibility-test', engine: 'pi', status: 'unavailable', installation: 'ready',
    authentication: 'ready', modelAvailability: 'available', adapterControls: 'unavailable', observedAt: 1_000,
  };
  const projection = projectHostPiCompatibility([
    { id: 'host-pi', engine: 'pi', workModel: 'provider/model-host', effort: 'medium' },
  ], host, readiness);
  assert.equal(projection.available, false);
  assert.equal(projection.options[0]?.state, 'model-unavailable');
  assert.match(projection.options[0]?.reason ?? '', /isolated Pi controls are unavailable/);
});

test('configured Host-run Pi executes a Message without Environment readiness or lease and reports local readiness', async () => {
  const model = 'provider/model-host';
  const engine = new ScriptedEngineAdapter({ turns: [scriptedTurn('Host Pi reply')] });
  let environmentLookups = 0;
  let environmentContexts = 0;
  let piReadiness: HostPiReadiness = {
    profileId: 'profile-runtime-test', engine: 'pi', status: 'ready', installation: 'ready',
    authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready',
    version: '1.0.4', observedAt: 1_000,
  };
  const environment = {
    async adapters() { environmentLookups += 1; return new Map([[engine.id, engine]]); },
    async contexts() { environmentContexts += 1; return { async prepare() { return { bootstrapInstructions: '' }; }, async recycle() {} }; },
    async close() {},
  };
  const hostPi = {
    id: 'pi',
    profileId: 'profile-runtime-test',
    authorizedModel: model,
    capabilities: engine.capabilities,
    async readiness() {
      return piReadiness;
    },
    startSession: engine.startSession.bind(engine),
  } as unknown as HostPiEngineAdapter;
  const runtimeConfig = {
    agents: [
      { ...agent('scout'), engine: 'pi', model, effort: 'medium', workOptions: [{ id: 'host-pi', engine: 'pi', workModel: model, effort: 'medium' }] },
      agent('scribe'),
    ],
    project: project(),
  };
  const { runtime } = await build({
    configuration: { executionMode: 'host-run', runtimeConfiguration: runtimeConfig },
    environment, hostPi, listen: false,
  });
  try {
    assert.equal(runtime.executionStrategy.admission.available, true);
    assert.equal(runtime.executionStrategy.taskAdmission.available, true);
    assert.deepEqual(await runtime.hostPiReadiness(), await hostPi.readiness());
    assert.equal((await runtime.orchestrator.evaluateOptionAdmission('scout', INSTANCE_ID)).ok, true);

    const { id } = await runtime.orchestrator.submit({ agentId: 'scout', projectId: PROJECT_ID, prompt: 'Say hello.' });
    const run = await runtime.orchestrator.waitFor(id);
    assert.equal(run.status, 'completed');
    assert.equal(run.executionMode, 'host-run');
    assert.equal(run.engineHostProfileId, 'profile-runtime-test');
    assert.equal(run.environmentInstanceId, '');
    assert.equal(environmentLookups, 0);
    assert.equal(environmentContexts, 0);
    assert.deepEqual(runtime.pool.leases(), []);
    piReadiness = { ...piReadiness, installation: 'unknown' };
    const notReady = await runtime.orchestrator.evaluateOptionAdmission('scout', INSTANCE_ID);
    assert.equal(notReady.ok, false, 'a top-level ready flag cannot override incomplete Host Pi readiness facts');
  } finally {
    await runtime.close();
  }
});

test('Host-run strategy reports admission unavailable without resolving an Environment or starting an engine', async () => {
  const adapter = new ScriptedEngineAdapter({ turns: [scriptedTurn('must not run')] });
  let adapterReads = 0;
  const environment = {
    async adapters() {
      adapterReads += 1;
      return new Map([[adapter.id, adapter]]);
    },
    async contexts() {
      return { async prepare() { return { bootstrapInstructions: '' }; }, async recycle() {} };
    },
    async close() {},
  };
  const { runtime } = await build({
    configuration: { executionMode: 'host-run' },
    environment,
    listen: false,
  });
  try {
    assert.equal(runtime.executionStrategy.mode, 'host-run');
    assert.ok(Object.isFrozen(runtime.executionStrategy));
    assert.equal(adapterReads, 0);

    const { id } = await runtime.orchestrator.submit({ agentId: 'scout', prompt: 'Do not infer.' });
    const run = await runtime.orchestrator.waitFor(id);
    assert.equal(run.status, 'failed');
    assert.equal(run.failureClass, 'admission');
    assert.match(run.failure ?? '', /Host-run execution is unavailable/);
    assert.equal(adapterReads, 0);
    assert.equal(adapter.requests.length, 0);
    assert.deepEqual(runtime.pool.leases(), []);
    assert.match(runtime.startupReport(41000), /execution:  host-run/);
  } finally {
    await runtime.close();
  }
});
