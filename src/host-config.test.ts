import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { parseHostConfiguration, parseWorkerConfiguration, workerEnvironment, type HostConfiguration, type HostEnvironment, type WorkerConfiguration } from './host-config.ts';

/**
 * The default host facts are asserted against a synthetic repository root, so no
 * test records a real machine path, hostname, or private network address.
 */
const projectRoot = '/synthetic/sprout';

function parseWith(environment: HostEnvironment = {}): HostConfiguration {
  return parseHostConfiguration(environment, { projectRoot });
}

/**
 * The Worker configuration is parsed against a synthetic working directory, so
 * its default workspace root is asserted without recording a real machine path.
 */
function parseWorker(environment: HostEnvironment = {}): WorkerConfiguration {
  return parseWorkerConfiguration(environment, { workingDirectory: '/synthetic/worker-cwd' });
}

/** The configuration an empty host environment produces. */
function parse(): HostConfiguration {
  return parseWith({});
}

type Setting = {
  /** The environment variable an operator sets. */
  readonly variable: string;
  /** The settings value the variable controls. */
  readonly read: (configuration: HostConfiguration) => unknown;
  /** The value a missing variable takes. */
  readonly missing: unknown;
  /** A value the variable is parsed to when present. */
  readonly present: HostEnvironment;
  /** The parsed result of `present`. */
  readonly parsed: unknown;
};

/**
 * One row per supported host setting. Each row exercises both the missing case
 * (the documented default) and a valid present case, so this table is the single
 * place that records the externally visible host configuration.
 */
const settings: readonly Setting[] = [
  {
    variable: 'SPROUT_DATABASE',
    read: (c) => c.databasePath,
    missing: join(projectRoot, 'sprout.db'),
    present: { SPROUT_DATABASE: '/synthetic/state/store.sqlite' },
    parsed: '/synthetic/state/store.sqlite',
  },
  {
    variable: 'SPROUT_WORKDIR',
    read: (c) => c.workingDirectory,
    missing: projectRoot,
    present: { SPROUT_WORKDIR: '/synthetic/work' },
    parsed: '/synthetic/work',
  },
  {
    variable: 'SPROUT_PORT',
    read: (c) => c.port,
    missing: 5174,
    present: { SPROUT_PORT: '41010' },
    parsed: 41010,
  },
  {
    variable: 'SPROUT_ENV_INSTANCE',
    read: (c) => c.environmentInstanceId,
    missing: 'local-macos',
    present: { SPROUT_ENV_INSTANCE: 'instance-b' },
    parsed: 'instance-b',
  },
  {
    variable: 'SPROUT_ENGINE',
    read: (c) => c.engineId,
    missing: 'codex',
    present: { SPROUT_ENGINE: 'pi' },
    parsed: 'pi',
  },
  {
    variable: 'SPROUT_RUNTIME_CONFIG',
    read: (c) => c.runtimeConfiguration,
    missing: {},
    present: {
      SPROUT_RUNTIME_CONFIG: JSON.stringify({
        agents: [{ id: 'a', name: 'A', engine: 'pi', capability: 'agent-run' }],
      }),
    },
    parsed: { agents: [{ id: 'a', name: 'A', engine: 'pi', capability: 'agent-run' }] },
  },
  {
    variable: 'SPROUT_ENV_KIND',
    read: (c) => c.environmentKind,
    missing: 'local',
    present: { SPROUT_ENV_KIND: 'container' },
    parsed: 'container',
  },
  {
    variable: 'SPROUT_CONTAINER_NAME',
    read: (c) => c.containerName,
    missing: 'local-macos',
    present: { SPROUT_ENV_INSTANCE: 'instance-b', SPROUT_CONTAINER_NAME: 'container-b' },
    parsed: 'container-b',
  },
  {
    variable: 'SPROUT_WINDOWS_TARGET',
    read: (c) => c.windowsTarget,
    missing: undefined,
    present: { SPROUT_WINDOWS_TARGET: 'operator@synthetic-host' },
    parsed: 'operator@synthetic-host',
  },
  {
    variable: 'SPROUT_WINDOWS_READY_FILE',
    read: (c) => c.windowsReadyFile,
    missing: 'C:/sprout-daemon/worker-ready.json',
    present: { SPROUT_WINDOWS_READY_FILE: 'C:/synthetic/ready.json' },
    parsed: 'C:/synthetic/ready.json',
  },
  {
    variable: 'SPROUT_CONTAINER_MOUNT',
    read: (c) => c.containerMountRoot,
    missing: '/sprout',
    present: { SPROUT_CONTAINER_MOUNT: '/synthetic/mount' },
    parsed: '/synthetic/mount',
  },
  {
    variable: 'SPROUT_CONTAINER_CODEX_HOME',
    read: (c) => c.containerCodexHome,
    missing: '/codexhome',
    present: { SPROUT_CONTAINER_CODEX_HOME: '/synthetic/codexhome' },
    parsed: '/synthetic/codexhome',
  },
  {
    variable: 'SPROUT_WINDOWS_TUNNEL_PORT',
    read: (c) => c.windowsTunnelPort,
    missing: 12741,
    present: { SPROUT_WINDOWS_TUNNEL_PORT: '41999' },
    parsed: 41999,
  },
  {
    variable: 'SPROUT_WINDOWS_WORKDIR',
    read: (c) => c.windowsWorkDirectory,
    missing: 'C:/sprout-work',
    present: { SPROUT_WINDOWS_WORKDIR: 'C:/synthetic/work' },
    parsed: 'C:/synthetic/work',
  },
  {
    variable: 'SPROUT_PROJECT',
    read: (c) => c.projectId,
    missing: 'sprout',
    present: { SPROUT_PROJECT: 'project-b' },
    parsed: 'project-b',
  },
  {
    variable: 'SPROUT_LEASE_TTL_MS',
    read: (c) => c.leaseTtlMs,
    missing: 900_000,
    present: { SPROUT_LEASE_TTL_MS: '60000' },
    parsed: 60_000,
  },
  {
    variable: 'SPROUT_DOCKER_PROXY',
    read: (c) => c.containerProxy,
    missing: {},
    present: { SPROUT_DOCKER_PROXY: 'http://198.51.100.4:8080' },
    parsed: {
      HTTPS_PROXY: 'http://198.51.100.4:8080',
      HTTP_PROXY: 'http://198.51.100.4:8080',
      NO_PROXY: 'localhost,127.0.0.1',
    },
  },
];

