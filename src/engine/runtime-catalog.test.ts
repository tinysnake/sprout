import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateEngineOption } from '../environment/readiness.ts';

import {
  ENGINE_RUNTIME_CATALOG,
  OAR_ADAPTER_VERSION,
  OAR_MINIMUM_NODE_MAJOR,
  OAR_RUNTIME_VERSION_FLOORS,
  runtimeCatalogEntry,
  runtimeConfigurationIssue,
  selectableEngineRuntimes,
} from './runtime-catalog.ts';

test('the product selector catalog exposes only accepted, explicitly configurable runtimes', () => {
  assert.deepEqual(selectableEngineRuntimes().map(runtime => runtime.id), [
    'pi', 'codex', 'agy', 'opencode',
  ]);
  assert.equal(runtimeCatalogEntry('claude')?.selection, 'candidate');
  assert.equal(runtimeCatalogEntry('future-runtime'), undefined);
});

test('the catalog is the shared source for adapter, platform, capability, readiness, and policy metadata', () => {
  assert.equal(OAR_ADAPTER_VERSION, '0.59.1');
  assert.equal(OAR_MINIMUM_NODE_MAJOR, 24);
  assert.deepEqual(OAR_RUNTIME_VERSION_FLOORS, {
    codex: '0.154.0',
    pi: '0.86.1',
    claude: '2.1.294',
  });
  assert.equal(ENGINE_RUNTIME_CATALOG.codex.adapter, 'oar');
  assert.equal(ENGINE_RUNTIME_CATALOG.pi.adapter, 'oar');
  assert.equal(ENGINE_RUNTIME_CATALOG.codex.capabilities.streaming, 'incremental');
  assert.equal(ENGINE_RUNTIME_CATALOG.opencode.capabilities.streaming, 'turn');
  assert.deepEqual(ENGINE_RUNTIME_CATALOG.codex.platform.deferred, ['win32']);
  assert.deepEqual(ENGINE_RUNTIME_CATALOG.pi.policy.limitations, [
    'The admitted Pi built-in tool set is empty.',
  ]);
  assert.match(ENGINE_RUNTIME_CATALOG.pi.readiness.unknownAction, /fresh readiness probe/);
});

test('admission keeps an unaccepted candidate unavailable even when it is discovered and ready', () => {
  const evaluation = evaluateEngineOption(
    { engine: 'claude', workModel: 'candidate-model' },
    {
      engine: 'claude', installed: true, required: true, readiness: 'ready',
      models: { state: 'available', models: ['candidate-model'] },
    },
  );

  assert.equal(evaluation.state, 'unknown');
  assert.match(evaluation.reason, /candidate runtime and is not enabled/);
});

test('unsupported runtime controls have an actionable catalog explanation', () => {
  const issue = runtimeConfigurationIssue('pi', { sessionDirectory: 'configured-session-store' });
  assert.match(issue ?? '', /uses the host Pi session store/);
  assert.match(issue ?? '', /Remove the Worker session-directory override/);
  assert.equal(runtimeConfigurationIssue('pi', { sessionDirectory: undefined }), undefined);
});
