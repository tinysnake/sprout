import type { EnvironmentDefinition, EnvironmentInstance, EnvironmentPlatform } from '../environment/model.ts';
import { workerEnvironment } from '../host-config.ts';
import {
  DockerRuntime,
  containerEnvironmentDefinition,
  type ContainerRuntime,
} from '../environment/container.ts';
import { EndpointCarrier, type WorkerConnection, type WorkerReady } from './carrier.ts';
import {
  ContainerCarrier,
  containerWorkerEntry,
  type ContainerWorkerOptions,
} from './container-carrier.ts';
import { SshTunnelCarrier, readWindowsReadyFile, type SshTunnelCarrierOptions } from './windows-carrier.ts';

/**
 * How the core constructs and reaches one Environment Worker.
 *
 * ADR-0003 makes every environment a network environment: the Worker protocol
 * and its semantics are identical everywhere and only the carrier differs. This
 * Module is that difference, in one place, behind one caller-facing interface.
 * Nothing above it — the orchestrator, the Task lifecycle, the Web surface —
 * learns whether an environment is a local machine, a container, or a remote
 * Windows daemon.
 *
 * Two facts are selected here and nowhere else:
 *
 * - **Platform.** A configured environment kind resolves to the platform the
 *   rest of Sprout records on the environment definition and uses to decide
 *   engine posture (`src/worker/engine-selection.ts`).
 * - **Carrier.** A local machine is a loopback endpoint, a container is reached
 *   through the runtime's exec channel, and a Windows host is reached through an
 *   SSH local forward to its daemon.
 *
 * Every carrier is injectable so selection can be asserted without Docker, SSH,
 * or a spawned process, and every externally visible error keeps the exact
 * message the runtime produced before this Module existed.
 */

export type EnvironmentWorkerKind = 'endpoint' | 'container' | 'windows';

export interface EnvironmentWorkerProfile {
  /** Which carrier reaches this environment. */
  readonly kind: EnvironmentWorkerKind;
  /** The platform Sprout records for this environment. */
  readonly platform: EnvironmentPlatform;
}

/**
 * The one mapping from a configured environment kind to its Worker profile.
 *
 * An unknown kind takes the local-endpoint path, which is the permissive
 * behaviour the entry point had before this Module existed.
 */
export function environmentWorkerProfile(environmentKind: string): EnvironmentWorkerProfile {
  switch (environmentKind) {
    case 'container':
      return { kind: 'container', platform: 'container' };
    case 'windows':
      return { kind: 'windows', platform: 'windows' };
    default:
      return { kind: 'endpoint', platform: 'macos' };
  }
}

/**
 * The environment Sprout records for this Worker's kind.
 *
 * Only the platform and the definition id differ; every kind declares the same
 * capabilities and lease rules, which is why the lease registry needs no
 * platform-specific rule and exclusivity works identically everywhere.
 */
export interface EnvironmentWorkerEnvironment {
  readonly profile: EnvironmentWorkerProfile;
  readonly definition: EnvironmentDefinition;
  readonly instance: EnvironmentInstance;
}

/**
 * Select the platform, definition, and instance for one configured environment.
 *
 * The definition is the durable fact the rest of Sprout branches on, so choosing
 * it here is what keeps a platform decision out of the composition root.
 */
export function selectEnvironmentWorker(
  configuration: EnvironmentWorkerConfiguration,
): EnvironmentWorkerEnvironment {
  const profile = environmentWorkerProfile(configuration.environmentKind);
  const definition: EnvironmentDefinition =
    profile.kind === 'container'
      ? containerEnvironmentDefinition({ id: 'container-linux', image: configuration.containerName })
      : {
          id: profile.kind === 'windows' ? 'windows-workstation' : 'macos-workstation',
          platform: profile.platform,
          capabilities: [
            { name: 'agent-run', requiresLease: true },
            { name: 'read-only-investigation', requiresLease: false },
          ],
        };

  // A run's working directory is a fact about the environment, not about Sprout,
  // so it lives on the instance and the same agent works unchanged across hosts
  // whose paths differ (F1 suggestion, #18).
  const workingDirectory =
    profile.kind === 'container'
      ? configuration.containerMountRoot
      : profile.kind === 'windows'
        ? configuration.windowsWorkDirectory
        : configuration.localWorkingDirectory;

  return {
    profile,
    definition,
    instance: {
      id: configuration.environmentInstanceId,
      definitionId: definition.id,
      workingDirectory,
    },
  };
}

