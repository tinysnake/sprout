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
  /**
   * How this Sprout instance reaches its production Worker (#115, ADR-0012).
   *
   * `configured` is the M1 carrier path (a core-started local endpoint, a
   * container exec channel, or an SSH-tunnelled daemon) used for tests and the
   * container carrier. `enrollment` is the production outbound path: the host
   * Worker initiates and the Sprout instance never dials it. The two are
   * mutually exclusive, so a deployment cannot silently run both. Defaults to
   * `configured` when the host names none.
   */
  readonly environmentSource: EnvironmentSource;
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
  /**
   * Host-only initialization/recovery input for the one Operator identity.
   * It is deliberately absent by default and is never part of runtime JSON,
   * portable records, diagnostics, or the browser URL.
   */
  readonly operatorCredential: string | undefined;
}

/** Which Worker execution seam a Sprout instance uses (#115, ADR-0012). */
export type EnvironmentSource = 'configured' | 'enrollment';

/**
 * The typed configuration of one environment worker (ADR-0003).
 *
 * A worker is a separate process that serves exactly one environment instance.
 * These are the host facts that decide how the core reaches it, where its
 * Worker-owned workspaces live, which engine binaries it hosts, and how the
 * environment's platform changes an engine's sandbox posture. Carrier selection
 * and engine construction remain the worker entry point's business (#80); this
 * Module only names each variable and its default once.
 */
export interface WorkerConfiguration {
  /** The one environment instance this worker serves. */
  readonly environmentInstanceId: string;
  /** Address the worker publishes for the core to dial. */
  readonly workerHost: string;
  /** Port the worker binds; `0` asks the host for a free port. */
  readonly workerPort: number;
  /** `endpoint` when the core dials this worker, `stdio` when the carrier owns the pipe. */
  readonly workerTransport: string;
  /** Worker-owned root for persistent Project workspaces. */
  readonly workspaceRoot: string;
  /** Platform the worker runs on when its carrier declares one (`container` inside a container). */
  readonly environmentPlatform: string | undefined;
  /** Where the Pi engine keeps its sessions, when the host overrides the default. */
  readonly piSessionDirectory: string | undefined;
  /** Path the worker writes its readiness address to, when a carrier needs a file. */
  readonly readyFile: string | undefined;
  /** Explicit engine binary overrides, keyed by engine command (`SPROUT_<ENGINE>_BIN`). */
  readonly engineBinaries: Readonly<Record<string, string>>;
  /**
   * The enrollment-backed outbound connection (#115, ADR-0012).
   *
   * When a pending enrollment was created in Web, the host Worker claims it and
   * dials the Sprout instance itself. The Sprout instance never dials the Worker
   * and never needs a host address. `undefined` keeps the M1 in-process
   * configured-Worker path for tests and the container carrier.
   */
  readonly enrollment: WorkerEnrollmentTarget | undefined;
}

/**
 * How this host Worker reaches its Sprout instance (#115, ADR-0012).
 *
 * The private key stays host-local: only the path to the key file is named, and
 * the one-use claim secret is read from the environment rather than the command
 * line, so it never enters shell history or process arguments.
 */
export interface WorkerEnrollmentTarget {
  /** The pending enrollment id shown in Web. */
  readonly enrollmentId: string;
  /** The Sprout instance host to dial. */
  readonly host: string;
  readonly port: number;
  /** The one-use claim secret, read from the environment, never the command line. */
  readonly claimSecret: string | undefined;
  /** Where the host-local private key lives; the Core never reads this file. */
  readonly identityKeyPath: string;
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

/** Host facts the Worker entry point cannot discover from the environment alone. */
export interface WorkerConfigurationDefaults {
  /** The worker's working directory, used for the workspace-root default. */
  readonly workingDirectory: string;
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
    environmentSource: parseEnvironmentSource(environment['SPROUT_ENV_SOURCE']),
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
    operatorCredential: environment['SPROUT_OPERATOR_CREDENTIAL'],
  };
}

/**
 * Parse every supported Worker host setting once.
 *
 * The Worker entry point consumes the typed result instead of naming a
 * `SPROUT_*` variable itself. Defaults and permissiveness are exactly the ones
 * the entry point used before this existed; the entry point keeps its startup
 * errors, carrier selection, and engine sandbox decision.
 */
