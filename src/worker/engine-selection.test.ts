import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EngineAdapter } from '../engine/port.ts';
import {
  createEnvironmentWorkerEngines,
  describeEnvironmentWorkerEngines,
  type EngineAdapterFactories,
  type EngineConfiguration,
  type EngineHostFacts,
} from './engine-selection.ts';

/**
 * Engine selection is a pure function of stated host facts, so these tests prove
 * the macOS, Windows, container, Codex, and Pi configuration outcomes without a
 * live engine, a real CLI, or the Sprout runtime.
 */

function facts(options: {
  readonly configuration?: Partial<EngineHostFacts['configuration']>;
  readonly platform?: NodeJS.Platform;
  readonly located?: Readonly<Record<string, string | undefined>>;
  readonly lookupCalls?: string[];
}): EngineHostFacts {
  return {
    configuration: {
      environmentPlatform: undefined,
      piSessionDirectory: undefined,
      engineBinaries: {},
      ...options.configuration,
    },
    platform: options.platform ?? 'darwin',
    locate: (command) => {
      options.lookupCalls?.push(command);
      return options.located?.[command];
    },
  };
}

test('a macOS host configures Codex read-only and Pi with the Sprout session store', () => {
  const configurations = describeEnvironmentWorkerEngines(
    facts({
      configuration: { piSessionDirectory: '/var/sprout/pi-sessions' },
      platform: 'darwin',
      located: { codex: '/opt/codex', pi: '/opt/pi' },
    }),
  );

  assert.deepEqual(configurations, [
    { engine: 'codex', binaryPath: '/opt/codex', args: ['--strict-config'], sandbox: 'read-only' },
    { engine: 'pi', binaryPath: '/opt/pi', sessionDirectory: '/var/sprout/pi-sessions' },
  ]);
});

test('a container environment configures Codex without its own sandbox because the container is the boundary', () => {
  const configurations = describeEnvironmentWorkerEngines(
    facts({
      configuration: { environmentPlatform: 'container' },
      platform: 'linux',
      located: { codex: '/opt/codex' },
    }),
  );

  assert.deepEqual(configurations, [
    { engine: 'codex', binaryPath: '/opt/codex', args: ['--strict-config'], sandbox: 'danger-full-access' },
  ]);
});

test('a Windows host configures the agy hook command for Windows and keeps Codex read-only', () => {
  const configurations = describeEnvironmentWorkerEngines(
    facts({
      platform: 'win32',
      located: { codex: 'C:/codex.exe', agy: 'C:/agy.cmd' },
    }),
  );

  assert.deepEqual(configurations, [
    { engine: 'codex', binaryPath: 'C:/codex.exe', args: ['--strict-config'], sandbox: 'read-only' },
    { engine: 'agy', binaryPath: 'C:/agy.cmd', skipPermissions: true, hookPlatform: 'windows' },
  ]);
});

test('a Unix host configures the agy hook command for posix', () => {
  const configurations = describeEnvironmentWorkerEngines(
    facts({ platform: 'linux', located: { agy: '/usr/local/bin/agy' } }),
  );

  assert.deepEqual(configurations, [
    { engine: 'agy', binaryPath: '/usr/local/bin/agy', skipPermissions: true, hookPlatform: 'posix' },
  ]);
});

test('an engine binary override wins over the host lookup', () => {
  const lookedUp: string[] = [];
  const configurations = describeEnvironmentWorkerEngines(
    facts({
      configuration: { engineBinaries: { pi: '/custom/pi' } },
      located: { pi: '/usr/local/bin/pi' },
      lookupCalls: lookedUp,
    }),
  );

  assert.deepEqual(configurations, [{ engine: 'pi', binaryPath: '/custom/pi' }]);
  // The override short-circuits the host lookup for that engine only.
  assert.equal(lookedUp.includes('pi'), false);
});

test('an absent engine CLI is omitted rather than configured against a missing binary', () => {
  const configurations = describeEnvironmentWorkerEngines(
    facts({ located: { codex: '/opt/codex' } }),
  );

  assert.deepEqual(configurations, [
    { engine: 'codex', binaryPath: '/opt/codex', args: ['--strict-config'], sandbox: 'read-only' },
  ]);
});

test('a host with no engine CLI selects no engine rather than inventing one', () => {
  assert.deepEqual(describeEnvironmentWorkerEngines(facts({})), []);
});

test('engines are configured in one stable, observable order', () => {
  const configurations = describeEnvironmentWorkerEngines(
    facts({ located: { codex: '/c', pi: '/p', agy: '/a', opencode: '/o' } }),
  );

  assert.deepEqual(
    configurations.map((configuration) => configuration.engine),
    ['codex', 'pi', 'agy', 'opencode'],
  );
});

test('every selected engine configuration becomes one adapter, keyed by its engine id', () => {
  const built: EngineConfiguration[] = [];
  const factories: Partial<EngineAdapterFactories> = {
    codex: (configuration) => {
      built.push(configuration);
      return stubAdapter('codex');
    },
    pi: (configuration) => {
      built.push(configuration);
      return stubAdapter('pi');
    },
    agy: (configuration) => {
      built.push(configuration);
      return stubAdapter('agy');
    },
    opencode: (configuration) => {
      built.push(configuration);
      return stubAdapter('opencode');
    },
  };

  const engines = createEnvironmentWorkerEngines(
    facts({ located: { codex: '/c', pi: '/p' } }),
    factories,
  );

  assert.deepEqual([...engines.keys()], ['codex', 'pi']);
  assert.deepEqual(
    built.map((configuration) => configuration.engine),
    ['codex', 'pi'],
  );
  assert.equal(built[0]?.engine === 'codex' && built[0].sandbox, 'read-only');
});

function stubAdapter(id: string): EngineAdapter {
  return {
    id,
    capabilities: { streaming: 'incremental', supportsInterrupt: true, standingInstructions: 'out-of-band' },
    startSession: async () => {
      throw new Error('not used');
    },
  };
}