/** The options a local-machine Worker is started with. */
export interface EndpointWorkerStart {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly label: string;
}

/**
 * The carrier port.
 *
 * Each method is one existing carrier's start path, expressed as a small
 * function so a caller can substitute a controlled one. Production wires the
 * real carriers; tests assert which one was selected and with what options.
 */
export interface EnvironmentWorkerCarriers {
  endpoint(options: EndpointWorkerStart): Promise<WorkerConnection>;
  container(options: ContainerWorkerOptions): Promise<WorkerConnection>;
  windows(options: SshTunnelCarrierOptions): Promise<WorkerConnection>;
}

const realCarriers: EnvironmentWorkerCarriers = {
  endpoint: (options) => EndpointCarrier.start(options),
  container: (options) => new ContainerCarrier(options).start(),
  windows: (options) => new SshTunnelCarrier(options).start(),
};

/** Host facts the Worker connector cannot discover on its own. */
export interface EnvironmentWorkerConfiguration {
  readonly environmentInstanceId: string;
  /** `local`, `container`, or `windows`; anything else is treated as local. */
  readonly environmentKind: string;
  /** For a container environment: the instance's container name. */
  readonly containerName: string;
  /** Where the Worker's code lives inside a container-mounted environment. */
  readonly containerMountRoot: string;
  readonly containerCodexHome: string;
  /** The host proxy, translated to the name a container uses for the host. */
  readonly containerProxy: Readonly<Record<string, string>>;
  /** For a Windows environment: the SSH target of the host running the daemon. */
  readonly windowsTarget: string | undefined;
  /** For a Windows environment: where the readiness file lives on that host. */
  readonly windowsReadyFile: string;
  /** For a Windows environment: the local port the SSH tunnel binds. */
  readonly windowsTunnelPort: number;
  /** The host working directory a local environment serves. */
  readonly localWorkingDirectory: string;
  /** For a Windows environment: the working directory a run uses. */
  readonly windowsWorkDirectory: string;
}

/** Where a carrier's log lines are attributed, so the operator log is unchanged. */
export type WorkerLogSource = 'container' | 'windows';

export interface EnvironmentWorkerDependencies {
  /** The Worker entry point the local carrier launches. */
  readonly workerEntryPath: string;
  /** The Node executable the Worker runs under. */
  readonly nodeExecutable: string;
  /** Host facts to be reduced to the explicit local Worker allowlist. */
  readonly hostEnvironment: NodeJS.ProcessEnv;
  /** Carrier overrides; tests supply recording carriers. */
  readonly carriers?: Partial<EnvironmentWorkerCarriers>;
  /** The container runtime factory; tests supply a controlled runtime. */
  readonly containerRuntime?: () => ContainerRuntime;
  /** Reads a remote daemon's readiness address; tests supply a stub. */
  readonly readWindowsReadyFile?: (options: {
    readonly target: string;
    readonly remotePath: string;
  }) => Promise<WorkerReady>;
  /** Attributed carrier log lines, so diagnostics keep their source prefix. */
  readonly logWorkerLine?: (source: WorkerLogSource, line: string) => void;
}

/**
 * The only host environment facts a local Worker and the engines it starts may
 * inherit. Worker configuration stays explicit; process-wide authority, browser
 * session state, operator recovery input, and unrelated host facts never cross
 * the core-to-Worker process boundary.
 *
 * HOME/XDG locations are intentionally retained because environment-owned engine
 * login and CLI configuration live with the signed-in Worker host, not the core.
 * Credentials and authority material must be reached through those native host
 * facilities, never injected as environment values by Sprout.
 */