export function parseWorkerConfiguration(
  environment: HostEnvironment,
  defaults: WorkerConfigurationDefaults,
): WorkerConfiguration {
  return {
    environmentInstanceId: environment['SPROUT_ENV_INSTANCE'] ?? 'local-macos',
    workerHost: environment['SPROUT_WORKER_HOST'] ?? '127.0.0.1',
    workerPort: numberValue(environment['SPROUT_WORKER_PORT'], 0),
    workerTransport: environment['SPROUT_WORKER_TRANSPORT'] ?? 'endpoint',
    workspaceRoot:
      environment['SPROUT_WORKSPACE_ROOT'] ??
      join(defaults.workingDirectory, '.sprout-workspaces'),
    environmentPlatform: environment['SPROUT_ENV_PLATFORM'],
    piSessionDirectory: environment['SPROUT_PI_SESSION_DIR'],
    readyFile: environment['SPROUT_READY_FILE'],
    engineBinaries: engineBinaryOverrides(environment),
    enrollment: workerEnrollmentTarget(environment),
  };
}

/**
 * Read the optional enrollment-backed outbound target (#115).
 *
 * All-or-nothing: a partial configuration returns `undefined` so the Worker
 * falls back to the M1 configured path rather than dialing with missing facts.
 */
function workerEnrollmentTarget(
  environment: HostEnvironment,
): WorkerEnrollmentTarget | undefined {
  const enrollmentId = environment['SPROUT_ENROLLMENT_ID'];
  const host = environment['SPROUT_CORE_HOST'];
  if (enrollmentId === undefined || host === undefined) return undefined;
  return {
    enrollmentId,
    host,
    port: numberValue(environment['SPROUT_CORE_PORT'], 5174),
    claimSecret: environment['SPROUT_ENROLLMENT_CLAIM'],
    identityKeyPath:
      environment['SPROUT_WORKER_KEY'] ?? join(environment['HOME'] ?? '.', '.sprout-worker-key.pem'),
  };
}

/**
 * The environment a spawned Worker process starts with.
 *
 * The core communicates the resolved instance to the worker through this one
 * variable, so the name lives here with the rest of the host surface rather than
 * in the core entry point. A carrier may add transport-specific facts, but the
 * instance is always this name.
 */
export function workerEnvironment(environmentInstanceId: string): Readonly<Record<string, string>> {
  return { SPROUT_ENV_INSTANCE: environmentInstanceId };
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

/**
 * Parse the production Worker execution source (#115, ADR-0012).
 *
 * The default preserves the M1 configured path. An unrecognized value is a
 * startup refusal rather than a silent fallback, because falling back would
 * quietly retain the configured production path ADR-0012 says must not run
 * alongside the enrollment path. The rejected value is never echoed, so a
 * mis-set variable cannot leak into a startup log.
 */
function parseEnvironmentSource(value: string | undefined): EnvironmentSource {
  if (value === undefined || value === 'configured') return 'configured';
  if (value === 'enrollment') return 'enrollment';
  throw new Error('SPROUT_ENV_SOURCE must be "configured" or "enrollment"');
}

/**
 * Explicit engine binary overrides, as `SPROUT_<ENGINE>_BIN` names them.
 *
 * A worker may host several engines, so the override is generic rather than one
 * variable per known engine. This is the only place the pattern is named; the
 * entry point asks the parsed map by engine command. A name that is not
 * `SPROUT_<ENGINE>_BIN` is never collected.
 */
function engineBinaryOverrides(environment: HostEnvironment): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    const engine = /^SPROUT_([A-Z0-9]+)_BIN$/.exec(name)?.[1];
    if (engine === undefined || value === undefined) continue;
    overrides[engine.toLowerCase()] = value;
  }
  return overrides;
}

/** The host proxy, translated to the name a container uses for the host. */
function containerProxy(environment: HostEnvironment): Readonly<Record<string, string>> {
  const raw = environment['SPROUT_DOCKER_PROXY'] ?? environment['HTTPS_PROXY'] ?? environment['https_proxy'];
  if (!raw) return {};
  const translated = raw.replace(/127\.0\.0\.1|localhost/g, 'host.docker.internal');
  return { HTTPS_PROXY: translated, HTTP_PROXY: translated, NO_PROXY: 'localhost,127.0.0.1' };
}
