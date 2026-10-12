import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultRuntimes } from '@botiverse/oar';

import { OarEngineAdapter } from './oar.ts';
import { CodexEngineAdapter } from './codex.ts';
import {
  build,
  PROJECT_ID,
  scriptedEnvironment,
} from '../runtime-test-harness.ts';
import {
  createEnvironmentWorkerEngines,
  type EngineHostFacts,
} from '../worker/engine-selection.ts';

test('AC8: Native production default is preserved when OAR opt-in is not active', () => {
  const previousEnv = process.env['SPROUT_USE_OAR_ENGINE'];
  try {
    delete process.env['SPROUT_USE_OAR_ENGINE'];

    const fakeFacts: EngineHostFacts = {
      configuration: {
        environmentPlatform: 'host',
        engineBinaries: { codex: '/usr/local/bin/codex' },
        piSessionDirectory: undefined,
      },
      platform: 'darwin',
      locate: () => '/usr/local/bin/codex',
    };

    const engines = createEnvironmentWorkerEngines(fakeFacts);
    const codex = engines.get('codex');
    assert.ok(codex, 'codex engine is configured');
    assert.ok(
      codex instanceof CodexEngineAdapter,
      'production default remains native CodexEngineAdapter when opt-in is not active',
    );
    assert.ok(
      !(codex instanceof OarEngineAdapter),
      'OarEngineAdapter is not used by default',
    );

    // Now test with opt-in active
    process.env['SPROUT_USE_OAR_ENGINE'] = 'codex';
    const oarEngines = createEnvironmentWorkerEngines(fakeFacts);
    const oarCodex = oarEngines.get('codex');
    assert.ok(oarCodex, 'codex engine is configured with opt-in');
    assert.ok(
      oarCodex instanceof OarEngineAdapter,
      'opt-in successfully selects OarEngineAdapter',
    );
  } finally {
    if (previousEnv === undefined) {
      delete process.env['SPROUT_USE_OAR_ENGINE'];
    } else {
      process.env['SPROUT_USE_OAR_ENGINE'] = previousEnv;
    }
  }
});

test('AC8: Bounded live macOS Codex Message-to-reply demonstration through the enrolled path', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('Live demonstration requires macOS host');
    return;
  }

  const codexRuntime = defaultRuntimes.require('codex');
  let installation: any;
  try {
    installation = await codexRuntime.installation?.();
  } catch {
    t.skip('Codex installation probe failed');
    return;
  }

  if (installation?.kind !== 'available') {
    t.skip('Codex executable is not available on this host');
    return;
  }

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    sandbox: 'danger-full-access',
  });

  // Full Runtime Message admission and reply projection demonstration through enrolled path
  const { runtime } = await build({
    environment: scriptedEnvironment({
      adapters: new Map([['scripted', adapter]]),
    }),
  });

  try {
    const delivered = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: '@scout please reply with only the word PONG',
      deliveryKey: `live-codex-admission-${Date.now()}`,
      awaitReply: true,
    });

    assert.equal(delivered.duplicate, false);
    assert.equal(delivered.admittedRunIds.length, 1);

    const run = await runtime.orchestrator.waitFor(delivered.admittedRunIds[0]!);
    assert.equal(run.status, 'completed', 'Admitted run settled as completed');
    assert.equal(run.result?.status, 'completed', 'Turn result completed');
    assert.match(run.result?.status === 'completed' ? run.result.text : '', /PONG/i, 'Terminal answer contains PONG');
    assert.equal(run.result?.source, 'oar', 'Result source is oar');
    assert.ok(
      run.result?.tokenUsage && run.result.tokenUsage.promptTokens > 0,
      'Truthful prompt tokens recorded',
    );
    assert.ok(
      run.result?.tokenUsage && run.result.tokenUsage.completionTokens > 0,
      'Truthful completion tokens recorded',
    );

    // Verify exactly one reply was projected back to the scope
    const messages = await runtime.collaboration.listMessages();
    const projected = messages.filter(
      (m) => m.author.kind === 'agent' && m.inReplyTo === delivered.message.id,
    );
    assert.equal(projected.length, 1, 'Exactly one reply was projected from the root turn');
    assert.equal(projected[0]?.author.id, 'scout');
    assert.match(projected[0]?.body ?? '', /PONG/i);
  } finally {
    await runtime.close();
  }
});
