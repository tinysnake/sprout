import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ContainerRuntime } from '../environment/container.ts';
import type { WorkerConnection } from './carrier.ts';
import type { ContainerWorkerOptions } from './container-carrier.ts';
import type { SshTunnelCarrierOptions } from './windows-carrier.ts';
import {
  createEnvironmentWorkerFactory,
  environmentWorkerProfile,
  selectEnvironmentWorker,
  type EndpointWorkerStart,
  type EnvironmentWorkerConfiguration,
} from './environment-worker.ts';

/**
 * The carrier selection seam is exercised without Docker, SSH, or a spawned
 * process: every carrier is substituted with a recorder, so a passing test proves
 * *which* carrier was selected and with what options rather than that some
 * environment happened to work.
 */

function baseConfiguration(
  overrides: Partial<EnvironmentWorkerConfiguration> = {},
): EnvironmentWorkerConfiguration {
  return {
    environmentInstanceId: 'local-macos',
    environmentKind: 'local',
    containerName: 'container-1',
    containerMountRoot: '/sprout',
    containerCodexHome: '/codexhome',
    containerProxy: { HTTPS_PROXY: 'http://host.docker.internal:3128' },
    windowsTarget: undefined,
    windowsReadyFile: 'C:/sprout-daemon/worker-ready.json',
    windowsTunnelPort: 12741,
    localWorkingDirectory: '/host/repo',
    windowsWorkDirectory: 'C:/sprout-work',
    ...overrides,
  };
}

/** A recorded carrier selection, so the factory's decision is observable. */
interface CarrierRecorder {
  readonly selected: string[];
  readonly connection: WorkerConnection;
}

function recorder(): CarrierRecorder & {
  carriers: {
    endpoint: (options: EndpointWorkerStart) => Promise<WorkerConnection>;
    container: (options: ContainerWorkerOptions) => Promise<WorkerConnection>;
    windows: (options: SshTunnelCarrierOptions) => Promise<WorkerConnection>;
  };
  options: {
    endpoint?: EndpointWorkerStart;
    container?: ContainerWorkerOptions;
    windows?: SshTunnelCarrierOptions;
  };
} {
  const state = {
    selected: [] as string[],
    connection: stubConnection('local-macos'),
    options: {} as {
      endpoint?: EndpointWorkerStart;
      container?: ContainerWorkerOptions;
      windows?: SshTunnelCarrierOptions;
    },
  };
  return {
    get selected() {
      return state.selected;
    },
    get connection() {
      return state.connection;
    },
    get options() {
      return state.options;
    },
    carriers: {
      endpoint: async (options) => {
        state.selected.push('endpoint');
        state.options.endpoint = options;
        return { ...state.connection, info: { ...state.connection.info, environmentInstanceId: 'local-macos' } };
      },
      container: async (options) => {
        state.selected.push('container');
        state.options.container = options;
        return { ...state.connection, info: { ...state.connection.info, environmentInstanceId: 'container-1' } };
      },
      windows: async (options) => {
        state.selected.push('windows');
        state.options.windows = options;
        return { ...state.connection, info: { ...state.connection.info, environmentInstanceId: 'windows-dev' } };
      },
    },
  };
}

function stubConnection(environmentInstanceId: string): WorkerConnection {
  return {
    info: { pid: 1, environmentInstanceId, engines: [] },
    adapters: new Map(),
    contexts: {} as WorkerConnection['contexts'],
    alive: true,
    close: async () => undefined,
  };
}

