import { join } from 'node:path';

import { parseRuntimeConfiguration, type RuntimeConfiguration } from './runtime-config.ts';

/**
 * The typed host configuration of one Sprout instance.
 *
 * These are host facts rather than product decisions: where the durable store
 * lives, which address the Web surface binds, which environment instance this
 * build serves, and how a container or Windows environment is reached. They are
 * read once here so no other Module needs to know an environment variable name.
 *
 * Defaults, permissiveness, and error text are exactly the ones the entry point
 * used before this Module existed, including the deliberately lenient numeric
 * conversion: this Module does not invent the validation the runtime never had.
 */
export interface HostConfiguration {
  /** Durable SQLite database file. */
  readonly databasePath: string;
  /** Host working directory that a local environment serves. */
  readonly workingDirectory: string;
  /** Port the Web surface binds. */
  readonly port: number;
  /** The one environment instance this build serves. */
  readonly environmentInstanceId: string;
  /** Default engine when the runtime configuration names none. */
  readonly engineId: string;
  /** Optional JSON channel for independent Agents and a Project. */
  readonly runtimeConfiguration: RuntimeConfiguration;
  /** `local` (a machine Sprout runs on), `container`, or `windows` (remote daemon). */
  readonly environmentKind: string;
  /** For a container environment: the instance's container name. */
  readonly containerName: string;
  /** For a Windows environment: the SSH target of the host running the daemon. */
  readonly windowsTarget: string | undefined;
  /** For a Windows environment: where the readiness file lives on that host. */
  readonly windowsReadyFile: string;
  /**
   * Where the worker's code lives inside the environment.
   *
   * A container mounts the repository, so it runs the same worker source as the
   * core; that keeps a stale image a mount problem rather than a silent protocol
   * mismatch.
   */
  readonly containerMountRoot: string;
  /** Where the container keeps the Codex home directory. */
  readonly containerCodexHome: string;
  /** The host proxy, translated to the name a container uses for the host. */
  readonly containerProxy: Readonly<Record<string, string>>;
  /** For a Windows environment: the local port the SSH tunnel binds. */
  readonly windowsTunnelPort: number;
  /**
   * For a Windows environment: the working directory a run uses.
   *
   * A run's working directory is a fact about the environment, not about Sprout,
   * so the same agent works unchanged on a host and inside a container whose path
   * differs (F1 suggestion, #18).
   */
  readonly windowsWorkDirectory: string;
  /** Identifier of the default Project. */
  readonly projectId: string;
  /** Environment lease time to live, in milliseconds. */
  readonly leaseTtlMs: number;
}

/**
 * The process environment, as the host configuration sees it.
 *
 * Deliberately a plain record so tests can cross this interface without touching
 * the real process environment.
 */
export type HostEnvironment = Readonly<Record<string, string | undefined>>;

/** Host facts this build cannot discover from the environment alone. */
export interface HostConfigurationDefaults {
  /** The repository root, used for path defaults when the host names none. */
  readonly projectRoot: string;
}

/**
 * Parse every supported host setting once.
 *
 * The single place that names a `SPROUT_*` host variable and its default. The
 * runtime JSON channel is delegated to its own parser, because it is a product
 * configuration document rather than a host fact.
 */
export function parseHostConfiguration(
  environment: HostEnvironment,
  defaults: HostConfigurationDefaults,
): HostConfiguration {
  const environmentInstanceId = environment['SPROUT_ENV_INSTANCE'] ?? 'local-macos';
  return {
    databasePath: environment['SPROUT_DATABASE'] ?? join(defaults.projectRoot, 'sprout.db'),
    workingDirectory: environment['SPROUT_WORKDIR'] ?? defaults.projectRoot,
    port: numberValue(environment['SPROUT_PORT'], 5174),
    environmentInstanceId,
    engineId: environment['SPROUT_ENGINE'] ?? 'codex',
    runtimeConfiguration: parseRuntimeConfiguration(environment['SPROUT_RUNTIME_CONFIG']),
    environmentKind: environment['SPROUT_ENV_KIND'] ?? 'local',
    containerName: environment['SPROUT_CONTAINER_NAME'] ?? environmentInstanceId,
    windowsTarget: environment['SPROUT_WINDOWS_TARGET'],
    windowsReadyFile: environment['SPROUT_WINDOWS_READY_FILE'] ?? 'C:/sprout-daemon/worker-ready.json',
    containerMountRoot: environment['SPROUT_CONTAINER_MOUNT'] ?? '/sprout',
    containerCodexHome: environment['SPROUT_CONTAINER_CODEX_HOME'] ?? '/codexhome',
    containerProxy: containerProxy(environment),
    windowsTunnelPort: numberValue(environment['SPROUT_WINDOWS_TUNNEL_PORT'], 12741),
    windowsWorkDirectory: environment['SPROUT_WINDOWS_WORKDIR'] ?? 'C:/sprout-work',
    projectId: environment['SPROUT_PROJECT'] ?? 'sprout',
    leaseTtlMs: numberValue(environment['SPROUT_LEASE_TTL_MS'], 900_000),
  };
}

/**
 * Numeric host settings keep the runtime's original conversion.
 *
 * A missing value takes the default and any other value is handed to `Number`
 * unchanged, so an unparseable value stays `NaN` exactly as before rather than
 * becoming a new startup error.
 */
function numberValue(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : Number(value);
}

/** The host proxy, translated to the name a container uses for the host. */
function containerProxy(environment: HostEnvironment): Readonly<Record<string, string>> {
  const raw = environment['SPROUT_DOCKER_PROXY'] ?? environment['HTTPS_PROXY'] ?? environment['https_proxy'];
  if (!raw) return {};
  const translated = raw.replace(/127\.0\.0\.1|localhost/g, 'host.docker.internal');
  return { HTTPS_PROXY: translated, HTTP_PROXY: translated, NO_PROXY: 'localhost,127.0.0.1' };
}
