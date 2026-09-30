/**
 * The `sprout worker` host CLI (#117, ADR-0003/0012).
 *
 * Seven executable subcommands give one Environment host a real, repeatable
 * bootstrap and user-session lifecycle:
 *
 * - `enroll <endpoint> <enrollment-id>` reads the one-use claim secret from
 *   non-echoing stdin (never argv, never shell history), generates the Worker key
 *   on this host, proves possession to the Sprout instance, and persists the
 *   minimum reconnection facts.
 * - `start` detaches a background daemon that establishes the E1 outbound
 *   connection and reconnects with a capped backoff whenever the channel ends;
 *   `--foreground` keeps the attempt in this process for service managers.
 * - `status` distinguishes not-enrolled, stopped, connecting, reconnecting,
 *   connected, incompatible, revoked, and local-configuration failure without
 *   printing a secret.
 * - `reset` requires explicit Human confirmation, removes host-local identity and
 *   configuration, and leaves the old identity unable to reconnect.
 * - `install-service` renders and installs the signed-in-user service: a
 *   LaunchAgent on macOS, or a Scheduled Task on Windows. It starts after sign-in
 *   and restarts after an unexpected exit.
 * - `uninstall-service` cleanly removes that service and its registration.
 * - `stop` signals the running Worker daemon to shut down cleanly.
 *
 * Every command is dependency-injected through `createWorkerCli`, so the tests
 * drive the real control flow with a controlled connectors, command runner, and
 * streams rather than reaching into the process. The default `main` wires the
 * real ones.
 */

import { closeSync, existsSync, openSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { parseWorkerConfiguration } from '../../host-config.ts';
import { projectHostDiagnostic, type HostDiagnosticExport } from '../../operations/contract.ts';
import { PRODUCT_VERSIONS } from '../../operations/versions.ts';
import type { EngineAdapter } from '../../engine/port.ts';
import { EnvironmentWorker, type EnvironmentWorkerOptions } from '../server.ts';
import { WorkerRecoveryJournal } from '../recovery-journal.ts';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerEngineReadinessFact,
  type WorkerReadinessFacts,
  type WorkerReadinessProbeParams,
  type WorkerReadinessProbeResult,
} from '../protocol.ts';
import {
  createEnvironmentWorkerEngines,
  describeEnvironmentWorkerEngines,
  hostEngineFacts,
} from '../engine-selection.ts';
import { probeEnvironmentReadiness, type ReadinessProbeOptions } from '../readiness.ts';
import { WORKER_DIAGNOSTICS, staticRefusalReason, type WorkerDiagnostic } from '../diagnostics.ts';
import {
  connectWorkerEnrollment,
  WorkerEnrollmentPendingError,
  WorkerEnrollmentRefusedError,
  type WorkerEnrollmentConnection,
} from '../enrollment-connector.ts';
import {
  acquireWorkerLock,
  acquireWorkerResetLock,
  createWorkerOwnerToken,
  currentWorkerProcess,
  DuplicateWorkerProcessError,
  ensureStateDirectory,
  isEnrolled,
  isProcessAlive,
  probeWorkerProcess,
  readConfig,
  readIdentityKey,
  readRuntimeState,
  removeFileIfPresent,
  removeHostState,
  stableSlug,
  workerRecoveryJournalPath,
  workerServiceLabel,
  writeConfig,
  writeRuntimeState,
  workerHostPaths,
  WorkerHostStateError,
  type WorkerHostConfig,
  type WorkerHostPaths,
  type WorkerRuntimeState,
  type WorkerConnectionState,
  type WorkerProcessIdentity,
  type WorkerProcessProbe,
} from './host-state.ts';
import {
  installLaunchAgent,
  launchAgentPlistPath,
  inspectLaunchAgent,
  renderLaunchAgent,
  restartLaunchAgent,
  uninstallLaunchAgent,
} from './launch-agent.ts';
import {
  inspectScheduledTask,
  installScheduledTask,
  startScheduledTask,
  uninstallScheduledTask,
} from './scheduled-task.ts';

/** Documented process exit statuses for every `sprout worker` subcommand. */
export const WORKER_EXIT = {
  /** The command completed. */
  ok: 0,
  /** A local configuration failure or unexpected error. */
  failure: 1,
  /** The command line was not understood. */
  usage: 2,
  /** No host-local enrollment exists. */
  notEnrolled: 3,
  /** The Sprout instance refused the enrollment or connection. */
  refused: 4,
  /** The identity is proven but a Human has not approved it yet. */
  awaitingApproval: 5,
  /** The LaunchAgent or Scheduled Task could not be installed, removed, or inspected. */
  serviceFailure: 6,
  /** Another Worker for this environment is already running. */
  alreadyRunning: 7,
} as const;

/**
 * The `status` projection.
 *
 * `local-configuration-failure` is distinct from `not-enrolled` so an operator
 * can tell "set me up" from "your files are unreadable", and `revoked` and
 * `incompatible` are distinct from a plain `stopped` so a refused Worker is
 * never mistaken for an idle one.
 */
export type WorkerStatusState =
  | 'not-enrolled'
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'pending-approval'
  | 'incompatible'
  | 'revoked'
  | 'local-configuration-failure';

export interface WorkerStatus {
  readonly state: WorkerStatusState;
  /** The Worker connection epoch when connected. */
  readonly epoch?: number;
  /** Whether a LaunchAgent plist is present for this environment. */
  readonly serviceInstalled: boolean;
  /** The Worker protocol version the host-local configuration declares. */
  readonly protocolVersion?: string;
  /** A bounded, sanitized explanation. Never a secret or a network address. */
  readonly detail?: string;
}

/** The one-use claim secret reader, so tests can supply one without a TTY. */
export type ClaimSecretReader = (prompt: string) => Promise<string>;

/** The connector seam, so tests can substitute a controlled outbound Worker. */
export type EnrollmentConnector = (input: {
  readonly host: string;
  readonly port: number;
  readonly enrollmentId: string;
  readonly claimSecret: string | undefined;
  readonly identityKeyPath: string;
  readonly scheme?: 'ws' | 'wss';
  readonly engineFacts: readonly {
    readonly engine: string;
    readonly installed: boolean;
    readonly authenticated: boolean;
    readonly models: readonly string[];
  }[];
  readonly log: (line: string) => void;
}) => Promise<WorkerEnrollmentConnection>;

export interface WorkerCliDependencies {
  /** Resolve host-local paths; defaults to the real user directories. */
  readonly paths?: () => WorkerHostPaths;
  /** Read the one-use secret from non-echoing stdin. */
  readonly readClaimSecret?: ClaimSecretReader;
  /** Confirm a destructive action; defaults to a TTY prompt plus `--yes`. */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** The outbound enrollment connector. */
  readonly connect?: EnrollmentConnector;
  /** Run one host command (used by the LaunchAgent seam). */
  readonly run?: (command: string, args: readonly string[]) => string;
  /** The signed-in user id whose `gui/<uid>` domain the LaunchAgent uses. */
  readonly uid?: number;
  /** The host platform; service commands are supported on macOS and Windows. */
  readonly platform?: NodeJS.Platform;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly now?: () => number;
  /** Probe exact host-local process bindings; tests may provide synthetic facts. */
  readonly processProbe?: WorkerProcessProbe;
  /** Establish this invocation's binding; test-only callers may supply a synthetic OS seam. */
  readonly currentProcess?: (ownerToken: string) => WorkerProcessIdentity;
  /** Seam for non-inference readiness probe options; test callers may supply custom runners or clocks. */
  readonly readinessProbeOptions?: ReadinessProbeOptions;
  /** Optional abort signal to trigger graceful worker shutdown; used by tests. */
  readonly signal?: AbortSignal;
  /** Injectable engines for host-local Worker operation; tests may substitute hermetic adapters. */
  readonly engines?: ReadonlyMap<string, EngineAdapter>;
  /** Injectable readiness provider; tests may state verified facts without spawning CLI checks. */
  readonly readiness?: () => WorkerReadinessFacts;
  /** The reconnect backoff sleep; injectable so tests run without real delays. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Serve the accepted channel. Defaults to the real `EnvironmentWorker`; tests
   * inject a recorder so `start` can be driven without a live core.
   *
   * The optional return is the session-end reason: `channel-closed` makes the
   * reconnect loop retry (a lost core is transient), while `void` or
   * `shutdown` ends the loop (an operator stop is deliberate).
   */
  readonly serve?: (input: {
    connection: WorkerEnrollmentConnection;
    environmentInstanceId: string;
    engineIds: readonly string[];
    identityKeyPath?: string;
  }) => Promise<'shutdown' | 'channel-closed' | void>;
}

