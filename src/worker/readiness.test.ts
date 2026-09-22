import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { EnvironmentWorker } from './server.ts';
import { WorkerClient, WorkerReadinessClient } from './client.ts';
import { LineJsonRpcTransport } from '../engine/jsonrpc.ts';
import { probeEnvironmentReadiness, piAuthCheckArgs, type ReadinessCommandRunner } from './readiness.ts';
import type { EngineConfiguration } from './engine-selection.ts';

const configurations: readonly EngineConfiguration[] = [
  { engine: 'codex', binaryPath: '/synthetic/codex', args: [], sandbox: 'read-only' },
  { engine: 'pi', binaryPath: '/synthetic/pi', sessionDirectory: '/synthetic/sessions' },
];

test('Codex and Pi readiness use only the #114 non-inference contract and keep model entitlement unknown', async () => {
  const calls: { readonly binary: string; readonly args: readonly string[] }[] = [];
  const runner: ReadinessCommandRunner = {
    async run(binary, args) {
      calls.push({ binary, args });
      if (args[0] === '--version') return { stdout: binary.endsWith('codex') ? 'codex-cli 0.154.0' : 'pi 0.86.1', exitCode: 0 };
      return { stdout: JSON.stringify({ status: 'ready', provider: 'openai-codex', authType: 'oauth' }), exitCode: 0 };
    },
    async accountRead() {
      return { stdout: JSON.stringify({ account: { type: 'chatgpt', email: 'must-not-survive', planType: 'plus' }, requiresOpenaiAuth: true }), exitCode: 0 };
    },
  };
  const result = await probeEnvironmentReadiness(configurations, { commandRunner: runner, clock: () => 1000 });
  assert.deepEqual(calls.map((call) => call.args), [
    ['--version'],
    ['--version'],
    ['auth', 'check', '--json', '--no-refresh', '--provider', 'openai-codex'],
  ]);
  assert.equal(result.readiness.engines[0]?.readiness, 'ready');
  assert.equal(result.readiness.engines[0]?.authMode, 'chatgpt');
  assert.equal(result.readiness.engines[0]?.modelAvailability, 'unknown');
  assert.equal(result.readiness.engines[0]?.version, '0.154.0');
  assert.equal(result.readiness.engines[1]?.authType, 'oauth');
  assert.equal(result.readiness.engines[1]?.modelAvailability, 'unknown');
  assert.equal(JSON.stringify(result).includes('must-not-survive'), false);
  assert.equal(result.probe.source, 'worker');
  assert.equal(result.probe.latencyMs, 0);
  assert.throws(() => piAuthCheckArgs('print-bearer-token'));
});

test('malformed or credential-adjacent probe output is unknown and never persisted as a ready fact', async () => {
  const runner: ReadinessCommandRunner = {
    async run(binary, args) {
      if (args[0] === '--version') return { stdout: binary.endsWith('pi') ? 'pi 0.86.1' : 'codex 0.154.0', exitCode: 0 };
      return { stdout: 'not-json', exitCode: 2 };
    },
    async accountRead() {
      return { stdout: 'Logged in using an API key - ABCDEFGH***12345', exitCode: 0 };
    },
  };
  const result = await probeEnvironmentReadiness(configurations, { commandRunner: runner, clock: () => 2000 });
  assert.equal(result.readiness.engines[0]?.readiness, 'unknown');
  assert.equal(result.readiness.engines[1]?.readiness, 'unknown');
  assert.equal(result.readiness.engines[0]?.models.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /ABCDEFGH|API key/);
});

test('a version outside the pinned #114 contract stays unknown without trying a fallback command', async () => {
  const calls: (readonly string[])[] = [];
  const runner: ReadinessCommandRunner = {
    async run(_binary, args) {
      calls.push(args);
      return { stdout: args[0] === '--version' ? 'pi 9.9.9' : '{}', exitCode: 0 };
    },
    async accountRead() {
      throw new Error('Codex account probe must not run for a version-skewed binary');
    },
  };
  const result = await probeEnvironmentReadiness([configurations[1]!], { commandRunner: runner, clock: () => 3000 });
  assert.equal(result.readiness.engines[0]?.readiness, 'unknown');
  assert.deepEqual(calls, [['--version']]);
});