for (const { variable, read, missing, present, parsed } of settings) {
  test(`${variable} defaults to ${String(missing)} when missing`, () => {
    assert.deepEqual(read(parse()), missing);
  });
  test(`${variable} is parsed when present`, () => {
    assert.deepEqual(read(parseWith(present)), parsed);
  });
}

test('an empty host environment takes exactly the documented defaults', () => {
  assert.deepEqual(parse(), {
    databasePath: join(projectRoot, 'sprout.db'),
    workingDirectory: projectRoot,
    port: 5174,
    environmentInstanceId: 'local-macos',
    engineId: 'codex',
    runtimeConfiguration: {},
    environmentKind: 'local',
    containerName: 'local-macos',
    windowsTarget: undefined,
    windowsReadyFile: 'C:/sprout-daemon/worker-ready.json',
    containerMountRoot: '/sprout',
    containerCodexHome: '/codexhome',
    containerProxy: {},
    windowsTunnelPort: 12741,
    windowsWorkDirectory: 'C:/sprout-work',
    projectId: 'sprout',
    leaseTtlMs: 900_000,
  });
});

test('the container name follows a configured environment instance', () => {
  assert.equal(parseWith({ SPROUT_ENV_INSTANCE: 'instance-b' }).containerName, 'instance-b');
});

/**
 * The host proxy is one setting with three accepted spellings and a rewrite for
 * the container's view of the host.
 */
test('the host proxy prefers SPROUT_DOCKER_PROXY and is rewritten for a container', () => {
  assert.deepEqual(
    parseWith({
      SPROUT_DOCKER_PROXY: 'http://127.0.0.1:8080',
      HTTPS_PROXY: 'http://192.0.2.10:8080',
    }).containerProxy,
    {
      HTTPS_PROXY: 'http://host.docker.internal:8080',
      HTTP_PROXY: 'http://host.docker.internal:8080',
      NO_PROXY: 'localhost,127.0.0.1',
    },
  );
});

test('the host proxy falls back to HTTPS_PROXY and its lowercase spelling', () => {
  const upper = parseWith({ HTTPS_PROXY: 'http://198.51.100.4:8080' });
  assert.equal(upper.containerProxy['HTTP_PROXY'], 'http://198.51.100.4:8080');
  const lower = parseWith({ https_proxy: 'http://localhost:8080' });
  assert.equal(lower.containerProxy['HTTP_PROXY'], 'http://host.docker.internal:8080');
});