/**
 * Whether the host-local identity is present, owner-only, and matches the
 * persisted configuration.
 *
 * A "connected" status must be backable by a real proof, so `status` treats a
 * missing or over-permissive key as a local configuration failure rather than a
 * healthy enrollment.
 */
export function isLocalConfigurationValid(paths: WorkerHostPaths): boolean {
  try {
    const config = readConfig(paths);
    readIdentityKey({ ...paths, identityPath: join(paths.stateDirectory, config.identityFileName) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The terminal refusal states `start` persists when the core refuses or pends
 * the connection.
 */
type TerminalRefusalState = 'pending-approval' | 'incompatible' | 'revoked';

function isTerminalRefusalState(state: WorkerConnectionState): state is TerminalRefusalState {
  return state === 'pending-approval' || state === 'incompatible' || state === 'revoked';
}

/**
 * Project the host-local state and the live daemon record into one status.
 *
 * The projection rules, in order:
 *
 * 1. A live runtime whose ownership evidence is unavailable is always a
 *    `local-configuration-failure`, even when configuration is absent or the
 *    last recorded label is `stopped`. This is the same fail-closed fact that
 *    fences start/reset and must not be hidden by a lower-priority state.
 * 2. An unenrolled host is `not-enrolled`; an unreadable configuration or an
 *    invalid identity key is a `local-configuration-failure`.
 * 3. A runtime record whose full host-local process binding is verified is
 *    trusted as the live state (`connecting`, `connected`, or a terminal refusal).
 * 4. A runtime record whose process is gone — or whose pid was reused by a non-owner
 *    process — preserves a last recorded terminal refusal fact so a refused
 *    Worker is never reported as a healthy `stopped`; it clears `connecting`
 *    and `connected` to `stopped`, because those facts only exist while a
 *    process is actually serving.
 * 5. No runtime record at all is `stopped`.
 *
 * The identity check compares an owner token and OS start marker, so a reused
 * pid can never make a dead, foreign, or other-environment Worker look connected.
 */
export function projectStatus(input: {
  readonly paths: WorkerHostPaths;
  readonly enrolled: boolean;
  readonly config: WorkerHostConfig | undefined;
  readonly configError: 'not-enrolled' | 'invalid' | 'restriction-unverifiable' | undefined;
  readonly runtime: WorkerRuntimeState | undefined;
  readonly processAlive: (pid: number) => boolean;
  readonly processMatchesRuntime?: (process: WorkerProcessIdentity) => boolean | 'unknown';
  readonly serviceInstalled: boolean;
}): WorkerStatus {
  const runtime = input.runtime;
  const identityCheck = input.processMatchesRuntime ?? ((_process: WorkerProcessIdentity) => true);
  const processAlive = runtime !== undefined && input.processAlive(runtime.pid);
  const identityResult = processAlive && runtime !== undefined ? identityCheck(runtime.process) : false;
  if (runtime !== undefined && processAlive && identityResult === 'unknown') {
    return {
      state: 'local-configuration-failure',
      serviceInstalled: input.serviceInstalled,
      ...(input.config !== undefined ? { protocolVersion: input.config.protocolVersion } : {}),
      detail: 'the Worker process ownership evidence is unavailable; start and reset are fenced',
    };
  }
  if (!input.enrolled) {
    return { state: 'not-enrolled', serviceInstalled: input.serviceInstalled };
  }
  if (input.configError === 'invalid' || input.config === undefined) {
    return {
      state: 'local-configuration-failure',
      serviceInstalled: input.serviceInstalled,
      detail: 'the host-local Worker configuration is missing or unreadable',
    };
  }
  const base = {
    serviceInstalled: input.serviceInstalled,
    protocolVersion: input.config.protocolVersion,
  };
  const trusted = runtime !== undefined && processAlive && identityResult === true;
  if (runtime === undefined || !trusted) {
    if (runtime !== undefined && isTerminalRefusalState(runtime.state)) {
      // Preserve the durable refusal/pending fact even after the process
      // exited: revoked or incompatible must never degrade to a healthy stop.
      return {
        state: runtime.state,
        ...base,
        ...(runtime.detail !== undefined ? { detail: runtime.detail } : {}),
      };
    }
    return { state: 'stopped', ...base };
  }
  switch (runtime.state) {
    case 'connecting':
    case 'connected':
    case 'reconnecting':
    case 'pending-approval':
    case 'incompatible':
    case 'revoked':
    case 'stopped':
      return {
        state: runtime.state === 'stopped' ? 'stopped' : runtime.state,
        ...(runtime.state === 'connected' && runtime.epoch !== undefined ? { epoch: runtime.epoch } : {}),
        ...base,
        ...(runtime.detail !== undefined ? { detail: runtime.detail } : {}),
      };
  }
}

/**
 * Parse the public Sprout endpoint argument.
 *
 * Only `host:port` (optionally with `ws`/`wss`/`http`/`https` scheme) is
 * accepted. The endpoint never carries a secret, so it is safe in argv; the
 * one-use claim secret deliberately has no argument form.
 */
export function parseEndpoint(value: string): { readonly host: string; readonly port: number; readonly scheme?: 'ws' | 'wss' } {
  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  if (scheme !== undefined && !['ws', 'wss', 'http', 'https'].includes(scheme)) {
    throw new WorkerHostStateError('invalid', 'the endpoint scheme must be ws, wss, http, or https');
  }
  const authority = schemeMatch === null ? value : value.slice(schemeMatch[0].length);
  // Enforce an authority grammar before URL parsing. URL would otherwise
  // accept and silently discard userinfo, paths, queries, and fragments — all
  // of which can carry credentials or private network facts in process argv.
  if (/[\s/?#@]/.test(authority)) {
    throw new WorkerHostStateError(
      'invalid',
      'the endpoint must contain only a public host and explicit port; URL components are not allowed',
    );
  }
  const authorityMatch = authority.match(/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d+)$/i);
  if (authorityMatch === null) {
    throw new WorkerHostStateError('invalid', 'the endpoint must include only a host and an explicit port');
  }
  // Preserve and validate the caller's explicit port token before WHATWG URL
  // normalization. WHATWG clears a scheme's default port (`http`/`ws` 80 and
  // `https`/`wss` 443), but those are valid explicit endpoints in this contract.
  const port = Number(authorityMatch[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new WorkerHostStateError('invalid', 'the endpoint port must be a number between 1 and 65535');
  }
  const withScheme = `${scheme ?? 'ws'}://${authority}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new WorkerHostStateError('invalid', 'the endpoint is not a valid host:port');
  }
  if (url.hostname === '') {
    throw new WorkerHostStateError('invalid', 'the endpoint must include a host and an explicit port');
  }
  const websocketScheme = scheme === 'http' ? 'ws' : scheme === 'https' ? 'wss' : scheme;
  return {
    host: url.hostname,
    port,
    ...(websocketScheme !== undefined ? { scheme: websocketScheme as 'ws' | 'wss' } : {}),
  };
}

/** The engine facts the Worker declares to the core on enrollment. */
function engineFacts(engineIds: readonly string[]): readonly {
  readonly engine: string;
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly models: readonly string[];
}[] {
  return engineIds.map((engine) => ({ engine, installed: true, authenticated: false, models: [] }));
}

export interface CreateForegroundWorkerOptionsInput {
  readonly stream?: (Readable & Writable) | undefined;
  readonly input?: Readable | undefined;
  readonly output?: Writable | undefined;
  readonly environmentInstanceId: string;
  readonly engineIds?: readonly string[] | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly onLog?: ((line: WorkerDiagnostic) => void) | undefined;
  readonly workingDirectory?: string | undefined;
  readonly readinessProbeOptions?: ReadinessProbeOptions | undefined;
  /** Locate engine binaries on the host; tests may substitute a hermetic resolver. */
  readonly locate?: ((command: string, options: { readonly preferWindowsExecutable: boolean }) => string | undefined) | undefined;
  readonly recoveryJournal?: WorkerRecoveryJournal | undefined;
  readonly engines?: ReadonlyMap<string, EngineAdapter> | undefined;
  readonly readiness?: (() => WorkerReadinessFacts) | undefined;
}

/**
 * Assemble EnvironmentWorker options for the foreground serve path.
 *
 * Startup readiness is measured by the host Worker before exposing its first
 * `worker/info`, and non-inference readiness probes update that cached
 * projection. Minimal-honest fallback readiness is preserved for engines that
 * genuinely cannot be measured (#126).
 */
export async function createForegroundWorkerOptions(
  input: CreateForegroundWorkerOptionsInput,
): Promise<EnvironmentWorkerOptions> {
  const inputStream = input.input ?? input.stream;
  const outputStream = input.output ?? input.stream;
  if (inputStream === undefined || outputStream === undefined) {
    throw new Error('createForegroundWorkerOptions requires stream or input and output');
  }

  const environment = input.environment ?? process.env;
  const workingDirectory = input.workingDirectory ?? process.cwd();
  const configuration = parseWorkerConfiguration(environment, { workingDirectory });
  const baseFacts = hostEngineFacts(configuration);
  const facts = input.locate !== undefined ? { ...baseFacts, locate: input.locate } : baseFacts;
  const engineConfigurations = describeEnvironmentWorkerEngines(facts);
  const engines = input.engines ?? createEnvironmentWorkerEngines(facts);

  const probeOptions: ReadinessProbeOptions = {
    ...(environment !== undefined ? { env: environment } : {}),
    ...(input.readinessProbeOptions ?? {}),
  };

  const allEngineKeys = new Set([...engines.keys(), ...(input.engineIds ?? [])]);
  const ensureCovered = (measured: WorkerReadinessFacts): WorkerReadinessFacts => {
    const known = new Set(measured.engines.map((e) => e.engine));
    const fallback: WorkerEngineReadinessFact[] = [];
    for (const engine of allEngineKeys) {
      if (!known.has(engine)) {
        fallback.push({
          engine,
          installed: true,
          readiness: 'unknown',
          modelAvailability: 'unknown',
          models: [],
        });
      }
    }
    if (fallback.length === 0) return measured;
    const probe = measured.probe !== undefined && measured.probe.enginesOk
      ? {
          ...measured.probe,
          enginesOk: false,
          summary: 'Worker non-inference readiness probe completed with unknown or unavailable facts.',
        }
      : measured.probe;
    return {
      ...measured,
      engines: [...measured.engines, ...fallback],
      ...(probe !== undefined ? { probe } : {}),
    };
  };

  const minimalHonestFallback: WorkerReadinessFacts = {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    engines: [...allEngineKeys].map((engine) => ({
      engine,
      installed: true,
      readiness: 'unknown',
      modelAvailability: 'unknown',
      models: [],
    })),
  };

  let workerReadiness: WorkerReadinessFacts;
  try {
    const startupProbe = await probeEnvironmentReadiness(engineConfigurations, probeOptions);
    workerReadiness = ensureCovered(startupProbe.readiness);
  } catch {
    workerReadiness = minimalHonestFallback;
  }

  const runProbe = async (
    params: WorkerReadinessProbeParams = {},
  ): Promise<WorkerReadinessProbeResult> => {
    const result = await probeEnvironmentReadiness(engineConfigurations, {
      ...probeOptions,
      ...(params.requiredModels !== undefined ? { requiredModels: params.requiredModels } : {}),
      ...(params.requirements !== undefined ? { requirements: params.requirements } : {}),
    });
    workerReadiness = ensureCovered(result.readiness);
    return {
      ...result,
      readiness: workerReadiness,
      probe: workerReadiness.probe ?? result.probe,
    };
  };

  return {
    environmentInstanceId: input.environmentInstanceId,
    engines,
    input: inputStream,
    output: outputStream,
    ...(input.onLog !== undefined ? { onLog: input.onLog } : {}),
    ...(input.recoveryJournal !== undefined ? { recoveryJournal: input.recoveryJournal } : {}),
    workspaceRoot: configuration.workspaceRoot,
    readiness: input.readiness ?? (() => workerReadiness),
    readinessProbe: (params) => runProbe(params),
  };
}


/**
 * Detach one background child running this same CLI with `args`.
 *
 * `detached` + `unref` is the cross-platform daemon primitive: the child
 * outlives the parent on both darwin and win32, and its output is redirected
 * into the host log file so the parent can return without holding pipes.
 * The child inherits this process environment, including the private owner
 * token, so its runtime and lock records bind the same identity lineage.
 * Returns the child's pid so the caller can report it.
 */
function spawnDetachedWorker(paths: WorkerHostPaths, args: readonly string[]): number {
  const log = openSync(paths.logPath, 'a');
  try {
    const child = spawn(paths.nodeExecutable, [paths.executablePath, ...args], {
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    });
    child.unref();
    return child.pid ?? 0;
  } finally {
    closeSync(log);
  }
}

export interface WorkerCli {
  run(argv: readonly string[], environment?: NodeJS.ProcessEnv): Promise<number>;
}

/**
 * Build the CLI over its dependencies.
 *
 * The returned `run` never throws for an expected outcome: it returns the
 * documented exit status and writes a sanitized line to stdout/stderr.
 */
export function createWorkerCli(dependencies: WorkerCliDependencies = {}): WorkerCli {
  const pathsOf = dependencies.paths ?? (() => workerHostPaths());
  const out = dependencies.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = dependencies.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const platform = dependencies.platform ?? process.platform;
  const uid = dependencies.uid ?? process.getuid?.() ?? 0;
  const now = dependencies.now ?? (() => Date.now());
  const runCommand = dependencies.run;
  const processProbe = dependencies.processProbe ?? probeWorkerProcess;
  const currentProcess = dependencies.currentProcess ?? currentWorkerProcess;
  const sleepFn = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

  const connect: EnrollmentConnector =
    dependencies.connect ??
    (async (input) =>
      connectWorkerEnrollment({
        target: {
          enrollmentId: input.enrollmentId,
          host: input.host,
          port: input.port,
          claimSecret: input.claimSecret,
          identityKeyPath: input.identityKeyPath,
          ...(input.scheme !== undefined ? { scheme: input.scheme } : {}),
        },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engineFacts: input.engineFacts,
        log: input.log,
      }));

  const readClaimSecret: ClaimSecretReader =
    dependencies.readClaimSecret ??
    (async (prompt) => {
      const { readSecretFromStdin } = await import('./host-state.ts');
      return readSecretFromStdin(
        process.stdin,
        process.stderr,
        prompt,
      );
    });

  const confirm =
    dependencies.confirm ??
    (async (question: string) => {
      if (!process.stdin.isTTY) return false;
      const { readSecretFromStdin } = await import('./host-state.ts');
      const answer = await readSecretFromStdin(process.stdin, process.stderr, question);
      return answer.trim().toLowerCase() === 'reset';
    });

  async function run(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<number> {
    const paths = pathsOf();
    const command = argv[0];
    const rest = argv.slice(1);
    switch (command) {
      case 'enroll':
        return enroll(paths, rest, environment);
      case 'start':
        return start(paths, rest, environment);
      case 'status':
        return status(paths, rest);
      case 'reset':
        return reset(paths, rest);
      case 'install-service':
        return installService(paths, rest);
      case 'uninstall-service':
        return uninstallService(paths, rest);
      case 'stop':
        return stop(paths, rest);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        out(usage());
        return command === undefined ? WORKER_EXIT.usage : WORKER_EXIT.ok;
      default:
        err(`sprout worker: unknown subcommand "${command}"`);
        err(usage());
        return WORKER_EXIT.usage;
    }
  }

  function usage(): string {
    return [
      'Usage: sprout worker <command>',
      '',
      'Commands:',
      '  enroll <endpoint> <enrollment-id>   Claim a pending enrollment (secret on stdin)',
      '  start [--foreground]                Start the Worker daemon in the background',
      '  status [--diagnostics]              Report host-local Worker state or typed diagnostic JSON',
      '  stop                                Signal the running Worker daemon to stop',
      '  reset                               Remove host-local identity and configuration',
      '  install-service                     Install the signed-in-user service (LaunchAgent or Scheduled Task)',
      '  uninstall-service                   Remove the signed-in-user service (LaunchAgent or Scheduled Task)',
    ].join('\n');
  }

  function resolveEngineIds(environment: NodeJS.ProcessEnv): readonly string[] {
    if (dependencies.engines !== undefined) {
      return [...dependencies.engines.keys()];
    }
    const configuration = parseWorkerConfiguration(environment, { workingDirectory: process.cwd() });
    return [...createEnvironmentWorkerEngines(hostEngineFacts(configuration)).keys()];
  }

  async function enroll(
    paths: WorkerHostPaths,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<number> {
    if (args.length !== 2) {
      err('sprout worker enroll: expected exactly <endpoint> and <enrollment-id>');
      err('the one-use claim secret is read from stdin and is never an argument');
      return WORKER_EXIT.usage;
    }
    const endpointArg = args[0] ?? '';
    const enrollmentId = args[1] ?? '';
    let endpoint: ReturnType<typeof parseEndpoint>;
    try {
      endpoint = parseEndpoint(endpointArg);
    } catch (error) {
      err(`sprout worker enroll: ${diagnosticOf(error, 'the endpoint is invalid')}`);
      return WORKER_EXIT.usage;
    }
    if (enrollmentId === '') {
      err('sprout worker enroll: the enrollment id must not be empty');
      return WORKER_EXIT.usage;
    }

    ensureStateDirectory(paths);
    const existedBefore = existsSync(paths.configPath) || existsSync(paths.identityPath);

    let secret: string;
    try {
      secret = (await readClaimSecret('Sprout enrollment claim secret (input is hidden): ')).trim();
    } catch (error) {
      err(`sprout worker enroll: ${diagnosticOf(error, 'enrollment input could not be read')}`);
      return WORKER_EXIT.failure;
    }
    if (secret === '') {
      err('sprout worker enroll: no claim secret was provided on stdin');
      return WORKER_EXIT.usage;
    }

    const engineIds = safeEngineIds(environment);
    const identityKeyPath = join(paths.stateDirectory, 'identity.pem');
    try {
      const connection = await connect({
        ...endpoint,
        enrollmentId,
        claimSecret: secret,
        identityKeyPath,
        engineFacts: engineFacts(engineIds),
        log: () => err('[sprout-worker] host-local Worker operation completed'),
      });
      writeConfig(paths, {
        version: 1,
        enrollmentId,
        environmentInstanceId: connection.environmentInstanceId,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        endpoint,
        identityFileName: 'identity.pem',
      });
      connection.close();
      out(`Enrolled. Environment instance ready for Human approval. Epoch ${connection.epoch}.`);
      return WORKER_EXIT.ok;
    } catch (error) {
      if (error instanceof WorkerEnrollmentPendingError) {
        // The identity is bound; the config lets a later `start` reconnect once
        // the Human approves. This is success-with-a-wait, not a failure.
        writeConfig(paths, {
          version: 1,
          enrollmentId,
          environmentInstanceId: error.environmentInstanceId ?? stableSlug('pending'),
          protocolVersion: WORKER_PROTOCOL_VERSION,
          endpoint,
          identityFileName: 'identity.pem',
        });
        out('Identity proven. Waiting for Human approval in Sprout Web; run `sprout worker start` afterwards.');
        return WORKER_EXIT.awaitingApproval;
      }
      // A refused or failed enrollment leaves no usable configuration. Remove a
      // freshly generated identity so a retry starts clean, but never delete a
      // pre-existing identity/key the operator may still be using.
      if (!existedBefore) {
        removeFileIfPresent(paths.identityPath);
        removeFileIfPresent(paths.configPath);
      }
      err(`sprout worker enroll: ${diagnosticOf(error, 'enrollment could not be completed')}`);
      return error instanceof WorkerEnrollmentRefusedError ? WORKER_EXIT.refused : WORKER_EXIT.failure;
    }
  }

  function safeEngineIds(environment: NodeJS.ProcessEnv): readonly string[] {
    try {
      return resolveEngineIds(environment);
    } catch {
      return [];
    }
  }

  async function start(
    paths: WorkerHostPaths,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<number> {
    const foreground = args.includes('--foreground');
    const rest = args.filter((a) => a !== '--foreground');
    if (rest.length !== 0) {
      err('sprout worker start: takes no arguments besides --foreground');
      return WORKER_EXIT.usage;
    }
    // Background is a plain detached child running this same command with
    // --foreground; the parent returns immediately and the daemon keeps the
    // reconnect loop alive (its output lands in the host log file). Service
    // managers (launchd, scheduled tasks) should keep using --foreground.
    if (!foreground) {
      const config = peekConfigOrReport(paths, err);
      if (config === undefined) return WORKER_EXIT.failure;
      // Authoritative duplicate check: probe the worker lock with this parent's
      // own identity before spawning the daemon child. The child re-acquires
      // the lock under its own identity after the parent releases it, so two
      // concurrent daemon starts are resolved by the child-side lock anyway.
      const previousOwnerToken = process.env['SPROUT_WORKER_OWNER_TOKEN'];
      // The exec-time token is the identity `ps -E` reports on darwin, so the
      // pre-check must probe with it; only a caller that never re-exec'd (a
      // test harness) gets a fresh token here.
      const ownerToken = previousOwnerToken ?? createWorkerOwnerToken();
      process.env['SPROUT_WORKER_OWNER_TOKEN'] = ownerToken;
      try {
        const parentIdentity = currentProcess(ownerToken);
        const probeLock = acquireWorkerLock(paths, parentIdentity, processProbe);
        probeLock.release();
      } catch (error) {
        if (error instanceof DuplicateWorkerProcessError) {
          err(`sprout worker start: ${error.message}`);
          return WORKER_EXIT.alreadyRunning;
        }
        err(`sprout worker start: ${diagnosticOf(error, 'host-local Worker lock could not be acquired')}`);
        return WORKER_EXIT.failure;
      } finally {
        if (previousOwnerToken === undefined) delete process.env['SPROUT_WORKER_OWNER_TOKEN'];
        else process.env['SPROUT_WORKER_OWNER_TOKEN'] = previousOwnerToken;
      }
      try {
        const child = spawnDetachedWorker(paths, ['worker', 'start', '--foreground']);
        out(`Worker daemon started (pid ${String(child)}). Logs: ${paths.logPath}`);
        return WORKER_EXIT.ok;
      } catch (error) {
        err(`sprout worker start: ${diagnosticOf(error, 'the Worker daemon could not be started')}`);
        return WORKER_EXIT.failure;
      }
    }
    return startForeground(paths, environment);
  }

  /** Read the host config for the daemon parent, reporting sanitized failures. */
  function peekConfigOrReport(paths: WorkerHostPaths, report: (line: string) => void): WorkerHostConfig | undefined {
    try {
      return readConfig(paths);
    } catch (error) {
      if (error instanceof WorkerHostStateError && error.reason === 'not-enrolled') {
        report('sprout worker start: this host is not enrolled; run `sprout worker enroll` first');
        return undefined;
      }
      report(`sprout worker start: ${diagnosticOf(error, 'host-local configuration could not be read')}`);
      return undefined;
    }
  }

  async function startForeground(
    paths: WorkerHostPaths,
    environment: NodeJS.ProcessEnv,
  ): Promise<number> {
    let config: WorkerHostConfig;
    try {
      config = readConfig(paths);
    } catch (error) {
      if (error instanceof WorkerHostStateError && error.reason === 'not-enrolled') {
        err('sprout worker start: this host is not enrolled; run `sprout worker enroll` first');
        return WORKER_EXIT.notEnrolled;
      }
      err(`sprout worker start: ${diagnosticOf(error, 'host-local configuration could not be read')}`);
      return WORKER_EXIT.failure;
    }
    const identityPath = join(paths.stateDirectory, config.identityFileName);
    try {
      readIdentityKey({ ...paths, identityPath });
    } catch (error) {
      err(`sprout worker start: ${diagnosticOf(error, 'the host-local Worker identity key is invalid or unavailable')}`);
      return WORKER_EXIT.failure;
    }

    // The token is private process environment state, not argv or persisted
    // portable configuration. It is installed before probing the OS so every
    // runtime and lock record binds this exact process incarnation.
    const previousOwnerToken = process.env['SPROUT_WORKER_OWNER_TOKEN'];
    const ownerToken = process.env['SPROUT_WORKER_OWNER_TOKEN'] ?? createWorkerOwnerToken();
    process.env['SPROUT_WORKER_OWNER_TOKEN'] = ownerToken;
    let detachSignals: (() => void) | undefined;
    try {
      let processIdentity: WorkerProcessIdentity;
      try {
        processIdentity = currentProcess(ownerToken);
      } catch (error) {
        err(`sprout worker start: ${diagnosticOf(error, 'host-local process identity could not be established')}`);
        return WORKER_EXIT.failure;
      }

      let lock: { release: () => void };
      try {
        lock = acquireWorkerLock(paths, processIdentity, processProbe);
      } catch (error) {
        if (error instanceof DuplicateWorkerProcessError) {
          err(`sprout worker start: ${error.message}`);
          return WORKER_EXIT.alreadyRunning;
        }
        err(`sprout worker start: ${diagnosticOf(error, 'host-local Worker lock could not be acquired')}`);
        return WORKER_EXIT.failure;
      }

      const engineIds = safeEngineIds(environment);
      // The reconnect loop: a lost channel or an unreachable core is transient
      // (a core restart is normal operation), so the daemon retries with a
      // capped backoff instead of exiting. Enrollment-level refusals are
      // terminal decisions, not outages: pending-approval, revoked, and
      // incompatible exit so the operator fixes the cause and restarts.
      let lockHeld = true;
      // SPROUT_WORKER_RECONNECT_MAX_MS bounds the total reconnect window. It is
      // unset by production daemons (they reconnect for as long as the host
      // runs); operators and packaged checks can set it to get an exit instead
      // of an unbounded retry when the core is unreachable.
      const maxWindowMs = Number.parseInt(environment['SPROUT_WORKER_RECONNECT_MAX_MS'] ?? '', 10);
      const reconnectDeadline = Number.isFinite(maxWindowMs) && maxWindowMs > 0 ? now() + maxWindowMs : undefined;
      // A stop can arrive while the loop is still retrying. Record a clean
      // stop and release the lock instead of leaving a stale lock directory
      // and a `reconnecting` record for the next start to recover.
      let stopRequested = dependencies.signal?.aborted ?? false;
      let wakeBackoff: (() => void) | undefined;
      const onSignal = (): void => {
        stopRequested = true;
        wakeBackoff?.();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      dependencies.signal?.addEventListener('abort', onSignal, { once: true });
      detachSignals = () => {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        dependencies.signal?.removeEventListener('abort', onSignal);
      };
      // The backoff races the injected sleep against the wake-up from a stop,
      // so `stop` does not wait out the current retry delay.
      const backoff = async (ms: number): Promise<void> => {
        if (stopRequested) return;
        let wake: () => void = () => {};
        const woken = new Promise<void>((resolve) => { wake = resolve; });
        wakeBackoff = wake;
        try {
          await Promise.race([sleepFn(ms), woken]);
        } finally {
          wakeBackoff = undefined;
        }
      };
      const attempt = async (): Promise<number> => {
        let delayMs = 2_000;
        for (;;) {
          if (stopRequested) {
            recordState(paths, { pid: process.pid, process: processIdentity, state: 'stopped', at: now(), detail: 'the Worker was stopped by the operator' });
            err('sprout worker start: stopped by the operator');
            lock.release();
            return WORKER_EXIT.ok;
          }
          if (reconnectDeadline !== undefined && now() >= reconnectDeadline) {
            recordState(paths, { pid: process.pid, process: processIdentity, state: 'stopped', at: now(), detail: 'the core remained unreachable for the whole reconnect window' });
            err(`sprout worker start: the core remained unreachable for the whole reconnect window (${String(Math.round(maxWindowMs / 1000))}s)`);
            lock.release();
            return WORKER_EXIT.failure;
          }
          recordState(paths, { pid: process.pid, process: processIdentity, state: lockHeld ? 'reconnecting' : 'connecting', at: now() });
          let connection: WorkerEnrollmentConnection;
          try {
            connection = await connect({
              host: config.endpoint.host,
              port: config.endpoint.port,
              ...(config.endpoint.scheme !== undefined ? { scheme: config.endpoint.scheme } : {}),
              enrollmentId: config.enrollmentId,
              claimSecret: undefined,
              identityKeyPath: identityPath,
              engineFacts: engineFacts(engineIds),
              log: () => err('[sprout-worker] host-local Worker operation completed'),
            });
          } catch (error) {
            if (error instanceof WorkerEnrollmentPendingError) {
              recordState(paths, {
                pid: process.pid, process: processIdentity, state: 'pending-approval', at: now(),
                detail: 'the Worker identity is proven and awaiting Human approval',
              });
              err('sprout worker start: identity proven; waiting for Human approval in Sprout Web');
              return WORKER_EXIT.awaitingApproval;
            }
            if (error instanceof WorkerEnrollmentRefusedError) {
              recordState(paths, {
                pid: process.pid,
                process: processIdentity,
                state: error.code === 'incompatible' ? 'incompatible' : 'revoked',
                at: now(),
                detail: error.code === 'incompatible'
                  ? WORKER_DIAGNOSTICS.protocolIncompatible
                  : WORKER_DIAGNOSTICS.enrollmentRefused,
              });
              err(`sprout worker start: ${diagnosticOf(error, WORKER_DIAGNOSTICS.connectionRefused)}`);
              return WORKER_EXIT.refused;
            }
            recordState(paths, { pid: process.pid, process: processIdentity, state: 'reconnecting', at: now(), detail: 'the Worker connection could not be established; retrying' });
            err(`sprout worker start: ${diagnosticOf(error, 'the Worker connection could not be established')}; retrying in ${String(Math.round(delayMs / 1000))}s`);
            await backoff(delayMs);
            delayMs = Math.min(delayMs * 2, 60_000);
            continue;
          }

          recordState(paths, { pid: process.pid, process: processIdentity, state: 'connected', at: now(), epoch: connection.epoch });
          out(`Connected to Sprout as enrollment ${connection.enrollmentId} (epoch ${connection.epoch}).`);
          lockHeld = false;
          let reason: 'shutdown' | 'channel-closed';
          try {
            if (dependencies.serve !== undefined) {
              reason = (await dependencies.serve({
                connection,
                environmentInstanceId: config.environmentInstanceId,
                engineIds,
                identityKeyPath: identityPath,
              })) ?? 'shutdown';
            } else {
              reason = await serveForeground(
                connection,
                config.environmentInstanceId,
                engineIds,
                environment,
                identityPath,
              );
            }
          } finally {
            lockHeld = true;
          }
          if (stopRequested || reason === 'shutdown') {
            recordState(paths, {
              pid: process.pid,
              process: processIdentity,
              state: 'stopped',
              at: now(),
              ...(stopRequested ? { detail: 'the Worker was stopped by the operator' } : {}),
            });
            lock.release();
            return WORKER_EXIT.ok;
          }
          // The channel ended without a terminal refusal or an operator stop:
          // transient. Record, release the lock so a concurrent start can take
          // over, and retry.
          recordState(paths, { pid: process.pid, process: processIdentity, state: 'reconnecting', at: now(), detail: 'the Worker channel closed; reconnecting' });
          err('[sprout-worker] channel closed; reconnecting');
          await backoff(delayMs);
          delayMs = Math.min(delayMs * 2, 60_000);
        }
      };
      const code = await attempt();
      lock.release();
      return code;
    } finally {
      detachSignals?.();
      if (previousOwnerToken === undefined) delete process.env['SPROUT_WORKER_OWNER_TOKEN'];
      else process.env['SPROUT_WORKER_OWNER_TOKEN'] = previousOwnerToken;
    }
  }

  /**
   * Serve the accepted channel until it ends or a signal arrives.
   *
   * The returned reason drives the reconnect loop: a lost channel is transient
   * (a core restart is normal operation) and is retried, while an operator
   * signal is a deliberate stop.
   */
  async function serveForeground(
    connection: WorkerEnrollmentConnection,
    environmentInstanceId: string,
    engineIds: readonly string[],
    environment: NodeJS.ProcessEnv,
    identityKeyPath: string,
  ): Promise<'shutdown' | 'channel-closed'> {
    const recoveryJournal = new WorkerRecoveryJournal(workerRecoveryJournalPath(identityKeyPath), connection.epoch);
    const options = await createForegroundWorkerOptions({
      stream: connection.stream,
      environmentInstanceId,
      engineIds,
      environment,
      recoveryJournal,
      ...(dependencies.engines !== undefined ? { engines: dependencies.engines } : {}),
      ...(dependencies.readiness !== undefined ? { readiness: dependencies.readiness } : {}),
      onLog: () => err('[sprout-worker] host-local Worker operation completed'),
      readinessProbeOptions: dependencies.readinessProbeOptions,
    });
    const worker = new EnvironmentWorker(options);
    return new Promise<'shutdown' | 'channel-closed'>((resolve) => {
      let reason: 'shutdown' | 'channel-closed' = 'channel-closed';
      let resolved = false;
      const cleanUpAndResolve = (): void => {
        if (resolved) return;
        resolved = true;
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        dependencies.signal?.removeEventListener('abort', stop);
        resolve(reason);
      };
      const stop = (): void => {
        reason = 'shutdown';
        connection.close();
        void worker.shutdown().then(cleanUpAndResolve, cleanUpAndResolve);
      };
      if (dependencies.signal?.aborted) {
        stop();
      } else {
        dependencies.signal?.addEventListener('abort', stop, { once: true });
      }
      connection.stream.on('close', () => {
        void worker.shutdown().then(cleanUpAndResolve, cleanUpAndResolve);
      });
      connection.stream.on('error', () => {
        void worker.shutdown().then(cleanUpAndResolve, cleanUpAndResolve);
      });
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  }

  async function status(paths: WorkerHostPaths, args: readonly string[]): Promise<number> {
    const diagnosticExport = args.length === 1 && args[0] === '--diagnostics';
    if (args.length !== 0 && !diagnosticExport) {
      err('sprout worker status: takes no arguments except --diagnostics');
      return WORKER_EXIT.usage;
    }
    const enrolled = isEnrolled(paths);
    let config: WorkerHostConfig | undefined;
    let configError: 'not-enrolled' | 'invalid' | 'restriction-unverifiable' | undefined;
    if (!enrolled) {
      configError = 'not-enrolled';
    } else {
      try {
        config = readConfig(paths);
      } catch (error) {
        configError = error instanceof WorkerHostStateError ? error.reason : 'invalid';
      }
    }
    let serviceInstalled = false;
    let serviceLoaded = false;
    let serviceInspectionFailed = false;
    let serviceInspectionError: unknown;
    if (config !== undefined) {
      if (platform === 'darwin') {
        serviceInstalled = existsSync(launchAgentPlistPath(paths, config.environmentInstanceId));
        serviceLoaded =
          serviceInstalled &&
          inspectLaunchAgent({
            label: workerServiceLabel(config.environmentInstanceId),
            uid,
            ...(runCommand !== undefined ? { run: runCommand } : {}),
          }) !== undefined;
      } else if (platform === 'win32') {
        try {
          const task = inspectScheduledTask({
            taskName: workerServiceLabel(config.environmentInstanceId),
            ...(runCommand !== undefined ? { run: runCommand } : {}),
          });
          serviceInstalled = task !== undefined;
          serviceLoaded = task !== undefined && task.enabled;
        } catch (error) {
          serviceInspectionFailed = true;
          serviceInspectionError = error;
        }
      }
    }
    // A runtime record that is present but malformed is a local configuration
    // failure, not a healthy stopped state.
    let runtime: WorkerRuntimeState | undefined;
    let runtimeInvalid = false;
    try {
      runtime = readRuntimeState(paths);
    } catch {
      runtime = undefined;
      runtimeInvalid = true;
    }
    const localConfigurationValid = runtimeInvalid ? false : isLocalConfigurationValid(paths);
    let projected: WorkerStatus;
    if (runtimeInvalid) {
      projected = {
        state: 'local-configuration-failure',
        serviceInstalled,
        ...(config !== undefined ? { protocolVersion: config.protocolVersion } : {}),
        detail: 'the host-local runtime state record is unreadable or malformed',
      };
    } else if (enrolled && config !== undefined && !localConfigurationValid) {
      projected = {
        state: 'local-configuration-failure',
        serviceInstalled,
        ...(config !== undefined ? { protocolVersion: config.protocolVersion } : {}),
        detail: 'the host-local Worker identity key is missing or readable by other users',
      };
    } else {
      projected = projectStatus({
        paths,
        enrolled,
        config,
        configError,
        runtime,
        processAlive: (pid) => isProcessAlive(pid),
        processMatchesRuntime: (identity) => {
          try {
            const observed = processProbe(identity.pid);
            if (observed.state === 'unknown') return 'unknown';
            return observed.state === 'alive' &&
              observed.process.pid === identity.pid &&
              observed.process.startIdentity === identity.startIdentity &&
              observed.process.ownerToken === identity.ownerToken;
          } catch {
            return 'unknown';
          }
        },
        serviceInstalled,
      });
    }
    if (diagnosticExport) {
      const diagnostic: HostDiagnosticExport = { ...projectHostDiagnostic({
        worker: projected.state,
        service: serviceInspectionFailed ? 'failed' : serviceLoaded ? 'running' : serviceInstalled ? 'stopped' : 'unknown',
        data: localConfigurationValid ? 'accessible' : 'unavailable',
        reachability: projected.state === 'connected' ? 'reachable' : 'unknown',
        engines: [{ engine: 'pi', readiness: 'unknown' }, { engine: 'codex', readiness: 'unknown' }],
      }), versions: PRODUCT_VERSIONS };
      out(JSON.stringify(diagnostic));
      return projected.state === 'local-configuration-failure' || serviceInspectionFailed ? WORKER_EXIT.failure : WORKER_EXIT.ok;
    }
    out(`state: ${projected.state}`);
    if (projected.epoch !== undefined) out(`epoch: ${projected.epoch}`);
    if (projected.protocolVersion !== undefined) out(`protocol: ${projected.protocolVersion}`);
    if (serviceInspectionFailed) {
      out('service: failed');
    } else {
      out(`service: ${serviceInstalled ? (serviceLoaded ? 'installed and loaded' : 'installed but not loaded') : 'not-installed'}`);
    }
    // The raw exception text can carry host paths, host names, or command
    // output, so it never crosses the CLI boundary; only the bounded fallback
    // from the shared diagnostic allowlist is emitted.
    const detail =
      projected.detail ??
      (serviceInspectionFailed
        ? diagnosticOf(serviceInspectionError, 'the Scheduled Task could not be inspected')
        : undefined);
    if (detail !== undefined) out(`detail: ${detail}`);
    switch (projected.state) {
      case 'not-enrolled':
        return WORKER_EXIT.notEnrolled;
      case 'local-configuration-failure':
        return WORKER_EXIT.failure;
      default:
        if (serviceInspectionFailed) {
          return WORKER_EXIT.serviceFailure;
        }
        return WORKER_EXIT.ok;
    }
  }

  async function reset(paths: WorkerHostPaths, args: readonly string[]): Promise<number> {
    const confirmed = args.includes('--yes') || (await confirm('Type "reset" to remove host-local Worker identity and configuration: '));
    const unknown = args.filter((arg) => arg !== '--yes');
    if (unknown.length > 0) {
      err(`sprout worker reset: unknown argument "${unknown[0]}"`);
      return WORKER_EXIT.usage;
    }
    if (!confirmed) {
      err('sprout worker reset: confirmation was not given; nothing was removed');
      return WORKER_EXIT.usage;
    }

    // Reset itself owns the same exclusive fence as start. Acquiring it is the
    // liveness check and closes the old check-then-remove race: no new start can
    // acquire the Worker lock until this reset has either failed or completed.
    const previousOwnerToken = process.env['SPROUT_WORKER_OWNER_TOKEN'];
    const ownerToken = process.env['SPROUT_WORKER_OWNER_TOKEN'] ?? createWorkerOwnerToken();
    process.env['SPROUT_WORKER_OWNER_TOKEN'] = ownerToken;
    let resetLock: { release: () => void };
    try {
      resetLock = acquireWorkerResetLock(paths, currentProcess(ownerToken), processProbe);
    } catch (error) {
      if (error instanceof DuplicateWorkerProcessError) {
        err(`sprout worker reset: a Worker or reset still owns this host-local state${error.pid === undefined ? '' : ` (pid ${error.pid})`}; nothing was removed`);
        return WORKER_EXIT.failure;
      }
      err(`sprout worker reset: could not establish exclusive ownership; nothing was removed (${diagnosticOf(error, 'host-local ownership evidence is unavailable')})`);
      return WORKER_EXIT.failure;
    }

    try {
      // Stop the supervised service before the identity disappears, and refuse
      // the reset when the service cannot be proven unloaded: a loaded
      // service would restart against a half-removed state.
      if (platform === 'darwin' || platform === 'win32') {
        const command = runCommand ?? realCommandRunner();
        let config: WorkerHostConfig;
        try {
          // The persisted environment binding is the only authority for reset.
          // Without it there is no safe way to prove a same-user Worker label
          // belongs to this state root, so reset refuses rather than enumerates.
          config = readConfig(paths);
        } catch (error) {
          err(`sprout worker reset: the current environment label could not be proven; host-local state was left untouched (${diagnosticOf(error, 'local configuration is unavailable')})`);
          return WORKER_EXIT.serviceFailure;
        }
        const label = workerServiceLabel(config.environmentInstanceId);
        try {
          if (platform === 'darwin') {
            uninstallLaunchAgent({ label, plistPath: launchAgentPlistPath(paths, config.environmentInstanceId), uid, run: command });
          } else {
            uninstallScheduledTask({ taskName: label, run: command });
          }
        } catch (error) {
          const serviceName = platform === 'darwin' ? 'the LaunchAgent' : 'the Scheduled Task';
          err(`sprout worker reset: ${serviceName} could not be removed; host-local state was left untouched (${diagnosticOf(error, 'the exact environment service could not be unloaded')})`);
          return WORKER_EXIT.serviceFailure;
        }
      }
      try {
        // Leave the maintenance fence in place until every other record is
        // gone; its ownership-checked release happens in finally below.
        removeHostState(paths, { preserveLock: true });
      } catch (error) {
        err(`sprout worker reset: host-local state could not be fully removed (${diagnosticOf(error, 'host-local state could not be fully removed')})`);
        return WORKER_EXIT.failure;
      }
      out('Host-local Worker identity and configuration removed. The old identity can no longer reconnect.');
      return WORKER_EXIT.ok;
    } finally {
      resetLock.release();
      if (previousOwnerToken === undefined) delete process.env['SPROUT_WORKER_OWNER_TOKEN'];
      else process.env['SPROUT_WORKER_OWNER_TOKEN'] = previousOwnerToken;
    }
  }

  /**
   * `stop` asks the running daemon to shut down cleanly.
   *
   * SIGTERM is the graceful channel both the reconnect loop and the serve
   * promise already honour (`process.once('SIGTERM', stop)`); the daemon
   * records its final state and releases the lock itself, so `stop` never
   * mutates host state it does not own. Windows delivers SIGTERM as a hard
   * termination via the C runtime; the daemon's next start recovers through
   * the existing lock-recovery path.
   */
  async function stop(paths: WorkerHostPaths, args: readonly string[]): Promise<number> {
    if (args.length !== 0) {
      err('sprout worker stop: takes no arguments');
      return WORKER_EXIT.usage;
    }
    let runtime: WorkerRuntimeState | undefined;
    try {
      runtime = readRuntimeState(paths);
    } catch (error) {
      if (error instanceof WorkerHostStateError && error.reason === 'not-enrolled') {
        err('sprout worker stop: this host is not enrolled; nothing to stop');
        return WORKER_EXIT.notEnrolled;
      }
      err(`sprout worker stop: ${diagnosticOf(error, 'the Worker runtime state could not be read')}`);
      return WORKER_EXIT.failure;
    }
    if (runtime === undefined || !isProcessAlive(runtime.pid)) {
      err('sprout worker stop: no running Worker was recorded on this host');
      return WORKER_EXIT.ok;
    }

    try {
      process.kill(runtime.pid, 'SIGTERM');
    } catch (error) {
      err(`sprout worker stop: the Worker process could not be signalled: ${error instanceof Error ? error.message : String(error)}`);
      return WORKER_EXIT.failure;
    }
    out(`Stop signalled to the Worker (pid ${String(runtime.pid)}).`);
    return WORKER_EXIT.ok;
  }

  async function installService(paths: WorkerHostPaths, args: readonly string[]): Promise<number> {
    if (args.length !== 0) {
      err('sprout worker install-service: takes no arguments');
      return WORKER_EXIT.usage;
    }
    if (platform !== 'darwin' && platform !== 'win32') {
      err('sprout worker install-service: service registration is only supported on macOS (LaunchAgent) and Windows (Scheduled Task)');
      return WORKER_EXIT.serviceFailure;
    }
    let config: WorkerHostConfig;
    try {
      config = readConfig(paths);
    } catch (error) {
      if (error instanceof WorkerHostStateError && error.reason === 'not-enrolled') {
        err('sprout worker install-service: this host is not enrolled; run `sprout worker enroll` first');
        return WORKER_EXIT.notEnrolled;
      }
      err(`sprout worker install-service: ${diagnosticOf(error, 'host-local configuration could not be read')}`);
      return WORKER_EXIT.failure;
    }
    const label = workerServiceLabel(config.environmentInstanceId);
    if (platform === 'win32') {
      try {
        installScheduledTask({
          paths,
          taskName: label,
          arguments: ['worker', 'start', '--foreground'],
          ...(runCommand !== undefined ? { run: runCommand } : {}),
        });
        try {
          startScheduledTask({
            taskName: label,
            ...(runCommand !== undefined ? { run: runCommand } : {}),
          });
        } catch {
          // Starting immediately is best-effort on install
        }
        out(`Installed Scheduled Task ${label}. It starts at sign-in and restarts after an unexpected exit.`);
        return WORKER_EXIT.ok;
      } catch (error) {
        err(`sprout worker install-service: ${diagnosticOf(error, 'the Scheduled Task could not be installed')}`);
        return WORKER_EXIT.serviceFailure;
      }
    }
    const plistPath = launchAgentPlistPath(paths, config.environmentInstanceId);
    const plist = renderLaunchAgent({
      label,
      executablePath: paths.executablePath,
      // launchd supervises one foreground process: the reconnect loop then
      // keeps that supervised process alive across core restarts.
      arguments: ['worker', 'start', '--foreground'],
      logPath: paths.logPath,
      environment: plistEnvironment(),
    });
    try {
      installLaunchAgent({
        paths,
        label,
        plistPath,
        plistContent: plist,
        uid,
        ...(runCommand !== undefined ? { run: runCommand } : {}),
      });
      // Start the job now (as well as at sign-in) so installation is observable
      // immediately rather than only after the next login.
      try {
        restartLaunchAgent({ label, uid, ...(runCommand !== undefined ? { run: runCommand } : {}) });
      } catch {
        // A fresh `bootstrap` may already have started it; not being able to
        // kickstart is not an install failure.
      }
      out(`Installed LaunchAgent ${label}. It starts at sign-in and restarts after an unexpected exit.`);
      return WORKER_EXIT.ok;
    } catch (error) {
      err(`sprout worker install-service: ${diagnosticOf(error, 'the LaunchAgent could not be installed')}`);
      return WORKER_EXIT.serviceFailure;
    }
  }

  async function uninstallService(paths: WorkerHostPaths, args: readonly string[]): Promise<number> {
    if (args.length !== 0) {
      err('sprout worker uninstall-service: takes no arguments');
      return WORKER_EXIT.usage;
    }
    if (platform !== 'darwin' && platform !== 'win32') {
      err('sprout worker uninstall-service: service registration is only supported on macOS (LaunchAgent) and Windows (Scheduled Task)');
      return WORKER_EXIT.serviceFailure;
    }
    let config: WorkerHostConfig | undefined;
    try {
      config = readConfig(paths);
    } catch {
      config = undefined;
    }
    if (config === undefined) {
      // Without a config the label cannot be derived; remove any plist whose
      // label prefix matches this host's state directory slug as a best effort.
      err('sprout worker uninstall-service: no host-local enrollment; nothing to uninstall');
      return WORKER_EXIT.notEnrolled;
    }
    const label = workerServiceLabel(config.environmentInstanceId);
    if (platform === 'win32') {
      try {
        const result = uninstallScheduledTask({
          taskName: label,
          ...(runCommand !== undefined ? { run: runCommand } : {}),
        });
        out(result.removed ? `Removed Scheduled Task ${label}.` : `Scheduled Task ${label} was not installed.`);
        return WORKER_EXIT.ok;
      } catch (error) {
        err(`sprout worker uninstall-service: ${diagnosticOf(error, 'the Scheduled Task could not be removed')}`);
        return WORKER_EXIT.serviceFailure;
      }
    }
    try {
      const result = uninstallLaunchAgent({
        label,
        plistPath: launchAgentPlistPath(paths, config.environmentInstanceId),
        uid,
        ...(runCommand !== undefined ? { run: runCommand } : {}),
      });
      out(result.removed ? `Removed LaunchAgent ${label}.` : `LaunchAgent ${label} was not installed.`);
      return WORKER_EXIT.ok;
    } catch (error) {
      err(`sprout worker uninstall-service: ${diagnosticOf(error, 'the LaunchAgent could not be removed')}`);
      return WORKER_EXIT.serviceFailure;
    }
  }

  function plistEnvironment(): Readonly<Record<string, string>> {
    const environment: Record<string, string> = {};
    if (process.env['HOME'] !== undefined) environment['HOME'] = process.env['HOME'];
    if (process.env['PATH'] !== undefined) environment['PATH'] = process.env['PATH'];
    if (process.env['SPROUT_WORKER_HOME'] !== undefined) {
      environment['SPROUT_WORKER_HOME'] = process.env['SPROUT_WORKER_HOME'];
    }
    environment['LC_ALL'] = 'C';
    return environment;
  }

  function recordState(paths: WorkerHostPaths, state: WorkerRuntimeState): void {
    ensureStateDirectory(paths);
    writeRuntimeState(paths, state);
  }

  /** The real host command runner, used only when no test seam was injected. */
  function realCommandRunner(): (command: string, args: readonly string[]) => string {
    return (command, args) =>
      execFileSync(command, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  }

  return { run };
}

function diagnosticOf(error: unknown, fallback: string): string {
  if (error instanceof WorkerEnrollmentRefusedError) {
    // A server refusal may carry a static, product-owned reason. Surface it only
    // when it is exactly a known string; any other server text could echo key
    // material, an absolute path, or a token-bearing URL, so those paths keep
    // the sanitized category. Transport-rule and claim/consumption refusals are
    // static by construction and are therefore the ones an operator can read.
    const reason =
      staticRefusalReason(error.message) ??
      (error.code === 'incompatible'
        ? WORKER_DIAGNOSTICS.protocolIncompatible
        : error.code === 'revoked'
          ? WORKER_DIAGNOSTICS.enrollmentRevoked
          : undefined);
    if (reason !== undefined) return `${fallback} (${reason})`;
  }

  // Filesystem, launchd, transport, endpoint, and key errors can contain
  // paths, host names, command output, or secret-adjacent material. The CLI
  // boundary therefore emits only caller-supplied, sanitized categories.
  return fallback;
}

/** The default process entry point: parse argv and exit with the returned code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const cli = createWorkerCli();
  return cli.run(argv);
}