test('malformed pinned auth schemas fail closed for both engines', async () => {
  const malformedPi = [
    {},
    { status: 'ready' },
    { status: 'ready', provider: 'other-provider', authType: 'oauth' },
    { status: 'ready', provider: 'openai-codex', authType: 'chatgpt' },
    { status: 'not_ready', provider: 'openai-codex', reason: 'made_up' },
    { status: 'unexpected', provider: 'openai-codex', reason: 'invalid_state' },
    { status: 'ready', provider: 'openai-codex', authType: 'oauth', secret: 'extra' },
  ];
  for (const response of malformedPi) {
    const result = await probeEnvironmentReadiness([configurations[1]!], {
      commandRunner: {
        async run(_binary, args) {
          return args[0] === '--version'
            ? { stdout: 'pi 0.86.1', exitCode: 0 }
            : { stdout: JSON.stringify(response), exitCode: 0 };
        },
      },
    });
    assert.equal(result.readiness.engines[0]?.readiness, 'unknown', JSON.stringify(response));
  }

  const malformedCodex = [
    {},
    { requiresOpenaiAuth: true, account: {} },
    { requiresOpenaiAuth: true, account: false },
    { requiresOpenaiAuth: true, account: { type: 'chatgpt' } },
    { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: null } },
    { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: null, planType: 'platinum' } },
    { requiresOpenaiAuth: true, account: { type: 'amazonBedrock' } },
    { requiresOpenaiAuth: true, account: { type: 'amazonBedrock', usesCodexManagedCredentials: 'yes' } },
    { requiresOpenaiAuth: true, account: { type: 'garbage' } },
    { requiresOpenaiAuth: true, account: { type: 'apiKey', email: null } },
  ];
  for (const response of malformedCodex) {
    const result = await probeEnvironmentReadiness([configurations[0]!], {
      commandRunner: {
        async run() { return { stdout: 'codex-cli 0.154.0', exitCode: 0 }; },
        async accountRead() { return { stdout: JSON.stringify(response), exitCode: 0 }; },
      },
    });
    assert.equal(result.readiness.engines[0]?.readiness, 'unknown', JSON.stringify(response));
  }
});

test('all pinned Codex account variants are accepted only with their complete tagged fields', async () => {
  const variants = [
    { account: { type: 'apiKey' }, requiresOpenaiAuth: true, authMode: 'api_key' },
    { account: { type: 'chatgpt', email: null, planType: 'enterprise' }, requiresOpenaiAuth: true, authMode: 'chatgpt' },
    { account: { type: 'amazonBedrock', usesCodexManagedCredentials: false }, requiresOpenaiAuth: false, authMode: 'workload_identity' },
  ] as const;
  for (const { authMode, ...response } of variants) {
    const result = await probeEnvironmentReadiness([configurations[0]!], {
      commandRunner: {
        async run() { return { stdout: 'codex-cli 0.154.0', exitCode: 0 }; },
        async accountRead() { return { stdout: JSON.stringify(response), exitCode: 0 }; },
      },
    });
    assert.equal(result.readiness.engines[0]?.readiness, 'ready');
    assert.equal(result.readiness.engines[0]?.authMode, authMode);
  }
});

test('a nonzero or malformed version result never reaches an auth probe', async () => {
  for (const configuration of configurations) {
    let authCalls = 0;
    const result = await probeEnvironmentReadiness([configuration], {
      commandRunner: {
        async run(_binary, args) {
          if (args[0] === '--version') return { stdout: configuration.engine === 'codex' ? 'codex-cli 0.154.0' : 'pi 0.86.1', exitCode: 1 };
          authCalls++;
          return { stdout: '{}', exitCode: 0 };
        },
        async accountRead() {
          authCalls++;
          return { stdout: '{}', exitCode: 0 };
        },
      },
    });
    assert.equal(result.readiness.engines[0]?.readiness, 'unknown');
    assert.equal(authCalls, 0, `${configuration.engine} auth probe must not run`);
  }
});

test('explicit readiness probes execute on the Worker channel and cannot accept browser facts', async (t) => {
  const coreToWorker = new PassThrough();
  const workerToCore = new PassThrough();
  let received: unknown;
  const worker = new EnvironmentWorker({
    environmentInstanceId: 'instance-1',
    engines: new Map(),
    input: coreToWorker,
    output: workerToCore,
    readiness: () => ({ protocolVersion: '2', engines: [] }),
    readinessProbe: async (params) => {
      received = params;
      return {
        readiness: { protocolVersion: '2', observedAt: 42, engines: [] },
        probe: {
          at: 42,
          latencyMs: 7,
          protocolOk: true,
          enginesOk: true,
          source: 'worker',
          version: 'worker-2',
          summary: 'Worker non-inference readiness probe completed.',
        },
      };
    },
  });
  const transport = new LineJsonRpcTransport({ input: workerToCore, output: coreToWorker });
  const connected = await WorkerClient.connect(transport);
  t.after(() => {
    transport.close();
    void worker.shutdown();
  });
  const result = await new WorkerReadinessClient(transport).probe({
    requiredModels: ['browser-supplied-model'],
  });
  assert.deepEqual(received, { requiredModels: ['browser-supplied-model'] });
  assert.equal(result.probe.latencyMs, 7);
  assert.equal(result.readiness.observedAt, 42);
  assert.equal(connected.info.readiness?.protocolVersion, '2');
});