test('the host proxy is empty when the host declares none', () => {
  assert.deepEqual(parse().containerProxy, {});
});

/**
 * The runtime is lenient about numeric host settings: a value it cannot parse
 * becomes `NaN` and is surfaced by the socket bind or the lease clock, not by a
 * new configuration error. These cases pin that preserved behaviour.
 */
test('an unparseable numeric host setting stays NaN rather than becoming a new error', () => {
  const numeric = parseWith({
    SPROUT_PORT: 'not-a-port',
    SPROUT_WINDOWS_TUNNEL_PORT: 'x',
    SPROUT_LEASE_TTL_MS: 'y',
  });
  assert.ok(Number.isNaN(numeric.port));
  assert.ok(Number.isNaN(numeric.windowsTunnelPort));
  assert.ok(Number.isNaN(numeric.leaseTtlMs));
});

test('an empty numeric host setting keeps the runtime conversion it had before', () => {
  assert.equal(parseWith({ SPROUT_PORT: '' }).port, 0);
});

test('an invalid runtime JSON channel keeps its existing startup error', () => {
  assert.throws(
    () => parseWith({ SPROUT_RUNTIME_CONFIG: '{not json' }),
    /SPROUT_RUNTIME_CONFIG must be valid JSON/,
  );
});

/**
 * A runtime JSON document is product configuration and may legitimately carry a
 * private host fact. Its failure must stay a fixed message rather than echoing
 * the value, so a startup log cannot record what the operator wrote.
 */
test('runtime configuration errors do not echo the rejected document', () => {
  const document = JSON.stringify({
    agents: [{ id: 'a', name: 'A', engine: 'pi', capability: 'agent-run' }],
    project: { id: 'a-private-value' },
  });
  assert.throws(
    () => parseWith({ SPROUT_RUNTIME_CONFIG: document }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'SPROUT_RUNTIME_CONFIG project memberships must be an array');
      assert.equal(error.message.includes('a-private-value'), false);
      return true;
    },
  );
});

test('the parsed configuration exposes no unrelated host key', () => {
  const configuration = parseWith({ UNRELATED_HOST_FACT: 'not-sprout', SPROUT_UNKNOWN_SETTING: 'ignored' });
  assert.equal('UNRELATED_HOST_FACT' in configuration, false);
  assert.equal('SPROUT_UNKNOWN_SETTING' in configuration, false);
});

/**
 * One row per supported Worker host setting, mirroring the core table above so
 * the whole host surface crosses the same typed boundary. `worker/main.ts` names
 * no variable itself; it consumes these values.
 */
type WorkerSetting = {
  readonly variable: string;
  readonly read: (configuration: WorkerConfiguration) => unknown;
  readonly missing: unknown;
  readonly present: HostEnvironment;
  readonly parsed: unknown;
};

const workerSettings: readonly WorkerSetting[] = [
  {
    variable: 'SPROUT_ENV_INSTANCE',
    read: (c) => c.environmentInstanceId,
    missing: 'local-macos',
    present: { SPROUT_ENV_INSTANCE: 'instance-b' },
    parsed: 'instance-b',
  },
  {
    variable: 'SPROUT_WORKER_HOST',
    read: (c) => c.workerHost,
    missing: '127.0.0.1',
    present: { SPROUT_WORKER_HOST: '127.0.0.1' },
    parsed: '127.0.0.1',
  },
  {
    variable: 'SPROUT_WORKER_PORT',
    read: (c) => c.workerPort,
    missing: 0,
    present: { SPROUT_WORKER_PORT: '41020' },
    parsed: 41020,
  },
  {
    variable: 'SPROUT_WORKER_TRANSPORT',
    read: (c) => c.workerTransport,
    missing: 'endpoint',
    present: { SPROUT_WORKER_TRANSPORT: 'stdio' },
    parsed: 'stdio',
  },
  {
    variable: 'SPROUT_WORKSPACE_ROOT',
    read: (c) => c.workspaceRoot,
    missing: join('/synthetic/worker-cwd', '.sprout-workspaces'),
    present: { SPROUT_WORKSPACE_ROOT: '/synthetic/workspaces' },
    parsed: '/synthetic/workspaces',
  },
  {
    variable: 'SPROUT_ENV_PLATFORM',
    read: (c) => c.environmentPlatform,
    missing: undefined,
    present: { SPROUT_ENV_PLATFORM: 'container' },
    parsed: 'container',
  },
  {
    variable: 'SPROUT_PI_SESSION_DIR',
    read: (c) => c.piSessionDirectory,
    missing: undefined,
    present: { SPROUT_PI_SESSION_DIR: '/synthetic/pi-sessions' },
    parsed: '/synthetic/pi-sessions',
  },
  {
    variable: 'SPROUT_READY_FILE',
    read: (c) => c.readyFile,
    missing: undefined,
    present: { SPROUT_READY_FILE: 'C:/synthetic/worker-ready.json' },
    parsed: 'C:/synthetic/worker-ready.json',
  },
  {
    variable: 'SPROUT_CODEX_BIN',
    read: (c) => c.engineBinaries['codex'],
    missing: undefined,
    present: { SPROUT_CODEX_BIN: '/synthetic/bin/codex' },
    parsed: '/synthetic/bin/codex',
  },
];

