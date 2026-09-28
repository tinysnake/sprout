import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import type { EngineAdapter } from '../engine/port.ts';
import {
  createEnvironmentWorkerEngines,
  describeEnvironmentWorkerEngines,
  ENGINE_PROBE_STDIO,
  lookupCommand,
  type EngineAdapterFactories,
  type EngineConfiguration,
  type EngineHostFacts,
  type EngineLookupCommand,
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


test('engine probes pipe stderr on both Windows and POSIX hosts so localized noise never reaches the console', () => {
  const calls: EngineLookupCommand[] = [];
  const runner = (command: EngineLookupCommand): string => {
    calls.push(command);
    return '';
  };

  // The Windows branch is simulated by naming the platform, exactly as the
  // platform-specific CLI tests do, so this runs without a Windows host.
  lookupCommand('agy', 'win32', false, runner);
  lookupCommand('agy', 'darwin', false, runner);

  assert.deepEqual(calls, [
    { file: 'where.exe', args: ['agy'], stdio: ENGINE_PROBE_STDIO },
    { file: '/bin/sh', args: ['-lc', 'command -v agy'], stdio: ENGINE_PROBE_STDIO },
  ]);
  for (const call of calls) {
    assert.equal(call.stdio[0], 'ignore', 'stdin is never attached to the probe');
    assert.equal(call.stdio[1], 'pipe', 'stdout is read as the lookup result');
    assert.equal(call.stdio[2], 'pipe', 'stderr must be captured, never inherited');
  }
});


test('the Windows probe still prefers a directly runnable executable over an npm shim', () => {
  const result = lookupCommand('pi', 'win32', true, () => 'C:/npm/pi\nC:/tools/pi.exe\n');
  assert.equal(result, 'C:/tools/pi.exe');
});


test('an engine probe reports a probe-run not-found exit as engine-absent', () => {
  // What `where.exe` and `command -v` do when nothing matches: the command ran
  // and exited `1`, so execFileSync throws with that numeric status and no
  // spawn-error code.
  const notFound = Object.assign(new Error('Command failed: /bin/sh -lc command -v agy'), {
    status: 1,
    signal: null,
  });
  assert.equal(lookupCommand('agy', 'darwin', false, () => { throw notFound; }), undefined);
  assert.equal(lookupCommand('agy', 'win32', false, () => { throw notFound; }), undefined);
});


test('only the documented no-match exit is engine-absent; every other numeric exit propagates', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const notFound = Object.assign(new Error('not found'), { status: 1, signal: null });
    assert.equal(
      lookupCommand('agy', platform, false, () => { throw notFound; }),
      undefined,
      `${platform}: exit 1 is the ordinary no-match`,
    );
    for (const status of [0, 2]) {
      const unexpectedExit = Object.assign(new Error(`Command failed with status ${String(status)}`), {
        status,
        signal: null,
      });
      assert.throws(
        () => lookupCommand('agy', platform, false, () => { throw unexpectedExit; }),
        (error: unknown) => error === unexpectedExit,
        `${platform}: exit ${String(status)} is not a no-match and must reach the caller`,
      );
    }
  }
});


test('an engine probe exposes an unexpected spawn failure instead of reporting the engine absent', () => {
  // A probe that never ran (missing probe binary, access denied, a signal) is a
  // real failure, not an absent engine.
  const spawnFailure = Object.assign(new Error('spawnSync where.exe ENOENT'), {
    code: 'ENOENT',
    status: null,
    signal: null,
  });
  assert.throws(
    () => lookupCommand('agy', 'win32', false, () => { throw spawnFailure; }),
    (error: unknown) => error === spawnFailure,
  );
  const accessFailure = Object.assign(new Error('EACCES'), { code: 'EACCES', status: null });
  assert.throws(
    () => lookupCommand('agy', 'darwin', false, () => { throw accessFailure; }),
    (error: unknown) => error === accessFailure,
  );
  // A plain throw carries no exit status at all and must also propagate rather
  // than look like a no-match.
  const opaque = new Error('probe runner failed unexpectedly');
  assert.throws(() => lookupCommand('agy', 'darwin', false, () => { throw opaque; }), (error: unknown) => error === opaque);
});


test('an unexpected probe failure reaches engine selection rather than becoming engine-absent', () => {
  const spawnFailure = Object.assign(new Error('spawnSync /bin/sh ENOENT'), { code: 'ENOENT', status: null });
  const probeFacts: EngineHostFacts = {
    configuration: { environmentPlatform: undefined, piSessionDirectory: undefined, engineBinaries: {} },
    platform: 'darwin',
    locate: () => { throw spawnFailure; },
  };
  assert.throws(
    () => describeEnvironmentWorkerEngines(probeFacts),
    (error: unknown) => error === spawnFailure,
  );
});


test('a real engine probe never lets the child process stderr reach the console', async () => {
  const sentinel = 'SPROUT_ENGINE_PROBE_STDERR_SENTINEL';
  const moduleUrl = new URL('./engine-selection.ts', import.meta.url).href;
  const program = [
    `import { runEngineLookup, ENGINE_PROBE_STDIO } from ${JSON.stringify(moduleUrl)};`,
    `runEngineLookup({ file: process.execPath, args: ['-e', "process.stderr.write('${sentinel}')"], stdio: ENGINE_PROBE_STDIO });`,
    "process.stdout.write('probe-done');",
  ].join('\n');
  // The helper process's own stderr is a pipe here, so an inherited grandchild
  // stderr would surface in `err`; piping it must keep `err` empty.
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let error = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString('utf8'); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('engine probe harness did not finish'));
    }, 30_000);
    child.once('exit', (status) => { clearTimeout(timer); resolve(status); });
    child.once('error', reject);
  });
  assert.equal(code, 0, error);
  assert.match(out, /probe-done/);
  assert.doesNotMatch(error, new RegExp(sentinel), 'probe stderr leaked to the operator console');
});
