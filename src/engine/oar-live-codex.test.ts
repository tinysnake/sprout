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
  assert.ok(installation.version, 'Codex CLI reports version');
  assert.match(installation.version ?? '', /\b\d+\.\d+/, 'Codex CLI reports version');

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

test('AC8 & AC4 (F4): Bounded live macOS Codex execution discovers and invokes controlled MCP workspace tool through OAR', async (t) => {
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

  let readInvoked = false;
  let invokedPath = '';

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    sandbox: 'danger-full-access',
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: process.cwd(),
    remoteWorkspace: {
      binding: {
        projectId: 'live-proj',
        environmentInstanceId: 'live-env',
        bindingId: 'live-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws',
      },
      bindingFence: {
        generation: 1,
        isCurrent: () => true,
      },
      operations: ['read'],
      read: async (path: string) => {
        readInvoked = true;
        invokedPath = path;
        return {
          operationId: 'op-live-mcp',
          projectId: 'live-proj',
          environmentInstanceId: 'live-env',
          bindingId: 'live-bind',
          generation: 1,
          connectionEpoch: 1,
          workspaceId: 'live-ws',
          operation: 'read',
          status: 'completed',
          content: 'ALPHA_LIVE_VERIFIED_CONTENT',
        };
      },
      search: async () => ({
        operationId: 'op-live-search',
        projectId: 'live-proj',
        environmentInstanceId: 'live-env',
        bindingId: 'live-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws',
        operation: 'search',
        status: 'completed',
      }),
      inspect: async () => ({ status: 'completed' }),
      cancel: async () => ({ accepted: true, status: 'cancelled' }),
    },
  });

  try {
    const turn = session.run('Please read file "probe-target.txt" using the read tool from sprout_workspace and report its content.');
    const result = await turn.completion;

    assert.equal(result.status, 'completed', 'Turn settled as completed');
    assert.equal(readInvoked, true, 'Real Codex discovered and called remote MCP read tool');
    assert.match(invokedPath, /probe-target\.txt/, 'Read tool received correct target path');
    assert.match(result.text, /ALPHA_LIVE_VERIFIED_CONTENT/, 'Result reflects content returned by MCP tool');
  } finally {
    await session.close();
  }
});

test('AC8 & AC4 (F4): Bounded live macOS Codex execution enforces binding-fence refusal when capability is no longer current', async (t) => {
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

  let readInvoked = false;

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    sandbox: 'danger-full-access',
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: process.cwd(),
    remoteWorkspace: {
      binding: {
        projectId: 'live-proj',
        environmentInstanceId: 'live-env',
        bindingId: 'live-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws',
      },
      // Binding fence is closed/stale: capability is no longer current!
      bindingFence: {
        generation: 1,
        isCurrent: () => false,
      },
      operations: ['read'],
      read: async () => {
        readInvoked = true;
        return {
          operationId: 'op-stale',
          projectId: 'live-proj',
          environmentInstanceId: 'live-env',
          bindingId: 'live-bind',
          generation: 1,
          connectionEpoch: 1,
          workspaceId: 'live-ws',
          operation: 'read',
          status: 'completed',
          content: 'SHOULD_NOT_BE_REACHED',
        };
      },
      search: async () => ({
        operationId: 'op-stale-search',
        projectId: 'live-proj',
        environmentInstanceId: 'live-env',
        bindingId: 'live-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws',
        operation: 'search',
        status: 'completed',
      }),
      inspect: async () => ({ status: 'completed' }),
      cancel: async () => ({ accepted: true, status: 'cancelled' }),
    },
  });

  try {
    const turn = session.run('Please read file "fence-test.txt" using the read tool from sprout_workspace.');
    const result = await turn.completion;

    assert.equal(result.status, 'completed', 'Turn settled as completed');
    assert.equal(readInvoked, false, 'Underlying read operation must not be reached when binding fence is closed');
    assert.match(
      result.text,
      /no longer available|couldn’t read|could not read|unavailable/i,
      'Codex informs user of capability unavailability',
    );
  } finally {
    await session.close();
  }
});