for (const { variable, read, missing, present, parsed } of workerSettings) {
  test(`worker ${variable} defaults to ${String(missing)} when missing`, () => {
    assert.deepEqual(read(parseWorker()), missing);
  });
  test(`worker ${variable} is parsed when present`, () => {
    assert.deepEqual(read(parseWorker(present)), parsed);
  });
}

test('a worker with no host settings takes exactly the documented defaults', () => {
  assert.deepEqual(parseWorker(), {
    environmentInstanceId: 'local-macos',
    workerHost: '127.0.0.1',
    workerPort: 0,
    workerTransport: 'endpoint',
    workspaceRoot: join('/synthetic/worker-cwd', '.sprout-workspaces'),
    environmentPlatform: undefined,
    piSessionDirectory: undefined,
    readyFile: undefined,
    engineBinaries: {},
  });
});

/**
 * The engine binary override is generic: a worker may host several engines, so
 * any `SPROUT_<ENGINE>_BIN` name is collected and keyed by engine command. Only
 * that pattern is collected, so an unrelated `SPROUT_*_BIN` does not leak in.
 */
test('every generic engine binary override crosses the boundary, keyed by engine command', () => {
  const configuration = parseWorker({
    SPROUT_PI_BIN: '/synthetic/bin/pi',
    SPROUT_AGY_BIN: '/synthetic/bin/agy',
    SPROUT_OPENCODE_BIN: '/synthetic/bin/opencode',
  });
  assert.deepEqual(configuration.engineBinaries, {
    pi: '/synthetic/bin/pi',
    agy: '/synthetic/bin/agy',
    opencode: '/synthetic/bin/opencode',
  });
});

test('an engine binary override is case-insensitive in its engine name', () => {
  assert.deepEqual(parseWorker({ SPROUT_PI_BIN: '/synthetic/bin/pi' }).engineBinaries, {
    pi: '/synthetic/bin/pi',
  });
});

/**
 * The override pattern is generic by design — a worker may host several engines —
 * so any `SPROUT_<name>_BIN` name is collected. That is deliberately permissive:
 * an engine this build never resolves is simply never queried, exactly as the
 * entry point's original per-command lookup behaved, and no stricter validation
 * is invented. The per-engine read is asserted in the table above.
 */
test('the generic engine binary override surface is permissive, not allowlisted', () => {
  const configuration = parseWorker({ SPROUT_UNRELATED_BIN: '/synthetic/bin/other' });
  assert.deepEqual(configuration.engineBinaries, { unrelated: '/synthetic/bin/other' });
});

/**
 * The Worker keeps the runtime's lenient numeric conversion, like the core: an
 * unparseable port is not a new startup error.
 */
test('an unparseable worker port stays NaN rather than becoming a new error', () => {
  assert.ok(Number.isNaN(parseWorker({ SPROUT_WORKER_PORT: 'not-a-port' }).workerPort));
});

test('the parsed worker configuration exposes no unrelated host key', () => {
  const configuration = parseWorker({ UNRELATED_HOST_FACT: 'not-sprout', SPROUT_UNKNOWN_SETTING: 'ignored' });
  assert.equal('UNRELATED_HOST_FACT' in configuration, false);
  assert.equal('SPROUT_UNKNOWN_SETTING' in configuration, false);
});

/**
 * The core hands its resolved instance to a spawned Worker through this one
 * helper, so the core entry point names no `SPROUT_*` variable itself.
 */
test('a spawned worker receives exactly the resolved instance variable', () => {
  assert.deepEqual(workerEnvironment('instance-b'), { SPROUT_ENV_INSTANCE: 'instance-b' });
});