const LOCAL_WORKER_ENVIRONMENT_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR', 'SHELL',
  // Typed Worker configuration and known engine binary settings only.
  'SPROUT_WORKER_HOST', 'SPROUT_WORKER_PORT', 'SPROUT_WORKSPACE_ROOT',
  'SPROUT_PI_SESSION_DIR', 'SPROUT_READY_FILE', 'SPROUT_ENV_PLATFORM',
  'SPROUT_CODEX_BIN', 'SPROUT_PI_BIN', 'SPROUT_AGY_BIN', 'SPROUT_OPENCODE_BIN',
  // The enrollment-backed outbound target (#115, ADR-0012). The claim secret is
  // read from the environment (never argv), and the private key stays host-local
  // at `SPROUT_WORKER_KEY`; the core only forwards these values to the Worker it
  // starts, it never reads the key file itself.
  'SPROUT_ENROLLMENT_ID', 'SPROUT_CORE_HOST', 'SPROUT_CORE_PORT',
  'SPROUT_ENROLLMENT_CLAIM', 'SPROUT_WORKER_KEY',
]);

export function localWorkerEnvironment(hostEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};
  for (const key of LOCAL_WORKER_ENVIRONMENT_KEYS) {
    const value = hostEnvironment[key];
    if (value !== undefined) allowed[key] = value;
  }
  return allowed;
}

/** The caller-facing surface: reach the Worker serving one environment instance. */
export interface EnvironmentWorkerFactory {
  connect(requestedInstanceId: string): Promise<WorkerConnection>;
}

/**
 * Build a connector for the one environment this build serves.
 *
 * The requested instance id is checked against the configured one first, so a
 * run that resolves anything else is refused instead of executing locally under
 * another instance's name. A multi-instance build replaces this with a factory
 * keyed by instance id.
 */
export function createEnvironmentWorkerFactory(
  configuration: EnvironmentWorkerConfiguration,
  dependencies: EnvironmentWorkerDependencies,
): EnvironmentWorkerFactory {
  const carriers: EnvironmentWorkerCarriers = { ...realCarriers, ...dependencies.carriers };
  const containerRuntime = dependencies.containerRuntime ?? (() => new DockerRuntime());
  const readReadyFile = dependencies.readWindowsReadyFile ?? readWindowsReadyFile;
  const log = dependencies.logWorkerLine ?? (() => undefined);
  const { profile } = selectEnvironmentWorker(configuration);

  return {
    async connect(requestedInstanceId: string): Promise<WorkerConnection> {
      if (requestedInstanceId !== configuration.environmentInstanceId) {
        throw new Error(
          `this Sprout serves only environment instance ${configuration.environmentInstanceId}, not ${requestedInstanceId}`,
        );
      }

      if (profile.kind === 'container') {
        const runtime = containerRuntime();
        const availability = await runtime.available();
        if (!availability.available) {
          throw new Error(`container environment unavailable: ${availability.detail}`);
        }
        return carriers.container({
          runtime,
          containerName: configuration.containerName,
          workerEntryPath: containerWorkerEntry(configuration.containerMountRoot),
          environmentInstanceId: configuration.environmentInstanceId,
          workingDirectory: configuration.containerMountRoot,
          environment: {
            CODEX_HOME: configuration.containerCodexHome,
            ...configuration.containerProxy,
          },
          label: `container:${configuration.containerName}`,
          onLog: (line) => log('container', line),
        });
      }

      if (profile.kind === 'windows') {
        const target = configuration.windowsTarget;
        if (target === undefined || target === '') {
          throw new Error(
            'SPROUT_WINDOWS_TARGET is required for SPROUT_ENV_KIND=windows (e.g. user@host)',
          );
        }
        // Read the daemon's address from the provisioning channel. The daemon is
        // started out-of-band; the carrier owns only the tunnel's lifetime.
        const ready = await readReadyFile({ target, remotePath: configuration.windowsReadyFile });
        return carriers.windows({
          target,
          daemonPort: ready.port,
          // Collisions across concurrent cores on this machine are an operator
          // concern at M1 size; the port is stable so reconnects are predictable.
          localPort: configuration.windowsTunnelPort,
          label: `windows:${target}`,
          onLog: (line) => log('windows', line),
        });
      }

      return carriers.endpoint({
        command: dependencies.nodeExecutable,
        args: [dependencies.workerEntryPath],
        // A local Worker is a separate process with its own address; it is told
        // which instance it serves through its environment, exactly as before.
        env: {
          ...localWorkerEnvironment(dependencies.hostEnvironment),
          ...workerEnvironment(configuration.environmentInstanceId),
        },
        label: 'sprout-worker',
      });
    },
  };
}
