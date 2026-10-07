import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { build, scriptedTurn } from './runtime-test-harness.ts';

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