test('a local environment reaches its worker as a separate network endpoint', async () => {
  const carriers = recorder();
  const factory = createEnvironmentWorkerFactory(baseConfiguration(), {
    workerEntryPath: '/repo/src/worker/main.ts',
    nodeExecutable: '/usr/bin/node',
    hostEnvironment: { PATH: '/usr/bin', SPROUT_UNRELATED: 'kept' },
    carriers: carriers.carriers,
  });

  const connection = await factory.connect('local-macos');

  assert.deepEqual(carriers.selected, ['endpoint']);
  assert.equal(connection.info.environmentInstanceId, 'local-macos');
  // The worker is a real process with its own address, so the entry point and the
  // instance it serves cross the process boundary rather than an in-process shortcut.
  assert.equal(carriers.options.endpoint?.command, '/usr/bin/node');
  assert.deepEqual(carriers.options.endpoint?.args, ['/repo/src/worker/main.ts']);
  assert.equal(carriers.options.endpoint?.env?.['SPROUT_ENV_INSTANCE'], 'local-macos');
  assert.equal(carriers.options.endpoint?.env?.['SPROUT_UNRELATED'], 'kept');
  assert.equal(carriers.options.endpoint?.env?.['SPROUT_WORKER_TRANSPORT'], undefined);
});

test('a container environment is reached through the runtime exec channel with no published port', async () => {
  const carriers = recorder();
  const runtime = fakeRuntime();
  const factory = createEnvironmentWorkerFactory(baseConfiguration({ environmentKind: 'container' }), {
    workerEntryPath: '/repo/src/worker/main.ts',
    nodeExecutable: '/usr/bin/node',
    hostEnvironment: {},
    carriers: carriers.carriers,
    containerRuntime: () => runtime,
  });

  const connection = await factory.connect('local-macos');

  assert.deepEqual(carriers.selected, ['container']);
  assert.equal(connection.info.environmentInstanceId, 'container-1');
  assert.equal(carriers.options.container?.containerName, 'container-1');
  assert.equal(carriers.options.container?.workerEntryPath, '/sprout/src/worker/main.ts');
  assert.equal(carriers.options.container?.workingDirectory, '/sprout');
  // The container's own platform and Codex home travel with the worker, and the
  // host proxy is translated to the container's name for the host.
  assert.equal(carriers.options.container?.environment?.['CODEX_HOME'], '/codexhome');
  assert.equal(
    carriers.options.container?.environment?.['HTTPS_PROXY'],
    'http://host.docker.internal:3128',
  );
});

test('a container environment that is unavailable is a clear error, not a silent empty engine list', async () => {
  const carriers = recorder();
  const factory = createEnvironmentWorkerFactory(baseConfiguration({ environmentKind: 'container' }), {
    workerEntryPath: '/repo/src/worker/main.ts',
    nodeExecutable: '/usr/bin/node',
    hostEnvironment: {},
    carriers: carriers.carriers,
    containerRuntime: () => fakeRuntime({ available: false, detail: 'docker is not running' }),
  });

  await assert.rejects(factory.connect('local-macos'), /container environment unavailable: docker is not running/);
  assert.deepEqual(carriers.selected, []);
});

test('a Windows environment is reached through an SSH tunnel to the daemon readiness port', async () => {
  const carriers = recorder();
  const factory = createEnvironmentWorkerFactory(
    baseConfiguration({ environmentKind: 'windows', windowsTarget: 'user@windows-host' }),
    {
      workerEntryPath: '/repo/src/worker/main.ts',
      nodeExecutable: '/usr/bin/node',
      hostEnvironment: {},
      carriers: carriers.carriers,
      readWindowsReadyFile: async (options) => {
        assert.equal(options.target, 'user@windows-host');
        assert.equal(options.remotePath, 'C:/sprout-daemon/worker-ready.json');
        return { host: '127.0.0.1', port: 54321 };
      },
    },
  );

  const connection = await factory.connect('local-macos');

  assert.deepEqual(carriers.selected, ['windows']);
  assert.equal(connection.info.environmentInstanceId, 'windows-dev');
  assert.equal(carriers.options.windows?.target, 'user@windows-host');
  assert.equal(carriers.options.windows?.daemonPort, 54321);
  assert.equal(carriers.options.windows?.localPort, 12741);
});

test('a Windows environment without a target is a clear configuration error', async () => {
  const carriers = recorder();
  const factory = createEnvironmentWorkerFactory(baseConfiguration({ environmentKind: 'windows' }), {
    workerEntryPath: '/repo/src/worker/main.ts',
    nodeExecutable: '/usr/bin/node',
    hostEnvironment: {},
    carriers: carriers.carriers,
  });

  await assert.rejects(
    factory.connect('local-macos'),
    /SPROUT_WINDOWS_TARGET is required for SPROUT_ENV_KIND=windows/,
  );
  assert.deepEqual(carriers.selected, []);
});

