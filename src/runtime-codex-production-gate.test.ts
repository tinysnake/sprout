import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostPiEngineAdapter } from './engine/pi-host.ts';
import { createRuntime, hostConfiguration, inMemoryStores, project } from './runtime-test-harness.ts';

test('production Runtime blocks configured Host Codex while the #248 prerequisite is unresolved', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-codex-production-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previousModel = process.env['SPROUT_HOST_CODEX_MODEL'];
  process.env['SPROUT_HOST_CODEX_MODEL'] = 'gpt-6.1-sol';
  const hostPi = new HostPiEngineAdapter({
    provider: 'fixture-provider', model: 'fixture-model', runnerRoot: join(directory, 'pi-runner'),
    probeProcess: async input => ({
      profileId: input.profileId, engine: 'pi', status: 'ready', installation: 'ready',
      authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready',
      version: '1.0.4', observedAt: 1_000,
    }),
  });
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run', environmentSource: 'enrollment', databasePath: join(directory, 'state.db'),
      runtimeConfiguration: {
        agents: [{
          id: 'codex-agent', name: 'Codex agent', engine: 'codex', capability: 'agent-run',
          model: 'gpt-6.1-sol', effort: 'medium',
          workOptions: [{ id: 'authorized-codex', engine: 'codex', workModel: 'gpt-6.1-sol', effort: 'medium' }],
        }],
        project: {
          ...project(),
          memberships: [{ agentId: 'codex-agent', responsibilities: [], collaborationInstructions: '' }],
        },
      },
    }),
    projectRoot: directory,
    stores: inMemoryStores(),
    hostPi,
  });
  try {
    assert.equal(runtime.executionStrategy.admission.available, true, 'Host-run remains available through the separately configured Pi profile');
    assert.equal(runtime.hostCodex, undefined, 'production composition does not create Host Codex from model configuration');
    const submitted = await runtime.orchestrator.submit({
      agentId: 'codex-agent', projectId: 'composition-project', prompt: 'Use the configured Codex option.',
    });
    const run = await runtime.orchestrator.waitFor(submitted.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.failureClass, 'admission');
    assert.match(run.result?.status === 'failed' ? run.result.message : '', /no work option authorized by a configured Host Engine profile/);
  } finally {
    await runtime.close();
    if (previousModel === undefined) delete process.env['SPROUT_HOST_CODEX_MODEL'];
    else process.env['SPROUT_HOST_CODEX_MODEL'] = previousModel;
  }
});
