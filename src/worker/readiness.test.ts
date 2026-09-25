import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { EnvironmentWorker } from './server.ts';
import { WorkerClient, WorkerReadinessClient } from './client.ts';
import { LineJsonRpcTransport } from '../engine/jsonrpc.ts';
import {
  probeEnvironmentReadiness,
  piAuthCheckArgs,
  parseSemver,
  isAtLeastVersion,
  SUPPORTED_READINESS_VERSION_FLOORS,
  type ReadinessCommandRunner,
} from './readiness.ts';
import { evaluateEngineOption, observedFactsFromWorkerReadiness } from '../environment/readiness.ts';
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

test('a version below the minimum supported floor stays unknown without running auth probes (#136)', async () => {
  const calls: (readonly string[])[] = [];
  const runner: ReadinessCommandRunner = {
    async run(_binary, args) {
      calls.push(args);
      return { stdout: args[0] === '--version' ? 'pi 0.85.0' : '{}', exitCode: 0 };
    },
    async accountRead() {
      throw new Error('Codex account probe must not run for a version below floor');
    },
  };
  const piResult = await probeEnvironmentReadiness([configurations[1]!], { commandRunner: runner, clock: () => 3000 });
  assert.equal(piResult.readiness.engines[0]?.readiness, 'unknown');
  assert.equal(piResult.readiness.engines[0]?.version, '0.85.0');
  assert.deepEqual(calls, [['--version']]);

  const codexCalls: (readonly string[])[] = [];
  const codexRunner: ReadinessCommandRunner = {
    async run(_binary, args) {
      codexCalls.push(args);
      return { stdout: args[0] === '--version' ? 'codex-cli 0.153.9' : '{}', exitCode: 0 };
    },
    async accountRead() {
      throw new Error('Codex account probe must not run for a version below floor');
    },
  };
  const codexResult = await probeEnvironmentReadiness([configurations[0]!], { commandRunner: codexRunner, clock: () => 3001 });
  assert.equal(codexResult.readiness.engines[0]?.readiness, 'unknown');
  assert.equal(codexResult.readiness.engines[0]?.version, '0.153.9');
  assert.deepEqual(codexCalls, [['--version']]);
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

test('Codex local bundled-catalog presence is checked with the pinned non-inference command (#114 C3)', async () => {
  const account = { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true };
  const calls: (readonly string[])[] = [];
  const runner: ReadinessCommandRunner = {
    async run(_binary, args) {
      calls.push(args);
      return { stdout: 'codex-cli 0.154.0', exitCode: 0 };
    },
    async accountRead() { return { stdout: JSON.stringify(account), exitCode: 0 }; },
    async bundledModels() {
      return { stdout: JSON.stringify({ models: [{ slug: 'gpt-6-astra' }, { slug: 'gpt-5-codex' }] }), exitCode: 0 };
    },
  };
  const present = await probeEnvironmentReadiness([configurations[0]!], {
    commandRunner: runner,
    requiredModels: ['gpt-6-astra'],
  });
  // Local presence is an independent fact; account entitlement and models stay
  // unknown/unavailable and continue to block admission.
  assert.equal(present.readiness.engines[0]?.modelIdPresent, true);
  assert.equal(present.readiness.engines[0]?.modelAvailability, 'unknown');
  assert.deepEqual(present.readiness.engines[0]?.models, []);
  // The pinned local command is the only model operation: no `model/list`, no
  // `--list-models`, no default (network-capable) `debug models`.
  assert.deepEqual(calls, [['--version']]);

  const absent = await probeEnvironmentReadiness([configurations[0]!], {
    commandRunner: runner,
    requiredModels: ['does-not-exist'],
  });
  assert.equal(absent.readiness.engines[0]?.modelIdPresent, false);
});

test('Codex local-catalog presence fails closed on non-zero exit and malformed output (#114 C3)', async () => {
  const account = { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
  for (const bundled of [
    { stdout: '', exitCode: 1 },
    { stdout: 'not-json', exitCode: 0 },
    { stdout: JSON.stringify({ models: 'nope' }), exitCode: 0 },
    { stdout: JSON.stringify({ models: [{ display_name: 'no slug' }] }), exitCode: 0 },
  ]) {
    const result = await probeEnvironmentReadiness([configurations[0]!], {
      commandRunner: {
        async run() { return { stdout: 'codex-cli 0.154.0', exitCode: 0 }; },
        async accountRead() { return { stdout: JSON.stringify(account), exitCode: 0 }; },
        async bundledModels() { return bundled; },
      },
      requiredModels: ['gpt-6-astra'],
    });
    assert.equal(result.readiness.engines[0]?.modelIdPresent, undefined, JSON.stringify(bundled));
    // Authentication remains an independent fact.
    assert.equal(result.readiness.engines[0]?.readiness, 'ready');
  }
});

test('the Pi adapter never executes --list-models and reports no local catalog fact (#114 C3)', async () => {
  const calls: (readonly string[])[] = [];
  const result = await probeEnvironmentReadiness([configurations[1]!], {
    commandRunner: {
      async run(_binary, args) {
        calls.push(args);
        return args[0] === '--version'
          ? { stdout: 'pi 0.86.1', exitCode: 0 }
          : { stdout: JSON.stringify({ status: 'ready', provider: 'openai-codex', authType: 'oauth' }), exitCode: 0 };
      },
    },
  });
  assert.equal(result.readiness.engines[0]?.modelIdPresent, undefined);
  assert.equal(result.readiness.engines[0]?.modelAvailability, 'unknown');
  for (const args of calls) assert.equal(args.includes('--list-models'), false);
});

test('#128: Worker measures only applicable engine targets and leaves Pi model scope unknown', async () => {
  const { readinessRequirements } = await import('../environment/readiness.ts');
  const requirements = readinessRequirements([{ engine: 'codex', workModel: 'codex-target' }, { engine: 'pi', workModel: 'pi-target' }]);
  const result = await probeEnvironmentReadiness(configurations, {
    requirements,
    commandRunner: {
      async run(_binary, args) {
        if (args[0] === '--version') return { stdout: _binary.includes('codex') ? 'codex-cli 0.154.0' : 'pi 0.86.1', exitCode: 0 };
        return { stdout: JSON.stringify({ status: 'ready', provider: 'openai-codex', authType: 'oauth' }), exitCode: 0 };
      },
      async accountRead() { return { stdout: JSON.stringify({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }), exitCode: 0 }; },
      async bundledModels() { return { stdout: JSON.stringify({ models: [{ slug: 'codex-target' }] }), exitCode: 0 }; },
    },
  });
  assert.deepEqual(result.readiness.engines.find((engine) => engine.engine === 'codex')?.targetModels, ['codex-target']);
  assert.deepEqual(result.readiness.engines.find((engine) => engine.engine === 'pi')?.targetModels, []);
  assert.equal(result.readiness.engines.find((engine) => engine.engine === 'pi')?.modelIdPresent, undefined);
  assert.equal(result.readiness.engines[0]?.requirementRevision, requirements.revisionsByEngine?.[result.readiness.engines[0]!.engine]);
});

test('a Worker-declared provider or account identity is dropped at the readiness ingress boundary (#114 C6, R118-BOUNDARY-003)', async () => {
  // A proven Worker is still not allowed to widen the persisted vocabulary. An
  // unknown authMode/authType/source must be dropped rather than pass a generic
  // identifier sanitizer, so no provider/account identity can be persisted.
  const observed = observedFactsFromWorkerReadiness({
    protocolVersion: '2',
    at: 1,
    supported: { minMajor: 2, maxMajor: 2 },
    engines: [{
      engine: 'pi',
      installed: true,
      readiness: 'ready',
      modelAvailability: 'unknown',
      models: [],
      authenticated: true,
      // A malicious or legacy Worker tries to smuggle provider/account identity.
      authMode: 'provider-account',
      authType: 'openai-codex',
      source: 'openai-codex',
    }],
  });
  const engine = observed.engines[0]!;
  assert.equal(engine.authMode, undefined, 'unknown authMode is dropped');
  assert.equal(engine.authType, undefined, 'unknown authType is dropped');
  assert.equal(engine.source, undefined, 'unknown source is dropped');
  assert.doesNotMatch(JSON.stringify(observed), /openai-codex|provider-account/);
  // A known allowlisted value still survives.
  const allowed = observedFactsFromWorkerReadiness({
    protocolVersion: '2',
    at: 1,
    supported: { minMajor: 2, maxMajor: 2 },
    engines: [{
      engine: 'codex', installed: true, readiness: 'ready', modelAvailability: 'unknown', models: [],
      authenticated: true, authMode: 'api_key', source: 'codex-account-read',
    }],
  });
  assert.equal(allowed.engines[0]?.authMode, 'api_key');
  assert.equal(allowed.engines[0]?.source, 'codex-account-read');
});

test('semver floor comparison helpers parse standard versions and evaluate floor accurately (#136)', () => {
  assert.deepEqual(parseSemver('0.154.0'), [0, 154, 0]);
  assert.deepEqual(parseSemver('  0.86.1\n'), [0, 86, 1]);
  assert.equal(parseSemver('not-a-version'), undefined);
  assert.equal(parseSemver('1.2'), undefined);

  // Exact floor match
  assert.equal(isAtLeastVersion('0.154.0', SUPPORTED_READINESS_VERSION_FLOORS.codex), true);
  assert.equal(isAtLeastVersion('0.86.1', SUPPORTED_READINESS_VERSION_FLOORS.pi), true);

  // Above floor (including current installed versions 0.156.0 and 0.87.1)
  assert.equal(isAtLeastVersion('0.156.0', SUPPORTED_READINESS_VERSION_FLOORS.codex), true);
  assert.equal(isAtLeastVersion('0.87.1', SUPPORTED_READINESS_VERSION_FLOORS.pi), true);
  assert.equal(isAtLeastVersion('1.0.0', SUPPORTED_READINESS_VERSION_FLOORS.codex), true);
  assert.equal(isAtLeastVersion('9.9.9', SUPPORTED_READINESS_VERSION_FLOORS.pi), true);

  // Below floor
  assert.equal(isAtLeastVersion('0.153.9', SUPPORTED_READINESS_VERSION_FLOORS.codex), false);
  assert.equal(isAtLeastVersion('0.86.0', SUPPORTED_READINESS_VERSION_FLOORS.pi), false);
  assert.equal(isAtLeastVersion('0.85.1', SUPPORTED_READINESS_VERSION_FLOORS.pi), false);
  assert.equal(isAtLeastVersion('bad', SUPPORTED_READINESS_VERSION_FLOORS.pi), false);
});

test('engine versions at or above minimum supported floors execute verified non-inference probe contracts (#136)', async () => {
  // Test installed versions (Codex 0.156.0 with workspaceRouting, Pi 0.87.1)
  const codexAccountWithRouting = {
    account: { type: 'chatgpt', email: 'must-not-persist@example.com', planType: 'plus' },
    requiresOpenaiAuth: true,
    workspaceRouting: {
      accountRoutingOverride: 'NO_CONSTRAINT',
      backendOrigin: 'https://chatgpt.com',
      chatgptAccountId: '00000000-0000-0000-0000-000000000001',
    },
  };

  const runner: ReadinessCommandRunner = {
    async run(binary, args) {
      if (args[0] === '--version') {
        return { stdout: binary.endsWith('codex') ? 'codex-cli 0.156.0' : '0.87.1', exitCode: 0 };
      }
      return { stdout: JSON.stringify({ status: 'ready', provider: 'openai-codex', authType: 'oauth' }), exitCode: 0 };
    },
    async accountRead() {
      return { stdout: JSON.stringify(codexAccountWithRouting), exitCode: 0 };
    },
    async bundledModels() {
      return { stdout: JSON.stringify({ models: [{ slug: 'gpt-6-astra' }] }), exitCode: 0 };
    },
  };

  const result = await probeEnvironmentReadiness(configurations, {
    commandRunner: runner,
    requiredModels: ['gpt-6-astra'],
    clock: () => 5000,
  });

  const codexEngine = result.readiness.engines.find((e) => e.engine === 'codex');
  const piEngine = result.readiness.engines.find((e) => e.engine === 'pi');

  assert.equal(codexEngine?.version, '0.156.0');
  assert.equal(codexEngine?.readiness, 'ready');
  assert.equal(codexEngine?.authenticated, true);
  assert.equal(codexEngine?.authMode, 'chatgpt');
  assert.equal(codexEngine?.modelIdPresent, true);
  // Ensure workspaceRouting and email were dropped, never leaked
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('workspaceRouting'), false);
  assert.equal(serialized.includes('chatgptAccountId'), false);
  assert.equal(serialized.includes('00000000-0000'), false);
  assert.equal(serialized.includes('must-not-persist'), false);

  assert.equal(piEngine?.version, '0.87.1');
  assert.equal(piEngine?.readiness, 'ready');
  assert.equal(piEngine?.authenticated, true);
  assert.equal(piEngine?.authType, 'oauth');

  // Both engines ok
  assert.equal(result.probe.enginesOk, true);
  assert.equal(result.probe.summary, 'Worker non-inference readiness probe completed.');

  // Check consistency with shared evaluation in environment/readiness.ts (#123)
  const codexEval = evaluateEngineOption({ engine: 'codex' }, {
    engine: 'codex',
    version: '0.156.0',
    installed: true,
    readiness: codexEngine!.readiness,
    required: true,
    models: { state: 'unknown', models: [] },
  });
  assert.equal(codexEval.state, 'available');
  assert.equal(codexEval.reason, 'Engine "codex" is ready.');
});

test('a newer engine version whose probe output is malformed degrades to unknown with neutral reason (#136)', async () => {
  // Codex 0.160.0 with malformed account/read output
  const malformedCodexRunner: ReadinessCommandRunner = {
    async run(_binary, args) {
      return { stdout: args[0] === '--version' ? 'codex-cli 0.160.0' : '{}', exitCode: 0 };
    },
    async accountRead() {
      return { stdout: JSON.stringify({ unexpectedKey: 'breaks_contract' }), exitCode: 0 };
    },
  };
  const codexResult = await probeEnvironmentReadiness([configurations[0]!], {
    commandRunner: malformedCodexRunner,
    clock: () => 6000,
  });
  const codexEngine = codexResult.readiness.engines[0]!;
  assert.equal(codexEngine.version, '0.160.0');
  assert.equal(codexEngine.readiness, 'unknown');
  assert.equal(codexEngine.authenticated, undefined);

  // Evaluate engine option produces neutral reason
  const codexEval = evaluateEngineOption({ engine: 'codex' }, {
    engine: 'codex',
    version: '0.160.0',
    installed: true,
    readiness: codexEngine.readiness,
    required: true,
    models: { state: 'unknown', models: [] },
  });
  assert.equal(codexEval.state, 'unknown');
  assert.equal(codexEval.reason, 'Engine "codex" readiness is unknown on this Environment.');

  // Pi 0.90.0 with unexpected auth check status
  const malformedPiRunner: ReadinessCommandRunner = {
    async run(_binary, args) {
      if (args[0] === '--version') return { stdout: 'pi 0.90.0', exitCode: 0 };
      return { stdout: JSON.stringify({ status: 'something_new', provider: 'openai-codex' }), exitCode: 0 };
    },
  };
  const piResult = await probeEnvironmentReadiness([configurations[1]!], {
    commandRunner: malformedPiRunner,
    clock: () => 6001,
  });
  const piEngine = piResult.readiness.engines[0]!;
  assert.equal(piEngine.version, '0.90.0');
  assert.equal(piEngine.readiness, 'unknown');
  assert.equal(piEngine.authenticated, undefined);

  const piEval = evaluateEngineOption({ engine: 'pi' }, {
    engine: 'pi',
    version: '0.90.0',
    installed: true,
    readiness: piEngine.readiness,
    required: true,
    models: { state: 'unknown', models: [] },
  });
  assert.equal(piEval.state, 'unknown');
  assert.equal(piEval.reason, 'Engine "pi" readiness is unknown on this Environment.');
});