test('a run that resolves another environment instance is refused rather than served locally', () => {
  const carriers = recorder();
  const factory = createEnvironmentWorkerFactory(baseConfiguration(), {
    workerEntryPath: '/repo/src/worker/main.ts',
    nodeExecutable: '/usr/bin/node',
    hostEnvironment: {},
    carriers: carriers.carriers,
  });

  return assert.rejects(
    factory.connect('other-instance'),
    /this Sprout serves only environment instance local-macos, not other-instance/,
  );
});

test('a carrier log line is attributed to the carrier that produced it', async () => {
  const carriers = recorder();
  const lines: string[] = [];
  const factory = createEnvironmentWorkerFactory(
    baseConfiguration({ environmentKind: 'windows', windowsTarget: 'user@windows-host' }),
    {
      workerEntryPath: '/repo/src/worker/main.ts',
      nodeExecutable: '/usr/bin/node',
      hostEnvironment: {},
      carriers: carriers.carriers,
      readWindowsReadyFile: async () => ({ host: '127.0.0.1', port: 1 }),
      logWorkerLine: (source, line) => lines.push(`${source}: ${line}`),
    },
  );

  await factory.connect('local-macos');
  carriers.options.windows?.onLog?.('tunnel channel closed');

  assert.deepEqual(lines, ['windows: tunnel channel closed']);
});

test('an unknown environment kind keeps the permissive local-endpoint path', () => {
  assert.deepEqual(environmentWorkerProfile('local'), { kind: 'endpoint', platform: 'macos' });
  assert.deepEqual(environmentWorkerProfile('something-new'), { kind: 'endpoint', platform: 'macos' });
  assert.deepEqual(environmentWorkerProfile('container'), { kind: 'container', platform: 'container' });
  assert.deepEqual(environmentWorkerProfile('windows'), { kind: 'windows', platform: 'windows' });
});

test('macOS, Windows, and container environments record the same lease rules and differ only in platform', () => {
  const macos = selectEnvironmentWorker(baseConfiguration({ environmentKind: 'local' }));
  const windows = selectEnvironmentWorker(
    baseConfiguration({ environmentKind: 'windows', windowsTarget: 'user@windows-host' }),
  );
  const container = selectEnvironmentWorker(baseConfiguration({ environmentKind: 'container' }));

  assert.equal(macos.definition.platform, 'macos');
  assert.equal(windows.definition.platform, 'windows');
  assert.equal(container.definition.platform, 'container');

  // Capability names and lease rules are the same vocabulary everywhere, which is
  // why the lease registry needs no platform-specific rule (see CONTEXT.md).
  const expectedCapabilities = [
    { name: 'agent-run', requiresLease: true },
    { name: 'read-only-investigation', requiresLease: false },
  ];
  for (const selected of [macos, windows, container]) {
    assert.deepEqual(selected.definition.capabilities, expectedCapabilities);
  }

  // The working directory is a fact about the environment: each kind resolves the
  // one configured for it rather than a single shared host path.
  assert.equal(macos.instance.workingDirectory, '/host/repo');
  assert.equal(windows.instance.workingDirectory, 'C:/sprout-work');
  assert.equal(container.instance.workingDirectory, '/sprout');
  assert.equal(macos.instance.id, 'local-macos');
  assert.equal(macos.instance.definitionId, 'macos-workstation');
  assert.equal(windows.instance.definitionId, 'windows-workstation');
  assert.equal(container.instance.definitionId, 'container-linux');
});

function fakeRuntime(
  availability: { available: boolean; detail: string } = { available: true, detail: 'fake' },
): ContainerRuntime {
  return {
    available: async () => availability,
    create: async () => undefined,
    exists: async () => true,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    stop: async () => undefined,
    remove: async () => undefined,
  };
}
